'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('../vendor/node_modules/exceljs');
const { loadXlsxWorkbookSafely } = require('./spreadsheet');
const { columnLetter } = require('./excel-deduplicate');

const MAX_COMPARE_ROWS = 500000;
const MAX_RULES = 100;
const RESERVED_GROUP_NAMES = new Set(['기타', '중복 확인', '미매칭 a', '미매칭 b', '결과 없음']);

function compareError(code, message, cause) {
  const error = new Error(message); error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function cellText(cell) {
  return String(cell?.text ?? '').trim();
}

function detectHeaderRow(sheet) {
  const limit = Math.min(Math.max(1, Number(sheet.rowCount) || 1), 50);
  let best = { row: 1, score: -1, populated: 0 };
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber); let populated = 0; let textCells = 0; const unique = new Set();
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = cellText(cell); if (!text) return;
      populated += 1; unique.add(text.toLocaleLowerCase('ko-KR'));
      if (typeof cell.value === 'string') textCells += 1;
    });
    const score = populated * 20 + textCells * 3 + unique.size;
    if (populated && (score > best.score || (score === best.score && rowNumber < best.row))) best = { row: rowNumber, score, populated };
  }
  return best.row;
}

function sheetColumns(sheet, headerRow) {
  const populated = new Set();
  sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (_cell, column) => populated.add(column)));
  return [...populated].sort((left, right) => left - right).map((index) => {
    const letter = columnLetter(index); const header = cellText(sheet.getRow(headerRow).getCell(index)).slice(0, 100);
    return { index, letter, label: header || `열 ${letter}` };
  });
}

function headerCandidates(sheet, detectedRow, baseColumns = sheetColumns(sheet, detectedRow)) {
  const rows = [];
  for (let rowNumber = 1; rowNumber <= Math.min(20, Math.max(1, Number(sheet.rowCount) || 1)); rowNumber += 1) {
    const preview = []; sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, column) => {
      const text = cellText(cell); if (text && preview.length < 4) preview.push(`${columnLetter(column)} ${text.slice(0, 24)}`);
    });
    if (preview.length) rows.push({
      row: rowNumber, label: `${rowNumber}행 · ${preview.join(' · ')}`,
      columns: baseColumns.map((column) => ({ ...column, label: cellText(sheet.getRow(rowNumber).getCell(column.index)).slice(0, 100) || `열 ${column.letter}` }))
    });
  }
  if (!rows.some((item) => item.row === detectedRow)) rows.push({ row: detectedRow, label: `${detectedRow}행`, columns: baseColumns });
  return rows.sort((left, right) => left.row - right.row);
}

function inspectWorkbook(loaded) {
  const sheets = loaded.workbook.worksheets.map((sheet, index) => {
    const headerRow = detectHeaderRow(sheet); const columns = sheetColumns(sheet, headerRow);
    return {
      index, name: String(sheet.name || `시트 ${index + 1}`).slice(0, 31),
      visibility: ['visible', 'hidden', 'veryHidden'].includes(sheet.state) ? sheet.state : 'visible',
      rowCount: Math.max(0, Number(sheet.rowCount) || 0), headerRow,
      columns, headerCandidates: headerCandidates(sheet, headerRow, columns)
    };
  });
  return { sourcePath: loaded.sourcePath, sourceBytes: loaded.sourceBytes, sourceSha256: loaded.sourceSha256, sheetCount: sheets.length, sheets };
}

async function inspectExcelCompareFile(filePath) {
  try { return inspectWorkbook(await loadXlsxWorkbookSafely(filePath)); }
  catch (error) { throw compareError(error?.code || 'EXCEL_COMPARE_INPUT_INVALID', error?.message || 'Excel 파일을 분석하지 못했습니다.', error); }
}

function normalizeSelection(workbook, raw, side) {
  const sheetIndex = Number(raw?.sheetIndex); const headerRow = Number(raw?.headerRow); const keyColumn = Number(raw?.keyColumn);
  const sheet = workbook.worksheets[sheetIndex];
  if (!Number.isInteger(sheetIndex) || !sheet) throw compareError('EXCEL_COMPARE_SHEET_INVALID', `${side} 파일에서 비교할 시트를 선택해주세요.`);
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > Math.max(1, Number(sheet.rowCount) || 1)) throw compareError('EXCEL_COMPARE_HEADER_INVALID', `${side} 파일의 열 이름 행을 확인해주세요.`);
  if (!Number.isInteger(keyColumn) || keyColumn < 1 || keyColumn > Math.max(1, Number(sheet.columnCount) || 0)) throw compareError('EXCEL_COMPARE_KEY_COLUMN_INVALID', `${side} 파일에서 사람을 비교할 열을 선택해주세요.`);
  const columns = sheetColumns(sheet, headerRow);
  if (!columns.some((column) => column.index === keyColumn)) throw compareError('EXCEL_COMPARE_KEY_COLUMN_INVALID', `${side} 파일의 비교 열에 데이터가 없습니다.`);
  return { side, sheetIndex, sheet, headerRow, keyColumn, columns };
}

