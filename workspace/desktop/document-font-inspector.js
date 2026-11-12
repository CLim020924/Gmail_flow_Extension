'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const packagedSaxes = process.resourcesPath
  ? path.join(process.resourcesPath, 'vendor', 'node_modules', 'saxes')
  : '';
const vendorModulesPath = packagedSaxes && nodeFs.existsSync(packagedSaxes)
  ? path.dirname(packagedSaxes)
  : path.join(__dirname, '..', 'vendor', 'node_modules');
const JSZip = require(path.join(vendorModulesPath, 'jszip'));
const { SaxesParser } = require(path.join(vendorModulesPath, 'saxes'));

const SUPPORTED_FORMATS = new Set(['pptx', 'docx', 'xlsx', 'hwpx']);
const UNSUPPORTED_FORMAT_REASONS = Object.freeze({
  hwp: 'BINARY_HWP_UNSUPPORTED',
  cell: 'BINARY_HANCELL_UNSUPPORTED',
  nxl: 'BINARY_HANCELL_UNSUPPORTED',
  ppt: 'LEGACY_BINARY_OFFICE_UNSUPPORTED',
  doc: 'LEGACY_BINARY_OFFICE_UNSUPPORTED',
  xls: 'LEGACY_BINARY_OFFICE_UNSUPPORTED',
  pptm: 'MACRO_ENABLED_OFFICE_UNSUPPORTED',
  docm: 'MACRO_ENABLED_OFFICE_UNSUPPORTED',
  xlsm: 'MACRO_ENABLED_OFFICE_UNSUPPORTED',
  xlsb: 'BINARY_EXCEL_UNSUPPORTED'
});

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_XML_PART_BYTES = 32 * 1024 * 1024;
const MAX_PARSED_XML_BYTES = 128 * 1024 * 1024;
const MAX_FONT_FAMILIES = 4_096;
const MAX_FONT_FAMILY_LENGTH = 256;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const THEME_PLACEHOLDER = /^\+(?:mj|mn)(?:[-_].*)?$/i;
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'sans serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'system', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset',
  'default', 'auto', 'none'
]);

class DocumentFontInspectionError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'DocumentFontInspectionError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function inspectionError(code, message, cause) {
  return new DocumentFontInspectionError(code, message, cause);
}

function normalizeExtension(value) {
  const extension = String(value || '').trim().replace(/^\./, '').toLocaleLowerCase('en-US');
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : '';
}

function normalizeOptions(extensionOrOptions) {
  if (typeof extensionOrOptions === 'string') return { extension: normalizeExtension(extensionOrOptions) };
  if (!extensionOrOptions) return {};
  if (typeof extensionOrOptions !== 'object' || Array.isArray(extensionOrOptions)) {
    throw inspectionError('INSPECTION_OPTIONS_INVALID', '글꼴 검사 옵션이 올바르지 않습니다.');
  }
  return { ...extensionOrOptions };
}

function unsupportedResult(format, reasonCode) {
  return {
    checked: false,
    supported: false,
    format: format || null,
    usedFonts: [],
    embeddedFonts: [],
    families: [],
    reasonCode
  };
}

function supportedResult(format, usedFonts, embeddedFonts, themeSupplementalFonts = []) {
  return {
    checked: true,
    supported: true,
    format,
    usedFonts: [...usedFonts],
    embeddedFonts: [...embeddedFonts],
    families: [...usedFonts],
    themeSupplementalFonts: themeSupplementalFonts.map((item) => ({ ...item }))
  };
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw inspectionError('DOCUMENT_ZIP_INVALID', '문서 ZIP의 중앙 디렉터리를 찾을 수 없습니다.');
}

