'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const packagedExcelJs = process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'node_modules', 'exceljs') : '';
const vendorModulesPath = packagedExcelJs && fs.existsSync(packagedExcelJs)
  ? path.dirname(packagedExcelJs)
  : path.join(__dirname, '..', 'vendor', 'node_modules');
const JSZip = require(path.join(vendorModulesPath, 'jszip'));
const { SaxesParser } = require(path.join(vendorModulesPath, 'saxes'));

const MAX_PPTX_BYTES = 128 * 1024 * 1024;
const MAX_PPTX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_PPTX_ARCHIVE_ENTRIES = 20_000;
const MAX_PPTX_SLIDES = 500;
const MAX_PPTX_TEXT_BLOCKS = 5_000;
const MAX_REPLACEMENT_TEXT_LENGTH = 4_000;
const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const FORBIDDEN_PACKAGE_PART = /(?:^|\/)(?:vbaProject\.bin|activeX(?:\/|$)|embeddings(?:\/|$)|oleObject(?:\/|$)|customUI(?:\/|$))/i;
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main'
]);
const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships'
]);
const KOREAN_TEXT_PATTERN = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/i;
const KOREAN_FALLBACK_TYPEFACE = '맑은 고딕';
const RELATIONSHIPS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const DANGEROUS_CONTENT_TYPE = /(?:vbaProject|activeX|oleObject|macroEnabled)/i;
const DANGEROUS_RELATIONSHIP_TYPE = /\/(?:oleObject|activeX|vbaProject|package)\/?$/i;
const XML_PREFIX_PATTERN = '(?:[^\\s<>/=:]+:)?';
const XML_PREFIX_CAPTURE_PATTERN = '([^\\s<>/=:]+:)?';
const MODERN_COMMENT_EXTENSION_URI = '{6950BFC3-D8DA-4A85-94F7-54DA5524770B}';

function qualifiedOpenTagPattern(localName, flags = 'i') {
  return new RegExp(`<${XML_PREFIX_PATTERN}${localName}\\b[^>]*>`, flags);
}