function normalizeRules(rules, left, right) {
  if (!Array.isArray(rules) || !rules.length || rules.length > MAX_RULES) throw compareError('EXCEL_COMPARE_RULE_INVALID', '분류 규칙을 하나 이상 입력해주세요.');
  const groupNames = new Map();
  return rules.map((raw, index) => {
    const source = ['key', 'a', 'b'].includes(raw?.source) ? raw.source : '';
    const contains = String(raw?.contains || '').trim(); const groupName = String(raw?.groupName || '').trim();
    const columnIndex = source === 'key' ? 0 : Number(raw?.columnIndex);
    const selection = source === 'a' ? left : source === 'b' ? right : null;
    if (!source || !contains || !groupName) throw compareError('EXCEL_COMPARE_RULE_INVALID', `${index + 1}번째 분류 규칙의 찾을 문자와 그룹 이름을 입력해주세요.`);
    if (selection && (!Number.isInteger(columnIndex) || !selection.columns.some((column) => column.index === columnIndex))) throw compareError('EXCEL_COMPARE_RULE_COLUMN_INVALID', `${index + 1}번째 규칙의 확인할 열을 선택해주세요.`);
    const normalizedGroup = groupName.toLocaleLowerCase('ko-KR');
    if (RESERVED_GROUP_NAMES.has(normalizedGroup)) throw compareError('EXCEL_COMPARE_RULE_GROUP_RESERVED', `“${groupName}”은 자동 결과 시트 이름입니다. 다른 그룹 이름을 입력해주세요.`);
    if (!groupNames.has(normalizedGroup)) groupNames.set(normalizedGroup, groupName);
    return { source, columnIndex, contains, normalizedContains: contains.toLocaleLowerCase('ko-KR'), groupName: groupNames.get(normalizedGroup) };
  });
}

function normalizeKey(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US');
}

function collectRecords(selection) {
  const records = []; const byKey = new Map();
  for (let rowNumber = selection.headerRow + 1; rowNumber <= selection.sheet.rowCount; rowNumber += 1) {
    const row = selection.sheet.getRow(rowNumber); const values = selection.columns.map((column) => cellText(row.getCell(column.index)));
    if (!values.some(Boolean)) continue;
    const rawKey = cellText(row.getCell(selection.keyColumn)); const key = normalizeKey(rawKey);
    const record = { side: selection.side, rowNumber, rawKey, key, values, row };
    records.push(record);
    if (key) { const group = byKey.get(key) || []; group.push(record); byKey.set(key, group); }
  }
  return { records, byKey };
}

function ruleValue(rule, pair, left, right) {
  if (rule.source === 'key') return pair.a.rawKey || pair.b.rawKey;
  const record = rule.source === 'a' ? pair.a : pair.b; const selection = rule.source === 'a' ? left : right;
  const offset = selection.columns.findIndex((column) => column.index === rule.columnIndex);
  return offset >= 0 ? record.values[offset] : '';
}

function buildComparePlanFromLoaded(leftLoaded, rightLoaded, options = {}) {
  const left = normalizeSelection(leftLoaded.workbook, options.left, 'A'); const right = normalizeSelection(rightLoaded.workbook, options.right, 'B');
  const rules = normalizeRules(options.rules, left, right); const leftRecords = collectRecords(left); const rightRecords = collectRecords(right);
  if (leftRecords.records.length + rightRecords.records.length > MAX_COMPARE_ROWS) throw compareError('EXCEL_COMPARE_ROW_LIMIT', `비교할 데이터가 ${MAX_COMPARE_ROWS.toLocaleString('ko-KR')}행을 넘습니다.`);
  const matched = []; const ambiguous = []; const unmatchedA = []; const unmatchedB = []; const usedKeys = new Set();
  for (const [key, aRows] of leftRecords.byKey) {
    const bRows = rightRecords.byKey.get(key) || []; usedKeys.add(key);
    if (!bRows.length) { unmatchedA.push(...aRows); continue; }
    if (aRows.length !== 1 || bRows.length !== 1) { ambiguous.push(...aRows, ...bRows); continue; }
    matched.push({ key, a: aRows[0], b: bRows[0] });
  }
  for (const [key, bRows] of rightRecords.byKey) if (!usedKeys.has(key)) unmatchedB.push(...bRows);
  unmatchedA.push(...leftRecords.records.filter((record) => !record.key));
  unmatchedB.push(...rightRecords.records.filter((record) => !record.key));
  const groups = new Map(); rules.forEach((rule) => { if (!groups.has(rule.groupName)) groups.set(rule.groupName, []); }); const other = [];
  for (const pair of matched) {
    const rule = rules.find((candidate) => ruleValue(candidate, pair, left, right).toLocaleLowerCase('ko-KR').includes(candidate.normalizedContains));
    if (rule) groups.get(rule.groupName).push(pair); else other.push(pair);
  }
  return {
    left, right, rules, groups, other, ambiguous, unmatchedA, unmatchedB,
    matchedCount: matched.length, classifiedCount: matched.length - other.length,
    groupCounts: [...groups].map(([name, pairs]) => ({ name, count: pairs.length })),
    warnings: [
      ...(ambiguous.length ? ['같은 비교값이 한 파일에 여러 번 있는 행은 잘못 연결하지 않고 “중복 확인” 시트로 분리합니다.'] : []),
      '여러 규칙에 동시에 해당하면 위에 있는 첫 번째 규칙을 적용합니다.'
    ]
  };
}

