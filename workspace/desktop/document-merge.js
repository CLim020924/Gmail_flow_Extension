'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PDFDocument, ParseSpeeds } = require('./vendor/pdf-lib.min.js');

const MIN_MERGE_FILES = 2;
const MAX_MERGE_FILES = 500;
const MAX_PDF_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_MERGE_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_MERGED_PDF_PAGES = 50_000;
const MAX_MERGED_PPTX_SLIDES = 10_000;

function mergeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizeDocumentMergeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (kind !== 'pdf' && kind !== 'pptx') {
    throw mergeError('DOCUMENT_MERGE_KIND_INVALID', '합칠 문서 형식을 PDF 또는 PPTX 중에서 선택해주세요.');
  }
  return kind;
}

function pdfSourceError(error, sourceName = '') {
  if (error?.code && String(error.code).startsWith('DOCUMENT_MERGE_')) return error;
  const label = path.basename(String(sourceName || 'PDF 파일'));
  const detail = String(error?.message || error || '');
  if (/encrypt|password|비밀번호|암호/i.test(detail)) {
    return mergeError(
      'DOCUMENT_MERGE_PDF_ENCRYPTED',
      `${label} 파일은 암호로 보호되어 있어 합칠 수 없습니다. 암호를 해제한 복사본을 선택해주세요.`,
      error
    );
  }
  return mergeError(
    'DOCUMENT_MERGE_PDF_INVALID',
    `${label} 파일이 손상되었거나 지원하지 않는 PDF 형식입니다. 원본을 다시 저장한 뒤 시도해주세요.`,
    error
  );
}

function hasPdfHeader(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) return false;
  const source = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return source.subarray(0, Math.min(source.length, 1_024)).includes(Buffer.from('%PDF-', 'ascii'));
}

async function loadPdfDocument(buffer, sourceName = '') {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!hasPdfHeader(source)) throw pdfSourceError(new Error('PDF_HEADER_NOT_FOUND'), sourceName);
  try {
    const document = await PDFDocument.load(source, {
      ignoreEncryption: false,
      parseSpeed: ParseSpeeds.Fastest,
      throwOnInvalidObject: true,
      updateMetadata: false
    });
    if (document.isEncrypted) throw new Error('PDF_ENCRYPTED');
    const pageCount = document.getPageCount();
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw mergeError('DOCUMENT_MERGE_PDF_EMPTY', `${path.basename(String(sourceName || 'PDF 파일'))} 파일에 합칠 페이지가 없습니다.`);
    }
    return document;
  } catch (error) {
    throw pdfSourceError(error, sourceName);
  }
}

async function inspectPdfBuffer(buffer, sourceName = '') {
  const document = await loadPdfDocument(buffer, sourceName);
  return {
    pageCount: document.getPageCount(),
    encrypted: false
  };
}

async function inspectPdfFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  let stats;
  try { stats = await fs.promises.stat(resolvedPath); }
  catch (error) {
    throw mergeError('DOCUMENT_MERGE_INPUT_NOT_FOUND', `${path.basename(resolvedPath)} 파일을 찾을 수 없습니다. 다시 선택해주세요.`, error);
  }
  if (!stats.isFile()) throw mergeError('DOCUMENT_MERGE_INPUT_NOT_FILE', `${path.basename(resolvedPath)} 항목은 파일이 아닙니다.`);
  if (stats.size <= 0 || stats.size > MAX_PDF_INPUT_BYTES) {
    throw mergeError('DOCUMENT_MERGE_PDF_SIZE_INVALID', `${path.basename(resolvedPath)} 파일은 256MB 이하의 PDF만 사용할 수 있습니다.`);
  }
  const inspected = await inspectPdfBuffer(await fs.promises.readFile(resolvedPath), path.basename(resolvedPath));
  return {
    sourcePath: resolvedPath,
    sourceName: path.basename(resolvedPath),
    sourceBytes: stats.size,
    sourceModifiedAt: stats.mtimeMs,
    ...inspected
  };
}

