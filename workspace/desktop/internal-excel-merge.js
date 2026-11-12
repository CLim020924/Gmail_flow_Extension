'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NativeOfficeMerge = require('./native-office-merge');
const { loadXlsxWorkbookSafely } = require('./spreadsheet');

const MAX_INTERNAL_FILES = 500;
const MAX_INTERNAL_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_INTERNAL_WORKSHEETS = 200;
const MAX_INTERNAL_CELLS = 1_000_000;
const MAX_EXCEL_ROWS = 1_048_576;
const DEFAULT_COMBINED_SHEET_NAME = '전체 통합';

const LOADER_ERROR_CODES = Object.freeze({
  XLSX_IMPORT_FORMAT_INVALID: 'INTERNAL_EXCEL_INPUT_FORMAT_INVALID',
  XLSX_IMPORT_FILE_TOO_LARGE: 'INTERNAL_EXCEL_INPUT_TOO_LARGE',
  XLSX_IMPORT_FILE_UNREADABLE: 'INTERNAL_EXCEL_INPUT_UNREADABLE',
  XLSX_IMPORT_INPUT_CHANGED: 'INTERNAL_EXCEL_INPUT_CHANGED',
  XLSX_IMPORT_ARCHIVE_INVALID: 'INTERNAL_EXCEL_ARCHIVE_INVALID',
  XLSX_IMPORT_ARCHIVE_LIMIT_EXCEEDED: 'INTERNAL_EXCEL_ARCHIVE_LIMIT_EXCEEDED',
  XLSX_IMPORT_ARCHIVE_PATH_INVALID: 'INTERNAL_EXCEL_ARCHIVE_PATH_INVALID',
  XLSX_IMPORT_ENCRYPTED: 'INTERNAL_EXCEL_ENCRYPTED_UNSUPPORTED',
  XLSX_IMPORT_MACRO_REJECTED: 'INTERNAL_EXCEL_MACRO_REJECTED',
  XLSX_IMPORT_SIGNATURE_REJECTED: 'INTERNAL_EXCEL_SIGNATURE_REJECTED',
  XLSX_IMPORT_PROTECTED_REJECTED: 'INTERNAL_EXCEL_PROTECTED_REJECTED',
  XLSX_IMPORT_WORKBOOK_INVALID: 'INTERNAL_EXCEL_WORKBOOK_OPEN_FAILED',
  XLSX_IMPORT_WORKSHEET_MISSING: 'INTERNAL_EXCEL_WORKSHEET_MISSING',
  XLSX_IMPORT_WORKSHEET_LIMIT_EXCEEDED: 'INTERNAL_EXCEL_WORKSHEET_LIMIT_EXCEEDED',
  XLSX_IMPORT_ROW_LIMIT_EXCEEDED: 'INTERNAL_EXCEL_ROW_LIMIT_EXCEEDED',
  XLSX_IMPORT_COLUMN_LIMIT_EXCEEDED: 'INTERNAL_EXCEL_COLUMN_LIMIT_EXCEEDED',
  XLSX_IMPORT_CELL_LIMIT_EXCEEDED: 'INTERNAL_EXCEL_CELL_LIMIT_EXCEEDED'
});

function internalExcelError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function asInternalExcelError(error, defaultCode = 'INTERNAL_EXCEL_WORKBOOK_OPEN_FAILED') {
  if (String(error?.code || '').startsWith('INTERNAL_EXCEL_') || error?.code === 'DOCUMENT_TOOL_CANCELLED') return error;
  const code = LOADER_ERROR_CODES[String(error?.code || '')] || defaultCode;
  return internalExcelError(code, String(error?.message || '프로그램 내부 Excel 엔진이 파일을 읽지 못했습니다.'), error);
}

