'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadXlsxWorkbookSafely } = require('./spreadsheet');

const HIGH_RISK_FEATURES = Object.freeze({ charts: '차트', pivots: '피벗 테이블', externalLinks: '외부 데이터 연결' });

function excelDeduplicateError(code, message, cause) {
  const error = new Error(message); error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function canonicalValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return ['empty'];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (Buffer.isBuffer(value)) return ['bytes', value.toString('base64')];
  if (typeof value === 'number') return ['number', Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value !== 'object') return [typeof value, String(value)];
  if (seen.has(value)) return ['circular'];
  seen.add(value);
  if (Array.isArray(value)) return ['array', value.map((item) => canonicalValue(item, seen))];
  return ['object', Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], seen)])];
}

function cellHasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizedMatchValue(value) {
  if (typeof value !== 'string') return canonicalValue(value);
  const normalized = value.normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/\s+/g, '')
    .toLocaleLowerCase('ko-KR');
  return ['string', normalized];
}

function columnLetter(column) {
  let value = Number(column); let result = '';
  while (Number.isInteger(value) && value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

function normalizeColumnIndexes(columnIndexes, maximumColumn, { allowEmpty = false } = {}) {
  if (columnIndexes === undefined || columnIndexes === null) return Array.from({ length: maximumColumn }, (_, index) => index + 1);
  const normalized = [...new Set((Array.isArray(columnIndexes) ? columnIndexes : []).map(Number))].sort((left, right) => left - right);
  if ((!allowEmpty && !normalized.length) || normalized.some((column) => !Number.isInteger(column) || column < 1 || column > maximumColumn)) {
    throw excelDeduplicateError('EXCEL_DEDUPLICATE_COLUMN_SELECTION_INVALID', '중복 비교 기준 열을 하나 이상 올바르게 선택해주세요.');
  }
  return normalized;
}

function rowFingerprint(row, maximumColumn, columnIndexes = null, options = {}) {
  const columns = normalizeColumnIndexes(columnIndexes, maximumColumn, { allowEmpty: true });
  const values = []; let hasContent = false;
  for (const column of columns) {
    const value = row.getCell(column).value;
    if (cellHasValue(value)) hasContent = true;
    values.push(options.normalizeText === true ? normalizedMatchValue(value) : canonicalValue(value));
  }
  return hasContent ? crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex') : '';
}

const HEADER_WORDS = /^(?:이름|성명|성함|메일|이메일|전자우편|전화|전화번호|휴대폰|연락처|소속|회사|기관|부서|직급|직책|주소|지역|구분|분류|그룹|상태|점수|비고|메모|번호|순번|name|email|e-mail|phone|mobile|contact|company|organization|department|title|address|group|status|note|memo|id)$/i;

function detectHeaderRow(sheet) {
  const maximumColumn = Math.max(0, Number(sheet.columnCount) || 0);
  const maximumRow = Math.max(0, Number(sheet.rowCount) || 0);
  if (!maximumColumn || maximumRow < 2) return 0;
  const row = sheet.getRow(1);
  let populated = 0; let headerWords = 0; let dataLike = 0;
  for (let column = 1; column <= maximumColumn; column += 1) {
    const text = String(row.getCell(column).text || '').normalize('NFKC').trim();
    if (!text) continue;
    populated += 1;
    if (HEADER_WORDS.test(text)) headerWords += 1;
    if (/@|https?:\/\/|\d{2,4}[-.)\s]\d{3,4}[-.\s]\d{4}/i.test(text)) dataLike += 1;
  }
  if (!populated || dataLike) return 0;
  return headerWords >= Math.min(2, populated) || (headerWords >= 1 && populated <= 3) ? 1 : 0;
}

function analyzeWorksheet(sheet, index, options = {}) {
  const maximumColumn = Math.max(0, Number(sheet.columnCount) || 0);
  const maximumRow = Math.max(0, Number(sheet.rowCount) || 0);
  const criteriaColumnIndexes = normalizeColumnIndexes(options.columnIndexes, maximumColumn, { allowEmpty: true });
  const headerRow = Number.isInteger(Number(options.headerRow)) ? Math.max(0, Math.min(maximumRow, Number(options.headerRow))) : detectHeaderRow(sheet);
  const firstRows = new Map(); const duplicateRows = []; const duplicateGroups = new Map(); let nonEmptyRowCount = 0;
  for (let rowNumber = headerRow + 1; rowNumber <= maximumRow; rowNumber += 1) {
    const fingerprint = rowFingerprint(sheet.getRow(rowNumber), maximumColumn, criteriaColumnIndexes, { normalizeText: options.normalizeText === true });
    if (!fingerprint) continue;
    nonEmptyRowCount += 1;
    if (!firstRows.has(fingerprint)) { firstRows.set(fingerprint, rowNumber); continue; }
    const firstRow = firstRows.get(fingerprint);
    duplicateRows.push(rowNumber);
    const group = duplicateGroups.get(fingerprint) || [firstRow]; group.push(rowNumber); duplicateGroups.set(fingerprint, group);
  }
  return {
    index, name: String(sheet.name || `시트 ${index + 1}`).slice(0, 31),
    visibility: ['visible', 'hidden', 'veryHidden'].includes(sheet.state) ? sheet.state : 'visible',
    rowCount: maximumRow, columnCount: maximumColumn, nonEmptyRowCount,
    headerRow,
    criteriaMode: options.columnIndexes === undefined || options.columnIndexes === null ? 'all' : 'columns',
    criteriaColumnIndexes,
    duplicateRowCount: duplicateRows.length, duplicateGroupCount: duplicateGroups.size,
    duplicateRows, duplicateExamples: [...duplicateGroups.values()].slice(0, 5)
  };
}

function worksheetColumns(sheet, headerRow = detectHeaderRow(sheet)) {
  const populated = new Set();
  sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (_cell, column) => populated.add(column)));
  return [...populated].sort((left, right) => left - right).map((index) => {
    const letter = columnLetter(index); const header = headerRow > 0 ? String(sheet.getRow(headerRow).getCell(index).text || '').trim().slice(0, 80) : '';
    return { index, letter, label: header && header !== letter ? header : `열 ${letter}` };
  });
}

