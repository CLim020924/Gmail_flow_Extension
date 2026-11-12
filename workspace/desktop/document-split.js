'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PDFDocument, ParseSpeeds } = require('./vendor/pdf-lib.min.js');
const {
  MAX_PPTX_BYTES,
  inspectPptxBuffer,
  buildSplitPptxPackage
} = require('./pptx-template');
const {
  MAX_PDF_INPUT_BYTES,
  MAX_MERGED_PDF_PAGES,
  hasPdfHeader
} = require('./document-merge');

const MAX_SPLIT_GROUPS = 500;
const MAX_DOCUMENT_SPLIT_GROUPS = MAX_SPLIT_GROUPS;
const MAX_SPLIT_GROUP_NAME_LENGTH = 160;
const MAX_SPLIT_SOURCE_UNITS = MAX_MERGED_PDF_PAGES;
const DOCUMENT_SPLIT_MEBIBYTE = 1024 * 1024;
const DOCUMENT_SPLIT_GIBIBYTE = 1024 * DOCUMENT_SPLIT_MEBIBYTE;
// Splitting can duplicate a document-level font, image, theme, or other shared
// resource into every result. Keep both the projected final set and the
// all-results-at-once temporary workspace bounded before any Office process or
// PDF serializer starts writing.
const MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES = 8 * DOCUMENT_SPLIT_GIBIBYTE;
const MAX_DOCUMENT_SPLIT_PROJECTED_TEMP_BYTES = MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES + MAX_PDF_INPUT_BYTES;
// Preserve a practical cushion for the OS, Office lock files, ZIP/PDF save
// overhead, and a small amount of concurrent filesystem activity.
const DOCUMENT_SPLIT_FREE_SPACE_RESERVE_BYTES = 512 * DOCUMENT_SPLIT_MEBIBYTE;

function documentSplitError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function formatDocumentSplitBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= DOCUMENT_SPLIT_GIBIBYTE) return `${(bytes / DOCUMENT_SPLIT_GIBIBYTE).toFixed(bytes >= 10 * DOCUMENT_SPLIT_GIBIBYTE ? 0 : 1)}GB`;
  if (bytes >= DOCUMENT_SPLIT_MEBIBYTE) return `${Math.ceil(bytes / DOCUMENT_SPLIT_MEBIBYTE)}MB`;
  return `${Math.ceil(bytes / 1024)}KB`;
}

function normalizedStorageBytes(value, code, message) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw documentSplitError(code, message);
  return bytes;
}

function projectDocumentSplitStorage(sourceBytesValue, outputCountValue) {
  const sourceBytes = normalizedStorageBytes(
    sourceBytesValue,
    'DOCUMENT_SPLIT_SOURCE_SIZE_INVALID',
    '나눌 원본 파일의 크기를 안전하게 확인하지 못했습니다. 파일을 다시 선택해주세요.'
  );
  const outputCount = Number(outputCountValue);
  if (sourceBytes < 1) {
    throw documentSplitError('DOCUMENT_SPLIT_SOURCE_SIZE_INVALID', '나눌 원본 파일이 비어 있습니다. 파일을 다시 선택해주세요.');
  }
  if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > MAX_SPLIT_GROUPS) {
    throw documentSplitError('DOCUMENT_SPLIT_GROUP_COUNT_INVALID', '나눌 그룹을 1개 이상, 500개 이하로 만들어주세요.');
  }

  // Compare by division before multiplying so an unexpectedly large injected
  // payload cannot overflow Number's safe-integer range.
  if (sourceBytes > Math.floor(MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES / outputCount)) {
    const projectedBytes = Math.min(Number.MAX_SAFE_INTEGER, sourceBytes * outputCount);
    const error = documentSplitError(
      'DOCUMENT_SPLIT_PROJECTED_SIZE_EXCEEDED',
      `이 문서를 ${outputCount}개로 나누면 공유 글꼴·이미지가 각 파일에 포함되어 최대 약 ${formatDocumentSplitBytes(projectedBytes)}가 필요할 수 있습니다. 한 번에 처리하는 안전 한도 ${formatDocumentSplitBytes(MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES)}를 넘으므로 그룹 수를 줄여 여러 번 나눠주세요.`
    );
    error.details = {
      sourceBytes,
      outputCount,
      projectedOutputBytes: projectedBytes,
      maximumProjectedOutputBytes: MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES
    };
    throw error;
  }

  const projectedOutputBytes = sourceBytes * outputCount;
  const projectedTempBytes = sourceBytes + projectedOutputBytes;
  if (!Number.isSafeInteger(projectedTempBytes) || projectedTempBytes > MAX_DOCUMENT_SPLIT_PROJECTED_TEMP_BYTES) {
    const error = documentSplitError(
      'DOCUMENT_SPLIT_PROJECTED_TEMP_SIZE_EXCEEDED',
      `파일 나누기에 필요한 임시 공간이 안전 한도 ${formatDocumentSplitBytes(MAX_DOCUMENT_SPLIT_PROJECTED_TEMP_BYTES)}를 넘습니다. 그룹 수를 줄여 여러 번 나눠주세요.`
    );
    error.details = {
      sourceBytes,
      outputCount,
      projectedOutputBytes,
      projectedTempBytes: Math.min(Number.MAX_SAFE_INTEGER, projectedTempBytes),
      maximumProjectedTempBytes: MAX_DOCUMENT_SPLIT_PROJECTED_TEMP_BYTES
    };
    throw error;
  }
  return {
    sourceBytes,
    outputCount,
    projectedOutputBytes,
    projectedTempBytes,
    reserveBytes: DOCUMENT_SPLIT_FREE_SPACE_RESERVE_BYTES
  };
}