function featureWarnings(features = {}) {
  const warnings = [];
  if (Number(features.formulas) > 0) warnings.push('수식은 현재 파일에 저장된 계산 결과 값으로 고정되며 라이브 수식은 제외됩니다.');
  if (Number(features.charts) > 0) warnings.push('차트는 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.pivots) > 0) warnings.push('피벗 테이블과 피벗 캐시는 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.externalLinks) > 0) warnings.push('외부 통합문서 연결과 데이터 연결은 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.tables) > 0) warnings.push('Excel 표 기능은 일반 셀과 서식으로만 복사되며 표 필터·구조 참조는 제외됩니다.');
  if (Number(features.drawings) > Number(features.charts || 0)) warnings.push('그림과 도형은 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.dataValidations) > 0) warnings.push('드롭다운 등 셀 입력 규칙은 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.conditionalFormatting) > 0) warnings.push('조건부 서식은 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.definedNames) > 0) warnings.push('이름 정의와 이름 범위는 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.comments) > 0) warnings.push('셀 메모와 댓글은 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (Number(features.hyperlinks) > 0) warnings.push('외부 하이퍼링크는 텍스트만 남기고 연결 기능은 제외했습니다.');
  return warnings;
}

async function inspectInternalExcelWorkbook(filePath) {
  let loaded;
  try {
    loaded = await loadXlsxWorkbookSafely(filePath);
  } catch (error) {
    throw asInternalExcelError(error);
  }
  const sheets = loaded.worksheets.map((sheet, index) => ({
    index,
    name: sheet.name,
    type: 'worksheet',
    visibility: sheet.visibility,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    cellCount: sheet.cellCount
  }));
  return {
    sourceBytes: loaded.sourceBytes,
    sourceSha256: loaded.sourceSha256,
    sheetCount: sheets.length,
    worksheetCount: sheets.length,
    sheets,
    worksheets: sheets,
    sheetNames: sheets.map((sheet) => sheet.name),
    worksheetNames: sheets.map((sheet) => sheet.name),
    sheetVisibility: sheets.map((sheet) => sheet.visibility),
    worksheetVisibility: sheets.map((sheet) => sheet.visibility),
    totalCellCount: loaded.totalCellCount,
    features: { ...loaded.packageFeatures },
    warnings: featureWarnings(loaded.packageFeatures),
    structureInspectionEngine: 'internal-exceljs',
    inspectionEngine: 'cmoe-internal-excel',
    internalFallbackRequired: true,
    internalForceCompatible: true,
    requiresPreview: true
  };
}

function cloneValue(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof DataView) {
    const copied = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return new DataView(copied);
  }
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (seen.has(value)) return seen.get(value);
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    output[key] = cloneValue(value[key], seen);
  }
  return output;
}

function formulaSnapshotValue(value, warningKeys) {
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return cloneValue(value);
  if (Object.hasOwn(value, 'formula') || Object.hasOwn(value, 'sharedFormula')) {
    warningKeys.add('formula-snapshot');
    if (!Object.hasOwn(value, 'result') || value.result === undefined) {
      warningKeys.add('formula-result-missing');
      return null;
    }
    return cloneValue(value.result);
  }
  if (Object.hasOwn(value, 'hyperlink')) {
    warningKeys.add('hyperlinks-removed');
    return String(value.text || value.hyperlink || '');
  }
  return cloneValue(value);
}

function addWarningMessages(warningKeys, warnings) {
  if (warningKeys.has('formula-snapshot')) warnings.add('수식은 현재 파일에 저장된 계산 결과 값으로 고정되며 라이브 수식은 제외됩니다.');
  if (warningKeys.has('formula-result-missing')) warnings.add('저장된 계산 결과가 없는 수식 셀은 빈 셀로 처리되었습니다. 결과 파일을 반드시 미리 확인해주세요.');
  if (warningKeys.has('hyperlinks-removed')) warnings.add('외부 하이퍼링크는 텍스트만 남기고 연결 기능은 제외했습니다.');
  if (warningKeys.has('comments-removed')) warnings.add('셀 메모와 댓글은 프로그램 내부 강제 병합 결과에서 제외됩니다.');
  if (warningKeys.has('combined-merge-skipped')) warnings.add('통합 시트에서 헤더와 데이터 행을 가로지르는 병합 셀은 병합 상태를 유지하지 못했습니다.');
}

function checkCancelled(options = {}) {
  try {
    options.throwIfCancelled?.();
  } catch (error) {
    if (!error.code) error.code = 'DOCUMENT_TOOL_CANCELLED';
    throw error;
  }
  if (options.isCancelled?.()) {
    throw internalExcelError('DOCUMENT_TOOL_CANCELLED', 'Excel 합치기를 중단했습니다.');
  }
}

