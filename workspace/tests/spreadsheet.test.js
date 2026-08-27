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
      availability: { p1: ['s1'] },
      scheduleRules: {},
      rosterViews: [],
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
  assert.equal(sheets[2].matrix.length, 2);
  assert.match(sheets[2].matrix[1][1], /날짜·시작·종료 컬럼/, 'missing required spreadsheet columns are recomputed');
  const calendarProject = JSON.parse(JSON.stringify(project));
  calendarProject.data.scheduleSheetInitialized = false;
  calendarProject.data.layout = { type: 'calendarCoach' };
  calendarProject.data.people.push({ id: 'coach-1', name: '김코치', values: { name: '김코치' }, roleIds: ['coach'], active: true });
  calendarProject.data.roles.push({ id: 'coach', name: '진행 코치', active: true });
  calendarProject.data.assignments.push({ id: 'coach-a1', slotId: 's1', personId: 'coach-1', roleId: 'coach' });
  calendarProject.data.externalArtifacts.push({ kind: 'zoom', slotId: 's1', status: 'created', joinUrl: 'https://zoom.example/j/s1' });
  calendarProject.data.layout = { type: 'list' };
  const listOutput = path.join(os.tmpdir(), `cmoe-workspace-list-sheet-${process.pid}.xlsx`);
  await exportProjectWorkbook(listOutput, calendarProject);
  const listSheet = await readFirstWorksheet(listOutput);
  assert.equal(listSheet.matrix[0].includes('Zoom 링크'), true, 'the full-list XLSX keeps its existing Zoom column');
  assert.equal(listSheet.matrix[1][7], 'https://zoom.example/j/s1');
  calendarProject.data.layout.type = 'calendarCoach';
  const coachOutput = path.join(os.tmpdir(), `cmoe-workspace-coach-sheet-${process.pid}.xlsx`);
  await exportProjectWorkbook(coachOutput, calendarProject);
  const coachSheet = await readFirstWorksheet(coachOutput);
  assert.equal(coachSheet.sheetName, '날짜별 일정 · 코치');
  assert.equal(coachSheet.matrix[0].includes('진행 코치'), true);
  assert.equal(coachSheet.matrix[1][4], '김코치');
  calendarProject.data.layout.type = 'calendarZoom';
  const zoomOutput = path.join(os.tmpdir(), `cmoe-workspace-zoom-sheet-${process.pid}.xlsx`);
  await exportProjectWorkbook(zoomOutput, calendarProject);
  const zoomSheet = await readFirstWorksheet(zoomOutput);
  assert.equal(zoomSheet.sheetName, '날짜별 일정 · Zoom');
  assert.equal(zoomSheet.matrix[0].includes('Zoom 참가 링크'), true);
  assert.equal(zoomSheet.matrix[1][5], 'https://zoom.example/j/s1');
  project.data.slots[0].date = '2026-02-30';
  project.data.conflicts = [];
  const invalidOutput = path.join(os.tmpdir(), `cmoe-workspace-invalid-sheet-${process.pid}.xlsx`);
  await exportProjectWorkbook(invalidOutput, project);
  const invalidSheets = await readWorkbookSheets(invalidOutput);
  assert.match(invalidSheets[2].matrix.map((row) => row.join(' ')).join('\n'), /실제 날짜/, 'export recomputes spreadsheet validation instead of trusting stored conflicts');
  const workOutput = path.join(os.tmpdir(), `cmoe-workspace-work-${process.pid}.xlsx`);
  await exportWorkItemWorkbook(workOutput, { name: '그룹 작업', columns: [{ id: 'group', name: '그룹' }, { id: 'name', name: '이름' }], rows: [{ values: { group: '그룹 1', name: '테스트' } }] });
  const workSheet = await readFirstWorksheet(workOutput); assert.deepEqual(workSheet.matrix, [['그룹', '이름'], ['그룹 1', '테스트']]);
  fs.unlinkSync(workOutput);
  fs.unlinkSync(zoomOutput);
  fs.unlinkSync(coachOutput);
  fs.unlinkSync(listOutput);
  fs.unlinkSync(invalidOutput);
  fs.unlinkSync(output);
  console.log('spreadsheet tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