function normalizedStorageCapacity(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw documentSplitError('DOCUMENT_SPLIT_DISK_SPACE_CHECK_FAILED', `${label}의 여유 공간을 확인하지 못했습니다.`);
  }
  const availableBytes = normalizedStorageBytes(
    value.availableBytes,
    'DOCUMENT_SPLIT_DISK_SPACE_CHECK_FAILED',
    `${label}의 여유 공간을 확인하지 못했습니다.`
  );
  const volumeId = String(value.volumeId || '').trim().slice(0, 240);
  if (!volumeId) throw documentSplitError('DOCUMENT_SPLIT_DISK_SPACE_CHECK_FAILED', `${label}의 저장 장치를 확인하지 못했습니다.`);
  return { availableBytes, volumeId };
}

function assertDocumentSplitFreeSpace(projectionValue, tempCapacityValue, outputCapacityValue) {
  const projection = projectDocumentSplitStorage(projectionValue?.sourceBytes, projectionValue?.outputCount);
  const tempCapacity = normalizedStorageCapacity(tempCapacityValue, '시스템 임시 저장 공간');
  const outputCapacity = normalizedStorageCapacity(outputCapacityValue, '선택한 결과 저장 공간');
  const sameVolume = tempCapacity.volumeId === outputCapacity.volumeId;
  const checks = sameVolume
    ? [{
        scope: 'shared',
        availableBytes: Math.min(tempCapacity.availableBytes, outputCapacity.availableBytes),
        requiredBytes: projection.projectedTempBytes + projection.projectedOutputBytes + projection.reserveBytes
      }]
    : [
        { scope: 'temporary', availableBytes: tempCapacity.availableBytes, requiredBytes: projection.projectedTempBytes + projection.reserveBytes },
        { scope: 'output', availableBytes: outputCapacity.availableBytes, requiredBytes: projection.projectedOutputBytes + projection.reserveBytes }
      ];

  for (const check of checks) {
    if (check.availableBytes >= check.requiredBytes) continue;
    const location = check.scope === 'shared'
      ? '시스템 임시 폴더와 결과 폴더가 있는 저장 장치'
      : (check.scope === 'temporary' ? '시스템 임시 저장 장치' : '선택한 결과 저장 장치');
    const error = documentSplitError(
      'DOCUMENT_SPLIT_DISK_SPACE_INSUFFICIENT',
      `${location}의 여유 공간이 부족합니다. 안전하게 나누려면 약 ${formatDocumentSplitBytes(check.requiredBytes)}가 필요하지만 약 ${formatDocumentSplitBytes(check.availableBytes)}만 남아 있습니다. 저장 공간을 확보하거나 그룹 수를 줄여주세요.`
    );
    error.details = {
      scope: check.scope,
      availableBytes: check.availableBytes,
      requiredBytes: check.requiredBytes,
      projectedOutputBytes: projection.projectedOutputBytes,
      projectedTempBytes: projection.projectedTempBytes,
      sameVolume
    };
    throw error;
  }
  return { ...projection, sameVolume, checks };
}