function copyRow(sourceRow, targetRow, warningKeys, options = {}) {
  if (sourceRow.height != null) targetRow.height = sourceRow.height;
  targetRow.hidden = sourceRow.hidden === true;
  targetRow.outlineLevel = Math.max(0, Number(sourceRow.outlineLevel) || 0);
  if (sourceRow.style && Object.keys(sourceRow.style).length) targetRow.style = cloneValue(sourceRow.style);
  const maximumColumn = Math.max(0, Number(sourceRow.cellCount) || 0);
  for (let columnNumber = 1; columnNumber <= maximumColumn; columnNumber += 1) {
    const sourceCell = sourceRow.getCell(columnNumber);
    const targetCell = targetRow.getCell(columnNumber);
    targetCell.value = formulaSnapshotValue(sourceCell.value, warningKeys);
    if (sourceCell.hasStyle || (sourceCell.style && Object.keys(sourceCell.style).length)) {
      targetCell.style = cloneValue(sourceCell.style);
    }
    if (sourceCell.note != null) warningKeys.add('comments-removed');
    options.onCell?.();
  }
}

function copyColumns(source, target) {
  const maximumColumn = Math.max(0, Number(source.columnCount) || 0);
  for (let columnNumber = 1; columnNumber <= maximumColumn; columnNumber += 1) {
    const sourceColumn = source.getColumn(columnNumber);
    const targetColumn = target.getColumn(columnNumber);
    if (Number.isFinite(sourceColumn.width) && sourceColumn.width > 0) targetColumn.width = sourceColumn.width;
    targetColumn.hidden = sourceColumn.hidden === true;
    targetColumn.outlineLevel = Math.max(0, Number(sourceColumn.outlineLevel) || 0);
    if (sourceColumn.style && Object.keys(sourceColumn.style).length) targetColumn.style = cloneValue(sourceColumn.style);
  }
}

function sheetMerges(source) {
  return Array.isArray(source?.model?.merges) ? source.model.merges.map(String) : [];
}

function parseMergeRange(range) {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(String(range || ''));
  if (!match) return null;
  return {
    startColumn: match[1].toUpperCase(),
    startRow: Number(match[2]),
    endColumn: match[3].toUpperCase(),
    endRow: Number(match[4])
  };
}

function mappedMergeRange(range, sourceStartRow, sourceEndRow, targetStartRow) {
  const parsed = parseMergeRange(range);
  if (!parsed || parsed.startRow < sourceStartRow || parsed.endRow > sourceEndRow) return null;
  const first = targetStartRow + parsed.startRow - sourceStartRow;
  const last = targetStartRow + parsed.endRow - sourceStartRow;
  return `${parsed.startColumn}${first}:${parsed.endColumn}${last}`;
}

function copyWorksheet(source, target, warningKeys, options = {}) {
  Object.assign(target.properties, cloneValue(source.properties || {}));
  target.views = cloneValue(source.views || []);
  target.pageSetup = cloneValue(source.pageSetup || {});
  if (source.pageMargins != null) target.pageMargins = cloneValue(source.pageMargins);
  target.headerFooter = cloneValue(source.headerFooter || {});
  target.state = ['visible', 'hidden', 'veryHidden'].includes(source.state) ? source.state : 'visible';
  if (source.autoFilter) target.autoFilter = cloneValue(source.autoFilter);
  copyColumns(source, target);
  let touched = 0;
  for (let rowNumber = 1; rowNumber <= source.rowCount; rowNumber += 1) {
    if (rowNumber % 2048 === 0) checkCancelled(options);
    copyRow(source.getRow(rowNumber), target.getRow(rowNumber), warningKeys, {
      onCell: () => {
        touched += 1;
        if (touched % 2048 === 0) checkCancelled(options);
      }
    });
  }
  for (const range of sheetMerges(source)) target.mergeCells(range);
}

