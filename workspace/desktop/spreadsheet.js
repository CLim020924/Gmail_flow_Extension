const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const Ops = require('../operations-core');
const packagedExcelJs = process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'node_modules', 'exceljs') : '';
const vendorModulesPath = packagedExcelJs && fs.existsSync(packagedExcelJs) ? path.dirname(packagedExcelJs) : path.join(__dirname, '..', 'vendor', 'node_modules');
const ExcelJS = require(path.join(vendorModulesPath, 'exceljs'));
const JSZip = require(path.join(vendorModulesPath, 'jszip'));
const { SaxesParser } = require(path.join(vendorModulesPath, 'saxes'));
const MAX_IMPORT_WORKBOOK_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_ARCHIVE_ENTRIES = 10_000;
const MAX_IMPORT_WORKSHEETS = 200;
const MAX_IMPORT_CELLS = 1_000_000;
const MAX_IMPORT_ROWS = 1_048_576;
const MAX_IMPORT_COLUMNS = 16_384;
const MAX_STRUCTURE_WORKBOOK_BYTES = 128 * 1024 * 1024;
const MAX_STRUCTURE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_STRUCTURE_ARCHIVE_ENTRIES = 20_000;
const MAX_STRUCTURE_XML_BYTES = 32 * 1024 * 1024;
const MAX_STRUCTURE_SHEETS = 10_000;
const SPREADSHEETML_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEETML_NAMESPACE = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const EXTENDED_PROPERTIES_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOCUMENT_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_DOCUMENT_RELATIONSHIPS_NAMESPACE = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const SPREADSHEETML_NAMESPACES = new Set([SPREADSHEETML_NAMESPACE, STRICT_SPREADSHEETML_NAMESPACE]);
const DOCUMENT_RELATIONSHIPS_NAMESPACES = new Set([
  DOCUMENT_RELATIONSHIPS_NAMESPACE,
  STRICT_DOCUMENT_RELATIONSHIPS_NAMESPACE
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeElementNamespacePrefix(xml, namespace) {
  const declaration = new RegExp(`\\bxmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*(['\"])${escapeRegExp(namespace)}\\2`, 'g');
  const prefixes = [...xml.matchAll(declaration)].map((match) => match[1]);
  let normalized = xml;
  for (const value of prefixes) {
    const prefix = escapeRegExp(value);
    normalized = normalized.replace(new RegExp(`<(/?)${prefix}:([A-Za-z_][\\w.-]*)`, 'g'), '<$1$2');
  }
  return { xml: normalized, changed: normalized !== xml };
}

function relationshipSourcePart(entryName) {
  if (entryName === '_rels/.rels') return '';
  const match = /^(.+)\/_rels\/([^/]+)\.rels$/.exec(entryName);
  return match ? `${match[1]}/${match[2]}` : null;
}

function normalizeAbsoluteRelationshipTargets(xml, entryName, archive) {
  const sourcePart = relationshipSourcePart(entryName);
  if (sourcePart === null) return { xml, changed: false };
  const sourceDirectory = sourcePart ? path.posix.dirname(sourcePart) : '.';
  let changed = false;
  const normalized = xml.replace(/<Relationship\b[^>]*>/g, (tag) => {
    if (/\bTargetMode\s*=\s*(['"])External\1/i.test(tag)) return tag;
    return tag.replace(/(\bTarget\s*=\s*)(['"])(\/+[^'"]*)\2/i, (attribute, start, quote, rawTarget) => {
      const fragmentIndex = rawTarget.search(/[?#]/);
      const packageTarget = (fragmentIndex < 0 ? rawTarget : rawTarget.slice(0, fragmentIndex))
        .replace(/^\/+/, '')
        .replace(/\\/g, '/');
      const suffix = fragmentIndex < 0 ? '' : rawTarget.slice(fragmentIndex);
      if (!packageTarget || !archive.file(packageTarget)) return attribute;
      const relativeTarget = path.posix.relative(sourceDirectory, packageTarget) || path.posix.basename(packageTarget);
      changed = true;
      return `${start}${quote}${relativeTarget}${suffix}${quote}`;
    });
  });
  return { xml: normalized, changed };
}

async function normalizeExcelJsWorkbookArchive(archive) {
  let changed = false;
  const xmlEntries = Object.values(archive.files).filter((entry) => (
    !entry.dir
    && (entry.name === 'docProps/app.xml' || (entry.name.startsWith('xl/') && entry.name.endsWith('.xml')))
  ));
  for (const entry of xmlEntries) {
    const original = await entry.async('string');
    const namespace = entry.name === 'docProps/app.xml'
      ? EXTENDED_PROPERTIES_NAMESPACE
      : SPREADSHEETML_NAMESPACE;
    const normalized = normalizeElementNamespacePrefix(original, namespace);
    if (!normalized.changed) continue;
    archive.file(entry.name, normalized.xml);
    changed = true;
  }
  const relationshipEntries = Object.values(archive.files).filter((entry) => !entry.dir && entry.name.endsWith('.rels'));
  for (const entry of relationshipEntries) {
    const original = await entry.async('string');
    const normalized = normalizeAbsoluteRelationshipTargets(original, entry.name, archive);
    if (!normalized.changed) continue;
    archive.file(entry.name, normalized.xml);
    changed = true;
  }
  if (!changed) return null;
  return archive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

async function inspectWorkbookArchive(buffer, options = {}) {
  const maximumEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : MAX_IMPORT_ARCHIVE_ENTRIES;
  const maximumUncompressedBytes = Number.isSafeInteger(options.maxUncompressedBytes) && options.maxUncompressedBytes > 0
    ? options.maxUncompressedBytes
    : MAX_IMPORT_UNCOMPRESSED_BYTES;
  const archive = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const entries = Object.values(archive.files);
  if (entries.length > maximumEntries) throw new Error('Excel 파일에 포함된 항목이 너무 많습니다. 필요한 시트만 새 파일로 저장한 뒤 다시 시도해주세요.');
  let uncompressedBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const size = Number(entry?._data?.uncompressedSize || 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Excel 압축 정보가 올바르지 않습니다.');
    uncompressedBytes += size;
    if (uncompressedBytes > maximumUncompressedBytes) {
      const megabytes = Math.floor(maximumUncompressedBytes / (1024 * 1024));
      throw new Error(`압축을 푼 Excel 파일이 ${megabytes}MB를 넘습니다. 필요한 시트만 새 파일로 저장한 뒤 다시 시도해주세요.`);
    }
  }
  return archive;
}

function spreadsheetImportError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function workbookPackageFeatures(archive) {
  const names = Object.keys(archive?.files || {});
  const count = (pattern) => names.filter((name) => pattern.test(name)).length;
  const invalidPaths = Object.values(archive?.files || {}).filter((entry) => {
    const rawName = String(entry?.unsafeOriginalName || entry?.name || '').replace(/\\/g, '/');
    return rawName.startsWith('/') || /^[A-Za-z]:\//.test(rawName)
      || rawName.split('/').some((segment) => segment === '..');
  }).length;
  return {
    macros: count(/(?:^|\/)(?:vbaProject\.bin|macrosheets\/)/i),
    signatures: count(/^_xmlsignatures\//i),
    encryptionParts: count(/^(?:EncryptionInfo|EncryptedPackage)$/i),
    rightsManagement: count(/(?:^|\/)(?:drm|dataspaces|licenses?)\//i),
    invalidPaths,
    charts: count(/^xl\/charts\/[^/]+\.xml$/i),
    pivots: count(/^xl\/(?:pivotTables|pivotCache)\//i),
    externalLinks: count(/^xl\/externalLinks\//i) + count(/^xl\/connections\.xml$/i),
    tables: count(/^xl\/tables\/[^/]+\.xml$/i),
    drawings: count(/^xl\/drawings\/[^/]+\.xml$/i)
  };
}

async function loadXlsxWorkbookSafely(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));
  if (path.extname(resolvedPath).toLocaleLowerCase('en-US') !== '.xlsx') {
    throw spreadsheetImportError('XLSX_IMPORT_FORMAT_INVALID', '프로그램 내부 Excel 처리는 XLSX 파일만 사용할 수 있습니다.');
  }

  let before;
  let source;
  try {
    before = await fs.promises.stat(resolvedPath);
    if (!before.isFile() || before.size <= 0) throw new Error('not-file');
    if (before.size > MAX_IMPORT_WORKBOOK_BYTES) {
      throw spreadsheetImportError('XLSX_IMPORT_FILE_TOO_LARGE', 'Excel 파일은 64MB 이하만 가져올 수 있습니다. 필요한 시트만 새 파일로 저장한 뒤 다시 시도해주세요.');
    }
    source = await fs.promises.readFile(resolvedPath);
  } catch (error) {
    if (String(error?.code || '').startsWith('XLSX_IMPORT_')) throw error;
    throw spreadsheetImportError('XLSX_IMPORT_FILE_UNREADABLE', 'Excel 파일을 읽을 수 없습니다. 파일이 이동되었거나 다른 프로그램에서 사용 중인지 확인해주세요.', error);
  }
  if (source.length !== before.size) {
    throw spreadsheetImportError('XLSX_IMPORT_INPUT_CHANGED', 'Excel 파일이 확인 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.');
  }
  if (source.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw spreadsheetImportError('XLSX_IMPORT_ENCRYPTED', '암호화된 Excel 파일은 프로그램 내부 병합으로 열 수 없습니다. 암호를 해제한 복사본을 선택해주세요.');
  }

  let archive;
  try {
    archive = await inspectWorkbookArchive(source);
  } catch (error) {
    const message = String(error?.message || '');
    if (/포함된 항목이 너무 많/.test(message) || /압축을 푼 Excel 파일/.test(message) || /압축 정보/.test(message)) {
      throw spreadsheetImportError('XLSX_IMPORT_ARCHIVE_LIMIT_EXCEEDED', message, error);
    }
    throw spreadsheetImportError('XLSX_IMPORT_ARCHIVE_INVALID', 'Excel 파일의 압축 구조를 읽지 못했습니다. 손상되었거나 올바른 XLSX 파일이 아닐 수 있습니다.', error);
  }

  const packageFeatures = workbookPackageFeatures(archive);
  if (packageFeatures.invalidPaths > 0) {
    throw spreadsheetImportError('XLSX_IMPORT_ARCHIVE_PATH_INVALID', 'Excel 파일 압축 안에 허용되지 않는 경로가 있어 열지 않았습니다.');
  }
  let contentTypesXml = '';
  let workbookRelationshipsXml = '';
  let workbookXml = '';
  try {
    const entry = archive.file('[Content_Types].xml');
    if (entry) contentTypesXml = decodeXmlPart(await readArchiveEntryBufferLimited(entry, 'Excel 콘텐츠 형식'), 'Excel 콘텐츠 형식');
    const relationshipsEntry = archive.file('xl/_rels/workbook.xml.rels');
    if (relationshipsEntry) {
      workbookRelationshipsXml = decodeXmlPart(
        await readArchiveEntryBufferLimited(relationshipsEntry, 'Excel 통합문서 관계'),
        'Excel 통합문서 관계'
      );
    }
    const workbookEntry = archive.file('xl/workbook.xml');
    if (workbookEntry) {
      workbookXml = decodeXmlPart(
        await readArchiveEntryBufferLimited(workbookEntry, 'Excel 통합문서'),
        'Excel 통합문서'
      );
    }
  } catch (error) {
    throw spreadsheetImportError('XLSX_IMPORT_ARCHIVE_INVALID', 'Excel 파일의 콘텐츠 형식 정보를 안전하게 읽지 못했습니다.', error);
  }
  if (packageFeatures.encryptionParts > 0 || packageFeatures.rightsManagement > 0
    || /(?:encryptedPackage|rightsManagement|informationRightsManagement)/i.test(contentTypesXml)) {
    throw spreadsheetImportError('XLSX_IMPORT_ENCRYPTED', '암호화된 Excel 파일은 프로그램 내부 병합으로 열 수 없습니다. 암호를 해제한 복사본을 선택해주세요.');
  }
  if (packageFeatures.macros > 0 || /(?:vbaProject|macroEnabled|macroSheet)/i.test(contentTypesXml)
    || /(?:vbaProject|intlMacroSheet|macroSheet)/i.test(workbookRelationshipsXml)) {
    throw spreadsheetImportError('XLSX_IMPORT_MACRO_REJECTED', '매크로가 포함된 Excel 파일은 프로그램 내부 병합 대상에서 제외됩니다.');
  }
  if (packageFeatures.signatures > 0) {
    throw spreadsheetImportError('XLSX_IMPORT_SIGNATURE_REJECTED', '디지털 서명이 있는 Excel 파일은 서명이 무효화될 수 있어 프로그램 내부 병합 대상에서 제외됩니다.');
  }
  if (/<(?:[A-Za-z_][\w.-]*:)?workbookProtection\b[^>]*\blockStructure\s*=\s*(['"])(?:1|true|on)\1/i.test(workbookXml)) {
    throw spreadsheetImportError('XLSX_IMPORT_PROTECTED_REJECTED', '통합문서 구조가 보호된 Excel 파일은 프로그램 내부 병합 대상에서 제외됩니다. 보호를 해제한 복사본을 선택해주세요.');
  }

  let workbook;
  try {
    const compatibleSource = await normalizeExcelJsWorkbookArchive(archive) || source;
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(compatibleSource);
  } catch (error) {
    throw spreadsheetImportError('XLSX_IMPORT_WORKBOOK_INVALID', '프로그램 내부 Excel 엔진이 파일 내용을 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 기능이 포함되었을 수 있습니다.', error);
  }
  if (!workbook.worksheets.length) {
    throw spreadsheetImportError('XLSX_IMPORT_WORKSHEET_MISSING', 'Excel 파일에 읽을 수 있는 워크시트가 없습니다.');
  }
  if (workbook.worksheets.length > MAX_IMPORT_WORKSHEETS) {
    throw spreadsheetImportError('XLSX_IMPORT_WORKSHEET_LIMIT_EXCEEDED', 'Excel 시트는 200개 이하만 가져올 수 있습니다. 필요한 시트만 새 파일로 저장한 뒤 다시 시도해주세요.');
  }
  if (workbook.worksheets.some((sheet) => sheet.sheetProtection
    && typeof sheet.sheetProtection === 'object'
    && Object.keys(sheet.sheetProtection).length > 0)) {
    throw spreadsheetImportError('XLSX_IMPORT_PROTECTED_REJECTED', '시트가 보호된 Excel 파일은 프로그램 내부 병합 대상에서 제외됩니다. 보호를 해제한 복사본을 선택해주세요.');
  }

  let totalCellCount = 0;
  let formulaCount = 0;
  let hyperlinkCount = 0;
  let commentCount = 0;
  let dataValidationCount = 0;
  let conditionalFormattingCount = 0;
  let imageCount = 0;
  const worksheets = workbook.worksheets.map((sheet) => {
    const rowCount = Math.max(0, Number(sheet.rowCount) || 0);
    const columnCount = Math.max(0, Number(sheet.columnCount) || 0);
    if (rowCount > MAX_IMPORT_ROWS) {
      throw spreadsheetImportError('XLSX_IMPORT_ROW_LIMIT_EXCEEDED', 'Excel 시트가 최대 행 수 1,048,576행을 넘습니다.');
    }
    if (columnCount > MAX_IMPORT_COLUMNS) {
      throw spreadsheetImportError('XLSX_IMPORT_COLUMN_LIMIT_EXCEEDED', 'Excel 시트가 최대 열 수 16,384열을 넘습니다.');
    }
    const cellCount = rowCount && columnCount ? rowCount * columnCount : 0;
    totalCellCount += cellCount;
    if (!Number.isSafeInteger(totalCellCount) || totalCellCount > MAX_IMPORT_CELLS) {
      throw spreadsheetImportError('XLSX_IMPORT_CELL_LIMIT_EXCEEDED', 'Excel 데이터 셀이 안전한 처리 한도인 100만 칸을 넘습니다. 필요한 행과 열만 새 파일로 저장한 뒤 다시 시도해주세요.');
    }
    dataValidationCount += Object.keys(sheet.dataValidations?.model || {}).length;
    conditionalFormattingCount += Array.isArray(sheet.conditionalFormattings) ? sheet.conditionalFormattings.length : 0;
    imageCount += typeof sheet.getImages === 'function' ? sheet.getImages().length : 0;
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.value && typeof cell.value === 'object'
        && (Object.hasOwn(cell.value, 'formula') || Object.hasOwn(cell.value, 'sharedFormula'))) formulaCount += 1;
      if (cell.value && typeof cell.value === 'object' && Object.hasOwn(cell.value, 'hyperlink')) hyperlinkCount += 1;
      if (cell.note != null) commentCount += 1;
    }));
    return {
      name: String(sheet.name || '').slice(0, 31),
      visibility: ['visible', 'hidden', 'veryHidden'].includes(sheet.state) ? sheet.state : 'visible',
      rowCount,
      columnCount,
      cellCount
    };
  });
  packageFeatures.formulas = formulaCount;
  packageFeatures.hyperlinks = hyperlinkCount;
  packageFeatures.comments = commentCount;
  packageFeatures.dataValidations = dataValidationCount;
  packageFeatures.conditionalFormatting = conditionalFormattingCount;
  packageFeatures.images = imageCount;
  packageFeatures.definedNames = Array.isArray(workbook.definedNames?.model) ? workbook.definedNames.model.length : 0;

  return {
    workbook,
    sourcePath: resolvedPath,
    sourceBytes: source.length,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    worksheets,
    totalCellCount,
    packageFeatures
  };
}

function spreadsheetStructureError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function decodeXmlPart(bytes, label) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!source.length || source.length > MAX_STRUCTURE_XML_BYTES) {
    throw spreadsheetStructureError(
      'XLSX_STRUCTURE_XML_SIZE_INVALID',
      `${label} 항목이 비어 있거나 안전한 검사 한도(32MB)를 넘습니다.`
    );
  }
  let offset = 0;
  let encoding = 'utf-8';
  if (source.length >= 4
    && ((source[0] === 0x00 && source[1] === 0x00 && source[2] === 0xfe && source[3] === 0xff)
      || (source[0] === 0xff && source[1] === 0xfe && source[2] === 0x00 && source[3] === 0x00))) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_XML_ENCODING_UNSUPPORTED', `${label} 항목의 UTF-32 인코딩은 지원하지 않습니다.`);
  }
  if (source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) {
    offset = 3;
  } else if (source.length >= 2 && source[0] === 0xff && source[1] === 0xfe) {
    offset = 2;
    encoding = 'utf-16le';
  } else if (source.length >= 2 && source[0] === 0xfe && source[1] === 0xff) {
    offset = 2;
    encoding = 'utf-16be';
  } else if (source.length >= 4 && source[0] === 0x3c && source[1] === 0x00 && source[2] === 0x3f && source[3] === 0x00) {
    encoding = 'utf-16le';
  } else if (source.length >= 4 && source[0] === 0x00 && source[1] === 0x3c && source[2] === 0x00 && source[3] === 0x3f) {
    encoding = 'utf-16be';
  }
  let encoded = source.subarray(offset);
  if (encoding === 'utf-16be') {
    if (encoded.length % 2) throw spreadsheetStructureError('XLSX_STRUCTURE_XML_ENCODING_INVALID', `${label} 항목의 UTF-16 인코딩이 손상되었습니다.`);
    const swapped = Buffer.allocUnsafe(encoded.length);
    for (let index = 0; index < encoded.length; index += 2) {
      swapped[index] = encoded[index + 1];
      swapped[index + 1] = encoded[index];
    }
    encoded = swapped;
    encoding = 'utf-16le';
  }
  try {
    const xml = new TextDecoder(encoding, { fatal: true }).decode(encoded);
    if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
      throw spreadsheetStructureError('XLSX_STRUCTURE_XML_DOCTYPE', `${label} 항목에 허용되지 않는 문서 선언이 있습니다.`);
    }
    return xml;
  } catch (error) {
    if (error?.code) throw error;
    throw spreadsheetStructureError('XLSX_STRUCTURE_XML_ENCODING_INVALID', `${label} 항목의 문자 인코딩이 손상되었습니다.`, error);
  }
}

async function readArchiveEntryBufferLimited(entry, label) {
  const declaredSize = Number(entry?._data?.uncompressedSize || 0);
  if (declaredSize > MAX_STRUCTURE_XML_BYTES) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_XML_SIZE_INVALID', `${label} 항목이 안전한 검사 한도(32MB)를 넘습니다.`);
  }
  let stream;
  try {
    stream = entry.nodeStream('nodebuffer');
  } catch (error) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_XML_INVALID', `${label} 항목의 압축 데이터를 안전하게 읽지 못했습니다.`, error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let actualBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { stream.destroy?.(); } catch (_) {}
      reject(error?.code ? error : spreadsheetStructureError(
        'XLSX_STRUCTURE_XML_INVALID',
        `${label} 항목의 압축 데이터를 안전하게 읽지 못했습니다.`,
        error
      ));
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      actualBytes += bytes.length;
      if (actualBytes > MAX_STRUCTURE_XML_BYTES) {
        fail(spreadsheetStructureError('XLSX_STRUCTURE_XML_SIZE_INVALID', `${label} 항목이 안전한 검사 한도(32MB)를 넘습니다.`));
        return;
      }
      chunks.push(bytes);
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, actualBytes));
    });
  });
}