function qualifiedElementPattern(localName, flags = 'i') {
  return new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}${localName}\\b[^>]*(?:\\/\\s*>|>[\\s\\S]*?<\\/\\1${localName}\\s*>)`, flags);
}

function relationshipIdAttribute(attributes) {
  const match = Object.entries(attributes || {}).find(([name]) => name.includes(':') && name.split(':').pop().toLowerCase() === 'id');
  return String(match?.[1] || '');
}

function visitXml(xml, handlers = {}) {
  const parser = new SaxesParser({ xmlns: true, position: true });
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler.bind(null, parser));
  parser.write(xml).close();
}

function visitXmlFragment(xml, handlers = {}) {
  const parser = new SaxesParser({ xmlns: false, position: true });
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler.bind(null, parser));
  parser.write(xml).close();
}

function fragmentTagLocalName(tag) {
  return String(tag?.name || tag?.local || '').split(':').pop();
}

function fragmentAttributeValue(tag, localName) {
  const entry = Object.entries(tag?.attributes || {}).find(([name, attribute]) => String(attribute?.local || name).split(':').pop() === localName);
  return String(entry ? (entry[1]?.value ?? entry[1]) : '');
}

function attributeValue(tag, localName) {
  const attribute = Object.values(tag?.attributes || {}).find((item) => item?.local === localName && !item.uri);
  return String(attribute?.value || '');
}

function validateXml(source, label = 'XML') {
  const xml = String(source || '');
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_PART_BYTES) throw new Error(`${label} 항목이 16MB를 넘습니다.`);
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) throw new Error(`${label} 항목에 허용되지 않는 문서 선언이 있습니다.`);
  try { new SaxesParser({ xmlns: true }).write(xml).close(); }
  catch (_) { throw new Error(`${label} 항목의 XML 형식이 올바르지 않습니다.`); }
  return xml;
}

function decodeXmlBytes(source, label = 'XML') {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source || []);
  let offset = 0;
  let encoding = 'utf-8';
  if (bytes.length >= 4
    && ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00))) {
    throw new Error(`${label} 항목의 UTF-32 문자 인코딩은 지원하지 않습니다.`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    offset = 2;
    encoding = 'utf-16le';
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    offset = 2;
    encoding = 'utf-16be';
  } else if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00) {
    encoding = 'utf-16le';
  } else if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] === 0x3f) {
    encoding = 'utf-16be';
  }

  let encoded = bytes.subarray(offset);
  if (encoding === 'utf-16be') {
    if (encoded.length % 2) throw new Error(`${label} 항목의 UTF-16 문자 인코딩이 손상되었습니다.`);
    const swapped = Buffer.allocUnsafe(encoded.length);
    for (let index = 0; index < encoded.length; index += 2) {
      swapped[index] = encoded[index + 1];
      swapped[index + 1] = encoded[index];
    }
    encoded = swapped;
    encoding = 'utf-16le';
  }

  try {
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(encoded);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  } catch (_) {
    throw new Error(`${label} 항목의 문자 인코딩이 손상되었거나 지원되지 않습니다.`);
  }
}

async function readXmlEntry(entry, label = 'XML') {
  if (!entry) throw new Error(`${label} 항목을 찾을 수 없습니다.`);
  return validateXml(decodeXmlBytes(await entry.async('uint8array'), label), label);
}

function serializeXmlUtf8(source) {
  const xml = String(source || '').replace(/^\ufeff/, '');
  return xml.replace(/^(\s*<\?xml\b[^?]*?\bencoding\s*=\s*)(["'])[^"']*\2/i, (_match, prefix, quote) => `${prefix}${quote}UTF-8${quote}`);
}

function validateReplacementText(value) {
  const text = String(value ?? '');
  if (text.length > MAX_REPLACEMENT_TEXT_LENGTH) throw new Error('한 셀의 글자는 4,000자 이하만 사용할 수 있습니다.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('셀 값에 문서에서 사용할 수 없는 제어 문자가 있습니다.');
  return text;
}

function decodeXmlText(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapeXmlText(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '&#10;');
}

function xmlAttributes(tag = '') {
  const attributes = {};
  const pattern = /([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(String(tag)))) attributes[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '');
  return attributes;
}

function archiveEntrySize(entry) {
  const size = Number(entry?._data?.uncompressedSize ?? entry?._data?.length ?? 0);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('PPTX 압축 정보가 올바르지 않습니다.');
  return size;
}

function canonicalPartName(value) {
  let partName = String(value || '').trim().replace(/\\/g, '/');
  try { partName = decodeURIComponent(partName); } catch (_) {}
  return `/${partName.replace(/^\/+/, '')}`;
}

function isXmlContentType(value) {
  const contentType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return contentType === 'application/xml' || contentType === 'text/xml' || contentType.endsWith('+xml');
}

function parseContentTypes(contentTypesXml) {
  const defaults = new Map();
  const overrides = new Map();
  visitXml(contentTypesXml, {
    opentag: (_parser, tag) => {
      if (tag.uri !== CONTENT_TYPES_NAMESPACE || !['Default', 'Override'].includes(tag.local)) return;
      const contentType = attributeValue(tag, 'ContentType').trim();
      if (!contentType) return;
      if (tag.local === 'Default') {
        const extension = attributeValue(tag, 'Extension').trim().replace(/^\./, '').toLowerCase();
        if (extension) defaults.set(extension, contentType);
      } else {
        const partName = attributeValue(tag, 'PartName');
        if (partName) overrides.set(canonicalPartName(partName), contentType);
      }
    }
  });
  return { defaults, overrides };
}

function contentTypeForEntry(contentTypes, entryName) {
  const canonicalName = canonicalPartName(entryName);
  const extension = path.posix.extname(canonicalName).slice(1).toLowerCase();
  return contentTypes.overrides.get(canonicalName) || contentTypes.defaults.get(extension) || '';
}

function validateRelationships(relationshipsXml) {
  visitXml(relationshipsXml, {
    opentag: (_parser, tag) => {
      if (tag.uri !== RELATIONSHIPS_NAMESPACE || tag.local !== 'Relationship') return;
      const type = attributeValue(tag, 'Type').trim();
      const targetMode = attributeValue(tag, 'TargetMode').trim().toLowerCase();
      if (DANGEROUS_RELATIONSHIP_TYPE.test(type)) {
        throw new Error('매크로·ActiveX·OLE가 포함된 PPTX는 안전을 위해 사용할 수 없습니다.');
      }
      if (targetMode === 'external' && !/\/hyperlink\/?$/i.test(type)) {
        throw new Error('외부 파일이나 외부 이미지에 연결된 PPTX는 안전을 위해 사용할 수 없습니다.');
      }
    }
  });
}

async function loadArchiveBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (!buffer.length) throw new Error('비어 있는 PPTX 파일입니다.');
  if (buffer.length > MAX_PPTX_BYTES) throw new Error('PPTX 파일은 128MB 이하만 사용할 수 있습니다.');
  const archive = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const entries = Object.values(archive.files);
  if (entries.length > MAX_PPTX_ARCHIVE_ENTRIES) throw new Error('PPTX 파일에 포함된 항목이 너무 많습니다.');
  let uncompressedBytes = 0;
  for (const entry of entries) {
    const entryName = String(entry.name || '').replace(/\\/g, '/');
    const originalEntryName = String(entry.unsafeOriginalName || entry.name || '').replace(/\\/g, '/');
    const unsafePath = (value) => !value
      || value.includes('\u0000')
      || value.startsWith('/')
      || /^[A-Za-z]:/.test(value)
      || value.split('/').includes('..')
      || path.posix.normalize(value).startsWith('../');
    if (unsafePath(entryName) || unsafePath(originalEntryName)) {
      throw new Error('PPTX 내부에 안전하지 않은 파일 경로가 있습니다.');
    }
    if (entry.dir) continue;
    if (FORBIDDEN_PACKAGE_PART.test(entryName)) throw new Error('매크로·ActiveX·OLE가 포함된 PPTX는 안전을 위해 사용할 수 없습니다.');
    uncompressedBytes += archiveEntrySize(entry);
    if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_PPTX_UNCOMPRESSED_BYTES) {
      throw new Error('압축을 푼 PPTX 파일이 512MB를 넘습니다.');
    }
  }
  if (!archive.file('[Content_Types].xml') || !archive.file('ppt/presentation.xml')) throw new Error('올바른 PowerPoint PPTX 파일이 아닙니다.');
  const contentTypesXml = await readXmlEntry(archive.file('[Content_Types].xml'), '[Content_Types].xml');
  const contentTypes = parseContentTypes(contentTypesXml);
  const xmlParts = new Map([['[Content_Types].xml', contentTypesXml]]);
  const relationshipPartNames = new Set();
  for (const entry of entries.filter((item) => !item.dir && item.name !== '[Content_Types].xml')) {
    const entryName = String(entry.name || '');
    const contentType = contentTypeForEntry(contentTypes, entryName);
    if (DANGEROUS_CONTENT_TYPE.test(contentType)) throw new Error('매크로·ActiveX·OLE가 포함된 PPTX는 안전을 위해 사용할 수 없습니다.');
    const xmlByName = /(?:\.xml|\.rels)$/i.test(entryName);
    if (xmlByName || isXmlContentType(contentType)) {
      xmlParts.set(entryName, await readXmlEntry(entry, entryName));
    }
    const normalizedContentType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (entryName.toLowerCase().endsWith('.rels') || normalizedContentType === RELATIONSHIPS_CONTENT_TYPE) relationshipPartNames.add(entryName);
  }
  for (const entryName of relationshipPartNames) validateRelationships(xmlParts.get(entryName));
  return archive;
}

async function readPptxFile(filePath) {
  const sourcePath = path.resolve(String(filePath || ''));
  if (path.extname(sourcePath).toLowerCase() !== '.pptx') throw new Error('템플릿 문서 양식은 PPTX 파일만 사용할 수 있습니다.');
  const stats = await fs.promises.stat(sourcePath);
  if (!stats.isFile()) throw new Error('PPTX 파일을 찾을 수 없습니다.');
  if (stats.size > MAX_PPTX_BYTES) throw new Error('PPTX 파일은 128MB 이하만 사용할 수 있습니다.');
  const buffer = await fs.promises.readFile(sourcePath);
  if (buffer.length > MAX_PPTX_BYTES) throw new Error('PPTX 파일은 128MB 이하만 사용할 수 있습니다.');
  return { sourcePath, buffer };
}

function resolvePartTarget(basePart, target) {
  const cleanTarget = decodeURIComponent(String(target || '').replace(/\\/g, '/'));
  if (!cleanTarget || cleanTarget.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleanTarget)) throw new Error('PPTX 내부 슬라이드 경로가 올바르지 않습니다.');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(basePart), cleanTarget));
  if (resolved === '..' || resolved.startsWith('../') || !resolved.startsWith('ppt/')) throw new Error('PPTX 내부 슬라이드 경로가 안전하지 않습니다.');
  return resolved;
}

function slideReferences(presentationXml, relationshipsXml) {
  const relationshipTargets = new Map();
  const relationshipPattern = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/gi;
  let relationshipMatch;
  while ((relationshipMatch = relationshipPattern.exec(relationshipsXml))) {
    const attrs = xmlAttributes(relationshipMatch[0]);
    if (!attrs.Id || !attrs.Target || !String(attrs.Type || '').endsWith('/slide')) continue;
    relationshipTargets.set(attrs.Id, resolvePartTarget('ppt/presentation.xml', attrs.Target));
  }

  const references = [];
  const slidePattern = qualifiedElementPattern('sldId', 'gi');
  let slideMatch;
  while ((slideMatch = slidePattern.exec(presentationXml))) {
    const attrs = xmlAttributes(slideMatch[0]);
    const relationshipId = relationshipIdAttribute(attrs);
    const partPath = relationshipTargets.get(relationshipId);
    if (relationshipId && partPath) references.push({ relationshipId, partPath, presentationId: attrs.id || '', tag: slideMatch[0] });
  }
  if (!references.length) throw new Error('PPTX에서 슬라이드를 찾을 수 없습니다.');
  if (references.length > MAX_PPTX_SLIDES) throw new Error('템플릿 문서 양식은 슬라이드 500개 이하만 사용할 수 있습니다.');
  return references;
}

function slideSize(presentationXml) {
  const match = presentationXml.match(qualifiedOpenTagPattern('sldSz'));
  const attrs = xmlAttributes(match?.[0] || '');
  const width = Number(attrs.cx || 0);
  const height = Number(attrs.cy || 0);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return { width: 13_333_500, height: 7_500_000 };
  return { width, height };
}

function shapeText(shapeXml) {
  const body = shapeXml.match(qualifiedElementPattern('txBody'))?.[0] || '';
  if (!body) return { hasTextBody: false, hasTextNodes: false, text: '' };
  const paragraphs = [];
  const paragraphPattern = qualifiedElementPattern('p', 'gi');
  let paragraphMatch;
  while ((paragraphMatch = paragraphPattern.exec(body))) {
    const fragments = [...paragraphMatch[0].matchAll(new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}t\\b[^>]*>([\\s\\S]*?)<\\/\\1t\\s*>`, 'gi'))]
      .map((match) => decodeXmlText(match[2]));
    if (fragments.length) paragraphs.push(fragments.join(''));
  }
  const allFragments = [...body.matchAll(new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}t\\b[^>]*>([\\s\\S]*?)<\\/\\1t\\s*>`, 'gi'))]
    .map((match) => decodeXmlText(match[2]));
  return { hasTextBody: true, hasTextNodes: allFragments.length > 0, text: paragraphs.length ? paragraphs.join('\n') : allFragments.join('') };
}

function normalizeTypeface(value) {
  const normalized = String(value || '').normalize('NFKC').trim().replace(/^@+/, '').replace(/\s+/g, ' ');
  if (!normalized || normalized.startsWith('+')) return '';
  return normalized;
}

function typefaceKey(value) {
  return normalizeTypeface(value).toLowerCase();
}

function addTypeface(target, value) {
  const normalized = normalizeTypeface(value);
  if (!normalized) return;
  const key = typefaceKey(normalized);
  if (!target.has(key)) target.set(key, normalized);
}

function typefaceReferences(xml) {
  const references = [];
  visitXml(String(xml || ''), {
    opentag: (_parser, tag) => {
      const value = attributeValue(tag, 'typeface');
      if (value) references.push(String(value).normalize('NFKC').trim().replace(/^@+/, '').replace(/\s+/g, ' '));
    }
  });
  return references.filter(Boolean);
}

function withoutEmbeddedFontList(presentationXml) {
  return String(presentationXml || '').replace(qualifiedElementPattern('embeddedFontLst', 'gi'), '');
}

function embeddedFontFamilies(presentationXml) {
  const families = new Map();
  let embeddedFontDepth = 0;
  visitXml(String(presentationXml || ''), {
    opentag: (_parser, tag) => {
      if (PRESENTATION_NAMESPACES.has(tag.uri) && tag.local === 'embeddedFont') embeddedFontDepth += 1;
      else if (embeddedFontDepth > 0 && PRESENTATION_NAMESPACES.has(tag.uri) && tag.local === 'font') addTypeface(families, attributeValue(tag, 'typeface'));
    },
    closetag: (_parser, tag) => {
      if (PRESENTATION_NAMESPACES.has(tag.uri) && tag.local === 'embeddedFont') embeddedFontDepth = Math.max(0, embeddedFontDepth - 1);
    }
  });
  return [...families.values()];
}

function themeTypefaceMap(themeXml) {
  const map = new Map();
  const fontScheme = String(themeXml || '').match(qualifiedElementPattern('fontScheme'))?.[0] || '';
  for (const [kind, tokenPrefix] of [['majorFont', '+mj'], ['minorFont', '+mn']]) {
    const group = fontScheme.match(qualifiedElementPattern(kind))?.[0] || '';
    for (const [localName, tokenSuffix] of [['latin', 'lt'], ['ea', 'ea'], ['cs', 'cs']]) {
      const tag = group.match(qualifiedOpenTagPattern(localName))?.[0] || '';
      const typeface = normalizeTypeface(xmlAttributes(tag).typeface);
      if (typeface) map.set(`${tokenPrefix}-${tokenSuffix}`, typeface);
    }
  }
  return map;
}

const IDENTITY_MATRIX = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

function multiplyMatrix(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

function translationMatrix(x, y) { return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }; }
function scaleMatrix(x, y) { return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }; }
function rotationMatrix(degrees) {
  const radians = degrees * Math.PI / 180;
  return { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 };
}

function aroundPoint(matrix, x, y) {
  return multiplyMatrix(translationMatrix(x, y), multiplyMatrix(matrix, translationMatrix(-x, -y)));
}

function transformPoint(matrix, x, y) {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function truthyXmlAttribute(value) { return ['1', 'true', 'on'].includes(String(value || '').trim().toLowerCase()); }

function xfrmFragment(elementXml, kind = 'shape') {
  let container = String(elementXml || '');
  if (kind === 'group') container = container.match(qualifiedElementPattern('grpSpPr'))?.[0] || '';
  else if (kind === 'graphicFrame') container = container.match(qualifiedElementPattern('xfrm'))?.[0] || '';
  else container = container.match(qualifiedElementPattern('spPr'))?.[0] || '';
  if (kind === 'graphicFrame') return container;
  return container.match(qualifiedElementPattern('xfrm'))?.[0] || '';
}

function transformDescriptor(elementXml, kind = 'shape') {
  const fragment = xfrmFragment(elementXml, kind);
  const openTag = fragment.match(qualifiedOpenTagPattern('xfrm'))?.[0] || '';
  const attrs = xmlAttributes(openTag);
  const tagAttributes = (localName) => xmlAttributes(fragment.match(qualifiedOpenTagPattern(localName))?.[0] || '');
  const offset = tagAttributes('off');
  const extent = tagAttributes('ext');
  const childOffset = tagAttributes('chOff');
  const childExtent = tagAttributes('chExt');
  return {
    x: finiteCoordinate(offset.x),
    y: finiteCoordinate(offset.y),
    width: finiteCoordinate(extent.cx),
    height: finiteCoordinate(extent.cy),
    childX: finiteCoordinate(childOffset.x),
    childY: finiteCoordinate(childOffset.y),
    childWidth: finiteCoordinate(childExtent.cx),
    childHeight: finiteCoordinate(childExtent.cy),
    rotation: (finiteCoordinate(attrs.rot) || 0) / 60_000,
    flipH: truthyXmlAttribute(attrs.flipH),
    flipV: truthyXmlAttribute(attrs.flipV)
  };
}

function orientationMatrix(transform) {
  const centerX = transform.x + transform.width / 2;
  const centerY = transform.y + transform.height / 2;
  const flip = scaleMatrix(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
  return aroundPoint(multiplyMatrix(rotationMatrix(transform.rotation), flip), centerX, centerY);
}

function groupCoordinateMatrix(groupXml) {
  const transform = transformDescriptor(groupXml, 'group');
  if (![transform.x, transform.y, transform.width, transform.height, transform.childX, transform.childY, transform.childWidth, transform.childHeight].every(Number.isFinite)
    || transform.childWidth <= 0 || transform.childHeight <= 0) return { ...IDENTITY_MATRIX };
  const scaleX = transform.width / transform.childWidth;
  const scaleY = transform.height / transform.childHeight;
  const base = multiplyMatrix(translationMatrix(transform.x - transform.childX * scaleX, transform.y - transform.childY * scaleY), scaleMatrix(scaleX, scaleY));
  return multiplyMatrix(orientationMatrix(transform), base);
}

function boundingGeometry(transform, parentMatrix = IDENTITY_MATRIX) {
  if (![transform.x, transform.y, transform.width, transform.height].every(Number.isFinite) || transform.width < 0 || transform.height < 0) return null;
  const ownOrientation = orientationMatrix(transform);
  const matrix = multiplyMatrix(parentMatrix, ownOrientation);
  const corners = [
    transformPoint(matrix, transform.x, transform.y),
    transformPoint(matrix, transform.x + transform.width, transform.y),
    transformPoint(matrix, transform.x + transform.width, transform.y + transform.height),
    transformPoint(matrix, transform.x, transform.y + transform.height)
  ];
  return geometryFromCorners(corners);
}

function geometryFromCorners(corners) {
  const xs = corners.map((point) => point.x); const ys = corners.map((point) => point.y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, corners };
}

function shapeGeometry(shapeXml, parentMatrix = IDENTITY_MATRIX, kind = 'shape') {
  return boundingGeometry(transformDescriptor(shapeXml, kind), parentMatrix);
}

function drawingElementRanges(slideXml, elementKinds) {
  const kinds = elementKinds instanceof Set ? elementKinds : new Set(elementKinds || []);
  const ranges = [];
  const elementStack = [];
  const groupStack = [];
  let pendingStart = -1;
  visitXml(slideXml, {
    opentagstart: (parser) => {
      pendingStart = slideXml.lastIndexOf('<', Math.max(0, parser.position - 1));
    },
    opentag: (_parser, tag) => {
      const start = pendingStart;
      pendingStart = -1;
      if (!PRESENTATION_NAMESPACES.has(tag.uri)) return;
      if (tag.local === 'grpSp') {
        const group = { start, end: -1 };
        groupStack.push(group);
      }
      if (kinds.has(tag.local)) {
        elementStack.push({ kind: tag.local, start, groups: groupStack.slice() });
      }
    },
    closetag: (parser, tag) => {
      if (!PRESENTATION_NAMESPACES.has(tag.uri)) return;
      if (kinds.has(tag.local)) {
        const element = elementStack.pop();
        if (element && element.kind === tag.local && element.start >= 0 && parser.position > element.start) ranges.push({ ...element, end: parser.position });
      }
      if (tag.local === 'grpSp') {
        const group = groupStack.pop();
        if (group) group.end = parser.position;
      }
    }
  });
  return ranges.sort((left, right) => left.start - right.start);
}

function selectableElementRanges(slideXml) {
  return drawingElementRanges(slideXml, new Set(['sp', 'cxnSp', 'graphicFrame']));
}

function visualElementRanges(slideXml) {
  return drawingElementRanges(slideXml, new Set(['sp', 'pic']));
}

function selectableShapeRanges(slideXml) {
  return selectableElementRanges(slideXml).filter((range) => ['sp', 'cxnSp'].includes(range.kind));
}

function groupParentMatrix(partXml, groups) {
  return groups.reduce((matrix, group) => {
    if (!group || group.start < 0 || group.end <= group.start) return matrix;
    return multiplyMatrix(matrix, groupCoordinateMatrix(partXml.slice(group.start, group.end)));
  }, { ...IDENTITY_MATRIX });
}

function alphaOperationPreservesOpacity(tag) {
  const localName = fragmentTagLocalName(tag);
  const numericAttribute = (...names) => {
    for (const name of names) {
      const rawValue = fragmentAttributeValue(tag, name).trim();
      if (!rawValue) continue;
      const value = finiteCoordinate(rawValue);
      if (value !== null) return value;
    }
    return null;
  };
  if (['alpha', 'alphaMod', 'alphaModFix'].includes(localName)) return numericAttribute('val', 'amt') === 100_000;
  if (localName === 'alphaOff') return numericAttribute('val', 'amt') === 0;
  if (localName === 'alphaRepl') return numericAttribute('a', 'val', 'amt') === 100_000;
  return false;
}

function opaqueSolidRectFill(elementXml) {
  const geometryTag = String(elementXml || '').match(qualifiedOpenTagPattern('prstGeom'))?.[0] || '';
  if (String(xmlAttributes(geometryTag).prst || '').toLowerCase() !== 'rect') return false;
  let depth = 0;
  let shapePropertiesDepth = -1;
  let solidFillDepth = -1;
  let colorSeen = false;
  let transparentOrUncertain = false;
  let opaqueFillFound = false;
  visitXmlFragment(elementXml, {
    opentag: (_parser, tag) => {
      depth += 1;
      const localName = fragmentTagLocalName(tag);
      if (localName === 'spPr' && shapePropertiesDepth < 0) {
        shapePropertiesDepth = depth;
        return;
      }
      if (shapePropertiesDepth > 0 && depth === shapePropertiesDepth + 1 && localName === 'solidFill') {
        solidFillDepth = depth;
        colorSeen = false;
        transparentOrUncertain = false;
        return;
      }
      if (solidFillDepth > 0 && depth > solidFillDepth) {
        if (['srgbClr', 'scrgbClr', 'schemeClr', 'prstClr', 'sysClr', 'hslClr'].includes(localName)) colorSeen = true;
        if (localName.startsWith('alpha') && !alphaOperationPreservesOpacity(tag)) transparentOrUncertain = true;
      }
    },
    closetag: (_parser, tag) => {
      const localName = fragmentTagLocalName(tag);
      if (localName === 'solidFill' && depth === solidFillDepth) {
        if (colorSeen && !transparentOrUncertain) opaqueFillFound = true;
        solidFillDepth = -1;
      }
      if (localName === 'spPr' && depth === shapePropertiesDepth) shapePropertiesDepth = -1;
      depth -= 1;
    }
  });
  return opaqueFillFound;
}

function opaquePicture(elementXml) {
  let hasEmbeddedImage = false;
  let transparentOrUncertain = false;
  visitXmlFragment(elementXml, {
    opentag: (_parser, tag) => {
      const localName = fragmentTagLocalName(tag);
      if (localName === 'blip') {
        hasEmbeddedImage = Object.entries(tag.attributes || {}).some(([name, attribute]) => ['embed', 'link'].includes(String(attribute?.local || name).split(':').pop()) && String(attribute?.value ?? attribute ?? '').trim());
      }
      if (localName.startsWith('alpha') && !alphaOperationPreservesOpacity(tag)) transparentOrUncertain = true;
    }
  });
  return hasEmbeddedImage && !transparentOrUncertain;
}

function slideOpaqueOccluders(slideXml) {
  const occluders = [];
  for (const range of visualElementRanges(slideXml)) {
    const elementXml = slideXml.slice(range.start, range.end);
    if (truthyXmlAttribute(nonVisualProperties(elementXml).hidden)) continue;
    const opaque = range.kind === 'pic' ? opaquePicture(elementXml) : opaqueSolidRectFill(elementXml);
    if (!opaque) continue;
    const geometry = shapeGeometry(elementXml, groupParentMatrix(slideXml, range.groups));
    if (geometry && geometry.width > 0 && geometry.height > 0) occluders.push(geometry);
  }
  return occluders;
}

function rectangleCorners(geometry) {
  return [
    { x: geometry.x, y: geometry.y },
    { x: geometry.x + geometry.width, y: geometry.y },
    { x: geometry.x + geometry.width, y: geometry.y + geometry.height },
    { x: geometry.x, y: geometry.y + geometry.height }
  ];
}

function pointInsideConvexPolygon(point, polygon) {
  let direction = 0;
  const coordinateScale = Math.max(1, ...polygon.flatMap((corner) => [Math.abs(corner.x), Math.abs(corner.y)]));
  const epsilon = coordinateScale * coordinateScale * 1e-10;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) <= epsilon) continue;
    const nextDirection = Math.sign(cross);
    if (direction && nextDirection !== direction) return false;
    direction = nextDirection;
  }
  return true;
}

function geometryFullyCovers(occluder, block) {
  if (!occluder || !block || block.width <= 0 || block.height <= 0) return false;
  const occluderCorners = Array.isArray(occluder.corners) && occluder.corners.length === 4 ? occluder.corners : rectangleCorners(occluder);
  const blockCorners = Array.isArray(block.corners) && block.corners.length === 4 ? block.corners : rectangleCorners(block);
  return blockCorners.every((corner) => pointInsideConvexPolygon(corner, occluderCorners));
}

function geometriesOverlap(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function sampledCoverage(block, occluders, inset = 0, steps = 8) {
  let covered = 0;
  const span = 1 - inset * 2;
  for (let row = 0; row < steps; row += 1) {
    for (let column = 0; column < steps; column += 1) {
      const point = {
        x: block.x + block.width * (inset + (column + 0.5) * span / steps),
        y: block.y + block.height * (inset + (row + 0.5) * span / steps)
      };
      if (occluders.some((occluder) => pointInsideConvexPolygon(point, occluder.corners || rectangleCorners(occluder)))) covered += 1;
    }
  }
  return covered / (steps * steps);
}

function geometryEffectivelyCovered(occluders, block) {
  const candidates = occluders.filter((occluder) => geometriesOverlap(occluder, block));
  if (!candidates.length) return false;
  if (candidates.some((occluder) => geometryFullyCovers(occluder, block))) return true;
  if (candidates.length > 128) return false;
  return sampledCoverage(block, candidates) >= 0.8 && sampledCoverage(block, candidates, 0.1) >= 0.95;
}

function markInheritedOcclusion(blocks, slideXml) {
  const occluders = slideOpaqueOccluders(slideXml);
  return blocks.map((block) => ({
    ...block,
    occluded: ['master', 'layout'].includes(block.sourceLayer) && geometryEffectivelyCovered(occluders, block)
  }));
}

function nonVisualProperties(elementXml) {
  const tag = elementXml.match(qualifiedOpenTagPattern('cNvPr'))?.[0] || '';
  return xmlAttributes(tag);
}

function placeholderDescriptor(elementXml) {
  const tag = elementXml.match(qualifiedOpenTagPattern('ph'))?.[0] || '';
  if (!tag) return null;
  const attrs = xmlAttributes(tag);
  return { idx: String(attrs.idx || ''), type: String(attrs.type || 'obj') };
}

function placeholderGeometry(placeholder, map) {
  if (!placeholder || !map) return null;
  return (placeholder.idx && map.byIndex.get(placeholder.idx)) || map.byType.get(placeholder.type || 'obj') || null;
}

function placeholderGeometryMap(partXml, inheritedMap = null) {
  const map = { byIndex: new Map(), byType: new Map() };
  for (const range of selectableShapeRanges(partXml)) {
    if (range.kind !== 'sp') continue;
    const elementXml = partXml.slice(range.start, range.end);
    const placeholder = placeholderDescriptor(elementXml);
    if (!placeholder) continue;
    const ownGeometry = shapeGeometry(elementXml, groupParentMatrix(partXml, range.groups));
    const geometry = ownGeometry || placeholderGeometry(placeholder, inheritedMap);
    if (!geometry) continue;
    if (placeholder.idx) map.byIndex.set(placeholder.idx, geometry);
    if (!map.byType.has(placeholder.type)) map.byType.set(placeholder.type, geometry);
  }
  return map;
}

function explicitTextBox(elementXml) {
  const attrs = xmlAttributes(elementXml.match(qualifiedOpenTagPattern('cNvSpPr'))?.[0] || '');
  return truthyXmlAttribute(attrs.txBox);
}

function blockIdFor(slideNumber, sourceLayer, shapeId, cell = null) {
  const layer = sourceLayer === 'slide' ? '' : `${sourceLayer}-`;
  return cell
    ? `slide-${slideNumber}-${layer}table-${shapeId}-cell-${cell.row}-${cell.column}`
    : `slide-${slideNumber}-${layer}shape-${shapeId}`;
}

function tableCellPosition(state, attributes) {
  const gridSpan = Math.max(1, Number.parseInt(attributes.gridSpan || '1', 10) || 1);
  const rowSpan = Math.max(1, Number.parseInt(attributes.rowSpan || '1', 10) || 1);
  const hMerge = truthyXmlAttribute(attributes.hMerge);
  const vMerge = truthyXmlAttribute(attributes.vMerge);
  const column = state.column;
  if (hMerge) {
    if (state.pendingHorizontalMerges > 0) state.pendingHorizontalMerges -= 1;
    else state.column += gridSpan;
    return { column, gridSpan, rowSpan, mergedContinuation: true };
  }
  state.pendingHorizontalMerges = 0;
  state.column += gridSpan;
  state.pendingHorizontalMerges = Math.max(0, gridSpan - 1);
  return { column, gridSpan, rowSpan, mergedContinuation: vMerge };
}

function tableCellRecords(frameXml, parentMatrix, slideNumber, sourceLayer, shapeId, shapeName, partPath, baseZOrder) {
  const table = frameXml.match(qualifiedElementPattern('tbl'))?.[0] || '';
  if (!table) return [];
  const frameTransform = transformDescriptor(frameXml, 'graphicFrame');
  if (![frameTransform.x, frameTransform.y, frameTransform.width, frameTransform.height].every(Number.isFinite)) return [];
  const grid = table.match(qualifiedElementPattern('tblGrid'))?.[0] || '';
  const columnWidths = [...grid.matchAll(qualifiedOpenTagPattern('gridCol', 'gi'))].map((match) => finiteCoordinate(xmlAttributes(match[0]).w) || 0);
  const rowMatches = [...table.matchAll(qualifiedElementPattern('tr', 'gi'))];
  const rowHeights = rowMatches.map((match) => finiteCoordinate(xmlAttributes(match[0].match(qualifiedOpenTagPattern('tr'))?.[0] || '').h) || 0);
  const totalWidth = columnWidths.reduce((sum, value) => sum + Math.max(0, value), 0);
  const totalHeight = rowHeights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (!columnWidths.length || !rowMatches.length || totalWidth <= 0 || totalHeight <= 0) return [];
  const tableMatrix = multiplyMatrix(parentMatrix, multiplyMatrix(
    orientationMatrix(frameTransform),
    multiplyMatrix(translationMatrix(frameTransform.x, frameTransform.y), scaleMatrix(frameTransform.width / totalWidth, frameTransform.height / totalHeight))
  ));
  const records = [];
  let y = 0;
  rowMatches.forEach((rowMatch, rowIndex) => {
    const rowXml = rowMatch[0];
    const cells = [...rowXml.matchAll(qualifiedElementPattern('tc', 'gi'))];
    const state = { column: 0, pendingHorizontalMerges: 0 };
    cells.forEach((cellMatch) => {
      const cellXml = cellMatch[0];
      const cellAttrs = xmlAttributes(cellXml.match(qualifiedOpenTagPattern('tc'))?.[0] || '');
      const { column, gridSpan, rowSpan, mergedContinuation } = tableCellPosition(state, cellAttrs);
      const x = columnWidths.slice(0, column).reduce((sum, value) => sum + Math.max(0, value), 0);
      const width = columnWidths.slice(column, column + gridSpan).reduce((sum, value) => sum + Math.max(0, value), 0);
      const height = rowHeights.slice(rowIndex, rowIndex + rowSpan).reduce((sum, value) => sum + Math.max(0, value), 0);
      const text = shapeText(cellXml);
      if (text.hasTextBody && !mergedContinuation) {
        const cellGeometry = geometryFromCorners([
          transformPoint(tableMatrix, x, y),
          transformPoint(tableMatrix, x + width, y),
          transformPoint(tableMatrix, x + width, y + height),
          transformPoint(tableMatrix, x, y + height)
        ]);
        records.push({
          id: blockIdFor(slideNumber, sourceLayer, shapeId, { row: rowIndex, column }),
          slideNumber,
          shapeId,
          name: `${shapeName || '표'} · ${rowIndex + 1}행 ${column + 1}열`.slice(0, 160),
          text: text.text.slice(0, MAX_REPLACEMENT_TEXT_LENGTH),
          ...cellGeometry,
          sourceLayer,
          elementKind: 'tableCell',
          rowIndex,
          columnIndex: column,
          partPath,
          zOrder: baseZOrder + records.length / 1_000
        });
      }
    });
    y += Math.max(0, rowHeights[rowIndex]);
  });
  return records;
}

function parsePartTextBlocks(partXml, options) {
  const { slideNumber, sourceLayer, partPath, inheritedPlaceholders = null, zOrderBase = 0 } = options;
  const blocks = [];
  const shapeIds = new Set();
  const ranges = selectableElementRanges(partXml);
  ranges.forEach((range, rangeIndex) => {
    const elementXml = partXml.slice(range.start, range.end);
    const attrs = nonVisualProperties(elementXml);
    const shapeId = String(attrs.id || `auto-${rangeIndex + 1}`);
    if (shapeIds.has(shapeId)) throw new Error(`${slideNumber}번 슬라이드의 ${sourceLayer} 계층에 중복된 도형 ID가 있습니다.`);
    shapeIds.add(shapeId);
    const parentMatrix = groupParentMatrix(partXml, range.groups);
    const elementKind = range.kind === 'graphicFrame' ? 'graphicFrame' : 'shape';
    const geometry = shapeGeometry(elementXml, parentMatrix, elementKind);
    if (range.kind === 'graphicFrame') {
      blocks.push(...tableCellRecords(elementXml, parentMatrix, slideNumber, sourceLayer, shapeId, String(attrs.name || ''), partPath, zOrderBase + rangeIndex));
      return;
    }
    const text = shapeText(elementXml);
    const placeholder = placeholderDescriptor(elementXml);
    const isHidden = truthyXmlAttribute(attrs.hidden);
    const selectableEmpty = text.hasTextBody && (explicitTextBox(elementXml) || (sourceLayer === 'slide' && placeholder));
    if (isHidden || (!text.hasTextNodes && !selectableEmpty) || (sourceLayer !== 'slide' && placeholder)) return;
    const resolvedGeometry = geometry || placeholderGeometry(placeholder, inheritedPlaceholders);
    if (!resolvedGeometry) return;
    blocks.push({
      id: blockIdFor(slideNumber, sourceLayer, shapeId),
      slideNumber,
      shapeId,
      name: String(attrs.name || `텍스트 ${blocks.length + 1}`).slice(0, 160),
      text: text.text.slice(0, MAX_REPLACEMENT_TEXT_LENGTH),
      x: resolvedGeometry.x,
      y: resolvedGeometry.y,
      width: resolvedGeometry.width,
      height: resolvedGeometry.height,
      sourceLayer,
      elementKind: 'shape',
      partPath,
      zOrder: zOrderBase + rangeIndex,
      corners: resolvedGeometry.corners
    });
    if (blocks.length > MAX_PPTX_TEXT_BLOCKS) throw new Error('PPTX에 선택 가능한 텍스트 블록이 너무 많습니다.');
  });
  return blocks;
}

function parseSlideTextBlocks(slideXml, slideNumber, size) {
  return parsePartTextBlocks(slideXml, {
    slideNumber,
    sourceLayer: 'slide',
    partPath: `ppt/slides/slide${slideNumber}.xml`,
    inheritedPlaceholders: null,
    size
  });
}

function relationshipPartName(partPath) {
  return path.posix.join(path.posix.dirname(partPath), '_rels', `${path.posix.basename(partPath)}.rels`);
}

function relationshipSourcePartName(relationshipsPartPath) {
  const normalized = String(relationshipsPartPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.toLowerCase() === '_rels/.rels') return '';
  const match = normalized.match(/^(.*\/)?_rels\/([^/]+)\.rels$/i);
  if (!match) return null;
  return `${match[1] || ''}${match[2]}`;
}

function resolvePackageRelationshipTarget(sourcePart, target) {
  let cleanTarget = String(target || '').trim().replace(/\\/g, '/');
  try { cleanTarget = decodeURIComponent(cleanTarget); }
  catch (_) { throw new Error('PPTX 내부 연결 경로의 문자 인코딩이 올바르지 않습니다.'); }
  if (!cleanTarget
    || cleanTarget.includes('\u0000')
    || cleanTarget.includes('#')
    || cleanTarget.includes('?')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleanTarget)) {
    throw new Error('PPTX 내부 연결 경로가 올바르지 않습니다.');
  }
  const joined = cleanTarget.startsWith('/')
    ? cleanTarget.replace(/^\/+/, '')
    : path.posix.join(path.posix.dirname(String(sourcePart || '')), cleanTarget);
  const normalized = path.posix.normalize(joined).replace(/^\.\//, '');
  if (!normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('PPTX 내부 연결 경로가 안전하지 않습니다.');
  }
  return normalized;
}

function relationshipElementPattern(flags = 'gi') {
  return new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?Relationship\\b[^>]*(?:\\/\\s*>|>[\\s\\S]*?<\\/(?:[A-Za-z_][\\w.-]*:)?Relationship\\s*>)`, flags);
}

