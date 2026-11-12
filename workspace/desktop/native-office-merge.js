'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MIN_NATIVE_OFFICE_MERGE_FILES = 2;
const MAX_NATIVE_OFFICE_MERGE_FILES = 500;
const MAX_NATIVE_OFFICE_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_NATIVE_OFFICE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_NATIVE_OFFICE_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_NATIVE_OFFICE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_NATIVE_OFFICE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const NATIVE_OFFICE_MERGE_FORMATS = Object.freeze({
  word: Object.freeze({
    operation: 'merge-word',
    inspectOperation: 'inspect-word',
    outputExtension: '.docx',
    inputExtensions: Object.freeze(['.doc', '.docx', '.odt', '.rtf']),
    rejectedExtensions: Object.freeze(['.docm', '.dotm', '.dot', '.dotx'])
  }),
  excel: Object.freeze({
    operation: 'merge-excel',
    inspectOperation: 'inspect-excel',
    outputExtension: '.xlsx',
    inputExtensions: Object.freeze(['.xls', '.xlsx', '.ods', '.csv']),
    rejectedExtensions: Object.freeze(['.xlsm', '.xlsb', '.xlam', '.xltm', '.xlt', '.xltx'])
  })
});

const ZIP_SIGNATURES = Object.freeze([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08])
]);
const OLE_COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function nativeOfficeMergeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizeNativeOfficeMergeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (!Object.hasOwn(NATIVE_OFFICE_MERGE_FORMATS, kind)) {
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_KIND_INVALID',
      '합칠 문서 형식을 Word 또는 Excel 중에서 선택해주세요.'
    );
  }
  return kind;
}

function normalizeNativeOfficeMergeOperation(value) {
  const operation = String(value || '').trim().toLowerCase();
  const allowed = new Set(Object.values(NATIVE_OFFICE_MERGE_FORMATS)
    .flatMap((format) => [format.operation, format.inspectOperation]));
  if (!allowed.has(operation)) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_OPERATION_INVALID', '지원하지 않는 Office 병합 작업입니다.');
  }
  return operation;
}

function formatForKind(kind) {
  return NATIVE_OFFICE_MERGE_FORMATS[normalizeNativeOfficeMergeKind(kind)];
}

function normalizedExtension(filePath) {
  return path.extname(String(filePath || '')).toLowerCase();
}

function assertNativeOfficeInputExtension(kind, filePath) {
  const normalizedKind = normalizeNativeOfficeMergeKind(kind);
  const format = NATIVE_OFFICE_MERGE_FORMATS[normalizedKind];
  const extension = normalizedExtension(filePath);
  if (format.rejectedExtensions.includes(extension)) {
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_MACRO_FORMAT_REJECTED',
      `${path.basename(String(filePath || '문서'))} 파일은 매크로 또는 특수 기능을 포함할 수 있어 안전한 병합 대상에서 제외됩니다.`
    );
  }
  if (!format.inputExtensions.includes(extension)) {
    const types = format.inputExtensions.map((item) => item.slice(1).toUpperCase()).join('·');
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_INPUT_FORMAT_INVALID',
      `${normalizedKind === 'word' ? 'Word' : 'Excel'} 병합은 ${types} 파일만 사용할 수 있습니다.`
    );
  }
  return extension;
}

function assertNativeOfficeOutputExtension(kind, outputPath) {
  const normalizedKind = normalizeNativeOfficeMergeKind(kind);
  const expected = NATIVE_OFFICE_MERGE_FORMATS[normalizedKind].outputExtension;
  if (normalizedExtension(outputPath) !== expected) {
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_OUTPUT_FORMAT_INVALID',
      `병합 결과는 ${expected.toUpperCase()} 파일로 저장해주세요.`
    );
  }
  return expected;
}

function lowerWindowsPath(value) {
  return path.resolve(String(value || '')).toLocaleLowerCase('en-US');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function assertNotEncryptedOoxmlContainer(filePath, extension) {
  if (extension !== '.docx' && extension !== '.xlsx') return;
  const handle = await fs.promises.open(filePath, 'r');
  const header = Buffer.alloc(OLE_COMPOUND_FILE_SIGNATURE.length);
  try { await handle.read(header, 0, header.length, 0); }
  finally { await handle.close(); }
  if (header.equals(OLE_COMPOUND_FILE_SIGNATURE)) {
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_ENCRYPTED_CONTAINER_REJECTED',
      `${path.basename(filePath)} 파일은 암호화된 Office 컨테이너여서 병합할 수 없습니다. 암호를 해제한 복사본을 선택해주세요.`
    );
  }
}