function comparableHeader(sheet, warningKeys) {
  const columnCount = Math.max(0, Number(sheet.columnCount) || 0);
  const values = [];
  for (let column = 1; column <= columnCount; column += 1) {
    const value = formulaSnapshotValue(sheet.getCell(1, column).value, warningKeys);
    if (value == null) values.push('');
    else if (value instanceof Date) values.push(value.toISOString());
    else if (typeof value === 'object' && Array.isArray(value.richText)) {
      values.push(value.richText.map((part) => String(part?.text || '')).join('').trim());
    } else if (typeof value === 'object' && value.text != null) values.push(String(value.text).trim());
    else if (typeof value === 'object') values.push(JSON.stringify(canonicalValue(value)));
    else values.push(String(value).trim());
  }
  while (values.length && !values.at(-1)) values.pop();
  return { columnCount, values };
}

function copyCombinedRows(source, target, targetStartRow, sourceStartRow, warningKeys, options = {}) {
  if (sourceStartRow > source.rowCount) return targetStartRow;
  const sourceEndRow = source.rowCount;
  let targetRowNumber = targetStartRow;
  for (let sourceRowNumber = sourceStartRow; sourceRowNumber <= sourceEndRow; sourceRowNumber += 1) {
    if ((sourceRowNumber - sourceStartRow) % 2048 === 0) checkCancelled(options);
    copyRow(source.getRow(sourceRowNumber), target.getRow(targetRowNumber), warningKeys, {
      onCell: () => {
        if ((sourceRowNumber + targetRowNumber) % 2048 === 0) checkCancelled(options);
      }
    });
    targetRowNumber += 1;
  }
  for (const range of sheetMerges(source)) {
    const mapped = mappedMergeRange(range, sourceStartRow, sourceEndRow, targetStartRow);
    if (mapped) target.mergeCells(mapped);
    else if (parseMergeRange(range)?.endRow >= sourceStartRow) warningKeys.add('combined-merge-skipped');
  }
  return targetRowNumber;
}

function createCombinedSheet(output, sourceSheets, name, warningKeys, warnings, options = {}) {
  const totalRows = sourceSheets.reduce((sum, sheet, index) => sum + Math.max(0, sheet.rowCount - (index ? 1 : 0)), 0);
  if (!Number.isSafeInteger(totalRows) || totalRows > MAX_EXCEL_ROWS) {
    throw internalExcelError('INTERNAL_EXCEL_COMBINED_ROW_LIMIT_EXCEEDED', '전체 통합 시트가 Excel 최대 행 수 1,048,576행을 넘어 만들 수 없습니다. 파일을 나눠 합쳐주세요.');
  }
  const target = output.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const baselineHeader = sourceSheets.length ? comparableHeader(sourceSheets[0], warningKeys) : [];
  let headerMismatch = false;
  let nextRow = 1;
  let maximumColumns = 0;
  sourceSheets.forEach((source, index) => {
    checkCancelled(options);
    maximumColumns = Math.max(maximumColumns, Number(source.columnCount) || 0);
    if (index > 0 && JSON.stringify(comparableHeader(source, warningKeys)) !== JSON.stringify(baselineHeader)) headerMismatch = true;
    nextRow = copyCombinedRows(source, target, nextRow, index === 0 ? 1 : 2, warningKeys, options);
    for (let column = 1; column <= source.columnCount; column += 1) {
      const width = source.getColumn(column).width;
      if (Number.isFinite(width) && width > 0) {
        target.getColumn(column).width = Math.max(Number(target.getColumn(column).width) || 0, width);
      }
    }
  });
  if (headerMismatch) warnings.add('시트마다 첫 행 헤더의 이름 또는 열 수가 다르지만 요청에 따라 열 위치 기준으로 강제 통합했습니다. 결과를 반드시 미리 확인해주세요.');
  return {
    sheet: target,
    rowCount: Math.max(0, nextRow - 1),
    columnCount: maximumColumns,
    headerMismatch
  };
}

function canonicalValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'formula' || key === 'sharedFormula') result[key] = String(value[key]);
    else result[key] = canonicalValue(value[key]);
  }
  return result;
}