function assertDocumentSplitActualStorage(sourceBytesValue, outputBytesValue) {
  const sourceBytes = normalizedStorageBytes(
    sourceBytesValue,
    'DOCUMENT_SPLIT_SOURCE_SIZE_INVALID',
    '나눌 원본 파일의 크기를 안전하게 확인하지 못했습니다.'
  );
  const outputBytes = normalizedStorageBytes(
    outputBytesValue,
    'DOCUMENT_SPLIT_OUTPUT_SIZE_INVALID',
    '나눈 결과 파일의 전체 크기를 안전하게 확인하지 못했습니다.'
  );
  const temporaryBytes = sourceBytes + outputBytes;
  if (outputBytes > MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES
    || !Number.isSafeInteger(temporaryBytes)
    || temporaryBytes > MAX_DOCUMENT_SPLIT_PROJECTED_TEMP_BYTES) {
    const error = documentSplitError(
      'DOCUMENT_SPLIT_OUTPUT_SIZE_LIMIT_EXCEEDED',
      `나눈 결과의 전체 크기가 안전 한도 ${formatDocumentSplitBytes(MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES)}를 넘었습니다. 결과를 저장하지 않았으니 그룹 수를 줄여 여러 번 나눠주세요.`
    );
    error.details = {
      sourceBytes,
      outputBytes,
      temporaryBytes: Math.min(Number.MAX_SAFE_INTEGER, temporaryBytes),
      maximumOutputBytes: MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES,
      maximumTempBytes: MAX_DOCUMENT_SPLIT_PROJECTED_TEMP_BYTES
    };
    throw error;
  }
  return { sourceBytes, outputBytes, temporaryBytes };
}

function normalizeDocumentSplitKind(value) {
  const kind = String(value || '').trim().toLocaleLowerCase('en-US');
  if (kind !== 'pdf' && kind !== 'pptx') {
    throw documentSplitError('DOCUMENT_SPLIT_KIND_INVALID', '나눌 문서 형식을 PDF 또는 PPTX 중에서 선택해주세요.');
  }
  return kind;
}

function normalizeDocumentSplitMethod(value) {
  const method = String(value || '').trim().toLocaleLowerCase('en-US');
  if (method !== 'equal' && method !== 'custom') {
    throw documentSplitError('DOCUMENT_SPLIT_METHOD_INVALID', '파일 나누기 방식을 균등 분할 또는 직접 그룹 지정 중에서 선택해주세요.');
  }
  return method;
}

function normalizedGroupName(value, index) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    throw documentSplitError('DOCUMENT_SPLIT_GROUP_NAME_INVALID', `${index + 1}번째 결과 파일 이름이 올바르지 않습니다.`);
  }
  if (value.length > MAX_SPLIT_GROUP_NAME_LENGTH) {
    throw documentSplitError('DOCUMENT_SPLIT_GROUP_NAME_TOO_LONG', '결과 파일 이름은 160자 이하로 입력해주세요.');
  }
  return value.trim();
}

function normalizedPageNumber(value, groupIndex, pageIndex, sourceUnitCount) {
  if (!Number.isInteger(value)) {
    throw documentSplitError(
      'DOCUMENT_SPLIT_PAGE_INVALID',
      `${groupIndex + 1}번째 그룹의 ${pageIndex + 1}번째 페이지 번호가 올바르지 않습니다.`
    );
  }
  if (value < 1 || value > sourceUnitCount) {
    throw documentSplitError(
      'DOCUMENT_SPLIT_PAGE_OUT_OF_RANGE',
      `페이지 번호는 1부터 ${sourceUnitCount}까지 입력해주세요.`
    );
  }
  return value;
}

function validateEqualGroups(groups, sourceUnitCount) {
  const chunkSize = groups[0]?.pages.length || 0;
  if (chunkSize < 1) {
    throw documentSplitError('DOCUMENT_SPLIT_EQUAL_GROUPS_INVALID', '균등 분할할 페이지 수를 1 이상 입력해주세요.');
  }
  const expectedGroupCount = Math.ceil(sourceUnitCount / chunkSize);
  if (groups.length !== expectedGroupCount) {
    throw documentSplitError('DOCUMENT_SPLIT_EQUAL_GROUPS_INVALID', '균등 분할 그룹이 원본 페이지 전체를 순서대로 포함하지 않습니다.');
  }
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const start = groupIndex * chunkSize + 1;
    const end = Math.min(sourceUnitCount, start + chunkSize - 1);
    const expectedPages = [];
    for (let page = start; page <= end; page += 1) expectedPages.push(page);
    const actualPages = groups[groupIndex].pages;
    if (actualPages.length !== expectedPages.length
      || actualPages.some((page, index) => page !== expectedPages[index])) {
      throw documentSplitError('DOCUMENT_SPLIT_EQUAL_GROUPS_INVALID', '균등 분할 그룹이 원본 페이지 전체를 순서대로 포함하지 않습니다.');
    }
  }
}