function internalRelationshipRecords(relationshipsXml, sourcePart) {
  const records = [];
  const pattern = relationshipElementPattern();
  let match;
  while ((match = pattern.exec(String(relationshipsXml || '')))) {
    const attrs = xmlAttributes(match[0]);
    if (!attrs.Target || String(attrs.TargetMode || '').trim().toLowerCase() === 'external') continue;
    records.push({
      id: String(attrs.Id || ''),
      type: String(attrs.Type || ''),
      targetPart: resolvePackageRelationshipTarget(sourcePart, attrs.Target)
    });
  }
  return records;
}

async function assertNoPptxDigitalSignatures(archive) {
  const signatureError = () => {
    const error = new Error('디지털 서명된 PPTX는 내부 호환 분할로 다시 저장하면 서명이 무효화될 수 있어 처리하지 않았습니다. PowerPoint 분할을 사용하거나 서명을 제거한 사본으로 다시 시도해주세요.');
    error.code = 'DOCUMENT_SPLIT_PPTX_DIGITAL_SIGNATURE_UNSUPPORTED';
    return error;
  };
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.some((entry) => /^_xmlsignatures(?:\/|$)/i.test(String(entry.name || '').replace(/\\/g, '/')))) {
    throw signatureError();
  }
  const contentTypesXml = await readXmlEntry(archive.file('[Content_Types].xml'), '[Content_Types].xml');
  const contentTypes = parseContentTypes(contentTypesXml);
  for (const entry of entries) {
    if (/digital-signature/i.test(contentTypeForEntry(contentTypes, entry.name))) throw signatureError();
    if (!String(entry.name || '').toLowerCase().endsWith('.rels')) continue;
    const relationshipsXml = await readXmlEntry(entry, `${entry.name} 연결`);
    const pattern = relationshipElementPattern();
    let match;
    while ((match = pattern.exec(relationshipsXml))) {
      if (/\/digital-signature(?:\/|$)/i.test(String(xmlAttributes(match[0]).Type || ''))) throw signatureError();
    }
  }
}