function worksheetValueDescriptor(sheet) {
  const hash = crypto.createHash('sha256');
  let maximumRow = 0;
  let maximumColumn = 0;
  let formulaCount = 0;
  sheet.eachRow((row, rowNumber) => row.eachCell((cell, columnNumber) => {
    const value = cell.value;
    if (value == null) return;
    maximumRow = Math.max(maximumRow, rowNumber);
    maximumColumn = Math.max(maximumColumn, columnNumber);
    if (typeof value === 'object' && (Object.hasOwn(value, 'formula') || Object.hasOwn(value, 'sharedFormula'))) formulaCount += 1;
    hash.update(`${rowNumber}:${columnNumber}:`);
    hash.update(JSON.stringify(canonicalValue(value)));
    hash.update('\n');
  }));
  return {
    name: sheet.name,
    visibility: ['visible', 'hidden', 'veryHidden'].includes(sheet.state) ? sheet.state : 'visible',
    rowCount: maximumRow,
    columnCount: maximumColumn,
    valueDigest: hash.digest('hex'),
    formulaCount
  };
}

function workbookValueDescriptors(workbook) {
  return workbook.worksheets.map(worksheetValueDescriptor);
}

function assertVerifiedOutput(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual) || actual.some((sheet) => sheet.formulaCount !== 0)) {
    throw internalExcelError('INTERNAL_EXCEL_OUTPUT_VERIFICATION_FAILED', '저장한 Excel 결과의 시트 순서·크기·셀 값이 내부 검증과 일치하지 않아 결과를 저장하지 않았습니다.');
  }
}

async function hashFile(filePath) {
  return crypto.createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex');
}