function validateDocumentSplitGroups(groups, sourceUnitCount, options = {}) {
  const method = normalizeDocumentSplitMethod(options.method || 'custom');
  if (!Number.isInteger(sourceUnitCount) || sourceUnitCount < 1 || sourceUnitCount > MAX_SPLIT_SOURCE_UNITS) {
    throw documentSplitError(
      'DOCUMENT_SPLIT_SOURCE_UNIT_COUNT_INVALID',
      `원본 문서의 페이지 또는 슬라이드 수는 1개 이상, ${MAX_SPLIT_SOURCE_UNITS.toLocaleString('en-US')}개 이하여야 합니다.`
    );
  }
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_SPLIT_GROUPS) {
    throw documentSplitError('DOCUMENT_SPLIT_GROUP_COUNT_INVALID', '나눌 그룹을 1개 이상, 500개 이하로 만들어주세요.');
  }

  const selectedPages = new Set();
  const normalizedGroups = groups.map((group, groupIndex) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw documentSplitError('DOCUMENT_SPLIT_GROUP_INVALID', `${groupIndex + 1}번째 그룹 정보가 올바르지 않습니다.`);
    }
    if (!Array.isArray(group.pages) || group.pages.length < 1 || group.pages.length > sourceUnitCount) {
      throw documentSplitError('DOCUMENT_SPLIT_GROUP_PAGES_INVALID', `${groupIndex + 1}번째 그룹에 페이지를 1개 이상 선택해주세요.`);
    }

    let priorPage = 0;
    const pages = group.pages.map((value, pageIndex) => {
      const page = normalizedPageNumber(value, groupIndex, pageIndex, sourceUnitCount);
      if (page <= priorPage) {
        throw documentSplitError(
          'DOCUMENT_SPLIT_PAGE_ORDER_INVALID',
          `${groupIndex + 1}번째 그룹의 페이지는 중복 없이 원본 순서대로 입력해주세요.`
        );
      }
      priorPage = page;
      if (selectedPages.has(page)) {
        throw documentSplitError('DOCUMENT_SPLIT_PAGE_DUPLICATED', `${page}페이지가 둘 이상의 그룹에 중복으로 선택되었습니다.`);
      }
      selectedPages.add(page);
      return page;
    });

    return {
      index: groupIndex,
      name: normalizedGroupName(group.name, groupIndex),
      pages,
      unitCount: pages.length
    };
  });

  if (method === 'equal') validateEqualGroups(normalizedGroups, sourceUnitCount);

  const omittedPages = [];
  for (let page = 1; page <= sourceUnitCount; page += 1) {
    if (!selectedPages.has(page)) omittedPages.push(page);
  }
  const allowOmissions = options.allowOmissions === true;
  if (omittedPages.length && !allowOmissions) {
    const visible = omittedPages.slice(0, 20).join(', ');
    const suffix = omittedPages.length > 20 ? ` 외 ${omittedPages.length - 20}개` : '';
    const error = documentSplitError(
      'DOCUMENT_SPLIT_OMISSIONS_CONFIRMATION_REQUIRED',
      `선택되지 않은 페이지가 ${omittedPages.length}개 있습니다 (${visible}${suffix}). 계속하면 이 페이지는 결과에 포함되지 않습니다.`
    );
    error.details = {
      omittedCount: omittedPages.length,
      omittedPages: omittedPages.slice(0, 100)
    };
    throw error;
  }

  return {
    method,
    sourceUnitCount,
    groups: normalizedGroups,
    selectedUnitCount: selectedPages.size,
    omittedPages,
    omittedCount: omittedPages.length,
    allowOmissions
  };
}

function defaultDocumentSplitOutputName(sourceName, index, total) {
  const parsed = path.parse(path.basename(String(sourceName || '문서')));
  const stem = parsed.name.trim() || '문서';
  const normalizedTotal = Math.max(1, Math.floor(Number(total) || 1));
  const width = Math.max(2, String(normalizedTotal).length);
  const number = Math.min(normalizedTotal, Math.max(1, Math.floor(Number(index) || 0) + 1));
  return `${stem} - 분할 ${String(number).padStart(width, '0')}`;
}