async function analyzeExcelCompareGroups(leftPath, rightPath, options = {}) {
  const leftLoaded = await loadXlsxWorkbookSafely(leftPath); const rightLoaded = await loadXlsxWorkbookSafely(rightPath);
  if (options.expectedLeftSha256 && leftLoaded.sourceSha256 !== options.expectedLeftSha256) throw compareError('EXCEL_COMPARE_INPUT_CHANGED', 'A 파일이 분석 후 바뀌었습니다. 다시 선택해주세요.');
  if (options.expectedRightSha256 && rightLoaded.sourceSha256 !== options.expectedRightSha256) throw compareError('EXCEL_COMPARE_INPUT_CHANGED', 'B 파일이 분석 후 바뀌었습니다. 다시 선택해주세요.');
  const plan = buildComparePlanFromLoaded(leftLoaded, rightLoaded, options);
  return {
    leftSha256: leftLoaded.sourceSha256, rightSha256: rightLoaded.sourceSha256,
    matchedCount: plan.matchedCount, classifiedCount: plan.classifiedCount, otherCount: plan.other.length,
    ambiguousRowCount: plan.ambiguous.length, unmatchedACount: plan.unmatchedA.length, unmatchedBCount: plan.unmatchedB.length,
    groupCounts: plan.groupCounts, warnings: plan.warnings
  };
}