function safeArchivePath(rawName) {
  if (typeof rawName !== 'string' || !rawName || rawName.length > 2_048 || /\u0000/.test(rawName)) {
    throw inspectionError('DOCUMENT_ZIP_PATH_INVALID', '문서 ZIP 항목 이름이 올바르지 않습니다.');
  }
  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    throw inspectionError('DOCUMENT_ZIP_SLIP', '문서 ZIP에 절대 경로가 포함되어 있습니다.');
  }
  if (/%(?:2e|2f|5c|25)/i.test(normalized)) {
    throw inspectionError('DOCUMENT_ZIP_PATH_INVALID', '문서 ZIP에 모호하게 인코딩된 경로가 포함되어 있습니다.');
  }
  const isDirectory = normalized.endsWith('/');
  const trimmed = isDirectory ? normalized.slice(0, -1) : normalized;
  const segments = trimmed.split('/');
  if (!trimmed || segments.length > 64 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw inspectionError('DOCUMENT_ZIP_SLIP', '문서 ZIP에 상위 경로나 빈 경로가 포함되어 있습니다.');
  }
  for (const segment of segments) {
    if (segment.length > 255 || /[<>:"|?*\u0000-\u001f\u007f]/.test(segment)
      || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment)) {
      throw inspectionError('DOCUMENT_ZIP_PATH_INVALID', '문서 ZIP에 Windows에서 안전하지 않은 경로가 포함되어 있습니다.');
    }
  }
  return { name: segments.join('/'), isDirectory };
}

function decodeEntryName(bytes, utf8) {
  try {
    return utf8
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : Buffer.from(bytes).toString('latin1');
  } catch (error) {
    throw inspectionError('DOCUMENT_ZIP_PATH_INVALID', '문서 ZIP 항목 이름의 문자 인코딩이 손상되었습니다.', error);
  }
}

function preflightZipArchive(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buffer.length) throw inspectionError('DOCUMENT_EMPTY', '문서 파일이 비어 있습니다.');
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw inspectionError('DOCUMENT_TOO_LARGE', '글꼴과 문서 구조를 안전하게 검사할 수 있도록 문서 파일은 128MB 이하만 사용할 수 있습니다.');
  }
  if (buffer.length < 22) throw inspectionError('DOCUMENT_ZIP_INVALID', '문서 ZIP이 너무 짧습니다.');

  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw inspectionError('DOCUMENT_ZIP_UNSUPPORTED', '다중 디스크 또는 ZIP64 문서는 검사하지 않습니다.');
  }
  if (!totalEntries || totalEntries > MAX_ARCHIVE_ENTRIES) {
    throw inspectionError('DOCUMENT_ZIP_ENTRY_LIMIT', '문서 ZIP 항목 수가 허용 범위를 벗어났습니다.');
  }
  if (centralOffset + centralSize > eocd) {
    throw inspectionError('DOCUMENT_ZIP_INVALID', '문서 ZIP 중앙 디렉터리 범위가 올바르지 않습니다.');
  }

  const entries = [];
  const names = new Set();
  let uncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw inspectionError('DOCUMENT_ZIP_INVALID', '문서 ZIP 중앙 디렉터리 항목이 손상되었습니다.');
    }
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const entryBytes = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || (flags & 0x0001)) {
      throw inspectionError('DOCUMENT_ZIP_INVALID', '암호화되었거나 손상된 문서 ZIP 항목은 검사하지 않습니다.');
    }
    const rawName = decodeEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), Boolean(flags & 0x0800));
    const safe = safeArchivePath(rawName);
    const key = safe.name.normalize('NFKC').toLocaleLowerCase('en-US');
    if (names.has(key)) throw inspectionError('DOCUMENT_ZIP_DUPLICATE', '문서 ZIP에 대소문자만 다른 중복 경로가 있습니다.');
    names.add(key);
    const hostSystem = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (hostSystem === 3 && (unixMode & 0o170000) === 0o120000) {
      throw inspectionError('DOCUMENT_ZIP_SYMLINK', '문서 ZIP의 심볼릭 링크는 검사하지 않습니다.');
    }
    if (!safe.isDirectory) {
      if (entryBytes > MAX_ENTRY_BYTES) throw inspectionError('DOCUMENT_ZIP_BOMB', '문서 ZIP 단일 항목이 너무 큽니다.');
      uncompressedBytes += entryBytes;
      if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw inspectionError('DOCUMENT_ZIP_BOMB', '문서 ZIP의 압축 해제 크기가 허용 범위를 초과합니다.');
      }
    }
    entries.push({ ...safe, uncompressedBytes: entryBytes });
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) {
    throw inspectionError('DOCUMENT_ZIP_INVALID', '문서 ZIP 중앙 디렉터리 크기가 일치하지 않습니다.');
  }
  return { entryCount: totalEntries, uncompressedBytes, entries };
}

function unixFileType(entry) {
  let permissions = entry?.unixPermissions;
  if (typeof permissions === 'string') permissions = Number.parseInt(permissions, 8);
  return Number.isInteger(permissions) ? (permissions & 0o170000) : 0;
}

