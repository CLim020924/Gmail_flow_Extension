const assert = require('node:assert/strict');
const Ops = require('../operations-core');

const hwp = [
  '송아라', 'cs-smile@naver.com', '010-8700-3977', 'cs-smile@naver.com',
  '조민지', 'alswldmswl00@naver.com', '010-8213-7220', 'alswldmswl00@naver.com',
  '김미', 'k100mi@naver.com', '010-2591-8813', 'k100mi@naver.com'
].join('\n');

const matrix = Ops.parseDelimited(hwp);
assert.equal(matrix.length, 4);
assert.deepEqual(matrix[0], ['이름', '이메일', '전화번호', '아이디']);
const roster = Ops.matrixToRoster(matrix);
assert.equal(roster.people.length, 3);
assert.equal(roster.people[0].name, '송아라');
assert.equal(roster.people[0].email, 'cs-smile@naver.com');

const parsedSlots = Ops.parseSlots('2026-07-06 09:30-10:30\n2026/07/06 10:30-11:30 오전반');
assert.equal(parsedSlots.errors.length, 0);
assert.equal(parsedSlots.slots.length, 2);

const people = roster.people.slice(0, 2).map((person, index) => ({ ...person, id: `p${index + 1}`, roleIds: ['participant'] }));
const roles = [{ id: 'participant', name: '참여자', minPerSession: 2, maxPerSession: 2, targetSessions: 1, active: true }];
const slots = [parsedSlots.slots[0]];
const availability = { p1: [slots[0].id], p2: [slots[0].id] };
const generated = Ops.generateSchedule({ people, roles, slots, availability, rules: { avoidRepeatPairing: true } });
assert.equal(generated.assignments.length, 2);
assert.equal(generated.conflicts.length, 0);
assert.equal(Ops.validateAssignments({ assignments: generated.assignments, people, roles, slots }).length, 0);

const project = { data: { people, roles, slots, assignments: generated.assignments } };
assert.match(Ops.scheduleToCsv(project), /날짜,시작,종료/);
assert.match(Ops.scheduleToExcelXml(project), /<Workbook/);

const mailProject = {
  name: '테스트',
  data: {
    columns: roster.columns,
    people: [{ ...people[0], values: { ...people[0].values, [roster.columns.find((column) => column.name === '전화번호').id]: '010-1234-5678' } }],
    roles,
    slots: [],
    assignments: [],
    externalArtifacts: [],
    communication: { subjectTemplate: '{이름} {전화번호}', bodyTemplate: '{전화번호}', bodyHtmlTemplate: '<p>{전화번호}</p>', mailEdits: {} }
  }
};
const mail = Ops.buildMailPackage(mailProject).entries[0];
assert.match(mail.subject, /010-1234-5678/);
assert.equal(mail.variables.전화번호, '010-1234-5678');

console.log('operations-core tests passed');