function publicSheet(sheet) {
  return {
    index: sheet.index, name: sheet.name, visibility: sheet.visibility, rowCount: sheet.rowCount,
    columnCount: sheet.columnCount, nonEmptyRowCount: sheet.nonEmptyRowCount, headerRow: sheet.headerRow,
    criteriaMode: sheet.criteriaMode, criteriaColumnIndexes: sheet.criteriaColumnIndexes.slice(),
    duplicateRowCount: sheet.duplicateRowCount, duplicateGroupCount: sheet.duplicateGroupCount,
    duplicateExamples: sheet.duplicateExamples.map((rows) => rows.slice())
  };
}

async function analyzeExcelDuplicates(filePath, options = {}) {
  let loaded;
  try { loaded = await loadXlsxWorkbookSafely(filePath); }
  catch (error) { throw excelDeduplicateError(error?.code || 'EXCEL_DEDUPLICATE_INPUT_INVALID', error?.message || 'Excel 파일을 분석하지 못했습니다.', error); }
  const columnIndexesBySheet = options.columnIndexesBySheet && typeof options.columnIndexesBySheet === 'object' ? options.columnIndexesBySheet : {};
  const headerRowsBySheet = options.headerRowsBySheet && typeof options.headerRowsBySheet === 'object' ? options.headerRowsBySheet : {};
  const sheets = loaded.workbook.worksheets.map((sheet, index) => analyzeWorksheet(sheet, index, {
    columnIndexes: Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index))
      ? (columnIndexesBySheet[index] || columnIndexesBySheet[String(index)]) : undefined,
    headerRow: Object.hasOwn(headerRowsBySheet, index) || Object.hasOwn(headerRowsBySheet, String(index)) ? Number(headerRowsBySheet[index] ?? headerRowsBySheet[String(index)]) : undefined,
    normalizeText: Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index))
  }));
  const publicSheets = sheets.map((sheet, index) => {
    const hasCriteria = Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index));
    const groups = hasCriteria && sheet.criteriaColumnIndexes.length
      ? collectDuplicateGroups(loaded.workbook.worksheets[index], index, { columnIndexes: sheet.criteriaColumnIndexes, headerRow: sheet.headerRow }) : [];
    const automaticGroups = groups.filter((group) => group.automaticMerge === true);
    const reviewGroups = groups.filter((group) => group.automaticMerge !== true);
    return {
      ...publicSheet(sheet), columns: worksheetColumns(loaded.workbook.worksheets[index], sheet.headerRow),
      automaticGroupCount: automaticGroups.length,
      automaticDuplicateRowCount: automaticGroups.reduce((sum, group) => sum + group.rowNumbers.length - 1, 0),
      reviewRequiredGroupCount: reviewGroups.length,
      reviewRequiredDuplicateRowCount: reviewGroups.reduce((sum, group) => sum + group.rowNumbers.length - 1, 0)
    };
  });
  const highRiskFeatures = Object.entries(HIGH_RISK_FEATURES).filter(([key]) => Number(loaded.packageFeatures?.[key]) > 0)
    .map(([key, label]) => ({ key, label, count: Number(loaded.packageFeatures[key]) }));
  return {
    sourcePath: loaded.sourcePath, sourceBytes: loaded.sourceBytes, sourceSha256: loaded.sourceSha256,
    sheetCount: sheets.length, sheets: publicSheets,
    duplicateRowCount: sheets.reduce((sum, sheet) => sum + sheet.duplicateRowCount, 0),
    duplicateSheetCount: sheets.filter((sheet) => sheet.duplicateRowCount > 0).length,
    highRiskFeatures, requiresPreview: true, engine: 'cmoe-internal-excel'
  };
}