async function loadSafeArchive(buffer) {
  const preflight = preflightZipArchive(buffer);
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  } catch (error) {
    throw inspectionError('DOCUMENT_ZIP_INVALID', '문서 ZIP을 읽을 수 없습니다.', error);
  }
  const jszipEntries = Object.values(archive.files);
  if (jszipEntries.length !== preflight.entryCount) {
    throw inspectionError('DOCUMENT_ZIP_ENTRY_MISMATCH', '문서 ZIP 항목 목록이 중앙 디렉터리와 일치하지 않습니다.');
  }
  const entries = [];
  const names = new Set();
  for (const entry of jszipEntries) {
    const rawName = typeof entry.unsafeOriginalName === 'string' ? entry.unsafeOriginalName : entry.name;
    const safe = safeArchivePath(rawName);
    const key = safe.name.normalize('NFKC').toLocaleLowerCase('en-US');
    if (names.has(key)) throw inspectionError('DOCUMENT_ZIP_DUPLICATE', '문서 ZIP에 중복 경로가 있습니다.');
    names.add(key);
    if (unixFileType(entry) === 0o120000) {
      throw inspectionError('DOCUMENT_ZIP_SYMLINK', '문서 ZIP의 심볼릭 링크는 검사하지 않습니다.');
    }
    entries.push({ entry, ...safe });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return entries;
}

function detectArchiveFormat(entries) {
  const names = new Set(entries.map((item) => item.name.toLocaleLowerCase('en-US')));
  const candidates = [];
  if (names.has('ppt/presentation.xml')) candidates.push('pptx');
  if (names.has('word/document.xml')) candidates.push('docx');
  if (names.has('xl/workbook.xml')) candidates.push('xlsx');
  if (names.has('contents/content.hpf')
    || (names.has('contents/header.xml') && [...names].some((name) => /^contents\/section\d+\.xml$/.test(name)))) {
    candidates.push('hwpx');
  }
  if (candidates.length > 1) throw inspectionError('DOCUMENT_FORMAT_AMBIGUOUS', '서로 다른 문서 형식의 핵심 항목이 한 ZIP에 섞여 있습니다.');
  return candidates[0] || '';
}

function shouldInspectPart(format, name) {
  const lower = name.toLocaleLowerCase('en-US');
  if (format === 'pptx') return lower.startsWith('ppt/') && lower.endsWith('.xml');
  if (format === 'docx') return lower.startsWith('word/') && lower.endsWith('.xml');
  if (format === 'xlsx') return lower.startsWith('xl/') && lower.endsWith('.xml');
  if (format === 'hwpx') return lower.startsWith('contents/') && (lower.endsWith('.xml') || lower.endsWith('.hpf'));
  return false;
}

async function readEntryLimited(entry, maximumBytes) {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream('nodebuffer');
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream.destroy?.();
      reject(error);
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maximumBytes) {
        fail(inspectionError('DOCUMENT_XML_TOO_LARGE', '문서 XML 항목의 실제 압축 해제 크기가 너무 큽니다.'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on('error', (error) => fail(inspectionError('DOCUMENT_ZIP_INVALID', '문서 ZIP 항목을 압축 해제하지 못했습니다.', error)));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
  });
}

function decodeXmlBytes(source, partName) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source || []);
  if (bytes.length > MAX_XML_PART_BYTES) throw inspectionError('DOCUMENT_XML_TOO_LARGE', `${partName} XML 항목이 너무 큽니다.`);
  let encoding = 'utf-8';
  let offset = 0;
  if (bytes.length >= 4
    && ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00))) {
    throw inspectionError('DOCUMENT_XML_ENCODING_UNSUPPORTED', `${partName}의 UTF-32 XML은 지원하지 않습니다.`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'; offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'; offset = 2;
  } else if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00) {
    encoding = 'utf-16le';
  } else if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] === 0x3f) {
    encoding = 'utf-16be';
  }
  let encoded = bytes.subarray(offset);
  if (encoding === 'utf-16be') {
    if (encoded.length % 2) throw inspectionError('DOCUMENT_XML_INVALID', `${partName}의 UTF-16 XML이 손상되었습니다.`);
    const swapped = Buffer.allocUnsafe(encoded.length);
    for (let index = 0; index < encoded.length; index += 2) {
      swapped[index] = encoded[index + 1];
      swapped[index + 1] = encoded[index];
    }
    encoded = swapped;
    encoding = 'utf-16le';
  }
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(encoded);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    throw inspectionError('DOCUMENT_XML_INVALID', `${partName} XML의 문자 인코딩이 손상되었습니다.`, error);
  }
}