async function inspectNativeOfficeMergeSources(kind, inputPaths, options = {}) {
  const normalizedKind = normalizeNativeOfficeMergeKind(kind);
  const sources = Array.isArray(inputPaths) ? inputPaths : [];
  const minimum = options.allowSingle === true ? 1 : MIN_NATIVE_OFFICE_MERGE_FILES;
  if (sources.length < minimum || sources.length > MAX_NATIVE_OFFICE_MERGE_FILES) {
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_FILE_COUNT_INVALID',
      `합칠 파일을 ${minimum}개 이상, ${MAX_NATIVE_OFFICE_MERGE_FILES}개 이하로 선택해주세요.`
    );
  }

  const inspected = [];
  let totalBytes = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const requestedPath = path.resolve(String(sources[index] || ''));
    const extension = assertNativeOfficeInputExtension(normalizedKind, requestedPath);
    let stats;
    let realPath;
    try {
      stats = await fs.promises.stat(requestedPath);
      realPath = await fs.promises.realpath(requestedPath);
    } catch (error) {
      throw nativeOfficeMergeError(
        'NATIVE_OFFICE_MERGE_INPUT_NOT_FOUND',
        `${path.basename(requestedPath) || `${index + 1}번째 파일`} 파일을 찾을 수 없습니다. 다시 선택해주세요.`,
        error
      );
    }
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_NATIVE_OFFICE_INPUT_BYTES) {
      throw nativeOfficeMergeError(
        'NATIVE_OFFICE_MERGE_INPUT_SIZE_INVALID',
        `${path.basename(requestedPath)} 파일은 비어 있지 않은 512MB 이하 문서여야 합니다.`
      );
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_NATIVE_OFFICE_TOTAL_BYTES) {
      throw nativeOfficeMergeError(
        'NATIVE_OFFICE_MERGE_TOTAL_SIZE_EXCEEDED',
        '선택한 문서의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.'
      );
    }
    const canonicalStats = await fs.promises.stat(realPath);
    await assertNotEncryptedOoxmlContainer(realPath, extension);
    const sha256 = await sha256File(realPath);
    inspected.push({
      index,
      filePath: realPath,
      name: path.basename(realPath),
      extension,
      bytes: canonicalStats.size,
      modifiedAt: canonicalStats.mtimeMs,
      sha256
    });
  }
  return { kind: normalizedKind, sourceCount: inspected.length, totalBytes, sources: inspected };
}

function nativeOfficeCompatibilityInputs(kind, sources) {
  const normalizedKind = normalizeNativeOfficeMergeKind(kind);
  const nativeExtension = normalizedKind === 'word' ? '.docx' : '.xlsx';
  return (Array.isArray(sources) ? sources : [])
    .filter((source) => String(source?.extension || '').toLowerCase() !== nativeExtension)
    .map((source) => ({
      index: Number(source.index),
      name: String(source.name || ''),
      extension: String(source.extension || '').replace(/^\./, '').toLowerCase()
    }));
}

async function prepareNativeOfficeMergePlan(kind, inputPaths, outputPath) {
  const normalizedKind = normalizeNativeOfficeMergeKind(kind);
  const sourceInspection = await inspectNativeOfficeMergeSources(normalizedKind, inputPaths);
  assertNativeOfficeOutputExtension(normalizedKind, outputPath);

  const requestedOutput = path.resolve(String(outputPath || ''));
  const outputDirectory = path.dirname(requestedOutput);
  let outputDirectoryStats;
  let canonicalDirectory;
  try {
    outputDirectoryStats = await fs.promises.stat(outputDirectory);
    canonicalDirectory = await fs.promises.realpath(outputDirectory);
  } catch (error) {
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_OUTPUT_DIRECTORY_NOT_FOUND',
      '결과를 저장할 폴더를 찾을 수 없습니다. 다시 선택해주세요.',
      error
    );
  }
  if (!outputDirectoryStats.isDirectory()) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_OUTPUT_DIRECTORY_INVALID', '결과 저장 위치가 폴더가 아닙니다.');
  }
  const canonicalOutput = path.join(canonicalDirectory, path.basename(requestedOutput));
  try {
    await fs.promises.access(canonicalOutput, fs.constants.F_OK);
    throw nativeOfficeMergeError(
      'NATIVE_OFFICE_MERGE_OUTPUT_EXISTS',
      `${path.basename(canonicalOutput)} 파일이 이미 있습니다. 다른 이름을 사용해주세요.`
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (sourceInspection.sources.some((source) => lowerWindowsPath(source.filePath) === lowerWindowsPath(canonicalOutput))) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_OUTPUT_EQUALS_INPUT', '원본 파일과 같은 위치에는 병합 결과를 저장할 수 없습니다.');
  }
  return {
    ...sourceInspection,
    operation: NATIVE_OFFICE_MERGE_FORMATS[normalizedKind].operation,
    outputPath: canonicalOutput,
    compatibilityInputs: nativeOfficeCompatibilityInputs(normalizedKind, sourceInspection.sources),
    requiresPreview: sourceInspection.sources.length > 0
  };
}

function truncateSheetName(value, maximumLength) {
  let result = String(value || '').slice(0, maximumLength);
  if (result && /[\uD800-\uDBFF]/.test(result.at(-1))) result = result.slice(0, -1);
  return result;
}

