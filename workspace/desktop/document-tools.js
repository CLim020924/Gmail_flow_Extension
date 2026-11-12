'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { createInflateRaw } = require('node:zlib');
const { TextDecoder } = require('node:util');
const { SaxesParser } = require(path.join(__dirname, '..', 'vendor', 'node_modules', 'saxes'));
const { JsonStorage } = require('./storage');
const { inspectXlsxWorkbookStructure, readWorkbookSheets } = require('./spreadsheet');
const {
  MAX_PPTX_BYTES,
  inspectPptxFile,
  readPptxFile,
  buildCertificatePptx
} = require('./pptx-template');
const {
  MIN_MERGE_FILES,
  MAX_MERGE_FILES,
  MAX_MERGE_INPUT_BYTES,
  normalizeDocumentMergeKind,
  inspectPdfFile,
  mergePdfFiles,
  sameSlideSize,
  assertCompatiblePptxInspections
} = require('./document-merge');
const {
  documentSplitError,
  normalizeDocumentSplitKind,
  normalizeDocumentSplitMethod,
  validateDocumentSplitGroups,
  defaultDocumentSplitOutputName,
  projectDocumentSplitStorage,
  assertDocumentSplitFreeSpace,
  assertDocumentSplitActualStorage,
  splitPdfFile,
  splitPptxFile
} = require('./document-split');
const DocumentConversion = require('./document-conversion');
const DocumentDependencies = require('./document-dependencies');
const DEFAULT_DOCUMENT_DEPENDENCY_MANIFEST = require('./document-dependency-manifest');
const {
  MAX_ARCHIVE_BYTES: MAX_DOCUMENT_FONT_INSPECTION_BYTES,
  SUPPORTED_FORMATS: DOCUMENT_FONT_INSPECTION_FORMATS,
  inspectDocumentFonts: inspectDocumentFontsDefault
} = require('./document-font-inspector');
const { createDocumentRhwpInspector } = require('./document-rhwp-inspector');
const NativeOfficeMerge = require('./native-office-merge');
const LibreOfficeExcelMerge = require('./libreoffice-excel-merge');
const InternalExcelMerge = require('./internal-excel-merge');
const ExcelDeduplicate = require('./excel-deduplicate');
const ExcelCompareGroup = require('./excel-compare-group');

const MAX_BATCH_FILES = 500;
const MAX_DOCUMENT_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_HWP_SOURCE_BYTES = 256 * 1024 * 1024;
// OOXML/HWPX font inspection deliberately reads and validates the complete ZIP
// package with a 128 MB security ceiling. Accepting a larger source here only
// to reject it later during font preflight makes the UI unpredictable, so the
// same per-file ceiling is enforced at selection and again before every run.
const MAX_INSPECTABLE_DOCUMENT_SOURCE_BYTES = Math.min(
  MAX_PPTX_BYTES,
  MAX_DOCUMENT_FONT_INSPECTION_BYTES
);
const INSPECTABLE_DOCUMENT_SOURCE_EXTENSIONS = new Set(DOCUMENT_FONT_INSPECTION_FORMATS);
// A maximum-size conversion owns one source token and one generated-result
// token per item, plus its output-directory capability.
const MAX_OWNER_TOKENS = MAX_BATCH_FILES * 2 + 100;
const MAX_CERTIFICATE_ROWS = 2_000;
const MAX_CERTIFICATE_FIELDS = 80;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_IMPORTED_CELLS = 200_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_SOURCE_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_PNG_DIMENSION = 100_000;
const PROCESS_TIMEOUT_PER_ITEM_MS = 180_000;
const POWERPOINT_CHUNK_SIZE = 30;
const POWERPOINT_MERGE_TIMEOUT_BASE_MS = 180_000;
const POWERPOINT_MERGE_TIMEOUT_PER_SOURCE_MS = 60_000;
const POWERPOINT_MERGE_TIMEOUT_PER_SLIDE_MS = 5_000;
const POWERPOINT_MERGE_TIMEOUT_MAX_MS = 2 * 60 * 60 * 1_000;
const TOKEN_PATTERN = /^[a-f0-9-]{36}$/i;
const PROFILE_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DOCUMENT_CONVERSION_INPUT_KIND = 'document-conversion-input';
const DOCUMENTS_MERGE_KIND = 'documents';
const DOCUMENTS_MERGE_MODE = 'print-share-pdf';
const NATIVE_OFFICE_MERGE_KINDS = Object.freeze(['word', 'excel']);
const NATIVE_OFFICE_MERGE_KIND_SET = new Set(NATIVE_OFFICE_MERGE_KINDS);
const NATIVE_OFFICE_MERGE_DEPENDENCIES = Object.freeze({ word: 'officeWord', excel: 'officeExcel' });
const NATIVE_OFFICE_MERGE_LABELS = Object.freeze({ word: 'Word', excel: 'Excel' });
const INTERNAL_EXCEL_STRUCTURE_FALLBACK_CODES = new Set([
  'XLSX_STRUCTURE_XML_INVALID',
  'XLSX_STRUCTURE_XML_ENCODING_UNSUPPORTED',
  'XLSX_STRUCTURE_WORKBOOK_INVALID',
  'XLSX_STRUCTURE_RELATIONSHIPS_INVALID',
  'XLSX_STRUCTURE_SHEET_RELATIONSHIP_INVALID'
]);
const INTERNAL_EXCEL_FALLBACK_WARNING = '내부 Excel 병합은 Microsoft Excel이나 LibreOffice를 사용하지 않고 XLSX 구조를 직접 합칩니다. 원본은 바꾸지 않으며 결과 파일은 사용 전에 한 번 확인해주세요.';
const OPENABLE_DOCUMENT_OUTPUT_EXTENSIONS = Object.freeze([
  '.pdf',
  '.ppt', '.pptx', '.pptm', '.odp',
  '.doc', '.docx', '.docm', '.odt', '.rtf', '.hwp', '.hwpx',
  '.xls', '.xlsx', '.xlsm', '.xlsb', '.ods', '.csv', '.cell', '.nxl'
]);
const ZIP_DOCUMENT_OUTPUT_EXTENSIONS = new Set(['pptx', 'pptm', 'odp', 'docx', 'docm', 'odt', 'hwpx', 'xlsx', 'xlsm', 'xlsb', 'ods']);
const OLE_DOCUMENT_OUTPUT_EXTENSIONS = new Set(['ppt', 'doc', 'hwp', 'xls']);
const HANCOM_CELL_OUTPUT_EXTENSIONS = new Set(['cell', 'nxl']);
const OLE_COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_CONVERTED_ZIP_ENTRIES = 20_000;
const MAX_CONVERTED_ZIP_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_CONVERTED_ZIP_ENTRY_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_CONVERTED_ZIP_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CONVERTED_ZIP_PATH_BYTES = 2_048;
const MAX_ZIP64_END_RECORD_BYTES = 1024 * 1024;
const MAX_CONVERTED_ZIP_REQUIRED_XML_BYTES = 32 * 1024 * 1024;
const MAX_CONVERTED_ZIP_REQUIRED_BINARY_BYTES = 256 * 1024 * 1024;
const OPC_CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OPC_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OPC_OFFICE_DOCUMENT_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const OPC_DOCUMENT_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const OPC_SLIDE_RELATIONSHIP = `${OPC_DOCUMENT_RELATIONSHIPS_NAMESPACE}/slide`;
const MAX_CONVERTED_CFB_DIRECTORY_BYTES = 64 * 1024 * 1024;
const CFB_FREE_SECTOR = 0xffffffff;
const CFB_END_OF_CHAIN = 0xfffffffe;
const CFB_FAT_SECTOR = 0xfffffffd;
const CFB_DIFAT_SECTOR = 0xfffffffc;
const CFB_MAX_REGULAR_SECTOR = 0xfffffffa;
const OOXML_PACKAGE_PROFILES = Object.freeze({
  pptx: Object.freeze({
    mainPart: 'ppt/presentation.xml',
    mainRoot: 'presentation',
    mainNamespace: 'http://schemas.openxmlformats.org/presentationml/2006/main',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
  }),
  pptm: Object.freeze({
    mainPart: 'ppt/presentation.xml',
    mainRoot: 'presentation',
    mainNamespace: 'http://schemas.openxmlformats.org/presentationml/2006/main',
    contentType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'
  }),
  docx: Object.freeze({
    mainPart: 'word/document.xml',
    mainRoot: 'document',
    mainNamespace: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  }),
  docm: Object.freeze({
    mainPart: 'word/document.xml',
    mainRoot: 'document',
    mainNamespace: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    contentType: 'application/vnd.ms-word.document.macroEnabled.main+xml'
  }),
  xlsx: Object.freeze({
    mainPart: 'xl/workbook.xml',
    mainRoot: 'workbook',
    mainNamespace: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
  }),
  xlsm: Object.freeze({
    mainPart: 'xl/workbook.xml',
    mainRoot: 'workbook',
    mainNamespace: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    contentType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
  }),
  xlsb: Object.freeze({
    mainPart: 'xl/workbook.bin',
    mainRoot: '',
    mainNamespace: '',
    contentType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.main'
  })
});
const CP437_HIGH_CHARACTERS = Object.freeze(Array.from([
  'ÇüéâäàåçêëèïîìÄÅ', 'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ',
  'áíóúñÑªº¿⌐¬½¼¡«»', '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐',
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧', '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀',
  'αßΓπΣσµτΦΘΩδ∞φε∩', '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
].join('')));
const DOCUMENT_APPLICATION_PROBES = Object.freeze({
  officePowerPoint: Object.freeze({
    progIds: Object.freeze(['PowerPoint.Application']),
    processNames: Object.freeze(['POWERPNT.EXE'])
  }),
  officeWord: Object.freeze({
    progIds: Object.freeze(['Word.Application']),
    processNames: Object.freeze(['WINWORD.EXE'])
  }),
  officeExcel: Object.freeze({
    progIds: Object.freeze(['Excel.Application']),
    processNames: Object.freeze(['EXCEL.EXE'])
  }),
  hancomWriter: Object.freeze({
    progIds: Object.freeze(['HWPFrame.HwpObject', 'HWPFrame.HwpObject.2']),
    processNames: Object.freeze(['HWP.EXE', 'HWPFRAME.EXE'])
  }),
  hancomCell: Object.freeze({
    progIds: Object.freeze(['HCell.Application', 'HCell.Application.1']),
    processNames: Object.freeze(['HCELL.EXE'])
  })
});
const DOCUMENT_SOURCE_EXTENSIONS = Object.freeze(Object.values(DocumentConversion.FORMAT_METADATA)
  .filter((item) => item.source)
  .map((item) => item.extension));
const DOCUMENT_SOURCE_EXTENSION_SET = new Set(DOCUMENT_SOURCE_EXTENSIONS);
const DOCUMENTS_MERGE_EXTENSIONS = Object.freeze(['pdf', ...DOCUMENT_SOURCE_EXTENSIONS]);
const WINDOWS_FONT_COLLECTION_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Drawing',
  '$collection = New-Object System.Drawing.Text.InstalledFontCollection',
  'try { $collection.Families | ForEach-Object { $_.Name } } finally { $collection.Dispose() }'
].join('; ');
const FONT_BASE_ALIASES = Object.freeze({
  '맑은고딕': 'malgungothic',
  malgungothic: 'malgungothic',
  '바탕': 'batang',
  '바탕체': 'batang',
  batang: 'batang',
  batangche: 'batang',
  '돋움': 'dotum',
  '돋움체': 'dotum',
  dotum: 'dotum',
  dotumche: 'dotum',
  '굴림': 'gulim',
  '굴림체': 'gulim',
  gulim: 'gulim',
  gulimche: 'gulim',
  '궁서': 'gungsuh',
  '궁서체': 'gungsuh',
  gungsuh: 'gungsuh',
  gungsuhche: 'gungsuh',
  'kopubworld바탕체pro': 'kopubworldbatangpro',
  kopubworldbatangpro: 'kopubworldbatangpro',
  'kopubworld돋움체pro': 'kopubworlddotumpro',
  kopubworlddotumpro: 'kopubworlddotumpro'
});

function documentSourceByteLimit(extension) {
  const normalized = DocumentConversion.normalizeExtension(extension);
  if (normalized === 'hwp') return MAX_HWP_SOURCE_BYTES;
  return INSPECTABLE_DOCUMENT_SOURCE_EXTENSIONS.has(normalized)
    ? MAX_INSPECTABLE_DOCUMENT_SOURCE_BYTES
    : MAX_DOCUMENT_SOURCE_BYTES;
}

function documentConversionSelectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeDocumentConversionSourceExtensions(payload = {}) {
  const requested = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.sourceExtensions
    : undefined;
  if (requested == null || (Array.isArray(requested) && requested.length === 0)) {
    return [...DOCUMENT_SOURCE_EXTENSIONS];
  }
  if (!Array.isArray(requested)) {
    throw documentConversionSelectionError(
      'DOCUMENT_CONVERSION_SOURCE_FILTER_INVALID',
      '원본 형식 선택 정보가 올바르지 않습니다. 원본 확장자를 목록으로 선택해주세요.'
    );
  }

  const extensions = [];
  const seen = new Set();
  for (const candidate of requested) {
    if (typeof candidate !== 'string') continue;
    const extension = DocumentConversion.normalizeExtension(candidate);
    if (!DOCUMENT_SOURCE_EXTENSION_SET.has(extension) || seen.has(extension)) continue;
    seen.add(extension);
    extensions.push(extension);
  }
  if (!extensions.length) {
    throw documentConversionSelectionError(
      'DOCUMENT_CONVERSION_SOURCE_FILTER_INVALID',
      '선택한 항목에 변환할 수 있는 원본 문서 형식이 없습니다. PDF같은 결과 형식이 아닌 원본 확장자를 선택해주세요.'
    );
  }
  return extensions;
}

function documentConversionSourceSelectionLabel(extensions) {
  if (extensions.length === DOCUMENT_SOURCE_EXTENSIONS.length
      && DOCUMENT_SOURCE_EXTENSIONS.every((extension) => extensions.includes(extension))) {
    return `지원 형식 전체 ${extensions.length}개`;
  }
  if (extensions.length === 1) {
    return DocumentConversion.getFormatLabel(extensions[0]) || `.${extensions[0]}`;
  }
  const visible = extensions.slice(0, 4).map((extension) => extension.toUpperCase()).join(', ');
  return extensions.length > 4 ? `${visible} 외 ${extensions.length - 4}개` : visible;
}

function documentSourceSizeError(filePath, extension, maximumBytes) {
  const name = path.basename(filePath);
  const megabytes = Math.floor(maximumBytes / (1024 * 1024));
  const normalized = DocumentConversion.normalizeExtension(extension);
  const message = normalized === 'hwp'
    ? `${name} 파일은 rHWP로 글꼴과 문서 구조를 안전하게 검사하기 위해 ${megabytes}MB 이하만 사용할 수 있습니다. HWP를 여러 파일로 나누거나 그림 용량을 줄인 뒤 다시 선택해주세요.`
    : INSPECTABLE_DOCUMENT_SOURCE_EXTENSIONS.has(normalized)
    ? `${name} 파일은 글꼴과 문서 구조를 안전하게 검사하기 위해 ${megabytes}MB 이하만 사용할 수 있습니다. 파일을 나누거나 용량을 줄인 뒤 다시 선택해주세요.`
    : `${name} 파일은 비어 있지 않은 ${megabytes}MB 이하 문서만 사용할 수 있습니다.`;
  const error = new Error(message);
  error.code = 'DOCUMENT_SOURCE_TOO_LARGE';
  return error;
}

function assertDocumentSourceStats(filePath, extension, stats) {
  const maximumBytes = documentSourceByteLimit(extension);
  if (!stats?.isFile?.() || !Number.isSafeInteger(stats.size) || stats.size <= 0) {
    const error = new Error(`${path.basename(filePath)} 파일은 비어 있지 않은 문서 파일이어야 합니다.`);
    error.code = 'DOCUMENT_SOURCE_INVALID';
    throw error;
  }
  if (stats.size > maximumBytes) throw documentSourceSizeError(filePath, extension, maximumBytes);
  return stats;
}

async function assertDocumentSourceFile(filePath, extension) {
  return assertDocumentSourceStats(filePath, extension, await fs.promises.stat(filePath));
}

function normalizeDocumentToolsMergeKind(value) {
  const kind = String(value || '').trim().toLocaleLowerCase('en-US');
  return kind === DOCUMENTS_MERGE_KIND || NATIVE_OFFICE_MERGE_KIND_SET.has(kind)
    ? kind
    : normalizeDocumentMergeKind(kind);
}

function boundedText(value, maximum, fallback = '') {
  return String(value ?? fallback).trim().slice(0, maximum);
}

function documentJobCancelledError() {
  const error = new Error('문서 작업을 중단했습니다. 이미 완료되어 저장된 파일은 그대로 남아 있습니다.');
  error.code = 'DOCUMENT_TOOL_CANCELLED';
  return error;
}

function documentSplitInputChangedError() {
  const error = new Error('선택한 문서가 나누기 준비 중 바뀌었습니다. 파일을 다시 선택해주세요.');
  error.code = 'DOCUMENT_SPLIT_INPUT_CHANGED';
  return error;
}

const PPTX_COMPATIBILITY_SPLIT_WARNINGS = Object.freeze([
  'PowerPoint를 사용하지 않고 PPTX 내부 구조를 재구성해 선택한 슬라이드만 안전하게 나눴습니다.',
  '선택한 슬라이드 본문·테마·글꼴·미디어 원본 데이터는 다시 그리거나 치환하지 않았습니다.',
  '슬라이드를 제외하는 결과에서는 해당 정보가 남지 않도록 슬라이드 제목 인덱스·문서 미리보기·보기 설정과 검토 댓글·댓글 작성자 메타데이터가 제거됩니다. 알 수 없는 형식의 댓글 참조는 파일 손상을 막기 위해 중단됩니다.',
  '사용자 지정 쇼·구역 등 프레젠테이션 전체 기능은 달라질 수 있고, 디지털 서명이나 제외한 슬라이드로 이어지는 링크가 있으면 안전을 위해 중단됩니다. 이 PC에 원본 글꼴이 없으면 미리보기나 인쇄에서 대체 글꼴로 보일 수 있으니 결과를 확인해주세요.'
]);

function documentSplitCompatibilityConfirmationError(reason, cause) {
  const reasons = {
    'powerpoint-missing': 'Microsoft PowerPoint가 설치되어 있지 않습니다.',
    'powerpoint-running': 'PowerPoint가 실행 중이라 작업 중인 문서를 보호하기 위해 자동화를 사용하지 않았습니다.',
    'powerpoint-failed': 'PowerPoint 자동 분할을 완료하지 못했습니다.'
  };
  const prefix = reasons[reason] || 'PowerPoint 원본 분할을 사용할 수 없습니다.';
  const error = documentSplitError(
    'DOCUMENT_SPLIT_COMPATIBILITY_CONFIRMATION_REQUIRED',
    `${prefix} 내부 호환 분할은 선택한 슬라이드 데이터를 그대로 보존하지만 슬라이드를 제외하는 결과에서는 개인정보 보호를 위해 슬라이드 제목 인덱스·문서 미리보기·보기 설정과 검토 댓글·댓글 작성자 메타데이터를 제거합니다. 사용자 지정 쇼·구역과 이 PC에 없는 글꼴의 표시가 달라질 수 있고, 디지털 서명·제외한 슬라이드로 이어지는 링크·알 수 없는 형식의 댓글 참조가 있으면 안전을 위해 중단됩니다. 경고를 확인하고 계속 진행해주세요.`,
    cause
  );
  error.details = { reason: String(reason || 'powerpoint-unavailable') };
  return error;
}

function documentSplitOutputDirectoryChangedError(cause) {
  return documentSplitError(
    'DOCUMENT_SPLIT_OUTPUT_DIRECTORY_CHANGED',
    '선택한 결과 폴더가 바뀐었거나 다시 만들어졌습니다. 다른 폴더에 저장되는 일을 막기 위해 결과 폴더를 다시 선택해주세요.',
    cause
  );
}

function safeOutputStem(value, fallback = '파일') {
  const sanitize = (candidate) => String(candidate || '')
    .replace(INVALID_FILE_CHARS, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  let stem = sanitize(value);
  if (!stem || WINDOWS_RESERVED_NAMES.test(stem)) stem = sanitize(fallback);
  if (!stem || WINDOWS_RESERVED_NAMES.test(stem)) stem = '파일';
  return stem;
}

function spreadsheetColumnLabel(index) {
  let value = Number(index);
  if (!Number.isInteger(value) || value < 0) return '';
  let label = '';
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function spreadsheetColumnIndex(label) {
  const value = String(label || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(value)) return -1;
  let index = 0;
  for (const character of value) {
    if (index > Math.floor(Number.MAX_SAFE_INTEGER / 26)) return Number.MAX_SAFE_INTEGER;
    index = index * 26 + character.charCodeAt(0) - 64;
  }
  return index - 1;
}

function compileCertificateFilenameTemplate(template, fields) {
  const source = String(template ?? '');
  if (!source.trim()) throw new Error('파일명 템플릿을 입력해주세요. 예: {A} (수료증)');
  if (source.length > 160) throw new Error('파일명 템플릿은 160자 이하로 입력해주세요.');
  const normalizedFields = (Array.isArray(fields) ? fields : []).slice(0, MAX_CERTIFICATE_FIELDS).map((field, index) => ({
    index,
    label: String(field?.label ?? field ?? '').trim()
  }));
  const labelIndexes = new Map();
  for (const field of normalizedFields) {
    if (!field.label) continue;
    const indexes = labelIndexes.get(field.label) || [];
    indexes.push(field.index);
    labelIndexes.set(field.label, indexes);
  }

  const segments = [];
  const tokenPattern = /\{([^{}]*)\}/g;
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(source))) {
    if (match.index > cursor) segments.push({ type: 'text', value: source.slice(cursor, match.index) });
    const token = match[1].trim();
    if (!token) throw new Error('파일명 템플릿에 빈 토큰 {}을 사용할 수 없습니다. 열 문자나 컬럼명을 넣어주세요.');
    const columnIndex = spreadsheetColumnIndex(token);
    if (columnIndex >= 0) {
      if (columnIndex >= normalizedFields.length) throw new Error(`파일명 템플릿의 {${token}} 열을 찾을 수 없습니다.`);
      segments.push({ type: 'field', index: columnIndex, token });
    } else {
      const indexes = labelIndexes.get(token) || [];
      if (!indexes.length) throw new Error(`파일명 템플릿의 {${token}}에 해당하는 컬럼을 찾을 수 없습니다.`);
      if (indexes.length > 1) throw new Error(`컬럼명이 '${token}'인 열이 여러 개입니다. {${spreadsheetColumnLabel(indexes[0])}}처럼 열 문자를 사용해주세요.`);
      segments.push({ type: 'field', index: indexes[0], token });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) segments.push({ type: 'text', value: source.slice(cursor) });
  if (segments.some((segment) => segment.type === 'text' && /[{}]/.test(segment.value))) {
    throw new Error('파일명 템플릿의 중괄호 짝이 맞지 않습니다. 토큰은 {A} 또는 {컬럼명}처럼 입력해주세요.');
  }
  return { source, segments };
}

function renderCertificateFilenameTemplate(compiled, values, rowNumber = 0) {
  if (!compiled || !Array.isArray(compiled.segments)) throw new Error('파일명 템플릿 정보가 올바르지 않습니다.');
  const rowValues = Array.isArray(values) ? values : [];
  const rendered = compiled.segments.map((segment) => segment.type === 'field'
    ? String(rowValues[segment.index] ?? '')
    : String(segment.value ?? '')).join('');
  // The selected output formats own their extensions. Removing a typed suffix
  // prevents names such as "수료증.pdf.pdf" and keeps PDF/PPTX stems identical.
  const withoutAutomaticExtension = rendered.replace(/\.(?:pdf|pptx)[. ]*$/i, '');
  const normalizedRowNumber = Math.max(1, Number(rowNumber) || 1);
  const fallback = `문서-${String(normalizedRowNumber).padStart(3, '0')}`;
  return safeOutputStem(withoutAutomaticExtension, fallback);
}

function isPathInside(parent, candidate) {
  const root = path.resolve(parent);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function removeGeneratedDirectory(directory) {
  const resolved = path.resolve(directory || '');
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!isPathInside(temporaryRoot, resolved) || !path.basename(resolved).startsWith('cmoe-document-tools-')) {
    throw new Error('임시 작업 폴더의 범위를 확인하지 못했습니다.');
  }
  // Office can release file handles a moment after its automation process
  // exits. Retry only inside the validated per-job temp directory to reduce
  // the chance that a transient EBUSY masks the real conversion/merge error.
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function makeJobDirectory() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'cmoe-document-tools-'));
}

function documentSplitVolumeRoot(value) {
  const root = path.parse(path.resolve(String(value || ''))).root;
  return process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root;
}

function documentSplitPathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function documentSplitStatIdentityValue(value) {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

async function inspectDocumentSplitOutputDirectoryIdentity(directory) {
  const requested = path.resolve(String(directory || ''));
  let realPath;
  let stats;
  try {
    realPath = path.resolve(await fs.promises.realpath(requested));
    stats = await fs.promises.stat(realPath, { bigint: true });
  } catch (cause) {
    throw documentSplitOutputDirectoryChangedError(cause);
  }
  if (!stats.isDirectory()) throw documentSplitOutputDirectoryChangedError();
  const dev = documentSplitStatIdentityValue(stats.dev);
  const ino = documentSplitStatIdentityValue(stats.ino);
  const birthtimeMs = documentSplitStatIdentityValue(stats.birthtimeMs);
  const birthtimeNs = documentSplitStatIdentityValue(stats.birthtimeNs);
  if (!dev || !ino || !birthtimeMs
    || (ino === '0' && birthtimeMs === '0' && (!birthtimeNs || birthtimeNs === '0'))) {
    throw documentSplitError(
      'DOCUMENT_SPLIT_OUTPUT_DIRECTORY_IDENTITY_UNAVAILABLE',
      '선택한 결과 폴더를 안전하게 구별할 수 없습니다. 로컬 디스크의 다른 폴더를 선택해주세요.'
    );
  }
  return {
    realPath,
    pathKey: documentSplitPathKey(realPath),
    dev,
    ino,
    birthtimeMs,
    ...(birthtimeNs ? { birthtimeNs } : {})
  };
}

function sameDocumentSplitOutputDirectoryIdentity(expected, actual) {
  if (!expected || !actual
    || typeof expected.realPath !== 'string'
    || typeof expected.dev !== 'string'
    || typeof expected.ino !== 'string'
    || typeof expected.birthtimeMs !== 'string') return false;
  return documentSplitPathKey(expected.realPath) === documentSplitPathKey(actual.realPath)
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs
    && (!expected.birthtimeNs || expected.birthtimeNs === actual.birthtimeNs);
}

function sameDocumentSplitPath(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  try { return documentSplitPathKey(expected) === documentSplitPathKey(actual); }
  catch (_) { return false; }
}

function validPowerPointSlideIds(value, expectedLength) {
  return Array.isArray(value)
    && value.length === expectedLength
    && value.every((item) => Number.isSafeInteger(item) && item > 0);
}

function sameIntegerSequence(expected, actual) {
  return Array.isArray(expected)
    && Array.isArray(actual)
    && expected.length === actual.length
    && expected.every((item, index) => item === actual[index]);
}

function documentSplitPptxWorkerContractError(message, code = 'DOCUMENT_SPLIT_PPTX_WORKER_CONTRACT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validatePowerPointSplitWorkerResult(workerResult, temporaryPlans, sourceUnitCount) {
  if (workerResult?.index !== 0
    || workerResult?.sourceSlideCount !== sourceUnitCount
    || !validPowerPointSlideIds(workerResult?.sourceSlideIds, sourceUnitCount)
    || new Set(workerResult.sourceSlideIds).size !== sourceUnitCount) {
    throw documentSplitPptxWorkerContractError(
      'PowerPoint가 확인한 원본 슬라이드 정보가 계획과 다릅니다. 결과를 저장하지 않았습니다.'
    );
  }
  if (!Array.isArray(workerResult.outputs) || workerResult.outputs.length !== temporaryPlans.length) {
    throw documentSplitPptxWorkerContractError(
      'PowerPoint 나누기 결과 개수가 계획과 다릅니다. 결과를 저장하지 않았습니다.',
      'DOCUMENT_SPLIT_OUTPUT_COUNT_MISMATCH'
    );
  }
  for (let index = 0; index < temporaryPlans.length; index += 1) {
    const plan = temporaryPlans[index];
    const output = workerResult.outputs[index];
    if (!output || output.index !== plan.index
      || !sameDocumentSplitPath(output.outputPath, plan.outputPath)
      || !sameIntegerSequence(plan.pages, output.pages)
      || output.slideCount !== plan.unitCount) {
      throw documentSplitPptxWorkerContractError(
        'PowerPoint 나누기 결과 정보가 선택한 그룹 계획과 다릅니다. 결과를 저장하지 않았습니다.'
      );
    }
    const expectedSlideIds = plan.pages.map((page) => workerResult.sourceSlideIds[page - 1]);
    if (!validPowerPointSlideIds(output.slideIds, plan.unitCount)
      || !sameIntegerSequence(expectedSlideIds, output.slideIds)) {
      throw documentSplitPptxWorkerContractError(
        'PowerPoint 나누기 결과에 선택하지 않은 슬라이드가 포함되었습니다. 결과를 저장하지 않았습니다.',
        'DOCUMENT_SPLIT_PPTX_SLIDE_ID_MISMATCH'
      );
    }
  }
  return workerResult.outputs;
}

async function inspectDocumentSplitFileSystemCapacity(directory) {
  const requested = path.resolve(String(directory || ''));
  const realPath = await fs.promises.realpath(requested);
  const [stats, fileSystem] = await Promise.all([
    fs.promises.stat(realPath),
    fs.promises.statfs(realPath, { bigint: true })
  ]);
  if (!stats.isDirectory()) {
    throw documentSplitError('DOCUMENT_SPLIT_DISK_SPACE_CHECK_FAILED', '저장 공간을 확인할 대상이 폴더가 아닙니다.');
  }
  const blockSize = BigInt(fileSystem.bsize);
  const availableBlocks = BigInt(fileSystem.bavail ?? fileSystem.bfree);
  if (blockSize <= 0n || availableBlocks < 0n) {
    throw documentSplitError('DOCUMENT_SPLIT_DISK_SPACE_CHECK_FAILED', '저장 장치의 여유 공간 정보를 읽지 못했습니다.');
  }
  const available = blockSize * availableBlocks;
  const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const availableBytes = available > maximumSafe ? Number.MAX_SAFE_INTEGER : Number(available);
  const device = Number(stats.dev);
  const volumeId = Number.isSafeInteger(device) && device !== 0
    ? `dev:${device}`
    : `root:${documentSplitVolumeRoot(realPath)}`;
  return { availableBytes, volumeId };
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_PROCESS_OUTPUT_BYTES) return current;
  return (current + String(chunk || '')).slice(0, MAX_PROCESS_OUTPUT_BYTES);
}

function decodeProcessOutput(buffer, fallbackEncoding = 'utf-8') {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(source); }
  catch (_) { return new TextDecoder(fallbackEncoding).decode(source); }
}

function decodeDelimitedFile(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  let decoded = '';
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch (_) {
    try {
      // WHATWG's euc-kr decoder includes the Windows CP949 extensions used by
      // Korean Excel when it saves a legacy CSV file.
      decoded = new TextDecoder('euc-kr', { fatal: true }).decode(source);
    } catch (_) {
      throw new Error('CSV·TSV 파일은 UTF-8 또는 한국어 CP949 인코딩으로 저장해주세요.');
    }
  }
  decoded = decoded.replace(/^\uFEFF/, '');
  if (decoded.includes('\uFFFD')) {
    throw new Error('CSV·TSV 문자 인코딩을 정확히 읽지 못했습니다. UTF-8 또는 한국어 CP949로 다시 저장해주세요.');
  }
  return decoded;
}

function windowsNativeOutputEncoding() {
  if (process.platform !== 'win32') return 'utf-8';
  const locale = String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  if (locale.startsWith('ko')) return 'euc-kr';
  if (locale.startsWith('ja')) return 'shift_jis';
  if (/^zh-(?:tw|hk|mo)/.test(locale)) return 'big5';
  if (locale.startsWith('zh')) return 'gbk';
  return 'windows-1252';
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const bufferedEncoding = options.outputEncoding || '';
    let settled = false;
    let timeoutError = null;
    let cooperativeKillTimeout = null;
    let killGraceTimeout = null;
    // UTF-8 streams use Node's StringDecoder so characters split across
    // chunks stay intact. Native Windows tools such as soffice.com write the
    // system code page, so those streams remain Buffers and are decoded once.
    if (!bufferedEncoding) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
    }
    const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 60_000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cooperativeKillTimeout) clearTimeout(cooperativeKillTimeout);
      if (killGraceTimeout) clearTimeout(killGraceTimeout);
      callback(value);
    };
    const terminateTimedOutChild = () => {
      try { child.kill(); } catch (_) {}
      // Wait briefly for close so callers do not remove a working directory
      // while the converter still has files open. Keep a hard upper bound for
      // an unexpectedly unresponsive child process.
      killGraceTimeout = setTimeout(() => finish(reject, timeoutError), 5_000);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timeoutError = new Error('문서 변환 시간이 초과되었습니다. 파일을 줄여 다시 시도해주세요.');
      timeoutError.code = 'DOCUMENT_TOOL_TIMEOUT';
      if (typeof options.onTimeout === 'function') {
        try { options.onTimeout(); } catch (_) {}
        cooperativeKillTimeout = setTimeout(
          terminateTimedOutChild,
          Math.max(1_000, Number(options.cooperativeTimeoutGraceMs) || 30_000)
        );
      } else {
        terminateTimedOutChild();
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (bufferedEncoding) {
        const source = Buffer.from(chunk);
        const available = Math.max(0, MAX_PROCESS_OUTPUT_BYTES - stdoutBytes);
        if (available) { const selected = source.subarray(0, available); stdoutChunks.push(selected); stdoutBytes += selected.length; }
        return;
      }
      stdout = appendBounded(stdout, chunk);
      options.onStdout?.(String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      if (bufferedEncoding) {
        const source = Buffer.from(chunk);
        const available = Math.max(0, MAX_PROCESS_OUTPUT_BYTES - stderrBytes);
        if (available) { const selected = source.subarray(0, available); stderrChunks.push(selected); stderrBytes += selected.length; }
        return;
      }
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', (error) => {
      finish(reject, timeoutError || error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (timeoutError) {
        finish(reject, timeoutError);
        return;
      }
      if (bufferedEncoding) {
        stdout = decodeProcessOutput(Buffer.concat(stdoutChunks), bufferedEncoding);
        stderr = decodeProcessOutput(Buffer.concat(stderrChunks), bufferedEncoding);
        if (stdout) options.onStdout?.(stdout);
      }
      finish(resolve, { code: Number(code), stdout, stderr });
    });
  });
}

function powerPointErrorMessage(value) {
  const code = String(value || '').trim();
  const messages = {
    POWERPOINT_IN_USE: '열려 있는 PowerPoint를 보호하기 위해 변환을 시작하지 않았습니다. PowerPoint를 닫고 다시 시도해주세요.',
    INPUT_COUNT_INVALID: '합칠 PPTX 파일을 2개 이상 선택해주세요.',
    INPUT_NOT_FOUND: '입력 PPTX 파일을 찾을 수 없습니다.',
    OUTPUT_EXISTS: '임시 출력 파일이 이미 존재합니다.',
    OUTPUT_DIRECTORY_NOT_FOUND: '임시 출력 폴더를 찾을 수 없습니다.',
    SLIDE_NOT_FOUND: '미리볼 슬라이드를 찾을 수 없습니다.',
    UNSUPPORTED_OPERATION: '지원하지 않는 PowerPoint 작업입니다.',
    OUTPUT_NOT_CREATED: 'PowerPoint가 결과 파일을 만들지 못했습니다.',
    POWERPOINT_OPERATION_FAILED: 'PowerPoint 작업을 완료하지 못했습니다.',
    POWERPOINT_PDF_EXPORT_FAILED: 'PowerPoint가 PDF를 내보내지 못했습니다. 원본 파일의 글꼴과 손상 여부를 확인해주세요.',
    POWERPOINT_PPTX_MERGE_FAILED: 'PowerPoint가 PPTX 파일을 합치지 못했습니다. 원본 파일을 PowerPoint에서 다시 저장한 뒤 시도해주세요.',
    POWERPOINT_PPTX_SIZE_MISMATCH: '슬라이드 크기가 서로 다른 PPTX는 원본 디자인을 유지하며 합칠 수 없습니다.',
    POWERPOINT_PPTX_STYLE_REBIND_FAILED: '삽입한 슬라이드의 원본 테마와 레이아웃을 안전하게 유지하지 못했습니다. 결과를 저장하지 않았습니다.',
    POWERPOINT_PPTX_OUTPUT_READ_ONLY: '임시 PPTX 결과를 읽기 전용에서 해제하지 못했습니다. 원본 파일의 속성을 확인해주세요.',
    POWERPOINT_PPTX_SAVE_FAILED: 'PowerPoint가 합친 PPTX 파일을 저장하지 못했습니다.',
    POWERPOINT_PPTX_SPLIT_INPUT_INVALID: '나눌 PPTX 파일을 PowerPoint에서 열 수 없습니다. 파일을 다시 저장한 뒤 시도해주세요.',
    POWERPOINT_PPTX_SPLIT_INPUT_CHANGED: 'PPTX 파일이 나누기 도중 바뀌었습니다. 파일을 다시 선택해주세요.',
    POWERPOINT_PPTX_SPLIT_OUTPUT_COUNT_INVALID: 'PPTX 분할 그룹은 1개 이상, 500개 이하로 만들어주세요.',
    POWERPOINT_PPTX_SPLIT_OUTPUT_INVALID: 'PPTX 분할 결과 위치가 올바르지 않습니다.',
    POWERPOINT_PPTX_SPLIT_OUTPUT_DUPLICATED: '둘 이상의 PPTX 분할 결과가 같은 위치를 사용하고 있습니다.',
    POWERPOINT_PPTX_SPLIT_PAGE_INVALID: '나눌 슬라이드 번호가 올바르지 않습니다.',
    POWERPOINT_PPTX_SPLIT_PAGE_OUT_OF_RANGE: '나눌 슬라이드 번호가 원본 범위를 벗어났습니다.',
    POWERPOINT_PPTX_SPLIT_PAGE_ORDER_INVALID: '각 그룹의 슬라이드는 중복 없이 원본 순서대로 입력해주세요.',
    POWERPOINT_PPTX_SPLIT_PAGE_DUPLICATED: '같은 슬라이드를 둘 이상의 그룹에 중복으로 넣을 수 없습니다.',
    POWERPOINT_PPTX_SPLIT_COUNT_MISMATCH: 'PPTX 나누기 결과의 슬라이드 수가 계획과 다릅니다. 결과를 저장하지 않았습니다.',
    POWERPOINT_PPTX_SPLIT_SLIDE_ID_MISMATCH: 'PPTX 나누기 결과에 선택하지 않은 슬라이드가 포함되었습니다. 결과를 저장하지 않았습니다.',
    POWERPOINT_PPTX_SPLIT_SAVE_FAILED: 'PowerPoint가 나눈 PPTX 파일을 저장하지 못했습니다.',
    POWERPOINT_PPTX_SPLIT_FAILED: 'PowerPoint가 PPTX 파일을 나누지 못했습니다. 원본 파일을 PowerPoint에서 다시 저장한 뒤 시도해주세요.',
    DOCUMENT_TOOL_CANCELLED: '문서 작업을 중단했습니다.',
    POWERPOINT_START_FAILED: 'PowerPoint를 실행하지 못했습니다.',
    MISSING_RESULT_PATH: 'PowerPoint 작업 결과 위치를 준비하지 못했습니다.'
  };
  if (messages[code]) return messages[code];
  if (/80040154|REGDB_E_CLASSNOTREG|class not registered|클래스 팩터리/i.test(code)) {
    return '이 PC에 Microsoft PowerPoint가 설치되어 있지 않거나 등록되지 않았습니다. Office 복구를 시도하거나 LibreOffice를 설치해주세요.';
  }
  return boundedText(code.replace(/\uFFFD+/g, ''), 500, 'PowerPoint 작업을 완료하지 못했습니다.');
}

function powerPointMergeTimeoutMs(sourceCount, slideCount) {
  const sources = Math.max(MIN_MERGE_FILES, Math.min(MAX_MERGE_FILES, Math.floor(Number(sourceCount) || 0)));
  const slides = Math.max(1, Math.floor(Number(slideCount) || 0));
  return Math.min(
    POWERPOINT_MERGE_TIMEOUT_MAX_MS,
    POWERPOINT_MERGE_TIMEOUT_BASE_MS
      + Math.max(0, sources - 1) * POWERPOINT_MERGE_TIMEOUT_PER_SOURCE_MS
      + slides * POWERPOINT_MERGE_TIMEOUT_PER_SLIDE_MS
  );
}

function findLibreOfficePath() {
  if (process.platform !== 'win32') return '';
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'LibreOffice', 'program', 'soffice.com'));
    candidates.push(path.join(root, 'LibreOffice', 'program', 'soffice.exe'));
  }
  return [...new Set(candidates)].find((candidate) => fs.existsSync(candidate)) || '';
}

function powerPointWorkerPath() {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'office-tools', 'office-automation.ps1'))) {
    return path.join(process.resourcesPath, 'office-tools', 'office-automation.ps1');
  }
  return path.join(__dirname, 'office-automation.ps1');
}

function nativeDocumentWorkerPath() {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'office-tools', 'native-document-conversion.ps1'))) {
    return path.join(process.resourcesPath, 'office-tools', 'native-document-conversion.ps1');
  }
  return path.join(__dirname, 'native-document-conversion.ps1');
}

function windowsSystemExecutable(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

async function commandSucceeds(command, args, timeoutMs = 10_000) {
  try { return (await runProcess(command, args, { timeoutMs })).code === 0; }
  catch (_) { return false; }
}

async function powerPointRegistered() {
  if (process.platform !== 'win32') return false;
  const reg = windowsSystemExecutable('reg.exe');
  if (!fs.existsSync(reg)) return false;
  const registryKey = 'HKCR\\PowerPoint.Application\\CurVer';
  const [defaultView, nativeView, wowView] = await Promise.all([
    commandSucceeds(reg, ['query', registryKey], 10_000),
    commandSucceeds(reg, ['query', registryKey, '/reg:64'], 10_000),
    commandSucceeds(reg, ['query', registryKey, '/reg:32'], 10_000)
  ]);
  return defaultView || nativeView || wowView;
}

async function powerPointProcessRunning() {
  if (process.platform !== 'win32') return false;
  const tasklist = windowsSystemExecutable('tasklist.exe');
  if (!fs.existsSync(tasklist)) return false;
  try {
    const result = await runProcess(tasklist, ['/FI', 'IMAGENAME eq POWERPNT.EXE', '/FO', 'CSV', '/NH'], { timeoutMs: 10_000 });
    return result.code === 0 && /"POWERPNT\.EXE"/i.test(result.stdout);
  } catch (_) { return false; }
}

async function registeredComProgId(progIds) {
  if (process.platform !== 'win32') return { registered: false, progId: '', applicationArchitecture: 'unknown' };
  const reg = windowsSystemExecutable('reg.exe');
  if (!fs.existsSync(reg)) return { registered: false, progId: '', applicationArchitecture: 'unknown' };
  for (const progId of Array.isArray(progIds) ? progIds : []) {
    const registryKey = `HKCR\\${progId}\\CLSID`;
    const [defaultView, view64, view32] = await Promise.all([
      commandSucceeds(reg, ['query', registryKey], 10_000),
      commandSucceeds(reg, ['query', registryKey, '/reg:64'], 10_000),
      commandSucceeds(reg, ['query', registryKey, '/reg:32'], 10_000)
    ]);
    if (defaultView || view64 || view32) {
      return {
        registered: true,
        progId,
        applicationArchitecture: view32 && !view64 ? 'x86' : view64 && !view32 ? 'x64' : 'unknown'
      };
    }
  }
  return { registered: false, progId: '', applicationArchitecture: 'unknown' };
}

async function comProgIdRegistered(progIds) {
  return (await registeredComProgId(progIds)).registered;
}

function parseRegistryQueryValues(value) {
  const records = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?)\s+(REG_(?:SZ|EXPAND_SZ|DWORD))\s+(.+?)\s*$/i);
    if (!match) continue;
    records.push({ name: match[1].trim(), type: match[2].toUpperCase(), data: match[3].trim() });
  }
  return records;
}

function portableExecutableInfo(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buffer.length < 256 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) return null;
  const machine = buffer.readUInt16LE(peOffset + 4);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalBytes = buffer.readUInt16LE(peOffset + 20);
  const characteristics = buffer.readUInt16LE(peOffset + 22);
  const optionalOffset = peOffset + 24;
  if (!sectionCount || sectionCount > 96 || optionalBytes < 2
    || optionalOffset + optionalBytes > buffer.length || (characteristics & 0x2000) === 0) return null;
  const optionalMagic = buffer.readUInt16LE(optionalOffset);
  const dataDirectoryOffset = optionalMagic === 0x10b ? optionalOffset + 96 : optionalMagic === 0x20b ? optionalOffset + 112 : -1;
  if (dataDirectoryOffset < 0 || dataDirectoryOffset + 8 > optionalOffset + optionalBytes) return null;
  const sectionsOffset = optionalOffset + optionalBytes;
  if (sectionsOffset + (sectionCount * 40) > buffer.length) return null;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionsOffset + (index * 40);
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20)
    });
  }
  const rvaOffset = (rva, bytes = 1) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva < section.virtualAddress || rva + bytes > section.virtualAddress + span) continue;
      const offset = section.rawOffset + (rva - section.virtualAddress);
      if (offset >= 0 && offset + bytes <= buffer.length && offset + bytes <= section.rawOffset + section.rawSize) return offset;
    }
    return -1;
  };
  const exportRva = buffer.readUInt32LE(dataDirectoryOffset);
  const exportBytes = buffer.readUInt32LE(dataDirectoryOffset + 4);
  const exports = new Set();
  if (exportRva && exportBytes) {
    const exportOffset = rvaOffset(exportRva, 40);
    if (exportOffset < 0) return null;
    const nameCount = buffer.readUInt32LE(exportOffset + 24);
    const namesRva = buffer.readUInt32LE(exportOffset + 32);
    if (nameCount > 4_096 || (nameCount && rvaOffset(namesRva, nameCount * 4) < 0)) return null;
    const namesOffset = nameCount ? rvaOffset(namesRva, nameCount * 4) : -1;
    for (let index = 0; index < nameCount; index += 1) {
      const nameRva = buffer.readUInt32LE(namesOffset + (index * 4));
      const nameOffset = rvaOffset(nameRva, 1);
      if (nameOffset < 0) return null;
      let end = nameOffset;
      while (end < buffer.length && end - nameOffset <= 255 && buffer[end] !== 0) end += 1;
      if (end >= buffer.length || end - nameOffset > 255) return null;
      exports.add(buffer.subarray(nameOffset, end).toString('ascii'));
    }
  }
  return {
    architecture: machine === 0x014c ? 'x86' : machine === 0x8664 ? 'x64' : 'unsupported',
    machine,
    exports
  };
}

async function queryRegistryValues(registryKey) {
  if (process.platform !== 'win32') return [];
  const reg = windowsSystemExecutable('reg.exe');
  if (!fs.existsSync(reg)) return [];
  const results = await Promise.all(['default', '64', '32'].map(async (view) => {
    const args = ['query', registryKey];
    if (view !== 'default') args.push(`/reg:${view}`);
    try {
      const result = await runProcess(reg, args, { timeoutMs: 10_000, outputEncoding: windowsNativeOutputEncoding() });
      return result.code === 0 ? parseRegistryQueryValues(result.stdout).map((record) => ({ ...record, view })) : [];
    } catch (_) { return []; }
  }));
  return results.flat();
}

async function probeHancomAutomationSecurityModule(options = {}) {
  const applicationArchitecture = ['x86', 'x64'].includes(options.applicationArchitecture)
    ? options.applicationArchitecture
    : 'unknown';
  const queryValues = options.queryRegistryValues || queryRegistryValues;
  const registryKey = 'HKCU\\Software\\HNC\\HwpAutomation\\Modules';
  const usesKey = `${registryKey}\\Uses`;
  const [rawModuleValues, rawUsesValues] = await Promise.all([queryValues(registryKey), queryValues(usesKey)]);
  const preferExplicitViews = (records) => {
    const values = Array.isArray(records) ? records : [];
    return values.some((item) => item?.view === '32' || item?.view === '64')
      ? values.filter((item) => item?.view === '32' || item?.view === '64')
      : values;
  };
  const moduleValues = preferExplicitViews(rawModuleValues);
  const usesValues = preferExplicitViews(rawUsesValues);
  const usesByName = new Map(usesValues.map((item) => [
    `${String(item?.view || 'default')}\u0000${String(item?.name || '').normalize('NFKC').toLocaleLowerCase('en-US')}`,
    { type: String(item?.type || ''), data: String(item?.data || '') }
  ]));
  const seen = new Set();
  const candidates = [];
  let disabledCandidates = 0;
  let invalidCandidates = 0;
  for (const item of Array.isArray(moduleValues) ? moduleValues : []) {
    const moduleName = String(item?.name || '').trim();
    const modulePath = String(item?.data || '').trim();
    const view = String(item?.view || 'default');
    const key = `${view}\u0000${moduleName.normalize('NFKC').toLocaleLowerCase('en-US')}\u0000${path.win32.normalize(modulePath).toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item?.type !== 'REG_SZ' || !moduleName || moduleName.length > 128
      || /[\\/\u0000-\u001f\u007f]/.test(moduleName)
      || !path.win32.isAbsolute(modulePath) || /^\\\\/.test(modulePath) || path.win32.extname(modulePath).toLowerCase() !== '.dll') {
      invalidCandidates += 1;
      continue;
    }
    const uses = usesByName.get(`${view}\u0000${moduleName.normalize('NFKC').toLocaleLowerCase('en-US')}`);
    if (uses) {
      if (uses.type !== 'REG_DWORD' || !/^(?:0x[a-f0-9]+|\d+)$/i.test(uses.data)) {
        invalidCandidates += 1;
        continue;
      }
      if (/^0x0+$/i.test(uses.data) || /^0+$/.test(uses.data)) {
        disabledCandidates += 1;
        continue;
      }
    }
    try {
      const stats = await fs.promises.lstat(modulePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 256 || stats.size > 16 * 1024 * 1024) {
        invalidCandidates += 1;
        continue;
      }
      const bytes = await fs.promises.readFile(modulePath);
      const pe = portableExecutableInfo(bytes);
      if (!pe || !pe.exports.has('IsAccessiblePath')) {
        invalidCandidates += 1;
        continue;
      }
      candidates.push({
        moduleName,
        modulePath,
        view,
        architecture: pe.architecture,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      });
    } catch (_) { invalidCandidates += 1; }
  }
  const distinctCandidates = [];
  const distinctKeys = new Set();
  for (const item of candidates) {
    const key = `${item.moduleName.normalize('NFKC').toLocaleLowerCase('en-US')}\u0000${path.win32.normalize(item.modulePath).toLocaleLowerCase('en-US')}`;
    if (distinctKeys.has(key)) continue;
    distinctKeys.add(key);
    distinctCandidates.push(item);
  }
  const preferredNames = [DocumentDependencies.HANCOM_AUTOMATION_SECURITY_MODULE_NAME, 'FilePathCheckerModuleExample'];
  let candidate = null;
  for (const preferred of preferredNames) {
    const matches = distinctCandidates.filter((item) => item.moduleName.toLocaleLowerCase('en-US') === preferred.toLocaleLowerCase('en-US'));
    if (matches.length === 1) { candidate = matches[0]; break; }
  }
  if (!candidate && distinctCandidates.length === 1) candidate = distinctCandidates[0];
  if (!candidate) return {
    ready: false,
    reasonCode: distinctCandidates.length > 1
      ? 'HANCOM_SECURITY_MODULE_AMBIGUOUS'
      : disabledCandidates > 0
        ? 'HANCOM_SECURITY_MODULE_DISABLED'
        : invalidCandidates > 0
          ? 'HANCOM_SECURITY_MODULE_INVALID'
          : 'HANCOM_SECURITY_MODULE_REQUIRED',
    applicationArchitecture
  };
  if (applicationArchitecture === 'unknown') return {
    ready: false,
    reasonCode: 'HANCOM_APPLICATION_ARCHITECTURE_UNKNOWN',
    moduleArchitecture: candidate.architecture,
    applicationArchitecture
  };
  if (applicationArchitecture !== 'unknown' && candidate.architecture !== applicationArchitecture) return {
    ready: false,
    reasonCode: 'HANCOM_SECURITY_MODULE_ARCHITECTURE_MISMATCH',
    moduleName: candidate.moduleName,
    moduleArchitecture: candidate.architecture,
    moduleSha256: candidate.sha256,
    applicationArchitecture
  };
  return {
    ready: true,
    reasonCode: '',
    moduleName: candidate.moduleName,
    moduleArchitecture: candidate.architecture,
    moduleSha256: candidate.sha256,
    applicationArchitecture
  };
}

function parseTasklistImageNames(value) {
  const images = new Set();
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^\s*"([^"]+)"/);
    if (match) images.add(match[1].toLocaleUpperCase('en-US'));
  }
  return images;
}

async function runningDocumentProcesses() {
  const running = Object.fromEntries(Object.keys(DOCUMENT_APPLICATION_PROBES).map((dependencyId) => [dependencyId, false]));
  if (process.platform !== 'win32') return running;
  const tasklist = windowsSystemExecutable('tasklist.exe');
  if (!fs.existsSync(tasklist)) return running;
  try {
    const result = await runProcess(tasklist, ['/FO', 'CSV', '/NH'], { timeoutMs: 10_000, outputEncoding: windowsNativeOutputEncoding() });
    if (result.code !== 0) return running;
    const imageNames = parseTasklistImageNames(result.stdout);
    for (const [dependencyId, probe] of Object.entries(DOCUMENT_APPLICATION_PROBES)) {
      running[dependencyId] = probe.processNames.some((imageName) => imageNames.has(imageName));
    }
  } catch (_) {}
  return running;
}

async function probeDocumentApplications() {
  const [registrations, running] = await Promise.all([
    Promise.all(Object.entries(DOCUMENT_APPLICATION_PROBES).map(async ([dependencyId, probe]) => [
      dependencyId,
      await registeredComProgId(probe.progIds)
    ])),
    runningDocumentProcesses()
  ]);
  const registrationById = Object.fromEntries(registrations);
  const writerRegistration = registrationById.hancomWriter || {};
  const automationSecurity = writerRegistration.registered
    ? await probeHancomAutomationSecurityModule({ applicationArchitecture: writerRegistration.applicationArchitecture })
    : { ready: false, reasonCode: 'HANCOM_SECURITY_MODULE_REQUIRED', applicationArchitecture: writerRegistration.applicationArchitecture || 'unknown' };
  return Object.fromEntries(registrations.map(([dependencyId, registration]) => {
    const registered = Boolean(registration?.registered);
    const securityBlocked = dependencyId === 'hancomWriter' && !automationSecurity.ready;
    return [dependencyId, {
      registered,
      available: registered && !securityBlocked,
      running: Boolean(running[dependencyId]),
      progId: registration?.progId || '',
      applicationArchitecture: registration?.applicationArchitecture || 'unknown',
      ...(dependencyId === 'hancomWriter' ? {
        reasonCode: securityBlocked ? automationSecurity.reasonCode : '',
        automationSecurity
      } : {})
    }];
  }));
}

function validatePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

function validatePng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function pngDimensions(buffer) {
  // A conforming PNG always starts with a 13-byte IHDR chunk. Read only that
  // fixed header so malformed converter output cannot make us scan or allocate
  // based on renderer-controlled chunk lengths.
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !validatePng(buffer)) return null;
  if (buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) return null;
  return { width, height };
}

function previewRenderer(engine) {
  return engine === 'powerpoint' ? 'Microsoft PowerPoint' : 'LibreOffice';
}

function normalizeFontKey(value) {
  return String(value || '').normalize('NFKC').replace(/^@+/, '').trim().toLocaleLowerCase('en-US').replace(/[\s_.-]+/gu, '');
}

function baseFontKey(value) {
  const key = normalizeFontKey(value).replace(/(?:(?:regular|book|medium|semibold|demibold|extrabold|ultrabold|bold|extralight|ultralight|light|thin|black|heavy|italic|oblique))+$/i, '');
  return FONT_BASE_ALIASES[key] || key;
}

function parseWindowsFontRegistry(value) {
  const families = [];
  const seen = new Set();
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(.*?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s{2,}/i);
    if (!match) continue;
    const displayName = match[1].replace(/\s+\((?:TrueType|OpenType|Type 1|Variable)\)\s*$/i, '').trim();
    for (const family of displayName.split(/\s+&\s+/).map((item) => item.trim()).filter(Boolean)) {
      const key = normalizeFontKey(family);
      if (!key || seen.has(key)) continue;
      seen.add(key); families.push(family);
    }
  }
  return families;
}

function parseWindowsInstalledFontCollection(value) {
  const families = [];
  const seen = new Set();
  for (const line of String(value || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const family = line.trim();
    if (!family || family.length > 256 || /[\u0000-\u001f\u007f]/.test(family)) continue;
    const key = normalizeFontKey(family);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    families.push(family);
  }
  return families;
}

function missingFontFamilies(usedFonts, embeddedFonts, installedFonts) {
  const installedExact = new Set((installedFonts || []).map(normalizeFontKey).filter(Boolean));
  const installedBase = new Set((installedFonts || []).map(baseFontKey).filter(Boolean));
  const embeddedExact = new Set((embeddedFonts || []).map(normalizeFontKey).filter(Boolean));
  const embeddedBase = new Set((embeddedFonts || []).map(baseFontKey).filter(Boolean));
  return (usedFonts || []).filter((font) => {
    const exact = normalizeFontKey(font); const base = baseFontKey(font);
    return exact && !installedExact.has(exact) && !embeddedExact.has(exact) && !installedBase.has(base) && !embeddedBase.has(base);
  });
}

function certificatePreviewResult(jobId, preview, cacheHit = false) {
  return {
    jobId,
    engine: preview.engine,
    renderer: previewRenderer(preview.engine),
    fidelity: preview.engine === 'powerpoint' ? 'native' : 'compatible',
    imageUrl: `data:image/png;base64,${preview.image.toString('base64')}`,
    bytes: preview.image.length,
    imageWidth: preview.imageWidth,
    imageHeight: preview.imageHeight,
    slideWidth: preview.slideWidth,
    slideHeight: preview.slideHeight,
    slideNumber: preview.slideNumber,
    cacheHit: Boolean(cacheHit)
  };
}

function convertedZipError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function readFileRangeExactly(handle, length, position) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 파일 범위가 올바르지 않습니다.');
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP이 예상보다 일찍 끝났습니다.');
    }
    offset += result.bytesRead;
  }
  return buffer;
}

function findConvertedZipEndRecord(tail, tailOffset, fileBytes) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentBytes = tail.readUInt16LE(offset + 20);
    const absoluteOffset = tailOffset + offset;
    if (absoluteOffset + 22 + commentBytes === fileBytes) {
      return { bufferOffset: offset, fileOffset: absoluteOffset };
    }
  }
  throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 중앙 디렉터리 끝 정보를 찾을 수 없습니다.');
}

function safeConvertedZipNumber(value, fieldName) {
  const numeric = typeof value === 'bigint' ? value : BigInt(value);
  if (numeric < 0n || numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', `생성된 문서 ZIP의 ${fieldName} 값이 안전한 범위를 벗어났습니다.`);
  }
  return Number(numeric);
}

function decodeConvertedZipName(bytes, utf8) {
  try {
    if (utf8) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let result = '';
    for (const byte of bytes) {
      result += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH_CHARACTERS[byte - 0x80];
    }
    return result;
  } catch (error) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_INVALID', '생성된 문서 ZIP 항목 이름의 문자 인코딩이 손상되었습니다.', error);
  }
}

function updateConvertedZipCrc32(crc, bytes) {
  let current = crc >>> 0;
  for (const byte of bytes) {
    current ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current >>> 1) ^ ((current & 1) ? 0xedb88320 : 0);
    }
  }
  return current >>> 0;
}

function convertedZipCrc32(bytes) {
  return (updateConvertedZipCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

function convertedZipExtraFields(extra) {
  const fields = [];
  let cursor = 0;
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 확장 정보가 잘렸습니다.');
    }
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const end = cursor + 4 + size;
    if (end > extra.length) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 확장 정보가 손상되었습니다.');
    }
    fields.push({ id, data: extra.subarray(cursor + 4, end) });
    cursor = end;
  }
  return fields;
}

function safeConvertedZipPath(rawName) {
  if (typeof rawName !== 'string' || !rawName || rawName.length > MAX_CONVERTED_ZIP_PATH_BYTES || /\u0000/.test(rawName)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_INVALID', '생성된 문서 ZIP의 항목 이름이 올바르지 않습니다.');
  }
  const normalized = rawName.normalize('NFKC').replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_SLIP', '생성된 문서 ZIP에 절대 경로가 포함되어 있습니다.');
  }
  if (/%(?:2e|2f|5c)/i.test(normalized)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_INVALID', '생성된 문서 ZIP에 모호하게 인코딩된 경로가 포함되어 있습니다.');
  }
  const isDirectory = normalized.endsWith('/');
  const trimmed = isDirectory ? normalized.slice(0, -1) : normalized;
  const segments = trimmed.split('/');
  if (!trimmed || segments.length > 64 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_SLIP', '생성된 문서 ZIP에 상위 경로나 빈 경로가 포함되어 있습니다.');
  }
  for (const segment of segments) {
    if (segment.length > 255 || /[<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(segment)
      || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAMES.test(segment)) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_INVALID', '생성된 문서 ZIP에 Windows에서 안전하지 않은 경로가 포함되어 있습니다.');
    }
  }
  const name = segments.join('/');
  return { name, key: name.toLocaleLowerCase('en-US'), isDirectory };
}

function convertedZipPath(rawNameBytes, utf8, extra) {
  const primary = safeConvertedZipPath(decodeConvertedZipName(rawNameBytes, utf8));
  const unicodeFields = convertedZipExtraFields(extra).filter((field) => field.id === 0x7075);
  if (!unicodeFields.length) return primary;
  if (unicodeFields.length !== 1) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_INVALID', '생성된 문서 ZIP에 중복된 Unicode 경로 정보가 있습니다.');
  }
  const payload = unicodeFields[0].data;
  if (payload.length < 6 || payload[0] !== 1 || payload.readUInt32LE(1) !== convertedZipCrc32(rawNameBytes)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_INVALID', '생성된 문서 ZIP의 Unicode 경로 정보가 손상되었습니다.');
  }
  let unicodeName;
  try {
    unicodeName = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(5));
  } catch (error) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_INVALID', '생성된 문서 ZIP의 Unicode 경로 이름이 손상되었습니다.', error);
  }
  const canonical = safeConvertedZipPath(unicodeName);
  if (utf8 && (canonical.key !== primary.key || canonical.isDirectory !== primary.isDirectory)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_AMBIGUOUS', '생성된 문서 ZIP의 기본 경로와 Unicode 경로가 서로 다릅니다.');
  }
  if (canonical.isDirectory !== primary.isDirectory) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_PATH_AMBIGUOUS', '생성된 문서 ZIP 항목의 파일/폴더 경로 정보가 서로 다릅니다.');
  }
  return canonical;
}

function convertedZip64Extra(extra, needs) {
  const zip64Fields = convertedZipExtraFields(extra).filter((field) => field.id === 0x0001);
  if (zip64Fields.length !== 1) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 항목 확장 정보를 찾을 수 없습니다.');
  }
  const payload = zip64Fields[0].data;
  let cursor = 0;
  const result = {};
  const read64 = (key) => {
    if (cursor + 8 > payload.length) throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 항목 크기 정보가 잘렸습니다.');
    result[key] = payload.readBigUInt64LE(cursor);
    cursor += 8;
  };
  if (needs.uncompressed) read64('uncompressed');
  if (needs.compressed) read64('compressed');
  if (needs.localOffset) read64('localOffset');
  if (needs.disk) {
    if (cursor + 4 > payload.length) throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 디스크 정보가 잘렸습니다.');
    result.disk = payload.readUInt32LE(cursor);
  }
  return result;
}

async function convertedZipDataDescriptorBytes(handle, position, maximumPosition, entry) {
  const available = Math.min(24, maximumPosition - position);
  if (available < 12) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 데이터 설명자가 잘렸습니다.');
  }
  const descriptor = await readFileRangeExactly(handle, available, position);
  const signed = descriptor.length >= 4 && descriptor.readUInt32LE(0) === 0x08074b50;
  const signatureOffsets = signed ? [4, 0] : [0];
  const zip64Orders = entry.zip64Sizes ? [true, false] : [false, true];
  for (const offset of signatureOffsets) {
    for (const zip64 of zip64Orders) {
      const byteLength = offset + 4 + (zip64 ? 16 : 8);
      if (byteLength > descriptor.length || descriptor.readUInt32LE(offset) !== entry.crc32) continue;
      const compressed = zip64
        ? descriptor.readBigUInt64LE(offset + 4)
        : BigInt(descriptor.readUInt32LE(offset + 4));
      const uncompressed = zip64
        ? descriptor.readBigUInt64LE(offset + 12)
        : BigInt(descriptor.readUInt32LE(offset + 8));
      if (compressed === BigInt(entry.compressedBytes) && uncompressed === BigInt(entry.uncompressedBytes)) {
        return byteLength;
      }
    }
  }
  throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 데이터 설명자가 중앙 디렉터리와 일치하지 않습니다.');
}

async function readConvertedZip64Locator(handle, eocdOffset) {
  if (eocdOffset < 20) return null;
  const locatorOffset = eocdOffset - 20;
  const locator = await readFileRangeExactly(handle, 20, locatorOffset);
  if (locator.readUInt32LE(0) !== 0x07064b50) return null;
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_UNSUPPORTED', '생성된 문서 ZIP은 다중 디스크 형식을 사용할 수 없습니다.');
  }
  const recordOffset = safeConvertedZipNumber(locator.readBigUInt64LE(8), 'ZIP64 끝 레코드 위치');
  if (recordOffset + 56 > locatorOffset) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 끝 레코드 범위가 올바르지 않습니다.');
  }
  const header = await readFileRangeExactly(handle, 56, recordOffset);
  if (header.readUInt32LE(0) !== 0x06064b50) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 끝 레코드가 손상되었습니다.');
  }
  const recordBytes = safeConvertedZipNumber(header.readBigUInt64LE(4) + 12n, 'ZIP64 끝 레코드 크기');
  if (recordBytes < 56 || recordBytes > MAX_ZIP64_END_RECORD_BYTES
    || recordOffset + recordBytes !== locatorOffset) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 끝 레코드 범위가 올바르지 않습니다.');
  }
  return {
    recordOffset,
    disk: header.readUInt32LE(16),
    centralDisk: header.readUInt32LE(20),
    diskEntries: header.readBigUInt64LE(24),
    totalEntries: header.readBigUInt64LE(32),
    centralBytes: header.readBigUInt64LE(40),
    centralOffset: header.readBigUInt64LE(48)
  };
}

async function hasAdjacentConvertedZip64Record(handle, eocdOffset) {
  // A ZIP64 end record without its mandatory locator is malformed. Detect it
  // even when the legacy EOCD deliberately contains ordinary (unsaturated)
  // values, otherwise that legacy directory could bypass the ZIP64 directory.
  const scanBytes = Math.min(eocdOffset, MAX_ZIP64_END_RECORD_BYTES);
  const scanOffset = eocdOffset - scanBytes;
  let position = 0;
  let overlap = Buffer.alloc(0);
  while (position < scanBytes) {
    const chunkBytes = Math.min(64 * 1024, scanBytes - position);
    const chunk = await readFileRangeExactly(handle, chunkBytes, scanOffset + position);
    const searchable = overlap.length ? Buffer.concat([overlap, chunk]) : chunk;
    const searchableOffset = scanOffset + position - overlap.length;
    let index = 0;
    while ((index = searchable.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]), index)) !== -1) {
      const candidateOffset = searchableOffset + index;
      if (candidateOffset + 12 <= eocdOffset) {
        const prefix = await readFileRangeExactly(handle, 12, candidateOffset);
        let recordBytes = 0;
        try {
          recordBytes = safeConvertedZipNumber(prefix.readBigUInt64LE(4) + 12n, 'ZIP64 끝 레코드 크기');
        } catch (_) {
          recordBytes = 0;
        }
        if (recordBytes >= 56 && recordBytes <= MAX_ZIP64_END_RECORD_BYTES
          && candidateOffset + recordBytes === eocdOffset) return true;
      }
      index += 4;
    }
    overlap = searchable.subarray(Math.max(0, searchable.length - 3));
    position += chunkBytes;
  }
  return false;
}

async function readConvertedZipDirectory(handle, fileBytes) {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 22 || fileBytes > MAX_DOCUMENT_SOURCE_BYTES) {
    throw convertedZipError(
      fileBytes > MAX_DOCUMENT_SOURCE_BYTES ? 'DOCUMENT_OUTPUT_TOO_LARGE' : 'DOCUMENT_OUTPUT_ZIP_INVALID',
      fileBytes > MAX_DOCUMENT_SOURCE_BYTES
        ? '생성된 문서 ZIP이 안전한 결과 검사 한도(512MB)를 넘습니다.'
        : '생성된 문서 ZIP이 너무 짧습니다.'
    );
  }
  const tailBytes = Math.min(fileBytes, 65_557);
  const tailOffset = fileBytes - tailBytes;
  const tail = await readFileRangeExactly(handle, tailBytes, tailOffset);
  const endRecord = findConvertedZipEndRecord(tail, tailOffset, fileBytes);
  const eocd = tail.subarray(endRecord.bufferOffset, endRecord.bufferOffset + 22);
  const eocdDisk = eocd.readUInt16LE(4);
  const eocdCentralDisk = eocd.readUInt16LE(6);
  const eocdDiskEntries = eocd.readUInt16LE(8);
  const eocdTotalEntries = eocd.readUInt16LE(10);
  const eocdCentralBytes = eocd.readUInt32LE(12);
  const eocdCentralOffset = eocd.readUInt32LE(16);
  const needsZip64 = eocdDisk === 0xffff || eocdCentralDisk === 0xffff
    || eocdDiskEntries === 0xffff || eocdTotalEntries === 0xffff
    || eocdCentralBytes === 0xffffffff || eocdCentralOffset === 0xffffffff;
  const zip64Trailer = await readConvertedZip64Locator(handle, endRecord.fileOffset);
  if (!zip64Trailer && await hasAdjacentConvertedZip64Record(handle, endRecord.fileOffset)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서에 필수 위치 정보가 없습니다.');
  }

  let disk = eocdDisk;
  let centralDisk = eocdCentralDisk;
  let diskEntries = BigInt(eocdDiskEntries);
  let totalEntries = BigInt(eocdTotalEntries);
  let centralBytes = BigInt(eocdCentralBytes);
  let centralOffset = BigInt(eocdCentralOffset);
  let trailerOffset = endRecord.fileOffset;
  let zip64 = false;
  if (needsZip64 && !zip64Trailer) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 위치 정보가 없습니다.');
  }
  if (zip64Trailer) {
    if ((eocdDisk !== 0xffff && eocdDisk !== zip64Trailer.disk)
      || (eocdCentralDisk !== 0xffff && eocdCentralDisk !== zip64Trailer.centralDisk)
      || (eocdDiskEntries !== 0xffff && BigInt(eocdDiskEntries) !== zip64Trailer.diskEntries)
      || (eocdTotalEntries !== 0xffff && BigInt(eocdTotalEntries) !== zip64Trailer.totalEntries)
      || (eocdCentralBytes !== 0xffffffff && BigInt(eocdCentralBytes) !== zip64Trailer.centralBytes)
      || (eocdCentralOffset !== 0xffffffff && BigInt(eocdCentralOffset) !== zip64Trailer.centralOffset)) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP64_INVALID', '생성된 ZIP64 문서의 기본 및 확장 끝 정보가 서로 다릅니다.');
    }
    disk = zip64Trailer.disk;
    centralDisk = zip64Trailer.centralDisk;
    diskEntries = zip64Trailer.diskEntries;
    totalEntries = zip64Trailer.totalEntries;
    centralBytes = zip64Trailer.centralBytes;
    centralOffset = zip64Trailer.centralOffset;
    trailerOffset = zip64Trailer.recordOffset;
    zip64 = true;
  }
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_UNSUPPORTED', '생성된 문서 ZIP은 다중 디스크 형식을 사용할 수 없습니다.');
  }
  if (totalEntries <= 0n || totalEntries > BigInt(MAX_CONVERTED_ZIP_ENTRIES)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_ENTRY_LIMIT', '생성된 문서 ZIP의 항목 수가 안전한 범위를 벗어났습니다.');
  }
  if (centralBytes <= 0n || centralBytes > BigInt(MAX_CONVERTED_ZIP_CENTRAL_DIRECTORY_BYTES)) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_DIRECTORY_LIMIT', '생성된 문서 ZIP의 중앙 디렉터리가 안전한 크기 범위를 벗어났습니다.');
  }
  const centralOffsetNumber = safeConvertedZipNumber(centralOffset, '중앙 디렉터리 위치');
  const centralBytesNumber = safeConvertedZipNumber(centralBytes, '중앙 디렉터리 크기');
  if (centralOffsetNumber < 4 || centralOffsetNumber + centralBytesNumber > trailerOffset) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 중앙 디렉터리 범위가 올바르지 않습니다.');
  }
  const central = await readFileRangeExactly(handle, centralBytesNumber, centralOffsetNumber);
  const entries = [];
  const names = new Set();
  let cursor = 0;
  let totalUncompressed = 0n;
  let totalCompressed = 0n;
  const entryCount = Number(totalEntries);
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 중앙 디렉터리 항목이 손상되었습니다.');
    }
    const madeBy = central.readUInt16LE(cursor + 4);
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const crc32 = central.readUInt32LE(cursor + 16);
    const compressed32 = central.readUInt32LE(cursor + 20);
    const uncompressed32 = central.readUInt32LE(cursor + 24);
    const nameBytes = central.readUInt16LE(cursor + 28);
    const extraBytes = central.readUInt16LE(cursor + 30);
    const commentBytes = central.readUInt16LE(cursor + 32);
    const disk32 = central.readUInt16LE(cursor + 34);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localOffset32 = central.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (!nameBytes || nameBytes > MAX_CONVERTED_ZIP_PATH_BYTES || end > central.length || (flags & 0x0001) || (flags & 0x0040)) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP에 암호화되었거나 손상된 항목이 있습니다.');
    }
    const rawName = central.subarray(cursor + 46, cursor + 46 + nameBytes);
    const extra = central.subarray(cursor + 46 + nameBytes, cursor + 46 + nameBytes + extraBytes);
    const pathInfo = convertedZipPath(rawName, Boolean(flags & 0x0800), extra);
    if (names.has(pathInfo.key)) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_DUPLICATE', '생성된 문서 ZIP에 대소문자만 다른 중복 경로가 있습니다.');
    }
    names.add(pathInfo.key);
    const hostSystem = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (hostSystem === 3 && (unixMode & 0o170000) === 0o120000) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_SYMLINK', '생성된 문서 ZIP의 심볼릭 링크는 허용하지 않습니다.');
    }
    const needs = {
      uncompressed: uncompressed32 === 0xffffffff,
      compressed: compressed32 === 0xffffffff,
      localOffset: localOffset32 === 0xffffffff,
      disk: disk32 === 0xffff
    };
    const zip64Extra = Object.values(needs).some(Boolean)
      ? convertedZip64Extra(extra, needs)
      : {};
    const uncompressed = needs.uncompressed ? zip64Extra.uncompressed : BigInt(uncompressed32);
    const compressed = needs.compressed ? zip64Extra.compressed : BigInt(compressed32);
    const localOffset = needs.localOffset ? zip64Extra.localOffset : BigInt(localOffset32);
    const entryDisk = needs.disk ? zip64Extra.disk : disk32;
    if (entryDisk !== 0) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_UNSUPPORTED', '생성된 문서 ZIP은 다중 디스크 항목을 사용할 수 없습니다.');
    }
    if (uncompressed > BigInt(MAX_CONVERTED_ZIP_ENTRY_UNCOMPRESSED_BYTES)) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_BOMB', '생성된 문서 ZIP의 단일 항목 압축 해제 크기가 너무 큽니다.');
    }
    totalUncompressed += uncompressed;
    totalCompressed += compressed;
    if (totalUncompressed > BigInt(MAX_CONVERTED_ZIP_UNCOMPRESSED_BYTES)
      || totalCompressed > BigInt(fileBytes)) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_BOMB', '생성된 문서 ZIP의 전체 압축 해제 크기 또는 압축 데이터 합계가 안전한 범위를 넘습니다.');
    }
    if (method === 0 && compressed !== uncompressed) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 무압축 항목 크기 정보가 서로 다릅니다.');
    }
    entries.push({
      ...pathInfo,
      flags,
      method,
      crc32,
      zip64Sizes: needs.uncompressed || needs.compressed,
      compressedBytes: safeConvertedZipNumber(compressed, '압축 항목 크기'),
      uncompressedBytes: safeConvertedZipNumber(uncompressed, '압축 해제 항목 크기'),
      localHeaderOffset: safeConvertedZipNumber(localOffset, '로컬 헤더 위치')
    });
    cursor = end;
  }
  if (cursor !== central.length) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 중앙 디렉터리 크기가 항목 목록과 일치하지 않습니다.');
  }

  const ranges = [];
  let localMetadataBytes = 0;
  for (const entry of entries) {
    if (entry.localHeaderOffset < 0 || entry.localHeaderOffset + 30 > centralOffsetNumber) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 로컬 헤더 위치가 올바르지 않습니다.');
    }
    const local = await readFileRangeExactly(handle, 30, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 로컬 헤더가 손상되었습니다.');
    }
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const localCrc32 = local.readUInt32LE(14);
    const localCompressed32 = local.readUInt32LE(18);
    const localUncompressed32 = local.readUInt32LE(22);
    const localNameBytes = local.readUInt16LE(26);
    const localExtraBytes = local.readUInt16LE(28);
    if (!localNameBytes || localNameBytes > MAX_CONVERTED_ZIP_PATH_BYTES
      || localFlags !== entry.flags || localMethod !== entry.method || (localFlags & 0x0001) || (localFlags & 0x0040)) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 로컬 및 중앙 항목 정보가 서로 다릅니다.');
    }
    localMetadataBytes += localNameBytes + localExtraBytes;
    if (localMetadataBytes > MAX_CONVERTED_ZIP_CENTRAL_DIRECTORY_BYTES) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_DIRECTORY_LIMIT', '생성된 문서 ZIP의 로컬 항목 정보가 안전한 크기 범위를 벗어났습니다.');
    }
    const dataOffset = entry.localHeaderOffset + 30 + localNameBytes + localExtraBytes;
    const dataEnd = dataOffset + entry.compressedBytes;
    if (!Number.isSafeInteger(dataEnd) || dataOffset > centralOffsetNumber || dataEnd > centralOffsetNumber) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 항목 데이터 범위가 올바르지 않습니다.');
    }
    const localMetadata = await readFileRangeExactly(
      handle,
      localNameBytes + localExtraBytes,
      entry.localHeaderOffset + 30
    );
    const localName = localMetadata.subarray(0, localNameBytes);
    const localExtra = localMetadata.subarray(localNameBytes);
    const localPath = convertedZipPath(localName, Boolean(localFlags & 0x0800), localExtra);
    if (localPath.name !== entry.name || localPath.isDirectory !== entry.isDirectory) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 로컬 및 중앙 항목 이름이 서로 다릅니다.');
    }
    entry.dataOffset = dataOffset;
    entry.localExtraBytes = localExtraBytes;
    entry.usesDataDescriptor = Boolean(localFlags & 0x0008);
    let recordEnd = dataEnd;
    if (localFlags & 0x0008) {
      if ((localCrc32 !== 0 && localCrc32 !== entry.crc32)
        || (localCompressed32 !== 0 && localCompressed32 !== 0xffffffff && localCompressed32 !== entry.compressedBytes)
        || (localUncompressed32 !== 0 && localUncompressed32 !== 0xffffffff && localUncompressed32 !== entry.uncompressedBytes)) {
        throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 로컬 크기 정보가 중앙 디렉터리와 일치하지 않습니다.');
      }
      recordEnd += await convertedZipDataDescriptorBytes(handle, dataEnd, centralOffsetNumber, entry);
    } else {
      const localNeeds = {
        uncompressed: localUncompressed32 === 0xffffffff,
        compressed: localCompressed32 === 0xffffffff,
        localOffset: false,
        disk: false
      };
      const localZip64 = (localNeeds.uncompressed || localNeeds.compressed)
        ? convertedZip64Extra(localExtra, localNeeds)
        : {};
      const localUncompressed = localNeeds.uncompressed ? localZip64.uncompressed : BigInt(localUncompressed32);
      const localCompressed = localNeeds.compressed ? localZip64.compressed : BigInt(localCompressed32);
      if (localCrc32 !== entry.crc32
        || localCompressed !== BigInt(entry.compressedBytes)
        || localUncompressed !== BigInt(entry.uncompressedBytes)) {
        throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP의 로컬 CRC 또는 크기 정보가 중앙 디렉터리와 일치하지 않습니다.');
      }
    }
    ranges.push({ start: entry.localHeaderOffset, end: recordEnd });
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_OVERLAP', '생성된 문서 ZIP의 항목 데이터 범위가 서로 겹칩니다.');
    }
  }
  let mimetype = null;
  const mimetypeEntry = entries.find((entry) => !entry.isDirectory && entry.name === 'mimetype');
  if (mimetypeEntry) {
    if (mimetypeEntry.localHeaderOffset !== 0 || mimetypeEntry.method !== 0
      || mimetypeEntry.usesDataDescriptor || mimetypeEntry.localExtraBytes !== 0
      || mimetypeEntry.compressedBytes !== mimetypeEntry.uncompressedBytes
      || mimetypeEntry.uncompressedBytes <= 0 || mimetypeEntry.uncompressedBytes > 256) {
      throw convertedZipError('DOCUMENT_OUTPUT_ODF_MIMETYPE_INVALID', '생성된 OpenDocument의 mimetype 항목 배치 또는 저장 방식이 올바르지 않습니다.');
    }
    const mimetypeBytes = await readFileRangeExactly(handle, mimetypeEntry.uncompressedBytes, mimetypeEntry.dataOffset);
    if (convertedZipCrc32(mimetypeBytes) !== mimetypeEntry.crc32) {
      throw convertedZipError('DOCUMENT_OUTPUT_ODF_MIMETYPE_INVALID', '생성된 OpenDocument의 mimetype 항목이 손상되었습니다.');
    }
    try {
      mimetype = new TextDecoder('ascii', { fatal: true }).decode(mimetypeBytes);
    } catch (error) {
      throw convertedZipError('DOCUMENT_OUTPUT_ODF_MIMETYPE_INVALID', '생성된 OpenDocument의 mimetype 문자열이 손상되었습니다.', error);
    }
  }
  return {
    entryCount,
    uncompressedBytes: Number(totalUncompressed),
    entries,
    zip64,
    mimetype
  };
}

function convertedZipXmlEncoding(prefix) {
  const bytes = Buffer.from(prefix || []);
  if (bytes.length >= 4
    && ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00))) {
    throw convertedZipError('DOCUMENT_OUTPUT_XML_ENCODING_INVALID', '생성된 문서의 필수 XML에 지원하지 않는 UTF-32 인코딩이 있습니다.');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', offset: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', offset: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', offset: 2 };
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00) {
    return { encoding: 'utf-16be', offset: 0 };
  }
  if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00) {
    return { encoding: 'utf-16le', offset: 0 };
  }
  return { encoding: 'utf-8', offset: 0 };
}

async function* convertedZipFileChunks(handle, position, length) {
  let offset = 0;
  while (offset < length) {
    const chunkBytes = Math.min(64 * 1024, length - offset);
    yield await readFileRangeExactly(handle, chunkBytes, position + offset);
    offset += chunkBytes;
  }
}

async function inspectConvertedZipRequiredEntry(handle, entry, options = {}) {
  const required = options.required === true;
  if (!entry || entry.isDirectory || (required && entry.uncompressedBytes <= 0)) {
    throw convertedZipError('DOCUMENT_OUTPUT_PACKAGE_CONTENT_INVALID', '생성된 문서 ZIP의 필수 항목이 비어 있습니다.');
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw convertedZipError('DOCUMENT_OUTPUT_ZIP_METHOD_UNSUPPORTED', '생성된 문서 ZIP 항목이 지원하지 않는 압축 방식을 사용합니다.');
  }
  if (required && entry.compressedBytes <= 0) {
    throw convertedZipError('DOCUMENT_OUTPUT_PACKAGE_CONTENT_INVALID', '생성된 문서 ZIP의 필수 항목에 압축 데이터가 없습니다.');
  }
  const xml = options.xml === true;
  if (xml && entry.uncompressedBytes > MAX_CONVERTED_ZIP_REQUIRED_XML_BYTES) {
    throw convertedZipError('DOCUMENT_OUTPUT_XML_TOO_LARGE', '생성된 문서 ZIP의 필수 XML이 안전한 검사 한도(32MB)를 넘습니다.');
  }
  if (required && !xml && entry.uncompressedBytes > MAX_CONVERTED_ZIP_REQUIRED_BINARY_BYTES) {
    throw convertedZipError('DOCUMENT_OUTPUT_REQUIRED_ENTRY_TOO_LARGE', '생성된 문서 ZIP의 필수 바이너리 항목이 안전한 검사 한도(256MB)를 넘습니다.');
  }

  const parser = xml ? new SaxesParser({ xmlns: true, position: true }) : null;
  let rootLocalName = '';
  let rootNamespace = '';
  if (parser) {
    parser.on('doctype', () => {
      throw convertedZipError('DOCUMENT_OUTPUT_XML_DOCTYPE', '생성된 문서의 필수 XML에 허용되지 않는 문서 형식 선언이 있습니다.');
    });
    parser.on('opentag', (tag) => {
      if (!rootLocalName) {
        rootLocalName = String(tag?.local || tag?.name || '').split(':').pop();
        rootNamespace = String(tag?.uri || '');
      }
      options.onOpenTag?.(tag);
    });
  }

  const source = Readable.from(convertedZipFileChunks(handle, entry.dataOffset, entry.compressedBytes));
  let content = source;
  if (entry.method === 8) {
    const inflater = createInflateRaw();
    source.on('error', (error) => inflater.destroy(error));
    content = source.pipe(inflater);
  }

  let byteCount = 0;
  let crc = 0xffffffff;
  let decoder = null;
  let xmlPrefix = Buffer.alloc(0);
  const writeXml = (bytes, final = false) => {
    if (!parser) return;
    if (!decoder) {
      xmlPrefix = Buffer.concat([xmlPrefix, Buffer.from(bytes)]);
      if (!final && xmlPrefix.length < 4) return;
      const detected = convertedZipXmlEncoding(xmlPrefix);
      decoder = new TextDecoder(detected.encoding, { fatal: true });
      const decoded = decoder.decode(xmlPrefix.subarray(detected.offset), { stream: !final });
      xmlPrefix = Buffer.alloc(0);
      if (decoded) parser.write(decoded);
      return;
    }
    const decoded = decoder.decode(bytes, { stream: !final });
    if (decoded) parser.write(decoded);
  };

  try {
    for await (const chunk of content) {
      const bytes = Buffer.from(chunk);
      byteCount += bytes.length;
      if (byteCount > entry.uncompressedBytes) {
        throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP 항목의 실제 압축 해제 크기가 선언값을 넘습니다.');
      }
      crc = updateConvertedZipCrc32(crc, bytes);
      writeXml(bytes, false);
    }
    if (byteCount !== entry.uncompressedBytes) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_INVALID', '생성된 문서 ZIP 항목의 실제 압축 해제 크기가 선언값과 다릅니다.');
    }
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw convertedZipError('DOCUMENT_OUTPUT_ZIP_CRC_MISMATCH', '생성된 문서 ZIP 항목의 CRC가 일치하지 않습니다.');
    }
    if (parser) {
      writeXml(Buffer.alloc(0), true);
      parser.close();
      const expectedRoots = Array.isArray(options.rootLocalNames) ? options.rootLocalNames : [];
      const expectedNamespaces = Array.isArray(options.rootNamespaceUris) ? options.rootNamespaceUris : [];
      if (!rootLocalName || (expectedRoots.length && !expectedRoots.includes(rootLocalName))
        || (expectedNamespaces.length && !expectedNamespaces.includes(rootNamespace))) {
        throw convertedZipError('DOCUMENT_OUTPUT_XML_ROOT_INVALID', '생성된 문서 ZIP의 필수 XML 루트 요소가 올바르지 않습니다.');
      }
    }
  } catch (error) {
    if (String(error?.code || '').startsWith('DOCUMENT_OUTPUT_')) throw error;
    throw convertedZipError(
      xml ? 'DOCUMENT_OUTPUT_XML_INVALID' : 'DOCUMENT_OUTPUT_ZIP_INVALID',
      xml ? '생성된 문서 ZIP의 필수 XML을 안전하게 해석하지 못했습니다.' : '생성된 문서 ZIP의 필수 항목을 압축 해제하지 못했습니다.',
      error
    );
  } finally {
    source.destroy();
    if (content !== source) content.destroy();
  }
  return { name: entry.name, rootLocalName, rootNamespace, bytes: byteCount };
}

function convertedZipPackageStructureError(extension) {
  return convertedZipError(
    'DOCUMENT_OUTPUT_PACKAGE_STRUCTURE_INVALID',
    `생성된 ${extension.toUpperCase()} 문서의 내부 필수 구조를 확인하지 못해 저장을 중단했습니다.`
  );
}

function convertedZipXmlAttribute(tag, localName) {
  const matches = Object.values(tag?.attributes || {}).filter((attribute) => (
    String(attribute?.local || attribute?.name || '').split(':').pop() === localName
    && !String(attribute?.uri || '')
  ));
  return matches.length === 1 ? String(matches[0].value ?? '') : '';
}

function convertedZipXmlAttributeInNamespace(tag, localName, namespaceUri) {
  const matches = Object.values(tag?.attributes || {}).filter((attribute) => (
    String(attribute?.local || attribute?.name || '').split(':').pop() === localName
    && String(attribute?.uri || '') === namespaceUri
  ));
  return matches.length === 1 ? String(matches[0].value ?? '') : '';
}

function convertedZipRelationshipTargetsMain(target, mainPart) {
  const value = String(target || '');
  if (!value || /[?#\\]/.test(value)) return false;
  const relative = value.startsWith('/') ? value.slice(1) : value;
  if (!relative || relative.startsWith('../') || relative.includes('/../') || relative.includes('/./')) return false;
  return relative === mainPart;
}

function validateConvertedOoxmlMetadata(extension, profile, contentTypes, relationships) {
  const partName = `/${profile.mainPart}`;
  const matchingOverrides = contentTypes.overrides.filter((item) => item.partName === partName);
  if (matchingOverrides.length > 1) throw convertedZipPackageStructureError(extension);
  let actualContentType = matchingOverrides[0]?.contentType || '';
  if (!actualContentType) {
    const mainExtension = path.posix.extname(profile.mainPart).slice(1).toLocaleLowerCase('en-US');
    const matchingDefaults = contentTypes.defaults.filter((item) => (
      item.extension.toLocaleLowerCase('en-US') === mainExtension
    ));
    if (matchingDefaults.length !== 1) throw convertedZipPackageStructureError(extension);
    actualContentType = matchingDefaults[0].contentType;
  }
  if (actualContentType !== profile.contentType) throw convertedZipPackageStructureError(extension);

  const officeDocuments = relationships.filter((item) => item.type === OPC_OFFICE_DOCUMENT_RELATIONSHIP);
  if (officeDocuments.length !== 1
    || !officeDocuments[0].id
    || (officeDocuments[0].targetMode && officeDocuments[0].targetMode !== 'Internal')
    || !convertedZipRelationshipTargetsMain(officeDocuments[0].target, profile.mainPart)) {
    throw convertedZipPackageStructureError(extension);
  }
}

async function validateConvertedZipPackageContents(handle, packageInfo, extension) {
  const exactEntries = new Map(packageInfo.entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => [entry.name, entry]));
  const required = (name, options = {}) => {
    const entry = exactEntries.get(name);
    if (!entry) throw convertedZipPackageStructureError(extension);
    return { entry, options: { ...options, required: true } };
  };
  let specifications = [];
  let ooxmlValidation = null;
  const ooxmlProfile = OOXML_PACKAGE_PROFILES[extension];
  if (ooxmlProfile) {
    const contentTypes = { overrides: [], defaults: [] };
    const relationships = [];
    const contentTypesOptions = {
      xml: true,
      rootLocalNames: ['Types'],
      rootNamespaceUris: [OPC_CONTENT_TYPES_NAMESPACE],
      onOpenTag(tag) {
        if (String(tag?.uri || '') !== OPC_CONTENT_TYPES_NAMESPACE) return;
        const local = String(tag?.local || tag?.name || '').split(':').pop();
        if (local === 'Override') {
          contentTypes.overrides.push({
            partName: convertedZipXmlAttribute(tag, 'PartName'),
            contentType: convertedZipXmlAttribute(tag, 'ContentType')
          });
        } else if (local === 'Default') {
          contentTypes.defaults.push({
            extension: convertedZipXmlAttribute(tag, 'Extension'),
            contentType: convertedZipXmlAttribute(tag, 'ContentType')
          });
        }
      }
    };
    const relationshipsOptions = {
      xml: true,
      rootLocalNames: ['Relationships'],
      rootNamespaceUris: [OPC_RELATIONSHIPS_NAMESPACE],
      onOpenTag(tag) {
        if (String(tag?.uri || '') !== OPC_RELATIONSHIPS_NAMESPACE
          || String(tag?.local || tag?.name || '').split(':').pop() !== 'Relationship') return;
        relationships.push({
          id: convertedZipXmlAttribute(tag, 'Id'),
          type: convertedZipXmlAttribute(tag, 'Type'),
          target: convertedZipXmlAttribute(tag, 'Target'),
          targetMode: convertedZipXmlAttribute(tag, 'TargetMode')
        });
      }
    };
    specifications = [
      required('[Content_Types].xml', contentTypesOptions),
      required('_rels/.rels', relationshipsOptions),
      required(ooxmlProfile.mainPart, ooxmlProfile.mainRoot ? {
        xml: true,
        rootLocalNames: [ooxmlProfile.mainRoot],
        rootNamespaceUris: [ooxmlProfile.mainNamespace]
      } : {})
    ];
    ooxmlValidation = () => validateConvertedOoxmlMetadata(extension, ooxmlProfile, contentTypes, relationships);
  } else if (extension === 'odp' || extension === 'odt' || extension === 'ods') {
    const expectedMimetype = {
      odp: 'application/vnd.oasis.opendocument.presentation',
      odt: 'application/vnd.oasis.opendocument.text',
      ods: 'application/vnd.oasis.opendocument.spreadsheet'
    }[extension];
    if (packageInfo.mimetype !== expectedMimetype) throw convertedZipPackageStructureError(extension);
    specifications = [
      required('content.xml', { xml: true, rootLocalNames: ['document-content'] }),
      required('META-INF/manifest.xml', { xml: true, rootLocalNames: ['manifest'] })
    ];
  } else if (extension === 'hwpx') {
    if (packageInfo.mimetype !== 'application/hwp+zip') throw convertedZipPackageStructureError(extension);
    specifications = [
      required('Contents/content.hpf', { xml: true, rootLocalNames: ['package'] }),
      required('Contents/header.xml', { xml: true, rootLocalNames: ['head'] }),
      required('Contents/section0.xml', { xml: true, rootLocalNames: ['sec'] })
    ];
  } else {
    throw convertedZipPackageStructureError(extension);
  }
  const specificationByName = new Map(specifications.map((specification) => [specification.entry.name, specification]));
  const inspected = [];
  let requiredEntriesChecked = 0;
  for (const entry of packageInfo.entries) {
    if (entry.isDirectory) continue;
    const specification = specificationByName.get(entry.name);
    inspected.push(await inspectConvertedZipRequiredEntry(handle, entry, specification?.options || {}));
    if (specification) requiredEntriesChecked += 1;
  }
  ooxmlValidation?.();
  return {
    structureChecked: true,
    requiredEntriesChecked,
    entriesChecked: inspected.length
  };
}

function convertedPptxRelationshipTarget(target) {
  const value = String(target || '');
  if (!value || /[?#\\]/.test(value)) return '';
  const packagePath = value.startsWith('/')
    ? value.slice(1)
    : path.posix.join('ppt', value);
  if (!/^ppt\/slides\/slide[1-9]\d*\.xml$/.test(packagePath)) return '';
  return packagePath;
}

async function inspectConvertedPptxSlideGraph(handle, packageInfo) {
  const exactEntries = new Map(packageInfo.entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => [entry.name, entry]));
  const presentation = exactEntries.get('ppt/presentation.xml');
  const relationshipsEntry = exactEntries.get('ppt/_rels/presentation.xml.rels');
  if (!presentation || !relationshipsEntry) throw convertedZipPackageStructureError('pptx');
  const slideIds = [];
  const relationships = [];
  await inspectConvertedZipRequiredEntry(handle, presentation, {
    required: true,
    xml: true,
    rootLocalNames: ['presentation'],
    rootNamespaceUris: [OOXML_PACKAGE_PROFILES.pptx.mainNamespace],
    onOpenTag(tag) {
      if (String(tag?.uri || '') !== OOXML_PACKAGE_PROFILES.pptx.mainNamespace
        || String(tag?.local || tag?.name || '').split(':').pop() !== 'sldId') return;
      slideIds.push(convertedZipXmlAttributeInNamespace(tag, 'id', OPC_DOCUMENT_RELATIONSHIPS_NAMESPACE));
    }
  });
  await inspectConvertedZipRequiredEntry(handle, relationshipsEntry, {
    required: true,
    xml: true,
    rootLocalNames: ['Relationships'],
    rootNamespaceUris: [OPC_RELATIONSHIPS_NAMESPACE],
    onOpenTag(tag) {
      if (String(tag?.uri || '') !== OPC_RELATIONSHIPS_NAMESPACE
        || String(tag?.local || tag?.name || '').split(':').pop() !== 'Relationship') return;
      relationships.push({
        id: convertedZipXmlAttribute(tag, 'Id'),
        type: convertedZipXmlAttribute(tag, 'Type'),
        target: convertedZipXmlAttribute(tag, 'Target'),
        targetMode: convertedZipXmlAttribute(tag, 'TargetMode')
      });
    }
  });
  if (new Set(slideIds).size !== slideIds.length || slideIds.some((id) => !id)) {
    throw convertedZipPackageStructureError('pptx');
  }
  const relationshipById = new Map();
  for (const relationship of relationships) {
    if (!relationship.id || relationshipById.has(relationship.id)) throw convertedZipPackageStructureError('pptx');
    relationshipById.set(relationship.id, relationship);
  }
  const linkedSlides = new Set();
  for (const id of slideIds) {
    const relationship = relationshipById.get(id);
    const target = convertedPptxRelationshipTarget(relationship?.target);
    if (!relationship || relationship.type !== OPC_SLIDE_RELATIONSHIP
      || (relationship.targetMode && relationship.targetMode !== 'Internal')
      || !target || !exactEntries.has(target) || linkedSlides.has(target)) {
      throw convertedZipPackageStructureError('pptx');
    }
    linkedSlides.add(target);
  }
  return { slideCount: slideIds.length, slideCountFromRelationships: true };
}

async function inspectConvertedZipIntegrity(filePath, stats) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size <= 0 || (stats && !sameOutputFileStats(stats, openedStats))) {
      throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    const result = await readConvertedZipDirectory(handle, openedStats.size);
    let entriesChecked = 0;
    for (const entry of result.entries) {
      if (entry.isDirectory) continue;
      await inspectConvertedZipRequiredEntry(handle, entry);
      entriesChecked += 1;
    }
    if (!entriesChecked) throw convertedZipError('DOCUMENT_OUTPUT_PACKAGE_CONTENT_INVALID', '생성된 문서 ZIP에 파일 항목이 없습니다.');
    const finalStats = await handle.stat();
    if (!sameOutputFileStats(openedStats, finalStats)) {
      throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    return { ...result, entriesChecked, structureChecked: true };
  } finally {
    await handle.close();
  }
}

async function inspectConvertedZipPackage(filePath, stats, extension) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size <= 0) {
      throw convertedZipError('DOCUMENT_OUTPUT_EMPTY', '변환 결과 파일이 비어 있습니다.');
    }
    if (stats && !sameOutputFileStats(stats, openedStats)) {
      throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    const result = await readConvertedZipDirectory(handle, openedStats.size);
    const contentValidation = await validateConvertedZipPackageContents(handle, result, extension);
    const slideValidation = extension === 'pptx' && openedStats.size > MAX_DOCUMENT_FONT_INSPECTION_BYTES
      ? await inspectConvertedPptxSlideGraph(handle, result)
      : {};
    const finalStats = await handle.stat();
    if (!sameOutputFileStats(openedStats, finalStats)) {
      throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    return { ...result, ...contentValidation, ...slideValidation };
  } finally {
    await handle.close();
  }
}

function sameOutputFileStats(left, right) {
  return Boolean(left && right
    && left.isFile() && right.isFile()
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino);
}

function convertedCfbError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function readConvertedCfbRangeExactly(handle, length, position) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
    throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 파일 범위가 올바르지 않습니다.');
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서가 예상보다 일찍 끝났습니다.');
    }
    offset += result.bytesRead;
  }
  return buffer;
}

function isConvertedCfbRegularSector(sector, sectorCount) {
  return Number.isInteger(sector) && sector >= 0 && sector <= CFB_MAX_REGULAR_SECTOR && sector < sectorCount;
}

async function inspectConvertedCfbFile(filePath, initialStats) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size < 512 || openedStats.size > MAX_DOCUMENT_SOURCE_BYTES) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 크기가 안전한 범위를 벗어났습니다.');
    }
    if (initialStats && !sameOutputFileStats(initialStats, openedStats)) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    const header = await readConvertedCfbRangeExactly(handle, 512, 0);
    if (!header.subarray(0, 8).equals(OLE_COMPOUND_FILE_SIGNATURE)
      || header.subarray(8, 24).some((byte) => byte !== 0)) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 파일의 복합 문서 헤더가 올바르지 않습니다.');
    }
    const minorVersion = header.readUInt16LE(24);
    const majorVersion = header.readUInt16LE(26);
    const byteOrder = header.readUInt16LE(28);
    const sectorShift = header.readUInt16LE(30);
    const miniSectorShift = header.readUInt16LE(32);
    const sectorSize = 2 ** sectorShift;
    if (![0x003b, 0x003e].includes(minorVersion)
      || ![3, 4].includes(majorVersion)
      || byteOrder !== 0xfffe
      || sectorShift !== (majorVersion === 3 ? 9 : 12)
      || miniSectorShift !== 6
      || header.subarray(34, 40).some((byte) => byte !== 0)
      || header.readUInt32LE(56) !== 4096
      || !Number.isSafeInteger(sectorSize)
      || openedStats.size % sectorSize !== 0) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 버전 또는 섹터 정보가 올바르지 않습니다.');
    }
    const sectorCount = openedStats.size / sectorSize - 1;
    const directorySectorCount = header.readUInt32LE(40);
    const fatSectorCount = header.readUInt32LE(44);
    const firstDirectorySector = header.readUInt32LE(48);
    const firstMiniFatSector = header.readUInt32LE(60);
    const miniFatSectorCount = header.readUInt32LE(64);
    const firstDifatSector = header.readUInt32LE(68);
    const difatSectorCount = header.readUInt32LE(72);
    const fatEntriesPerSector = sectorSize / 4;
    if (sectorCount < 2 || fatSectorCount < 1 || fatSectorCount > sectorCount
      || fatSectorCount * fatEntriesPerSector < sectorCount
      || !isConvertedCfbRegularSector(firstDirectorySector, sectorCount)
      || (majorVersion === 3 && directorySectorCount !== 0)
      || (majorVersion === 4 && (directorySectorCount < 1 || directorySectorCount > sectorCount))
      || miniFatSectorCount > sectorCount || difatSectorCount > sectorCount) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 FAT 또는 디렉터리 범위가 올바르지 않습니다.');
    }

    const fatSectors = [];
    const seenFatSectors = new Set();
    const addFatSector = (sector) => {
      if (!isConvertedCfbRegularSector(sector, sectorCount) || seenFatSectors.has(sector)) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 FAT 섹터 목록이 올바르지 않습니다.');
      }
      seenFatSectors.add(sector);
      fatSectors.push(sector);
    };
    for (let index = 0; index < 109; index += 1) {
      const sector = header.readUInt32LE(76 + index * 4);
      if (fatSectors.length < fatSectorCount) addFatSector(sector);
      else if (sector !== CFB_FREE_SECTOR) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 미사용 DIFAT 항목이 올바르지 않습니다.');
      }
    }

    const difatSectors = [];
    if (fatSectorCount <= 109) {
      if (difatSectorCount !== 0 || firstDifatSector !== CFB_END_OF_CHAIN) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 DIFAT 정보가 올바르지 않습니다.');
      }
    } else {
      if (!difatSectorCount || !isConvertedCfbRegularSector(firstDifatSector, sectorCount)) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 DIFAT 시작 정보가 올바르지 않습니다.');
      }
      let sector = firstDifatSector;
      const entriesPerDifatSector = fatEntriesPerSector - 1;
      const seenDifatSectors = new Set();
      for (let index = 0; index < difatSectorCount; index += 1) {
        if (!isConvertedCfbRegularSector(sector, sectorCount)
          || seenDifatSectors.has(sector) || seenFatSectors.has(sector)) {
          throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 DIFAT 체인이 올바르지 않습니다.');
        }
        seenDifatSectors.add(sector);
        difatSectors.push(sector);
        const bytes = await readConvertedCfbRangeExactly(handle, sectorSize, (sector + 1) * sectorSize);
        for (let item = 0; item < entriesPerDifatSector; item += 1) {
          const fatSector = bytes.readUInt32LE(item * 4);
          if (fatSectors.length < fatSectorCount) addFatSector(fatSector);
          else if (fatSector !== CFB_FREE_SECTOR) {
            throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 미사용 DIFAT 항목이 올바르지 않습니다.');
          }
        }
        sector = bytes.readUInt32LE(entriesPerDifatSector * 4);
      }
      if (sector !== CFB_END_OF_CHAIN || fatSectors.length !== fatSectorCount) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 DIFAT 길이가 선언값과 다릅니다.');
      }
    }
    if (fatSectors.length !== fatSectorCount) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 FAT 섹터 수가 선언값과 다릅니다.');
    }

    const fatBuffers = [];
    for (const sector of fatSectors) {
      fatBuffers.push(await readConvertedCfbRangeExactly(handle, sectorSize, (sector + 1) * sectorSize));
    }
    const fatEntry = (sector) => fatBuffers[Math.floor(sector / fatEntriesPerSector)]
      .readUInt32LE((sector % fatEntriesPerSector) * 4);
    for (let sector = 0; sector < sectorCount; sector += 1) {
      const next = fatEntry(sector);
      if (next <= CFB_MAX_REGULAR_SECTOR && next >= sectorCount) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 FAT 체인이 파일 범위를 벗어났습니다.');
      }
      if (next > CFB_MAX_REGULAR_SECTOR
        && ![CFB_FREE_SECTOR, CFB_END_OF_CHAIN, CFB_FAT_SECTOR, CFB_DIFAT_SECTOR].includes(next)) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 FAT 항목이 올바르지 않습니다.');
      }
    }
    for (const sector of fatSectors) {
      if (fatEntry(sector) !== CFB_FAT_SECTOR) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 FAT 섹터 표식이 올바르지 않습니다.');
      }
    }
    for (const sector of difatSectors) {
      if (fatEntry(sector) !== CFB_DIFAT_SECTOR) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 DIFAT 섹터 표식이 올바르지 않습니다.');
      }
    }

    const occupiedChains = new Set([...fatSectors, ...difatSectors]);
    const readChain = (start, expectedCount, label) => {
      if (expectedCount === 0 && start === CFB_END_OF_CHAIN) return [];
      if (!isConvertedCfbRegularSector(start, sectorCount)) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', `생성된 복합 문서의 ${label} 시작 섹터가 올바르지 않습니다.`);
      }
      const chain = [];
      const seen = new Set();
      let sector = start;
      while (sector !== CFB_END_OF_CHAIN) {
        if (!isConvertedCfbRegularSector(sector, sectorCount) || seen.has(sector) || occupiedChains.has(sector)) {
          throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', `생성된 복합 문서의 ${label} 체인이 겹치거나 순환합니다.`);
        }
        seen.add(sector);
        chain.push(sector);
        if (chain.length > sectorCount || (expectedCount > 0 && chain.length > expectedCount)) {
          throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', `생성된 복합 문서의 ${label} 체인이 선언 범위를 넘습니다.`);
        }
        sector = fatEntry(sector);
      }
      if (expectedCount > 0 && chain.length !== expectedCount) {
        throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', `생성된 복합 문서의 ${label} 체인 길이가 선언값과 다릅니다.`);
      }
      for (const item of chain) occupiedChains.add(item);
      return chain;
    };
    const directoryChain = readChain(firstDirectorySector, majorVersion === 4 ? directorySectorCount : 0, '디렉터리');
    if (!directoryChain.length || directoryChain.length * sectorSize > MAX_CONVERTED_CFB_DIRECTORY_BYTES) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 디렉터리가 안전한 검사 범위를 벗어났습니다.');
    }
    if ((miniFatSectorCount === 0) !== (firstMiniFatSector === CFB_END_OF_CHAIN)) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 MiniFAT 정보가 서로 다릅니다.');
    }
    if (miniFatSectorCount > 0) readChain(firstMiniFatSector, miniFatSectorCount, 'MiniFAT');

    let rootEntries = 0;
    let streamEntries = 0;
    let directoryIndex = 0;
    for (const sector of directoryChain) {
      const bytes = await readConvertedCfbRangeExactly(handle, sectorSize, (sector + 1) * sectorSize);
      for (let offset = 0; offset + 128 <= bytes.length; offset += 128, directoryIndex += 1) {
        const type = bytes[offset + 66];
        if (type === 0) continue;
        const nameBytes = bytes.readUInt16LE(offset + 64);
        if (![1, 2, 5].includes(type) || nameBytes < 2 || nameBytes > 64 || nameBytes % 2 !== 0) {
          throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 디렉터리 항목이 올바르지 않습니다.');
        }
        let name = '';
        try {
          name = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(offset, offset + nameBytes - 2));
        } catch (error) {
          throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 디렉터리 이름이 손상되었습니다.', error);
        }
        if (type === 5) {
          rootEntries += 1;
          if (directoryIndex !== 0 || name !== 'Root Entry') {
            throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 루트 디렉터리가 올바르지 않습니다.');
          }
        } else if (type === 2) {
          streamEntries += 1;
        }
        const streamSize = bytes.readBigUInt64LE(offset + 120);
        const streamStart = bytes.readUInt32LE(offset + 116);
        if (majorVersion === 3 && (streamSize >> 32n) !== 0n) {
          throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 스트림 크기가 버전 범위를 벗어났습니다.');
        }
        if ((type === 5 || (type === 2 && streamSize >= 4096n)) && streamSize > 0n
          && !isConvertedCfbRegularSector(streamStart, sectorCount)) {
          throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서의 스트림 시작 위치가 올바르지 않습니다.');
        }
      }
    }
    if (rootEntries !== 1 || streamEntries < 1) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CFB_INVALID', '생성된 복합 문서에 루트 또는 문서 스트림이 없습니다.');
    }
    const finalStats = await handle.stat();
    if (!sameOutputFileStats(openedStats, finalStats)) {
      throw convertedCfbError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    return {
      structureChecked: true,
      sectorSize,
      sectorCount,
      directoryEntriesChecked: directoryIndex
    };
  } finally {
    await handle.close();
  }
}

async function inspectGeneratedPdf(filePath, initialStats, inspector = inspectPdfFile) {
  const inspected = await inspector(filePath);
  const finalStats = await fs.promises.stat(filePath);
  if (!sameOutputFileStats(initialStats, finalStats)
    || inspected.sourceBytes !== initialStats.size
    || inspected.sourceModifiedAt !== initialStats.mtimeMs
    || inspected.pageCount < 1) {
    throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 생성된 PDF가 바뀌어 저장을 중단했습니다.');
  }
  return inspected;
}

async function validateOutputFile(filePath, kind) {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile() || stats.size <= 0) throw new Error('변환 결과 파일이 비어 있습니다.');
  const handle = await fs.promises.open(filePath, 'r');
  const header = Buffer.alloc(8);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally { await handle.close(); }
  if (kind === 'pdf') {
    if (!validatePdf(header)) throw new Error('생성된 파일이 올바른 PDF가 아닙니다.');
    await inspectGeneratedPdf(filePath, stats);
  }
  if (kind === 'png' && !validatePng(header)) throw new Error('생성된 미리보기가 올바른 PNG가 아닙니다.');
  return stats;
}

async function validateConvertedOutputFile(
  filePath,
  extension,
  inspectPptx = inspectPptxFile,
  inspectPdf = inspectPdfFile
) {
  const normalized = DocumentConversion.safeOutputExtension(extension);
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile() || stats.size <= 0) throw new Error('변환 결과 파일이 비어 있습니다.');
  const handle = await fs.promises.open(filePath, 'r');
  let header;
  try {
    header = Buffer.alloc(8);
    await handle.read(header, 0, header.length, 0);
  } finally { await handle.close(); }

  let signature = '';
  let details = {};
  if (normalized === 'pdf') {
    if (!validatePdf(header)) throw new Error('생성된 파일이 올바른 PDF가 아닙니다.');
    const inspected = await inspectGeneratedPdf(filePath, stats, inspectPdf);
    signature = 'pdf';
    details = { ...details, pageCount: inspected.pageCount, structureChecked: true };
  } else if (ZIP_DOCUMENT_OUTPUT_EXTENSIONS.has(normalized)) {
    if (!header.subarray(0, 4).equals(ZIP_LOCAL_FILE_SIGNATURE)) {
      throw new Error(`생성된 파일이 올바른 ${normalized.toUpperCase()} 문서가 아닙니다.`);
    }
    const packageInfo = await inspectConvertedZipPackage(filePath, stats, normalized);
    signature = 'zip';
    details = {
      ...details,
      structureChecked: packageInfo.structureChecked === true,
      requiredEntriesChecked: packageInfo.requiredEntriesChecked,
      entryCount: packageInfo.entryCount,
      zip64: packageInfo.zip64
    };
    if (normalized === 'pptx') {
      if (stats.size <= MAX_DOCUMENT_FONT_INSPECTION_BYTES) {
        const inspected = await inspectPptx(filePath);
        details = { ...details, slideCount: Number(inspected?.slideCount) || 0 };
      } else {
        details = {
          ...details,
          slideCount: Number(packageInfo.slideCount) || 0,
          slideCountFromRelationships: packageInfo.slideCountFromRelationships === true
        };
      }
    }
  } else if (OLE_DOCUMENT_OUTPUT_EXTENSIONS.has(normalized)) {
    if (!header.equals(OLE_COMPOUND_FILE_SIGNATURE)) {
      throw new Error(`생성된 파일이 올바른 ${normalized.toUpperCase()} 문서가 아닙니다.`);
    }
    const inspected = await inspectConvertedCfbFile(filePath, stats);
    signature = 'ole-compound-file';
    details = { ...details, ...inspected };
  } else if (HANCOM_CELL_OUTPUT_EXTENSIONS.has(normalized)) {
    const ole = header.equals(OLE_COMPOUND_FILE_SIGNATURE);
    const zip = header.subarray(0, 4).equals(ZIP_LOCAL_FILE_SIGNATURE);
    if (!ole && !zip) throw new Error(`생성된 파일이 올바른 ${normalized.toUpperCase()} 문서가 아닙니다.`);
    if (ole) {
      const inspected = await inspectConvertedCfbFile(filePath, stats);
      signature = 'ole-compound-file';
      details = { ...details, ...inspected };
    } else {
      const inspected = await inspectConvertedZipIntegrity(filePath, stats);
      signature = 'zip';
      details = {
        ...details,
        structureChecked: inspected.structureChecked,
        entriesChecked: inspected.entriesChecked,
        entryCount: inspected.entryCount,
        zip64: inspected.zip64
      };
    }
  } else if (normalized === 'rtf' || normalized === 'csv') {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let prefix = '';
    try {
      for await (const chunk of fs.createReadStream(filePath)) {
        const text = decoder.decode(chunk, { stream: true });
        if (prefix.length < 32) prefix += text.slice(0, 32 - prefix.length);
      }
      const tail = decoder.decode();
      if (prefix.length < 32) prefix += tail.slice(0, 32 - prefix.length);
    } catch (_) {
      throw new Error(`생성된 ${normalized.toUpperCase()} 파일이 UTF-8이 아니어서 한글 깨짐을 막기 위해 저장을 중단했습니다.`);
    }
    if (prefix.includes('\u0000')) throw new Error(`생성된 ${normalized.toUpperCase()} 텍스트 형식이 올바르지 않습니다.`);
    if (normalized === 'rtf' && !prefix.replace(/^\uFEFF/, '').startsWith('{\\rtf')) {
      throw new Error('생성된 파일이 올바른 RTF 문서가 아닙니다.');
    }
    signature = normalized === 'rtf' ? 'rtf-utf8' : 'csv-utf8';
  } else {
    throw new Error('변환 결과 형식을 검증할 수 없습니다.');
  }
  return { ok: true, extension: normalized, bytes: stats.size, signature, ...details };
}

async function runLibreOfficeConversion(executable, inputPath, format, jobRoot) {
  const operationRoot = await fs.promises.mkdtemp(path.join(jobRoot, 'lo-'));
  const outputDirectory = path.join(operationRoot, 'output');
  const profileDirectory = path.join(operationRoot, 'profile');
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  await fs.promises.mkdir(profileDirectory, { recursive: true });
  const filter = format === 'pdf' ? 'pdf:impress_pdf_Export' : 'png:impress_png_Export';
  const profileUrl = pathToFileURL(profileDirectory).href;
  const result = await runProcess(executable, [
    '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--norestore', '--nolockcheck',
    `-env:UserInstallation=${profileUrl}`,
    '--convert-to', filter,
    '--outdir', outputDirectory,
    inputPath
  ], { timeoutMs: PROCESS_TIMEOUT_PER_ITEM_MS, cwd: path.dirname(executable), outputEncoding: windowsNativeOutputEncoding() });
  const expected = path.join(outputDirectory, `${path.parse(inputPath).name}.${format}`);
  if (result.code !== 0 || !fs.existsSync(expected)) {
    const detail = boundedText(result.stderr || result.stdout, 500);
    throw new Error(`LibreOffice가 ${format.toUpperCase()} 파일을 만들지 못했습니다.${detail ? ` ${detail}` : ''}`);
  }
  await validateOutputFile(expected, format);
  return expected;
}

async function runPowerPointOperation(operation, items, jobRoot, onProgress, options = {}) {
  const worker = powerPointWorkerPath();
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(worker) || !fs.existsSync(powershell)) throw new Error('PowerPoint 변환 도구를 찾을 수 없습니다.');
  const resultPath = path.join(jobRoot, `powerpoint-result-${crypto.randomUUID()}.json`);
  const jobPath = path.join(jobRoot, `powerpoint-job-${crypto.randomUUID()}.json`);
  const cancelPath = typeof options.isCancelled === 'function'
    ? path.join(jobRoot, `powerpoint-cancel-${crypto.randomUUID()}.signal`)
    : '';
  await fs.promises.writeFile(jobPath, JSON.stringify({ operation, resultPath, cancelPath, items }), 'utf8');
  let pending = '';
  const parseProgress = (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const marker = line.indexOf('CMOE_PROGRESS:');
      if (marker < 0) continue;
      try { onProgress?.(JSON.parse(line.slice(marker + 'CMOE_PROGRESS:'.length))); } catch (_) {}
    }
  };
  let cancellationTimer = null;
  let cancellationWriteStarted = false;
  const writeCancellationSignal = () => {
    if (!cancelPath || cancellationWriteStarted) return;
    cancellationWriteStarted = true;
    fs.promises.writeFile(cancelPath, 'cancelled', { flag: 'wx' }).catch((error) => {
      if (error?.code !== 'EEXIST') cancellationWriteStarted = false;
    });
  };
  const signalCancellation = () => {
    if (options.isCancelled?.()) writeCancellationSignal();
  };
  if (cancelPath) {
    signalCancellation();
    cancellationTimer = setInterval(signalCancellation, 250);
    cancellationTimer.unref?.();
  }
  let processResult;
  try {
    processResult = await runProcess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', worker, '-JobFile', jobPath
    ], {
      timeoutMs: Math.max(60_000, Number(options.timeoutMs) || items.length * PROCESS_TIMEOUT_PER_ITEM_MS),
      onStdout: parseProgress,
      onTimeout: cancelPath ? writeCancellationSignal : undefined,
      cooperativeTimeoutGraceMs: 30_000
    });
  } finally {
    if (cancellationTimer) clearInterval(cancellationTimer);
  }
  let payload = null;
  try { payload = JSON.parse(await fs.promises.readFile(resultPath, 'utf8')); } catch (_) {}
  if (!payload || (!payload.ok && !Array.isArray(payload.results))) {
    const detail = powerPointErrorMessage(payload?.fatalError || processResult.stderr || processResult.stdout);
    throw new Error(`PowerPoint를 실행하지 못했습니다.${detail ? ` ${detail}` : ''}`);
  }
  if (processResult.code !== 0 && payload.fatalError) throw new Error(`PowerPoint를 실행하지 못했습니다. ${powerPointErrorMessage(payload.fatalError)}`);
  return Array.isArray(payload.results) ? payload.results.map((item) => item?.ok ? item : { ...item, error: powerPointErrorMessage(item?.error) }) : [];
}

function nativeDocumentErrorMessage(value) {
  const code = String(value || '').trim();
  const messages = {
    HANCOM_SECURITY_MODULE_REGISTRY_MISSING: '한컴 한글 자동 변환 모듈의 사용자 등록 정보가 없습니다. 한컴 공식 오토메이션 안내를 확인해주세요.',
    HANCOM_SECURITY_MODULE_REGISTRY_TYPE_INVALID: '한컴 한글 자동 변환 모듈은 HKCU의 REG_SZ 절대 경로로 등록되어야 합니다.',
    HANCOM_SECURITY_MODULE_REGISTRY_AMBIGUOUS: '한컴 한글 자동 변환 모듈이 서로 다른 경로로 중복 등록되어 안전하게 선택할 수 없습니다.',
    HANCOM_SECURITY_MODULE_DISABLED: '한컴 한글 자동 변환 모듈이 Modules\\Uses에서 0으로 꺼져 있습니다.',
    HANCOM_SECURITY_MODULE_USES_TYPE_INVALID: '한컴 한글 자동 변환 모듈의 Modules\\Uses 값은 DWORD 형식이어야 합니다.',
    HANCOM_SECURITY_MODULE_FILE_INVALID: '한컴 한글 자동 변환 모듈 DLL 경로나 파일을 안전하게 확인하지 못했습니다.',
    HANCOM_SECURITY_MODULE_CHANGED: '확인 후 한컴 한글 자동 변환 모듈 DLL이 바뀌어 변환을 중단했습니다.',
    HANCOM_SECURITY_MODULE_REGISTER_FAILED: '한컴 한글이 보안 모듈을 불러오지 못했습니다. DLL과 Hwp.exe의 비트 구성이 같은지 확인해주세요.',
    HANCOM_SECURITY_MODULE_REGISTER_RETURNED_FALSE: '한컴 한글이 보안 모듈 등록을 승인하지 않아 문서 접근 창이 나타날 수 있으므로 변환을 중단했습니다.'
  };
  return messages[code] || boundedText(code, 500, '문서 변환 도구를 실행하지 못했습니다.');
}

async function runNativeDocumentConversion(engine, items, jobRoot, onProgress, options = {}) {
  const worker = nativeDocumentWorkerPath();
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(worker) || !fs.existsSync(powershell)) {
    const error = new Error('범용 문서 변환 도구를 찾을 수 없습니다.');
    error.code = 'DOCUMENT_CONVERSION_WORKER_MISSING';
    throw error;
  }
  const resultPath = path.join(jobRoot, `native-document-result-${crypto.randomUUID()}.json`);
  const jobPath = path.join(jobRoot, `native-document-job-${crypto.randomUUID()}.json`);
  const cancelPath = typeof options.isCancelled === 'function'
    ? path.join(jobRoot, `native-document-cancel-${crypto.randomUUID()}.signal`)
    : '';
  const hancomAutomationSecurity = engine === 'hancomWriter' && Array.isArray(items) && items.length
    ? options.hancomAutomationSecurity
    : null;
  if (engine === 'hancomWriter' && Array.isArray(items) && items.length
    && (!hancomAutomationSecurity || hancomAutomationSecurity.ready !== true
      || typeof hancomAutomationSecurity.moduleName !== 'string'
      || !hancomAutomationSecurity.moduleName || hancomAutomationSecurity.moduleName.length > 128
      || /[\\/\u0000-\u001f\u007f]/.test(hancomAutomationSecurity.moduleName)
      || !/^[a-f0-9]{64}$/i.test(String(hancomAutomationSecurity.moduleSha256 || '')))) {
    const error = new Error('한컴 한글 자동 변환에 필요한 공식 보안 모듈을 안전하게 확인하지 못했습니다.');
    error.code = 'HANCOM_SECURITY_MODULE_REQUIRED';
    throw error;
  }
  await fs.promises.writeFile(jobPath, JSON.stringify({
    engine,
    resultPath,
    cancelPath,
    items,
    ...(hancomAutomationSecurity ? {
      hancomSecurityModuleName: hancomAutomationSecurity.moduleName,
      hancomSecurityModuleSha256: hancomAutomationSecurity.moduleSha256
    } : {})
  }), 'utf8');

  let pending = '';
  const parseProgress = (chunk) => {
    pending += String(chunk || '');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const marker = line.indexOf('CMOE_PROGRESS:');
      if (marker < 0) continue;
      try { onProgress?.(JSON.parse(line.slice(marker + 'CMOE_PROGRESS:'.length))); } catch (_) {}
    }
  };
  let cancellationTimer = null;
  let cancellationWriteStarted = false;
  const writeCancellationSignal = () => {
    if (!cancelPath || cancellationWriteStarted) return;
    cancellationWriteStarted = true;
    fs.promises.writeFile(cancelPath, 'cancelled', { flag: 'wx' }).catch((error) => {
      if (error?.code !== 'EEXIST') cancellationWriteStarted = false;
    });
  };
  if (cancelPath) {
    const signalCancellation = () => { if (options.isCancelled?.()) writeCancellationSignal(); };
    signalCancellation();
    cancellationTimer = setInterval(signalCancellation, 250);
    cancellationTimer.unref?.();
  }

  let processResult;
  try {
    processResult = await runProcess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', worker, '-JobFile', jobPath
    ], {
      timeoutMs: Math.max(60_000, Number(options.timeoutMs) || items.length * PROCESS_TIMEOUT_PER_ITEM_MS),
      onStdout: parseProgress,
      onTimeout: cancelPath ? writeCancellationSignal : undefined,
      cooperativeTimeoutGraceMs: 30_000
    });
  } finally {
    if (cancellationTimer) clearInterval(cancellationTimer);
  }
  let payload = null;
  try { payload = JSON.parse(await fs.promises.readFile(resultPath, 'utf8')); } catch (_) {}
  if (!payload || (!payload.ok && !Array.isArray(payload.results))) {
    const detail = nativeDocumentErrorMessage(payload?.fatalError || processResult.stderr || processResult.stdout);
    const error = new Error(`문서 변환 도구를 실행하지 못했습니다.${detail ? ` ${detail}` : ''}`);
    error.code = 'DOCUMENT_CONVERSION_WORKER_FAILED';
    throw error;
  }
  if (processResult.code !== 0 && payload.fatalError) {
    const error = new Error(`문서 변환 도구를 실행하지 못했습니다. ${nativeDocumentErrorMessage(payload.fatalError)}`);
    error.code = 'DOCUMENT_CONVERSION_WORKER_FAILED';
    throw error;
  }
  return Array.isArray(payload.results)
    ? payload.results.map((item) => item?.ok ? item : { ...item, error: nativeDocumentErrorMessage(item?.error) })
    : [];
}

function parseDelimitedText(source, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"' && !cell) { quoted = true; continue; }
    if (character === delimiter) { row.push(cell); cell = ''; continue; }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
      continue;
    }
    cell += character;
  }
  row.push(cell);
  if (row.some((value) => value !== '') || !rows.length) rows.push(row);
  return rows;
}

function normalizeImportedMatrix(matrix) {
  const rows = [];
  let cells = 0;
  for (const sourceRow of Array.isArray(matrix) ? matrix : []) {
    const row = (Array.isArray(sourceRow) ? sourceRow : []).slice(0, MAX_CERTIFICATE_FIELDS).map((value) => String(value ?? '').slice(0, 4_000));
    while (row.length && !row.at(-1)) row.pop();
    if (!row.some((value) => value.trim())) continue;
    cells += row.length;
    if (cells > MAX_IMPORTED_CELLS || rows.length >= MAX_CERTIFICATE_ROWS) throw new Error('가져올 데이터가 너무 많습니다. 2,000행·20만 셀 이하로 나눠주세요.');
    rows.push(row);
  }
  return rows;
}

class DocumentTools {
  constructor(options = {}) {
    this.dialog = options.dialog;
    this.shell = options.shell;
    this.userDataPath = path.resolve(options.userDataPath);
    this.templatesRoot = path.join(this.userDataPath, 'document-tools', 'templates');
    this.storage = new JsonStorage(path.join(this.userDataPath, 'document-tools', 'document-tools-data.json'));
    this.tokens = new Map();
    this.ownerTokens = new Map();
    this.ownerCleanup = new Set();
    this.activeJobs = new Map();
    this.operationChain = Promise.resolve();
    this.inFlightUserFontCommits = new Set();
    this.acceptingUserFontCommits = true;
    this.cachedCapabilities = null;
    this.cachedInstalledFonts = null;
    this.hancomAutomationSecurity = null;
    this.localAppDataPath = typeof options.localAppDataPath === 'string' && path.isAbsolute(options.localAppDataPath)
      ? path.resolve(options.localAppDataPath)
      : (typeof process.env.LOCALAPPDATA === 'string' && path.isAbsolute(process.env.LOCALAPPDATA)
        ? path.resolve(process.env.LOCALAPPDATA)
        : '');
    this.userFontFileInstaller = options.userFontFileInstaller || null;
    this.runPowerPointOperation = options.runPowerPointOperation || runPowerPointOperation;
    this.runLibreOfficeConversion = options.runLibreOfficeConversion || runLibreOfficeConversion;
    this.runNativeDocumentConversion = options.runNativeDocumentConversion || runNativeDocumentConversion;
    this.runProcess = options.runProcess || runProcess;
    this.validateConvertedOutputFile = options.validateConvertedOutputFile || validateConvertedOutputFile;
    this.inspectDocumentFonts = typeof options.inspectDocumentFonts === 'function'
      ? options.inspectDocumentFonts
      : inspectDocumentFontsDefault;
    const rhwpInspector = options.documentRhwpInspector || createDocumentRhwpInspector({
      userDataPath: this.userDataPath,
      runner: options.runRhwpInspector
    });
    this.inspectHwpFonts = typeof options.inspectHwpFonts === 'function'
      ? options.inspectHwpFonts
      : (typeof options.inspectDocumentFonts === 'function'
        ? options.inspectDocumentFonts
        : rhwpInspector.inspectDocumentFonts);
    this.probeDocumentApplications = options.probeDocumentApplications || probeDocumentApplications;
    this.probeDocumentRunningProcesses = options.probeDocumentRunningProcesses || runningDocumentProcesses;
    this.findLibreOfficePath = options.findLibreOfficePath || findLibreOfficePath;
    this.dependencyManifest = options.dependencyManifest && typeof options.dependencyManifest === 'object'
      ? options.dependencyManifest
      : DEFAULT_DOCUMENT_DEPENDENCY_MANIFEST;
    this.dependencyInstaller = options.dependencyInstaller || null;
    this.mergePdfFiles = options.mergePdfFiles || mergePdfFiles;
    this.inspectNativeOfficeFiles = options.inspectNativeOfficeFiles || NativeOfficeMerge.inspectNativeOfficeFiles;
    this.mergeNativeOfficeFiles = options.mergeNativeOfficeFiles || NativeOfficeMerge.mergeNativeOfficeFiles;
    this.mergeExcelFilesWithLibreOffice = options.mergeExcelFilesWithLibreOffice
      || LibreOfficeExcelMerge.mergeExcelFilesWithLibreOffice;
    this.inspectInternalExcelWorkbook = options.inspectInternalExcelWorkbook
      || InternalExcelMerge.inspectInternalExcelWorkbook;
    this.mergeExcelFilesInternally = options.mergeExcelFilesInternally
      || InternalExcelMerge.mergeExcelFilesInternally;
    this.analyzeExcelDuplicates = options.analyzeExcelDuplicates || ExcelDeduplicate.analyzeExcelDuplicates;
    this.deduplicateExcelWorkbook = options.deduplicateExcelWorkbook || ExcelDeduplicate.deduplicateExcelWorkbook;
    this.inspectExcelCompareFile = options.inspectExcelCompareFile || ExcelCompareGroup.inspectExcelCompareFile;
    this.analyzeExcelCompareGroups = options.analyzeExcelCompareGroups || ExcelCompareGroup.analyzeExcelCompareGroups;
    this.compareAndGroupExcelFiles = options.compareAndGroupExcelFiles || ExcelCompareGroup.compareAndGroupExcelFiles;
    this.inspectXlsxWorkbookStructure = options.inspectXlsxWorkbookStructure || inspectXlsxWorkbookStructure;
    this.splitPdfFile = options.splitPdfFile || splitPdfFile;
    this.splitPptxFile = options.splitPptxFile || splitPptxFile;
    this.inspectDocumentSplitFileSystemCapacity = options.inspectDocumentSplitFileSystemCapacity
      || inspectDocumentSplitFileSystemCapacity;
    this.inspectDocumentSplitOutputDirectoryIdentity = options.inspectDocumentSplitOutputDirectoryIdentity
      || inspectDocumentSplitOutputDirectoryIdentity;
    this.removeDocumentSplitJobDirectory = options.removeDocumentSplitJobDirectory || removeGeneratedDirectory;
    this.inspectPdfFile = options.inspectPdfFile || inspectPdfFile;
    this.inspectPptxFile = options.inspectPptxFile || inspectPptxFile;
    this.sourcePreviewCache = new Map();
    this.sourcePreviewCacheBytes = 0;
    const configuredPreviewCacheBytes = Number(options.sourcePreviewCacheBytes);
    this.sourcePreviewCacheLimitBytes = Number.isFinite(configuredPreviewCacheBytes) && configuredPreviewCacheBytes > 0
      ? Math.min(MAX_SOURCE_PREVIEW_CACHE_BYTES, Math.floor(configuredPreviewCacheBytes))
      : MAX_SOURCE_PREVIEW_CACHE_BYTES;
  }

  async installedFontFamilies() {
    if (Array.isArray(this.cachedInstalledFonts)) return this.cachedInstalledFonts.slice();
    if (process.platform !== 'win32') return [];
    const reg = windowsSystemExecutable('reg.exe');
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
    ];
    const registryOutputs = fs.existsSync(reg) ? await Promise.all(keys.map(async (key) => {
      try {
        const result = await this.runProcess(reg, ['query', key], { timeoutMs: 10_000, outputEncoding: windowsNativeOutputEncoding() });
        return result.code === 0 ? result.stdout : '';
      } catch (_) { return ''; }
    })) : [];
    const powershell = windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe');
    let collectionOutput = '';
    let collectionChecked = false;
    if (fs.existsSync(powershell)) {
      try {
        const result = await this.runProcess(powershell, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', WINDOWS_FONT_COLLECTION_SCRIPT
        ], { timeoutMs: 15_000, outputEncoding: 'utf-8', shell: false });
        if (result.code === 0) {
          collectionOutput = result.stdout;
          collectionChecked = true;
        }
      } catch (_) {}
    }
    const families = []; const seen = new Set();
    // Registry entries can exist before GDI/Office can actually use the font.
    // When the runtime collection probe succeeds it is authoritative; the
    // registry remains only a compatibility fallback if that probe is absent.
    const detectedFamilies = collectionChecked
      ? parseWindowsInstalledFontCollection(collectionOutput)
      : registryOutputs.flatMap(parseWindowsFontRegistry);
    for (const family of detectedFamilies) {
      const key = normalizeFontKey(family); if (!key || seen.has(key)) continue;
      seen.add(key); families.push(family);
    }
    this.cachedInstalledFonts = families;
    return families.slice();
  }

  async fontReport(inspected) {
    const usedFonts = Array.isArray(inspected?.usedFonts) ? inspected.usedFonts.slice(0, 200) : [];
    const embeddedFonts = Array.isArray(inspected?.embeddedFonts) ? inspected.embeddedFonts.slice(0, 200) : [];
    const installedFonts = await this.installedFontFamilies();
    const checked = installedFonts.length > 0;
    const embeddedKeys = new Set(embeddedFonts.map(baseFontKey).filter(Boolean));
    return {
      usedFonts,
      embeddedFonts,
      missingFonts: checked
        ? missingFontFamilies(usedFonts, embeddedFonts, installedFonts)
        : usedFonts.filter((font) => !embeddedKeys.has(baseFontKey(font))),
      checked
    };
  }

  async sourcePreviewCacheKey(filePath, stats, slideNumber, engine) {
    const identity = [
      process.platform === 'win32' ? path.resolve(filePath).toLocaleLowerCase('en-US') : path.resolve(filePath),
      Number(stats.size),
      Number(stats.mtimeMs),
      Number(stats.ctimeMs),
      Number(slideNumber),
      String(engine)
    ];
    return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  cachedSourcePreview(cacheKey) {
    const preview = this.sourcePreviewCache.get(cacheKey);
    if (!preview) return null;
    this.sourcePreviewCache.delete(cacheKey);
    this.sourcePreviewCache.set(cacheKey, preview);
    return preview;
  }

  cacheSourcePreview(cacheKey, preview) {
    if (!cacheKey || !Buffer.isBuffer(preview?.image) || preview.image.length > this.sourcePreviewCacheLimitBytes) return;
    const prior = this.sourcePreviewCache.get(cacheKey);
    if (prior) {
      this.sourcePreviewCacheBytes -= prior.image.length;
      this.sourcePreviewCache.delete(cacheKey);
    }
    this.sourcePreviewCache.set(cacheKey, preview);
    this.sourcePreviewCacheBytes += preview.image.length;
    while (this.sourcePreviewCacheBytes > this.sourcePreviewCacheLimitBytes && this.sourcePreviewCache.size) {
      const oldestKey = this.sourcePreviewCache.keys().next().value;
      const oldest = this.sourcePreviewCache.get(oldestKey);
      this.sourcePreviewCache.delete(oldestKey);
      this.sourcePreviewCacheBytes -= oldest?.image?.length || 0;
    }
  }

  registerOwner(webContents) {
    const ownerId = webContents.id;
    if (this.ownerCleanup.has(ownerId)) return ownerId;
    this.ownerCleanup.add(ownerId);
    webContents.once('destroyed', () => this.releaseOwner(ownerId));
    return ownerId;
  }

  issueToken(ownerId, kind, filePath, metadata = {}, options = {}) {
    const current = this.ownerTokens.get(ownerId) || new Set();
    const resolvedPath = path.resolve(filePath);
    if (options.reuse !== false) {
      for (const existingToken of current) {
        const existing = this.tokens.get(existingToken);
        if (existing?.ownerId === ownerId && existing.kind === kind && existing.filePath === resolvedPath) return existingToken;
      }
    }
    if (current.size >= MAX_OWNER_TOKENS) throw new Error('이 창에서 선택한 파일이 너무 많습니다. 창을 닫고 다시 시도해주세요.');
    const token = crypto.randomUUID();
    this.tokens.set(token, { ownerId, kind, filePath: resolvedPath, metadata });
    current.add(token); this.ownerTokens.set(ownerId, current);
    return token;
  }

  resolveToken(ownerId, token, kind) {
    if (!TOKEN_PATTERN.test(String(token || ''))) throw new Error('파일 선택 정보가 올바르지 않습니다.');
    const entry = this.tokens.get(String(token));
    if (!entry || entry.ownerId !== ownerId || entry.kind !== kind) throw new Error('파일을 다시 선택해주세요.');
    return entry;
  }

  revokeToken(ownerId, token) {
    const key = String(token || '');
    const entry = this.tokens.get(key);
    if (!entry || entry.ownerId !== ownerId) return false;
    this.tokens.delete(key);
    const owned = this.ownerTokens.get(ownerId);
    owned?.delete(key);
    if (owned && !owned.size) this.ownerTokens.delete(ownerId);
    return true;
  }

  releaseOwner(ownerId) {
    for (const job of this.activeJobs.values()) {
      if (job.ownerId !== ownerId) continue;
      job.ownerReleased = true;
      if (job.status !== 'committing') job.cancelled = true;
    }
    const tokens = this.ownerTokens.get(ownerId) || [];
    for (const token of tokens) this.tokens.delete(token);
    this.ownerTokens.delete(ownerId); this.ownerCleanup.delete(ownerId);
  }

  async capabilities(refresh = false) {
    if (refresh) {
      this.cachedInstalledFonts = null;
      this.hancomAutomationSecurity = null;
    }
    if (this.cachedCapabilities && !refresh) {
      const running = await this.probeDocumentRunningProcesses();
      return this.capabilitiesWithRunning(this.cachedCapabilities, running);
    }
    const [probed, running] = await Promise.all([
      this.probeDocumentApplications(),
      this.probeDocumentRunningProcesses()
    ]);
    const rawDependencies = probed?.dependencies && typeof probed.dependencies === 'object'
      ? probed.dependencies
      : (probed || {});
    const rawHancomAutomationSecurity = rawDependencies.hancomWriter?.automationSecurity;
    this.hancomAutomationSecurity = rawDependencies.hancomWriter?.available === true
      && rawHancomAutomationSecurity?.ready === true
      && typeof rawHancomAutomationSecurity.moduleName === 'string'
      && rawHancomAutomationSecurity.moduleName.length > 0
      && /^[a-f0-9]{64}$/i.test(String(rawHancomAutomationSecurity.moduleSha256 || ''))
      ? Object.freeze({
        ready: true,
        moduleName: rawHancomAutomationSecurity.moduleName,
        moduleSha256: String(rawHancomAutomationSecurity.moduleSha256).toLowerCase()
      })
      : null;
    const detected = {};
    const availability = {};
    for (const dependencyId of DocumentConversion.DEPENDENCY_IDS) {
      const raw = rawDependencies[dependencyId];
      const registered = raw === true || Boolean(raw && typeof raw === 'object' && (raw.registered === true || raw.available === true));
      const available = raw === true || Boolean(raw && typeof raw === 'object' && raw.available === true);
      const metadata = DocumentConversion.DEPENDENCY_METADATA[dependencyId];
      detected[dependencyId] = {
        dependencyId,
        engine: metadata.engine,
        label: metadata.label,
        registered,
        available,
        running: Boolean(raw && typeof raw === 'object' && raw.running === true) || Boolean(running?.[dependencyId]),
        ...(raw && typeof raw === 'object' && typeof raw.reasonCode === 'string' ? { reasonCode: boundedText(raw.reasonCode, 96) } : {}),
        ...(raw && typeof raw === 'object' && ['x86', 'x64', 'unknown'].includes(raw.applicationArchitecture)
          ? { applicationArchitecture: raw.applicationArchitecture }
          : {}),
        ...(dependencyId === 'hancomWriter' && raw?.automationSecurity && typeof raw.automationSecurity === 'object'
          ? { automationSecurity: {
            ready: raw.automationSecurity.ready === true,
            reasonCode: boundedText(raw.automationSecurity.reasonCode, 96),
            moduleArchitecture: ['x86', 'x64'].includes(raw.automationSecurity.moduleArchitecture)
              ? raw.automationSecurity.moduleArchitecture
              : 'unknown',
            applicationArchitecture: ['x86', 'x64'].includes(raw.automationSecurity.applicationArchitecture)
              ? raw.automationSecurity.applicationArchitecture
              : 'unknown'
          } }
          : {})
      };
      availability[dependencyId] = detected[dependencyId];
    }
    const libreOfficePath = this.findLibreOfficePath();
    const preparationPlan = DocumentDependencies.planDocumentDependencies({
      platform: process.platform,
      architecture: process.arch,
      requiredApplications: [...DocumentConversion.DEPENDENCY_IDS, 'libreOffice', 'rhwp'],
      availability: { ...availability, libreOffice: Boolean(libreOfficePath), rhwp: false }
    }, this.dependencyManifest);
    const preparationById = new Map(preparationPlan.applications.map((item) => [item.id, item]));
    for (const dependencyId of DocumentConversion.DEPENDENCY_IDS) {
      detected[dependencyId].preparation = detected[dependencyId].available
        ? null
        : preparationById.get(dependencyId)?.preparation || 'unavailable';
    }
    const status = {
      dependencies: detected,
      powerPoint: detected.officePowerPoint.available,
      word: detected.officeWord.available,
      excel: detected.officeExcel.available,
      hancomWriter: detected.hancomWriter.available,
      hancomCell: detected.hancomCell.available,
      libreOffice: Boolean(libreOfficePath),
      libreOfficePath,
      compatibleFallbacks: {
        libreOffice: {
          available: Boolean(libreOfficePath),
          preparation: preparationById.get('libreOffice')?.preparation || null
        },
        rhwp: {
          available: false,
          preparation: preparationById.get('rhwp')?.preparation || 'unavailable'
        }
      },
      engine: ''
    };
    const withRunning = this.capabilitiesWithRunning(status, running);
    this.cachedCapabilities = withRunning;
    return withRunning;
  }

  capabilitiesWithRunning(status, running = {}) {
    const dependencies = Object.fromEntries(DocumentConversion.DEPENDENCY_IDS.map((dependencyId) => [
      dependencyId,
      {
        ...(status.dependencies?.[dependencyId] || {}),
        running: Boolean(running?.[dependencyId] ?? status.dependencies?.[dependencyId]?.running)
      }
    ]));
    const next = {
      ...status,
      dependencies,
      powerPointRunning: dependencies.officePowerPoint.running,
      wordRunning: dependencies.officeWord.running,
      excelRunning: dependencies.officeExcel.running,
      hancomWriterRunning: dependencies.hancomWriter.running,
      hancomCellRunning: dependencies.hancomCell.running
    };
    next.engine = this.chooseEngine(next, next.powerPointRunning);
    return next;
  }

  async publicCapabilities(refresh = false) {
    const status = await this.capabilities(refresh);
    const { libreOfficePath: _privateLibreOfficePath, ...safe } = status;
    const certificatePdfAvailable = Boolean(status.powerPoint && !status.powerPointRunning);
    return {
      ...safe,
      conversionCatalog: DocumentConversion.getConversionCatalog(),
      certificatePdfEngine: certificatePdfAvailable ? 'powerpoint' : '',
      certificatePdfAvailable,
      certificatePdf: {
        engine: 'powerpoint',
        strict: true,
        available: certificatePdfAvailable,
        blocked: !certificatePdfAvailable,
        running: Boolean(status.powerPointRunning),
        preparation: status.dependencies?.officePowerPoint?.preparation || null,
        compatiblePreviewAvailable: Boolean(status.libreOffice)
      }
    };
  }

  getDependencyInstaller() {
    if (this.dependencyInstaller) return this.dependencyInstaller;
    let installerModule;
    try { installerModule = require('./document-dependency-installer'); }
    catch (_) { return null; }
    if (typeof installerModule.createDocumentDependencyInstaller !== 'function') return null;
    this.dependencyInstaller = installerModule.createDocumentDependencyInstaller({
      shell: this.shell,
      fs,
      userDataPath: this.userDataPath
    });
    return this.dependencyInstaller;
  }

  getUserFontFileInstaller() {
    if (this.userFontFileInstaller) return this.userFontFileInstaller;
    if (process.platform !== 'win32' || !this.localAppDataPath) return null;
    let installerModule;
    try { installerModule = require('./user-font-file-installer'); }
    catch (_) { return null; }
    if (typeof installerModule.createUserFontFileInstaller !== 'function') return null;
    this.userFontFileInstaller = installerModule.createUserFontFileInstaller({
      fs,
      localAppData: this.localAppDataPath,
      platform: process.platform
    });
    return this.userFontFileInstaller;
  }

  chooseEngine(status, powerPointRunning = status.powerPointRunning) {
    if (status.powerPoint && !powerPointRunning) return 'powerpoint';
    if (status.libreOffice) return 'libreoffice';
    return '';
  }

  async selectedEngine() {
    const status = await this.capabilities();
    if (status.engine) return { engine: status.engine, status };
    if (status.powerPoint && status.powerPointRunning) throw new Error('열려 있는 PowerPoint를 닫은 뒤 다시 시도해주세요. 작업 중인 PowerPoint를 보호하기 위해 자동 변환을 시작하지 않았습니다.');
    throw new Error('PDF 변환을 위해 Microsoft PowerPoint 또는 LibreOffice가 필요합니다. PPTX만 만드는 템플릿 문서 작업은 계속 사용할 수 있습니다.');
  }

  async selectedNativePowerPointEngine() {
    const status = await this.capabilities();
    if (status.powerPointRunning) {
      throw new Error('열려 있는 PowerPoint를 닫은 뒤 다시 시도해주세요. 작업 중인 문서를 보호하기 위해 PDF 생성을 시작하지 않았습니다.');
    }
    if (!status.powerPoint) {
      throw new Error('글꼴·배치·서명을 온전히 유지한 최종 PDF에는 Microsoft PowerPoint가 필요합니다. PPTX만 생성하거나 호환 미리보기는 계속 사용할 수 있습니다.');
    }
    return { engine: 'powerpoint', status };
  }

  async assertExactFontsAvailable(inspected, contextLabel = '원본 문서') {
    const report = await this.fontReport(inspected);
    const embeddedKeys = new Set(report.embeddedFonts.map(baseFontKey).filter(Boolean));
    const missingFonts = report.checked
      ? report.missingFonts
      : report.usedFonts.filter((font) => !embeddedKeys.has(baseFontKey(font)));
    if (missingFonts.length) {
      const names = missingFonts.slice(0, 8).map((family) => boundedText(family, 128)).filter(Boolean);
      const suffix = missingFonts.length > names.length ? ` 외 ${missingFonts.length - names.length}개` : '';
      const error = new Error(`${contextLabel}에 필요한 정확한 글꼴을 찾지 못했습니다: ${names.join(' · ')}${suffix}. 임의 글꼴로 대체하지 않고 PDF 생성을 중단했습니다.`);
      error.code = 'DOCUMENT_EXACT_FONT_REQUIRED';
      throw error;
    }
    return { ...report, missingFonts: [] };
  }

  async certificatePdfReadiness(inspected, suppliedStatus = null) {
    const [status, fontReport] = await Promise.all([
      suppliedStatus || this.capabilities(),
      this.fontReport(inspected)
    ]);
    const powerpoint = DocumentConversion.getDependencyAvailability('officePowerPoint', status);
    const runningDependencies = status.powerPointRunning || status.dependencies?.officePowerPoint?.running
      ? ['officePowerPoint']
      : [];
    const requiredFonts = [...fontReport.missingFonts];
    const missingDependencies = powerpoint.blocked ? [powerpoint] : [];
    const blocked = missingDependencies.length > 0 || runningDependencies.length > 0 || requiredFonts.length > 0;
    const preparationPlan = missingDependencies.length || requiredFonts.length
      ? this.dependencyPreparationForRoutes(
        [{ requiredDependency: 'officePowerPoint' }],
        status,
        requiredFonts
      )
      : null;
    return {
      engine: 'powerpoint',
      strict: true,
      available: !blocked,
      ready: !blocked,
      blocked,
      requiredDependencies: ['officePowerPoint'],
      missingDependencies,
      runningDependencies,
      requiredFonts,
      fontReport,
      preparationPlan,
      compatiblePreviewAvailable: Boolean(status.libreOffice),
      compatiblePreviewEngine: status.libreOffice ? 'libreoffice' : null
    };
  }

  async choosePptxFiles(ownerId, parentWindow) {
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: 'PDF로 바꿀 PowerPoint 파일 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PowerPoint PPTX', extensions: ['pptx'] }]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true, files: [] };
    if (result.filePaths.length > MAX_BATCH_FILES) throw new Error('한 번에 500개 파일까지 변환할 수 있습니다. 나눠서 선택해주세요.');
    const files = [];
    for (const filePath of result.filePaths) {
      const extension = path.extname(filePath).toLowerCase();
      if (extension !== '.pptx') continue;
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile() || stats.size > MAX_PPTX_BYTES) throw new Error(`${path.basename(filePath)} 파일은 128MB 이하만 사용할 수 있습니다.`);
      await inspectPptxFile(filePath);
      files.push({ token: this.issueToken(ownerId, 'pptx-input', filePath), key: crypto.createHash('sha256').update(path.resolve(filePath).toLocaleLowerCase('en-US')).digest('hex'), name: path.basename(filePath), bytes: stats.size });
    }
    return { canceled: false, files };
  }

  documentConversionFileKey(filePath) {
    const normalizedPath = process.platform === 'win32'
      ? path.resolve(filePath).toLocaleLowerCase('en-US')
      : path.resolve(filePath);
    return crypto.createHash('sha256').update(normalizedPath).digest('hex');
  }

  async chooseDocumentConversionFiles(ownerId, parentWindow, payload = {}) {
    const sourceExtensions = normalizeDocumentConversionSourceExtensions(payload);
    const sourceLabel = documentConversionSourceSelectionLabel(sourceExtensions);
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: `변환 원본 선택 · ${sourceLabel}`,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: sourceLabel, extensions: [...sourceExtensions] }]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true, files: [], targets: [] };
    if (result.filePaths.length > MAX_BATCH_FILES) {
      throw new Error('한 번에 500개 파일까지 변환할 수 있습니다. 나눠서 선택해주세요.');
    }

    // Native dialogs can still be bypassed by typing a file name directly.
    // Validate every selected extension before issuing any capability token so
    // a mixed or stale selection cannot partially enter the conversion job.
    const selectedFiles = result.filePaths.map((filePath) => ({
      filePath,
      metadata: DocumentConversion.getFormatMetadata(filePath)
    }));
    const mismatches = selectedFiles.filter(({ metadata }) => (
      !metadata?.source || !sourceExtensions.includes(metadata.extension)
    ));
    if (mismatches.length) {
      const names = mismatches.slice(0, 3).map(({ filePath }) => path.basename(filePath)).join(', ');
      const more = mismatches.length > 3 ? ` 외 ${mismatches.length - 3}개` : '';
      throw documentConversionSelectionError(
        'DOCUMENT_CONVERSION_SOURCE_MISMATCH',
        `${names}${more}은(는) 선택한 변환 원본 형식(${sourceLabel})과 다릅니다. 형식에 맞는 파일만 다시 선택해주세요.`
      );
    }

    for (const selected of selectedFiles) {
      selected.stats = await assertDocumentSourceFile(selected.filePath, selected.metadata.extension);
    }

    const files = [];
    for (const { filePath, metadata, stats } of selectedFiles) {
      const token = this.issueToken(ownerId, DOCUMENT_CONVERSION_INPUT_KIND, filePath, {
        name: path.basename(filePath),
        bytes: stats.size,
        modifiedAt: stats.mtimeMs,
        extension: metadata.extension,
        group: metadata.group,
        key: this.documentConversionFileKey(filePath)
      });
      files.push({
        token,
        key: this.documentConversionFileKey(filePath),
        name: path.basename(filePath),
        bytes: stats.size,
        extension: metadata.extension,
        group: metadata.group,
        targets: DocumentConversion.getTargetsForSource(metadata.extension)
      });
    }
    if (!files.length) throw new Error('지원하는 문서 파일을 선택해주세요.');
    const targetExtensions = DocumentConversion.getCommonTargets(files.map((item) => item.extension));
    return {
      canceled: false,
      files,
      targetExtensions,
      targets: targetExtensions.map((extension) => DocumentConversion.getFormatMetadata(extension))
    };
  }

  resolveDocumentConversionInputs(ownerId, payload = {}, tokenKind = DOCUMENT_CONVERSION_INPUT_KIND) {
    const fileTokens = Array.isArray(payload.fileTokens)
      ? [...new Set(payload.fileTokens.map((item) => String(item?.token || item || '')))]
      : [];
    if (!fileTokens.length || fileTokens.length > MAX_BATCH_FILES) {
      throw new Error('변환할 문서를 1개 이상, 500개 이하로 선택해주세요.');
    }
    return fileTokens.map((token) => {
      const entry = this.resolveToken(ownerId, token, tokenKind);
      const extension = DocumentConversion.normalizeExtension(entry.filePath);
      if (!DocumentConversion.getFormatMetadata(extension)?.source) throw new Error('지원하지 않는 원본 문서 형식입니다.');
      return { token, entry, extension };
    });
  }

  async documentFontRequirements(inputs) {
    const reports = [];
    const requiredFonts = [];
    const seenRequired = new Set();
    const inspectorRequiredDependencies = [];
    const seenInspectorDependencies = new Set();
    for (const input of inputs) {
      // Capabilities are long-lived, so the source can be replaced after it was
      // first selected. Recheck the same per-format limit immediately before
      // an inspector can read the complete archive into memory.
      await assertDocumentSourceFile(input.entry.filePath, input.extension);
      let report = { usedFonts: [], embeddedFonts: [], missingFonts: [], checked: false };
      let inspectionChecked = false;
      let inspectionSupported = false;
      let inspectionReasonCode = '';
      let inspected = null;
      if (input.extension === 'pptx') {
        inspected = await this.inspectPptxFile(input.entry.filePath);
        report = await this.fontReport(inspected);
        inspectionChecked = true;
        inspectionSupported = true;
      } else {
        const inspector = input.extension === 'hwp' ? this.inspectHwpFonts : this.inspectDocumentFonts;
        if (typeof inspector === 'function') {
          inspected = await inspector(input.entry.filePath, input.extension);
          const usedFonts = Array.isArray(inspected?.usedFonts) ? inspected.usedFonts.slice(0, 200).map(String) : [];
          const embeddedFonts = Array.isArray(inspected?.embeddedFonts) ? inspected.embeddedFonts.slice(0, 200).map(String) : [];
          const installedFonts = usedFonts.length ? await this.installedFontFamilies() : [];
          inspectionChecked = inspected?.checked !== false;
          inspectionSupported = inspected?.supported !== false;
          inspectionReasonCode = boundedText(inspected?.reasonCode, 100);
          report = {
            usedFonts,
            embeddedFonts,
            missingFonts: Array.isArray(inspected?.missingFonts)
              ? inspected.missingFonts.slice(0, 200).map(String)
              : missingFontFamilies(usedFonts, embeddedFonts, installedFonts),
            checked: inspected?.checked !== false && installedFonts.length > 0
          };
        } else {
          inspectionReasonCode = 'FONT_INSPECTOR_UNAVAILABLE';
        }
      }
      const requestedInspectorDependencies = [
        inspected?.requiredDependency,
        ...(Array.isArray(inspected?.requiredDependencies) ? inspected.requiredDependencies : [])
      ].map((dependencyId) => String(dependencyId || '').trim()).filter((dependencyId) => (
        DocumentDependencies.DEPENDENCY_IDS.includes(dependencyId)
      ));
      for (const dependencyId of requestedInspectorDependencies) {
        if (seenInspectorDependencies.has(dependencyId)) continue;
        seenInspectorDependencies.add(dependencyId);
        inspectorRequiredDependencies.push(dependencyId);
      }
      const missing = report.checked
        ? report.missingFonts
        : report.usedFonts.filter((font) => !new Set(report.embeddedFonts.map(baseFontKey)).has(baseFontKey(font)));
      for (const family of missing) {
        const safeFamily = boundedText(family, 128);
        const key = baseFontKey(safeFamily) || safeFamily.normalize('NFKC').toLocaleLowerCase('en-US');
        if (!safeFamily || seenRequired.has(key)) continue;
        seenRequired.add(key);
        requiredFonts.push(safeFamily);
      }
      reports.push({
        token: input.token,
        name: path.basename(input.entry.filePath),
        extension: input.extension,
        usedFonts: report.usedFonts,
        embeddedFonts: report.embeddedFonts,
        missingFonts: missing,
        checked: report.checked,
        inspectionChecked,
        inspectionSupported,
        inspectionUnavailable: !inspectionChecked || !inspectionSupported,
        reasonCode: inspectionReasonCode || null,
        inspectorRequiredDependencies: requestedInspectorDependencies
      });
    }
    const inspectionUnavailable = reports.filter((report) => report.inspectionUnavailable).map((report) => ({
      token: report.token,
      name: report.name,
      extension: report.extension,
      reasonCode: report.reasonCode,
      requiredDependencies: report.inspectorRequiredDependencies
    }));
    return {
      reports,
      requiredFonts,
      inspectorRequiredDependencies,
      inspectionUnavailable,
      requiresPreview: inspectionUnavailable.length > 0
    };
  }

  documentInspectorDependencyAvailability(dependencyId, status = {}) {
    const raw = status.dependencies?.[dependencyId] ?? status.compatibleFallbacks?.[dependencyId];
    const available = raw === true || Boolean(raw && typeof raw === 'object' && (
      raw.available === true || raw.registered === true || raw.installed === true
    ));
    const labels = { rhwp: 'rHWP 문서 검사기', libreOffice: 'LibreOffice' };
    return {
      dependencyId,
      engine: dependencyId,
      label: labels[dependencyId] || dependencyId,
      available,
      blocked: !available,
      preparation: available ? null : boundedText(raw?.preparation, 40, 'unavailable')
    };
  }

  dependencyPreparationForRoutes(routes, status, requiredFonts = [], inspectorRequiredDependencies = []) {
    const requiredApplications = [...new Set([
      ...routes.map((route) => route.requiredDependency),
      ...inspectorRequiredDependencies
    ])];
    const availability = {
      ...(status?.dependencies || {}),
      officePowerPoint: status?.dependencies?.officePowerPoint || Boolean(status?.powerPoint),
      officeWord: status?.dependencies?.officeWord || Boolean(status?.word),
      officeExcel: status?.dependencies?.officeExcel || Boolean(status?.excel),
      hancomWriter: status?.dependencies?.hancomWriter || Boolean(status?.hancomWriter),
      hancomCell: status?.dependencies?.hancomCell || Boolean(status?.hancomCell),
      libreOffice: status?.compatibleFallbacks?.libreOffice || status?.libreOffice || false,
      rhwp: status?.compatibleFallbacks?.rhwp || false
    };
    return DocumentDependencies.planDocumentDependencies({
      platform: process.platform,
      architecture: process.arch,
      requiredApplications,
      requiredFonts,
      availability
    }, this.dependencyManifest);
  }

  async getDocumentConversionTargets(ownerId, payload = {}) {
    const inputs = this.resolveDocumentConversionInputs(ownerId, payload);
    const sourceExtensions = inputs.map((item) => item.extension);
    const targetExtensions = DocumentConversion.getCommonTargets(sourceExtensions);
    const requestedTarget = payload.targetExtension ?? payload.target;
    let targetExtension = '';
    let routes = [];
    let availability = null;
    let preparationPlan = null;
    const fontRequirements = await this.documentFontRequirements(inputs);
    if (requestedTarget != null && String(requestedTarget).trim()) {
      targetExtension = DocumentConversion.safeOutputExtension(requestedTarget);
      if (!targetExtensions.includes(targetExtension)) {
        const error = new Error('선택한 모든 원본 문서에 공통으로 지원되는 변환 형식이 아닙니다.');
        error.code = 'DOCUMENT_CONVERSION_ROUTE_UNSUPPORTED';
        throw error;
      }
      routes = inputs.map((input) => DocumentConversion.selectConversionRoute(input.extension, targetExtension));
      const status = await this.capabilities();
      const routeAvailability = DocumentConversion.getBatchConversionAvailability(sourceExtensions, targetExtension, status);
      const inspectorDependencies = fontRequirements.inspectorRequiredDependencies.map((dependencyId) => (
        this.documentInspectorDependencyAvailability(dependencyId, status)
      ));
      const missingInspectorDependencies = inspectorDependencies.filter((item) => item.blocked);
      const fontOrInspectorBlocked = fontRequirements.requiredFonts.length > 0 || missingInspectorDependencies.length > 0;
      availability = fontOrInspectorBlocked ? {
        ...routeAvailability,
        available: false,
        ready: false,
        blocked: true,
        fontBlocked: fontRequirements.requiredFonts.length > 0,
        inspectorBlocked: missingInspectorDependencies.length > 0,
        missingFonts: [...fontRequirements.requiredFonts],
        requiredDependencies: [...new Set([
          ...routeAvailability.requiredDependencies,
          ...fontRequirements.inspectorRequiredDependencies
        ])],
        missingDependencies: [...routeAvailability.missingDependencies, ...missingInspectorDependencies]
      } : routeAvailability;
      if (availability.blocked || fontRequirements.requiredFonts.length || missingInspectorDependencies.length) {
        preparationPlan = this.dependencyPreparationForRoutes(
          routes,
          status,
          fontRequirements.requiredFonts,
          fontRequirements.inspectorRequiredDependencies
        );
      }
    }
    return {
      sourceExtensions,
      targetExtensions,
      targets: targetExtensions.map((extension) => {
        const compatibilityNote = [...new Set(sourceExtensions
          .map((sourceExtension) => DocumentConversion.selectConversionRoute(sourceExtension, extension)?.compatibilityNote)
          .filter(Boolean))].join(' ');
        return {
          ...DocumentConversion.getFormatMetadata(extension),
          compatibilityNote
        };
      }),
      targetExtension,
      routes,
      availability,
      preparationPlan,
      requiredDependencies: availability?.requiredDependencies || [],
      missingDependencies: availability?.missingDependencies || [],
      requiredFonts: fontRequirements.requiredFonts,
      fontReports: fontRequirements.reports,
      inspectorRequiredDependencies: fontRequirements.inspectorRequiredDependencies,
      inspectionUnavailable: fontRequirements.inspectionUnavailable,
      requiresPreview: fontRequirements.requiresPreview
    };
  }

  documentSplitTokenKind(kind) {
    return `document-split-${normalizeDocumentSplitKind(kind)}`;
  }

  async preflightDocumentSplitStorage(outputDirectory, projection) {
    let tempCapacity;
    let outputCapacity;
    try {
      [tempCapacity, outputCapacity] = await Promise.all([
        this.inspectDocumentSplitFileSystemCapacity(os.tmpdir()),
        this.inspectDocumentSplitFileSystemCapacity(outputDirectory)
      ]);
    } catch (cause) {
      if (cause?.code === 'DOCUMENT_SPLIT_DISK_SPACE_CHECK_FAILED') throw cause;
      throw documentSplitError(
        'DOCUMENT_SPLIT_DISK_SPACE_CHECK_FAILED',
        '파일 나누기에 필요한 임시 공간과 결과 저장 공간의 여유 용량을 확인하지 못했습니다. 저장 장치를 다시 연결한 뒤 시도해주세요.',
        cause
      );
    }
    return assertDocumentSplitFreeSpace(projection, tempCapacity, outputCapacity);
  }

  async bindDocumentSplitOutputDirectory(entry) {
    const current = await this.inspectDocumentSplitOutputDirectoryIdentity(entry?.filePath);
    const selected = entry?.metadata?.directoryIdentity;
    if (selected && !sameDocumentSplitOutputDirectoryIdentity(selected, current)) {
      throw documentSplitOutputDirectoryChangedError();
    }
    if (!selected) {
      // Older direct callers issued output-directory capabilities without
      // metadata. Bind them on first use so existing integrations keep working,
      // while every subsequent queued/publish boundary is identity checked.
      entry.filePath = current.realPath;
      entry.metadata = { ...(entry.metadata || {}), directoryIdentity: current };
    }
    return selected || current;
  }

  async assertDocumentSplitOutputDirectory(entry, selectedIdentity) {
    const current = await this.inspectDocumentSplitOutputDirectoryIdentity(entry?.filePath);
    if (!sameDocumentSplitOutputDirectoryIdentity(selectedIdentity, current)) {
      throw documentSplitOutputDirectoryChangedError();
    }
    return current.realPath;
  }

  async inspectDocumentSplitEntry(kind, filePath) {
    const normalizedKind = normalizeDocumentSplitKind(kind);
    const inspected = await this.inspectDocumentMergeEntry(normalizedKind, filePath);
    const sourceUnitCount = normalizedKind === 'pdf'
      ? Number(inspected.pageCount) || 0
      : Number(inspected.slideCount) || 0;
    if (sourceUnitCount < 1) {
      const error = new Error(normalizedKind === 'pdf'
        ? '나눌 PDF에 페이지가 없습니다.'
        : '나눌 PPTX에 슬라이드가 없습니다.');
      error.code = 'DOCUMENT_SPLIT_SOURCE_EMPTY';
      throw error;
    }
    const identity = await this.inspectOutputFileIdentity(filePath);
    if (identity.bytes !== Number(inspected.bytes)) {
      const error = new Error('파일을 확인하는 동안 내용이 바뀌었습니다. 다시 선택해주세요.');
      error.code = 'DOCUMENT_SPLIT_INPUT_CHANGED';
      throw error;
    }
    return { ...inspected, sourceUnitCount, identity };
  }

  documentSplitPublicMetadata(kind, token, metadata = {}) {
    const normalizedKind = normalizeDocumentSplitKind(kind);
    return {
      token,
      kind: normalizedKind,
      name: boundedText(metadata.name, 200),
      bytes: Number(metadata.bytes) || 0,
      sourceUnitCount: Number(metadata.sourceUnitCount) || 0,
      ...(normalizedKind === 'pdf'
        ? { pageCount: Number(metadata.pageCount) || 0 }
        : {
          slideCount: Number(metadata.slideCount) || 0,
          slideSize: metadata.slideSize || null
        })
    };
  }

  async chooseDocumentSplitFile(ownerId, parentWindow, payload = {}) {
    const kind = normalizeDocumentSplitKind(payload.kind);
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: kind === 'pdf' ? '나눌 PDF 파일 선택' : '나눌 PowerPoint 파일 선택',
      properties: ['openFile'],
      filters: [{
        name: kind === 'pdf' ? 'PDF 문서' : 'PowerPoint PPTX',
        extensions: [kind]
      }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, kind, file: null };
    const filePath = result.filePaths[0];
    const inspected = await this.inspectDocumentSplitEntry(kind, filePath);
    const token = this.issueToken(ownerId, this.documentSplitTokenKind(kind), filePath, inspected);
    const entry = this.resolveToken(ownerId, token, this.documentSplitTokenKind(kind));
    entry.metadata = inspected;
    const file = this.documentSplitPublicMetadata(kind, token, inspected);
    return {
      canceled: false,
      kind,
      file,
      sourceUnitCount: file.sourceUnitCount
    };
  }

  async chooseExcelDeduplicateFile(ownerId, parentWindow) {
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: '중복 행을 정리할 Excel 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'Excel XLSX', extensions: ['xlsx'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, file: null };
    const filePath = result.filePaths[0];
    const analysis = await this.analyzeExcelDuplicates(filePath);
    const token = this.issueToken(ownerId, 'excel-deduplicate-input', filePath, analysis, { reuse: false });
    return {
      canceled: false,
      file: {
        token,
        name: boundedText(path.basename(filePath), 200),
        bytes: Number(analysis.sourceBytes) || 0,
        sheetCount: Number(analysis.sheetCount) || 0,
        duplicateRowCount: Number(analysis.duplicateRowCount) || 0,
        duplicateSheetCount: Number(analysis.duplicateSheetCount) || 0,
        sheets: Array.isArray(analysis.sheets) ? analysis.sheets : [],
        highRiskFeatures: Array.isArray(analysis.highRiskFeatures) ? analysis.highRiskFeatures : [],
        engine: 'cmoe-internal-excel'
      }
    };
  }

  async analyzeExcelDeduplicateCriteria(ownerId, payload = {}) {
    const source = this.resolveToken(ownerId, payload.fileToken, 'excel-deduplicate-input');
    const rawSelections = payload.columnIndexesBySheet && typeof payload.columnIndexesBySheet === 'object' ? payload.columnIndexesBySheet : {};
    const columnIndexesBySheet = {};
    for (const [rawIndex, rawColumns] of Object.entries(rawSelections)) {
      const index = Number(rawIndex); const sheet = source.metadata?.sheets?.[index];
      const columns = [...new Set((Array.isArray(rawColumns) ? rawColumns : []).map(Number))].sort((left, right) => left - right);
      if (!Number.isInteger(index) || !sheet || columns.length > Number(sheet.columnCount) || columns.some((column) => !Number.isInteger(column) || column < 1 || column > Number(sheet.columnCount))) {
        throw ExcelDeduplicate.excelDeduplicateError('EXCEL_DEDUPLICATE_COLUMN_SELECTION_INVALID', '중복 비교 기준 열 선택을 올바르게 확인해주세요.');
      }
      columnIndexesBySheet[index] = columns;
    }
    const analysis = await this.analyzeExcelDuplicates(source.filePath, { columnIndexesBySheet });
    if (analysis.sourceSha256 !== source.metadata?.sourceSha256 || analysis.sourceBytes !== source.metadata?.sourceBytes) {
      throw ExcelDeduplicate.excelDeduplicateError('EXCEL_DEDUPLICATE_INPUT_CHANGED', '선택한 Excel 파일이 분석 후 바뀌었습니다. 파일을 다시 선택해주세요.');
    }
    return {
      sheetCount: analysis.sheetCount,
      duplicateRowCount: analysis.duplicateRowCount,
      duplicateSheetCount: analysis.duplicateSheetCount,
      sheets: analysis.sheets
    };
  }

  async analyzeExcelDeduplicateReview(ownerId, payload = {}) {
    const source = this.resolveToken(ownerId, payload.fileToken, 'excel-deduplicate-input');
    const index = Number(payload.sheetIndex); const sheet = source.metadata?.sheets?.[index];
    const columns = [...new Set((Array.isArray(payload.columnIndexes) ? payload.columnIndexes : []).map(Number))].sort((left, right) => left - right);
    if (!Number.isInteger(index) || !sheet || !columns.length || columns.length > Number(sheet.columnCount) || columns.some((column) => !Number.isInteger(column) || column < 1 || column > Number(sheet.columnCount))) {
      throw ExcelDeduplicate.excelDeduplicateError('EXCEL_DEDUPLICATE_COLUMN_SELECTION_INVALID', '검토할 시트와 기준 열을 다시 선택해주세요.');
    }
    return ExcelDeduplicate.analyzeExcelDuplicateReview(source.filePath, index, {
      expectedSha256: source.metadata?.sourceSha256,
      columnIndexes: columns,
      headerRow: Number.isInteger(Number(payload.headerRow)) ? Number(payload.headerRow) : Number(sheet.headerRow) || 0
    });
  }

  async runExcelDeduplicate(ownerId, payload = {}, progress = () => {}) {
    const source = this.resolveToken(ownerId, payload.fileToken, 'excel-deduplicate-input');
    const outputCapability = this.resolveToken(ownerId, payload.outputToken, 'output-directory');
    const selectedOutputDirectoryIdentity = await this.bindDocumentSplitOutputDirectory(outputCapability);
    const outputDirectory = selectedOutputDirectoryIdentity.realPath;
    const selectedSheetIndexes = [...new Set((Array.isArray(payload.sheetIndexes) ? payload.sheetIndexes : []).map(Number))];
    if (!selectedSheetIndexes.length) throw ExcelDeduplicate.excelDeduplicateError('EXCEL_DEDUPLICATE_SHEET_SELECTION_INVALID', '중복을 제거할 시트를 하나 이상 선택해주세요.');
    const criteriaMode = payload.criteriaMode === 'columns' ? 'columns' : 'all';
    const rawSelections = payload.columnIndexesBySheet && typeof payload.columnIndexesBySheet === 'object' ? payload.columnIndexesBySheet : {};
    const columnIndexesBySheet = {};
    if (criteriaMode === 'columns') {
      for (const index of selectedSheetIndexes) {
        const sheet = source.metadata?.sheets?.[index];
        const rawColumns = rawSelections[index] || rawSelections[String(index)];
        const columns = [...new Set((Array.isArray(rawColumns) ? rawColumns : []).map(Number))].sort((left, right) => left - right);
        if (!sheet || !columns.length || columns.length > Number(sheet.columnCount) || columns.some((column) => !Number.isInteger(column) || column < 1 || column > Number(sheet.columnCount))) {
          throw ExcelDeduplicate.excelDeduplicateError('EXCEL_DEDUPLICATE_COLUMN_SELECTION_INVALID', `${sheet?.name || '선택한 시트'}의 중복 비교 기준 열을 하나 이상 선택해주세요.`);
        }
        columnIndexesBySheet[index] = columns;
      }
    }
    const current = await this.analyzeExcelDuplicates(source.filePath, { columnIndexesBySheet });
    if (current.sourceSha256 !== source.metadata?.sourceSha256 || current.sourceBytes !== source.metadata?.sourceBytes) {
      throw ExcelDeduplicate.excelDeduplicateError('EXCEL_DEDUPLICATE_INPUT_CHANGED', '선택한 Excel 파일이 분석 후 바뀌었습니다. 파일을 다시 선택해주세요.');
    }
    if (selectedSheetIndexes.some((index) => !Number.isInteger(index) || !current.sheets[index] || current.sheets[index].duplicateRowCount < 1)) {
      throw ExcelDeduplicate.excelDeduplicateError('EXCEL_DEDUPLICATE_SHEET_SELECTION_INVALID', '현재 중복 행이 있는 시트만 선택해주세요.');
    }
    const requestedName = String(payload.outputName || '').replace(/\.xlsx$/i, '');
    const fallbackName = `${path.parse(source.filePath).name}_중복제거`;
    return this.enqueue('excel-deduplicate', ownerId, payload.requestId, async (_jobId, control) => {
      control.throwIfCancelled();
      await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
      const output = await this.availableOutputBase(outputDirectory, safeOutputStem(requestedName, fallbackName), ['xlsx']);
      progress({ phase: 'clean', completed: 0, total: selectedSheetIndexes.length, engine: 'cmoe-internal-excel' });
      const cleaned = await this.deduplicateExcelWorkbook(source.filePath, output.paths.xlsx, selectedSheetIndexes, {
        expectedSha256: current.sourceSha256,
        columnIndexesBySheet,
        headerRowsBySheet: Object.fromEntries(current.sheets.map((sheet) => [String(sheet.index), Number(sheet.headerRow) || 0])),
        mergeMissingValues: payload.mergeMissingValues !== false,
        preferredRowsByGroup: payload.preferredRowsByGroup,
        cellSourceRowsByGroup: payload.cellSourceRowsByGroup,
        customValuesByGroup: payload.customValuesByGroup,
        approvedGroupIds: payload.approvedGroupIds,
        throwIfCancelled: control.throwIfCancelled
      });
      progress({ phase: 'verify', completed: selectedSheetIndexes.length, total: selectedSheetIndexes.length, engine: 'cmoe-internal-excel' });
      control.beginCommit();
      const outputIdentity = await this.inspectOutputFileIdentity(cleaned.outputPath);
      const outputFileToken = await this.issueOutputFileToken(ownerId, cleaned.outputPath, outputIdentity);
      const { outputPath: _privateOutputPath, ...publicResult } = cleaned;
      return {
        ...publicResult,
        outputFileToken,
        warnings: [
          ...(current.highRiskFeatures.length ? [`${current.highRiskFeatures.map((item) => item.label).join('·')}이 포함된 파일입니다. 완료 파일에서 해당 개체와 수식을 확인해주세요.`] : []),
          criteriaMode === 'columns'
            ? '원본 파일은 변경하지 않았습니다. 완전히 같은 행·빈칸·공백 차이·포함 관계만 자동 통합했고, 완전히 다른 값은 사용자가 최종 행을 직접 확정한 묶음만 통합했습니다.'
            : '원본 파일은 변경하지 않았습니다. 셀 내용과 수식이 모두 같은 비어 있지 않은 행만 제거했습니다.'
        ]
      };
    });
  }

  async chooseExcelCompareFile(ownerId, parentWindow, payload = {}) {
    const slot = payload.slot === 'b' ? 'b' : 'a';
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: `${slot.toUpperCase()} 비교 파일 선택`, properties: ['openFile'], filters: [{ name: 'Excel XLSX', extensions: ['xlsx'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, slot, file: null };
    const filePath = result.filePaths[0]; const inspection = await this.inspectExcelCompareFile(filePath);
    const token = this.issueToken(ownerId, `excel-compare-input-${slot}`, filePath, inspection, { reuse: false });
    return {
      canceled: false, slot,
      file: {
        token, name: boundedText(path.basename(filePath), 200), bytes: Number(inspection.sourceBytes) || 0,
        sheetCount: Number(inspection.sheetCount) || 0, sheets: Array.isArray(inspection.sheets) ? inspection.sheets : []
      }
    };
  }

  excelComparePayload(ownerId, payload = {}) {
    const left = this.resolveToken(ownerId, payload.leftToken, 'excel-compare-input-a');
    const right = this.resolveToken(ownerId, payload.rightToken, 'excel-compare-input-b');
    return {
      left, right,
      options: {
        left: payload.left, right: payload.right,
        rules: Array.isArray(payload.rules) ? payload.rules.slice(0, ExcelCompareGroup.MAX_RULES + 1) : [],
        expectedLeftSha256: left.metadata?.sourceSha256,
        expectedRightSha256: right.metadata?.sourceSha256
      }
    };
  }

  async analyzeExcelComparePlan(ownerId, payload = {}) {
    const { left, right, options } = this.excelComparePayload(ownerId, payload);
    return this.analyzeExcelCompareGroups(left.filePath, right.filePath, options);
  }

  async runExcelCompareGroup(ownerId, payload = {}, progress = () => {}) {
    const { left, right, options } = this.excelComparePayload(ownerId, payload);
    const outputCapability = this.resolveToken(ownerId, payload.outputToken, 'output-directory');
    const selectedOutputDirectoryIdentity = await this.bindDocumentSplitOutputDirectory(outputCapability);
    const outputDirectory = selectedOutputDirectoryIdentity.realPath;
    const requestedName = String(payload.outputName || '').replace(/\.xlsx$/i, '');
    return this.enqueue('excel-compare-group', ownerId, payload.requestId, async (_jobId, control) => {
      control.throwIfCancelled(); await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
      const output = await this.availableOutputBase(outputDirectory, safeOutputStem(requestedName, 'Excel 비교 분류 결과'), ['xlsx']);
      progress({ phase: 'compare', completed: 0, total: 2, engine: 'cmoe-internal-excel' });
      const generated = await this.compareAndGroupExcelFiles(left.filePath, right.filePath, output.paths.xlsx, {
        ...options, throwIfCancelled: control.throwIfCancelled
      });
      progress({ phase: 'verify', completed: 2, total: 2, engine: 'cmoe-internal-excel' });
      control.beginCommit(); const outputIdentity = await this.inspectOutputFileIdentity(generated.outputPath);
      const outputFileToken = await this.issueOutputFileToken(ownerId, generated.outputPath, outputIdentity);
      const { outputPath: _privateOutputPath, ...publicResult } = generated;
      return {
        ...publicResult, outputFileToken,
        warnings: [...(publicResult.warnings || []), '결과는 서로 다른 두 표를 합친 새 보고서입니다. 원본 파일의 셀 서식·차트·피벗은 복사하지 않습니다.']
      };
    });
  }

  documentMergeTokenKind(kind) {
    return `document-merge-${normalizeDocumentToolsMergeKind(kind)}`;
  }

  documentMergeFileKey(kind, filePath) {
    const normalizedPath = process.platform === 'win32'
      ? path.resolve(filePath).toLocaleLowerCase('en-US')
      : path.resolve(filePath);
    return crypto.createHash('sha256').update(`${normalizeDocumentToolsMergeKind(kind)}\u0000${normalizedPath}`).digest('hex');
  }

  async inspectInternalExcelMergeEntry(filePath, options = {}) {
    const extension = NativeOfficeMerge.assertNativeOfficeInputExtension('excel', filePath).slice(1);
    if (extension !== 'xlsx') {
      const error = new Error('내부 Excel 병합은 XLSX 파일만 사용할 수 있습니다.');
      error.code = 'INTERNAL_EXCEL_INPUT_FORMAT_INVALID';
      throw error;
    }
    if (typeof this.inspectInternalExcelWorkbook !== 'function') {
      const error = new Error('내부 Excel 검사 도구를 사용할 수 없습니다. 앱을 다시 설치해주세요.');
      error.code = 'INTERNAL_EXCEL_INSPECTOR_UNAVAILABLE';
      throw error;
    }
    const stats = options.stats || await assertDocumentSourceFile(filePath, extension);
    const source = options.source || (await NativeOfficeMerge.inspectNativeOfficeMergeSources(
      'excel',
      [filePath],
      { allowSingle: true }
    )).sources[0];
    let fallbackCause = options.fallbackCause;
    if (!fallbackCause) {
      try {
        const securityStructure = await this.inspectXlsxWorkbookStructure(source.filePath);
        if (Number(securityStructure?.sourceBytes) !== Number(source.bytes)
          || securityStructure?.sourceSha256 !== source.sha256) {
          const error = new Error(`“${path.basename(source.filePath)}” 파일이 내부 병합 검사 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.`);
          error.code = 'INTERNAL_EXCEL_INPUT_CHANGED';
          throw error;
        }
      } catch (error) {
        if (!INTERNAL_EXCEL_STRUCTURE_FALLBACK_CODES.has(String(error?.code || ''))) throw error;
        fallbackCause = error;
      }
    }
    const inspected = await this.inspectInternalExcelWorkbook(source.filePath);
    if (!inspected || inspected.internalForceCompatible !== true
      || Number(inspected.sourceBytes) !== Number(source.bytes)
      || inspected.sourceSha256 !== source.sha256) {
      const error = new Error(`“${path.basename(source.filePath)}” 파일의 내부 병합 안전 검사가 원본과 일치하지 않습니다. 현재 파일을 다시 선택해주세요.`);
      error.code = 'INTERNAL_EXCEL_INPUT_CHANGED';
      throw error;
    }
    const rawSheets = Array.isArray(inspected.worksheets) ? inspected.worksheets : [];
    const sheets = rawSheets.map((sheet, index) => ({
      index,
      name: boundedText(sheet?.name, 31, `Sheet ${index + 1}`),
      type: 'worksheet',
      visibility: ['visible', 'hidden', 'veryHidden'].includes(sheet?.visibility)
        ? sheet.visibility
        : 'unknown'
    }));
    const sheetCount = Number(inspected.sheetCount || inspected.worksheetCount || sheets.length);
    if (!Number.isInteger(sheetCount) || sheetCount < 1 || sheets.length !== sheetCount) {
      const error = new Error('내부 Excel 검사 결과에서 시트 구성을 확인하지 못했습니다.');
      error.code = 'INTERNAL_EXCEL_WORKSHEET_MISSING';
      throw error;
    }
    const fallbackReasonCode = String(fallbackCause?.code || '')
      .replace(/[^A-Z0-9_.-]/gi, '_')
      .slice(0, 96);
    const rawFallbackMessage = String(fallbackCause?.message || '').replaceAll(
      String(source.filePath),
      path.basename(source.filePath)
    );
    const externalLinkCount = Math.max(0, Number(inspected.features?.externalLinks) || 0);
    return {
      name: path.basename(source.filePath),
      bytes: source.bytes,
      modifiedAt: source.modifiedAt,
      extension,
      group: 'spreadsheet',
      sourceRealPath: source.filePath,
      sourceSha256: source.sha256,
      sourceBirthtimeMs: stats.birthtimeMs,
      sheetCount,
      sheets,
      sheetNames: sheets.map((sheet) => sheet.name),
      externalLinksPresent: externalLinkCount > 0,
      externalLinkCount,
      requiresPreview: true,
      structureInspectionEngine: 'internal-exceljs',
      internalFallbackRequired: true,
      internalFallbackReasonCode: fallbackReasonCode,
      internalFallbackReasonMessage: boundedText(rawFallbackMessage, 240),
      internalFallbackWarnings: Array.isArray(inspected.warnings)
        ? inspected.warnings.map((warning) => boundedText(warning, 300)).filter(Boolean)
        : []
    };
  }

  async inspectDocumentMergeEntry(kind, filePath) {
    const normalizedKind = normalizeDocumentToolsMergeKind(kind);
    if (NATIVE_OFFICE_MERGE_KIND_SET.has(normalizedKind)) {
      const extension = NativeOfficeMerge.assertNativeOfficeInputExtension(normalizedKind, filePath).slice(1);
      const stats = await assertDocumentSourceFile(filePath, extension);
      const sourceInspection = await NativeOfficeMerge.inspectNativeOfficeMergeSources(
        normalizedKind,
        [filePath],
        { allowSingle: true }
      );
      const source = sourceInspection.sources[0];
      let workbookStructure = null;
      if (normalizedKind === 'excel' && extension === 'xlsx') {
        try {
          workbookStructure = await this.inspectXlsxWorkbookStructure(source.filePath);
        } catch (error) {
          if (!INTERNAL_EXCEL_STRUCTURE_FALLBACK_CODES.has(String(error?.code || ''))) throw error;
          return this.inspectInternalExcelMergeEntry(source.filePath, {
            stats,
            source,
            fallbackCause: error
          });
        }
        if (Number(workbookStructure?.sourceBytes) !== Number(source.bytes)
          || workbookStructure?.sourceSha256 !== source.sha256) {
          const error = new Error(`“${path.basename(source.filePath)}” 파일이 확인 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.`);
          error.code = 'NATIVE_OFFICE_MERGE_INPUT_CHANGED';
          throw error;
        }
      }
      return {
        name: path.basename(source.filePath),
        bytes: source.bytes,
        modifiedAt: source.modifiedAt,
        extension,
        group: normalizedKind === 'word' ? 'text' : 'spreadsheet',
        sourceRealPath: source.filePath,
        sourceSha256: source.sha256,
        sourceBirthtimeMs: stats.birthtimeMs,
        ...(workbookStructure ? {
          sheetCount: workbookStructure.sheetCount,
          sheets: workbookStructure.sheets,
          sheetNames: workbookStructure.sheetNames,
          externalLinksPresent: workbookStructure.externalLinksPresent,
          externalLinkCount: workbookStructure.externalLinkCount,
          requiresPreview: workbookStructure.requiresPreview,
          structureInspectionEngine: workbookStructure.structureInspectionEngine
        } : {})
      };
    }
    if (normalizedKind === DOCUMENTS_MERGE_KIND) {
      const extension = DocumentConversion.normalizeExtension(filePath);
      const format = DocumentConversion.getFormatMetadata(extension);
      if (extension !== 'pdf' && !format?.source) {
        throw new Error('PDF 또는 지원하는 문서 파일만 선택해주세요.');
      }
      if (extension === 'pdf') {
        const inspected = await this.inspectPdfFile(filePath);
        return {
          name: inspected.sourceName,
          bytes: inspected.sourceBytes,
          modifiedAt: inspected.sourceModifiedAt,
          extension,
          group: 'pdf',
          pageCount: inspected.pageCount
        };
      }
      const stats = await assertDocumentSourceFile(filePath, extension);
      return {
        name: path.basename(filePath),
        bytes: stats.size,
        modifiedAt: stats.mtimeMs,
        extension,
        group: format.group
      };
    }
    if (path.extname(filePath).toLowerCase() !== `.${normalizedKind}`) {
      throw new Error(`${normalizedKind.toUpperCase()} 파일만 선택해주세요.`);
    }
    if (normalizedKind === 'pdf') {
      const inspected = await this.inspectPdfFile(filePath);
      return {
        name: inspected.sourceName,
        bytes: inspected.sourceBytes,
        modifiedAt: inspected.sourceModifiedAt,
        pageCount: inspected.pageCount
      };
    }
    const inspected = await this.inspectPptxFile(filePath);
    const stats = await fs.promises.stat(inspected.sourcePath);
    return {
      name: inspected.sourceName,
      bytes: inspected.sourceBytes,
      modifiedAt: stats.mtimeMs,
      slideCount: inspected.slideCount,
      slideSize: inspected.slideSize
    };
  }

  documentMergePublicMetadata(kind, token, entry, itemId = crypto.randomUUID()) {
    const metadata = entry?.metadata || {};
    const common = {
      token,
      itemId,
      key: metadata.key || this.documentMergeFileKey(kind, entry.filePath),
      name: boundedText(metadata.name || path.basename(entry.filePath), 200),
      bytes: Number(metadata.bytes) || 0
    };
    if (kind === DOCUMENTS_MERGE_KIND) {
      const extension = DocumentConversion.normalizeExtension(metadata.extension || entry.filePath);
      return {
        ...common,
        extension,
        group: boundedText(metadata.group, 32, extension === 'pdf' ? 'pdf' : ''),
        ...(extension === 'pdf' ? { pageCount: Number(metadata.pageCount) || 0 } : {})
      };
    }
    if (NATIVE_OFFICE_MERGE_KIND_SET.has(kind)) {
      const sheets = Array.isArray(metadata.sheets) ? metadata.sheets.map((sheet, index) => ({
        index,
        name: boundedText(sheet?.name, 31, `Sheet ${index + 1}`),
        type: boundedText(sheet?.type, 32, 'unknown'),
        visibility: ['visible', 'hidden', 'veryHidden'].includes(sheet?.visibility) ? sheet.visibility : 'unknown'
      })) : [];
      return {
        ...common,
        extension: boundedText(metadata.extension || DocumentConversion.normalizeExtension(entry.filePath), 12),
        internalFallbackRequired: metadata.internalFallbackRequired === true,
        structureInspectionEngine: metadata.internalFallbackRequired === true
          ? boundedText(metadata.structureInspectionEngine, 48, 'internal-exceljs')
          : '',
        internalFallbackReasonCode: metadata.internalFallbackRequired === true
          ? boundedText(metadata.internalFallbackReasonCode, 96)
          : '',
        internalFallbackReasonMessage: metadata.internalFallbackRequired === true
          ? boundedText(metadata.internalFallbackReasonMessage, 240)
          : '',
        compatibilityInput: metadata.requiresPreview === true
          || (kind === 'word' ? metadata.extension !== 'docx' : metadata.extension !== 'xlsx'),
        requiresPreview: metadata.requiresPreview === true,
        ...(kind === 'word' ? {
          ...(Number(metadata.pageCount) > 0 ? { pageCount: Number(metadata.pageCount) } : {}),
          ...(Number(metadata.sectionCount) > 0 ? { sectionCount: Number(metadata.sectionCount) } : {}),
          revisionCount: Number(metadata.revisionCount) || 0,
          commentCount: Number(metadata.commentCount) || 0
        } : {
          ...(Number(metadata.sheetCount) > 0 || sheets.length ? {
            sheetCount: Number(metadata.sheetCount) || sheets.length,
            sheets,
            sheetNames: sheets.map((sheet) => sheet.name)
          } : {}),
          externalLinksPresent: metadata.externalLinksPresent === true,
          externalLinkCount: Number(metadata.externalLinkCount) || 0
        })
      };
    }
    return {
      ...common,
      ...(kind === 'pdf' ? { pageCount: Number(metadata.pageCount) || 0 } : {
        slideCount: Number(metadata.slideCount) || 0,
        slideSize: metadata.slideSize || null
      })
    };
  }

  async documentMergeNativeOfficeReadiness(kind, inputs) {
    const normalizedKind = NativeOfficeMerge.normalizeNativeOfficeMergeKind(kind);
    const internalFallbackRequired = normalizedKind === 'excel'
      && inputs.some((input) => input.entry.metadata?.internalFallbackRequired === true);
    const internalFallbackWarnings = inputs.flatMap((input) => (
      Array.isArray(input.entry.metadata?.internalFallbackWarnings)
        ? input.entry.metadata.internalFallbackWarnings
        : []
    ));
    if (internalFallbackRequired) {
      const warnings = [...new Set([INTERNAL_EXCEL_FALLBACK_WARNING, ...internalFallbackWarnings])];
      return {
        availability: {
          supported: true,
          available: true,
          ready: true,
          blocked: false,
          runningBlocked: false,
          fontBlocked: false,
          inspectorBlocked: false,
          requiredDependencies: [],
          missingDependencies: [],
          runningDependencies: [],
          missingFonts: [],
          inspectionUnavailable: [],
          requiresPreview: true
        },
        preparationPlan: null,
        requiredDependencies: [],
        missingDependencies: [],
        runningDependencies: [],
        requiredFonts: [],
        fontReports: [],
        inspectorRequiredDependencies: [],
        inspectionUnavailable: [],
        requiresPreview: true,
        compatibilityMode: true,
        compatibilityInputs: [],
        engine: 'cmoe-internal-excel',
        compatibilityFallback: true,
        internalFallbackRequired: true,
        fallbackSupported: true,
        fallbackUnsupportedReasons: [],
        warnings,
        applicationReady: false
      };
    }
    const dependencyId = NATIVE_OFFICE_MERGE_DEPENDENCIES[normalizedKind];
    const status = await this.capabilities();
    const dependencyMetadata = DocumentConversion.DEPENDENCY_METADATA[dependencyId] || {};
    const rawDependency = status.dependencies?.[dependencyId] || {};
    const nativeApplication = {
      dependencyId,
      engine: dependencyMetadata.engine || normalizedKind,
      label: dependencyMetadata.label || `Microsoft ${NATIVE_OFFICE_MERGE_LABELS[normalizedKind]}`,
      available: rawDependency.available === true || status[normalizedKind] === true,
      blocked: !(rawDependency.available === true || status[normalizedKind] === true),
      running: rawDependency.running === true || status[`${normalizedKind}Running`] === true,
      preparation: rawDependency.preparation || null
    };
    const fallbackUnsupportedReasons = normalizedKind !== 'excel' ? [] : [
      ...(inputs.some((input) => input.extension !== 'xlsx') ? ['non-xlsx-input'] : []),
      ...(inputs.some((input) => input.entry.metadata?.structureInspectionEngine !== 'ooxml') ? ['structure-not-inspected'] : []),
      ...(inputs.some((input) => input.entry.metadata?.externalLinksPresent === true) ? ['external-links'] : []),
      ...(inputs.some((input) => !Array.isArray(input.entry.metadata?.sheets) || !input.entry.metadata.sheets.length) ? ['sheet-list-unavailable'] : []),
      ...(inputs.some((input) => (input.entry.metadata?.sheets || []).some((sheet) => sheet.type !== 'worksheet')) ? ['non-worksheet-sheet'] : []),
      ...(inputs.some((input) => (input.entry.metadata?.sheets || []).some((sheet) => sheet.visibility === 'veryHidden')) ? ['very-hidden-sheet'] : []),
      ...(inputs.some((input) => (input.entry.metadata?.sheets || []).some((sheet) => !['visible', 'hidden', 'veryHidden'].includes(sheet.visibility))) ? ['unknown-sheet-visibility'] : [])
    ];
    const fallbackSupported = normalizedKind === 'excel'
      && inputs.length > 0
      && fallbackUnsupportedReasons.length === 0;
    const rawLibreOffice = status.compatibleFallbacks?.libreOffice || {};
    const libreOfficeApplication = {
      dependencyId: 'libreOffice',
      engine: 'libreoffice',
      label: 'LibreOffice',
      available: rawLibreOffice.available === true || status.libreOffice === true,
      blocked: !(rawLibreOffice.available === true || status.libreOffice === true),
      running: false,
      preparation: rawLibreOffice.preparation || null
    };
    // Prefer Microsoft Excel whenever it is installed because its native copy
    // path preserves the widest set of workbook-scoped features.  On a PC
    // without Excel, a structurally safe XLSX set may use an isolated
    // LibreOffice compatibility path after explicit user confirmation.
    const compatibilityFallback = normalizedKind === 'excel'
      && !nativeApplication.available
      && fallbackSupported;
    const application = compatibilityFallback ? libreOfficeApplication : nativeApplication;
    const engine = compatibilityFallback ? 'libreoffice' : `microsoft-${normalizedKind}`;
    const fontRequirements = await this.documentFontRequirements(inputs);
    // An Excel sheet copy preserves font-family references in the workbook even
    // when this PC cannot render those families. Missing fonts are therefore a
    // fidelity warning for local preview/printing, not a structural merge block.
    const advisoryFonts = normalizedKind === 'excel' ? fontRequirements.requiredFonts : [];
    const blockingFonts = normalizedKind === 'excel' ? [] : fontRequirements.requiredFonts;
    const nativeExtension = normalizedKind === 'word' ? 'docx' : 'xlsx';
    const compatibilityInputs = inputs
      .filter((input) => input.extension !== nativeExtension)
      .map((input) => ({
        token: input.token,
        name: boundedText(path.basename(input.entry.filePath), 200),
        extension: boundedText(input.extension, 12)
      }));
    // Word repaginates fields/sections while concatenating and Excel may carry
    // workbook-scoped objects that are not sheet-scoped. A native result is
    // editable, but it must always be opened once before operational use.
    const requiresPreview = inputs.length > 0;
    const inspectorDependencies = fontRequirements.inspectorRequiredDependencies.map((id) => (
      this.documentInspectorDependencyAvailability(id, status)
    ));
    const missingInspectorDependencies = inspectorDependencies.filter((item) => item.blocked);
    const missingDependencies = [
      ...(application.blocked ? [application] : []),
      ...missingInspectorDependencies
    ].filter((item, index, values) => values.findIndex((candidate) => candidate.dependencyId === item.dependencyId) === index);
    const runningDependencies = application.running ? [application.dependencyId] : [];
    const requiredDependencies = [...new Set([
      application.dependencyId,
      ...fontRequirements.inspectorRequiredDependencies
    ])];
    const blocked = missingDependencies.length > 0
      || runningDependencies.length > 0
      || blockingFonts.length > 0;
    const preparationPlan = missingDependencies.length || blockingFonts.length
      ? this.dependencyPreparationForRoutes(
        [{ requiredDependency: application.dependencyId }],
        status,
        blockingFonts,
        fontRequirements.inspectorRequiredDependencies
      )
      : null;
    return {
      availability: {
        supported: true,
        available: !blocked,
        ready: !blocked,
        blocked,
        runningBlocked: runningDependencies.length > 0,
        fontBlocked: blockingFonts.length > 0,
        inspectorBlocked: missingInspectorDependencies.length > 0,
        requiredDependencies,
        missingDependencies,
        runningDependencies,
        missingFonts: [...blockingFonts],
        inspectionUnavailable: fontRequirements.inspectionUnavailable,
        requiresPreview
      },
      preparationPlan,
      requiredDependencies,
      missingDependencies,
      runningDependencies,
      requiredFonts: blockingFonts,
      fontReports: fontRequirements.reports,
      inspectorRequiredDependencies: fontRequirements.inspectorRequiredDependencies,
      inspectionUnavailable: fontRequirements.inspectionUnavailable,
      requiresPreview,
      compatibilityMode: compatibilityInputs.length > 0 || compatibilityFallback || internalFallbackRequired,
      compatibilityInputs,
      engine,
      compatibilityFallback,
      internalFallbackRequired,
      fallbackSupported,
      fallbackUnsupportedReasons: [...new Set(fallbackUnsupportedReasons)],
      warnings: [...new Set([
        ...(internalFallbackRequired ? [INTERNAL_EXCEL_FALLBACK_WARNING, ...internalFallbackWarnings] : []),
        ...(compatibilityFallback ? [
          'LibreOffice 호환 병합은 셀·수식·도형 수와 시트 순서를 저장 후 다시 검증하지만 일부 고급 Excel 서식은 달라질 수 있습니다.'
        ] : []),
        ...(advisoryFonts.length ? [
          `이 PC에 없는 글꼴 ${advisoryFonts.slice(0, 4).join(', ')}${advisoryFonts.length > 4 ? ` 외 ${advisoryFonts.length - 4}개` : ''}이(가) 있습니다. 시트의 글꼴 지정값은 유지하여 합치며, 이 PC의 화면·인쇄에서는 대체 글꼴로 보일 수 있으니 완료 후 결과를 확인해주세요.`
        ] : [])
      ])],
      applicationReady: !internalFallbackRequired && !compatibilityFallback && application.available && !application.running
    };
  }

  async inspectNativeOfficeMergeEntries(kind, inputs, progress = () => {}, options = {}) {
    const root = await makeJobDirectory();
    try {
      return await this.inspectNativeOfficeFiles(
        kind,
        inputs.map((input) => input.entry.filePath),
        root,
        {
          onProgress: (item) => progress({ phase: 'inspect', kind, ...item }),
          isCancelled: options.isCancelled,
          timeoutMs: powerPointMergeTimeoutMs(inputs.length, inputs.length * 10)
        }
      );
    } finally {
      await removeGeneratedDirectory(root);
    }
  }

  async chooseDocumentMergeFiles(ownerId, parentWindow, payload = {}) {
    const kind = normalizeDocumentToolsMergeKind(payload.kind);
    const isDocuments = kind === DOCUMENTS_MERGE_KIND;
    const isNativeOffice = NATIVE_OFFICE_MERGE_KIND_SET.has(kind);
    const nativeFormat = isNativeOffice ? NativeOfficeMerge.NATIVE_OFFICE_MERGE_FORMATS[kind] : null;
    const kindLabel = NATIVE_OFFICE_MERGE_LABELS[kind] || (kind === 'pdf' ? 'PDF' : 'PowerPoint');
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: isDocuments
        ? 'PDF로 합칠 문서 파일을 순서대로 선택'
        : `순서대로 합칠 ${kindLabel} 파일 선택`,
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: isDocuments ? 'PDF 및 지원 문서' : `${kindLabel} 문서`,
        extensions: isDocuments
          ? [...DOCUMENTS_MERGE_EXTENSIONS]
          : (isNativeOffice ? nativeFormat.inputExtensions.map((extension) => extension.slice(1)) : [kind])
      }]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true, kind, files: [] };
    if (result.filePaths.length > MAX_MERGE_FILES) throw new Error('한 번에 500개 파일까지 합칠 수 있습니다. 나눠서 선택해주세요.');

    const files = [];
    let totalBytes = 0;
    let totalUnits = 0;
    for (const filePath of result.filePaths) {
      const inspected = await this.inspectDocumentMergeEntry(kind, filePath);
      totalBytes += inspected.bytes;
      totalUnits += kind === 'pptx'
        ? Number(inspected.slideCount) || 0
        : kind === 'excel'
        ? Number(inspected.sheetCount) || 0
        : Number(inspected.pageCount) || 0;
      if (totalBytes > MAX_MERGE_INPUT_BYTES) throw new Error('선택한 문서의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
      const metadata = {
        ...inspected,
        key: this.documentMergeFileKey(kind, filePath)
      };
      // Every selected row owns its selection-time identity. Re-selecting a
      // file after editing it must not silently re-authorize an older row.
      const token = this.issueToken(ownerId, this.documentMergeTokenKind(kind), filePath, metadata, { reuse: false });
      const tokenEntry = this.resolveToken(ownerId, token, this.documentMergeTokenKind(kind));
      tokenEntry.metadata = metadata;
      files.push(this.documentMergePublicMetadata(kind, token, tokenEntry));
    }

    return {
      canceled: false,
      kind,
      files,
      sourceCount: files.length,
      totalBytes,
      ...(kind === 'pdf' ? { pageCount: totalUnits } : (isDocuments ? {
        mode: DOCUMENTS_MERGE_MODE,
        purpose: 'print-share',
        editable: false,
        outputExtension: 'pdf',
        knownPdfPageCount: totalUnits
      } : kind === 'pptx'
        ? { slideCount: totalUnits }
        : kind === 'word'
        ? { pageCount: totalUnits }
        : { sheetCount: totalUnits }))
    };
  }

  async documentMergeDocumentsReadiness(inputs) {
    const sourceInputs = inputs.filter((input) => input.extension !== 'pdf');
    if (!sourceInputs.length) {
      return {
        availability: {
          supported: true,
          available: true,
          ready: true,
          blocked: false,
          preparation: null,
          targetExtension: 'pdf',
          routes: [],
          requiredDependencies: [],
          missingDependencies: []
        },
        preparationPlan: null,
        requiredDependencies: [],
        missingDependencies: [],
        runningDependencies: [],
        requiredFonts: [],
        fontReports: [],
        inspectorRequiredDependencies: [],
        inspectionUnavailable: [],
        requiresPreview: false,
        routes: []
      };
    }
    const routes = sourceInputs.map((input) => DocumentConversion.selectConversionRoute(input.extension, 'pdf'));
    if (routes.some((route) => !route || route.policy !== 'strict' || route.automaticFallback)) {
      const error = new Error('문서를 PDF로 바꾸는 엄격 변환 경로를 확인하지 못했습니다.');
      error.code = 'DOCUMENT_CONVERSION_ROUTE_UNSUPPORTED';
      throw error;
    }
    const status = await this.capabilities();
    const routeAvailability = DocumentConversion.getBatchConversionAvailability(
      sourceInputs.map((input) => input.extension),
      'pdf',
      status
    );
    const fontRequirements = await this.documentFontRequirements(sourceInputs);
    const inspectorDependencies = fontRequirements.inspectorRequiredDependencies.map((dependencyId) => (
      this.documentInspectorDependencyAvailability(dependencyId, status)
    ));
    const missingInspectorDependencies = inspectorDependencies.filter((item) => item.blocked);
    const requiredDependencies = [...new Set([
      ...routes.map((route) => route.requiredDependency),
      ...fontRequirements.inspectorRequiredDependencies
    ])];
    const runningDependencies = requiredDependencies.filter((dependencyId) => status.dependencies?.[dependencyId]?.running);
    const missingDependencies = [...routeAvailability.missingDependencies, ...missingInspectorDependencies];
    const blocked = missingDependencies.length > 0 || runningDependencies.length > 0 || fontRequirements.requiredFonts.length > 0;
    const availability = {
      ...routeAvailability,
      available: !blocked,
      ready: !blocked,
      blocked,
      runningBlocked: runningDependencies.length > 0,
      fontBlocked: fontRequirements.requiredFonts.length > 0,
      inspectorBlocked: missingInspectorDependencies.length > 0,
      requiredDependencies,
      missingDependencies,
      runningDependencies,
      missingFonts: [...fontRequirements.requiredFonts],
      inspectionUnavailable: fontRequirements.inspectionUnavailable,
      requiresPreview: fontRequirements.requiresPreview
    };
    const preparationPlan = missingDependencies.length || fontRequirements.requiredFonts.length
      ? this.dependencyPreparationForRoutes(
        routes,
        status,
        fontRequirements.requiredFonts,
        fontRequirements.inspectorRequiredDependencies
      )
      : null;
    return {
      availability,
      preparationPlan,
      requiredDependencies,
      missingDependencies,
      runningDependencies,
      requiredFonts: fontRequirements.requiredFonts,
      fontReports: fontRequirements.reports,
      inspectorRequiredDependencies: fontRequirements.inspectorRequiredDependencies,
      inspectionUnavailable: fontRequirements.inspectionUnavailable,
      requiresPreview: fontRequirements.requiresPreview,
      routes
    };
  }

  async inspectDocumentMergeFiles(ownerId, payload = {}, internal = {}) {
    const kind = normalizeDocumentToolsMergeKind(payload.kind);
    const isDocuments = kind === DOCUMENTS_MERGE_KIND;
    const isNativeOffice = NATIVE_OFFICE_MERGE_KIND_SET.has(kind);
    if (isNativeOffice && internal.nativeInspectionQueued !== true) {
      return this.enqueue(`document-merge-${kind}-inspect`, ownerId, `inspect-${crypto.randomUUID()}`, async (_jobId, control) => (
        this.inspectDocumentMergeFiles(ownerId, payload, { nativeInspectionQueued: true, control })
      ));
    }
    const fileTokens = Array.isArray(payload.fileTokens) ? payload.fileTokens.map((item) => String(item?.token || item || '')) : [];
    if (!fileTokens.length || fileTokens.length > MAX_MERGE_FILES) throw new Error('확인할 문서를 1개 이상, 500개 이하로 선택해주세요.');
    const files = [];
    const tokenOccurrences = new Map();
    const readinessInputs = [];
    let totalBytes = 0;
    let totalUnits = 0;
    for (let index = 0; index < fileTokens.length; index += 1) {
      internal.control?.throwIfCancelled();
      const token = fileTokens[index];
      const entry = this.resolveToken(ownerId, token, this.documentMergeTokenKind(kind));
      const selectedSourceSha256 = entry.metadata?.sourceSha256;
      const selectedSourceRealPath = entry.metadata?.sourceRealPath;
      const inspected = await this.inspectDocumentMergeEntry(kind, entry.filePath);
      if (isNativeOffice && (
        (selectedSourceSha256 && inspected.sourceSha256 !== selectedSourceSha256)
        || (selectedSourceRealPath && path.resolve(inspected.sourceRealPath) !== path.resolve(selectedSourceRealPath))
      )) {
        const error = new Error(`“${path.basename(entry.filePath)}” 파일이 선택 후 바뀌었습니다. 현재 파일을 다시 선택해주세요.`);
        error.code = 'NATIVE_OFFICE_MERGE_INPUT_CHANGED';
        throw error;
      }
      totalBytes += inspected.bytes;
      totalUnits += kind === 'pptx'
        ? Number(inspected.slideCount) || 0
        : kind === 'excel'
        ? Number(inspected.sheetCount) || 0
        : Number(inspected.pageCount) || 0;
      entry.metadata = { ...inspected, key: entry.metadata?.key || this.documentMergeFileKey(kind, entry.filePath) };
      const occurrence = (tokenOccurrences.get(token) || 0) + 1;
      tokenOccurrences.set(token, occurrence);
      files.push(this.documentMergePublicMetadata(kind, token, entry, `${token}:${occurrence}`));
      if (isDocuments || isNativeOffice) readinessInputs.push({ token, entry, extension: inspected.extension });
    }
    if (totalBytes > MAX_MERGE_INPUT_BYTES) throw new Error('선택한 문서의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
    let readiness = null;
    let nativeInspectionRoot = '';
    try {
      let effectiveReadinessInputs = readinessInputs;
      if (isNativeOffice) {
        nativeInspectionRoot = await makeJobDirectory();
        effectiveReadinessInputs = [];
        for (let index = 0; index < readinessInputs.length; index += 1) {
          internal.control?.throwIfCancelled();
          const input = readinessInputs[index];
          const extension = String(input.extension || '').toLowerCase();
          const expectedSha256 = input.entry.metadata?.sourceSha256;
          const snapshotPath = path.join(nativeInspectionRoot, `inspection-${String(index + 1).padStart(4, '0')}.${extension}`);
          const validateSnapshot = async (filePath) => {
            const sourceInspection = await NativeOfficeMerge.inspectNativeOfficeMergeSources(
              kind,
              [filePath],
              { allowSingle: true }
            );
            const source = sourceInspection.sources[0];
            if (expectedSha256 && source?.sha256 !== expectedSha256) {
              const error = new Error(`“${path.basename(input.entry.filePath)}” 파일이 검사 준비 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.`);
              error.code = 'NATIVE_OFFICE_MERGE_INPUT_CHANGED';
              throw error;
            }
            return source;
          };
          await this.copyValidatedExclusive(input.entry.filePath, snapshotPath, {
            validateSource: validateSnapshot,
            validateDestination: validateSnapshot
          });
          effectiveReadinessInputs.push({
            token: input.token,
            extension,
            entry: {
              filePath: snapshotPath,
              metadata: {
                ...input.entry.metadata,
                sourceRealPath: snapshotPath,
                sourceSha256: expectedSha256
              }
            }
          });
        }
      }
      readiness = isDocuments
        ? await this.documentMergeDocumentsReadiness(readinessInputs)
        : isNativeOffice
        ? await this.documentMergeNativeOfficeReadiness(kind, effectiveReadinessInputs)
        : null;
      if (isNativeOffice) {
        const selectedNameByToken = new Map(readinessInputs.map((input) => [input.token, path.basename(input.entry.filePath)]));
        for (const field of ['compatibilityInputs', 'fontReports', 'inspectionUnavailable']) {
          if (!Array.isArray(readiness[field])) continue;
          readiness[field] = readiness[field].map((item) => ({
            ...item,
            name: selectedNameByToken.get(item.token) || item.name
          }));
        }
      }
      if (isNativeOffice && readiness.applicationReady) {
        const nativeInspectionTargets = effectiveReadinessInputs
          .map((input, originalIndex) => ({ input, originalIndex }))
          .filter(({ input }) => !(
            kind === 'excel'
            && input.extension === 'xlsx'
            && input.entry.metadata?.structureInspectionEngine === 'ooxml'
          ));
        internal.control?.throwIfCancelled();
        if (nativeInspectionTargets.length) {
          const nativeInspection = await this.inspectNativeOfficeMergeEntries(
            kind,
            nativeInspectionTargets.map(({ input }) => input),
            () => {},
            { isCancelled: internal.control?.isCancelled }
          );
          nativeInspection.files.forEach((inspected, inspectionIndex) => {
            const originalIndex = nativeInspectionTargets[inspectionIndex].originalIndex;
            const input = readinessInputs[originalIndex];
            const selectedMetadata = input.entry.metadata;
            input.entry.metadata = {
              ...selectedMetadata,
              ...inspected,
              name: selectedMetadata.name,
              bytes: selectedMetadata.bytes,
              extension: selectedMetadata.extension,
              sourceRealPath: selectedMetadata.sourceRealPath,
              sourceSha256: selectedMetadata.sourceSha256,
              key: selectedMetadata.key || this.documentMergeFileKey(kind, input.entry.filePath)
            };
            files[originalIndex] = this.documentMergePublicMetadata(
              kind,
              fileTokens[originalIndex],
              input.entry,
              files[originalIndex].itemId
            );
          });
        }
        totalUnits = files.reduce((sum, file) => (
          sum + (kind === 'word' ? Number(file.pageCount) || 0 : Number(file.sheetCount) || 0)
        ), 0);
      }
    } finally {
      if (nativeInspectionRoot) {
        try { await removeGeneratedDirectory(nativeInspectionRoot); }
        catch (cleanupError) { console.error('Word/Excel 검사 임시 작업 폴더 정리 실패:', cleanupError); }
      }
    }
    return {
      kind,
      files,
      sourceCount: files.length,
      totalBytes,
      ...(kind === 'pdf' ? { pageCount: totalUnits } : (isDocuments ? {
        mode: DOCUMENTS_MERGE_MODE,
        purpose: 'print-share',
        editable: false,
        outputExtension: 'pdf',
        knownPdfPageCount: totalUnits,
        ...readiness
      } : kind === 'pptx'
        ? { slideCount: totalUnits }
        : kind === 'word'
        ? { pageCount: totalUnits, ...readiness }
        : { sheetCount: totalUnits, ...readiness }))
    };
  }

  async chooseOutputDirectory(ownerId, parentWindow) {
    const result = await this.dialog.showOpenDialog(parentWindow, { title: '결과를 저장할 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const directoryIdentity = await this.inspectDocumentSplitOutputDirectoryIdentity(result.filePaths[0]);
    const directory = directoryIdentity.realPath;
    const token = this.issueToken(ownerId, 'output-directory', directory, { directoryIdentity });
    const entry = this.resolveToken(ownerId, token, 'output-directory');
    // Re-selecting a folder is an explicit authorization for its current object,
    // even when its canonical path reuses an older capability token.
    entry.filePath = directory;
    entry.metadata = { ...(entry.metadata || {}), directoryIdentity };
    return { canceled: false, token, name: path.basename(directory) || directory };
  }

  async openOutputDirectory(ownerId, token) {
    const directory = this.resolveToken(ownerId, token, 'output-directory').filePath;
    const error = await this.shell.openPath(directory);
    if (error) throw new Error(error);
    return { ok: true };
  }

  async openOutputFile(ownerId, token) {
    const entry = this.resolveToken(ownerId, token, 'output-file');
    const filePath = entry.filePath;
    const extension = path.extname(filePath).toLowerCase();
    if (!OPENABLE_DOCUMENT_OUTPUT_EXTENSIONS.includes(extension)) {
      throw new Error('지원하는 문서 변환 결과 파일만 열 수 있습니다.');
    }
    let stats;
    try { stats = await fs.promises.stat(filePath); }
    catch (_) { throw new Error('결과 파일을 찾을 수 없습니다. 작업을 다시 실행해주세요.'); }
    if (!stats.isFile()) throw new Error('결과 파일을 찾을 수 없습니다. 작업을 다시 실행해주세요.');
    const expectedIdentity = entry.metadata?.outputIdentity;
    if (expectedIdentity) {
      let currentIdentity;
      try { currentIdentity = await this.inspectOutputFileIdentity(filePath); }
      catch (_) {
        this.revokeToken(ownerId, token);
        throw new Error('결과 파일을 찾을 수 없습니다. 작업을 다시 실행해주세요.');
      }
      if (!this.sameOutputFileIdentity(expectedIdentity, currentIdentity, true)) {
        this.revokeToken(ownerId, token);
        throw new Error('저장한 뒤 결과 파일이 바뀌었습니다. 안전을 위해 이 미리보기를 종료했으니 작업을 다시 실행해주세요.');
      }
    }
    const error = await this.shell.openPath(filePath);
    if (error) throw new Error(error);
    return { ok: true };
  }

  async chooseCertificateTemplate(ownerId, parentWindow) {
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: '템플릿 문서 PowerPoint 양식 선택',
      properties: ['openFile'],
      filters: [{ name: 'PowerPoint PPTX', extensions: ['pptx'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const inspected = await inspectPptxFile(result.filePaths[0]);
    const certificatePdfReadiness = await this.certificatePdfReadiness(inspected);
    return {
      canceled: false,
      token: this.issueToken(ownerId, 'certificate-template', inspected.sourcePath),
      name: inspected.sourceName,
      bytes: inspected.sourceBytes,
      slideCount: inspected.slideCount,
      slideSize: inspected.slideSize,
      fontReport: certificatePdfReadiness.fontReport,
      certificatePdfReadiness,
      requiredFonts: certificatePdfReadiness.requiredFonts,
      preparationPlan: certificatePdfReadiness.preparationPlan,
      slides: inspected.slides.map((slide) => ({ number: slide.number, blockCount: slide.blockCount, visibleBlockCount: slide.visibleBlockCount ?? slide.blockCount, blocks: slide.blocks }))
    };
  }

  async chooseCertificateData(parentWindow) {
    const result = await this.dialog.showOpenDialog(parentWindow, {
      title: '템플릿 문서 데이터 가져오기',
      properties: ['openFile'],
      filters: [
        { name: 'Excel 또는 CSV', extensions: ['xlsx', 'xlsm', 'csv', 'tsv'] },
        { name: '모든 파일', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, sheets: [] };
    const filePath = result.filePaths[0];
    const extension = path.extname(filePath).toLowerCase();
    if (['.xlsx', '.xlsm'].includes(extension)) {
      const sheets = await readWorkbookSheets(filePath);
      const selectedSheet = sheets.find((sheet) => Array.isArray(sheet.matrix) && sheet.matrix.some((row) => Array.isArray(row) && row.some((value) => String(value ?? '').trim()))) || sheets[0];
      const normalizedSheet = selectedSheet ? { name: selectedSheet.name, matrix: normalizeImportedMatrix(selectedSheet.matrix) } : null;
      return { canceled: false, name: path.basename(filePath), sheetCount: sheets.length, sheets: normalizedSheet ? [normalizedSheet] : [] };
    }
    if (!['.csv', '.tsv'].includes(extension)) throw new Error('XLSX, XLSM, CSV, TSV 파일만 가져올 수 있습니다.');
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_CSV_BYTES) throw new Error('CSV·TSV 파일은 20MB 이하만 가져올 수 있습니다.');
    const source = decodeDelimitedFile(await fs.promises.readFile(filePath));
    const matrix = normalizeImportedMatrix(parseDelimitedText(source, extension === '.tsv' ? '\t' : ','));
    return { canceled: false, name: path.basename(filePath), sheets: [{ name: path.parse(filePath).name, matrix }] };
  }

  enqueue(label, ownerId, requestId, operation) {
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      label: boundedText(label, 80),
      ownerId,
      requestId: boundedText(requestId, 80),
      cancelled: false,
      ownerReleased: false,
      status: 'queued'
    };
    const control = {
      isCancelled: () => job.cancelled,
      throwIfCancelled: () => { if (job.cancelled) throw documentJobCancelledError(); },
      beginCommit: () => {
        if (job.cancelled) throw documentJobCancelledError();
        job.status = 'committing';
      }
    };
    this.activeJobs.set(jobId, job);
    const execute = async () => {
      job.status = 'running';
      try {
        control.throwIfCancelled();
        const result = await operation(jobId, control);
        control.throwIfCancelled();
        return result;
      } catch (error) {
        if (job.cancelled && error?.code !== 'DOCUMENT_TOOL_CANCELLED') throw documentJobCancelledError();
        throw error;
      }
      finally {
        this.activeJobs.delete(jobId);
        if (job.ownerReleased) {
          const tokens = this.ownerTokens.get(ownerId) || [];
          for (const token of tokens) this.tokens.delete(token);
          this.ownerTokens.delete(ownerId);
          this.ownerCleanup.delete(ownerId);
        }
      }
    };
    const queued = this.operationChain.then(execute, execute);
    this.operationChain = queued.catch(() => {});
    return queued;
  }

  cancelJob(ownerId, requestId) {
    const key = boundedText(requestId, 80);
    if (!key) throw new Error('중단할 문서 작업 정보가 올바르지 않습니다.');
    const job = [...this.activeJobs.values()].find((item) => item.ownerId === ownerId && (item.requestId === key || item.id === key));
    if (!job) return { ok: false, finished: true };
    // Once a validated result starts publishing, cancellation would make the
    // caller see a failure even though a complete file may already exist.
    // Treat that short final copy/token window as an atomic commit instead.
    if (job.status === 'committing') return { ok: false, committing: true, jobId: job.id, status: job.status };
    job.cancelled = true;
    return { ok: true, jobId: job.id, status: job.status };
  }

  async prepareDocumentDependencies(ownerId, payload = {}, progress = () => {}) {
    if (payload.approved !== true && payload.userConfirmed !== true) {
      const error = new Error('문서 도구 준비는 사용자가 명시적으로 승인한 뒤에만 실행할 수 있습니다.');
      error.code = 'DOCUMENT_DEPENDENCY_CONFIRMATION_REQUIRED';
      throw error;
    }
    const applicationValues = payload.requiredApplications ?? payload.requiredDependencies;
    const requiredApplications = [...new Set((Array.isArray(applicationValues) ? applicationValues : []).map(String))];
    const requiredFonts = [...new Set((Array.isArray(payload.requiredFonts) ? payload.requiredFonts : []).map(String))];
    if (!requiredApplications.length && !requiredFonts.length) {
      throw new Error('준비할 문서 프로그램 또는 글꼴을 선택해주세요.');
    }
    if (requiredApplications.length > DocumentDependencies.DEPENDENCY_IDS.length || requiredFonts.length > 100) {
      throw new Error('한 번에 준비할 문서 프로그램 또는 글꼴이 너무 많습니다.');
    }
    const allowedDependencies = new Set(DocumentDependencies.DEPENDENCY_IDS);
    if (requiredApplications.some((dependencyId) => !allowedDependencies.has(dependencyId))) {
      const error = new Error('지원하지 않는 문서 프로그램 준비 요청입니다.');
      error.code = 'DOCUMENT_DEPENDENCY_UNSUPPORTED';
      throw error;
    }

    return this.enqueue('document-dependency-prepare', ownerId, payload.requestId, async (jobId, control) => {
      control.throwIfCancelled();
      const [status, installedFontFamilies] = await Promise.all([
        this.capabilities(true),
        this.installedFontFamilies()
      ]);
      const plan = DocumentDependencies.planDocumentDependencies({
        platform: process.platform,
        architecture: process.arch,
        requiredApplications,
        requiredFonts,
        availability: {
          ...(status.dependencies || {}),
          libreOffice: status.libreOffice,
          rhwp: status.compatibleFallbacks?.rhwp?.available === true
        },
        installedFontFamilies
      }, this.dependencyManifest);
      const requestedActionIds = payload.confirmedActionIds ?? payload.actionIds;
      const confirmedActionIds = [...new Set((Array.isArray(requestedActionIds)
        ? requestedActionIds
        : plan.actions.map((action) => action.id)).map(String))];
      const actionById = new Map(plan.actions.map((action) => [action.id, action]));
      if (confirmedActionIds.some((actionId) => !actionById.has(actionId))) {
        const error = new Error('현재 준비 계획에 없는 작업은 실행할 수 없습니다.');
        error.code = 'DOCUMENT_DEPENDENCY_ACTION_NOT_PLANNED';
        throw error;
      }
      if (!confirmedActionIds.length) {
        return { jobId, ok: plan.unresolved.length === 0, alreadyReady: plan.actions.length === 0, actions: [], unresolved: plan.unresolved };
      }

      const installer = this.getDependencyInstaller();
      if (!installer) {
        const error = new Error('문서 프로그램 자동 준비 실행기를 찾을 수 없습니다.');
        error.code = 'DOCUMENT_DEPENDENCY_INSTALLER_MISSING';
        throw error;
      }
      progress({ jobId, phase: 'start', total: confirmedActionIds.length });
      let rawResult;
      if (typeof installer.executePlan === 'function') {
        rawResult = await installer.executePlan(plan, { confirmedActionIds });
      } else if (typeof installer.executeAction === 'function') {
        const results = [];
        for (const actionId of confirmedActionIds) {
          control.throwIfCancelled();
          const result = await installer.executeAction(actionById.get(actionId), { userConfirmed: true });
          results.push({ actionId, ...result });
        }
        rawResult = { results };
      } else {
        const error = new Error('문서 프로그램 자동 준비 실행기 API가 올바르지 않습니다.');
        error.code = 'DOCUMENT_DEPENDENCY_INSTALLER_INVALID';
        throw error;
      }
      control.throwIfCancelled();
      const rawResults = Array.isArray(rawResult) ? rawResult : (Array.isArray(rawResult?.results) ? rawResult.results : []);
      const publicResults = confirmedActionIds.map((actionId, index) => {
        const action = actionById.get(actionId);
        const raw = rawResults.find((item) => item?.actionId === actionId || item?.id === actionId) || rawResults[index] || {};
        const statusValue = boundedText(raw.status, 80, raw.ok === false ? 'failed' : 'complete')
          .replace(/[^A-Za-z0-9_.-]/g, '') || (raw.ok === false ? 'failed' : 'complete');
        const publicResult = {
          actionId,
          type: action.type,
          ok: raw.ok !== false,
          status: statusValue
        };
        if (raw.restartRequired === true) publicResult.restartRequired = true;
        if (raw.applicationRestartRecommended === true) publicResult.applicationRestartRecommended = true;
        if (raw.runtimeRegistered === true) publicResult.runtimeRegistered = true;
        return publicResult;
      });
      this.cachedCapabilities = null;
      this.cachedInstalledFonts = null;
      const response = {
        jobId,
        ok: publicResults.every((item) => item.ok),
        openedOfficialInstaller: publicResults.some((item) => item.ok && item.type === 'officialInstaller'),
        openedOfficialSource: publicResults.some((item) => item.ok
          && (item.type === 'officialInstaller' || item.type === 'officialFontSource'
            || item.type === 'officialHancomAutomationGuide')),
        requiresUserAction: confirmedActionIds.some((actionId) => actionById.get(actionId)?.automatic === false),
        restartRequired: publicResults.some((item) => item.restartRequired),
        applicationRestartRecommended: publicResults.some((item) => item.applicationRestartRecommended),
        runtimeRegistered: publicResults.some((item) => item.runtimeRegistered),
        actions: publicResults,
        unresolved: plan.unresolved.map((item) => ({
          kind: item.kind,
          id: item.id,
          reasonCode: item.reasonCode,
          preparation: item.preparation
        }))
      };
      progress({
        jobId,
        phase: 'complete',
        total: publicResults.length,
        completed: publicResults.filter((item) => item.ok).length,
        failed: publicResults.filter((item) => !item.ok).length
      });
      return response;
    });
  }

  async chooseAndInstallUserFont(ownerId, browserWindow, payload = {}) {
    if (payload.userConfirmed !== true && payload.approved !== true) {
      const error = new Error('선택한 글꼴 파일 설치는 사용자가 직접 눌러 승인해야 합니다.');
      error.code = 'DOCUMENT_FONT_CONFIRMATION_REQUIRED';
      throw error;
    }
    const expectedFamily = String(payload.expectedFamily ?? payload.family ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!expectedFamily || expectedFamily.length > 256 || /[\p{Cc}\p{Cf}]/u.test(expectedFamily)) {
      const error = new Error('설치할 글꼴 가족 이름이 올바르지 않습니다.');
      error.code = 'DOCUMENT_FONT_FAMILY_INVALID';
      throw error;
    }
    if (!this.dialog || typeof this.dialog.showOpenDialog !== 'function') {
      const error = new Error('글꼴 설치 파일 선택 창을 열 수 없습니다.');
      error.code = 'DOCUMENT_FONT_DIALOG_UNAVAILABLE';
      throw error;
    }
    const chosen = await this.dialog.showOpenDialog(browserWindow, {
      title: `${expectedFamily} 정식 글꼴 파일 선택`,
      properties: ['openFile'],
      filters: [
        { name: 'TrueType·OpenType 글꼴', extensions: ['ttf', 'otf', 'ttc'] }
      ]
    });
    if (chosen.canceled || !chosen.filePaths?.[0]) return { canceled: true, family: expectedFamily };
    if (!this.acceptingUserFontCommits) {
      const error = new Error('앱 종료를 준비하는 동안에는 새 글꼴 설치를 시작할 수 없습니다. 종료가 취소되면 다시 시도해주세요.');
      error.code = 'DOCUMENT_FONT_SHUTDOWN_DRAIN';
      throw error;
    }
    const installer = this.getUserFontFileInstaller();
    if (!installer || typeof installer.installFontFile !== 'function') {
      const error = new Error('이 Windows 사용자에게 글꼴을 안전하게 설치하는 기능을 찾을 수 없습니다.');
      error.code = 'DOCUMENT_FONT_INSTALLER_MISSING';
      throw error;
    }
    const selectedPath = path.resolve(chosen.filePaths[0]);
    const commit = (async () => {
      const installed = await installer.installFontFile({ filePath: selectedPath, expectedFamily });
      this.cachedInstalledFonts = null;
      this.cachedCapabilities = null;
      const detectedFamilies = await this.installedFontFamilies();
      const detected = missingFontFamilies([expectedFamily], [], detectedFamilies).length === 0;
      return {
        canceled: false,
        installed: installed?.installed === true,
        alreadyInstalled: installed?.alreadyInstalled === true,
        family: expectedFamily,
        detected,
        runtimeRegistered: installed?.runtimeRegistered === true,
        applicationRestartRecommended: !detected,
        container: ['sfnt', 'ttc'].includes(installed?.container) ? installed.container : 'sfnt'
      };
    })();
    this.inFlightUserFontCommits.add(commit);
    try { return await commit; }
    finally { this.inFlightUserFontCommits.delete(commit); }
  }

  requestShutdownDrain() { this.acceptingUserFontCommits = false; }

  resumeAfterShutdownAbort() { this.acceptingUserFontCommits = true; }

  async waitForIdle() {
    while (true) {
      const operationChain = this.operationChain;
      const fontCommits = [...this.inFlightUserFontCommits];
      await Promise.allSettled([operationChain, ...fontCommits]);
      if (operationChain === this.operationChain && this.inFlightUserFontCommits.size === 0) return;
    }
  }

  async availableOutputBase(directory, requestedStem, extensions, reserved = new Set()) {
    const stem = safeOutputStem(requestedStem, '파일');
    for (let index = 0; index < 10_000; index += 1) {
      const candidate = index ? `${stem} (${index + 1})` : stem;
      const key = candidate.toLocaleLowerCase('ko-KR');
      if (reserved.has(key)) continue;
      const paths = extensions.map((extension) => path.join(directory, `${candidate}.${extension}`));
      const exists = (await Promise.all(paths.map(async (filePath) => {
        try { await fs.promises.access(filePath, fs.constants.F_OK); return true; } catch (_) { return false; }
      }))).some(Boolean);
      if (!exists) { reserved.add(key); return { stem: candidate, paths: Object.fromEntries(extensions.map((extension) => [extension, path.join(directory, `${candidate}.${extension}`)])) }; }
    }
    throw new Error('겹치지 않는 출력 파일 이름을 만들 수 없습니다.');
  }

  async inspectOutputFileHandle(handle, expectedStats = null) {
    const initialStats = await handle.stat();
    if (!initialStats.isFile() || initialStats.size <= 0) {
      throw convertedZipError('DOCUMENT_OUTPUT_EMPTY', '변환 결과 파일이 비어 있습니다.');
    }
    if (initialStats.size > MAX_DOCUMENT_SOURCE_BYTES) {
      throw convertedZipError('DOCUMENT_OUTPUT_TOO_LARGE', '변환 결과 파일이 512MB를 넘어 안전하게 저장할 수 없습니다.');
    }
    if (expectedStats && !sameOutputFileStats(expectedStats, initialStats)) {
      throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < initialStats.size) {
      const bytesToRead = Math.min(buffer.length, initialStats.size - position);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) {
        throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalStats = await handle.stat();
    if (!sameOutputFileStats(initialStats, finalStats)) {
      throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
    }
    return { stats: initialStats, bytes: initialStats.size, sha256: hash.digest('hex') };
  }

  async inspectOutputFileIdentity(filePath) {
    const handle = await fs.promises.open(filePath, 'r');
    try { return await this.inspectOutputFileHandle(handle); }
    finally { await handle.close(); }
  }

  async issueOutputFileToken(ownerId, filePath, outputIdentity = null) {
    const identity = outputIdentity || await this.inspectOutputFileIdentity(filePath);
    return this.issueToken(ownerId, 'output-file', filePath, { outputIdentity: identity }, { reuse: false });
  }

  sameOutputFileIdentity(expected, actual, compareFileStats = true) {
    return Boolean(expected && actual
      && expected.bytes === actual.bytes
      && expected.sha256 === actual.sha256
      && (!compareFileStats || sameOutputFileStats(expected.stats, actual.stats)));
  }

  sameOutputFileObject(expectedStats, actualStats) {
    if (!expectedStats?.isFile?.() || !actualStats?.isFile?.()) return false;
    if (Number.isFinite(expectedStats.ino) && Number.isFinite(actualStats.ino)
      && expectedStats.ino !== 0 && actualStats.ino !== 0) {
      return expectedStats.dev === actualStats.dev && expectedStats.ino === actualStats.ino;
    }
    return Number.isFinite(expectedStats.birthtimeMs)
      && expectedStats.birthtimeMs === actualStats.birthtimeMs;
  }

  async cleanupOwnedOutput(filePath, ownedStats, label = '검증 실패 결과 파일 정리 실패:') {
    if (!ownedStats) return;
    try {
      const currentStats = await fs.promises.stat(filePath);
      if (this.sameOutputFileObject(ownedStats, currentStats)) await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(label, error);
    }
  }

  async copyValidatedExclusive(sourcePath, destinationPath, options = {}) {
    const validateSource = options.validateSource;
    const validateDestination = options.validateDestination || validateSource;
    if (typeof validateSource !== 'function' || typeof validateDestination !== 'function') {
      throw new TypeError('검증된 결과 복사에는 원본과 저장본 검사 함수가 필요합니다.');
    }

    const sourceIdentity = await this.inspectOutputFileIdentity(sourcePath);
    const sourceValidation = await validateSource(sourcePath);
    let sourceHandle = null;
    let destinationHandle = null;
    let createdStats = null;
    let destinationValidation;
    let destinationIdentity;
    let operationError = null;
    try {
      sourceHandle = await fs.promises.open(sourcePath, 'r');
      const openedSourceStats = await sourceHandle.stat();
      if (!sameOutputFileStats(sourceIdentity.stats, openedSourceStats)) {
        throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검사 후 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
      }
      destinationHandle = await fs.promises.open(destinationPath, 'wx+');
      createdStats = await destinationHandle.stat();

      const copiedHash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let position = 0;
      while (position < sourceIdentity.bytes) {
        const bytesToRead = Math.min(buffer.length, sourceIdentity.bytes - position);
        const { bytesRead } = await sourceHandle.read(buffer, 0, bytesToRead, position);
        if (bytesRead <= 0) {
          throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '복사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
        }
        let written = 0;
        while (written < bytesRead) {
          const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
          if (result.bytesWritten <= 0) throw new Error('변환 결과 파일을 저장하지 못했습니다.');
          written += result.bytesWritten;
        }
        copiedHash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const copiedSourceStats = await sourceHandle.stat();
      if (!sameOutputFileStats(sourceIdentity.stats, copiedSourceStats)
        || copiedHash.digest('hex') !== sourceIdentity.sha256) {
        throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '복사 중 변환 결과 파일이 바뀌어 저장을 중단했습니다.');
      }
      await destinationHandle.sync();
      destinationValidation = await validateDestination(destinationPath, sourceValidation);
      destinationIdentity = await this.inspectOutputFileHandle(destinationHandle);
      const [sourcePathStats, destinationPathStats] = await Promise.all([
        fs.promises.stat(sourcePath),
        fs.promises.stat(destinationPath)
      ]);
      if (!sameOutputFileStats(sourceIdentity.stats, sourcePathStats)
        || !this.sameOutputFileIdentity(sourceIdentity, destinationIdentity, false)) {
        throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '검증한 변환 결과와 저장된 파일이 달라 저장을 중단했습니다.');
      }
      if (!sameOutputFileStats(destinationIdentity.stats, destinationPathStats)) {
        throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '저장 확인 중 결과 파일이 바뀌어 완료 처리를 중단했습니다.');
      }
    } catch (error) {
      operationError = error;
    }

    const closeResults = await Promise.allSettled([
      sourceHandle?.close(),
      destinationHandle?.close()
    ].filter(Boolean));
    if (!operationError) {
      const closeFailure = closeResults.find((result) => result.status === 'rejected');
      if (closeFailure) operationError = closeFailure.reason;
    }
    if (operationError) {
      await this.cleanupOwnedOutput(destinationPath, createdStats);
      throw operationError;
    }

    let commitResult;
    let commitHandle = null;
    let commitSucceeded = false;
    try {
      commitHandle = await fs.promises.open(destinationPath, 'r');
      const commitHandleStats = await commitHandle.stat();
      const commitPathStats = await fs.promises.stat(destinationPath);
      if (!sameOutputFileStats(destinationIdentity.stats, commitHandleStats)
        || !sameOutputFileStats(destinationIdentity.stats, commitPathStats)) {
        throw convertedZipError('DOCUMENT_OUTPUT_CHANGED', '저장 확인 후 결과 파일이 바뀌어 완료 처리를 중단했습니다.');
      }
      commitResult = typeof options.commitDestination === 'function'
        ? await options.commitDestination(destinationPath, destinationIdentity)
        : undefined;
      commitSucceeded = true;
    } catch (error) {
      operationError = error;
    } finally {
      if (commitHandle) {
        try { await commitHandle.close(); }
        catch (error) {
          if (!commitSucceeded && !operationError) operationError = error;
          else console.error('검증된 결과 파일 핸들 닫기 실패:', error);
        }
      }
    }
    if (operationError) {
      await this.cleanupOwnedOutput(destinationPath, createdStats);
      throw operationError;
    }

    return {
      sourceValidation,
      destinationValidation,
      destinationPath,
      destinationStats: destinationIdentity.stats,
      destinationIdentity,
      commitResult
    };
  }

  async copyValidatedToAvailableOutput(sourcePath, directory, requestedStem, extension, options = {}) {
    const defaultStems = { pdf: '합친 PDF', pptx: '합친 PowerPoint', docx: '합친 Word 문서', xlsx: '합친 Excel 파일' };
    const stem = safeOutputStem(
      String(requestedStem || '').replace(new RegExp(`\\.${extension}$`, 'i'), ''),
      defaultStems[extension] || '합친 문서'
    );
    for (let index = 0; index < 10_000; index += 1) {
      const candidate = index ? `${stem} (${index + 1})` : stem;
      const destination = path.join(directory, `${candidate}.${extension}`);
      try {
        return await this.copyValidatedExclusive(sourcePath, destination, options);
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new Error('겹치지 않는 출력 파일 이름을 만들 수 없습니다.');
  }

  async mergeDocumentsToPdf(ownerId, payload = {}, progress = () => {}) {
    const fileTokens = Array.isArray(payload.fileTokens)
      ? payload.fileTokens.map((item) => String(item?.token || item || ''))
      : [];
    if (fileTokens.length < MIN_MERGE_FILES || fileTokens.length > MAX_MERGE_FILES) {
      throw new Error('PDF로 합칠 문서를 2개 이상, 500개 이하로 선택해주세요.');
    }
    const tokenKind = this.documentMergeTokenKind(DOCUMENTS_MERGE_KIND);
    // Preserve both order and intentional repeats. A repeated capability means
    // the source should appear repeatedly in the final PDF.
    const sourceEntries = fileTokens.map((token) => ({
      token,
      entry: this.resolveToken(ownerId, token, tokenKind)
    }));
    const outputDirectory = this.resolveToken(ownerId, payload.outputToken, 'output-directory').filePath;
    const outputStats = await fs.promises.stat(outputDirectory);
    if (!outputStats.isDirectory()) throw new Error('결과 폴더를 찾을 수 없습니다. 다시 선택해주세요.');
    const requestedStem = boundedText(payload.outputName, 160, '통합 문서');

    return this.enqueue('document-merge-documents', ownerId, payload.requestId, async (jobId, control) => {
      const inputs = [];
      let inputBytes = 0;
      let knownPdfPageCount = 0;
      for (let index = 0; index < sourceEntries.length; index += 1) {
        control.throwIfCancelled();
        const source = sourceEntries[index];
        const inspected = await this.inspectDocumentMergeEntry(DOCUMENTS_MERGE_KIND, source.entry.filePath);
        inputBytes += inspected.bytes;
        if (inputBytes > MAX_MERGE_INPUT_BYTES) {
          throw new Error('선택한 문서의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
        }
        if (inspected.extension === 'pdf') knownPdfPageCount += inspected.pageCount;
        inputs.push({
          index,
          token: source.token,
          entry: source.entry,
          extension: inspected.extension,
          sourceInspection: inspected
        });
      }

      const readiness = await this.documentMergeDocumentsReadiness(inputs);
      if (readiness.availability.blocked) {
        const blocked = {
          jobId,
          kind: DOCUMENTS_MERGE_KIND,
          mode: DOCUMENTS_MERGE_MODE,
          purpose: 'print-share',
          editable: false,
          outputExtension: 'pdf',
          strict: true,
          ready: false,
          blocked: true,
          sourceCount: inputs.length,
          inputBytes,
          knownPdfPageCount,
          availability: readiness.availability,
          preparationPlan: readiness.preparationPlan,
          requiredDependencies: readiness.requiredDependencies,
          missingDependencies: readiness.missingDependencies,
          runningDependencies: readiness.runningDependencies,
          requiredFonts: readiness.requiredFonts,
          fontReports: readiness.fontReports,
          inspectorRequiredDependencies: readiness.inspectorRequiredDependencies,
          inspectionUnavailable: readiness.inspectionUnavailable,
          requiresPreview: readiness.requiresPreview,
          compatibilityMode: readiness.compatibilityMode,
          compatibilityInputs: readiness.compatibilityInputs,
          results: []
        };
        progress({
          jobId,
          phase: 'blocked',
          kind: DOCUMENTS_MERGE_KIND,
          mode: DOCUMENTS_MERGE_MODE,
          missingDependencies: readiness.missingDependencies.map((item) => item.dependencyId),
          runningDependencies: readiness.runningDependencies,
          requiredFonts: readiness.requiredFonts
        });
        return blocked;
      }

      const root = await makeJobDirectory();
      const temporaryOutput = path.join(root, 'merged.pdf');
      try {
        const plans = inputs.map((input) => ({
          ...input,
          route: input.extension === 'pdf'
            ? null
            : DocumentConversion.selectConversionRoute(input.extension, 'pdf'),
          temporaryPdf: input.extension === 'pdf'
            ? input.entry.filePath
            : path.join(root, `normalized-${String(input.index + 1).padStart(4, '0')}.pdf`)
        }));
        progress({
          jobId,
          phase: 'start',
          kind: DOCUMENTS_MERGE_KIND,
          mode: DOCUMENTS_MERGE_MODE,
          targetExtension: 'pdf',
          strict: true,
          total: plans.length,
          engines: [...new Set(plans.filter((plan) => plan.route).map((plan) => plan.route.engine))]
        });

        const nativePlans = plans.filter((plan) => plan.route);
        const workerResultsByIndex = new Map();
        const plansByEngine = new Map();
        for (const plan of nativePlans) {
          const group = plansByEngine.get(plan.route.engine) || [];
          group.push(plan);
          plansByEngine.set(plan.route.engine, group);
        }
        for (const [engine, enginePlans] of plansByEngine) {
          control.throwIfCancelled();
          let workerResults;
          try {
            workerResults = await this.runNativeDocumentConversion(engine, enginePlans.map((plan) => ({
              inputPath: plan.entry.filePath,
              outputPath: plan.temporaryPdf,
              sourceExtension: plan.extension,
              targetExtension: 'pdf'
            })), root, (item) => {
              const localIndex = Number(item?.index);
              const plan = Number.isInteger(localIndex) ? enginePlans[localIndex] : null;
              if (!plan) return;
              progress({
                jobId,
                phase: 'convert',
                kind: DOCUMENTS_MERGE_KIND,
                index: plan.index,
                total: plans.length,
                engine,
                ok: item?.ok !== false,
                error: boundedText(item?.error, 500)
              });
            }, {
              isCancelled: control.isCancelled,
              hancomAutomationSecurity: engine === 'hancomWriter' ? this.hancomAutomationSecurity : null,
              timeoutMs: Math.min(6 * 60 * 60 * 1_000, Math.max(60_000, enginePlans.length * PROCESS_TIMEOUT_PER_ITEM_MS))
            });
          } catch (error) {
            control.throwIfCancelled();
            const wrapped = new Error(`${DocumentConversion.getFormatLabel(enginePlans[0].extension)} PDF 변환에 실패했습니다: ${boundedText(error.message, 500, '변환 엔진 오류')}`);
            wrapped.code = error?.code || 'DOCUMENT_MERGE_NORMALIZATION_FAILED';
            throw wrapped;
          }
          workerResults.forEach((result, resultIndex) => {
            const localIndex = Number(result?.index);
            const plan = enginePlans[Number.isInteger(localIndex) ? localIndex : resultIndex];
            if (plan) workerResultsByIndex.set(plan.index, result);
          });
        }
        control.throwIfCancelled();

        const normalized = [];
        for (const plan of plans) {
          control.throwIfCancelled();
          if (plan.route) {
            const workerResult = workerResultsByIndex.get(plan.index);
            if (!workerResult?.ok) {
              const error = new Error(`${path.basename(plan.entry.filePath)} 파일을 PDF로 바꾸지 못했습니다: ${boundedText(workerResult?.error, 500, '변환 결과 없음')}`);
              error.code = 'DOCUMENT_MERGE_NORMALIZATION_FAILED';
              throw error;
            }
          }
          const validateNormalizedPdf = async (filePath) => {
            const validation = await this.validateConvertedOutputFile(
              filePath,
              'pdf',
              this.inspectPptxFile,
              this.inspectPdfFile
            );
            const inspection = await this.inspectPdfFile(filePath);
            if (!plan.route && inspection.pageCount !== plan.sourceInspection.pageCount) {
              throw convertedZipError('DOCUMENT_MERGE_INPUT_CHANGED', '선택한 PDF가 병합 준비 중 바뀌어 작업을 중단했습니다.');
            }
            return { validation, inspection };
          };
          const snapshotPdf = path.join(root, `snapshot-${String(plan.index + 1).padStart(4, '0')}.pdf`);
          const copied = await this.copyValidatedExclusive(
            plan.temporaryPdf,
            snapshotPdf,
            { validateSource: validateNormalizedPdf, validateDestination: validateNormalizedPdf }
          );
          const validation = copied.destinationValidation.validation;
          const pdfInspection = copied.destinationValidation.inspection;
          normalized.push({
            ...plan,
            snapshotPdf,
            snapshotIdentity: copied.destinationIdentity,
            validation,
            pdfInspection
          });
          progress({
            jobId,
            phase: 'validate',
            kind: DOCUMENTS_MERGE_KIND,
            index: plan.index,
            completed: plan.index + 1,
            total: plans.length,
            name: path.basename(plan.entry.filePath),
            pageCount: pdfInspection.pageCount
          });
        }

        const expectedPageCount = normalized.reduce((total, item) => total + item.pdfInspection.pageCount, 0);
        const mergeResult = await this.mergePdfFiles(
          normalized.map((item) => item.snapshotPdf),
          temporaryOutput,
          {
            expectedIdentities: normalized.map((item) => item.snapshotIdentity),
            throwIfCancelled: control.throwIfCancelled,
            onProgress: (item) => progress({
              jobId,
              phase: 'merge',
              kind: DOCUMENTS_MERGE_KIND,
              ...item,
              name: path.basename(normalized[item.index].entry.filePath)
            })
          }
        );
        control.throwIfCancelled();
        const inspectMergedPdf = async (filePath, stored) => {
          const validation = await this.validateConvertedOutputFile(
            filePath,
            'pdf',
            this.inspectPptxFile,
            this.inspectPdfFile
          );
          const inspection = await this.inspectPdfFile(filePath);
          if (inspection.pageCount !== expectedPageCount
            || (!stored && mergeResult.pageCount !== expectedPageCount)) {
            throw new Error(stored
              ? '저장된 문서 병합 결과의 페이지 수가 원본과 다릅니다.'
              : '문서 병합 결과의 페이지 수가 원본과 다릅니다. 결과를 저장하지 않았습니다.');
          }
          return { validation, inspection };
        };
        const copied = await this.copyValidatedToAvailableOutput(
          temporaryOutput,
          outputDirectory,
          requestedStem,
          'pdf',
          {
            validateSource: (filePath) => inspectMergedPdf(filePath, false),
            validateDestination: (filePath) => inspectMergedPdf(filePath, true),
            commitDestination: (filePath, outputIdentity) => this.issueOutputFileToken(ownerId, filePath, outputIdentity)
          }
        );
        const finalPath = copied.destinationPath;
        const temporaryValidation = copied.sourceValidation.validation;
        const finalValidation = copied.destinationValidation.validation;
        const finalInspection = copied.destinationValidation.inspection;

        const response = {
          jobId,
          kind: DOCUMENTS_MERGE_KIND,
          mode: DOCUMENTS_MERGE_MODE,
          purpose: 'print-share',
          editable: false,
          outputExtension: 'pdf',
          strict: true,
          ready: true,
          blocked: false,
          engine: 'strict-native-to-pdf+pdf-lib',
          sourceCount: plans.length,
          pdfSourceCount: plans.length - nativePlans.length,
          convertedCount: nativePlans.length,
          pageCount: expectedPageCount,
          inputBytes,
          normalizedInputBytes: Number(mergeResult.inputBytes) || 0,
          outputName: path.basename(finalPath),
          outputToken: payload.outputToken,
          outputFileToken: copied.commitResult,
          validation: {
            ...temporaryValidation,
            ...finalValidation,
            pageCount: finalInspection.pageCount
          },
          requiredDependencies: readiness.requiredDependencies,
          missingDependencies: [],
          runningDependencies: [],
          requiredFonts: [],
          fontReports: readiness.fontReports,
          inspectorRequiredDependencies: readiness.inspectorRequiredDependencies,
          inspectionUnavailable: readiness.inspectionUnavailable,
          requiresPreview: readiness.requiresPreview,
          preparationPlan: null,
          results: normalized.map((item) => ({
            index: item.index,
            name: path.basename(item.entry.filePath),
            sourceExtension: item.extension,
            targetExtension: 'pdf',
            engine: item.route?.engine || 'pdf-pass-through',
            converted: Boolean(item.route),
            validation: item.validation,
            pageCount: item.pdfInspection.pageCount
          }))
        };
        progress({ ...response, results: undefined, fontReports: undefined, phase: 'complete', completed: plans.length, total: plans.length });
        return response;
      } finally {
        await removeGeneratedDirectory(root);
      }
    });
  }

  async splitDocumentFile(ownerId, payload = {}, progress = () => {}) {
    const kind = normalizeDocumentSplitKind(payload.kind);
    const method = normalizeDocumentSplitMethod(payload.method);
    const fileToken = String(payload.fileToken || payload.inputToken || '');
    const source = this.resolveToken(ownerId, fileToken, this.documentSplitTokenKind(kind));
    const outputCapability = this.resolveToken(ownerId, payload.outputToken, 'output-directory');
    const selectedOutputDirectoryIdentity = await this.bindDocumentSplitOutputDirectory(outputCapability);
    const outputDirectory = selectedOutputDirectoryIdentity.realPath;

    const selectedIdentity = source.metadata?.identity;
    if (!selectedIdentity?.stats || !selectedIdentity.sha256) throw documentSplitInputChangedError();
    const current = await this.inspectDocumentSplitEntry(kind, source.filePath);
    if (!this.sameOutputFileIdentity(selectedIdentity, current.identity, true)
      || Number(source.metadata?.sourceUnitCount) !== current.sourceUnitCount) {
      throw documentSplitInputChangedError();
    }
    const allowOmissions = payload.allowOmissions === true;
    const allowCompatibilityFallback = payload.allowCompatibilityFallback === true;
    const plan = validateDocumentSplitGroups(payload.groups, current.sourceUnitCount, {
      method,
      allowOmissions
    });
    const sourceStem = path.parse(current.name || path.basename(source.filePath)).name;
    const outputPlans = plan.groups.map((group, index) => {
      const fallback = defaultDocumentSplitOutputName(sourceStem, index, plan.groups.length);
      const rawName = String(group.name || '').replace(new RegExp(`\\.${kind}$`, 'i'), '');
      return {
        ...group,
        requestedStem: safeOutputStem(rawName, fallback)
      };
    });
    const storageProjection = projectDocumentSplitStorage(current.identity.bytes, outputPlans.length);

    return this.enqueue(`document-split-${kind}`, ownerId, payload.requestId, async (jobId, control) => {
      control.throwIfCancelled();
      await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
      await this.preflightDocumentSplitStorage(outputDirectory, storageProjection);
      control.throwIfCancelled();
      const root = await makeJobDirectory();
      let rootCleaned = false;
      const snapshotPath = path.join(root, `source.${kind}`);
      const temporaryPlans = outputPlans.map((group, index) => ({
        ...group,
        outputPath: path.join(root, `split-${String(index + 1).padStart(4, '0')}.${kind}`)
      }));
      const published = [];
      const issuedTokens = [];
      let splitEngine = kind === 'pdf' ? 'pdf-lib' : 'powerpoint';
      let compatibilityFallback = false;
      let compatibilityWarnings = [];
      const validateSourceShape = async (filePath, expectedUnitCount = current.sourceUnitCount) => {
        const validation = await this.validateConvertedOutputFile(
          filePath,
          kind,
          this.inspectPptxFile,
          this.inspectPdfFile
        );
        const inspection = kind === 'pdf'
          ? await this.inspectPdfFile(filePath)
          : await this.inspectPptxFile(filePath);
        const actualUnitCount = kind === 'pdf'
          ? Number(inspection.pageCount) || 0
          : Number(inspection.slideCount) || 0;
        if (actualUnitCount !== expectedUnitCount) {
          const error = new Error(kind === 'pdf'
            ? 'PDF 나누기 결과의 페이지 수가 계획과 다릅니다. 결과를 저장하지 않았습니다.'
            : 'PPTX 나누기 결과의 슬라이드 수가 계획과 다릅니다. 결과를 저장하지 않았습니다.');
          error.code = 'DOCUMENT_SPLIT_OUTPUT_COUNT_MISMATCH';
          throw error;
        }
        if (kind === 'pptx' && !sameSlideSize(inspection.slideSize, current.slideSize)) {
          const error = new Error('PPTX 나누기 결과의 슬라이드 크기가 원본과 다릅니다. 결과를 저장하지 않았습니다.');
          error.code = 'DOCUMENT_SPLIT_OUTPUT_SIZE_MISMATCH';
          throw error;
        }
        return { validation, inspection, actualUnitCount };
      };

      try {
        progress({
          jobId,
          phase: 'start',
          kind,
          method,
          completed: 0,
          total: temporaryPlans.length,
          sourceUnitCount: current.sourceUnitCount
        });
        control.throwIfCancelled();
        const snapshot = await this.copyValidatedExclusive(source.filePath, snapshotPath, {
          validateSource: async (filePath) => {
            const validated = await validateSourceShape(filePath);
            const identity = await this.inspectOutputFileIdentity(filePath);
            if (!this.sameOutputFileIdentity(selectedIdentity, identity, true)) throw documentSplitInputChangedError();
            return validated;
          },
          validateDestination: async (filePath) => {
            const validated = await validateSourceShape(filePath);
            const identity = await this.inspectOutputFileIdentity(filePath);
            if (!this.sameOutputFileIdentity(selectedIdentity, identity, false)) throw documentSplitInputChangedError();
            return validated;
          }
        });
        control.throwIfCancelled();

        if (kind === 'pdf') {
          await this.splitPdfFile(snapshotPath, temporaryPlans.map((item) => ({
            outputPath: item.outputPath,
            name: item.requestedStem,
            pages: item.pages
          })), {
            method,
            allowOmissions,
            expectedIdentity: {
              bytes: snapshot.destinationIdentity.bytes,
              sha256: snapshot.destinationIdentity.sha256
            },
            throwIfCancelled: control.throwIfCancelled,
            onProgress: (item = {}) => progress({
              jobId,
              phase: 'split',
              kind,
              method,
              index: Number(item.index) || 0,
              completed: Number(item.completed) || 0,
              total: temporaryPlans.length,
              pageCount: Number(item.pageCount) || 0
            })
          });
        } else {
          const status = await this.capabilities();
          let fallbackReason = status.powerPointRunning
            ? 'powerpoint-running'
            : (!status.powerPoint ? 'powerpoint-missing' : '');
          let powerPointFailure = null;

          if (!fallbackReason) {
            try {
              const workerResults = await this.runPowerPointOperation('split-pptx', [{
                inputPath: snapshotPath,
                outputs: temporaryPlans.map((item) => ({ outputPath: item.outputPath, pages: item.pages }))
              }], root, (item = {}) => progress({
                jobId,
                phase: 'split',
                kind,
                method,
                engine: 'powerpoint',
                index: Number(item.index) || 0,
                completed: Number(item.completed) || 0,
                total: temporaryPlans.length,
                slideCount: Number(item.slideCount) || 0
              }), {
                timeoutMs: powerPointMergeTimeoutMs(
                  Math.max(MIN_MERGE_FILES, temporaryPlans.length),
                  Math.max(1, current.sourceUnitCount * temporaryPlans.length)
                ),
                isCancelled: control.isCancelled
              });
              control.throwIfCancelled();
              const workerResult = workerResults[0];
              if (workerResult?.ok !== true) {
                const error = new Error(workerResult?.error || 'PowerPoint가 PPTX 파일을 나누지 못했습니다.');
                error.code = 'POWERPOINT_PPTX_SPLIT_FAILED';
                throw error;
              }
              validatePowerPointSplitWorkerResult(workerResult, temporaryPlans, current.sourceUnitCount);
            } catch (error) {
              control.throwIfCancelled();
              fallbackReason = 'powerpoint-failed';
              powerPointFailure = error;
            }
          }

          if (fallbackReason) {
            if (!allowCompatibilityFallback) {
              throw documentSplitCompatibilityConfirmationError(fallbackReason, powerPointFailure);
            }
            // A crashed native worker may have left one or more files inside
            // this job's private temporary directory. The package fallback
            // exclusively creates every result, so remove only those exact
            // predeclared temporary paths before starting it.
            for (const item of temporaryPlans) {
              try { await fs.promises.unlink(item.outputPath); }
              catch (error) { if (error?.code !== 'ENOENT') throw error; }
            }
            control.throwIfCancelled();
            compatibilityFallback = true;
            splitEngine = 'pptx-package';
            compatibilityWarnings = [...PPTX_COMPATIBILITY_SPLIT_WARNINGS];
            progress({
              jobId,
              phase: 'engine-fallback',
              kind,
              method,
              engine: splitEngine,
              reason: fallbackReason,
              completed: 0,
              total: temporaryPlans.length
            });
            await this.splitPptxFile(snapshotPath, temporaryPlans.map((item) => ({
              outputPath: item.outputPath,
              name: item.requestedStem,
              pages: item.pages
            })), {
              method,
              allowOmissions,
              expectedIdentity: {
                bytes: snapshot.destinationIdentity.bytes,
                sha256: snapshot.destinationIdentity.sha256
              },
              throwIfCancelled: control.throwIfCancelled,
              onProgress: (item = {}) => progress({
                jobId,
                phase: 'split',
                kind,
                method,
                engine: splitEngine,
                index: Number(item.index) || 0,
                completed: Number(item.completed) || 0,
                total: temporaryPlans.length,
                slideCount: Number(item.slideCount) || 0
              })
            });
          }
        }

        const temporaryValidation = [];
        let temporaryOutputBytes = 0;
        for (let index = 0; index < temporaryPlans.length; index += 1) {
          control.throwIfCancelled();
          const group = temporaryPlans[index];
          const validation = await validateSourceShape(group.outputPath, group.unitCount);
          const identity = await this.inspectOutputFileIdentity(group.outputPath);
          temporaryOutputBytes += identity.bytes;
          assertDocumentSplitActualStorage(current.identity.bytes, temporaryOutputBytes);
          temporaryValidation.push({ ...validation, identity });
          progress({
            jobId,
            phase: 'verify',
            kind,
            method,
            index,
            completed: index + 1,
            total: temporaryPlans.length
          });
        }

        for (let index = 0; index < temporaryPlans.length; index += 1) {
          control.throwIfCancelled();
          const group = temporaryPlans[index];
          await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
          const copied = await this.copyValidatedToAvailableOutput(
            group.outputPath,
            outputDirectory,
            group.requestedStem,
            kind,
            {
              validateSource: (filePath) => validateSourceShape(filePath, group.unitCount),
              validateDestination: (filePath) => validateSourceShape(filePath, group.unitCount)
            }
          );
          published.push({ group, copied, validation: temporaryValidation[index] });
          await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
          progress({
            jobId,
            phase: 'save',
            kind,
            method,
            index,
            completed: index + 1,
            total: temporaryPlans.length
          });
        }
        control.throwIfCancelled();

        // A completed split must never be reported as failed merely because its
        // temporary workspace could not be removed after output capabilities
        // were committed. Remove it before issuing those capabilities; if the
        // cleanup fails, the catch block rolls every published file back.
        try {
          await this.removeDocumentSplitJobDirectory(root);
          rootCleaned = true;
        } catch (cause) {
          throw documentSplitError(
            'DOCUMENT_SPLIT_TEMP_CLEANUP_FAILED',
            '임시 분할 파일을 안전하게 정리하지 못해 결과 저장을 취소했습니다. 열려 있는 PowerPoint나 파일 탐색기를 닫고 다시 시도해주세요.',
            cause
          );
        }
        control.throwIfCancelled();

        const results = published.map(({ group, copied }) => {
          const outputFileToken = this.issueToken(
            ownerId,
            'output-file',
            copied.destinationPath,
            { outputIdentity: copied.destinationIdentity },
            { reuse: false }
          );
          issuedTokens.push(outputFileToken);
          return {
            index: group.index,
            outputName: path.basename(copied.destinationPath),
            outputFileToken,
            pages: group.pages.slice(),
            ...(kind === 'pdf'
              ? { pageCount: group.unitCount }
              : { slideCount: group.unitCount })
          };
        });
        const response = {
          jobId,
          kind,
          method,
          engine: splitEngine,
          compatibilityFallback,
          requiresPreview: compatibilityFallback,
          warnings: compatibilityWarnings,
          sourceCount: 1,
          sourceUnitCount: current.sourceUnitCount,
          selectedUnitCount: plan.selectedUnitCount,
          omittedPages: plan.omittedPages,
          omittedCount: plan.omittedCount,
          outputToken: payload.outputToken,
          results
        };
        progress({
          jobId,
          phase: 'complete',
          kind,
          method,
          engine: splitEngine,
          compatibilityFallback,
          requiresPreview: compatibilityFallback,
          completed: results.length,
          total: results.length,
          resultCount: results.length,
          omittedCount: plan.omittedCount
        });
        return response;
      } catch (error) {
        for (const token of issuedTokens) this.revokeToken(ownerId, token);
        for (const item of published.slice().reverse()) {
          await this.cleanupOwnedOutput(
            item.copied.destinationPath,
            item.copied.destinationStats,
            '문서 나누기 결과 되돌리기 실패:'
          );
        }
        throw error;
      } finally {
        if (!rootCleaned) {
          try {
            await this.removeDocumentSplitJobDirectory(root);
            rootCleaned = true;
          } catch (cleanupError) {
            // Preserve the original operation/rollback error. The remover
            // validates that this is a per-job directory under os.tmpdir(), so
            // no broader path is ever retried or deleted here.
            console.error('문서 나누기 임시 작업 폴더 정리 실패:', cleanupError);
          }
        }
      }
    });
  }

  async mergeNativeOfficeDocuments(ownerId, kind, payload = {}, progress = () => {}) {
    const normalizedKind = NativeOfficeMerge.normalizeNativeOfficeMergeKind(kind);
    const internalFallback = payload.confirmedInternalExcelFallback === true;
    if (internalFallback && normalizedKind !== 'excel') {
      const error = new Error('내부 Excel 병합은 Excel XLSX 파일에만 사용할 수 있습니다.');
      error.code = 'INTERNAL_EXCEL_MERGE_KIND_UNSUPPORTED';
      throw error;
    }
    const label = NATIVE_OFFICE_MERGE_LABELS[normalizedKind];
    const extension = normalizedKind === 'word' ? 'docx' : 'xlsx';
    const addCombinedSheet = normalizedKind === 'excel' && payload.addCombinedSheet === true;
    const useFileNameAsSheetName = normalizedKind === 'excel' && payload.useFileNameAsSheetName === true;
    const combinedSheetName = addCombinedSheet
      ? boundedText(payload.combinedSheetName, 31, '전체 통합')
      : '';
    const fileTokens = Array.isArray(payload.fileTokens)
      ? payload.fileTokens.map((item) => String(item?.token || item || ''))
      : [];
    if (fileTokens.length < MIN_MERGE_FILES || fileTokens.length > MAX_MERGE_FILES) {
      throw new Error(`합칠 ${label} 파일을 2개 이상, 500개 이하로 선택해주세요.`);
    }
    const tokenKind = this.documentMergeTokenKind(normalizedKind);
    const inputs = fileTokens.map((token) => ({
      token,
      entry: this.resolveToken(ownerId, token, tokenKind)
    }));
    const outputCapability = this.resolveToken(ownerId, payload.outputToken, 'output-directory');
    const selectedOutputDirectoryIdentity = await this.bindDocumentSplitOutputDirectory(outputCapability);
    const outputDirectory = selectedOutputDirectoryIdentity.realPath;
    const requestedStem = boundedText(
      payload.outputName,
      160,
      normalizedKind === 'word' ? '합친 Word 문서' : '합친 Excel 파일'
    );

    return this.enqueue(`document-merge-${normalizedKind}`, ownerId, payload.requestId, async (jobId, control) => {
      control.throwIfCancelled();
      await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
      const readinessInputs = [];
      let totalBytes = 0;
      for (let index = 0; index < inputs.length; index += 1) {
        control.throwIfCancelled();
        const input = inputs[index];
        if (internalFallback && path.extname(input.entry.filePath).toLowerCase() !== '.xlsx') {
          const error = new Error('내부 Excel 병합은 XLSX 파일만 사용할 수 있습니다. XLS 파일은 XLSX로 저장한 뒤 다시 선택해주세요.');
          error.code = 'INTERNAL_EXCEL_INPUT_FORMAT_INVALID';
          throw error;
        }
        const selectedSha256 = input.entry.metadata?.sourceSha256;
        const selectedRealPath = input.entry.metadata?.sourceRealPath;
        const inspected = internalFallback
          ? await this.inspectInternalExcelMergeEntry(input.entry.filePath)
          : await this.inspectDocumentMergeEntry(normalizedKind, input.entry.filePath);
        if ((selectedSha256 && inspected.sourceSha256 !== selectedSha256)
          || (selectedRealPath && path.resolve(inspected.sourceRealPath) !== path.resolve(selectedRealPath))) {
          const error = new Error(`“${path.basename(input.entry.filePath)}” 파일이 선택 후 바뀌었습니다. 현재 파일을 다시 선택해주세요.`);
          error.code = 'NATIVE_OFFICE_MERGE_INPUT_CHANGED';
          throw error;
        }
        totalBytes += inspected.bytes;
        if (totalBytes > MAX_MERGE_INPUT_BYTES) {
          throw new Error('선택한 문서의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
        }
        input.entry.metadata = {
          ...inspected,
          key: input.entry.metadata?.key || this.documentMergeFileKey(normalizedKind, input.entry.filePath)
        };
        readinessInputs.push({ token: input.token, entry: input.entry, extension: inspected.extension });
      }
      const readiness = internalFallback ? {
        availability: {
          supported: true,
          available: true,
          ready: true,
          blocked: false,
          runningBlocked: false,
          fontBlocked: false,
          inspectorBlocked: false,
          requiredDependencies: [],
          missingDependencies: [],
          runningDependencies: [],
          missingFonts: [],
          inspectionUnavailable: [],
          requiresPreview: true
        },
        preparationPlan: null,
        requiredDependencies: [],
        missingDependencies: [],
        runningDependencies: [],
        requiredFonts: [],
        fontReports: [],
        inspectorRequiredDependencies: [],
        inspectionUnavailable: [],
        requiresPreview: true,
        compatibilityMode: true,
        compatibilityInputs: [],
        engine: 'cmoe-internal-excel',
        compatibilityFallback: true,
        internalFallbackRequired: true,
        fallbackSupported: true,
        fallbackUnsupportedReasons: [],
        warnings: [...new Set([
          INTERNAL_EXCEL_FALLBACK_WARNING,
          ...readinessInputs.flatMap((input) => input.entry.metadata?.internalFallbackWarnings || [])
        ])],
        applicationReady: false
      } : await this.documentMergeNativeOfficeReadiness(normalizedKind, readinessInputs);
      if (!internalFallback && readiness.internalFallbackRequired) {
        const error = new Error('이 XLSX 파일은 내부 Excel 병합 방식이 필요합니다. 결과 확인 안내에 동의한 뒤 다시 진행해주세요.');
        error.code = 'INTERNAL_EXCEL_MERGE_CONFIRMATION_REQUIRED';
        error.details = { engine: 'CMOE 내부 Excel', phase: 'prepare' };
        throw error;
      }
      if (!internalFallback && readiness.availability.blocked) {
        const blocked = {
          jobId,
          kind: normalizedKind,
          mode: normalizedKind === 'excel' ? 'excel-merge' : `native-${normalizedKind}`,
          editable: true,
          outputExtension: extension,
          blocked: true,
          ...readiness,
          results: []
        };
        progress({
          jobId,
          phase: 'blocked',
          kind: normalizedKind,
          missingDependencies: readiness.missingDependencies.map((item) => item.dependencyId),
          runningDependencies: readiness.runningDependencies,
          requiredFonts: readiness.requiredFonts
        });
        return blocked;
      }
      if (!internalFallback && readiness.compatibilityFallback && payload.confirmedCompatibilityFallback !== true) {
        const error = new Error('Microsoft Excel이 없어 LibreOffice 호환 방식이 필요합니다. 서식 차이 안내를 확인한 뒤 다시 진행해주세요.');
        error.code = 'LIBREOFFICE_EXCEL_MERGE_CONFIRMATION_REQUIRED';
        error.details = { engine: 'LibreOffice', phase: 'prepare' };
        throw error;
      }

      const root = await makeJobDirectory();
      const temporaryOutput = path.join(root, `merged.${extension}`);
      let published = null;
      let issuedOutputFileToken = '';
      let failurePhase = 'prepare';
      let failureFileIndex = -1;
      const executionEngine = internalFallback ? 'cmoe-internal-excel' : readiness.engine;
      const engineLabel = internalFallback
        ? 'CMOE 내부 Excel'
        : (readiness.compatibilityFallback ? 'LibreOffice' : `Microsoft ${label}`);
      try {
        progress({ jobId, phase: 'start', kind: normalizedKind, engine: executionEngine, total: inputs.length });
        const snapshots = [];
        for (let index = 0; index < inputs.length; index += 1) {
          control.throwIfCancelled();
          failurePhase = 'snapshot';
          failureFileIndex = index;
          const input = inputs[index];
          const inputExtension = String(input.entry.metadata?.extension || '').toLowerCase();
          const expectedSha256 = input.entry.metadata?.sourceSha256;
          const snapshotPath = path.join(root, `snapshot-${String(index + 1).padStart(4, '0')}.${inputExtension}`);
          const validateSnapshot = async (filePath) => {
            const inspected = await NativeOfficeMerge.inspectNativeOfficeMergeSources(
              normalizedKind,
              [filePath],
              { allowSingle: true }
            );
            if (expectedSha256 && inspected.sources[0]?.sha256 !== expectedSha256) {
              const error = new Error(`“${path.basename(input.entry.filePath)}” 파일이 병합 준비 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.`);
              error.code = 'NATIVE_OFFICE_MERGE_INPUT_CHANGED';
              throw error;
            }
            return inspected.sources[0];
          };
          await this.copyValidatedExclusive(input.entry.filePath, snapshotPath, {
            validateSource: validateSnapshot,
            validateDestination: validateSnapshot
          });
          snapshots.push(snapshotPath);
        }
        control.throwIfCancelled();
        failurePhase = 'inspect';
        failureFileIndex = -1;
        if (!internalFallback && !readiness.compatibilityFallback) {
          const sourceInspection = await this.inspectNativeOfficeFiles(
            normalizedKind,
            snapshots,
            root,
            {
              onProgress: (item) => progress({ jobId, phase: 'inspect', kind: normalizedKind, engine: executionEngine, ...item }),
              isCancelled: control.isCancelled
            }
          );
          sourceInspection.files.forEach((inspected, index) => {
            inputs[index].entry.metadata = { ...inputs[index].entry.metadata, ...inspected };
          });
        }
        control.throwIfCancelled();
        failurePhase = 'merge';
        const mergeOptions = {
          addCombinedSheet,
          combinedSheetName,
          useFileNameAsSheetName,
          sourceFileNames: inputs.map((input) => path.basename(input.entry.filePath)),
          onProgress: (item) => {
            if (Number.isInteger(Number(item?.index))) failureFileIndex = Number(item.index);
            progress({
              jobId,
              phase: 'merge',
              kind: normalizedKind,
              engine: executionEngine,
              ...item,
              completed: Number.isFinite(Number(item?.completed))
                ? Math.max(0, Number(item.completed))
                : inputs.length,
              total: inputs.length
            });
          },
          isCancelled: control.isCancelled,
          throwIfCancelled: control.throwIfCancelled
        };
        const mergeResult = internalFallback
          ? await this.mergeExcelFilesInternally(snapshots, temporaryOutput, mergeOptions)
          : (readiness.compatibilityFallback
              ? await this.mergeExcelFilesWithLibreOffice(
                this.findLibreOfficePath(),
                snapshots,
                temporaryOutput,
                root,
                mergeOptions
              )
              : await this.mergeNativeOfficeFiles(
                normalizedKind,
                snapshots,
                temporaryOutput,
                root,
                mergeOptions
              ));
        control.throwIfCancelled();
        failurePhase = 'verify';
        failureFileIndex = -1;
        const validation = await this.validateConvertedOutputFile(
          temporaryOutput,
          extension,
          this.inspectPptxFile,
          this.inspectPdfFile
        );
        if (normalizedKind === 'word' && mergeResult.sourcePageCounts.length !== inputs.length) {
          throw new Error('Word 병합 결과의 원본 문서 순서를 확인하지 못했습니다. 결과를 저장하지 않았습니다.');
        }
        if (normalizedKind === 'excel') {
          const combinedSheetCount = addCombinedSheet ? 1 : 0;
          const sourceSheetCount = Array.isArray(mergeResult.sourceSheetCounts)
            ? mergeResult.sourceSheetCounts.reduce((sum, count) => sum + Number(count || 0), 0)
            : -1;
          if (sourceSheetCount + combinedSheetCount !== mergeResult.sheetCount
            || (mergeResult.combinedSheetAdded === true) !== addCombinedSheet) {
            throw new Error('Excel 병합 결과의 원본 시트와 전체 통합 시트 구성을 확인하지 못했습니다. 결과를 저장하지 않았습니다.');
          }
        }
        failurePhase = 'publish';
        await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
        const validateMergedOutput = (filePath) => this.validateConvertedOutputFile(
          filePath,
          extension,
          this.inspectPptxFile,
          this.inspectPdfFile
        );
        control.beginCommit();
        const copied = await this.copyValidatedToAvailableOutput(
          temporaryOutput,
          outputDirectory,
          requestedStem,
          extension,
          {
            validateSource: validateMergedOutput,
            validateDestination: validateMergedOutput,
            commitDestination: (filePath, outputIdentity) => this.issueOutputFileToken(ownerId, filePath, outputIdentity)
          }
        );
        published = copied;
        issuedOutputFileToken = copied.commitResult;
        await this.assertDocumentSplitOutputDirectory(outputCapability, selectedOutputDirectoryIdentity);
        const response = {
          jobId,
          kind: normalizedKind,
          mode: normalizedKind === 'excel' ? 'excel-merge' : `native-${normalizedKind}`,
          engine: mergeResult.engine || executionEngine,
          compatibilityFallback: internalFallback || readiness.compatibilityFallback === true,
          internalFallback,
          internalFallbackRequired: internalFallback || readiness.internalFallbackRequired === true,
          contentVerified: mergeResult.contentVerified === true,
          editable: true,
          sourceCount: inputs.length,
          inputBytes: totalBytes,
          outputName: path.basename(copied.destinationPath),
          outputToken: payload.outputToken,
          outputFileToken: copied.commitResult,
          validation,
          requiredFonts: readiness.requiredFonts,
          fontReports: readiness.fontReports,
          inspectionUnavailable: readiness.inspectionUnavailable,
          requiresPreview: readiness.requiresPreview || mergeResult.requiresPreview === true,
          warnings: [...new Set([...(readiness.warnings || []), ...(mergeResult.warnings || [])])],
          compatibilityInputs: mergeResult.compatibilityInputs || readiness.compatibilityInputs,
          ...(normalizedKind === 'word' ? {
            pageCount: mergeResult.pageCount,
            sectionCount: mergeResult.sectionCount,
            sourcePageCounts: mergeResult.sourcePageCounts,
            headerFooterLinksDetached: mergeResult.headerFooterLinksDetached,
            headerFooterLinkFailures: mergeResult.headerFooterLinkFailures
          } : {
            sheetCount: mergeResult.sheetCount,
            sourceSheetCounts: mergeResult.sourceSheetCounts,
            sheetNames: mergeResult.sheetNames,
            sheetTypes: mergeResult.sheetTypes,
            sheetVisibility: mergeResult.sheetVisibility,
            externalLinksPresent: mergeResult.externalLinksPresent,
            externalLinkCount: mergeResult.externalLinkCount,
            baseStrategy: mergeResult.baseStrategy,
            combinedSheetAdded: mergeResult.combinedSheetAdded === true,
            combinedSheetName: mergeResult.combinedSheetAdded ? boundedText(mergeResult.combinedSheetName, 31) : '',
            combinedRowCount: mergeResult.combinedSheetAdded ? Math.max(0, Number(mergeResult.combinedRowCount) || 0) : 0,
            combinedColumnCount: mergeResult.combinedSheetAdded ? Math.max(0, Number(mergeResult.combinedColumnCount) || 0) : 0,
            combinedDataMode: mergeResult.combinedSheetAdded ? boundedText(mergeResult.combinedDataMode, 80) : '',
            combinedValueSnapshot: mergeResult.combinedSheetAdded === true
              && (mergeResult.combinedValueSnapshot === true
                || mergeResult.combinedDataMode === 'calculated-values-with-cell-formatting')
          })
        };
        progress({ ...response, phase: 'complete', completed: inputs.length, total: inputs.length });
        return response;
      } catch (error) {
        const existingDetails = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
          ? error.details
          : {};
        const workerCode = String(error.workerCode || existingDetails.workerCode || '').replace(/[^A-Z0-9_.-]/gi, '_').slice(0, 128);
        error.details = {
          ...existingDetails,
          engine: existingDetails.engine || engineLabel,
          phase: existingDetails.phase || failurePhase,
          ...(workerCode ? { workerCode } : {}),
          ...(!Object.hasOwn(existingDetails, 'fileIndex') && failureFileIndex >= 0 && failureFileIndex < inputs.length ? {
            fileIndex: failureFileIndex,
            fileName: path.basename(inputs[failureFileIndex].entry.filePath)
          } : {})
        };
        if (issuedOutputFileToken) this.revokeToken(ownerId, issuedOutputFileToken);
        if (published) {
          await this.cleanupOwnedOutput(
            published.destinationPath,
            published.destinationStats,
            'Word/Excel 병합 결과 되돌리기 실패:'
          );
        }
        throw error;
      } finally {
        try { await removeGeneratedDirectory(root); }
        catch (cleanupError) { console.error('Word/Excel 병합 임시 작업 폴더 정리 실패:', cleanupError); }
      }
    });
  }

  async mergeDocumentFiles(ownerId, payload = {}, progress = () => {}) {
    const kind = normalizeDocumentToolsMergeKind(payload.kind);
    if (kind === DOCUMENTS_MERGE_KIND) return this.mergeDocumentsToPdf(ownerId, payload, progress);
    if (NATIVE_OFFICE_MERGE_KIND_SET.has(kind)) return this.mergeNativeOfficeDocuments(ownerId, kind, payload, progress);
    const fileTokens = Array.isArray(payload.fileTokens) ? payload.fileTokens.map((item) => String(item?.token || item || '')) : [];
    if (fileTokens.length < MIN_MERGE_FILES || fileTokens.length > MAX_MERGE_FILES) {
      throw new Error(`합칠 ${kind.toUpperCase()} 파일을 2개 이상, 500개 이하로 선택해주세요.`);
    }
    const tokenKind = this.documentMergeTokenKind(kind);
    // Do not deduplicate. Repeating the same token intentionally repeats that
    // document, and the array order is the user's final merge order.
    const inputs = fileTokens.map((token) => this.resolveToken(ownerId, token, tokenKind));
    const outputDirectory = this.resolveToken(ownerId, payload.outputToken, 'output-directory').filePath;
    const outputStats = await fs.promises.stat(outputDirectory);
    if (!outputStats.isDirectory()) throw new Error('결과 폴더를 찾을 수 없습니다. 다시 선택해주세요.');
    const requestedStem = boundedText(payload.outputName, 160, kind === 'pdf' ? '합친 PDF' : '합친 PowerPoint');

    return this.enqueue(`document-merge-${kind}`, ownerId, payload.requestId, async (jobId, control) => {
      const root = await makeJobDirectory();
      const temporaryOutput = path.join(root, `merged.${kind}`);
      try {
        progress({ jobId, phase: 'start', kind, total: inputs.length });
        let mergeResult;
        let engine = kind === 'pdf' ? 'pdf-lib' : 'powerpoint';
        if (kind === 'pdf') {
          const snapshots = [];
          for (let index = 0; index < inputs.length; index += 1) {
            control.throwIfCancelled();
            const input = inputs[index];
            const expectedPageCount = Number(input.metadata?.pageCount) || 0;
            const validateMergeInput = async (filePath) => {
              const validation = await this.validateConvertedOutputFile(
                filePath,
                'pdf',
                this.inspectPptxFile,
                this.inspectPdfFile
              );
              const inspection = await this.inspectPdfFile(filePath);
              if (expectedPageCount > 0 && inspection.pageCount !== expectedPageCount) {
                throw convertedZipError('DOCUMENT_MERGE_INPUT_CHANGED', '선택한 PDF가 병합 준비 중 바뀌어 작업을 중단했습니다.');
              }
              return { validation, inspection };
            };
            const snapshotPath = path.join(root, `snapshot-${String(index + 1).padStart(4, '0')}.pdf`);
            const copied = await this.copyValidatedExclusive(
              input.filePath,
              snapshotPath,
              { validateSource: validateMergeInput, validateDestination: validateMergeInput }
            );
            snapshots.push({
              path: snapshotPath,
              identity: copied.destinationIdentity,
              sourceName: path.basename(input.filePath)
            });
          }
          mergeResult = await this.mergePdfFiles(snapshots.map((item) => item.path), temporaryOutput, {
            expectedIdentities: snapshots.map((item) => item.identity),
            throwIfCancelled: control.throwIfCancelled,
            onProgress: (item) => progress({ jobId, phase: 'merge', kind, ...item, name: snapshots[item.index].sourceName })
          });
        } else {
          const inspections = [];
          for (let index = 0; index < inputs.length; index += 1) {
            control.throwIfCancelled();
            const inspected = await this.inspectPptxFile(inputs[index].filePath);
            // Retain only merge compatibility metadata. The template
            // inspector also returns every text block, which can be large and
            // is not needed once this source has been validated.
            inspections.push({
              sourceName: inspected.sourceName,
              sourceBytes: inspected.sourceBytes,
              slideCount: inspected.slideCount,
              slideSize: inspected.slideSize
            });
            progress({ jobId, phase: 'inspect', kind, index, completed: index + 1, total: inputs.length, name: inspected.sourceName, slideCount: inspected.slideCount });
          }
          const expected = assertCompatiblePptxInspections(inspections);
          const status = await this.capabilities();
          if (status.powerPointRunning) {
            throw new Error('열려 있는 PowerPoint를 닫은 뒤 다시 시도해주세요. 작업 중인 문서를 보호하기 위해 자동 병합을 시작하지 않았습니다.');
          }
          if (!status.powerPoint) {
            throw new Error('PPTX의 글꼴·테마·마스터·미디어를 그대로 유지하며 합치려면 Microsoft PowerPoint가 필요합니다. PDF 병합은 별도 프로그램 없이 사용할 수 있습니다.');
          }
          const results = await this.runPowerPointOperation('merge-pptx', [{
            inputPaths: inputs.map((entry) => entry.filePath),
            outputPath: temporaryOutput
          }], root, (item) => progress({ jobId, phase: 'merge', kind, ...item, total: inputs.length }), {
            timeoutMs: powerPointMergeTimeoutMs(inputs.length, expected.slideCount),
            isCancelled: control.isCancelled
          });
          control.throwIfCancelled();
          const result = results[0];
          if (!result?.ok) throw new Error(result?.error || 'PowerPoint가 PPTX 파일을 합치지 못했습니다.');
          const verified = await this.inspectPptxFile(temporaryOutput);
          if (verified.slideCount !== expected.slideCount) {
            throw new Error('PPTX 병합 결과의 슬라이드 수가 원본 합계와 다릅니다. 결과를 저장하지 않았습니다.');
          }
          if (!sameSlideSize(verified.slideSize, expected.slideSize)) {
            throw new Error('PPTX 병합 결과의 슬라이드 크기가 원본과 다릅니다. 결과를 저장하지 않았습니다.');
          }
          mergeResult = { ...expected, slideCount: verified.slideCount };
        }

        control.throwIfCancelled();
        const validateMergedOutput = async (filePath, stored) => {
          const validation = await this.validateConvertedOutputFile(
            filePath,
            kind,
            this.inspectPptxFile,
            this.inspectPdfFile
          );
          if (kind === 'pdf') {
            const inspection = await this.inspectPdfFile(filePath);
            if (inspection.pageCount !== mergeResult.pageCount) {
              throw new Error(stored
                ? '저장된 PDF 병합 결과의 페이지 수가 원본 합계와 다릅니다.'
                : 'PDF 병합 결과의 페이지 수가 원본 합계와 다릅니다. 결과를 저장하지 않았습니다.');
            }
            return { validation, inspection };
          }
          const inspection = await this.inspectPptxFile(filePath);
          if (inspection.slideCount !== mergeResult.slideCount
            || !sameSlideSize(inspection.slideSize, mergeResult.slideSize)) {
            throw new Error(stored
              ? '저장된 PPTX 병합 결과의 슬라이드 수 또는 크기가 원본과 다릅니다.'
              : 'PPTX 병합 결과의 슬라이드 수 또는 크기가 원본과 다릅니다. 결과를 저장하지 않았습니다.');
          }
          return { validation, inspection };
        };
        const copied = await this.copyValidatedToAvailableOutput(
          temporaryOutput,
          outputDirectory,
          requestedStem,
          kind,
          {
            validateSource: (filePath) => validateMergedOutput(filePath, false),
            validateDestination: (filePath) => validateMergedOutput(filePath, true),
            commitDestination: (filePath, outputIdentity) => this.issueOutputFileToken(ownerId, filePath, outputIdentity)
          }
        );
        const finalPath = copied.destinationPath;
        const response = {
          jobId,
          kind,
          engine,
          sourceCount: inputs.length,
          outputName: path.basename(finalPath),
          outputToken: payload.outputToken,
          outputFileToken: copied.commitResult,
          inputBytes: Number(mergeResult.inputBytes) || 0,
          ...(kind === 'pdf' ? { pageCount: Number(mergeResult.pageCount) || 0 } : { slideCount: Number(mergeResult.slideCount) || 0 })
        };
        progress({ ...response, phase: 'complete', completed: inputs.length, total: inputs.length });
        return response;
      } finally {
        await removeGeneratedDirectory(root);
      }
    });
  }

  async convertDocumentBatch(ownerId, payload = {}, progress = () => {}) {
    const inputs = this.resolveDocumentConversionInputs(ownerId, payload);
    const targetExtension = DocumentConversion.safeOutputExtension(payload.targetExtension ?? payload.target);
    const commonTargets = DocumentConversion.getCommonTargets(inputs.map((item) => item.extension));
    if (!commonTargets.includes(targetExtension)) {
      const error = new Error('선택한 모든 원본 문서에 공통으로 지원되는 변환 형식이 아닙니다.');
      error.code = 'DOCUMENT_CONVERSION_ROUTE_UNSUPPORTED';
      throw error;
    }
    const routes = inputs.map((input) => DocumentConversion.selectConversionRoute(input.extension, targetExtension));
    if (routes.some((route) => !route || route.policy !== 'strict' || route.automaticFallback)) {
      const error = new Error('원본 문서의 엄격 변환 경로를 확인하지 못했습니다.');
      error.code = 'DOCUMENT_CONVERSION_ROUTE_UNSUPPORTED';
      throw error;
    }
    const outputDirectory = this.resolveToken(ownerId, payload.outputToken, 'output-directory').filePath;
    const outputStats = await fs.promises.stat(outputDirectory);
    if (!outputStats.isDirectory()) throw new Error('결과 폴더를 찾을 수 없습니다. 다시 선택해주세요.');

    return this.enqueue('document-conversion', ownerId, payload.requestId, async (jobId, control) => {
      const status = await this.capabilities();
      const fontRequirements = await this.documentFontRequirements(inputs);
      const routeAvailability = DocumentConversion.getBatchConversionAvailability(
        inputs.map((item) => item.extension),
        targetExtension,
        status
      );
      const inspectorDependencies = fontRequirements.inspectorRequiredDependencies.map((dependencyId) => (
        this.documentInspectorDependencyAvailability(dependencyId, status)
      ));
      const missingInspectorDependencies = inspectorDependencies.filter((item) => item.blocked);
      const requiredDependencies = [...new Set([
        ...routes.map((route) => route.requiredDependency),
        ...fontRequirements.inspectorRequiredDependencies
      ])];
      const missingDependencies = [...routeAvailability.missingDependencies, ...missingInspectorDependencies];
      const runningDependencies = requiredDependencies.filter((dependencyId) => status.dependencies?.[dependencyId]?.running);
      if (missingDependencies.length || runningDependencies.length || fontRequirements.requiredFonts.length) {
        const preparationPlan = missingDependencies.length || fontRequirements.requiredFonts.length
          ? this.dependencyPreparationForRoutes(
            routes,
            status,
            fontRequirements.requiredFonts,
            fontRequirements.inspectorRequiredDependencies
          )
          : null;
        const blocked = {
          jobId,
          ready: false,
          blocked: true,
          strict: true,
          targetExtension,
          requiredDependencies,
          missingDependencies,
          runningDependencies,
          requiredFonts: fontRequirements.requiredFonts,
          fontReports: fontRequirements.reports,
          inspectorRequiredDependencies: fontRequirements.inspectorRequiredDependencies,
          inspectionUnavailable: fontRequirements.inspectionUnavailable,
          requiresPreview: fontRequirements.requiresPreview,
          preparationPlan,
          results: [],
          completed: 0,
          failed: 0
        };
        progress({
          jobId,
          phase: 'blocked',
          targetExtension,
          missingDependencies: missingDependencies.map((item) => item.dependencyId),
          runningDependencies,
          requiredFonts: fontRequirements.requiredFonts
        });
        return blocked;
      }

      const root = await makeJobDirectory();
      const reserved = new Set();
      const plans = [];
      try {
        for (let index = 0; index < inputs.length; index += 1) {
          control.throwIfCancelled();
          const input = inputs[index];
          await assertDocumentSourceFile(input.entry.filePath, input.extension);
          const route = routes[index];
          const output = await this.availableOutputBase(
            outputDirectory,
            path.parse(input.entry.filePath).name,
            [targetExtension],
            reserved
          );
          plans.push({
            index,
            input,
            route,
            output,
            temporaryOutput: path.join(root, `converted-${String(index + 1).padStart(4, '0')}.${targetExtension}`)
          });
        }
        progress({
          jobId,
          phase: 'start',
          strict: true,
          targetExtension,
          total: plans.length,
          engines: [...new Set(routes.map((route) => route.engine))]
        });

        const workerResultsByIndex = new Map();
        const workerFailuresByIndex = new Map();
        const plansByEngine = new Map();
        for (const plan of plans) {
          const group = plansByEngine.get(plan.route.engine) || [];
          group.push(plan);
          plansByEngine.set(plan.route.engine, group);
        }
        for (const [engine, enginePlans] of plansByEngine) {
          control.throwIfCancelled();
          try {
            const workerResults = await this.runNativeDocumentConversion(engine, enginePlans.map((plan) => ({
              inputPath: plan.input.entry.filePath,
              outputPath: plan.temporaryOutput,
              sourceExtension: plan.input.extension,
              targetExtension
            })), root, (item) => {
              const localIndex = Number(item?.index);
              const plan = Number.isInteger(localIndex) ? enginePlans[localIndex] : null;
              if (!plan) return;
              progress({
                jobId,
                phase: 'convert',
                index: plan.index,
                total: plans.length,
                engine,
                ok: item?.ok !== false,
                error: boundedText(item?.error, 500)
              });
            }, {
              isCancelled: control.isCancelled,
              hancomAutomationSecurity: engine === 'hancomWriter' ? this.hancomAutomationSecurity : null,
              timeoutMs: Math.min(6 * 60 * 60 * 1_000, Math.max(60_000, enginePlans.length * PROCESS_TIMEOUT_PER_ITEM_MS))
            });
            workerResults.forEach((result, resultIndex) => {
              const localIndex = Number(result?.index);
              const plan = enginePlans[Number.isInteger(localIndex) ? localIndex : resultIndex];
              if (plan) workerResultsByIndex.set(plan.index, result);
            });
          } catch (error) {
            control.throwIfCancelled();
            for (const plan of enginePlans) workerFailuresByIndex.set(plan.index, error);
          }
        }
        control.throwIfCancelled();

        const results = [];
        for (const plan of plans) {
          control.throwIfCancelled();
          const workerResult = workerResultsByIndex.get(plan.index);
          const baseResult = {
            name: path.basename(plan.input.entry.filePath),
            sourceExtension: plan.input.extension,
            targetExtension,
            engine: plan.route.engine
          };
          const workerFailure = workerFailuresByIndex.get(plan.index);
          if (workerFailure || !workerResult?.ok) {
            results.push({
              ...baseResult,
              ok: false,
              validation: { ok: false, extension: targetExtension },
              outputFileToken: null,
              error: boundedText(workerFailure?.message || workerResult?.error, 500, '변환하지 못했습니다.')
            });
            continue;
          }
          try {
            const validateResult = (filePath) => this.validateConvertedOutputFile(
              filePath,
              targetExtension,
              this.inspectPptxFile,
              this.inspectPdfFile
            );
            const copied = await this.copyValidatedExclusive(
              plan.temporaryOutput,
              plan.output.paths[targetExtension],
              {
                validateSource: validateResult,
                validateDestination: validateResult,
                commitDestination: (filePath, outputIdentity) => this.issueOutputFileToken(ownerId, filePath, outputIdentity)
              }
            );
            const validation = copied.destinationValidation;
            results.push({
              ...baseResult,
              ok: true,
              validation,
              outputName: path.basename(plan.output.paths[targetExtension]),
              outputFileToken: copied.commitResult
            });
          } catch (error) {
            results.push({
              ...baseResult,
              ok: false,
              validation: { ok: false, extension: targetExtension },
              outputFileToken: null,
              error: boundedText(error.message, 500, '변환 결과를 검증하지 못했습니다.')
            });
          }
        }
        const response = {
          jobId,
          ready: true,
          blocked: false,
          strict: true,
          targetExtension,
          requiredDependencies,
          requiredFonts: [],
          fontReports: fontRequirements.reports,
          inspectorRequiredDependencies: fontRequirements.inspectorRequiredDependencies,
          inspectionUnavailable: fontRequirements.inspectionUnavailable,
          requiresPreview: fontRequirements.requiresPreview,
          results,
          completed: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length
        };
        progress({
          jobId,
          phase: 'complete',
          targetExtension,
          total: plans.length,
          completed: response.completed,
          failed: response.failed
        });
        return response;
      } finally { await removeGeneratedDirectory(root); }
    });
  }

  async convertPptxBatch(ownerId, payload = {}, progress = () => {}) {
    return this.convertPptxPdfCompatibilityBatch(ownerId, payload, progress);
  }

  async convertPptxPdfCompatibilityBatch(ownerId, payload = {}, progress = () => {}) {
    const fileTokens = Array.isArray(payload.fileTokens) ? [...new Set(payload.fileTokens.map(String))] : [];
    if (!fileTokens.length || fileTokens.length > MAX_BATCH_FILES) throw new Error('변환할 PPTX 파일을 1개 이상, 500개 이하로 선택해주세요.');
    const inputs = fileTokens.map((token) => this.resolveToken(ownerId, token, 'pptx-input'));
    const outputDirectory = this.resolveToken(ownerId, payload.outputToken, 'output-directory').filePath;
    return this.enqueue('pptx-pdf', ownerId, payload.requestId, async (jobId, control) => {
      const engineInfo = await this.selectedEngine();
      let activeEngine = engineInfo.engine;
      const root = await makeJobDirectory();
      const reserved = new Set();
      const plans = [];
      try {
        for (let index = 0; index < inputs.length; index += 1) {
          control.throwIfCancelled();
          const input = inputs[index];
          const sourceInspection = await this.inspectPptxFile(input.filePath);
          const output = await this.availableOutputBase(outputDirectory, path.parse(input.filePath).name, ['pdf'], reserved);
          plans.push({
            index,
            input,
            output,
            sourceSlideCount: sourceInspection.slideCount,
            temporaryPdf: path.join(root, `converted-${String(index + 1).padStart(4, '0')}.pdf`)
          });
        }
        progress({ jobId, phase: 'start', engine: activeEngine, total: plans.length });
        const engineResults = new Map();
        let libreOfficePlans = activeEngine === 'libreoffice' ? plans : [];
        let powerPointFailure = null;
        if (activeEngine === 'powerpoint') {
          for (let offset = 0; offset < plans.length; offset += POWERPOINT_CHUNK_SIZE) {
            control.throwIfCancelled();
            const chunk = plans.slice(offset, offset + POWERPOINT_CHUNK_SIZE);
            try {
              const results = await this.runPowerPointOperation('pdf', chunk.map((plan) => ({ inputPath: plan.input.filePath, outputPath: plan.temporaryPdf })), root, (item) => {
                const plan = chunk[Number(item.index)];
                if (!plan) return;
                progress({ jobId, phase: 'convert', index: plan.index, total: plans.length, ok: item.ok !== false, error: item.error || '' });
              });
              results.forEach((result, resultIndex) => {
                const localIndex = Number(result?.index);
                const plan = Number.isInteger(localIndex) && localIndex >= 0 && localIndex < chunk.length
                  ? chunk[localIndex]
                  : chunk[resultIndex];
                if (plan) engineResults.set(plan.index, result);
              });
              for (const plan of chunk) {
                if (!engineResults.has(plan.index)) engineResults.set(plan.index, { ok: false, error: 'PowerPoint 작업 결과를 확인하지 못했습니다.' });
              }
            } catch (error) {
              if (!engineInfo.status?.libreOfficePath) throw error;
              powerPointFailure = error;
              break;
            }
          }
          libreOfficePlans = plans.filter((plan) => !engineResults.get(plan.index)?.ok);
          if (libreOfficePlans.length && engineInfo.status?.libreOfficePath) {
            activeEngine = 'libreoffice';
            const firstFailure = libreOfficePlans.map((plan) => engineResults.get(plan.index)?.error).find(Boolean);
            progress({
              jobId,
              phase: 'engine-fallback',
              engine: activeEngine,
              total: plans.length,
              retryCount: libreOfficePlans.length,
              error: boundedText(powerPointFailure?.message || firstFailure, 500)
            });
          }
        }
        if (libreOfficePlans.length && (engineInfo.engine === 'libreoffice' || engineInfo.status?.libreOfficePath)) {
          const executable = engineInfo.status.libreOfficePath || (await this.capabilities()).libreOfficePath;
          for (const plan of libreOfficePlans) {
            control.throwIfCancelled();
            try {
              try { await fs.promises.unlink(plan.temporaryPdf); } catch (error) { if (error.code !== 'ENOENT') throw error; }
              const converted = await this.runLibreOfficeConversion(executable, plan.input.filePath, 'pdf', root);
              await fs.promises.copyFile(converted, plan.temporaryPdf, fs.constants.COPYFILE_EXCL);
              engineResults.set(plan.index, { ok: true, index: plan.index });
              progress({ jobId, phase: 'convert', index: plan.index, total: plans.length, ok: true });
            } catch (error) {
              engineResults.set(plan.index, { ok: false, index: plan.index, error: error.message });
              progress({ jobId, phase: 'convert', index: plan.index, total: plans.length, ok: false, error: error.message });
            }
          }
        }

        control.throwIfCancelled();
        const results = [];
        for (const plan of plans) {
          const engineResult = engineResults.get(plan.index);
          if (!engineResult?.ok) {
            results.push({ name: path.basename(plan.input.filePath), ok: false, error: boundedText(engineResult?.error, 500, '변환하지 못했습니다.') });
            continue;
          }
          try {
            const validatePdfResult = async (filePath) => {
              const validation = await this.validateConvertedOutputFile(
                filePath,
                'pdf',
                this.inspectPptxFile,
                this.inspectPdfFile
              );
              if (validation.pageCount !== plan.sourceSlideCount) {
                throw new Error('PPTX 슬라이드 수와 생성된 PDF 페이지 수가 달라 저장을 중단했습니다.');
              }
              return validation;
            };
            const copied = await this.copyValidatedExclusive(
              plan.temporaryPdf,
              plan.output.paths.pdf,
              {
                validateSource: validatePdfResult,
                validateDestination: validatePdfResult,
                commitDestination: (filePath, outputIdentity) => this.issueOutputFileToken(ownerId, filePath, outputIdentity)
              }
            );
            results.push({
              name: path.basename(plan.input.filePath),
              ok: true,
              outputName: path.basename(plan.output.paths.pdf),
              outputFileToken: copied.commitResult
            });
          } catch (error) {
            results.push({ name: path.basename(plan.input.filePath), ok: false, error: boundedText(error.message, 500) });
          }
        }
        progress({ jobId, phase: 'complete', total: plans.length, completed: results.filter((item) => item.ok).length });
        return { jobId, engine: activeEngine, results, completed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length };
      } finally { await removeGeneratedDirectory(root); }
    });
  }

  async certificateSource(ownerId, payload = {}) {
    if (payload.profileId) {
      const profile = await this.profileById(payload.profileId);
      const filePath = path.join(this.templatesRoot, profile.id, 'template.pptx');
      return { filePath, profile };
    }
    return { filePath: this.resolveToken(ownerId, payload.templateToken, 'certificate-template').filePath, profile: null };
  }

  async inspectCertificateReadiness(ownerId, payload = {}) {
    const source = await this.certificateSource(ownerId, payload);
    const inspected = await this.inspectPptxFile(source.filePath);
    const status = await this.capabilities(payload.refresh !== false);
    const readiness = await this.certificatePdfReadiness(inspected, status);
    return {
      name: boundedText(inspected.sourceName || path.basename(source.filePath), 200),
      certificatePdfReadiness: readiness,
      ...readiness
    };
  }

  validateCertificateSelection(inspected, slideNumber, fields) {
    const slide = inspected.slides.find((item) => item.number === Number(slideNumber));
    if (!slide) throw new Error('선택한 양식 슬라이드를 찾을 수 없습니다.');
    if (!Array.isArray(fields) || !fields.length || fields.length > MAX_CERTIFICATE_FIELDS) throw new Error('바꿀 텍스트 블록을 1개 이상 선택해주세요.');
    const available = new Set(slide.blocks.map((block) => block.id));
    const seen = new Set();
    const normalized = fields.map((field, index) => {
      const blockId = boundedText(field?.blockId, 160);
      if (!available.has(blockId) || seen.has(blockId)) throw new Error('선택한 텍스트 블록 정보가 바뀌었습니다. 양식을 다시 확인해주세요.');
      seen.add(blockId);
      return { blockId, label: boundedText(field?.label, 80, `항목 ${index + 1}`) || `항목 ${index + 1}` };
    });
    return { slide, fields: normalized };
  }

  async previewCertificate(ownerId, payload = {}) {
    return this.enqueue('certificate-preview', ownerId, payload.requestId, async (jobId) => {
      const source = await this.certificateSource(ownerId, payload);
      const inspected = await inspectPptxFile(source.filePath);
      const slideNumber = Number(payload.slideNumber);
      const slide = inspected.slides.find((item) => item.number === slideNumber);
      if (!slide) throw new Error('선택한 양식 슬라이드를 찾을 수 없습니다.');
      const selection = Array.isArray(payload.fields) && payload.fields.length
        ? this.validateCertificateSelection(inspected, slideNumber, payload.fields)
        : { slide, fields: [] };
      const values = Array.isArray(payload.values) ? payload.values : [];
      const replacements = new Map(selection.fields.map((field, index) => [field.blockId, String(values[index] ?? '').slice(0, 4_000)]));
      const sourcePreview = selection.fields.length === 0;
      const engineInfo = await this.selectedEngine();
      const sourceStats = sourcePreview ? await fs.promises.stat(source.filePath) : null;
      let preferredCacheKey = '';
      if (sourcePreview) {
        preferredCacheKey = await this.sourcePreviewCacheKey(source.filePath, sourceStats, slideNumber, engineInfo.engine);
        const cached = this.cachedSourcePreview(preferredCacheKey);
        if (cached) return certificatePreviewResult(jobId, cached, true);
      }
      const root = await makeJobDirectory();
      try {
        const isolatedInputPath = path.join(root, 'certificate-preview.pptx');
        const outputPath = path.join(root, 'certificate-preview.png');
        let isolatedReady = false;
        const ensureIsolatedInput = async () => {
          if (isolatedReady) return isolatedInputPath;
          const { buffer } = await readPptxFile(source.filePath);
          const certificate = await buildCertificatePptx(buffer, { slideNumber, replacements });
          await fs.promises.writeFile(isolatedInputPath, certificate);
          isolatedReady = true;
          return isolatedInputPath;
        };
        let activeEngine = engineInfo.engine;
        if (activeEngine === 'powerpoint') {
          try {
            // Untouched template slides retain their exact master/layout/theme
            // context by rendering straight from the original presentation.
            const inputPath = sourcePreview ? source.filePath : await ensureIsolatedInput();
            const renderSlideNumber = sourcePreview ? slideNumber : 1;
            const results = await this.runPowerPointOperation('png', [{ inputPath, outputPath, slideNumber: renderSlideNumber }], root);
            if (!results[0]?.ok) throw new Error(results[0]?.error || '미리보기를 만들지 못했습니다.');
          } catch (powerPointError) {
            if (!engineInfo.status.libreOfficePath) throw powerPointError;
            activeEngine = 'libreoffice';
            try { await fs.promises.unlink(outputPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (sourcePreview) {
              const fallbackCacheKey = await this.sourcePreviewCacheKey(source.filePath, sourceStats, slideNumber, activeEngine);
              const cached = this.cachedSourcePreview(fallbackCacheKey);
              if (cached) return certificatePreviewResult(jobId, cached, true);
            }
          }
        }
        if (activeEngine === 'libreoffice') {
          const executable = engineInfo.status.libreOfficePath || (await this.capabilities()).libreOfficePath;
          // LibreOffice PNG export targets the first slide, so use the existing
          // one-slide extraction for source and personalized previews alike.
          const converted = await this.runLibreOfficeConversion(executable, await ensureIsolatedInput(), 'png', root);
          await fs.promises.copyFile(converted, outputPath, fs.constants.COPYFILE_EXCL);
        }
        const stats = await validateOutputFile(outputPath, 'png');
        if (stats.size > MAX_PREVIEW_BYTES) throw new Error('미리보기 이미지가 너무 큽니다. 양식의 고해상도 이미지를 줄여주세요.');
        const image = await fs.promises.readFile(outputPath);
        const dimensions = pngDimensions(image);
        if (!dimensions) throw new Error('생성된 미리보기의 이미지 크기를 확인하지 못했습니다.');
        const preview = {
          engine: activeEngine,
          image,
          imageWidth: dimensions.width,
          imageHeight: dimensions.height,
          slideWidth: inspected.slideSize.width,
          slideHeight: inspected.slideSize.height,
          slideNumber
        };
        if (sourcePreview) {
          const cacheKey = activeEngine === engineInfo.engine
            ? preferredCacheKey
            : await this.sourcePreviewCacheKey(source.filePath, sourceStats, slideNumber, activeEngine);
          this.cacheSourcePreview(cacheKey, preview);
        }
        return certificatePreviewResult(jobId, preview);
      } finally { await removeGeneratedDirectory(root); }
    });
  }

  async generateCertificates(ownerId, payload = {}, progress = () => {}) {
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length || rows.length > MAX_CERTIFICATE_ROWS) throw new Error('템플릿 문서 데이터는 1행 이상, 2,000행 이하로 입력해주세요.');
    const formats = { pdf: payload.formats?.pdf !== false, pptx: Boolean(payload.formats?.pptx) };
    if (!formats.pdf && !formats.pptx) throw new Error('PDF 또는 PPTX 출력 형식을 하나 이상 선택해주세요.');
    const outputDirectory = this.resolveToken(ownerId, payload.outputToken, 'output-directory').filePath;
    return this.enqueue('certificate-generate', ownerId, payload.requestId, async (jobId, control) => {
      const source = await this.certificateSource(ownerId, payload);
      const { buffer } = await readPptxFile(source.filePath);
      const inspected = await inspectPptxFile(source.filePath);
      const selection = this.validateCertificateSelection(inspected, payload.slideNumber, payload.fields);
      const filenameFieldIndex = Math.min(selection.fields.length - 1, Math.max(0, Number(payload.filenameFieldIndex) || 0));
      const hasFilenameTemplate = Object.prototype.hasOwnProperty.call(payload, 'filenameTemplate');
      const requestedFilenameTemplate = hasFilenameTemplate
        ? String(payload.filenameTemplate ?? '').trim()
        : String(source.profile?.filenameTemplate || '').trim();
      if (hasFilenameTemplate && !requestedFilenameTemplate) throw new Error('파일명 규칙을 입력해주세요. 예: {A} 또는 {이름}');
      const filenameTemplate = String(requestedFilenameTemplate).trim()
        ? compileCertificateFilenameTemplate(requestedFilenameTemplate, selection.fields)
        : null;
      if (formats.pdf) await this.assertExactFontsAvailable(inspected, '템플릿 문서');
      const engineInfo = formats.pdf ? await this.selectedNativePowerPointEngine() : { engine: 'pptx-only' };
      let activeEngine = engineInfo.engine;
      const extensions = [formats.pdf ? 'pdf' : '', formats.pptx ? 'pptx' : ''].filter(Boolean);
      const reserved = new Set();
      const plans = [];
      for (let index = 0; index < rows.length; index += 1) {
        control.throwIfCancelled();
        const values = Array.isArray(rows[index]?.values) ? rows[index].values.slice(0, selection.fields.length).map((value) => String(value ?? '').slice(0, 4_000)) : [];
        while (values.length < selection.fields.length) values.push('');
        const fallback = `문서-${String(index + 1).padStart(3, '0')}`;
        const requestedStem = filenameTemplate
          ? renderCertificateFilenameTemplate(filenameTemplate, values, index + 1)
          : values[filenameFieldIndex] || fallback;
        const output = await this.availableOutputBase(outputDirectory, requestedStem, extensions, reserved);
        plans.push({ index, values, output });
      }

      const root = await makeJobDirectory();
      const results = [];
      progress({ jobId, phase: 'start', engine: activeEngine, total: plans.length });
      try {
        for (let offset = 0; offset < plans.length; offset += POWERPOINT_CHUNK_SIZE) {
          control.throwIfCancelled();
          const chunk = plans.slice(offset, offset + POWERPOINT_CHUNK_SIZE);
          const prepared = [];
          for (const plan of chunk) {
            try {
              const replacements = new Map(selection.fields.map((field, fieldIndex) => [field.blockId, plan.values[fieldIndex]]));
              const certificate = await buildCertificatePptx(buffer, { slideNumber: Number(payload.slideNumber), replacements });
              const temporaryPptx = path.join(root, `certificate-${String(plan.index + 1).padStart(5, '0')}.pptx`);
              const temporaryPdf = path.join(root, `certificate-${String(plan.index + 1).padStart(5, '0')}.pdf`);
              await fs.promises.writeFile(temporaryPptx, certificate);
              prepared.push({ ...plan, temporaryPptx, temporaryPdf });
            } catch (error) {
              results[plan.index] = { ok: false, row: plan.index + 1, error: boundedText(error.message, 500) };
              progress({ jobId, phase: 'generate', index: plan.index, total: plans.length, ok: false, error: error.message });
            }
          }

          const pdfResults = new Map();
          if (formats.pdf && prepared.length) {
            control.throwIfCancelled();
            const converted = await this.runPowerPointOperation(
              'pdf',
              prepared.map((plan) => ({ inputPath: plan.temporaryPptx, outputPath: plan.temporaryPdf })),
              root
            );
            converted.forEach((result, resultIndex) => {
              const localIndex = Number(result?.index);
              const plan = Number.isInteger(localIndex) && localIndex >= 0 && localIndex < prepared.length
                ? prepared[localIndex]
                : prepared[resultIndex];
              if (plan) pdfResults.set(plan.index, result);
            });
            for (const plan of prepared) {
              if (!pdfResults.has(plan.index)) pdfResults.set(plan.index, { ok: false, error: 'PowerPoint 작업 결과를 확인하지 못했습니다.' });
            }
          }

          control.throwIfCancelled();
          for (const plan of prepared) {
            const outputs = [];
            const createdOutputs = [];
            let error = '';
            try {
              if (formats.pdf) {
                const pdfResult = pdfResults.get(plan.index);
                if (!pdfResult?.ok) throw new Error(pdfResult?.error || 'PDF를 만들지 못했습니다.');
                const validateCertificatePdf = async (filePath) => {
                  const validation = await this.validateConvertedOutputFile(
                    filePath,
                    'pdf',
                    this.inspectPptxFile,
                    this.inspectPdfFile
                  );
                  if (validation.pageCount !== 1) {
                    throw new Error('생성된 수료증 PDF가 한 페이지가 아니어서 저장을 중단했습니다.');
                  }
                  return validation;
                };
                const copiedPdf = await this.copyValidatedExclusive(
                  plan.temporaryPdf,
                  plan.output.paths.pdf,
                  { validateSource: validateCertificatePdf, validateDestination: validateCertificatePdf }
                );
                createdOutputs.push({ filePath: copiedPdf.destinationPath, stats: copiedPdf.destinationStats });
                outputs.push(path.basename(plan.output.paths.pdf));
              }
              if (formats.pptx) {
                const validateCertificatePptx = async (filePath) => {
                  const validation = await this.validateConvertedOutputFile(
                    filePath,
                    'pptx',
                    this.inspectPptxFile,
                    this.inspectPdfFile
                  );
                  if (validation.slideCount !== 1) {
                    throw new Error('생성된 수료증 PPTX가 한 슬라이드가 아니어서 저장을 중단했습니다.');
                  }
                  return validation;
                };
                const copiedPptx = await this.copyValidatedExclusive(
                  plan.temporaryPptx,
                  plan.output.paths.pptx,
                  { validateSource: validateCertificatePptx, validateDestination: validateCertificatePptx }
                );
                createdOutputs.push({ filePath: copiedPptx.destinationPath, stats: copiedPptx.destinationStats });
                outputs.push(path.basename(plan.output.paths.pptx));
              }
            } catch (copyError) {
              error = copyError.message;
              for (const created of createdOutputs) {
                if (isPathInside(outputDirectory, created.filePath)) {
                  try {
                    const currentStats = await fs.promises.stat(created.filePath);
                    if (this.sameOutputFileObject(created.stats, currentStats)) await fs.promises.unlink(created.filePath);
                  } catch (cleanupError) {
                    if (cleanupError.code !== 'ENOENT') console.error('부분 생성 파일 정리 실패:', cleanupError);
                  }
                }
              }
              outputs.length = 0;
            }
            results[plan.index] = error
              ? { ok: false, row: plan.index + 1, error: boundedText(error, 500) }
              : { ok: true, row: plan.index + 1, outputNames: outputs };
            progress({ jobId, phase: 'generate', index: plan.index, total: plans.length, ok: !error, error });
          }
        }
        const normalizedResults = plans.map((plan) => results[plan.index] || { ok: false, row: plan.index + 1, error: '생성 결과를 확인하지 못했습니다.' });
        progress({ jobId, phase: 'complete', total: plans.length, completed: normalizedResults.filter((item) => item.ok).length });
        return {
          jobId,
          engine: activeEngine,
          results: normalizedResults,
          completed: normalizedResults.filter((item) => item.ok).length,
          failed: normalizedResults.filter((item) => !item.ok).length
        };
      } finally { await removeGeneratedDirectory(root); }
    });
  }

  async listProfiles() {
    const raw = await this.storage.get('certificateProfiles', []);
    const profiles = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!PROFILE_ID_PATTERN.test(String(item?.id || ''))) continue;
      const templatePath = path.join(this.templatesRoot, item.id, 'template.pptx');
      if (!isPathInside(this.templatesRoot, templatePath) || !fs.existsSync(templatePath)) continue;
      profiles.push({
        id: item.id,
        name: boundedText(item.name, 80, '템플릿 양식'),
        sourceName: boundedText(item.sourceName, 160, 'template.pptx'),
        slideNumber: Math.max(1, Number(item.slideNumber) || 1),
        fields: Array.isArray(item.fields) ? item.fields.slice(0, MAX_CERTIFICATE_FIELDS).map((field, index) => ({ blockId: boundedText(field.blockId, 160), label: boundedText(field.label, 80, `항목 ${index + 1}`) })) : [],
        filenameTemplate: boundedText(item.filenameTemplate, 160, '{A}') || '{A}',
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || ''
      });
    }
    return profiles.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async profileById(profileId) {
    if (!PROFILE_ID_PATTERN.test(String(profileId || ''))) throw new Error('저장된 템플릿 양식 정보가 올바르지 않습니다.');
    const profile = (await this.listProfiles()).find((item) => item.id === profileId);
    if (!profile) throw new Error('저장된 템플릿 양식을 찾을 수 없습니다.');
    return profile;
  }

  async openProfile(ownerId, profileId) {
    const profile = await this.profileById(profileId);
    const templatePath = path.join(this.templatesRoot, profile.id, 'template.pptx');
    const inspected = await inspectPptxFile(templatePath);
    const certificatePdfReadiness = await this.certificatePdfReadiness(inspected);
    return {
      token: this.issueToken(ownerId, 'certificate-template', templatePath),
      profile,
      name: profile.name,
      bytes: inspected.sourceBytes,
      slideCount: inspected.slideCount,
      slideSize: inspected.slideSize,
      fontReport: certificatePdfReadiness.fontReport,
      certificatePdfReadiness,
      requiredFonts: certificatePdfReadiness.requiredFonts,
      preparationPlan: certificatePdfReadiness.preparationPlan,
      slides: inspected.slides.map((slide) => ({ number: slide.number, blockCount: slide.blockCount, visibleBlockCount: slide.visibleBlockCount ?? slide.blockCount, blocks: slide.blocks }))
    };
  }

  async saveProfile(ownerId, payload = {}) {
    const source = this.resolveToken(ownerId, payload.templateToken, 'certificate-template');
    const inspected = await inspectPptxFile(source.filePath);
    const selection = this.validateCertificateSelection(inspected, payload.slideNumber, payload.fields);
    const filenameTemplate = String(payload.filenameTemplate ?? '').trim();
    if (!filenameTemplate) throw new Error('저장할 파일명 규칙을 입력해주세요. 예: {A} 또는 {이름}');
    if (filenameTemplate.length > 160) throw new Error('저장할 파일명 템플릿은 160자 이하로 입력해주세요.');
    compileCertificateFilenameTemplate(filenameTemplate, selection.fields);
    const id = crypto.randomUUID();
    const profileDirectory = path.join(this.templatesRoot, id);
    if (!isPathInside(this.templatesRoot, profileDirectory)) throw new Error('템플릿 양식 저장 위치가 올바르지 않습니다.');
    const now = new Date().toISOString();
    const profile = {
      id,
      name: boundedText(payload.name, 80, path.parse(source.filePath).name) || '템플릿 양식',
      sourceName: path.basename(source.filePath).slice(0, 160),
      slideNumber: Number(payload.slideNumber),
      fields: selection.fields,
      filenameTemplate,
      createdAt: now,
      updatedAt: now
    };
    await fs.promises.mkdir(this.templatesRoot, { recursive: true });
    await fs.promises.mkdir(profileDirectory, { recursive: false });
    try {
      const validateStoredTemplate = async (filePath) => {
        const verified = await inspectPptxFile(filePath);
        if (verified.slideCount !== inspected.slideCount
          || !sameSlideSize(verified.slideSize, inspected.slideSize)) {
          throw new Error('저장된 템플릿의 슬라이드 수 또는 크기가 원본과 다릅니다.');
        }
        return verified;
      };
      await this.copyValidatedExclusive(
        source.filePath,
        path.join(profileDirectory, 'template.pptx'),
        { validateSource: validateStoredTemplate, validateDestination: validateStoredTemplate }
      );
      const profiles = await this.listProfiles();
      await this.storage.set('certificateProfiles', [profile, ...profiles]);
      return profile;
    } catch (error) {
      try { await fs.promises.rm(profileDirectory, { recursive: true, force: true }); } catch (_) {}
      throw error;
    }
  }

  async deleteProfile(profileId) {
    const profile = await this.profileById(profileId);
    const profileDirectory = path.join(this.templatesRoot, profile.id);
    if (!isPathInside(this.templatesRoot, profileDirectory)) throw new Error('템플릿 양식 저장 위치가 올바르지 않습니다.');
    await this.shell.trashItem(profileDirectory);
    const profiles = (await this.listProfiles()).filter((item) => item.id !== profile.id);
    await this.storage.set('certificateProfiles', profiles);
    return { ok: true, id: profile.id };
  }
}

module.exports = {
  MAX_BATCH_FILES,
  MAX_DOCUMENT_SOURCE_BYTES,
  MAX_HWP_SOURCE_BYTES,
  MAX_INSPECTABLE_DOCUMENT_SOURCE_BYTES,
  MAX_CONVERTED_ZIP_REQUIRED_BINARY_BYTES,
  MAX_CERTIFICATE_ROWS,
  MAX_CERTIFICATE_FIELDS,
  DOCUMENT_CONVERSION_INPUT_KIND,
  DOCUMENT_SOURCE_EXTENSIONS,
  normalizeDocumentConversionSourceExtensions,
  documentConversionSourceSelectionLabel,
  DOCUMENTS_MERGE_KIND,
  DOCUMENTS_MERGE_MODE,
  DOCUMENTS_MERGE_EXTENSIONS,
  NATIVE_OFFICE_MERGE_KINDS,
  NATIVE_OFFICE_MERGE_DEPENDENCIES,
  OPENABLE_DOCUMENT_OUTPUT_EXTENSIONS,
  DOCUMENT_APPLICATION_PROBES,
  documentSourceByteLimit,
  assertDocumentSourceStats,
  normalizeDocumentToolsMergeKind,
  safeOutputStem,
  spreadsheetColumnLabel,
  spreadsheetColumnIndex,
  compileCertificateFilenameTemplate,
  renderCertificateFilenameTemplate,
  isPathInside,
  decodeProcessOutput,
  decodeDelimitedFile,
  windowsNativeOutputEncoding,
  runProcess,
  powerPointErrorMessage,
  parseDelimitedText,
  normalizeImportedMatrix,
  pngDimensions,
  normalizeFontKey,
  baseFontKey,
  parseWindowsFontRegistry,
  parseWindowsInstalledFontCollection,
  missingFontFamilies,
  WINDOWS_FONT_COLLECTION_SCRIPT,
  findLibreOfficePath,
  nativeDocumentWorkerPath,
  parseTasklistImageNames,
  parseRegistryQueryValues,
  portableExecutableInfo,
  registeredComProgId,
  comProgIdRegistered,
  queryRegistryValues,
  probeHancomAutomationSecurityModule,
  runningDocumentProcesses,
  probeDocumentApplications,
  powerPointRegistered,
  powerPointProcessRunning,
  runLibreOfficeConversion,
  validateConvertedOutputFile,
  powerPointMergeTimeoutMs,
  runPowerPointOperation,
  nativeDocumentErrorMessage,
  runNativeDocumentConversion,
  DocumentTools
};