function splitPdfSourceError(error, sourceName = '') {
  if (error?.code && String(error.code).startsWith('DOCUMENT_SPLIT_')) return error;
  const label = path.basename(String(sourceName || 'PDF 파일'));
  const detail = String(error?.message || error || '');
  if (/encrypt|password|비밀번호|암호/i.test(detail)) {
    return documentSplitError(
      'DOCUMENT_SPLIT_PDF_ENCRYPTED',
      `${label} 파일은 암호로 보호되어 있어 나눌 수 없습니다. 암호를 해제한 복사본을 선택해주세요.`,
      error
    );
  }
  return documentSplitError(
    'DOCUMENT_SPLIT_PDF_INVALID',
    `${label} 파일이 손상되었거나 지원하지 않는 PDF 형식입니다. 원본을 다시 저장한 뒤 시도해주세요.`,
    error
  );
}

async function loadPdfForSplit(buffer, sourceName = '') {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!hasPdfHeader(source)) throw splitPdfSourceError(new Error('PDF_HEADER_NOT_FOUND'), sourceName);
  try {
    const document = await PDFDocument.load(source, {
      ignoreEncryption: false,
      parseSpeed: ParseSpeeds.Fastest,
      throwOnInvalidObject: true,
      updateMetadata: false
    });
    if (document.isEncrypted) throw new Error('PDF_ENCRYPTED');
    const pageCount = document.getPageCount();
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_SPLIT_SOURCE_UNITS) {
      throw documentSplitError(
        'DOCUMENT_SPLIT_SOURCE_UNIT_COUNT_INVALID',
        `PDF 페이지는 1쪽 이상, ${MAX_SPLIT_SOURCE_UNITS.toLocaleString('en-US')}쪽 이하여야 합니다.`
      );
    }
    return document;
  } catch (error) {
    throw splitPdfSourceError(error, sourceName);
  }
}

function stableFileStats(left, right) {
  return Boolean(left && right
    && left.isFile?.() && right.isFile?.()
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs);
}

function sameFileObject(left, right) {
  if (!left?.isFile?.() || !right?.isFile?.()) return false;
  if (Number.isFinite(left.ino) && Number.isFinite(right.ino) && left.ino !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return Number.isFinite(left.birthtimeMs) && left.birthtimeMs === right.birthtimeMs;
}

function normalizeExpectedIdentity(value) {
  if (value == null) return null;
  const bytes = Number(value.bytes);
  const sha256 = String(value.sha256 || '').toLocaleLowerCase('en-US');
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw documentSplitError('DOCUMENT_SPLIT_INPUT_IDENTITY_INVALID', '검증된 문서 입력 정보가 올바르지 않습니다.');
  }
  return { bytes, sha256 };
}

async function readStablePdfSource(inputPath, expectedIdentity) {
  const handle = await fs.promises.open(inputPath, 'r').catch((error) => {
    if (error?.code === 'ENOENT') {
      throw documentSplitError('DOCUMENT_SPLIT_INPUT_NOT_FOUND', `${path.basename(inputPath)} 파일을 찾을 수 없습니다. 다시 선택해주세요.`, error);
    }
    throw error;
  });
  try {
    const initialStats = await handle.stat();
    if (!initialStats.isFile() || initialStats.size < 1 || initialStats.size > MAX_PDF_INPUT_BYTES) {
      throw documentSplitError('DOCUMENT_SPLIT_PDF_SIZE_INVALID', `${path.basename(inputPath)} 파일은 비어 있지 않은 256MB 이하의 PDF여야 합니다.`);
    }
    const buffer = await handle.readFile();
    const finalStats = await handle.stat();
    if (!stableFileStats(initialStats, finalStats) || buffer.length !== initialStats.size) {
      throw documentSplitError('DOCUMENT_SPLIT_INPUT_CHANGED', '검증한 PDF 입력 파일이 나누기 직전에 바뀌어 작업을 중단했습니다.');
    }
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (expectedIdentity && (expectedIdentity.bytes !== buffer.length || expectedIdentity.sha256 !== sha256)) {
      throw documentSplitError('DOCUMENT_SPLIT_INPUT_CHANGED', '검증한 PDF 입력 파일이 나누기 직전에 바뀌어 작업을 중단했습니다.');
    }
    return { buffer, stats: initialStats, bytes: buffer.length, sha256 };
  } finally {
    await handle.close();
  }
}