function safeCellText(cell) {
  return String(cell?.text ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').slice(0, 32767);
}

function valueSignature(value) {
  return JSON.stringify(typeof value === 'string' ? normalizedMatchValue(value) : canonicalValue(value));
}

function unionComparable(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF\s]+/g, '').toLocaleLowerCase('ko-KR');
}

function crossColumnValueIdentity(value) {
  if (typeof value !== 'string') return '';
  const compact = unionComparable(value);
  if (!compact) return '';
  if (/^[^@]+@[^@]+\.[^@]+$/.test(compact)) return `email:${compact}`;
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(compact)) return `url:${compact.replace(/\/$/, '')}`;
  const visible = String(value).normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  const digits = visible.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 16 && /^[+()\d\s.-]+$/.test(visible)) return `phone:${digits}`;
  if (compact.length >= 4) return `text:${compact}`;
  return '';
}

function uniqueCellItems(items) {
  const unique = [];
  for (const item of items) {
    const signature = valueSignature(item.cell.value);
    if (!unique.some((entry) => entry.signature === signature)) unique.push({ ...item, signature });
  }
  return unique;
}

function choosePortableAnchors(sheet, rowNumbers, maximumColumn, criteriaColumnIndexes, preferredRowNumber, targetRowNumber) {
  const criteria = new Set(criteriaColumnIndexes.map(Number)); const occurrences = new Map();
  for (const rowNumber of rowNumbers) {
    for (let columnIndex = 1; columnIndex <= maximumColumn; columnIndex += 1) {
      const cell = sheet.getRow(rowNumber).getCell(columnIndex); const identity = crossColumnValueIdentity(cell.value);
      if (!identity) continue;
      const list = occurrences.get(identity) || []; list.push({ rowNumber, columnIndex }); occurrences.set(identity, list);
    }
  }
  const anchors = new Map();
  for (const [identity, list] of occurrences.entries()) {
    const criteriaOccurrence = list.filter((item) => criteria.has(item.columnIndex)).sort((left, right) => left.columnIndex - right.columnIndex || left.rowNumber - right.rowNumber)[0];
    if (criteriaOccurrence) { anchors.set(identity, criteriaOccurrence.columnIndex); continue; }
    const preferredOccurrence = list.filter((item) => item.rowNumber === Number(preferredRowNumber)).sort((left, right) => left.columnIndex - right.columnIndex)[0];
    if (preferredOccurrence) { anchors.set(identity, preferredOccurrence.columnIndex); continue; }
    const targetOccurrence = list.filter((item) => item.rowNumber === Number(targetRowNumber)).sort((left, right) => left.columnIndex - right.columnIndex)[0];
    if (targetOccurrence) { anchors.set(identity, targetOccurrence.columnIndex); continue; }
    const counts = new Map();
    list.forEach((item) => counts.set(item.columnIndex, (counts.get(item.columnIndex) || 0) + 1));
    anchors.set(identity, [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0]);
  }
  return anchors;
}

function buildAutomaticMergePlan(sheet, rowNumbers, maximumColumn, criteriaColumnIndexes, preferredRowNumber, targetRowNumber, options = {}) {
  const criteria = new Set(criteriaColumnIndexes.map(Number));
  const portableAnchors = choosePortableAnchors(sheet, rowNumbers, maximumColumn, criteriaColumnIndexes, preferredRowNumber, targetRowNumber);
  const plan = new Map(); let crossColumnDuplicateCount = 0; let unionCellCount = 0;
  for (let columnIndex = 1; columnIndex <= maximumColumn; columnIndex += 1) {
    if (criteria.has(columnIndex)) continue;
    const populated = rowNumbers
      .map((rowNumber) => ({ rowNumber, cell: sheet.getRow(rowNumber).getCell(columnIndex) }))
      .filter((item) => cellHasValue(item.cell.value));
    const kept = populated.filter((item) => {
      const identity = crossColumnValueIdentity(item.cell.value);
      if (!identity || portableAnchors.get(identity) === columnIndex) return true;
      crossColumnDuplicateCount += 1; return false;
    });
    const unique = uniqueCellItems(kept);
    if (!unique.length) {
      const removedPortableDuplicate = populated.length > 0;
      plan.set(columnIndex, { value: null, text: '', kind: removedPortableDuplicate ? 'relocatedDuplicate' : 'empty' });
      continue;
    }
    if (unique.length === 1) {
      const item = unique[0]; plan.set(columnIndex, { value: cloneCellValue(item.cell.value), text: safeCellText(item.cell), kind: 'single' }); continue;
    }
    const suggestion = conflictMergeSuggestion(unique, preferredRowNumber);
    if (['equivalent', 'moreDetailed'].includes(suggestion.kind)) {
      plan.set(columnIndex, { value: suggestion.value, text: suggestion.value, kind: suggestion.kind }); continue;
    }
    const texts = unique.map((item) => safeCellText(item.cell).trim()).filter(Boolean);
    const combined = texts.join('\n');
    if (combined.length > 32767 && options.enforceCellLimit === true) throw excelDeduplicateError('EXCEL_DEDUPLICATE_UNION_TOO_LONG', `${columnLetter(columnIndex)}열의 합집합 값이 Excel 셀 제한을 넘었습니다.`);
    const preview = combined.length > 32767 ? `${combined.slice(0, 32766)}…` : combined;
    unionCellCount += 1; plan.set(columnIndex, { value: preview, text: preview, kind: combined.length > 32767 ? 'unionOverflow' : 'union' });
  }
  return { plan, crossColumnDuplicateCount, unionCellCount };
}