function safeSheetName(name, used) {
  const base = String(name || '그룹').replace(/[\\/*?:\[\]]/g, ' ').replace(/[\x00-\x1f]/g, '').trim().slice(0, 31) || '그룹';
  let candidate = base; let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('ko-KR'))) {
    const tail = ` (${suffix++})`; candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
  }
  used.add(candidate.toLocaleLowerCase('ko-KR')); return candidate;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF217346' } };
  row.alignment = { vertical: 'middle', wrapText: true }; row.height = 26;
}

function addPairSheet(workbook, name, pairs, plan, used) {
  const sheet = workbook.addWorksheet(safeSheetName(name, used));
  const headers = ['비교값', ...plan.left.columns.map((column) => `A · ${column.label}`), ...plan.right.columns.map((column) => `B · ${column.label}`)];
  sheet.addRow(headers); styleHeader(sheet.getRow(1));
  pairs.forEach((pair) => sheet.addRow([pair.a.rawKey || pair.b.rawKey, ...pair.a.values, ...pair.b.values]));
  sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } };
  sheet.columns.forEach((column) => { column.width = Math.min(42, Math.max(12, ...column.values.slice(1, 101).map((value) => String(value || '').length + 2))); });
  return sheet.name;
}

function addSingleSideSheet(workbook, name, records, selection, used, extraHeader = '') {
  const sheet = workbook.addWorksheet(safeSheetName(name, used)); const headers = [...(extraHeader ? [extraHeader] : []), '비교값', ...selection.columns.map((column) => column.label)];
  sheet.addRow(headers); styleHeader(sheet.getRow(1));
  records.forEach((record) => sheet.addRow([...(extraHeader ? [record.side] : []), record.rawKey, ...record.values]));
  sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } };
  sheet.columns.forEach((column) => { column.width = Math.min(42, Math.max(12, ...column.values.slice(1, 101).map((value) => String(value || '').length + 2))); });
  return sheet.name;
}

async function compareAndGroupExcelFiles(leftPath, rightPath, outputPath, options = {}) {
  const leftLoaded = await loadXlsxWorkbookSafely(leftPath); const rightLoaded = await loadXlsxWorkbookSafely(rightPath);
  if (options.expectedLeftSha256 && leftLoaded.sourceSha256 !== options.expectedLeftSha256) throw compareError('EXCEL_COMPARE_INPUT_CHANGED', 'A 파일이 분석 후 바뀌었습니다. 다시 선택해주세요.');
  if (options.expectedRightSha256 && rightLoaded.sourceSha256 !== options.expectedRightSha256) throw compareError('EXCEL_COMPARE_INPUT_CHANGED', 'B 파일이 분석 후 바뀌었습니다. 다시 선택해주세요.');
  const plan = buildComparePlanFromLoaded(leftLoaded, rightLoaded, options); const output = new ExcelJS.Workbook(); const used = new Set(); const sheetResults = [];
  for (const [groupName, pairs] of plan.groups) {
    if (!pairs.length) continue;
    sheetResults.push({ kind: 'group', requestedName: groupName, name: addPairSheet(output, groupName, pairs, plan, used), rowCount: pairs.length });
  }
  if (plan.other.length) sheetResults.push({ kind: 'other', name: addPairSheet(output, '기타', plan.other, plan, used), rowCount: plan.other.length });
  if (plan.ambiguous.length) {
    const sheet = output.addWorksheet(safeSheetName('중복 확인', used)); const maxColumns = Math.max(plan.left.columns.length, plan.right.columns.length);
    sheet.addRow(['파일', '비교값', ...Array.from({ length: maxColumns }, (_, index) => `원본 열 ${index + 1}`)]); styleHeader(sheet.getRow(1));
    plan.ambiguous.forEach((record) => sheet.addRow([record.side, record.rawKey, ...record.values])); sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheetResults.push({ kind: 'ambiguous', name: sheet.name, rowCount: plan.ambiguous.length });
  }
  if (plan.unmatchedA.length) sheetResults.push({ kind: 'unmatchedA', name: addSingleSideSheet(output, '미매칭 A', plan.unmatchedA, plan.left, used), rowCount: plan.unmatchedA.length });
  if (plan.unmatchedB.length) sheetResults.push({ kind: 'unmatchedB', name: addSingleSideSheet(output, '미매칭 B', plan.unmatchedB, plan.right, used), rowCount: plan.unmatchedB.length });
  if (!output.worksheets.length) { const sheet = output.addWorksheet('결과 없음'); sheet.addRow(['두 파일에서 비교·분류할 행을 찾지 못했습니다.']); }
  output.creator = 'CMOE Workspace'; output.created = new Date(); output.calcProperties.fullCalcOnLoad = true;
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.parse(outputPath).name}.partial-${crypto.randomUUID()}.xlsx`); let published = false;
  try {
    await output.xlsx.writeFile(temporaryPath); options.throwIfCancelled?.();
    const verified = await loadXlsxWorkbookSafely(temporaryPath);
    if (verified.workbook.worksheets.length !== output.worksheets.length) throw compareError('EXCEL_COMPARE_VERIFY_FAILED', '결과 시트 수를 다시 확인하지 못했습니다.');
    await fs.promises.copyFile(temporaryPath, outputPath, fs.constants.COPYFILE_EXCL); published = true; const stats = await fs.promises.stat(outputPath);
    return {
      outputPath, outputName: path.basename(outputPath), outputBytes: stats.size, sheetCount: verified.workbook.worksheets.length,
      matchedCount: plan.matchedCount, classifiedCount: plan.classifiedCount, otherCount: plan.other.length,
      ambiguousRowCount: plan.ambiguous.length, unmatchedACount: plan.unmatchedA.length, unmatchedBCount: plan.unmatchedB.length,
      sheets: sheetResults, warnings: plan.warnings, engine: 'cmoe-internal-excel', contentVerified: true, requiresPreview: true
    };
  } catch (error) {
    if (published) await fs.promises.unlink(outputPath).catch(() => {});
    if (String(error?.code || '').startsWith('EXCEL_COMPARE_')) throw error;
    throw compareError('EXCEL_COMPARE_FAILED', error?.message || 'Excel 명단 비교·분류 파일을 만들지 못했습니다.', error);
  } finally { await fs.promises.unlink(temporaryPath).catch(() => {}); }
}

module.exports = { MAX_COMPARE_ROWS, MAX_RULES, RESERVED_GROUP_NAMES, compareError, cellText, detectHeaderRow, sheetColumns, headerCandidates, inspectExcelCompareFile, normalizeKey, buildComparePlanFromLoaded, analyzeExcelCompareGroups, compareAndGroupExcelFiles };