async function readStablePptxSource(inputPath, expectedIdentity) {
  const handle = await fs.promises.open(inputPath, 'r').catch((error) => {
    if (error?.code === 'ENOENT') {
      throw documentSplitError('DOCUMENT_SPLIT_INPUT_NOT_FOUND', `${path.basename(inputPath)} 파일을 찾을 수 없습니다. 다시 선택해주세요.`, error);
    }
    throw error;
  });
  try {
    const initialStats = await handle.stat();
    if (!initialStats.isFile() || initialStats.size < 1 || initialStats.size > MAX_PPTX_BYTES) {
      throw documentSplitError('DOCUMENT_SPLIT_PPTX_SIZE_INVALID', `${path.basename(inputPath)} 파일은 비어 있지 않은 128MB 이하의 PPTX여야 합니다.`);
    }
    const buffer = await handle.readFile();
    const finalStats = await handle.stat();
    if (!stableFileStats(initialStats, finalStats) || buffer.length !== initialStats.size) {
      throw documentSplitError('DOCUMENT_SPLIT_INPUT_CHANGED', '검증한 PPTX 입력 파일이 나누기 직전에 바뀌어 작업을 중단했습니다.');
    }
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (expectedIdentity && (expectedIdentity.bytes !== buffer.length || expectedIdentity.sha256 !== sha256)) {
      throw documentSplitError('DOCUMENT_SPLIT_INPUT_CHANGED', '검증한 PPTX 입력 파일이 나누기 직전에 바뀌어 작업을 중단했습니다.');
    }
    return { buffer, stats: initialStats, bytes: buffer.length, sha256 };
  } finally {
    await handle.close();
  }
}

function normalizedOutputPlans(outputs) {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > MAX_SPLIT_GROUPS) {
    throw documentSplitError('DOCUMENT_SPLIT_GROUP_COUNT_INVALID', '나눌 그룹을 1개 이상, 500개 이하로 만들어주세요.');
  }
  const destinations = new Set();
  return outputs.map((output, index) => {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw documentSplitError('DOCUMENT_SPLIT_OUTPUT_INVALID', `${index + 1}번째 임시 결과 정보가 올바르지 않습니다.`);
    }
    if (typeof output.outputPath !== 'string' || !output.outputPath.trim()) {
      throw documentSplitError('DOCUMENT_SPLIT_OUTPUT_PATH_INVALID', `${index + 1}번째 임시 결과 위치가 올바르지 않습니다.`);
    }
    const outputPath = path.resolve(output.outputPath);
    const key = process.platform === 'win32' ? outputPath.toLocaleLowerCase('en-US') : outputPath;
    if (destinations.has(key)) {
      throw documentSplitError('DOCUMENT_SPLIT_OUTPUT_PATH_DUPLICATED', '둘 이상의 분할 결과가 같은 임시 파일 위치를 사용하고 있습니다.');
    }
    destinations.add(key);
    return {
      outputPath,
      name: output.name == null ? '' : String(output.name),
      pages: output.pages
    };
  });
}

async function writeExclusiveOutput(filePath, bytes, createdOutputs) {
  let handle = null;
  let closeError = null;
  try {
    handle = await fs.promises.open(filePath, 'wx');
    const ownedStats = await handle.stat();
    createdOutputs.push({ filePath, ownedStats });
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch (error) { closeError = error; }
    }
  }
  if (closeError) throw closeError;
}