function conflictMergeSuggestion(values, preferredRowNumber) {
  if (values.some((item) => typeof item.cell?.value !== 'string')) {
    const preferred = values.find((item) => item.rowNumber === Number(preferredRowNumber)) || values[0];
    return { value: safeCellText(preferred?.cell).trim(), kind: 'manual', sourceRowNumbers: values.map((item) => item.rowNumber) };
  }
  const unique = [];
  for (const item of values) {
    const text = safeCellText(item.cell).trim(); const key = unionComparable(text);
    if (!key || unique.some((entry) => entry.key === key)) continue;
    unique.push({ rowNumber: item.rowNumber, text, key });
  }
  if (!unique.length) return { value: '', kind: 'manual', sourceRowNumbers: [] };
  const containing = unique.filter((candidate) => unique.every((entry) => candidate.key.includes(entry.key)))
    .sort((left, right) => right.key.length - left.key.length || right.text.length - left.text.length || left.rowNumber - right.rowNumber)[0];
  if (containing) return { value: containing.text, kind: unique.length === 1 ? 'equivalent' : 'moreDetailed', sourceRowNumbers: unique.map((entry) => entry.rowNumber) };
  const preferred = unique.find((entry) => entry.rowNumber === Number(preferredRowNumber)) || unique[0];
  return { value: preferred.text, kind: 'manual', sourceRowNumbers: unique.map((entry) => entry.rowNumber) };
}

function cloneCellValue(value, seen = new WeakMap()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (seen.has(value)) return seen.get(value);
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = cloneCellValue(item, seen);
  return copy;
}

function uniqueWorksheetName(workbook, requested) {
  const used = new Set(workbook.worksheets.map((sheet) => String(sheet.name || '').toLocaleLowerCase('ko-KR')));
  const base = String(requested || 'CMOE 기록').slice(0, 31);
  if (!used.has(base.toLocaleLowerCase('ko-KR'))) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = ` (${suffix})`; const candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    if (!used.has(candidate.toLocaleLowerCase('ko-KR'))) return candidate;
  }
  throw excelDeduplicateError('EXCEL_DEDUPLICATE_AUDIT_SHEET_FAILED', '처리 기록 시트 이름을 안전하게 만들지 못했습니다.');
}