class FontCollector {
  constructor() {
    this.used = [];
    this.embedded = [];
    this.themeSupplemental = [];
    this.usedSet = new Set();
    this.embeddedSet = new Set();
    this.themeSupplementalSet = new Set();
  }

  clean(value) {
    const family = String(value ?? '').trim();
    if (!family || family.length > MAX_FONT_FAMILY_LENGTH || /[\u0000-\u001f\u007f]/.test(family)) return '';
    const key = family.toLocaleLowerCase('en-US');
    if (THEME_PLACEHOLDER.test(family) || GENERIC_FAMILIES.has(key)) return '';
    return family;
  }

  add(value, embedded = false) {
    const family = this.clean(value);
    if (!family) return;
    if (!this.usedSet.has(family)) {
      if (this.used.length >= MAX_FONT_FAMILIES) throw inspectionError('FONT_FAMILY_LIMIT', '문서에 선언된 글꼴 가족이 너무 많습니다.');
      this.usedSet.add(family);
      this.used.push(family);
    }
    if (embedded && !this.embeddedSet.has(family)) {
      this.embeddedSet.add(family);
      this.embedded.push(family);
    }
  }

  addThemeSupplemental(value, script = '') {
    const family = this.clean(value);
    if (!family) return;
    const normalizedScript = String(script || '').trim().slice(0, 32);
    const key = `${normalizedScript.toLocaleLowerCase('en-US')}\u0000${family.toLocaleLowerCase('en-US')}`;
    if (this.themeSupplementalSet.has(key)) return;
    if (this.themeSupplemental.length >= MAX_FONT_FAMILIES) {
      throw inspectionError('FONT_FAMILY_LIMIT', '문서 테마에 선언된 보조 글꼴 가족이 너무 많습니다.');
    }
    this.themeSupplementalSet.add(key);
    this.themeSupplemental.push({ script: normalizedScript, family });
  }
}

function localName(value) {
  return String(value?.local || value?.name || value || '').split(':').pop().toLocaleLowerCase('en-US');
}

function attributes(tag) {
  return Object.values(tag?.attributes || {}).map((attribute) => ({
    local: localName(attribute),
    value: String(attribute?.value ?? '')
  }));
}

function attribute(tag, wanted) {
  const names = new Set((Array.isArray(wanted) ? wanted : [wanted]).map((name) => String(name).toLocaleLowerCase('en-US')));
  return attributes(tag).find((item) => names.has(item.local))?.value || '';
}

function ancestor(stack, name) {
  return stack.some((item) => item.local === name);
}

function extractPptxTag(tag, stack, collector, partName) {
  const current = localName(tag);
  const typefaceElements = new Set(['rpr', 'defrpr', 'endpararpr', 'latin', 'ea', 'cs', 'sym', 'font']);
  if (!typefaceElements.has(current)) return;
  const typeface = attribute(tag, 'typeface');
  if (current === 'font' && partName.toLocaleLowerCase('en-US').startsWith('ppt/theme/')) {
    collector.addThemeSupplemental(typeface, attribute(tag, 'script'));
    return;
  }
  if (typeface) collector.add(typeface, current === 'font' && ancestor(stack, 'embeddedfont'));
}

function extractDocxTag(tag, stack, collector, partName, context) {
  const current = localName(tag);
  if (current === 'rfonts') {
    for (const name of ['ascii', 'hansi', 'eastasia', 'cs']) collector.add(attribute(tag, name));
  }
  const lowerPart = partName.toLocaleLowerCase('en-US');
  if (lowerPart.startsWith('word/theme/') && ['latin', 'ea', 'cs', 'font'].includes(current)) {
    if (current === 'font') collector.addThemeSupplemental(attribute(tag, 'typeface'), attribute(tag, 'script'));
    else collector.add(attribute(tag, 'typeface'));
  }
  if (lowerPart === 'word/fonttable.xml' && current === 'font') {
    const family = attribute(tag, 'name');
    collector.add(family);
    context.fontTableFamily = family;
  } else if (lowerPart === 'word/fonttable.xml' && /^embed(?:regular|bold|italic|bolditalic)$/.test(current)) {
    const fontContext = [...stack].reverse().find((item) => item.fontTableFamily);
    if (fontContext?.fontTableFamily && attribute(tag, ['id', 'fontkey'])) collector.add(fontContext.fontTableFamily, true);
  }
}