async function packageRelationshipGraph(archive) {
  const graph = new Map();
  const relationshipParts = [];
  const partNames = Object.values(archive.files)
    .filter((entry) => !entry.dir && String(entry.name || '').toLowerCase().endsWith('.rels'))
    .map((entry) => String(entry.name || '').replace(/\\/g, '/'))
    .sort();
  for (const relationshipsPartPath of partNames) {
    const sourcePart = relationshipSourcePartName(relationshipsPartPath);
    if (sourcePart === null) continue;
    const xml = await readXmlEntry(archive.file(relationshipsPartPath), `${relationshipsPartPath} 연결`);
    const records = internalRelationshipRecords(xml, sourcePart);
    graph.set(sourcePart, records.map((record) => record.targetPart));
    relationshipParts.push({ relationshipsPartPath, sourcePart, xml, records });
  }
  return { graph, relationshipParts };
}

function relationshipClosure(seeds, graph, blocked = new Set()) {
  const reached = new Set();
  const queue = [...seeds];
  for (let index = 0; index < queue.length; index += 1) {
    const partName = String(queue[index] || '');
    if (blocked.has(partName) || reached.has(partName)) continue;
    reached.add(partName);
    for (const targetPart of graph.get(partName) || []) {
      if (!blocked.has(targetPart) && !reached.has(targetPart)) queue.push(targetPart);
    }
  }
  return reached;
}