async function preparePlan(inputPaths, outputPath) {
  if (!Array.isArray(inputPaths) || inputPaths.length < 2 || inputPaths.length > MAX_INTERNAL_FILES) {
    throw internalExcelError('INTERNAL_EXCEL_FILE_COUNT_INVALID', `합칠 XLSX 파일을 2개 이상, ${MAX_INTERNAL_FILES}개 이하로 선택해주세요.`);
  }
  const requestedOutput = path.resolve(String(outputPath || ''));
  if (path.extname(requestedOutput).toLocaleLowerCase('en-US') !== '.xlsx') {
    throw internalExcelError('INTERNAL_EXCEL_OUTPUT_FORMAT_INVALID', '프로그램 내부 Excel 병합 결과는 XLSX 파일로 저장해야 합니다.');
  }
  let outputDirectory;
  try {
    outputDirectory = await fs.promises.realpath(path.dirname(requestedOutput));
    if (!(await fs.promises.stat(outputDirectory)).isDirectory()) throw new Error('not-directory');
  } catch (error) {
    throw internalExcelError('INTERNAL_EXCEL_OUTPUT_DIRECTORY_INVALID', '결과를 저장할 폴더를 찾을 수 없습니다.', error);
  }
  const resolvedOutput = path.join(outputDirectory, path.basename(requestedOutput));
  try {
    await fs.promises.access(resolvedOutput, fs.constants.F_OK);
    throw internalExcelError('INTERNAL_EXCEL_OUTPUT_EXISTS', `${path.basename(resolvedOutput)} 파일이 이미 있습니다. 다른 이름을 사용해주세요.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const outputKey = resolvedOutput.toLocaleLowerCase('en-US');
  const sources = [];
  let totalBytes = 0;
  for (const value of inputPaths) {
    const requested = path.resolve(String(value || ''));
    if (path.extname(requested).toLocaleLowerCase('en-US') !== '.xlsx') {
      throw internalExcelError('INTERNAL_EXCEL_INPUT_FORMAT_INVALID', '프로그램 내부 강제 병합은 XLSX 파일만 사용할 수 있습니다.');
    }
    let sourcePath;
    try { sourcePath = await fs.promises.realpath(requested); }
    catch (error) { throw internalExcelError('INTERNAL_EXCEL_INPUT_UNREADABLE', `${path.basename(requested)} 파일을 찾거나 읽을 수 없습니다.`, error); }
    if (sourcePath.toLocaleLowerCase('en-US') === outputKey) {
      throw internalExcelError('INTERNAL_EXCEL_OUTPUT_EQUALS_INPUT', '원본 파일과 같은 위치에는 병합 결과를 저장할 수 없습니다.');
    }
    sources.push(sourcePath);
  }
  return { outputPath: resolvedOutput, sources, totalBytes };
}

async function publishExclusive(tempPath, outputPath) {
  try {
    await fs.promises.link(tempPath, outputPath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw internalExcelError('INTERNAL_EXCEL_OUTPUT_EXISTS', `${path.basename(outputPath)} 파일이 이미 있습니다. 다른 이름을 사용해주세요.`, error);
    try {
      await fs.promises.copyFile(tempPath, outputPath, fs.constants.COPYFILE_EXCL);
    } catch (copyError) {
      if (copyError?.code !== 'EEXIST') await fs.promises.unlink(outputPath).catch(() => {});
      if (copyError?.code === 'EEXIST') {
        throw internalExcelError('INTERNAL_EXCEL_OUTPUT_EXISTS', `${path.basename(outputPath)} 파일이 이미 있습니다. 다른 이름을 사용해주세요.`, copyError);
      }
      throw internalExcelError('INTERNAL_EXCEL_OUTPUT_PUBLISH_FAILED', '검증을 마친 Excel 결과를 선택한 위치에 저장하지 못했습니다.', copyError);
    }
  }
}

async function mergeExcelFilesInternally(inputPaths, outputPath, options = {}) {
  const plan = await preparePlan(inputPaths, outputPath);
  const tempPath = path.join(path.dirname(plan.outputPath), `.${path.basename(plan.outputPath)}.${crypto.randomUUID()}.tmp.xlsx`);
  const loadedSources = [];
  const warnings = new Set();
  const warningKeys = new Set();
  let published = false;
  try {
    let totalBytes = 0;
    let totalCells = 0;
    let totalSheets = 0;
    for (let index = 0; index < plan.sources.length; index += 1) {
      checkCancelled(options);
      let loaded;
      try { loaded = await loadXlsxWorkbookSafely(plan.sources[index]); }
      catch (error) { throw asInternalExcelError(error); }
      totalBytes += loaded.sourceBytes;
      totalCells += loaded.totalCellCount;
      totalSheets += loaded.worksheets.length;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_INTERNAL_TOTAL_BYTES) {
        throw internalExcelError('INTERNAL_EXCEL_TOTAL_SIZE_EXCEEDED', '선택한 Excel 파일의 전체 크기가 512MB를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
      }
      if (!Number.isSafeInteger(totalCells) || totalCells > MAX_INTERNAL_CELLS) {
        throw internalExcelError('INTERNAL_EXCEL_CELL_LIMIT_EXCEEDED', '합칠 Excel 데이터가 안전한 처리 한도인 100만 칸을 넘습니다. 여러 번으로 나눠 합쳐주세요.');
      }
      if (totalSheets > MAX_INTERNAL_WORKSHEETS) {
        throw internalExcelError('INTERNAL_EXCEL_WORKSHEET_LIMIT_EXCEEDED', '합칠 Excel 시트가 안전한 처리 한도인 200개를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
      }
      featureWarnings(loaded.packageFeatures).forEach((warning) => warnings.add(warning));
      loadedSources.push(loaded);
      options.onProgress?.({ ok: true, index: index + 1, completed: index + 1, total: plan.sources.length });
    }

    const sourceSheetEntries = loadedSources.flatMap((loaded, sourceIndex) => loaded.workbook.worksheets.map((sheet) => ({ sheet, sourceIndex })));
    const sourceSheets = sourceSheetEntries.map((entry) => entry.sheet);
    const addCombinedSheet = options.addCombinedSheet === true;
    const useFileNameAsSheetName = options.useFileNameAsSheetName === true;
    if (sourceSheets.length + (addCombinedSheet ? 1 : 0) > MAX_INTERNAL_WORKSHEETS) {
      throw internalExcelError('INTERNAL_EXCEL_WORKSHEET_LIMIT_EXCEEDED', '전체 통합 시트를 포함한 결과가 안전한 처리 한도인 200개 시트를 넘습니다. 여러 번으로 나눠 합쳐주세요.');
    }
    const usedNames = new Set();
    const originalNames = sourceSheetEntries.map(({ sheet, sourceIndex }, index) => {
      const useSourceFileName = useFileNameAsSheetName && loadedSources[sourceIndex].worksheets.length === 1;
      const sourceFileName = String(options.sourceFileNames?.[sourceIndex] || plan.sources[sourceIndex]);
      const requestedName = useSourceFileName
        ? path.basename(sourceFileName, path.extname(sourceFileName))
        : sheet.name;
      return NativeOfficeMerge.safeExcelSheetName(requestedName, usedNames, index + 1);
    });
    const combinedSheetName = addCombinedSheet
      ? NativeOfficeMerge.safeExcelSheetName(options.combinedSheetName || DEFAULT_COMBINED_SHEET_NAME, usedNames, originalNames.length + 1)
      : '';
    const Workbook = loadedSources[0].workbook.constructor;
    const output = new Workbook();
    output.creator = 'CMOE Workspace';
    output.created = new Date();

    let combined = { rowCount: 0, columnCount: 0, headerMismatch: false };
    if (addCombinedSheet) combined = createCombinedSheet(output, sourceSheets, combinedSheetName, warningKeys, warnings, options);
    sourceSheets.forEach((source, index) => {
      checkCancelled(options);
      const target = output.addWorksheet(originalNames[index]);
      copyWorksheet(source, target, warningKeys, options);
    });
    addWarningMessages(warningKeys, warnings);

    const expectedDescriptors = workbookValueDescriptors(output);
    await output.xlsx.writeFile(tempPath);
    checkCancelled(options);
    let verified;
    try { verified = await loadXlsxWorkbookSafely(tempPath); }
    catch (error) { throw internalExcelError('INTERNAL_EXCEL_OUTPUT_VERIFICATION_FAILED', '저장한 Excel 결과를 프로그램 내부 엔진으로 다시 열지 못해 결과를 저장하지 않았습니다.', error); }
    const actualDescriptors = workbookValueDescriptors(verified.workbook);
    assertVerifiedOutput(expectedDescriptors, actualDescriptors);
    const verifiedCombinedDescriptor = addCombinedSheet ? actualDescriptors[0] : null;

    for (let index = 0; index < loadedSources.length; index += 1) {
      checkCancelled(options);
      const currentHash = await hashFile(plan.sources[index]);
      if (currentHash !== loadedSources[index].sourceSha256) {
        throw internalExcelError('INTERNAL_EXCEL_INPUT_CHANGED', `${path.basename(plan.sources[index])} 파일이 병합 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.`);
      }
    }
    checkCancelled(options);
    await publishExclusive(tempPath, plan.outputPath);
    published = true;
    const stats = await fs.promises.stat(plan.outputPath);
    return {
      kind: 'excel',
      outputPath: plan.outputPath,
      outputName: path.basename(plan.outputPath),
      outputBytes: stats.size,
      sourceCount: loadedSources.length,
      sourceSheetCounts: loadedSources.map((source) => source.worksheets.length),
      sheetCount: actualDescriptors.length,
      sheetNames: actualDescriptors.map((sheet) => sheet.name),
      sheetTypes: actualDescriptors.map(() => 'worksheet'),
      sheetVisibility: actualDescriptors.map((sheet) => sheet.visibility),
      combinedSheetAdded: addCombinedSheet,
      combinedSheetName,
      combinedRowCount: verifiedCombinedDescriptor?.rowCount || 0,
      combinedColumnCount: verifiedCombinedDescriptor?.columnCount || 0,
      combinedHeaderMismatch: combined.headerMismatch,
      combinedValueSnapshot: addCombinedSheet,
      combinedDataMode: addCombinedSheet ? 'calculated-values-with-cell-formatting' : '',
      externalLinksPresent: false,
      externalLinkCount: 0,
      baseStrategy: 'cmoe-internal-xlsx-rebuild',
      compatibilityInputs: [],
      compatibilityFallback: true,
      internalFallback: true,
      lossy: warnings.size > 0,
      warnings: [...warnings],
      contentVerified: true,
      requiresPreview: true,
      engine: 'cmoe-internal-excel'
    };
  } catch (error) {
    if (published) await fs.promises.unlink(plan.outputPath).catch(() => {});
    throw asInternalExcelError(error, 'INTERNAL_EXCEL_MERGE_FAILED');
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

module.exports = {
  DEFAULT_COMBINED_SHEET_NAME,
  internalExcelError,
  inspectInternalExcelWorkbook,
  mergeExcelFilesInternally,
  worksheetValueDescriptor,
  assertVerifiedOutput
};