function safeExcelSheetName(value, usedNames = new Set(), fallbackIndex = 1) {
  const used = usedNames instanceof Set ? usedNames : new Set();
  let base = String(value || '')
    .replace(/[:\\/?*\[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  if (!base) base = `Sheet ${Math.max(1, Number(fallbackIndex) || 1)}`;
  base = truncateSheetName(base, 31) || `Sheet ${Math.max(1, Number(fallbackIndex) || 1)}`;
  const unavailable = (candidate) => used.has(candidate.toLocaleLowerCase('en-US'))
    || candidate.toLocaleLowerCase('en-US') === 'history';
  let candidate = base;
  let suffixIndex = 2;
  while (unavailable(candidate)) {
    const suffix = ` (${suffixIndex})`;
    candidate = `${truncateSheetName(base, 31 - suffix.length)}${suffix}`;
    suffixIndex += 1;
  }
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

function nativeOfficeMergeContract(kind) {
  const normalizedKind = normalizeNativeOfficeMergeKind(kind);
  if (normalizedKind === 'word') {
    return {
      kind: normalizedKind,
      outputExtension: '.docx',
      ordering: 'selected-files',
      boundary: 'next-page-section-break',
      headerFooterLinkIsolation: 'verified-at-appended-boundaries',
      fidelity: 'microsoft-word-native-best-effort',
      limitations: [
        'headers-footers-section-layout-best-effort',
        'fields-cross-references-and-toc-may-recalculate',
        'every-result-requires-native-preview',
        'password-irm-or-macro-bearing-inputs-are-rejected',
        'doc-odt-and-rtf-inputs-require-result-preview'
      ]
    };
  }
  return {
    kind: normalizedKind,
    outputExtension: '.xlsx',
    ordering: 'selected-files-then-source-sheets',
    sheetScope: 'all-sheets-including-chart-sheets',
    optionalCombinedSheet: 'first-sheet-single-header-position-aligned',
    combinedSheetDataMode: 'calculated-values-with-cell-formatting',
    preservesVisibility: true,
    fidelity: 'microsoft-excel-native-best-effort',
    limitations: [
      'sheet-names-are-normalized-and-deduplicated',
      'renaming-may-update-formulas-and-cross-workbook-links-may-remain',
      'optional-combined-sheet-uses-calculated-values-not-live-formulas',
      'connections-pivots-and-external-data-refresh-are-not-run',
      'every-result-requires-native-preview',
      'password-irm-or-macro-bearing-inputs-are-rejected',
      'xls-ods-and-csv-inputs-require-result-preview'
    ]
  };
}

function workerErrorMessage(value) {
  const code = String(value || '').trim();
  const messages = {
    DOCUMENT_TOOL_CANCELLED: '문서 병합을 중단했습니다.',
    WORD_IN_USE: '열려 있는 Word 문서를 보호하기 위해 병합을 시작하지 않았습니다. Word를 닫고 다시 시도해주세요.',
    EXCEL_IN_USE: '열려 있는 Excel 통합문서를 보호하기 위해 병합을 시작하지 않았습니다. Excel을 닫고 다시 시도해주세요.',
    WORD_START_FAILED: '이 PC에서 Microsoft Word를 실행하지 못했습니다. Word 설치 또는 Office 복구 상태를 확인해주세요.',
    EXCEL_START_FAILED: '이 PC에서 Microsoft Excel을 실행하지 못했습니다. Excel 설치 또는 Office 복구 상태를 확인해주세요.',
    WORD_MACRO_INPUT_REJECTED: '매크로가 포함된 Word 문서는 안전한 병합 대상에서 제외됩니다.',
    EXCEL_MACRO_INPUT_REJECTED: '매크로나 Excel 4.0 매크로 시트가 포함된 통합문서는 안전한 병합 대상에서 제외됩니다.',
    WORD_MACRO_INSPECTION_FAILED: 'Word 문서의 매크로 포함 여부를 안전하게 확인하지 못했습니다.',
    WORD_PASSWORD_INPUT_REJECTED: '암호가 설정된 Word 문서는 안전한 병합 대상에서 제외됩니다.',
    WORD_IRM_INPUT_REJECTED: 'IRM 권한으로 보호된 Word 문서는 안전한 병합 대상에서 제외됩니다.',
    WORD_PROTECTED_INPUT_REJECTED: '편집 제한이 설정된 Word 문서는 안전한 병합 대상에서 제외됩니다. 보호를 해제한 복사본을 선택해주세요.',
    WORD_SIGNED_INPUT_REJECTED: '디지털 서명이 있는 Word 문서는 병합 시 서명이 무효화될 수 있어 대상에서 제외됩니다.',
    WORD_SECURITY_INSPECTION_FAILED: 'Word 문서의 암호·권한 보호 상태를 안전하게 확인하지 못했습니다.',
    EXCEL_MACRO_INSPECTION_FAILED: 'Excel 파일의 매크로 포함 여부를 안전하게 확인하지 못했습니다.',
    EXCEL_PASSWORD_INPUT_REJECTED: '암호가 설정된 Excel 파일은 안전한 병합 대상에서 제외됩니다.',
    EXCEL_IRM_INPUT_REJECTED: 'IRM 권한으로 보호된 Excel 파일은 안전한 병합 대상에서 제외됩니다.',
    EXCEL_SIGNED_INPUT_REJECTED: '디지털 서명이 있는 Excel 파일은 병합 시 서명이 무효화될 수 있어 대상에서 제외됩니다.',
    EXCEL_SECURITY_INSPECTION_FAILED: 'Excel 파일의 암호·권한 보호 상태를 안전하게 확인하지 못했습니다.',
    EXCEL_EXTERNAL_LINK_INSPECTION_FAILED: 'Excel 파일의 외부 연결·데이터 연결 상태를 안전하게 확인하지 못했습니다.',
    EXCEL_WORKBOOK_PROTECTED_REJECTED: '통합문서 구조가 보호된 Excel 파일은 시트를 안전하게 합칠 수 없습니다.',
    ENCRYPTED_CONTAINER_REJECTED: '암호화된 Office 파일은 병합할 수 없습니다. 암호를 해제한 복사본을 선택해주세요.',
    MACRO_FORMAT_REJECTED: '매크로 또는 특수 기능 형식은 안전한 병합 대상에서 제외됩니다.',
    INPUT_IDENTITY_INVALID: '원본 파일 확인 정보가 올바르지 않습니다. 파일을 다시 선택해주세요.',
    WORD_INPUT_EMPTY: 'Word 문서에 합칠 페이지가 없습니다.',
    EXCEL_INPUT_EMPTY: 'Excel 파일에 합칠 시트가 없습니다.',
    INPUT_IDENTITY_CHANGED: '선택한 원본 파일이 확인 이후 바뀌었습니다. 파일을 다시 선택해주세요.',
    INPUT_NOT_FOUND: '선택한 원본 파일을 찾을 수 없습니다.',
    INPUT_FORMAT_INVALID: '지원하지 않는 입력 문서 형식입니다.',
    INPUT_COUNT_INVALID: '합칠 파일 수가 올바르지 않습니다.',
    OUTPUT_EXISTS: '같은 이름의 결과 파일이 이미 있습니다. 다른 이름을 사용해주세요.',
    OUTPUT_DIRECTORY_NOT_FOUND: '결과 저장 폴더를 찾을 수 없습니다.',
    OUTPUT_FORMAT_INVALID: '결과 파일 형식이 올바르지 않습니다.',
    OUTPUT_EQUALS_INPUT: '원본 파일과 같은 위치에는 결과를 저장할 수 없습니다.',
    WORD_INPUT_OPEN_FAILED: 'Word에서 원본 문서를 안전하게 열지 못했습니다.',
    WORD_INSERT_FAILED: 'Word 문서 내용을 순서대로 삽입하지 못했습니다.',
    WORD_SAVE_FAILED: 'Word 병합 결과를 DOCX로 저장하지 못했습니다.',
    WORD_OUTPUT_VERIFY_FAILED: 'Word 병합 결과를 다시 열어 검증하지 못했습니다.',
    WORD_MERGE_FAILED: 'Microsoft Word가 문서를 합치지 못했습니다. 원본을 Word에서 다시 저장한 뒤 시도해주세요.',
    WORD_OPERATION_FAILED: 'Microsoft Word 문서 검사 또는 병합을 완료하지 못했습니다.',
    EXCEL_INPUT_OPEN_FAILED: 'Excel에서 원본 통합문서를 안전하게 열지 못했습니다.',
    EXCEL_SHEET_COPY_FAILED: 'Excel 시트를 순서대로 복사하지 못했습니다.',
    EXCEL_SHEET_REFERENCE_REBIND_FAILED: '복사한 Excel 시트 사이의 수식·차트 연결을 새 통합문서 안으로 안전하게 연결하지 못했습니다.',
    EXCEL_SHEET_NAME_FAILED: 'Excel 시트 이름을 안전하게 정리하지 못했습니다.',
    EXCEL_COMBINED_HEADER_MISMATCH: '전체 통합 시트를 만들 수 없습니다. 합칠 워크시트의 첫 번째 행(헤더)이 서로 다릅니다.',
    EXCEL_COMBINED_HEADER_MISSING: '전체 통합 시트를 만들 수 없습니다. 첫 번째 행에서 사용할 헤더를 찾지 못했습니다.',
    EXCEL_COMBINED_ROW_LIMIT_EXCEEDED: '전체 통합 데이터가 Excel 한 시트의 최대 행 수를 넘습니다. 파일을 나눠 합쳐주세요.',
    EXCEL_COMBINED_SHEET_FAILED: 'Excel 시트의 데이터를 전체 통합 시트로 모으지 못했습니다.',
    EXCEL_COMBINED_OUTPUT_VERIFY_FAILED: '전체 통합 시트의 행·열·헤더를 저장 후 다시 확인하지 못했습니다.',
    EXCEL_SAVE_FAILED: 'Excel 병합 결과를 XLSX로 저장하지 못했습니다.',
    EXCEL_OUTPUT_VERIFY_FAILED: 'Excel 병합 결과를 다시 열어 검증하지 못했습니다.',
    EXCEL_BASE_COPY_FAILED: '첫 XLSX 파일을 기준 통합문서로 안전하게 복제하지 못했습니다.',
    EXCEL_MERGE_FAILED: 'Microsoft Excel이 통합문서를 합치지 못했습니다. 원본을 Excel에서 다시 저장한 뒤 시도해주세요.',
    EXCEL_OPERATION_FAILED: 'Microsoft Excel 파일 검사 또는 병합을 완료하지 못했습니다.',
    OUTPUT_PUBLISH_FAILED: '검증한 병합 결과를 최종 위치에 저장하지 못했습니다.',
    OUTPUT_NOT_CREATED: '문서 앱이 병합 결과를 만들지 못했습니다.',
    MISSING_RESULT_PATH: '문서 병합 결과 정보를 저장할 위치가 없습니다.',
    UNSUPPORTED_OPERATION: '지원하지 않는 Microsoft Office 병합 작업입니다.'
  };
  if (messages[code]) return messages[code];
  if (/80040154|REGDB_E_CLASSNOTREG|class not registered|클래스 팩터리/i.test(code)) {
    return '필요한 Microsoft Office 앱이 설치되어 있지 않거나 정상 등록되지 않았습니다.';
  }
  return 'Microsoft Office 문서 병합을 완료하지 못했습니다.';
}

function workerFailure(value, fallbackCode = 'NATIVE_OFFICE_MERGE_WORKER_FAILED') {
  const workerCode = String(value || '').trim();
  const code = workerCode === 'DOCUMENT_TOOL_CANCELLED' ? 'NATIVE_OFFICE_MERGE_CANCELLED' : fallbackCode;
  const error = nativeOfficeMergeError(code, workerErrorMessage(workerCode));
  error.workerCode = workerCode.slice(0, 128);
  return error;
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_NATIVE_OFFICE_PROCESS_OUTPUT_BYTES) return current;
  return (current + String(chunk || '')).slice(0, MAX_NATIVE_OFFICE_PROCESS_OUTPUT_BYTES);
}

function publicWorkerProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const progress = { ok: value.ok === true };
  for (const key of ['index', 'completed', 'total']) {
    const number = Number(value[key]);
    if (Number.isInteger(number) && number >= 0 && number <= MAX_NATIVE_OFFICE_MERGE_FILES) progress[key] = number;
  }
  if (value.ok !== true && typeof value.error === 'string') {
    progress.error = String(value.error).replace(/[^A-Z0-9_.-]/gi, '_').slice(0, 80);
  }
  return progress;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let graceTimer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      callback(value);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { options.onTimeout?.(); } catch (_) {}
      graceTimer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish(reject, nativeOfficeMergeError('NATIVE_OFFICE_MERGE_TIMEOUT', '문서 병합 시간이 초과되었습니다. 파일 수를 줄여 다시 시도해주세요.'));
      }, Math.max(1_000, Number(options.cooperativeTimeoutGraceMs) || 30_000));
    }, Math.max(10_000, Number(options.timeoutMs) || DEFAULT_NATIVE_OFFICE_TIMEOUT_MS));
    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
      options.onStdout?.(String(chunk));
    });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (timedOut) {
        finish(reject, nativeOfficeMergeError('NATIVE_OFFICE_MERGE_TIMEOUT', '문서 병합 시간이 초과되었습니다. 파일 수를 줄여 다시 시도해주세요.'));
        return;
      }
      finish(resolve, { code: Number(code), stdout, stderr });
    });
  });
}