function removeContentTypeOverrides(contentTypesXml, removedParts) {
  return String(contentTypesXml || '').replace(qualifiedElementPattern('Override', 'gi'), (tag) => {
    const partName = canonicalPartName(xmlAttributes(tag).PartName || '').replace(/^\//, '');
    return partName && removedParts.has(partName) ? '' : tag;
  });
}

function isPresentationCommentPrivacyPart(partName) {
  const normalized = String(partName || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  if (normalized === 'ppt/commentauthors.xml') return true;
  return /^ppt\/(?:comments?[^/]*|threadedcomments?[^/]*|commentauthors?[^/]*|authors?[^/]*|persons?[^/]*|people[^/]*)(?:\/|$)/i.test(normalized);
}

function isPresentationCommentRelationship(type) {
  const tail = String(type || '').replace(/\/+$/, '').split('/').pop().toLowerCase();
  return tail.includes('comment') || ['author', 'authors', 'person', 'persons', 'people'].includes(tail);
}

function isSplitDerivedPrivacyPart(partName) {
  const normalized = String(partName || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return isPresentationCommentPrivacyPart(normalized)
    || /^docprops\/thumbnail\.(?:jpe?g|png|wmf|emf)$/i.test(normalized)
    || normalized === 'ppt/viewprops.xml';
}

function isSplitDerivedPrivacyRelationship(type, sourcePart, targetPart) {
  const tail = String(type || '').replace(/\/+$/, '').split('/').pop().toLowerCase();
  if (isPresentationCommentRelationship(type) || tail === 'viewprops') return true;
  return tail === 'thumbnail'
    && (String(sourcePart || '') === '' || /^docprops\/thumbnail\.(?:jpe?g|png|wmf|emf)$/i.test(String(targetPart || '')));
}

function sanitizePresentationProperties(presentationPropertiesXml) {
  return String(presentationPropertiesXml || '').replace(qualifiedElementPattern('showPr', 'gi'), '');
}

function sanitizeModernCommentMetadata(slideXml) {
  let removed = 0;
  let sanitized = String(slideXml || '').replace(qualifiedElementPattern('ext', 'gi'), (extensionXml) => {
    const attrs = xmlAttributes(extensionXml.match(qualifiedOpenTagPattern('ext'))?.[0] || extensionXml);
    if (String(attrs.uri || '').toUpperCase() !== MODERN_COMMENT_EXTENSION_URI) return extensionXml;
    removed += 1;
    return '';
  });
  if (removed) {
    sanitized = sanitized.replace(qualifiedElementPattern('extLst', 'gi'), (extensionListXml) => (
      qualifiedElementPattern('ext').test(extensionListXml) ? extensionListXml : ''
    ));
  }
  if (qualifiedElementPattern('commentRel').test(sanitized)
    || sanitized.toUpperCase().includes(MODERN_COMMENT_EXTENSION_URI)) {
    const error = new Error('선택한 슬라이드에 알 수 없는 최신 PowerPoint 댓글 참조가 있어 내부 호환 분할을 안전하게 완료할 수 없습니다. PowerPoint 분할을 사용하거나 댓글을 삭제한 뒤 다시 시도해주세요.');
    error.code = 'DOCUMENT_SPLIT_PPTX_COMMENT_REFERENCE_UNSUPPORTED';
    throw error;
  }
  return { xml: sanitized, changed: removed > 0, removed };
}

async function pruneUnselectedSlideParts(archive, removedSlideParts, selectedSlideParts) {
  const unselectedSlideParts = new Set([...removedSlideParts].map((partName) => String(partName || '').replace(/\\/g, '/')));
  const selectedParts = new Set([...selectedSlideParts].map((partName) => String(partName || '').replace(/\\/g, '/')));
  if (!unselectedSlideParts.size) return { removedParts: new Set(), removedSlideLinks: 0, commentsRemoved: false };

  const { graph, relationshipParts } = await packageRelationshipGraph(archive);
  const initialRemoved = new Set(unselectedSlideParts);
  for (const entry of Object.values(archive.files)) {
    if (!entry.dir && isSplitDerivedPrivacyPart(entry.name)) initialRemoved.add(String(entry.name).replace(/\\/g, '/'));
  }
  for (const relationshipPart of relationshipParts) {
    for (const record of relationshipPart.records) {
      if (isSplitDerivedPrivacyRelationship(record.type, relationshipPart.sourcePart, record.targetPart)) initialRemoved.add(record.targetPart);
    }
  }
  const commentsRemoved = [...initialRemoved].some((partName) => isPresentationCommentPrivacyPart(partName));

  const candidates = relationshipClosure(initialRemoved, graph);
  const retainedSeeds = new Set(['', ...selectedParts]);
  for (const sourcePart of graph.keys()) {
    if (!candidates.has(sourcePart)) retainedSeeds.add(sourcePart);
  }
  const retained = relationshipClosure(retainedSeeds, graph, initialRemoved);
  const removedParts = new Set([...candidates].filter((partName) => !retained.has(partName)));
  initialRemoved.forEach((partName) => removedParts.add(partName));
  for (const relationshipPart of relationshipParts) {
    if (removedParts.has(relationshipPart.sourcePart)) continue;
    if (relationshipPart.records.some((record) => unselectedSlideParts.has(record.targetPart) && record.type.endsWith('/slide'))) {
      const error = new Error('남길 슬라이드 또는 연결 데이터가 제외할 슬라이드로 이어져 있어 내부 호환 분할을 안전하게 완료할 수 없습니다. PowerPoint 분할을 사용하거나 연결을 해제한 뒤 다시 시도해주세요.');
      error.code = 'DOCUMENT_SPLIT_PPTX_CROSS_SLIDE_LINK_UNSUPPORTED';
      throw error;
    }
  }

  let removedSlideLinks = 0;
  for (const relationshipPart of relationshipParts) {
    if (removedParts.has(relationshipPart.sourcePart)) {
      archive.remove(relationshipPart.relationshipsPartPath);
      continue;
    }
    const nextXml = relationshipPart.xml.replace(relationshipElementPattern(), (tag) => {
      const attrs = xmlAttributes(tag);
      if (!attrs.Target || String(attrs.TargetMode || '').trim().toLowerCase() === 'external') return tag;
      const targetPart = resolvePackageRelationshipTarget(relationshipPart.sourcePart, attrs.Target);
      if (!removedParts.has(targetPart)) return tag;
      if (String(attrs.Type || '').endsWith('/slide')) removedSlideLinks += 1;
      return '';
    });
    if (nextXml !== relationshipPart.xml) {
      archive.file(relationshipPart.relationshipsPartPath, serializeXmlUtf8(nextXml));
    }
  }

  for (const partName of removedParts) {
    archive.remove(partName);
    archive.remove(relationshipPartName(partName));
  }
  const contentTypesEntry = archive.file('[Content_Types].xml');
  const contentTypesXml = await readXmlEntry(contentTypesEntry, '[Content_Types].xml');
  const removedRelationshipParts = new Set([...removedParts].map((partName) => relationshipPartName(partName)));
  archive.file(
    '[Content_Types].xml',
    serializeXmlUtf8(removeContentTypeOverrides(contentTypesXml, new Set([...removedParts, ...removedRelationshipParts])))
  );
  return { removedParts, removedSlideLinks, commentsRemoved };
}

async function verifyPackageRelationshipTargets(archive) {
  const { relationshipParts } = await packageRelationshipGraph(archive);
  for (const relationshipPart of relationshipParts) {
    for (const record of relationshipPart.records) {
      if (!archive.file(record.targetPart)) {
        throw new Error('분할 PPTX의 내부 연결 대상이 누락되어 결과를 만들지 않았습니다.');
      }
    }
  }
  const contentTypesXml = await readXmlEntry(archive.file('[Content_Types].xml'), '[Content_Types].xml');
  const contentTypes = parseContentTypes(contentTypesXml);
  for (const partName of contentTypes.overrides.keys()) {
    if (!archive.file(partName.replace(/^\//, ''))) {
      throw new Error('분할 PPTX의 콘텐츠 형식 대상이 누락되어 결과를 만들지 않았습니다.');
    }
  }
  for (const entry of Object.values(archive.files)) {
    const partName = String(entry.name || '').replace(/\\/g, '/');
    if (entry.dir || partName === '[Content_Types].xml' || partName.toLowerCase().endsWith('.rels')) continue;
    const contentType = contentTypeForEntry(contentTypes, partName);
    if (!/\.xml$/i.test(partName) && !isXmlContentType(contentType)) continue;
    const xml = await readXmlEntry(entry, `${partName} 관계 참조`);
    const referencedIds = [];
    visitXml(xml, {
      opentag: (_parser, tag) => {
        for (const attribute of Object.values(tag?.attributes || {})) {
          if (OFFICE_RELATIONSHIP_NAMESPACES.has(String(attribute?.uri || '')) && attribute?.value) {
            referencedIds.push(String(attribute.value));
          }
        }
      }
    });
    if (!referencedIds.length) continue;
    const relationshipsEntry = archive.file(relationshipPartName(partName));
    if (!relationshipsEntry) {
      throw new Error('분할 PPTX의 XML 관계 참조 대상이 누락되어 결과를 만들지 않았습니다.');
    }
    const relationshipsXml = await readXmlEntry(relationshipsEntry, `${partName} 연결`);
    const availableIds = new Set();
    const relationshipPattern = relationshipElementPattern();
    let relationshipMatch;
    while ((relationshipMatch = relationshipPattern.exec(relationshipsXml))) {
      const relationshipId = String(xmlAttributes(relationshipMatch[0]).Id || '');
      if (relationshipId) availableIds.add(relationshipId);
    }
    if (referencedIds.some((relationshipId) => !availableIds.has(relationshipId))) {
      throw new Error('분할 PPTX의 XML 관계 ID가 연결 파일과 일치하지 않아 결과를 만들지 않았습니다.');
    }
  }
}

async function relatedPartPath(archive, sourcePart, relationshipSuffix) {
  const relationshipsPart = archive.file(relationshipPartName(sourcePart));
  if (!relationshipsPart) return '';
  const relationshipsXml = await readXmlEntry(relationshipsPart, `${sourcePart} 연결`);
  const relationshipPattern = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/gi;
  let match;
  while ((match = relationshipPattern.exec(relationshipsXml))) {
    const attrs = xmlAttributes(match[0]);
    if (!String(attrs.Type || '').endsWith(`/${relationshipSuffix}`) || !attrs.Target) continue;
    return resolvePartTarget(sourcePart, attrs.Target);
  }
  return '';
}

function masterShapesVisible(partXml, rootName) {
  const attrs = xmlAttributes(partXml.match(qualifiedOpenTagPattern(rootName))?.[0] || '');
  return !['0', 'false', 'off'].includes(String(attrs.showMasterSp || '').toLowerCase());
}

async function inspectPptxArchive(archive) {
  const presentationXml = await readXmlEntry(archive.file('ppt/presentation.xml'), '프레젠테이션');
  const relationshipsPart = archive.file('ppt/_rels/presentation.xml.rels');
  if (!relationshipsPart) throw new Error('PPTX 슬라이드 연결 정보를 찾을 수 없습니다.');
  const relationshipsXml = await readXmlEntry(relationshipsPart, '프레젠테이션 연결');
  const references = slideReferences(presentationXml, relationshipsXml);
  const size = slideSize(presentationXml);
  const slides = [];
  const usedFontFamilies = new Map();
  const embeddedFonts = embeddedFontFamilies(presentationXml);
  const presentationTypefaceRefs = typefaceReferences(withoutEmbeddedFontList(presentationXml));
  presentationTypefaceRefs.forEach((typeface) => addTypeface(usedFontFamilies, typeface));
  const scannedFontParts = new Map();
  const themeCache = new Map();
  const fontReferencesForPart = (partPath, partXml) => {
    if (!partPath) return typefaceReferences(partXml);
    if (!scannedFontParts.has(partPath)) {
      const referencesForPart = typefaceReferences(partXml);
      referencesForPart.forEach((typeface) => addTypeface(usedFontFamilies, typeface));
      scannedFontParts.set(partPath, referencesForPart);
    }
    return scannedFontParts.get(partPath);
  };
  let totalBlocks = 0;
  let totalVisibleBlocks = 0;
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const part = archive.file(reference.partPath);
    if (!part) throw new Error(`${index + 1}번 슬라이드 파일을 찾을 수 없습니다.`);
    const slideXml = await readXmlEntry(part, `${index + 1}번 슬라이드`);
    const layoutPath = await relatedPartPath(archive, reference.partPath, 'slideLayout');
    const layoutXml = layoutPath && archive.file(layoutPath) ? await readXmlEntry(archive.file(layoutPath), `${index + 1}번 슬라이드 레이아웃`) : '';
    const masterPath = layoutPath ? await relatedPartPath(archive, layoutPath, 'slideMaster') : '';
    const masterXml = masterPath && archive.file(masterPath) ? await readXmlEntry(archive.file(masterPath), `${index + 1}번 슬라이드 마스터`) : '';
    const slideTypefaceRefs = fontReferencesForPart(reference.partPath, slideXml);
    const layoutTypefaceRefs = layoutXml ? fontReferencesForPart(layoutPath, layoutXml) : [];
    const masterTypefaceRefs = masterXml ? fontReferencesForPart(masterPath, masterXml) : [];
    const themePath = masterPath ? await relatedPartPath(archive, masterPath, 'theme') : '';
    if (themePath && archive.file(themePath) && !themeCache.has(themePath)) {
      const themeXml = await readXmlEntry(archive.file(themePath), `${index + 1}번 슬라이드 테마`);
      themeCache.set(themePath, themeTypefaceMap(themeXml));
    }
    const themeFonts = themeCache.get(themePath) || new Map();
    for (const typeface of [...presentationTypefaceRefs, ...slideTypefaceRefs, ...layoutTypefaceRefs, ...masterTypefaceRefs]) {
      const resolved = themeFonts.get(String(typeface || '').toLowerCase());
      if (resolved) addTypeface(usedFontFamilies, resolved);
    }
    const masterPlaceholders = masterXml ? placeholderGeometryMap(masterXml) : null;
    const layoutPlaceholders = layoutXml ? placeholderGeometryMap(layoutXml, masterPlaceholders) : masterPlaceholders;
    const parsedBlocks = [];
    if (masterXml && masterShapesVisible(slideXml, 'sld') && masterShapesVisible(layoutXml, 'sldLayout')) {
      parsedBlocks.push(...parsePartTextBlocks(masterXml, { slideNumber: index + 1, sourceLayer: 'master', partPath: masterPath, inheritedPlaceholders: null, zOrderBase: 0 }));
    }
    if (layoutXml) parsedBlocks.push(...parsePartTextBlocks(layoutXml, { slideNumber: index + 1, sourceLayer: 'layout', partPath: layoutPath, inheritedPlaceholders: masterPlaceholders, zOrderBase: 10_000 }));
    parsedBlocks.push(...parsePartTextBlocks(slideXml, { slideNumber: index + 1, sourceLayer: 'slide', partPath: reference.partPath, inheritedPlaceholders: layoutPlaceholders, zOrderBase: 20_000 }));
    const blocks = markInheritedOcclusion(parsedBlocks, slideXml);
    const visibleBlockCount = blocks.filter((block) => !block.occluded).length;
    totalBlocks += blocks.length;
    totalVisibleBlocks += visibleBlockCount;
    if (totalBlocks > MAX_PPTX_TEXT_BLOCKS) throw new Error('PPTX에 선택 가능한 텍스트 블록이 너무 많습니다.');
    slides.push({ number: index + 1, partPath: reference.partPath, blockCount: blocks.length, visibleBlockCount, blocks });
  }
  return {
    slideCount: slides.length,
    slideSize: size,
    blockCount: totalBlocks,
    visibleBlockCount: totalVisibleBlocks,
    usedFonts: [...usedFontFamilies.values()],
    embeddedFonts,
    slides,
    references,
    presentationXml,
    relationshipsXml
  };
}

async function inspectPptxBuffer(buffer) {
  const archive = await loadArchiveBuffer(buffer);
  const inspected = await inspectPptxArchive(archive);
  return {
    slideCount: inspected.slideCount,
    slideSize: inspected.slideSize,
    blockCount: inspected.blockCount,
    visibleBlockCount: inspected.visibleBlockCount,
    usedFonts: inspected.usedFonts,
    embeddedFonts: inspected.embeddedFonts,
    slides: inspected.slides
  };
}

async function inspectPptxFile(filePath) {
  const { sourcePath, buffer } = await readPptxFile(filePath);
  const inspected = await inspectPptxBuffer(buffer);
  return { ...inspected, sourcePath, sourceName: path.basename(sourcePath), sourceBytes: buffer.length };
}

function drawingPrefixFor(xml) {
  for (const localName of ['bodyPr', 'lstStyle', 'rPr', 'endParaRPr', 'r', 'fld', 't', 'p']) {
    const match = String(xml || '').match(new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}${localName}\\b`, 'i'));
    if (match) return match[1] || '';
  }
  return 'a:';
}

function collapseTextParagraphs(bodyXml) {
  const paragraphs = [...String(bodyXml).matchAll(qualifiedElementPattern('p', 'gi'))];
  if (paragraphs.length <= 1) return bodyXml;
  const anchorIndex = Math.max(0, paragraphs.findIndex((match) => qualifiedOpenTagPattern('t').test(match[0])));
  let index = 0;
  return String(bodyXml).replace(qualifiedElementPattern('p', 'gi'), (paragraph) => {
    const keep = index === anchorIndex;
    index += 1;
    return keep ? paragraph : '';
  });
}

function convertDynamicFieldsToRuns(bodyXml, fallbackPrefix) {
  return String(bodyXml).replace(qualifiedElementPattern('fld', 'gi'), (fieldXml) => {
    const paired = fieldXml.match(new RegExp(`^<${XML_PREFIX_CAPTURE_PATTERN}fld\\b[^>]*>([\\s\\S]*?)<\\/\\1fld\\s*>$`, 'i'));
    if (!paired) return fieldXml;
    const runPrefix = paired[1] || fallbackPrefix;
    const content = paired[2].replace(qualifiedElementPattern('pPr', 'gi'), '');
    return `<${runPrefix}r>${content}</${runPrefix}r>`;
  });
}

function replaceTextContainer(sourceXml, replacement) {
  let replaced = false;
  const text = validateReplacementText(replacement);
  const bodyMatch = String(sourceXml).match(qualifiedElementPattern('txBody'));
  if (!bodyMatch) return sourceXml;
  const drawingPrefix = drawingPrefixFor(bodyMatch[0]);
  let bodyXml = convertDynamicFieldsToRuns(collapseTextParagraphs(bodyMatch[0]), drawingPrefix);
  bodyXml = bodyXml.replace(qualifiedElementPattern('t', 'gi'), (tag, prefix) => {
    const textPrefix = prefix || drawingPrefix;
    let openTag = tag.match(qualifiedOpenTagPattern('t'))?.[0] || `<${textPrefix}t>`;
    if (/\/\s*>$/.test(openTag)) openTag = openTag.replace(/\/\s*>$/, '>');
    if (replaced) return `${openTag}</${textPrefix}t>`;
    replaced = true;
    const needsPreserve = /^\s|\s$|\n/.test(text);
    const normalizedOpenTag = needsPreserve && !/\bxml:space\s*=/.test(openTag)
      ? openTag.replace(/>$/, ' xml:space="preserve">')
      : openTag;
    return `${normalizedOpenTag}${escapeXmlText(text)}</${textPrefix}t>`;
  });
  if (!replaced) {
    const needsPreserve = /^\s|\s$|\n/.test(text);
    const textTag = `<${drawingPrefix}t${needsPreserve ? ' xml:space="preserve"' : ''}>${escapeXmlText(text)}</${drawingPrefix}t>`;
    const run = `<${drawingPrefix}r>${textTag}</${drawingPrefix}r>`;
    const selfClosingParagraph = new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}p\\b([^>]*)\\/\\s*>`, 'i');
    if (selfClosingParagraph.test(bodyXml)) {
      bodyXml = bodyXml.replace(selfClosingParagraph, (_whole, prefix, attributes) => {
        const paragraphPrefix = prefix || drawingPrefix;
        return `<${paragraphPrefix}p${attributes}>${run}</${paragraphPrefix}p>`;
      });
      replaced = true;
    } else if (qualifiedElementPattern('p').test(bodyXml)) {
      bodyXml = bodyXml.replace(new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}p\\b([^>]*)>([\\s\\S]*?)<\\/\\1p\\s*>`, 'i'), (_whole, prefix, attributes, content) => {
        const paragraphPrefix = prefix || drawingPrefix;
        const endProperties = new RegExp(`(<${XML_PREFIX_PATTERN}endParaRPr\\b)`, 'i');
        const nextContent = endProperties.test(content)
          ? content.replace(endProperties, `${run}$1`)
          : `${content}${run}`;
        return `<${paragraphPrefix}p${attributes}>${nextContent}</${paragraphPrefix}p>`;
      });
      replaced = true;
    }
  }
  if (!replaced) return sourceXml;
  let updated = `${sourceXml.slice(0, bodyMatch.index)}${bodyXml}${sourceXml.slice(bodyMatch.index + bodyMatch[0].length)}`;
  if (KOREAN_TEXT_PATTERN.test(text)) updated = ensureKoreanTextRun(updated);
  return updated;
}

function replaceShapeText(shapeXml, replacement) {
  return replaceTextContainer(shapeXml, replacement);
}

function withKoreanLanguage(openTag) {
  if (/\blang\s*=\s*(?:"[^"]*"|'[^']*')/i.test(openTag)) {
    return openTag.replace(/\blang\s*=\s*(?:"[^"]*"|'[^']*')/i, 'lang="ko-KR"');
  }
  return openTag.replace(/\s*\/?>$/, (ending) => ` lang="ko-KR"${ending}`);
}

function koreanEastAsiaFontTag(prefix = 'a:') {
  return `<${prefix}ea typeface="${KOREAN_FALLBACK_TYPEFACE}"/>`;
}

function ensureKoreanRunProperties(runContent, fallbackPrefix = 'a:') {
  const pairedProperties = qualifiedElementPattern('rPr');
  const selfClosingProperties = new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}rPr\\b[^>]*\\/\\s*>`, 'i');
  const updateProperties = (properties) => {
    const propertyPrefix = properties.match(new RegExp(`^<${XML_PREFIX_CAPTURE_PATTERN}rPr\\b`, 'i'))?.[1] || fallbackPrefix;
    if (selfClosingProperties.test(properties)) {
      const openTag = withKoreanLanguage(properties.replace(/\/\s*>$/, '>'));
      return `${openTag}${koreanEastAsiaFontTag(propertyPrefix)}</${propertyPrefix}rPr>`;
    }
    let nextProperties = properties.replace(qualifiedOpenTagPattern('rPr'), (openTag) => withKoreanLanguage(openTag));
    const eastAsiaFont = nextProperties.match(new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}ea\\b[^>]*\\/\\s*>`, 'i'))?.[0] || '';
    if (!eastAsiaFont) return nextProperties.replace(new RegExp(`<\/${XML_PREFIX_PATTERN}rPr\\s*>`, 'i'), `${koreanEastAsiaFontTag(propertyPrefix)}</${propertyPrefix}rPr>`);
    const attrs = xmlAttributes(eastAsiaFont);
    if (attrs.typeface && !/^\+(?:mj|mn)-ea$/i.test(attrs.typeface)) return nextProperties;
    const eastAsiaPrefix = eastAsiaFont.match(new RegExp(`^<${XML_PREFIX_CAPTURE_PATTERN}ea\\b`, 'i'))?.[1] || propertyPrefix;
    return nextProperties.replace(new RegExp(`<${XML_PREFIX_PATTERN}ea\\b[^>]*\\/\\s*>`, 'i'), koreanEastAsiaFontTag(eastAsiaPrefix));
  };

  if (pairedProperties.test(runContent)) return runContent.replace(pairedProperties, updateProperties);
  if (selfClosingProperties.test(runContent)) return runContent.replace(selfClosingProperties, updateProperties);
  const textPrefix = runContent.match(new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}t\\b`, 'i'))?.[1] || fallbackPrefix;
  return runContent.replace(new RegExp(`<${XML_PREFIX_PATTERN}t\\b`, 'i'), `<${textPrefix}rPr lang="ko-KR">${koreanEastAsiaFontTag(textPrefix)}</${textPrefix}rPr><${textPrefix}t`);
}

function ensureKoreanTextRun(shapeXml) {
  let updated = false;
  const runPattern = new RegExp(`<${XML_PREFIX_CAPTURE_PATTERN}(r|fld)\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\2\\s*>`, 'gi');
  return shapeXml.replace(runPattern, (whole, prefix, kind, attributes, content) => {
    if (updated || !qualifiedOpenTagPattern('t').test(content)) return whole;
    updated = true;
    const runPrefix = prefix || drawingPrefixFor(content);
    return `<${runPrefix}${kind}${attributes}>${ensureKoreanRunProperties(content, runPrefix)}</${runPrefix}${kind}>`;
  });
}

function replaceTableFrameText(frameXml, slideNumber, sourceLayer, shapeId, replacements) {
  let rowIndex = 0;
  return frameXml.replace(qualifiedElementPattern('tr', 'gi'), (rowXml) => {
    const state = { column: 0, pendingHorizontalMerges: 0 };
    const currentRow = rowIndex;
    rowIndex += 1;
    return rowXml.replace(qualifiedElementPattern('tc', 'gi'), (cellXml) => {
      const attrs = xmlAttributes(cellXml.match(qualifiedOpenTagPattern('tc'))?.[0] || '');
      const { column, mergedContinuation } = tableCellPosition(state, attrs);
      const blockId = blockIdFor(slideNumber, sourceLayer, shapeId, { row: currentRow, column });
      return !mergedContinuation && replacements.has(blockId)
        ? replaceTextContainer(cellXml, replacements.get(blockId))
        : cellXml;
    });
  });
}

function replacePartText(partXml, slideNumber, sourceLayer, replacements) {
  const replacementMap = replacements instanceof Map ? replacements : new Map(Object.entries(replacements || {}));
  let cursor = 0;
  let output = '';
  for (const [rangeIndex, range] of selectableElementRanges(partXml).entries()) {
    const elementXml = partXml.slice(range.start, range.end);
    const attrs = nonVisualProperties(elementXml);
    const shapeId = String(attrs.id || `auto-${rangeIndex + 1}`);
    output += partXml.slice(cursor, range.start);
    if (range.kind === 'graphicFrame') {
      output += replaceTableFrameText(elementXml, slideNumber, sourceLayer, shapeId, replacementMap);
    } else {
      const blockId = blockIdFor(slideNumber, sourceLayer, shapeId);
      output += replacementMap.has(blockId) ? replaceShapeText(elementXml, replacementMap.get(blockId)) : elementXml;
    }
    cursor = range.end;
  }
  return `${output}${partXml.slice(cursor)}`;
}

function replaceSlideText(slideXml, slideNumber, replacements) {
  return replacePartText(slideXml, slideNumber, 'slide', replacements);
}

function filterPresentationCustomShows(presentationXml, selectedRelationshipIds) {
  return String(presentationXml || '').replace(qualifiedElementPattern('custShowLst', 'gi'), (listXml) => {
    const filtered = listXml.replace(qualifiedElementPattern('custShow', 'gi'), (showXml) => {
      let retainedSlides = 0;
      const nextShow = showXml.replace(qualifiedElementPattern('sld', 'gi'), (slideTag) => {
        const relationshipId = relationshipIdAttribute(xmlAttributes(slideTag));
        if (!relationshipId || !selectedRelationshipIds.has(relationshipId)) return '';
        retainedSlides += 1;
        return slideTag;
      });
      return retainedSlides ? nextShow : '';
    });
    return qualifiedElementPattern('custShow').test(filtered) ? filtered : '';
  });
}

function filterPresentationSections(presentationXml, selectedPresentationIds) {
  return String(presentationXml || '').replace(qualifiedElementPattern('sectionLst', 'gi'), (listXml) => {
    const filtered = listXml.replace(qualifiedElementPattern('section', 'gi'), (sectionXml) => {
      let retainedSlides = 0;
      const nextSection = sectionXml.replace(qualifiedElementPattern('sldId', 'gi'), (slideTag) => {
        const presentationId = String(xmlAttributes(slideTag).id || '');
        if (!presentationId || !selectedPresentationIds.has(presentationId)) return '';
        retainedSlides += 1;
        return slideTag;
      });
      return retainedSlides ? nextSection : '';
    });
    return qualifiedElementPattern('section').test(filtered) ? filtered : '';
  });
}

function isolatePresentationSlides(presentationXml, relationshipsXml, selectedReferences) {
  const references = Array.isArray(selectedReferences) ? selectedReferences : [];
  if (!references.length) throw new Error('PPTX 분할 결과에는 슬라이드가 하나 이상 필요합니다.');
  const selectedRelationshipIds = new Set(references.map((reference) => String(reference?.relationshipId || '')));
  const selectedPresentationIds = new Set(references.map((reference) => String(reference?.presentationId || '')));
  if (selectedRelationshipIds.has('') || selectedPresentationIds.has('')
    || selectedRelationshipIds.size !== references.length
    || selectedPresentationIds.size !== references.length) {
    throw new Error('PPTX 슬라이드 연결 정보가 올바르지 않습니다.');
  }

  let nextPresentation = String(presentationXml || '').replace(qualifiedElementPattern('sldId', 'gi'), (tag) => {
    const attrs = xmlAttributes(tag);
    const relationshipId = relationshipIdAttribute(attrs);
    if (relationshipId) return selectedRelationshipIds.has(relationshipId) ? tag : '';
    const presentationId = String(attrs.id || '');
    return presentationId && selectedPresentationIds.has(presentationId) ? tag : '';
  });
  nextPresentation = filterPresentationCustomShows(nextPresentation, selectedRelationshipIds);
  nextPresentation = filterPresentationSections(nextPresentation, selectedPresentationIds);

  const nextRelationships = String(relationshipsXml || '').replace(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*(?:\/\s*>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?Relationship\s*>)/gi, (tag) => {
    const attrs = xmlAttributes(tag);
    if (!String(attrs.Type || '').endsWith('/slide')) return tag;
    return selectedRelationshipIds.has(String(attrs.Id || '')) ? tag : '';
  });
  return { presentationXml: nextPresentation, relationshipsXml: nextRelationships };
}

function isolatePresentationSlide(presentationXml, relationshipsXml, selectedReference) {
  return isolatePresentationSlides(presentationXml, relationshipsXml, [selectedReference]);
}

function normalizeSplitSlideNumbers(value, slideCount) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PPTX_SLIDES) {
    throw new Error('PPTX 분할 결과에는 슬라이드를 1개 이상, 500개 이하로 선택해주세요.');
  }
  let prior = 0;
  return value.map((item) => {
    const slideNumber = Number(item);
    if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > slideCount) {
      throw new Error(`PPTX 슬라이드 번호는 1부터 ${slideCount}까지 입력해주세요.`);
    }
    if (slideNumber <= prior) throw new Error('PPTX 분할 슬라이드는 중복 없이 원본 순서대로 선택해주세요.');
    prior = slideNumber;
    return slideNumber;
  });
}