function collectDuplicateGroups(sheet, index, options = {}) {
  const maximumColumn = Math.max(0, Number(sheet.columnCount) || 0);
  const maximumRow = Math.max(0, Number(sheet.rowCount) || 0);
  const columns = normalizeColumnIndexes(options.columnIndexes, maximumColumn);
  const headerRow = Number.isInteger(Number(options.headerRow)) ? Math.max(0, Math.min(maximumRow, Number(options.headerRow))) : detectHeaderRow(sheet);
  const grouped = new Map();
  for (let rowNumber = headerRow + 1; rowNumber <= maximumRow; rowNumber += 1) {
    const fingerprint = rowFingerprint(sheet.getRow(rowNumber), maximumColumn, columns, { normalizeText: true });
    if (!fingerprint) continue;
    const rows = grouped.get(fingerprint) || []; rows.push(rowNumber); grouped.set(fingerprint, rows);
  }
  return [...grouped.entries()].filter(([, rows]) => rows.length > 1).map(([fingerprint, rowNumbers]) => {
    const rows = rowNumbers.map((rowNumber) => {
      const row = sheet.getRow(rowNumber); const cells = []; let populatedCellCount = 0;
      for (let columnIndex = 1; columnIndex <= maximumColumn; columnIndex += 1) {
        const cell = row.getCell(columnIndex); const hasValue = cellHasValue(cell.value);
        if (hasValue) populatedCellCount += 1;
        cells.push({ columnIndex, text: safeCellText(cell), hasValue });
      }
      return { rowNumber, populatedCellCount, cells };
    });
    const suggestedRow = rows.slice().sort((left, right) => right.populatedCellCount - left.populatedCellCount || left.rowNumber - right.rowNumber)[0];
    const conflictColumnIndexes = []; const conflictSuggestions = []; let fillableBlankCount = 0;
    for (let columnIndex = 1; columnIndex <= maximumColumn; columnIndex += 1) {
      const populated = rowNumbers.map((rowNumber) => ({ rowNumber, cell: sheet.getRow(rowNumber).getCell(columnIndex) })).filter((item) => cellHasValue(item.cell.value));
      const unique = new Set(populated.map((item) => valueSignature(item.cell.value)));
      if (unique.size > 1) {
        conflictColumnIndexes.push(columnIndex);
        conflictSuggestions.push({ columnIndex, ...conflictMergeSuggestion(populated, suggestedRow.rowNumber) });
      }
      if (populated.length && populated.length < rowNumbers.length && unique.size === 1) fillableBlankCount += 1;
    }
    const fullRowFingerprints = rowNumbers.map((rowNumber) => rowFingerprint(sheet.getRow(rowNumber), maximumColumn, null, { normalizeText: false }));
    const exactRowDuplicate = new Set(fullRowFingerprints).size === 1; const oversized = rowNumbers.length >= 20;
    const safeMerge = !oversized && conflictSuggestions.every((suggestion) => ['equivalent', 'moreDetailed'].includes(suggestion.kind));
    const automaticMerge = true;
    const keyText = columns.map((columnIndex) => safeCellText(sheet.getRow(rowNumbers[0]).getCell(columnIndex))).filter(Boolean).join(' · ');
    const automaticPlan = buildAutomaticMergePlan(sheet, rowNumbers, maximumColumn, columns, suggestedRow.rowNumber, Math.min(...rowNumbers));
    return {
      id: `${index}-${fingerprint.slice(0, 24)}`, rowNumbers, rows, suggestedRowNumber: suggestedRow.rowNumber,
      conflictColumnIndexes, conflictSuggestions, fillableBlankCount, keyText: keyText.slice(0, 240), oversized,
      exactRowDuplicate, safeMerge, automaticMerge,
      automaticValues: Object.fromEntries([...automaticPlan.plan.entries()].map(([columnIndex, item]) => [String(columnIndex), { text: item.text, kind: item.kind }])),
      crossColumnDuplicateCount: automaticPlan.crossColumnDuplicateCount,
      unionCellCount: automaticPlan.unionCellCount
    };
  });
}

async function analyzeExcelDuplicateReview(filePath, sheetIndex, options = {}) {
  const loaded = await loadXlsxWorkbookSafely(filePath);
  if (options.expectedSha256 && loaded.sourceSha256 !== String(options.expectedSha256)) {
    throw excelDeduplicateError('EXCEL_DEDUPLICATE_INPUT_CHANGED', '선택한 Excel 파일이 분석 후 바뀌었습니다. 파일을 다시 선택해주세요.');
  }
  const index = Number(sheetIndex); const sheet = loaded.workbook.worksheets[index];
  if (!Number.isInteger(index) || !sheet) throw excelDeduplicateError('EXCEL_DEDUPLICATE_SHEET_SELECTION_INVALID', '검토할 시트를 다시 선택해주세요.');
  const headerRow = Number.isInteger(Number(options.headerRow)) ? Number(options.headerRow) : detectHeaderRow(sheet);
  const columnIndexes = normalizeColumnIndexes(options.columnIndexes, Math.max(0, Number(sheet.columnCount) || 0));
  const groups = collectDuplicateGroups(sheet, index, { columnIndexes, headerRow });
  return {
    sheetIndex: index, sheetName: String(sheet.name || `시트 ${index + 1}`).slice(0, 31), headerRow,
    criteriaColumnIndexes: columnIndexes, columns: worksheetColumns(sheet, headerRow), groups,
    duplicateGroupCount: groups.length, duplicateRowCount: groups.reduce((sum, group) => sum + group.rowNumbers.length - 1, 0),
    conflictGroupCount: groups.filter((group) => group.conflictColumnIndexes.length).length,
    oversizedGroupCount: groups.filter((group) => group.oversized).length,
    fillableGroupCount: groups.filter((group) => group.fillableBlankCount).length
  };
}