async function cleanupCreatedOutputs(createdOutputs) {
  for (const created of [...createdOutputs].reverse()) {
    try {
      const currentStats = await fs.promises.stat(created.filePath);
      if (sameFileObject(created.ownedStats, currentStats)) await fs.promises.unlink(created.filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('PDF 분할 임시 결과 정리 실패:', error);
    }
  }
}

async function splitPdfFile(inputPath, outputs, options = {}) {
  const sourcePath = path.resolve(String(inputPath || ''));
  if (path.extname(sourcePath).toLocaleLowerCase('en-US') !== '.pdf') {
    throw documentSplitError('DOCUMENT_SPLIT_INPUT_TYPE_INVALID', 'PDF 파일만 PDF 분할 입력으로 사용할 수 있습니다.');
  }
  const outputPlans = normalizedOutputPlans(outputs);
  const sourceKey = process.platform === 'win32' ? sourcePath.toLocaleLowerCase('en-US') : sourcePath;
  if (outputPlans.some((output) => (process.platform === 'win32'
    ? output.outputPath.toLocaleLowerCase('en-US')
    : output.outputPath) === sourceKey)) {
    throw documentSplitError('DOCUMENT_SPLIT_OUTPUT_PATH_INVALID', '원본 PDF 파일을 분할 결과로 덮어쓸 수 없습니다.');
  }

  const expectedIdentity = normalizeExpectedIdentity(options.expectedIdentity);
  options.throwIfCancelled?.();
  const source = await readStablePdfSource(sourcePath, expectedIdentity);
  options.throwIfCancelled?.();
  const sourceDocument = await loadPdfForSplit(source.buffer, path.basename(sourcePath));
  const sourceUnitCount = sourceDocument.getPageCount();
  const validated = validateDocumentSplitGroups(
    outputPlans.map((output) => ({ name: output.name, pages: output.pages })),
    sourceUnitCount,
    { method: options.method || 'custom', allowOmissions: options.allowOmissions === true }
  );

  const createdOutputs = [];
  const results = [];
  let totalOutputBytes = 0;
  try {
    for (let index = 0; index < outputPlans.length; index += 1) {
      options.throwIfCancelled?.();
      const outputPlan = outputPlans[index];
      const group = validated.groups[index];
      const outputDocument = await PDFDocument.create();
      const copiedPages = await outputDocument.copyPages(sourceDocument, group.pages.map((page) => page - 1));
      for (const page of copiedPages) outputDocument.addPage(page);
      options.throwIfCancelled?.();
      let serialized = await outputDocument.save({ addDefaultPage: false, objectsPerTick: 50, useObjectStreams: true });
      options.throwIfCancelled?.();
      totalOutputBytes += serialized.byteLength;
      assertDocumentSplitActualStorage(source.bytes, totalOutputBytes);
      await writeExclusiveOutput(outputPlan.outputPath, serialized, createdOutputs);
      serialized = null;
      options.throwIfCancelled?.();

      const outputBytes = await fs.promises.readFile(outputPlan.outputPath);
      const verified = await loadPdfForSplit(outputBytes, path.basename(outputPlan.outputPath));
      if (verified.getPageCount() !== group.pages.length) {
        throw documentSplitError('DOCUMENT_SPLIT_PAGE_COUNT_MISMATCH', 'PDF 분할 결과의 페이지 수가 선택한 페이지 수와 다릅니다.');
      }
      const sha256 = crypto.createHash('sha256').update(outputBytes).digest('hex');
      const result = {
        index,
        outputPath: outputPlan.outputPath,
        name: group.name,
        pages: [...group.pages],
        pageCount: group.pages.length,
        bytes: outputBytes.length,
        sha256
      };
      results.push(result);
      options.onProgress?.({
        phase: 'split',
        index,
        completed: index + 1,
        total: outputPlans.length,
        pages: [...group.pages],
        pageCount: group.pages.length
      });
    }
    options.throwIfCancelled?.();
    return {
      sourceUnitCount,
      pageCount: sourceUnitCount,
      inputBytes: source.bytes,
      sourceSha256: source.sha256,
      omittedPages: [...validated.omittedPages],
      results
    };
  } catch (error) {
    await cleanupCreatedOutputs(createdOutputs);
    throw error;
  }
}

async function splitPptxFile(inputPath, outputs, options = {}) {
  const sourcePath = path.resolve(String(inputPath || ''));
  if (path.extname(sourcePath).toLocaleLowerCase('en-US') !== '.pptx') {
    throw documentSplitError('DOCUMENT_SPLIT_INPUT_TYPE_INVALID', 'PPTX 파일만 PowerPoint 분할 입력으로 사용할 수 있습니다.');
  }
  const outputPlans = normalizedOutputPlans(outputs);
  const sourceKey = process.platform === 'win32' ? sourcePath.toLocaleLowerCase('en-US') : sourcePath;
  if (outputPlans.some((output) => (process.platform === 'win32'
    ? output.outputPath.toLocaleLowerCase('en-US')
    : output.outputPath) === sourceKey)) {
    throw documentSplitError('DOCUMENT_SPLIT_OUTPUT_PATH_INVALID', '원본 PPTX 파일을 분할 결과로 덮어쓸 수 없습니다.');
  }

  const expectedIdentity = normalizeExpectedIdentity(options.expectedIdentity);
  options.throwIfCancelled?.();
  const source = await readStablePptxSource(sourcePath, expectedIdentity);
  options.throwIfCancelled?.();
  let sourceInspection;
  try {
    sourceInspection = await inspectPptxBuffer(source.buffer);
  } catch (error) {
    throw documentSplitError(
      'DOCUMENT_SPLIT_PPTX_INVALID',
      `${path.basename(sourcePath)} 파일이 손상되었거나 안전한 내부 분할을 지원하지 않습니다. PowerPoint에서 다시 저장한 뒤 시도해주세요.`,
      error
    );
  }
  const sourceUnitCount = Number(sourceInspection.slideCount) || 0;
  const validated = validateDocumentSplitGroups(
    outputPlans.map((output) => ({ name: output.name, pages: output.pages })),
    sourceUnitCount,
    { method: options.method || 'custom', allowOmissions: options.allowOmissions === true }
  );

  const createdOutputs = [];
  const results = [];
  let totalOutputBytes = 0;
  try {
    for (let index = 0; index < outputPlans.length; index += 1) {
      options.throwIfCancelled?.();
      const outputPlan = outputPlans[index];
      const group = validated.groups[index];
      const generated = await buildSplitPptxPackage(source.buffer, { pages: group.pages });
      options.throwIfCancelled?.();
      if (generated.slideCount !== group.pages.length
        || generated.slideNumbers.some((page, pageIndex) => page !== group.pages[pageIndex])
        || generated.slideSize.width !== sourceInspection.slideSize.width
        || generated.slideSize.height !== sourceInspection.slideSize.height) {
        throw documentSplitError(
          'DOCUMENT_SPLIT_PPTX_IDENTITY_MISMATCH',
          '내부 분할 결과의 슬라이드 순서 또는 크기가 원본 선택과 달라 결과를 만들지 않았습니다.'
        );
      }
      totalOutputBytes += generated.buffer.length;
      assertDocumentSplitActualStorage(source.bytes, totalOutputBytes);
      await writeExclusiveOutput(outputPlan.outputPath, generated.buffer, createdOutputs);
      options.throwIfCancelled?.();

      const outputBytes = await fs.promises.readFile(outputPlan.outputPath);
      if (!outputBytes.equals(generated.buffer)) {
        throw documentSplitError('DOCUMENT_SPLIT_OUTPUT_CHANGED', '내부 분할 결과를 저장하는 동안 파일이 바뀌어 작업을 중단했습니다.');
      }
      const inspectedOutput = await inspectPptxBuffer(outputBytes);
      if (inspectedOutput.slideCount !== group.pages.length
        || inspectedOutput.slideSize.width !== sourceInspection.slideSize.width
        || inspectedOutput.slideSize.height !== sourceInspection.slideSize.height) {
        throw documentSplitError(
          'DOCUMENT_SPLIT_OUTPUT_COUNT_MISMATCH',
          'PPTX 내부 분할 결과의 슬라이드 수 또는 크기가 계획과 다릅니다.'
        );
      }
      const sha256 = crypto.createHash('sha256').update(outputBytes).digest('hex');
      results.push({
        index,
        outputPath: outputPlan.outputPath,
        name: group.name,
        pages: [...group.pages],
        slideCount: group.pages.length,
        slideIds: [...generated.slideIds],
        bytes: outputBytes.length,
        sha256
      });
      options.onProgress?.({
        phase: 'split',
        index,
        completed: index + 1,
        total: outputPlans.length,
        pages: [...group.pages],
        slideCount: group.pages.length
      });
    }
    options.throwIfCancelled?.();
    const finalSourceHash = crypto.createHash('sha256').update(source.buffer).digest('hex');
    if (finalSourceHash !== source.sha256) {
      throw documentSplitError('DOCUMENT_SPLIT_INPUT_CHANGED', 'PPTX 원본 메모리 사본이 처리 중 바뀌어 결과를 저장하지 않았습니다.');
    }
    return {
      sourceUnitCount,
      slideCount: sourceUnitCount,
      slideSize: { ...sourceInspection.slideSize },
      inputBytes: source.bytes,
      sourceSha256: source.sha256,
      omittedPages: [...validated.omittedPages],
      results
    };
  } catch (error) {
    await cleanupCreatedOutputs(createdOutputs);
    throw error;
  }
}

module.exports = {
  MAX_SPLIT_GROUPS,
  MAX_DOCUMENT_SPLIT_GROUPS,
  MAX_SPLIT_GROUP_NAME_LENGTH,
  MAX_SPLIT_SOURCE_UNITS,
  MAX_DOCUMENT_SPLIT_PROJECTED_OUTPUT_BYTES,
  MAX_DOCUMENT_SPLIT_PROJECTED_TEMP_BYTES,
  DOCUMENT_SPLIT_FREE_SPACE_RESERVE_BYTES,
  documentSplitError,
  formatDocumentSplitBytes,
  projectDocumentSplitStorage,
  assertDocumentSplitFreeSpace,
  assertDocumentSplitActualStorage,
  normalizeDocumentSplitKind,
  normalizeDocumentSplitMethod,
  validateDocumentSplitGroups,
  defaultDocumentSplitOutputName,
  splitPdfFile,
  splitPptxFile
};