async function readXmlPart(archive, partName, label, options = {}) {
  const entry = archive.file(partName);
  if (!entry || entry.dir) {
    if (options.required !== true) return null;
    throw spreadsheetStructureError('XLSX_STRUCTURE_PART_MISSING', `${label} 항목을 찾을 수 없습니다. Excel에서 파일을 다시 저장한 뒤 시도해주세요.`);
  }
  return decodeXmlPart(await readArchiveEntryBufferLimited(entry, label), label);
}

function xmlAttributeValue(tag, localName, namespaceUris = null) {
  const candidates = Object.values(tag?.attributes || {}).filter((attribute) => attribute?.local === localName);
  const preferred = namespaceUris instanceof Set
    ? candidates.find((attribute) => namespaceUris.has(String(attribute?.uri || '')))
    : candidates.find((attribute) => !attribute?.uri) || candidates[0];
  return String(preferred?.value ?? '');
}

function parseXmlPart(xml, label, onOpenTag) {
  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on('doctype', () => {
    throw spreadsheetStructureError('XLSX_STRUCTURE_XML_DOCTYPE', `${label} 항목에 허용되지 않는 문서 선언이 있습니다.`);
  });
  parser.on('opentag', onOpenTag);
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error?.code) throw error;
    throw spreadsheetStructureError('XLSX_STRUCTURE_XML_INVALID', `${label} 항목의 XML 구조가 올바르지 않습니다.`, error);
  }
}