function nativeOfficeMergeWorkerPath() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'office-tools', 'native-office-merge.ps1');
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, 'native-office-merge.ps1');
}

function windowsPowerShellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function runNativeOfficeMergeWorker(operation, items, jobRoot, onProgress, options = {}) {
  const normalizedOperation = normalizeNativeOfficeMergeOperation(operation);
  const root = path.resolve(String(jobRoot || ''));
  const rootStats = await fs.promises.stat(root).catch(() => null);
  if (!rootStats?.isDirectory()) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_JOB_DIRECTORY_INVALID', '문서 병합 임시 폴더를 준비하지 못했습니다.');
  }
  const worker = path.resolve(options.workerPath || nativeOfficeMergeWorkerPath());
  const powershell = path.resolve(options.powershellPath || windowsPowerShellPath());
  if (!fs.existsSync(worker) || (!options.processRunner && !fs.existsSync(powershell))) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_WORKER_MISSING', 'Microsoft Office 병합 도구를 찾을 수 없습니다.');
  }
  const resultPath = path.join(root, `native-office-merge-result-${crypto.randomUUID()}.json`);
  const jobPath = path.join(root, `native-office-merge-job-${crypto.randomUUID()}.json`);
  const cancelPath = typeof options.isCancelled === 'function'
    ? path.join(root, `native-office-merge-cancel-${crypto.randomUUID()}.signal`)
    : '';
  const normalizedItems = Array.isArray(items) ? items : [];
  await fs.promises.writeFile(jobPath, JSON.stringify({
    operation: normalizedOperation,
    resultPath,
    cancelPath,
    items: normalizedItems
  }), { encoding: 'utf8', flag: 'wx' });

  let pending = '';
  const parseProgress = (chunk) => {
    pending += String(chunk || '');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const marker = line.indexOf('CMOE_PROGRESS:');
      if (marker < 0) continue;
      try {
        const progress = publicWorkerProgress(JSON.parse(line.slice(marker + 'CMOE_PROGRESS:'.length)));
        if (progress) onProgress?.(progress);
      } catch (_) {}
    }
  };
  let cancellationTimer = null;
  let cancellationWriteStarted = false;
  let cancellationWritePromise = Promise.resolve();
  const writeCancellationSignal = () => {
    if (!cancelPath || cancellationWriteStarted) return cancellationWritePromise;
    cancellationWriteStarted = true;
    cancellationWritePromise = fs.promises.writeFile(cancelPath, 'cancelled', { encoding: 'ascii', flag: 'wx' }).catch((error) => {
      if (error?.code !== 'EEXIST') cancellationWriteStarted = false;
    });
    return cancellationWritePromise;
  };
  if (cancelPath) {
    const pollCancellation = () => { if (options.isCancelled?.()) writeCancellationSignal(); };
    pollCancellation();
    cancellationTimer = setInterval(pollCancellation, 250);
    cancellationTimer.unref?.();
  }

  const processRunner = options.processRunner || runProcess;
  let processResult;
  let payload = null;
  let processError = null;
  try {
    try {
      processResult = await processRunner(powershell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', worker, '-JobFile', jobPath
      ], {
        cwd: root,
        timeoutMs: Math.min(MAX_NATIVE_OFFICE_TIMEOUT_MS, Math.max(60_000, Number(options.timeoutMs) || DEFAULT_NATIVE_OFFICE_TIMEOUT_MS)),
        cooperativeTimeoutGraceMs: 30_000,
        onStdout: parseProgress,
        onTimeout: cancelPath ? writeCancellationSignal : undefined
      });
    } catch (error) {
      processError = error;
    }
    try { payload = JSON.parse(await fs.promises.readFile(resultPath, 'utf8')); } catch (_) {}
  } finally {
    if (cancellationTimer) clearInterval(cancellationTimer);
    await cancellationWritePromise.catch(() => {});
    await Promise.all([jobPath, cancelPath].filter(Boolean).map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
  }

  try {
    if (processError) throw processError;
    if (!payload || !Array.isArray(payload.results)) {
      throw workerFailure(payload?.fatalError || processResult?.stderr || processResult?.stdout);
    }
    if (processResult.code !== 0 || payload.ok !== true) throw workerFailure(payload.fatalError);
    return payload.results.map((item) => item?.ok === true
      ? item
      : { ...item, errorMessage: workerErrorMessage(item?.error) });
  } finally {
    await fs.promises.unlink(resultPath).catch(() => {});
  }
}