async function deduplicateExcelWorkbook(inputPath, outputPath, selectedSheetIndexes, options = {}) {
  const loaded = await loadXlsxWorkbookSafely(inputPath);
  if (options.expectedSha256 && loaded.sourceSha256 !== String(options.expectedSha256)) {
    throw excelDeduplicateError('EXCEL_DEDUPLICATE_INPUT_CHANGED', '선택한 Excel 파일이 분석 후 바뀌었습니다. 파일을 다시 선택해주세요.');
  }
  const selected = [...new Set((Array.isArray(selectedSheetIndexes) ? selectedSheetIndexes : []).map(Number))];
  if (!selected.length || selected.some((index) => !Number.isInteger(index) || index < 0 || index >= loaded.workbook.worksheets.length)) {
    throw excelDeduplicateError('EXCEL_DEDUPLICATE_SHEET_SELECTION_INVALID', '중복을 제거할 시트를 하나 이상 선택해주세요.');
  }
  const columnIndexesBySheet = options.columnIndexesBySheet && typeof options.columnIndexesBySheet === 'object' ? options.columnIndexesBySheet : {};
  const headerRowsBySheet = options.headerRowsBySheet && typeof options.headerRowsBySheet === 'object' ? options.headerRowsBySheet : {};
  const preferredRowsByGroup = options.preferredRowsByGroup && typeof options.preferredRowsByGroup === 'object' ? options.preferredRowsByGroup : {};
  const cellSourceRowsByGroup = options.cellSourceRowsByGroup && typeof options.cellSourceRowsByGroup === 'object' ? options.cellSourceRowsByGroup : {};
  const customValuesByGroup = options.customValuesByGroup && typeof options.customValuesByGroup === 'object' ? options.customValuesByGroup : {};
  const approvedGroupIds = new Set((Array.isArray(options.approvedGroupIds) ? options.approvedGroupIds : []).map(String));
  const mergeMissingValues = options.mergeMissingValues !== false;
  for (const index of selected) {
    if (Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index))) {
      normalizeColumnIndexes(columnIndexesBySheet[index] || columnIndexesBySheet[String(index)], Math.max(0, Number(loaded.workbook.worksheets[index].columnCount) || 0));
    }
  }
  const analyses = loaded.workbook.worksheets.map((sheet, index) => analyzeWorksheet(sheet, index, {
    columnIndexes: Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index))
      ? (columnIndexesBySheet[index] || columnIndexesBySheet[String(index)]) : undefined,
    headerRow: Object.hasOwn(headerRowsBySheet, index) || Object.hasOwn(headerRowsBySheet, String(index)) ? Number(headerRowsBySheet[index] ?? headerRowsBySheet[String(index)]) : undefined,
    normalizeText: Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index))
  })); const results = []; const auditRows = []; const preservedRows = [];
  for (const index of selected) {
    options.throwIfCancelled?.();
    const sheet = loaded.workbook.worksheets[index]; const analysis = analyses[index];
    let mergedCellCount = 0; let conflictCellCount = 0; let approvedGroupCount = 0; let automaticGroupCount = 0; let skippedGroupCount = 0; let skippedDuplicateRowCount = 0;
    let rowsToRemove = [];
    if (analysis.criteriaMode === 'columns') {
      const groups = collectDuplicateGroups(sheet, index, { columnIndexes: analysis.criteriaColumnIndexes, headerRow: analysis.headerRow });
      for (const group of groups) {
        const automatic = group.automaticMerge === true;
        const approved = approvedGroupIds.has(group.id);
        if (!automatic && !approved) {
          skippedGroupCount += 1; skippedDuplicateRowCount += Math.max(0, group.rowNumbers.length - 1);
          auditRows.push([analysis.name, '유지', analysis.criteriaColumnIndexes.map(columnLetter).join('+'), group.rowNumbers.join(', '), '', '', group.conflictColumnIndexes.length, '사용자가 통합을 선택하지 않아 모든 행을 그대로 유지했습니다.']);
          continue;
        }
        const targetRowNumber = Math.min(...group.rowNumbers); const targetRow = sheet.getRow(targetRowNumber);
        if (automatic) automaticGroupCount += 1; else approvedGroupCount += 1;
        if (!group.exactRowDuplicate) {
          for (const rowNumber of group.rowNumbers) {
            const values = [];
            for (let columnIndex = 1; columnIndex <= analysis.columnCount; columnIndex += 1) values.push(cloneCellValue(sheet.getRow(rowNumber).getCell(columnIndex).value));
            preservedRows.push({ sheetName: analysis.name, groupId: group.id, rowNumber, values });
          }
        }
        const requestedPreferred = Number(preferredRowsByGroup[group.id]);
        const preferredRowNumber = group.rowNumbers.includes(requestedPreferred) ? requestedPreferred : group.suggestedRowNumber;
        const overrides = cellSourceRowsByGroup[group.id] && typeof cellSourceRowsByGroup[group.id] === 'object' ? cellSourceRowsByGroup[group.id] : {};
        const customValues = customValuesByGroup[group.id] && typeof customValuesByGroup[group.id] === 'object' ? customValuesByGroup[group.id] : {};
        if (!group.exactRowDuplicate) {
          const automaticPlan = buildAutomaticMergePlan(sheet, group.rowNumbers, analysis.columnCount, analysis.criteriaColumnIndexes, preferredRowNumber, targetRowNumber, { enforceCellLimit: true });
          for (let columnIndex = 1; columnIndex <= analysis.columnCount; columnIndex += 1) {
            const values = group.rowNumbers.map((rowNumber) => ({ rowNumber, cell: sheet.getRow(rowNumber).getCell(columnIndex) })).filter((item) => cellHasValue(item.cell.value));
            const unique = new Set(values.map((item) => valueSignature(item.cell.value)));
            if (unique.size > 1) conflictCellCount += 1;
            const targetCell = targetRow.getCell(columnIndex);
            const isCriteriaColumn = analysis.criteriaColumnIndexes.includes(columnIndex);
            const customKey = String(columnIndex);
            if (!isCriteriaColumn && Object.hasOwn(customValues, customKey)) {
              const customValue = String(customValues[customKey] ?? '');
              if (customValue.length > 32767) throw excelDeduplicateError('EXCEL_DEDUPLICATE_CUSTOM_VALUE_TOO_LONG', `${columnLetter(columnIndex)}열의 직접 입력 값이 Excel 셀 제한을 넘었습니다.`);
              if (targetCell.value !== customValue) { targetCell.value = customValue; mergedCellCount += 1; }
              continue;
            }
            if (!values.length) continue;
            const rawOverride = overrides[customKey] ?? overrides[columnIndex];
            const requestedSourceRowNumber = Number(rawOverride);
            const hasValidOverride = group.rowNumbers.includes(requestedSourceRowNumber)
              && cellHasValue(sheet.getRow(requestedSourceRowNumber).getCell(columnIndex).value);
            if (isCriteriaColumn) continue;
            if (hasValidOverride) {
              const overrideValue = cloneCellValue(sheet.getRow(requestedSourceRowNumber).getCell(columnIndex).value);
              if (valueSignature(targetCell.value) !== valueSignature(overrideValue)) { targetCell.value = overrideValue; mergedCellCount += 1; }
              continue;
            }
            const planned = automaticPlan.plan.get(columnIndex);
            if (!planned) continue;
            if (valueSignature(targetCell.value) !== valueSignature(planned.value)) { targetCell.value = cloneCellValue(planned.value); mergedCellCount += 1; }
            if (planned.kind === 'union') {
              targetCell.alignment = { ...(targetCell.alignment || {}), wrapText: true, vertical: 'top' };
              const lineCount = String(planned.text || '').split('\n').length;
              targetRow.height = Math.max(Number(targetRow.height) || 15, Math.min(120, lineCount * 15));
            }
          }
        }
        const removed = group.rowNumbers.filter((rowNumber) => rowNumber !== targetRowNumber);
        rowsToRemove.push(...removed);
        const resultLabel = group.exactRowDuplicate ? '자동 정리' : group.safeMerge ? '안전 자동 통합' : '자동 합집합 통합';
        const description = group.exactRowDuplicate
          ? '모든 셀 값이 같은 행만 자동으로 정리했습니다.'
          : group.safeMerge ? '빈칸, 공백 차이 또는 한 값이 다른 값을 포함하는 경우만 더 자세한 기존 원문으로 통합하고, 통합 전 행을 CMOE 원본 보존 시트에 복사했습니다.'
            : '선택한 기준 열이 같은 행을 자동 통합했습니다. 다른 값은 줄바꿈 합집합으로 보존하고, 열이 달라도 같은 값은 한 번만 남겼으며, 통합 전 원본 행을 CMOE 원본 보존 시트에 복사했습니다.';
        auditRows.push([analysis.name, resultLabel, analysis.criteriaColumnIndexes.map(columnLetter).join('+'), group.rowNumbers.join(', '), String(targetRowNumber), removed.join(', '), group.conflictColumnIndexes.length, description]);
      }
    } else {
      rowsToRemove = analysis.duplicateRows.slice();
      automaticGroupCount = analysis.duplicateGroupCount;
      auditRows.push([analysis.name, '자동 정리', '행 전체', '', '', rowsToRemove.join(', '), 0, '모든 셀 내용과 수식이 같은 행만 자동으로 정리했습니다.']);
    }
    rowsToRemove = [...new Set(rowsToRemove)].sort((left, right) => right - left);
    for (const rowNumber of rowsToRemove) sheet.spliceRows(rowNumber, 1);
    results.push({
      index, name: analysis.name, beforeRowCount: analysis.rowCount, removedRowCount: rowsToRemove.length,
      afterRowCount: Math.max(0, analysis.rowCount - rowsToRemove.length), criteriaMode: analysis.criteriaMode,
      criteriaColumnIndexes: analysis.criteriaColumnIndexes.slice(), mergedCellCount, conflictCellCount,
      automaticGroupCount, approvedGroupCount, skippedGroupCount, skippedDuplicateRowCount
    });
  }

  const auditSheetName = uniqueWorksheetName(loaded.workbook, 'CMOE 처리 기록');
  const auditSheet = loaded.workbook.addWorksheet(auditSheetName);
  auditSheet.addRow(['원본 시트', '처리 결과', '비교 기준', '원본 행', '대표 행', '정리된 행', '충돌 열 수', '설명']);
  for (const row of auditRows) auditSheet.addRow(row);
  auditSheet.getRow(1).font = { bold: true }; auditSheet.views = [{ state: 'frozen', ySplit: 1 }];
  [24, 18, 14, 24, 12, 24, 12, 54].forEach((width, offset) => { auditSheet.getColumn(offset + 1).width = width; });
  let preservationSheetName = '';
  if (preservedRows.length) {
    preservationSheetName = uniqueWorksheetName(loaded.workbook, 'CMOE 원본 보존');
    const preservation = loaded.workbook.addWorksheet(preservationSheetName);
    const maximumColumns = preservedRows.reduce((maximum, row) => Math.max(maximum, row.values.length), 0);
    preservation.addRow(['원본 시트', '원본 행', '후보 ID', ...Array.from({ length: maximumColumns }, (_, offset) => `열 ${columnLetter(offset + 1)}`)]);
    for (const row of preservedRows) preservation.addRow([row.sheetName, row.rowNumber, row.groupId, ...row.values]);
    preservation.getRow(1).font = { bold: true }; preservation.views = [{ state: 'frozen', ySplit: 1 }]; preservation.state = 'hidden';
  }
  loaded.workbook.calcProperties.fullCalcOnLoad = true;
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.parse(outputPath).name}.partial-${crypto.randomUUID()}.xlsx`); let published = false;
  try {
    await loaded.workbook.xlsx.writeFile(temporaryPath); options.throwIfCancelled?.();
    const verified = await loadXlsxWorkbookSafely(temporaryPath);
    const verifiedAnalyses = verified.workbook.worksheets.map((sheet, index) => analyzeWorksheet(sheet, index, {
      columnIndexes: Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index))
        ? (columnIndexesBySheet[index] || columnIndexesBySheet[String(index)]) : undefined,
      headerRow: Object.hasOwn(headerRowsBySheet, index) || Object.hasOwn(headerRowsBySheet, String(index)) ? Number(headerRowsBySheet[index] ?? headerRowsBySheet[String(index)]) : undefined,
      normalizeText: Object.hasOwn(columnIndexesBySheet, index) || Object.hasOwn(columnIndexesBySheet, String(index))
    }));
    for (const index of selected) {
      const result = results.find((item) => item.index === index);
      const expectedRemaining = result?.criteriaMode === 'columns' ? Number(result.skippedDuplicateRowCount) || 0 : 0;
      if (verifiedAnalyses[index].duplicateRowCount !== expectedRemaining) throw excelDeduplicateError('EXCEL_DEDUPLICATE_VERIFY_FAILED', `${analyses[index].name} 시트의 안전 정리 결과를 확인하지 못했습니다.`);
    }
    if (!verified.workbook.getWorksheet(auditSheetName) || (preservationSheetName && !verified.workbook.getWorksheet(preservationSheetName))) {
      throw excelDeduplicateError('EXCEL_DEDUPLICATE_VERIFY_FAILED', '처리 기록과 원본 보존 시트를 확인하지 못했습니다.');
    }
    await fs.promises.copyFile(temporaryPath, outputPath, fs.constants.COPYFILE_EXCL); published = true;
    const stats = await fs.promises.stat(outputPath);
    return {
      outputPath, outputName: path.basename(outputPath), outputBytes: stats.size, sheetCount: analyses.length,
      outputSheetCount: verifiedAnalyses.length,
      selectedSheetCount: selected.length, removedRowCount: results.reduce((sum, result) => sum + result.removedRowCount, 0),
      skippedGroupCount: results.reduce((sum, result) => sum + result.skippedGroupCount, 0),
      skippedDuplicateRowCount: results.reduce((sum, result) => sum + result.skippedDuplicateRowCount, 0),
      approvedGroupCount: results.reduce((sum, result) => sum + result.approvedGroupCount, 0),
      automaticGroupCount: results.reduce((sum, result) => sum + result.automaticGroupCount, 0),
      preservedRowCount: preservedRows.length, auditSheetName, preservationSheetName,
      sheets: results, engine: 'cmoe-internal-excel', contentVerified: true, requiresPreview: true
    };
  } catch (error) {
    if (published) await fs.promises.unlink(outputPath).catch(() => {});
    if (String(error?.code || '').startsWith('EXCEL_DEDUPLICATE_')) throw error;
    throw excelDeduplicateError('EXCEL_DEDUPLICATE_FAILED', error?.message || 'Excel 중복 행을 제거하지 못했습니다.', error);
  } finally { await fs.promises.unlink(temporaryPath).catch(() => {}); }
}

module.exports = { HIGH_RISK_FEATURES, excelDeduplicateError, canonicalValue, normalizedMatchValue, columnLetter, normalizeColumnIndexes, rowFingerprint, detectHeaderRow, analyzeWorksheet, collectDuplicateGroups, analyzeExcelDuplicates, analyzeExcelDuplicateReview, deduplicateExcelWorkbook };