function extractXlsxTag(tag, stack, collector, partName) {
  const current = localName(tag);
  const parent = stack.at(-1)?.local || '';
  if (current === 'rfont') collector.add(attribute(tag, 'val'));
  if (current === 'name' && parent === 'font') collector.add(attribute(tag, 'val'));
  if (partName.toLocaleLowerCase('en-US').startsWith('xl/theme/')
    && ['latin', 'ea', 'cs', 'font'].includes(current)) {
    if (current === 'font') collector.addThemeSupplemental(attribute(tag, 'typeface'), attribute(tag, 'script'));
    else collector.add(attribute(tag, 'typeface'));
  }
}

function truthyEmbedded(value) {
  return /^(?:1|true|yes)$/i.test(String(value || '').trim());
}

function extractHwpxTag(tag, _stack, collector) {
  const current = localName(tag);
  const values = attributes(tag);
  const fontElement = current.includes('font') || current.includes('face');
  const embedded = truthyEmbedded(values.find((item) => ['isembedded', 'embedded'].includes(item.local))?.value);
  for (const item of values) {
    const explicitFontAttribute = [
      'fontface', 'fontname', 'fontfamily', 'typeface', 'facename',
      'font-face', 'font-name', 'font-family'
    ].includes(item.local);
    const faceOrName = fontElement && ['face', 'name'].includes(item.local);
    if ((explicitFontAttribute || faceOrName) && !/^\d+$/.test(item.value.trim())) collector.add(item.value, embedded);
  }
}

function parseXmlFonts(xml, format, partName, collector) {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw inspectionError('DOCUMENT_XML_DOCTYPE', `${partName}에 허용되지 않는 XML 문서 선언이 있습니다.`);
  }
  const stack = [];
  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on('opentag', (tag) => {
    const context = { local: localName(tag) };
    if (format === 'pptx') extractPptxTag(tag, stack, collector, partName);
    else if (format === 'docx') extractDocxTag(tag, stack, collector, partName, context);
    else if (format === 'xlsx') extractXlsxTag(tag, stack, collector, partName);
    else if (format === 'hwpx') extractHwpxTag(tag, stack, collector);
    stack.push(context);
  });
  parser.on('closetag', () => { stack.pop(); });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof DocumentFontInspectionError) throw error;
    throw inspectionError('DOCUMENT_XML_INVALID', `${partName} XML 형식이 올바르지 않습니다.`, error);
  }
}

async function inspectArchiveBuffer(buffer, formatHint) {
  const entries = await loadSafeArchive(buffer);
  const detected = detectArchiveFormat(entries);
  if (!detected) throw inspectionError('DOCUMENT_PACKAGE_STRUCTURE_INVALID', '지원 문서 형식의 핵심 ZIP 항목을 찾을 수 없습니다.');
  if (formatHint && formatHint !== detected) {
    throw inspectionError('DOCUMENT_FORMAT_MISMATCH', `확장자 ${formatHint}와 ZIP 내부 형식 ${detected}이(가) 일치하지 않습니다.`);
  }
  const format = detected;
  const collector = new FontCollector();
  let parsedBytes = 0;
  for (const item of entries) {
    if (item.isDirectory || !shouldInspectPart(format, item.name)) continue;
    const remaining = MAX_PARSED_XML_BYTES - parsedBytes;
    if (remaining <= 0) throw inspectionError('DOCUMENT_XML_TOTAL_LIMIT', '검사할 문서 XML의 전체 크기가 너무 큽니다.');
    const data = await readEntryLimited(item.entry, Math.min(MAX_XML_PART_BYTES, remaining));
    parsedBytes += data.length;
    const xml = decodeXmlBytes(data, item.name);
    parseXmlFonts(xml, format, item.name, collector);
  }
  return supportedResult(format, collector.used, collector.embedded, collector.themeSupplemental);
}

function extensionForInput(input, options) {
  const explicit = normalizeExtension(options.extension || options.format);
  if (explicit) return explicit;
  const named = options.fileName || options.name || (typeof input === 'string' ? input : '');
  return normalizeExtension(path.extname(String(named || '')));
}