function sourceWorkerItem(source) {
  return {
    inputPath: source.filePath,
    expectedIdentity: { bytes: source.bytes, sha256: source.sha256 }
  };
}

function throwWorkerItemError(item) {
  if (item?.ok === true) return;
  throw workerFailure(item?.error, 'NATIVE_OFFICE_MERGE_ITEM_FAILED');
}

async function inspectNativeOfficeFiles(kind, inputPaths, jobRoot, options = {}) {
  const normalizedKind = normalizeNativeOfficeMergeKind(kind);
  const inspected = await inspectNativeOfficeMergeSources(normalizedKind, inputPaths, { allowSingle: true });
  const results = await runNativeOfficeMergeWorker(
    NATIVE_OFFICE_MERGE_FORMATS[normalizedKind].inspectOperation,
    inspected.sources.map(sourceWorkerItem),
    jobRoot,
    options.onProgress,
    options
  );
  if (results.length !== inspected.sources.length) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_INSPECTION_RESULT_INVALID', 'Office 문서 검사 결과가 선택한 파일 수와 다릅니다.');
  }
  const files = results.map((result, index) => {
    throwWorkerItemError(result);
    if (Number(result.index) !== index) {
      throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_INSPECTION_RESULT_INVALID', 'Office 문서 검사 순서를 확인하지 못했습니다.');
    }
    const source = inspected.sources[index];
    if (normalizedKind === 'word') {
      const pageCount = Number(result.pageCount);
      const sectionCount = Number(result.sectionCount);
      if (!Number.isInteger(pageCount) || pageCount < 1 || !Number.isInteger(sectionCount) || sectionCount < 1) {
        throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_INSPECTION_RESULT_INVALID', 'Word 문서의 페이지 정보를 확인하지 못했습니다.');
      }
      return {
        index,
        name: source.name,
        extension: source.extension.slice(1),
        bytes: source.bytes,
        pageCount,
        sectionCount,
        revisionCount: Math.max(0, Number(result.revisionCount) || 0),
        commentCount: Math.max(0, Number(result.commentCount) || 0),
        hasMacros: false,
        requiresPreview: true
      };
    }
    const sheets = Array.isArray(result.sheets) ? result.sheets.map((sheet, sheetIndex) => ({
      index: sheetIndex,
      name: String(sheet?.name || '').slice(0, 31),
      type: String(sheet?.type || 'unknown').slice(0, 32),
      visibility: ['visible', 'hidden', 'veryHidden'].includes(sheet?.visibility) ? sheet.visibility : 'unknown'
    })) : [];
    const allowedSheetTypes = new Set(['worksheet', 'chart', 'dialog', 'other']);
    const allowedVisibility = new Set(['visible', 'hidden', 'veryHidden']);
    if (!sheets.length || Number(result.sheetCount) !== sheets.length
      || sheets.some((sheet) => !allowedSheetTypes.has(sheet.type) || !allowedVisibility.has(sheet.visibility))) {
      throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_INSPECTION_RESULT_INVALID', 'Excel 파일의 시트 정보를 확인하지 못했습니다.');
    }
    return {
      index,
      name: source.name,
      extension: source.extension.slice(1),
      bytes: source.bytes,
      sheetCount: sheets.length,
      sheets,
      hasMacros: false,
      externalLinksPresent: Number(result.externalLinkCount) > 0,
      externalLinkCount: Math.max(0, Number(result.externalLinkCount) || 0),
      requiresPreview: true
    };
  });
  const compatibilityInputs = nativeOfficeCompatibilityInputs(normalizedKind, inspected.sources);
  return {
    kind: normalizedKind,
    sourceCount: files.length,
    totalBytes: inspected.totalBytes,
    files,
    compatibilityInputs,
    requiresPreview: files.length > 0,
    contract: nativeOfficeMergeContract(normalizedKind)
  };
}