async function mergePdfFiles(inputPaths, outputPath, options = {}) {
  const sources = Array.isArray(inputPaths) ? inputPaths.map((item) => path.resolve(String(item || ''))) : [];
  if (sources.length < MIN_MERGE_FILES || sources.length > MAX_MERGE_FILES) {
    throw mergeError('DOCUMENT_MERGE_FILE_COUNT_INVALID', '합칠 PDF 파일을 2개 이상, 500개 이하로 선택해주세요.');
  }

  const destination = path.resolve(outputPath);
  const expectedIdentities = Array.isArray(options.expectedIdentities) ? options.expectedIdentities : null;
  if (expectedIdentities && expectedIdentities.length !== sources.length) {
    throw mergeError('DOCUMENT_MERGE_INPUT_IDENTITY_INVALID', '검증된 PDF 입력 정보가 현재 병합 순서와 일치하지 않습니다.');
  }
  const output = await PDFDocument.create();
  let totalBytes = 0;
  let totalPages = 0;

  for (let index = 0; index < sources.length; index += 1) {
    options.throwIfCancelled?.();
    const sourcePath = sources[index];
    let stats;
    try { stats = await fs.promises.stat(sourcePath); }
    catch (error) {
      throw mergeError('DOCUMENT_MERGE_INPUT_NOT_FOUND', `${path.basename(sourcePath)} 파일을 찾을 수 없습니다. 다시 선택해주세요.`, error);
    }
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PDF_INPUT_BYTES) {
      throw mergeError('DOCUMENT_MERGE_PDF_SIZE_INVALID', `${path.basename(sourcePath)} 파일은 256MB 이하의 PDF만 사용할 수 있습니다.`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_MERGE_INPUT_BYTES) {
      throw mergeError('DOCUMENT_MERGE_TOTAL_SIZE_EXCEEDED', '선택한 문서의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
    }

    const sourceBytes = await fs.promises.readFile(sourcePath);
    const expectedIdentity = expectedIdentities?.[index];
    if (expectedIdentity) {
      const actualDigest = crypto.createHash('sha256').update(sourceBytes).digest('hex');
      if (sourceBytes.length !== Number(expectedIdentity.bytes)
        || !/^[a-f0-9]{64}$/i.test(String(expectedIdentity.sha256 || ''))
        || actualDigest !== String(expectedIdentity.sha256).toLowerCase()) {
        throw mergeError('DOCUMENT_MERGE_INPUT_CHANGED', '검증한 PDF 입력 파일이 병합 직전에 바뀌어 작업을 중단했습니다.');
      }
    }
    const source = await loadPdfDocument(sourceBytes, path.basename(sourcePath));
    const sourcePageCount = source.getPageCount();
    totalPages += sourcePageCount;
    if (totalPages > MAX_MERGED_PDF_PAGES) {
      throw mergeError('DOCUMENT_MERGE_PAGE_LIMIT_EXCEEDED', '합칠 PDF 페이지가 50,000쪽을 넘습니다. 여러 번으로 나눠 합쳐주세요.');
    }
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
    options.onProgress?.({ index, name: path.basename(sourcePath), pageCount: sourcePageCount, completed: index + 1, total: sources.length });
  }

  options.throwIfCancelled?.();
  let serialized = await output.save({ addDefaultPage: false, objectsPerTick: 50, useObjectStreams: true });
  await fs.promises.writeFile(destination, serialized, { flag: 'wx' });
  serialized = null;

  try {
    const verified = await loadPdfDocument(await fs.promises.readFile(destination), path.basename(destination));
    if (verified.getPageCount() !== totalPages) {
      throw mergeError('DOCUMENT_MERGE_PAGE_COUNT_MISMATCH', 'PDF 병합 결과의 페이지 수가 원본 합계와 다릅니다. 결과를 저장하지 않았습니다.');
    }
  } catch (error) {
    try { await fs.promises.unlink(destination); } catch (_) {}
    throw error;
  }

  return { outputPath: destination, sourceCount: sources.length, pageCount: totalPages, inputBytes: totalBytes };
}

function sameSlideSize(left, right) {
  return Number(left?.width) === Number(right?.width) && Number(left?.height) === Number(right?.height);
}

function validSlideSize(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
}

function assertCompatiblePptxInspections(inspections) {
  const sources = Array.isArray(inspections) ? inspections : [];
  if (sources.length < MIN_MERGE_FILES || sources.length > MAX_MERGE_FILES) {
    throw mergeError('DOCUMENT_MERGE_FILE_COUNT_INVALID', '합칠 PPTX 파일을 2개 이상, 500개 이하로 선택해주세요.');
  }
  const referenceSize = sources[0]?.slideSize;
  let totalBytes = 0;
  let slideCount = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const inspected = sources[index];
    const sourceLabel = path.basename(String(inspected?.sourceName || `${index + 1}번째 PPTX`));
    const sourceSlideCount = Number(inspected?.slideCount);
    if (!Number.isInteger(sourceSlideCount) || sourceSlideCount < 1) {
      throw mergeError('DOCUMENT_MERGE_PPTX_EMPTY', `${sourceLabel} 파일에 합칠 슬라이드가 없습니다.`);
    }
    if (!validSlideSize(inspected?.slideSize)) {
      throw mergeError('DOCUMENT_MERGE_PPTX_SIZE_INVALID', `${sourceLabel} 파일의 슬라이드 크기를 확인할 수 없습니다. PowerPoint에서 다시 저장한 뒤 시도해주세요.`);
    }
    totalBytes += Number(inspected?.sourceBytes) || 0;
    slideCount += sourceSlideCount;
    if (!sameSlideSize(referenceSize, inspected?.slideSize)) {
      throw mergeError(
        'DOCUMENT_MERGE_PPTX_SIZE_MISMATCH',
        '슬라이드 크기가 서로 다른 PPTX는 디자인을 그대로 유지하며 합칠 수 없습니다. 슬라이드 크기를 맞춘 뒤 다시 선택해주세요.'
      );
    }
  }
  if (totalBytes > MAX_MERGE_INPUT_BYTES) {
    throw mergeError('DOCUMENT_MERGE_TOTAL_SIZE_EXCEEDED', '선택한 문서의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
  }
  if (slideCount < 1 || slideCount > MAX_MERGED_PPTX_SLIDES) {
    throw mergeError('DOCUMENT_MERGE_SLIDE_LIMIT_EXCEEDED', '합칠 PPTX 슬라이드는 1장 이상, 10,000장 이하여야 합니다.');
  }
  return { sourceCount: sources.length, slideCount, inputBytes: totalBytes, slideSize: referenceSize };
}

module.exports = {
  MIN_MERGE_FILES,
  MAX_MERGE_FILES,
  MAX_PDF_INPUT_BYTES,
  MAX_MERGE_INPUT_BYTES,
  MAX_MERGED_PDF_PAGES,
  MAX_MERGED_PPTX_SLIDES,
  normalizeDocumentMergeKind,
  pdfSourceError,
  hasPdfHeader,
  inspectPdfBuffer,
  inspectPdfFile,
  mergePdfFiles,
  sameSlideSize,
  validSlideSize,
  assertCompatiblePptxInspections
};
