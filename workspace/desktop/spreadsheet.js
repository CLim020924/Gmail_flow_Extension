const fs = require('node:fs');
const path = require('node:path');
const Ops = require('../operations-core');
const packagedExcelJs = process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'node_modules', 'exceljs') : '';
const ExcelJS = require(packagedExcelJs && fs.existsSync(packagedExcelJs) ? packagedExcelJs : path.join(__dirname, '..', 'vendor', 'node_modules', 'exceljs'));

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
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
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

module.exports = { readWorkbookSheets, readFirstWorksheet, exportProjectWorkbook, exportWorkItemWorkbook };