async function assertGeneratedZip(filePath) {
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.size < 4) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_OUTPUT_INVALID', '병합 결과 파일이 비어 있거나 올바르지 않습니다.');
  }
  const handle = await fs.promises.open(filePath, 'r');
  const header = Buffer.alloc(4);
  try { await handle.read(header, 0, header.length, 0); }
  finally { await handle.close(); }
  if (!ZIP_SIGNATURES.some((signature) => header.equals(signature))) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_OUTPUT_INVALID', '병합 결과가 올바른 Office Open XML 문서가 아닙니다.');
  }
  return stats;
}

async function mergeNativeOfficeFiles(kind, inputPaths, outputPath, jobRoot, options = {}) {
  const plan = await prepareNativeOfficeMergePlan(kind, inputPaths, outputPath);
  const addCombinedSheet = plan.kind === 'excel' && options.addCombinedSheet === true;
  const useFileNameAsSheetName = plan.kind === 'excel' && options.useFileNameAsSheetName === true;
  const item = {
    inputPaths: plan.sources.map((source) => source.filePath),
    expectedIdentities: plan.sources.map((source) => ({ bytes: source.bytes, sha256: source.sha256 })),
    outputPath: plan.outputPath,
    addCombinedSheet,
    combinedSheetName: addCombinedSheet ? String(options.combinedSheetName || '') : '',
    useFileNameAsSheetName,
    sourceFileNames: plan.sources.map((source, index) => path.basename(String(options.sourceFileNames?.[index] || source.filePath)))
  };
  const results = await runNativeOfficeMergeWorker(
    plan.operation,
    [item],
    jobRoot,
    options.onProgress,
    options
  );
  if (results.length !== 1) {
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_RESULT_INVALID', 'Office 병합 결과를 정확히 확인하지 못했습니다.');
  }
  const result = results[0];
  throwWorkerItemError(result);
  if (Number(result.index) !== 0
    || lowerWindowsPath(result.outputPath) !== lowerWindowsPath(plan.outputPath)
    || Number(result.sourceCount) !== plan.sourceCount) {
    await fs.promises.unlink(plan.outputPath).catch(() => {});
    throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_RESULT_INVALID', 'Office 병합 결과가 요청한 파일 및 순서와 일치하지 않습니다.');
  }
  try {
    const stats = await assertGeneratedZip(plan.outputPath);
    if (plan.kind === 'word') {
      const pageCount = Number(result.pageCount);
      const sourcePageCounts = Array.isArray(result.sourcePageCounts) ? result.sourcePageCounts.map(Number) : [];
      if (!Number.isInteger(pageCount) || pageCount < 1
        || sourcePageCounts.length !== plan.sourceCount
        || sourcePageCounts.some((value) => !Number.isInteger(value) || value < 1)) {
        throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_RESULT_INVALID', 'Word 병합 결과의 페이지 수를 확인하지 못했습니다.');
      }
      return {
        kind: plan.kind,
        outputPath: plan.outputPath,
        outputName: path.basename(plan.outputPath),
        outputBytes: stats.size,
        sourceCount: plan.sourceCount,
        sourcePageCounts,
        pageCount,
        sectionCount: Math.max(1, Number(result.sectionCount) || 1),
        headerFooterLinksDetached: Number(result.headerFooterLinksDetached) || 0,
        headerFooterLinkFailures: Math.max(0, Number(result.headerFooterLinkFailures) || 0),
        compatibilityInputs: plan.compatibilityInputs,
        requiresPreview: true,
        contract: nativeOfficeMergeContract(plan.kind)
      };
    }
    const sheetCount = Number(result.sheetCount);
    const sheetNames = Array.isArray(result.sheetNames) ? result.sheetNames.map((name) => String(name || '').slice(0, 31)) : [];
    const sourceSheetCounts = Array.isArray(result.sourceSheetCounts) ? result.sourceSheetCounts.map(Number) : [];
    const sheetVisibility = Array.isArray(result.sheetVisibility) ? result.sheetVisibility.map(String) : [];
    const sheetTypes = Array.isArray(result.sheetTypes) ? result.sheetTypes.map(String) : [];
    const combinedSheetAdded = result.combinedSheetAdded === true;
    const combinedSheetName = combinedSheetAdded ? String(result.combinedSheetName || '').slice(0, 31) : '';
    const combinedRowCount = Number(result.combinedRowCount ?? 0);
    const combinedColumnCount = Number(result.combinedColumnCount ?? 0);
    const combinedDataMode = combinedSheetAdded ? String(result.combinedDataMode || '') : '';
    const allowedSheetTypes = new Set(['worksheet', 'chart', 'dialog', 'other']);
    const allowedVisibility = new Set(['visible', 'hidden', 'veryHidden']);
    const originalSheetCount = sourceSheetCounts.reduce((sum, value) => sum + value, 0);
    if (!Number.isInteger(sheetCount) || sheetCount < 1 || sheetNames.length !== sheetCount
      || sheetTypes.length !== sheetCount
      || sheetVisibility.length !== sheetCount
      || sourceSheetCounts.length !== plan.sourceCount
      || sourceSheetCounts.some((value) => !Number.isInteger(value) || value < 1)
      || sheetCount !== originalSheetCount + (addCombinedSheet ? 1 : 0)
      || new Set(sheetNames.map((name) => name.toLocaleLowerCase('en-US'))).size !== sheetCount
      || sheetTypes.some((type) => !allowedSheetTypes.has(type))
      || sheetVisibility.some((visibility) => !allowedVisibility.has(visibility))
      || combinedSheetAdded !== addCombinedSheet
      || !Number.isInteger(combinedRowCount) || combinedRowCount < 0
      || !Number.isInteger(combinedColumnCount) || combinedColumnCount < 0
      || (combinedSheetAdded && (!combinedSheetName
        || sheetNames[0] !== combinedSheetName
        || sheetTypes[0] !== 'worksheet'
        || sheetVisibility[0] !== 'visible'
        || combinedDataMode !== 'calculated-values-with-cell-formatting'
        || combinedRowCount < 1
        || combinedColumnCount < 1))
      || (!combinedSheetAdded && (combinedSheetName || combinedRowCount !== 0 || combinedColumnCount !== 0 || combinedDataMode))) {
      throw nativeOfficeMergeError('NATIVE_OFFICE_MERGE_RESULT_INVALID', 'Excel 병합 결과의 시트 순서와 이름을 확인하지 못했습니다.');
    }
    return {
      kind: plan.kind,
      outputPath: plan.outputPath,
      outputName: path.basename(plan.outputPath),
      outputBytes: stats.size,
      sourceCount: plan.sourceCount,
      sourceSheetCounts,
      sheetCount,
      sheetNames,
      sheetTypes,
      sheetVisibility,
      combinedSheetAdded,
      combinedSheetName,
      combinedRowCount,
      combinedColumnCount,
      combinedDataMode,
      externalLinksPresent: Number(result.externalLinkCount) > 0,
      externalLinkCount: Math.max(0, Number(result.externalLinkCount) || 0),
      baseStrategy: result.baseStrategy === 'physical-first-xlsx' ? 'physical-first-xlsx' : 'new-workbook-compatibility',
      compatibilityInputs: plan.compatibilityInputs,
      requiresPreview: true,
      contract: nativeOfficeMergeContract(plan.kind)
    };
  } catch (error) {
    await fs.promises.unlink(plan.outputPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  MIN_NATIVE_OFFICE_MERGE_FILES,
  MAX_NATIVE_OFFICE_MERGE_FILES,
  MAX_NATIVE_OFFICE_INPUT_BYTES,
  MAX_NATIVE_OFFICE_TOTAL_BYTES,
  NATIVE_OFFICE_MERGE_FORMATS,
  nativeOfficeMergeError,
  normalizeNativeOfficeMergeKind,
  normalizeNativeOfficeMergeOperation,
  assertNativeOfficeInputExtension,
  assertNativeOfficeOutputExtension,
  inspectNativeOfficeMergeSources,
  nativeOfficeCompatibilityInputs,
  prepareNativeOfficeMergePlan,
  safeExcelSheetName,
  nativeOfficeMergeContract,
  publicWorkerProgress,
  workerErrorMessage,
  runNativeOfficeMergeWorker,
  inspectNativeOfficeFiles,
  mergeNativeOfficeFiles
};