function looksLikeCompoundBinary(buffer) {
  const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

async function inspectDocumentFontBuffer(input, extensionOrOptions = {}) {
  const options = normalizeOptions(extensionOrOptions);
  const buffer = Buffer.isBuffer(input) ? input : (input instanceof Uint8Array ? Buffer.from(input) : null);
  if (!buffer) throw inspectionError('DOCUMENT_BUFFER_INVALID', '문서 Buffer가 필요합니다.');
  const extension = extensionForInput(buffer, options);
  if (UNSUPPORTED_FORMAT_REASONS[extension]) return unsupportedResult(extension, UNSUPPORTED_FORMAT_REASONS[extension]);
  if (extension && !SUPPORTED_FORMATS.has(extension)) {
    return unsupportedResult(extension, 'DOCUMENT_FORMAT_UNSUPPORTED');
  }
  if (!buffer.length) throw inspectionError('DOCUMENT_EMPTY', '문서 파일이 비어 있습니다.');
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw inspectionError('DOCUMENT_TOO_LARGE', '글꼴과 문서 구조를 안전하게 검사할 수 있도록 문서 파일은 128MB 이하만 사용할 수 있습니다.');
  }
  if (!extension && looksLikeCompoundBinary(buffer)) {
    return unsupportedResult(null, 'BINARY_COMPOUND_DOCUMENT_UNSUPPORTED');
  }
  if (!extension && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    return unsupportedResult(null, 'DOCUMENT_FORMAT_UNSUPPORTED');
  }
  return inspectArchiveBuffer(buffer, extension);
}

async function inspectDocumentFontFile(filePath, extensionOrOptions = {}) {
  const options = normalizeOptions(extensionOrOptions);
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\u0000')) {
    throw inspectionError('DOCUMENT_PATH_INVALID', '검사할 문서 경로가 올바르지 않습니다.');
  }
  const extension = extensionForInput(filePath, options);
  if (UNSUPPORTED_FORMAT_REASONS[extension]) return unsupportedResult(extension, UNSUPPORTED_FORMAT_REASONS[extension]);
  if (extension && !SUPPORTED_FORMATS.has(extension)) {
    return unsupportedResult(extension, 'DOCUMENT_FORMAT_UNSUPPORTED');
  }
  const adapter = options.fs || nodeFs;
  const fsp = adapter.promises || adapter;
  if (!fsp || typeof fsp.stat !== 'function' || typeof fsp.readFile !== 'function') {
    throw inspectionError('FS_ADAPTER_INVALID', '문서 읽기용 파일 시스템 어댑터가 올바르지 않습니다.');
  }
  let stats;
  try { stats = await fsp.stat(filePath); }
  catch (error) { throw inspectionError('DOCUMENT_READ_FAILED', '문서 파일 정보를 읽지 못했습니다.', error); }
  if (!stats.isFile?.()) throw inspectionError('DOCUMENT_PATH_INVALID', '검사 대상은 일반 파일이어야 합니다.');
  if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > MAX_ARCHIVE_BYTES) {
    throw inspectionError('DOCUMENT_TOO_LARGE', '글꼴과 문서 구조를 안전하게 검사할 수 있도록 문서 파일은 128MB 이하만 사용할 수 있습니다.');
  }
  let buffer;
  try { buffer = await fsp.readFile(filePath); }
  catch (error) { throw inspectionError('DOCUMENT_READ_FAILED', '문서 파일을 읽지 못했습니다.', error); }
  return inspectDocumentFontBuffer(Buffer.from(buffer), { ...options, extension });
}

async function inspectDocumentFonts(input, extensionOrOptions = {}) {
  if (typeof input === 'string') return inspectDocumentFontFile(input, extensionOrOptions);
  return inspectDocumentFontBuffer(input, extensionOrOptions);
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  MAX_XML_PART_BYTES,
  MAX_PARSED_XML_BYTES,
  MAX_FONT_FAMILIES,
  SUPPORTED_FORMATS: Object.freeze([...SUPPORTED_FORMATS]),
  UNSUPPORTED_FORMAT_REASONS,
  DocumentFontInspectionError,
  preflightZipArchive,
  inspectDocumentFontBuffer,
  inspectDocumentFontFile,
  inspectDocumentFonts,
  inspectFonts: inspectDocumentFonts
};
