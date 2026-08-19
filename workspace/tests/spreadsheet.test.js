const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exportProjectWorkbook, exportWorkItemWorkbook, readFirstWorksheet, readWorkbookSheets } = require('../desktop/spreadsheet');

async function run() {
  const output = path.join(os.tmpdir(), `cmoe-workspace-sheet-${process.pid}.xlsx`);
  const project = {
    name: 'Spreadsheet Test',
    data: {
      columns: [{ id: 'name', name: '이름' }, { id: 'email', name: '이메일' }],
      people: [{ id: 'p1', name: '테스트', values: { name: '테스트', email: 'test@example.com' }, roleIds: ['participant'] }],
      roles: [{ id: 'participant', name: '참여자' }],
      slots: [{ id: 's1', date: '2026-07-06', startTime: '09:30', endTime: '10:30', label: '세션', status: 'confirmed' }],
      assignments: [{ id: 'a1', slotId: 's1', personId: 'p1', roleId: 'participant' }],
      scheduleSheetInitialized: true,
      scheduleSheetColumns: [
        { id: 'sc-date', key: 'date', name: '날짜', kind: 'system' },
        { id: 'sc-participant', key: 'role:participant', name: '참여자', kind: 'role', roleId: 'participant' },
        { id: 'sc-note', key: 'custom:note', name: '운영 메모', kind: 'custom' }
      ],
      scheduleCustomValues: { s1: { 'sc-note': '확인 완료' } },
      externalArtifacts: [], conflicts: []
    }
  };
  await exportProjectWorkbook(output, project);
  assert.ok(fs.statSync(output).size > 1000);
  const imported = await readFirstWorksheet(output);
  assert.equal(imported.sheetName, '일정 목록');
  assert.equal(imported.matrix[0][0], '날짜');
  assert.deepEqual(imported.matrix[0], ['날짜', '참여자', '운영 메모']);
  assert.deepEqual(imported.matrix[1], ['2026-07-06', '테스트', '확인 완료']);
  const sheets = await readWorkbookSheets(output);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['일정 목록', '명단', '확인 필요']);
  assert.deepEqual(sheets[1].matrix[0], ['이름', '이메일']);
  assert.equal(sheets[1].matrix[1][0], '테스트');
  const workOutput = path.join(os.tmpdir(), `cmoe-workspace-work-${process.pid}.xlsx`);
  await exportWorkItemWorkbook(workOutput, { name: '그룹 작업', columns: [{ id: 'group', name: '그룹' }, { id: 'name', name: '이름' }], rows: [{ values: { group: '그룹 1', name: '테스트' } }] });
  const workSheet = await readFirstWorksheet(workOutput); assert.deepEqual(workSheet.matrix, [['그룹', '이름'], ['그룹 1', '테스트']]);
  fs.unlinkSync(workOutput);
  fs.unlinkSync(output);
  console.log('spreadsheet tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