function relationshipKind(type) {
  const normalized = String(type || '').trim().toLocaleLowerCase('en-US');
  if (normalized.endsWith('/worksheet')) return 'worksheet';
  if (normalized.endsWith('/chartsheet')) return 'chart';
  if (normalized.endsWith('/dialogsheet')) return 'dialog';
  if (normalized.endsWith('/macrosheet')) return 'excel4Macro';
  if (normalized.endsWith('/intlmacrosheet')) return 'excel4IntlMacro';
  return normalized.endsWith('/externallink') ? 'externalLink' : 'other';
}

function resolveRelationshipTarget(sourcePart, target, archive) {
  const raw = String(target || '').trim().replace(/\\/g, '/').split(/[?#]/, 1)[0];
  if (!raw) return '';
  const joined = raw.startsWith('/')
    ? raw.replace(/^\/+/, '')
    : path.posix.join(path.posix.dirname(sourcePart), raw);
  const normalized = path.posix.normalize(joined).replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return '';
  if (/%(?:2f|5c)/i.test(normalized)) return '';
  if (archive?.file(normalized)) return normalized;
  // OPC targets are URI references, but some producers keep the percent
  // escapes in the ZIP entry name while others store decoded Unicode names.
  // Prefer the exact normalized URI, and only then try a segment-safe decode.
  try {
    const decoded = normalized.split('/').map((segment) => decodeURIComponent(segment)).join('/');
    const safeDecoded = path.posix.normalize(decoded).replace(/^\.\//, '');
    if (!safeDecoded || safeDecoded === '..' || safeDecoded.startsWith('../') || path.posix.isAbsolute(safeDecoded)) return normalized;
    return archive?.file(safeDecoded) ? safeDecoded : normalized;
  } catch (_) {
    return normalized;
  }
}

function truthyOoxmlBoolean(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value || '').trim().toLocaleLowerCase('en-US'));
}

async function inspectXlsxWorkbookStructure(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));
  let stats;
  let source;
  try {
    stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile() || stats.size <= 0) throw new Error('not-file');
    if (stats.size > MAX_STRUCTURE_WORKBOOK_BYTES) {
      throw spreadsheetStructureError('XLSX_STRUCTURE_FILE_TOO_LARGE', 'Excel 파일은 안전한 구조 검사를 위해 128MB 이하여야 합니다.');
    }
    source = await fs.promises.readFile(resolvedPath);
  } catch (error) {
    if (error?.code?.startsWith?.('XLSX_')) throw error;
    throw spreadsheetStructureError('XLSX_STRUCTURE_FILE_UNREADABLE', 'Excel 파일을 읽을 수 없습니다. 파일이 이동되었거나 다른 프로그램에서 잠기지 않았는지 확인해주세요.', error);
  }
  if (source.length !== stats.size) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_INPUT_CHANGED', 'Excel 파일이 확인 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.');
  }

  let archive;
  try {
    archive = await inspectWorkbookArchive(source, {
      maxEntries: MAX_STRUCTURE_ARCHIVE_ENTRIES,
      maxUncompressedBytes: MAX_STRUCTURE_UNCOMPRESSED_BYTES
    });
  } catch (error) {
    if (error?.code) throw error;
    throw spreadsheetStructureError('XLSX_STRUCTURE_ARCHIVE_INVALID', 'Excel 파일 구조를 읽지 못했습니다. 파일이 손상되었거나 올바른 XLSX가 아닐 수 있습니다.', error);
  }

  const entryNames = Object.keys(archive.files);
  if (entryNames.some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name))) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_MACRO_REJECTED', '매크로가 포함된 Excel 파일은 안전한 병합 대상에서 제외됩니다.');
  }
  if (entryNames.some((name) => /^_xmlsignatures\//i.test(name))) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_SIGNATURE_REJECTED', '디지털 서명이 있는 Excel 파일은 병합 시 서명이 무효화될 수 있어 대상에서 제외됩니다.');
  }
  const contentTypesEntry = archive.file('[Content_Types].xml');
  if (contentTypesEntry) {
    const contentTypes = await readXmlPart(archive, '[Content_Types].xml', 'Excel 콘텐츠 형식');
    if (/(?:vbaProject|macroEnabled)/i.test(contentTypes)) {
      throw spreadsheetStructureError('XLSX_STRUCTURE_MACRO_REJECTED', '매크로가 포함된 Excel 파일은 안전한 병합 대상에서 제외됩니다.');
    }
  }

  const workbookXml = await readXmlPart(archive, 'xl/workbook.xml', 'Excel 통합문서', { required: true });
  const relationshipsXml = await readXmlPart(archive, 'xl/_rels/workbook.xml.rels', 'Excel 통합문서 관계', { required: true });
  const sheetDeclarations = [];
  let workbookRootValid = false;
  let workbookStructureProtected = false;
  parseXmlPart(workbookXml, 'Excel 통합문서', (tag) => {
    const local = String(tag?.local || '');
    const namespace = String(tag?.uri || '');
    if (!workbookRootValid && local === 'workbook' && SPREADSHEETML_NAMESPACES.has(namespace)) workbookRootValid = true;
    if (!SPREADSHEETML_NAMESPACES.has(namespace)) return;
    if (local === 'workbookProtection' && truthyOoxmlBoolean(xmlAttributeValue(tag, 'lockStructure'))) {
      workbookStructureProtected = true;
    }
    if (local !== 'sheet') return;
    if (sheetDeclarations.length >= MAX_STRUCTURE_SHEETS) {
      throw spreadsheetStructureError('XLSX_STRUCTURE_SHEET_LIMIT', 'Excel 시트가 10,000개를 넘어 구조를 안전하게 확인할 수 없습니다.');
    }
    sheetDeclarations.push({
      name: xmlAttributeValue(tag, 'name'),
      relationshipId: xmlAttributeValue(tag, 'id', DOCUMENT_RELATIONSHIPS_NAMESPACES),
      visibility: xmlAttributeValue(tag, 'state') || 'visible'
    });
  });
  if (!workbookRootValid) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_WORKBOOK_INVALID', 'Excel 통합문서의 기본 구조가 올바르지 않습니다.');
  }
  if (workbookStructureProtected) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_PROTECTED_REJECTED', '통합문서 구조가 보호된 Excel 파일은 시트를 안전하게 합칠 수 없습니다. 보호를 해제한 복사본을 선택해주세요.');
  }
  if (!sheetDeclarations.length) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_EMPTY', 'Excel 파일에 합칠 시트가 없습니다.');
  }

  const relationships = new Map();
  let relationshipsRootValid = false;
  let externalLinkCount = 0;
  parseXmlPart(relationshipsXml, 'Excel 통합문서 관계', (tag) => {
    const local = String(tag?.local || '');
    const namespace = String(tag?.uri || '');
    if (!relationshipsRootValid && local === 'Relationships' && namespace === PACKAGE_RELATIONSHIPS_NAMESPACE) relationshipsRootValid = true;
    if (local !== 'Relationship' || namespace !== PACKAGE_RELATIONSHIPS_NAMESPACE) return;
    const id = xmlAttributeValue(tag, 'Id');
    const type = xmlAttributeValue(tag, 'Type');
    const target = xmlAttributeValue(tag, 'Target');
    const targetMode = xmlAttributeValue(tag, 'TargetMode');
    const kind = relationshipKind(type);
    if (kind === 'externalLink') externalLinkCount += 1;
    if (id) relationships.set(id, { type, kind, target, external: targetMode.toLocaleLowerCase('en-US') === 'external' });
  });
  if (!relationshipsRootValid) {
    throw spreadsheetStructureError('XLSX_STRUCTURE_RELATIONSHIPS_INVALID', 'Excel 시트 연결 정보가 올바르지 않습니다.');
  }

  const sheets = sheetDeclarations.map((sheet, index) => {
    const relationship = relationships.get(sheet.relationshipId);
    if (!sheet.name || !sheet.relationshipId || !relationship || relationship.external) {
      throw spreadsheetStructureError('XLSX_STRUCTURE_SHEET_RELATIONSHIP_INVALID', `“${sheet.name || `${index + 1}번째 시트`}”의 연결 정보를 읽지 못했습니다. Excel에서 파일을 다시 저장한 뒤 시도해주세요.`);
    }
    if (relationship.kind === 'excel4Macro' || relationship.kind === 'excel4IntlMacro') {
      throw spreadsheetStructureError('XLSX_STRUCTURE_MACRO_REJECTED', 'Excel 4.0 매크로 시트가 포함된 파일은 안전한 병합 대상에서 제외됩니다.');
    }
    const targetPart = resolveRelationshipTarget('xl/workbook.xml', relationship.target, archive);
    if (!targetPart || !archive.file(targetPart)) {
      throw spreadsheetStructureError('XLSX_STRUCTURE_SHEET_PART_MISSING', `“${sheet.name}” 시트의 실제 내용을 찾지 못했습니다. Excel에서 파일을 다시 저장한 뒤 시도해주세요.`);
    }
    const visibility = ['visible', 'hidden', 'veryHidden'].includes(sheet.visibility) ? sheet.visibility : 'unknown';
    return {
      index,
      name: sheet.name.slice(0, 31),
      type: relationship.kind,
      visibility
    };
  });

  const connectionsEntry = archive.file('xl/connections.xml');
  if (connectionsEntry) {
    const connectionsXml = await readXmlPart(archive, 'xl/connections.xml', 'Excel 데이터 연결');
    parseXmlPart(connectionsXml, 'Excel 데이터 연결', (tag) => {
      if (String(tag?.local || '') === 'connection' && SPREADSHEETML_NAMESPACES.has(String(tag?.uri || ''))) externalLinkCount += 1;
    });
  }

  return {
    sheetCount: sheets.length,
    sheets,
    sheetNames: sheets.map((sheet) => sheet.name),
    externalLinksPresent: externalLinkCount > 0,
    externalLinkCount,
    requiresPreview: true,
    structureInspectionEngine: 'ooxml',
    sourceBytes: source.length,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex')
  };
}

function cellValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);
  if (value.text != null) return String(value.text);
  if (value.result != null) return String(value.result);
  if (value.hyperlink) return String(value.text || value.hyperlink);
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
  return String(value);
}

async function readWorkbookSheets(filePath) {
  const { workbook } = await loadXlsxWorkbookSafely(filePath);
  return workbook.worksheets.map((sheet) => {
    const rowCount = sheet.actualRowCount || sheet.rowCount;
    const columnCount = sheet.actualColumnCount || sheet.columnCount;
    const matrix = [];
    for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
      const row = [];
      for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) row.push(cellValue(sheet.getCell(rowNumber, columnNumber).value));
      while (row.length && !String(row.at(-1) || '').trim()) row.pop();
      if (row.some((value) => String(value || '').trim())) matrix.push(row);
    }
    return { name: sheet.name, matrix };
  });
}

async function readFirstWorksheet(filePath) {
  const sheets = await readWorkbookSheets(filePath); const first = sheets[0] || { name: '', matrix: [] };
  return { sheetName: first.name, matrix: first.matrix };
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245E89' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 23;
}

async function exportProjectWorkbook(filePath, project) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CMOE Workspace';
  workbook.created = new Date();

  const output = Ops.scheduleOutputTable(project);
  const schedule = workbook.addWorksheet(output.sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  schedule.columns = output.headers.map((header, index) => ({ header, key: `column-${index}`, width: Math.max(12, Math.min(header.includes('링크') ? 48 : 36, String(header || '').length + (header.includes('링크') ? 34 : 8))) }));
  output.rows.forEach((values) => schedule.addRow(Object.fromEntries(values.map((value, index) => [`column-${index}`, value]))));
  if (schedule.columnCount) schedule.autoFilter = `A1:${schedule.getColumn(schedule.columnCount).letter}1`;
  styleHeader(schedule.getRow(1));
  schedule.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      row.alignment = { vertical: 'middle', wrapText: true };
      row.eachCell((cell) => { cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE3' } } }; });
    }
  });

  const roster = workbook.addWorksheet('명단', { views: [{ state: 'frozen', ySplit: 1 }] });
  const columns = project.data.columns.length ? project.data.columns : [{ id: 'name', name: '이름' }, { id: 'email', name: '이메일' }, { id: 'phone', name: '전화번호' }];
  roster.columns = columns.map((column) => ({ header: column.name, key: column.id, width: Math.max(14, Math.min(32, column.name.length + 8)) }));
  styleHeader(roster.getRow(1));
  project.data.people.forEach((person) => roster.addRow({ ...person.values }));
  roster.autoFilter = `A1:${roster.getColumn(roster.columnCount).letter}1`;

  const conflicts = workbook.addWorksheet('확인 필요');
  conflicts.columns = [{ header: '종류', key: 'type', width: 18 }, { header: '내용', key: 'message', width: 80 }];
  styleHeader(conflicts.getRow(1));
  Ops.collectScheduleConflicts(project).forEach((conflict) => conflicts.addRow({ type: conflict.type, message: conflict.message }));

  await workbook.xlsx.writeFile(filePath);
}

async function exportWorkItemWorkbook(filePath, item) {
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'CMOE Workspace'; workbook.created = new Date();
  const sheet = workbook.addWorksheet(String(item.name || '명단 작업').slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = item.columns.map((column) => ({ header: column.name, key: column.id, width: Math.max(14, Math.min(36, String(column.name || '').length + 8)) })); styleHeader(sheet.getRow(1));
  item.rows.forEach((row) => sheet.addRow(Object.fromEntries(item.columns.map((column) => [column.id, row.values?.[column.id] || '']))));
  if (sheet.columnCount) sheet.autoFilter = `A1:${sheet.getColumn(sheet.columnCount).letter}1`;
  sheet.eachRow((row, rowNumber) => { if (rowNumber > 1) { row.alignment = { vertical: 'middle', wrapText: true }; row.eachCell((cell) => { cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE3' } } }; }); } });
  await workbook.xlsx.writeFile(filePath);
}

module.exports = {
  inspectWorkbookArchive,
  inspectXlsxWorkbookStructure,
  loadXlsxWorkbookSafely,
  readWorkbookSheets,
  readFirstWorksheet,
  exportProjectWorkbook,
  exportWorkItemWorkbook
};