function updateApplicationSlideCount(appXml, slideCount, options = {}) {
  let updated = String(appXml || '').replace(
    new RegExp(`(<${XML_PREFIX_PATTERN}Slides\\b[^>]*>)\\s*\\d+\\s*(<\\/${XML_PREFIX_PATTERN}Slides\\s*>)`, 'i'),
    (_whole, openTag, closeTag) => `${openTag}${slideCount}${closeTag}`
  );
  if (options.removeSlideTitleMetadata === true) {
    // PowerPoint stores slide titles in a positional TitlesOfParts vector whose
    // category ranges are described by HeadingPairs. Safely remapping every
    // producer-specific variant is not reliable, so remove both optional
    // extended properties instead of retaining titles from excluded slides.
    updated = updated.replace(qualifiedElementPattern('HeadingPairs', 'gi'), '');
    updated = updated.replace(qualifiedElementPattern('TitlesOfParts', 'gi'), '');
  }
  return updated;
}

async function buildSplitPptxPackage(buffer, options = {}) {
  const archive = await loadArchiveBuffer(buffer);
  await assertNoPptxDigitalSignatures(archive);
  const inspected = await inspectPptxArchive(archive);
  const slideNumbers = normalizeSplitSlideNumbers(options.pages || options.slideNumbers, inspected.references.length);
  const selectedReferences = slideNumbers.map((slideNumber) => inspected.references[slideNumber - 1]);
  const selectedPartPaths = new Set(selectedReferences.map((reference) => reference.partPath));
  const removedSlidePartPaths = new Set(
    inspected.references
      .map((reference) => reference.partPath)
      .filter((partPath) => !selectedPartPaths.has(partPath))
  );
  const selectedSlideBytes = [];
  let modernCommentsSanitized = 0;
  for (const reference of selectedReferences) {
    const entry = archive.file(reference.partPath);
    const originalBytes = Buffer.from(await entry.async('uint8array'));
    const slideXml = removedSlidePartPaths.size
      ? await readXmlEntry(entry, `${reference.partPath} 슬라이드`)
      : '';
    const sanitizedComments = removedSlidePartPaths.size
      ? sanitizeModernCommentMetadata(slideXml)
      : { changed: false, removed: 0 };
    if (sanitizedComments.changed) {
      const serialized = Buffer.from(serializeXmlUtf8(sanitizedComments.xml), 'utf8');
      archive.file(reference.partPath, serialized);
      selectedSlideBytes.push({ partPath: reference.partPath, bytes: serialized });
      modernCommentsSanitized += sanitizedComments.removed;
    } else {
      selectedSlideBytes.push({ partPath: reference.partPath, bytes: originalBytes });
    }
  }
  const isolated = isolatePresentationSlides(inspected.presentationXml, inspected.relationshipsXml, selectedReferences);
  archive.file('ppt/presentation.xml', serializeXmlUtf8(isolated.presentationXml));
  archive.file('ppt/_rels/presentation.xml.rels', serializeXmlUtf8(isolated.relationshipsXml));
  const presentationPropertiesPath = removedSlidePartPaths.size
    ? await relatedPartPath(archive, 'ppt/presentation.xml', 'presProps')
    : '';
  if (presentationPropertiesPath && archive.file(presentationPropertiesPath)) {
    const presentationPropertiesXml = await readXmlEntry(archive.file(presentationPropertiesPath), '프레젠테이션 속성');
    archive.file(presentationPropertiesPath, serializeXmlUtf8(sanitizePresentationProperties(presentationPropertiesXml)));
  }
  const pruned = await pruneUnselectedSlideParts(archive, removedSlidePartPaths, selectedPartPaths);
  const appProperties = archive.file('docProps/app.xml');
  if (appProperties) {
    const appXml = await readXmlEntry(appProperties, '문서 속성');
    archive.file('docProps/app.xml', serializeXmlUtf8(updateApplicationSlideCount(appXml, selectedReferences.length, {
      removeSlideTitleMetadata: removedSlidePartPaths.size > 0
    })));
  }
  const output = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (output.length > MAX_PPTX_BYTES) throw new Error('생성된 분할 PPTX가 128MB를 넘습니다.');

  // Reopen the generated package before returning it. Besides catching a
  // malformed relationship graph, this proves that the selected slide parts
  // were not rendered, rewritten, or substituted while the package-level
  // slide list was reduced.
  const verifiedArchive = await loadArchiveBuffer(output);
  await verifyPackageRelationshipTargets(verifiedArchive);
  const verified = await inspectPptxArchive(verifiedArchive);
  const expectedRelationshipIds = selectedReferences.map((reference) => String(reference.relationshipId));
  const expectedPresentationIds = selectedReferences.map((reference) => String(reference.presentationId));
  const expectedPartPaths = selectedReferences.map((reference) => reference.partPath);
  const actualRelationshipIds = verified.references.map((reference) => String(reference.relationshipId));
  const actualPresentationIds = verified.references.map((reference) => String(reference.presentationId));
  const actualPartPaths = verified.references.map((reference) => reference.partPath);
  if (verified.slideCount !== selectedReferences.length
    || actualRelationshipIds.some((value, index) => value !== expectedRelationshipIds[index])
    || actualPresentationIds.some((value, index) => value !== expectedPresentationIds[index])
    || actualPartPaths.some((value, index) => value !== expectedPartPaths[index])
    || verified.slideSize.width !== inspected.slideSize.width
    || verified.slideSize.height !== inspected.slideSize.height) {
    throw new Error('분할 PPTX의 슬라이드 순서 또는 크기가 원본 선택과 달라 결과를 만들지 않았습니다.');
  }
  for (const selected of selectedSlideBytes) {
    const verifiedEntry = verifiedArchive.file(selected.partPath);
    const verifiedBytes = verifiedEntry && Buffer.from(await verifiedEntry.async('uint8array'));
    if (!verifiedBytes || !selected.bytes.equals(verifiedBytes)) {
      throw new Error('분할 PPTX의 선택 슬라이드 내용이 원본과 달라 결과를 만들지 않았습니다.');
    }
  }
  for (const removedPartPath of pruned.removedParts) {
    if (verifiedArchive.file(removedPartPath) || verifiedArchive.file(relationshipPartName(removedPartPath))) {
      throw new Error('분할 PPTX에 제외한 슬라이드 데이터가 남아 결과를 만들지 않았습니다.');
    }
  }
  return {
    buffer: output,
    slideCount: selectedReferences.length,
    slideNumbers,
    slideIds: expectedPresentationIds,
    slidePartPaths: expectedPartPaths,
    removedSlideLinks: pruned.removedSlideLinks,
    commentsRemoved: pruned.commentsRemoved,
    modernCommentsSanitized,
    slideSize: { ...inspected.slideSize }
  };
}

async function buildSplitPptx(buffer, options = {}) {
  return (await buildSplitPptxPackage(buffer, options)).buffer;
}

async function buildCertificatePptx(buffer, options = {}) {
  const slideNumber = Number(options.slideNumber);
  if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > MAX_PPTX_SLIDES) throw new Error('양식 슬라이드 번호가 올바르지 않습니다.');
  const archive = await loadArchiveBuffer(buffer);
  const inspected = await inspectPptxArchive(archive);
  const selectedReference = inspected.references[slideNumber - 1];
  if (!selectedReference) throw new Error('선택한 양식 슬라이드를 찾을 수 없습니다.');
  const selectedSlide = inspected.slides.find((slide) => slide.number === slideNumber);
  if (!selectedSlide) throw new Error('선택한 양식 슬라이드를 찾을 수 없습니다.');
  const replacements = options.replacements instanceof Map ? options.replacements : new Map(Object.entries(options.replacements || {}));
  if (replacements.size > 80) throw new Error('한 템플릿 문서에서 바꿀 텍스트 블록은 80개 이하만 사용할 수 있습니다.');
  const availableBlocks = new Map(selectedSlide.blocks.map((block) => [block.id, block]));
  const replacementsByPart = new Map();
  for (const [blockId, value] of replacements) {
    const block = availableBlocks.get(String(blockId));
    if (!block?.partPath || !archive.file(block.partPath)) throw new Error('선택한 텍스트 블록 정보가 올바르지 않습니다.');
    validateReplacementText(value);
    if (!replacementsByPart.has(block.partPath)) replacementsByPart.set(block.partPath, { sourceLayer: block.sourceLayer, replacements: new Map() });
    replacementsByPart.get(block.partPath).replacements.set(block.id, value);
  }
  for (const [partPath, plan] of replacementsByPart) {
    const partXml = await readXmlEntry(archive.file(partPath), `${slideNumber}번 슬라이드 ${plan.sourceLayer} 텍스트`);
    archive.file(partPath, serializeXmlUtf8(replacePartText(partXml, slideNumber, plan.sourceLayer, plan.replacements)));
  }
  const isolated = isolatePresentationSlide(inspected.presentationXml, inspected.relationshipsXml, selectedReference);
  archive.file('ppt/presentation.xml', serializeXmlUtf8(isolated.presentationXml));
  archive.file('ppt/_rels/presentation.xml.rels', serializeXmlUtf8(isolated.relationshipsXml));
  const appProperties = archive.file('docProps/app.xml');
  if (appProperties) {
    const appXml = await readXmlEntry(appProperties, '문서 속성');
    archive.file('docProps/app.xml', serializeXmlUtf8(appXml.replace(/<Slides>\d+<\/Slides>/i, '<Slides>1</Slides>')));
  }
  const output = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (output.length > MAX_PPTX_BYTES) throw new Error('생성된 템플릿 문서 PPTX가 128MB를 넘습니다.');
  return output;
}

module.exports = {
  MAX_PPTX_BYTES,
  MAX_PPTX_UNCOMPRESSED_BYTES,
  MAX_PPTX_ARCHIVE_ENTRIES,
  MAX_PPTX_SLIDES,
  MAX_PPTX_TEXT_BLOCKS,
  MAX_REPLACEMENT_TEXT_LENGTH,
  MAX_XML_PART_BYTES,
  validateXml,
  decodeXmlBytes,
  serializeXmlUtf8,
  validateReplacementText,
  decodeXmlText,
  escapeXmlText,
  xmlAttributes,
  loadArchiveBuffer,
  readPptxFile,
  slideReferences,
  slideSize,
  parseSlideTextBlocks,
  inspectPptxBuffer,
  inspectPptxFile,
  replaceSlideText,
  isolatePresentationSlides,
  isolatePresentationSlide,
  buildSplitPptxPackage,
  buildSplitPptx,
  buildCertificatePptx
};
