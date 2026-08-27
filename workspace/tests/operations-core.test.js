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
const impossibleDate = Ops.parseSlots('2026-02-31 09:30-10:30');
assert.equal(impossibleDate.slots.length, 0);
assert.match(impossibleDate.errors[0], /실제 날짜/);
const invalidTime = Ops.parseSlots('2026-08-20 25:99-26:88');
assert.equal(invalidTime.slots.length, 0);
assert.match(invalidTime.errors.join('\n'), /HH:MM/);
const reversedRange = Ops.parseSlots('2026-08-20 10:00-09:00');
assert.equal(reversedRange.slots.length, 0);
assert.match(reversedRange.errors[0], /종료 시간은 시작 시간보다 늦어야/);
const nonStrictTime = Ops.parseSlots('2026-08-20 9:00-10:00');
assert.equal(nonStrictTime.slots.length, 0, 'times must use strict HH:MM formatting');
const leapDay = Ops.parseSlots('2028-02-29 09:00-10:00 윤년');
assert.equal(leapDay.errors.length, 0);
assert.equal(leapDay.slots[0].date, '2028-02-29');
assert.equal(Ops.isValidCalendarDate('2026-02-29'), false);
assert.equal(Ops.timeToMinutes('23:59'), 1439);
assert.equal(Ops.timeToMinutes('24:00'), null);

const people = roster.people.slice(0, 2).map((person, index) => ({ ...person, id: `p${index + 1}`, roleIds: ['participant'] }));
const roles = [{ id: 'participant', name: '참여자', minPerSession: 2, maxPerSession: 2, targetSessions: 1, active: true }];
const slots = [parsedSlots.slots[0]];
const availability = { p1: [slots[0].id], p2: [slots[0].id] };
const generated = Ops.generateSchedule({ people, roles, slots, availability, rules: { avoidRepeatPairing: true } });
assert.equal(generated.assignments.length, 2);
assert.equal(generated.conflicts.length, 0);
assert.equal(Ops.validateAssignments({ assignments: generated.assignments, people, roles, slots }).length, 0);

const cancelledGenerationSlots = [
  { id: 'slot-cancelled', date: '2026-07-06', startTime: '08:30', endTime: '09:30', label: '취소 일정', status: 'cancelled', locked: true },
  { id: 'slot-active', date: '2026-07-06', startTime: '09:30', endTime: '10:30', label: '진행 일정', status: 'draft', locked: false }
];
const generatedWithoutCancelled = Ops.generateSchedule({
  people: [people[0]],
  roles: [{ ...roles[0], minPerSession: 1, maxPerSession: 1 }],
  slots: cancelledGenerationSlots,
  availability: { p1: cancelledGenerationSlots.map((slot) => slot.id) },
  existingAssignments: [{ id: 'locked-cancelled', slotId: 'slot-cancelled', personId: 'p1', roleId: 'participant', locked: true }],
  rules: {}
});
assert.equal(generatedWithoutCancelled.assignments.length, 1);
assert.equal(generatedWithoutCancelled.assignments[0].slotId, 'slot-active');
assert(!generatedWithoutCancelled.assignments.some((assignment) => assignment.slotId === 'slot-cancelled'), 'cancelled slots must not retain or receive generated assignments');

const lockedActiveSlot = { id: 'slot-locked-active', date: '2026-07-06', startTime: '11:00', endTime: '12:00', label: '잠긴 진행 일정', status: 'draft', locked: true };
const lockedActiveAssignment = { id: 'locked-active-person', slotId: lockedActiveSlot.id, personId: 'p1', roleId: 'participant', locked: true };
const generatedWithLockedRow = Ops.generateSchedule({
  people,
  roles: [{ ...roles[0], minPerSession: 2, maxPerSession: 2 }],
  slots: [lockedActiveSlot],
  availability: { p1: [lockedActiveSlot.id], p2: [lockedActiveSlot.id] },
  existingAssignments: [lockedActiveAssignment],
  rules: {}
});
assert.deepEqual(generatedWithLockedRow.assignments, [lockedActiveAssignment], 'an active locked row must remain byte-for-byte unchanged during regeneration');
assert(generatedWithLockedRow.conflicts.some((item) => item.type === 'slotMinimum'), 'an incomplete locked row is reported instead of silently modified');

const rescheduleSlots = [
  { id: 'slot-a', date: '2026-07-06', startTime: '09:30', endTime: '10:30', label: '오전', status: 'confirmed', locked: false },
  { id: 'slot-b', date: '2026-07-06', startTime: '10:30', endTime: '11:30', label: '오후', status: 'confirmed', locked: false }
];
const rescheduleAssignments = [
  { id: 'a1', slotId: 'slot-a', personId: 'p1', roleId: 'participant', locked: false },
  { id: 'a2', slotId: 'slot-a', personId: 'p2', roleId: 'participant', locked: false }
];
const assignmentsBeforePreview = JSON.parse(JSON.stringify(rescheduleAssignments));
const sameDependencyDiff = Ops.diffScheduleDependencies({ beforeSlots: rescheduleSlots, afterSlots: rescheduleSlots.map((slot) => ({ ...slot, locked: !slot.locked })), beforeAssignments: rescheduleAssignments, afterAssignments: rescheduleAssignments.map((assignment, index) => ({ ...assignment, id: `replacement-${index}` })) });
assert.deepEqual(sameDependencyDiff, { changedSlotIds: [], zoomReviewSlotIds: [], affectedPersonIds: [] }, 'assignment ids and locks do not change external payloads');
const participantDependencyDiff = Ops.diffScheduleDependencies({ beforeSlots: rescheduleSlots, afterSlots: rescheduleSlots, beforeAssignments: rescheduleAssignments, afterAssignments: [{ ...rescheduleAssignments[0], id: 'replacement-p1' }, { ...rescheduleAssignments[1], id: 'replacement-p3', personId: 'p3' }] });
assert.deepEqual(participantDependencyDiff.changedSlotIds, ['slot-a']);
assert.deepEqual(participantDependencyDiff.zoomReviewSlotIds, [], 'participant replacement keeps an already-used Zoom meeting');
assert.deepEqual(new Set(participantDependencyDiff.affectedPersonIds), new Set(['p1', 'p2', 'p3']));
const timeDependencyDiff = Ops.diffScheduleDependencies({ beforeSlots: rescheduleSlots, afterSlots: [{ ...rescheduleSlots[0], startTime: '09:45' }, rescheduleSlots[1]], beforeAssignments: rescheduleAssignments, afterAssignments: rescheduleAssignments });
assert.deepEqual(timeDependencyDiff.zoomReviewSlotIds, ['slot-a']);
assert.deepEqual(new Set(timeDependencyDiff.affectedPersonIds), new Set(['p1', 'p2']));
const cancelledDependencyDiff = Ops.diffScheduleDependencies({ beforeSlots: rescheduleSlots, afterSlots: [{ ...rescheduleSlots[0], status: 'cancelled' }, rescheduleSlots[1]], beforeAssignments: rescheduleAssignments, afterAssignments: rescheduleAssignments });
assert.deepEqual(cancelledDependencyDiff.zoomReviewSlotIds, ['slot-a']);
const emptyDependencyDiff = Ops.diffScheduleDependencies({ beforeSlots: rescheduleSlots, afterSlots: rescheduleSlots, beforeAssignments: [rescheduleAssignments[0]], afterAssignments: [] });
assert.deepEqual(emptyDependencyDiff.zoomReviewSlotIds, ['slot-a']);

const reschedulePlan = Ops.planScheduleChange({
  people,
  roles,
  slots: rescheduleSlots,
  assignments: rescheduleAssignments,
  availability: { p1: ['slot-b'], p2: ['slot-a'] },
  rules: {},
  change: { action: 'move', assignmentId: 'a1', personId: 'p1', toSlotId: 'slot-b' }
});
assert.equal(reschedulePlan.canApply, true);
assert.equal(reschedulePlan.nextAssignments.find((item) => item.id === 'a1').slotId, 'slot-b');
assert.deepEqual(reschedulePlan.impact.changedSlotIds, ['slot-a', 'slot-b']);
assert.deepEqual(new Set(reschedulePlan.impact.affectedPersonIds), new Set(['p1', 'p2']));
assert.deepEqual(reschedulePlan.impact.zoomReviewSlotIds, ['slot-b']);
assert.match(reschedulePlan.warnings.find((item) => item.code === 'slotMinimum').message, /최소 인원/);
assert(!reschedulePlan.warnings.some((item) => item.slotId === 'slot-b' && item.code === 'slotMinimum'), 'an improving pre-existing target shortage should not be reported as a new warning');
assert.deepEqual(rescheduleAssignments, assignmentsBeforePreview, 'preview must not mutate current assignments');

const lockedPlan = Ops.planScheduleChange({
  people,
  roles,
  slots: [{ ...rescheduleSlots[0], locked: true }, rescheduleSlots[1]],
  assignments: rescheduleAssignments,
  availability: { p1: ['slot-b'] },
  rules: {},
  change: { action: 'move', assignmentId: 'a1', personId: 'p1', toSlotId: 'slot-b' }
});
assert.equal(lockedPlan.canApply, false);
assert.equal(lockedPlan.blockers[0].code, 'lockedSource');

const warningPlan = Ops.planScheduleChange({
  people: [{ ...people[0], roleIds: [] }, people[1]],
  roles: [{ ...roles[0], minPerSession: 1, maxPerSession: 1 }],
  slots: rescheduleSlots,
  assignments: [rescheduleAssignments[0], { ...rescheduleAssignments[1], slotId: 'slot-b' }],
  availability: { p1: [], p2: ['slot-b'] },
  rules: {},
  change: { action: 'move', assignmentId: 'a1', personId: 'p1', toSlotId: 'slot-b' }
});
assert.equal(warningPlan.canApply, true, 'warnings require confirmation but do not block an explicit exception');
assert.deepEqual(new Set(warningPlan.warnings.map((item) => item.code)), new Set(['roleEligibility', 'unavailable', 'slotMaximum', 'slotMinimum']));
assert.equal(new Set(warningPlan.warnings.map((item) => item.message)).size, warningPlan.warnings.length, 'the preview should not repeat equivalent warnings');

const cancelledPlan = Ops.planScheduleChange({
  people,
  roles,
  slots: [rescheduleSlots[0], { ...rescheduleSlots[1], status: 'cancelled' }],
  assignments: rescheduleAssignments,
  availability: { p1: ['slot-b'] },
  rules: {},
  change: { action: 'move', assignmentId: 'a1', personId: 'p1', toSlotId: 'slot-b' }
});
assert.equal(cancelledPlan.canApply, false);
assert(cancelledPlan.blockers.some((item) => item.code === 'cancelledTarget'));
const cancelledOverlapSlot = { id: 'slot-cancelled-overlap', date: '2026-07-06', startTime: '10:45', endTime: '11:15', label: '취소 겹침', status: 'cancelled', locked: false };
const cancelledOverlapAssignments = [{ id: 'a-cancelled', slotId: cancelledOverlapSlot.id, personId: 'p1', roleId: 'participant', locked: false }, rescheduleAssignments[0]];
assert.equal(Ops.validateAssignments({ assignments: cancelledOverlapAssignments, people, roles, slots: [...rescheduleSlots, cancelledOverlapSlot] }).length, 0, 'cancelled slots do not create overlap errors');
const cancelledOverlapPlan = Ops.planScheduleChange({ people, roles, slots: [...rescheduleSlots, cancelledOverlapSlot], assignments: cancelledOverlapAssignments, availability: { p1: ['slot-a', 'slot-b'] }, rules: {}, change: { action: 'move', assignmentId: 'a1', personId: 'p1', toSlotId: 'slot-b' } });
assert(!cancelledOverlapPlan.warnings.some((item) => item.code === 'newConflict'), 'cancelled overlaps are not new move conflicts');
const cancelledNoise = Ops.validateScheduleConstraints({ people: [{ ...people[0], roleIds: [] }, people[1]], roles, slots: [...rescheduleSlots, cancelledOverlapSlot], assignments: [cancelledOverlapAssignments[0]], availability: { p1: [] }, rules: {} }).filter((item) => item.personId === 'p1' && item.slotId === cancelledOverlapSlot.id);
assert.deepEqual(cancelledNoise.map((item) => item.type), ['cancelledSlot'], 'cancelled assignments suppress irrelevant eligibility and availability noise');

const duplicatePlan = Ops.planScheduleChange({
  people,
  roles,
  slots: rescheduleSlots,
  assignments: [...rescheduleAssignments, { id: 'a3', slotId: 'slot-b', personId: 'p1', roleId: 'participant', locked: false }],
  availability: { p1: ['slot-b'] },
  rules: {},
  change: { action: 'move', assignmentId: 'a1', personId: 'p1', toSlotId: 'slot-b' }
});
assert.equal(duplicatePlan.canApply, false);
assert(duplicatePlan.blockers.some((item) => item.code === 'duplicateTarget'));

const addPlan = Ops.planScheduleChange({
  people,
  roles,
  slots: rescheduleSlots,
  assignments: rescheduleAssignments,
  availability: { p1: ['slot-b'] },
  rules: {},
  change: { action: 'add', personId: 'p1', roleId: 'participant', toSlotId: 'slot-b', nextAssignmentId: 'a-new' }
});
assert.equal(addPlan.nextAssignments.find((item) => item.id === 'a-new').slotId, 'slot-b');
assert.deepEqual(addPlan.impact.zoomReviewSlotIds, ['slot-b']);
assert(addPlan.warnings.some((item) => item.code === 'personTargetMaximum'), 'adding beyond the target session count requires review');

const removePlan = Ops.planScheduleChange({
  people,
  roles,
  slots: rescheduleSlots,
  assignments: [rescheduleAssignments[0]],
  availability: { p1: ['slot-a'] },
  rules: {},
  targetPersonIds: ['p1'],
  change: { action: 'remove', assignmentId: 'a1', personId: 'p1' }
});
assert.equal(removePlan.nextAssignments.length, 0);
assert.deepEqual(removePlan.impact.zoomReviewSlotIds, ['slot-a']);
assert(removePlan.warnings.some((item) => item.code === 'personTarget' && item.personId === 'p1'), 'removing the last assignment should surface the newly missed person target');
assert(!removePlan.warnings.some((item) => item.code === 'personTarget' && item.personId === 'p2'), 'targetPersonIds should exclude out-of-scope people from preview warnings');
assert(!removePlan.warnings.some((item) => item.slotId === 'slot-b'), 'unchanged pre-existing slot constraints should not be repeated');

const constraintIssues = Ops.validateScheduleConstraints({
  people: [{ ...people[0], roleIds: [] }, people[1]],
  roles: [{ ...roles[0], minPerSession: 1, maxPerSession: 1 }],
  slots: rescheduleSlots,
  assignments: [rescheduleAssignments[0], { ...rescheduleAssignments[1], slotId: 'slot-a' }],
  availability: { p1: [], p2: ['slot-a'] },
  rules: {}
});
assert(constraintIssues.some((item) => item.type === 'roleEligibility'));
assert(constraintIssues.some((item) => item.type === 'unavailable'));
assert(constraintIssues.some((item) => item.type === 'slotMaximum'));

const selectedRosterIssues = Ops.validateScheduleConstraints({
  people,
  roles,
  slots: rescheduleSlots,
  assignments: [rescheduleAssignments[0]],
  availability: { p1: ['slot-a'], p2: ['slot-a'] },
  rules: {},
  targetPersonIds: ['p1']
});
assert(!selectedRosterIssues.some((item) => item.type === 'personTarget' && item.personId === 'p2'), 'people excluded from the schedule roster should not receive target-count warnings');

const recomputedProject = {
  data: {
    people,
    roles: [{ ...roles[0], minPerSession: 0, maxPerSession: 3, targetSessions: 1, candidateFilter: 'all' }],
    slots: [
      { id: 'invalid-slot', date: '2026-02-30', startTime: '10:00', endTime: '09:00', label: '잘못된 일정', status: 'draft' },
      { id: 'overlap-a', date: '2028-02-29', startTime: '09:00', endTime: '10:00', label: '겹침 A', status: 'draft' },
      { id: 'overlap-b', date: '2028-02-29', startTime: '09:30', endTime: '10:30', label: '겹침 B', status: 'draft' }
    ],
    assignments: [
      { id: 'overlap-assignment-a', slotId: 'overlap-a', personId: 'p1', roleId: 'participant' },
      { id: 'overlap-assignment-b', slotId: 'overlap-b', personId: 'p1', roleId: 'participant' }
    ],
    availability: { p1: ['overlap-a'], p2: [] },
    scheduleRules: { rosterViewId: 'selected-view' },
    rosterViews: [{ id: 'selected-view', personIds: ['p1', 'p2'], excludedPersonIds: ['p2'] }],
    scheduleSheetInitialized: false,
    conflicts: [{ type: 'stale', message: '저장된 오래된 결과' }]
  }
};
const recomputedConflicts = Ops.collectScheduleConflicts(recomputedProject);
assert(recomputedConflicts.some((item) => item.code === 'invalidDate'), 'impossible sheet dates are recomputed');
assert(recomputedConflicts.some((item) => item.code === 'invalidTimeRange'), 'reversed sheet time ranges are recomputed');
assert(recomputedConflicts.some((item) => item.type === 'validation' && /중복/.test(item.message)), 'assignment overlaps are recomputed');
assert(recomputedConflicts.some((item) => item.type === 'unavailable' && item.slotId === 'overlap-b'), 'availability conflicts are recomputed');
assert(!recomputedConflicts.some((item) => item.type === 'personTarget' && item.personId === 'p2'), 'the selected roster view limits target-count conflicts');
assert(!recomputedConflicts.some((item) => item.type === 'stale'), 'stored conflict snapshots are ignored');

const cleanRecomputedConflicts = Ops.collectScheduleConflicts({ data: { people, roles, slots, assignments: generated.assignments, availability, scheduleRules: {}, rosterViews: [], scheduleSheetInitialized: false } });
assert.deepEqual(cleanRecomputedConflicts, [], 'a valid current schedule recomputes to a clean conflict list');

const project = { data: { people, roles, slots, assignments: generated.assignments } };
assert.match(Ops.scheduleToCsv(project), /날짜,시작,종료/);
assert.match(Ops.scheduleToExcelXml(project), /<Workbook/);

const outputProject = {
  settings: { changeApprovalRequired: true },
  data: {
    layout: { type: 'list' },
    people: [...people, { id: 'coach-person', name: '김코치', active: true }],
    roles: [...roles, { id: 'coach', name: '진행 코치', active: true }],
    slots: [{ id: 'output-slot', date: '2026-07-09', startTime: '13:00', endTime: '14:30', label: '출력 세션', status: 'confirmed' }],
    assignments: [
      { id: 'output-participant', slotId: 'output-slot', personId: 'p1', roleId: 'participant' },
      { id: 'output-coach', slotId: 'output-slot', personId: 'coach-person', roleId: 'coach' }
    ],
    externalArtifacts: [{ kind: 'zoom', slotId: 'output-slot', status: 'created', joinUrl: 'https://zoom.example/j/output' }]
  }
};
const listOutput = Ops.scheduleOutputTable(outputProject, 'list');
const coachOutput = Ops.scheduleOutputTable(outputProject, 'calendarCoach');
const zoomOutput = Ops.scheduleOutputTable(outputProject, 'calendarZoom');
assert.deepEqual(listOutput.headers, ['날짜', '시작', '종료', '세션명', '역할', '이름', '상태', 'Zoom 링크']);
assert.equal(listOutput.rows[0][7], 'https://zoom.example/j/output', 'the full list keeps the existing Zoom link column');
assert.equal(coachOutput.headers.includes('진행 코치'), true);
assert.equal(coachOutput.rows[0][4], '김코치');
assert.equal(coachOutput.rows[0][5], people[0].name);
assert.equal(zoomOutput.headers.includes('Zoom 참가 링크'), true);
assert.equal(zoomOutput.rows[0][5], 'https://zoom.example/j/output');
assert.notEqual(Ops.scheduleToCsv(outputProject, 'calendarCoach'), Ops.scheduleToCsv(outputProject, 'calendarZoom'));
assert.match(Ops.scheduleToExcelXml(outputProject, 'calendarCoach'), /진행 코치/);
assert.match(Ops.scheduleToExcelXml(outputProject, 'calendarZoom'), /Zoom 참가 링크/);
assert.equal(Ops.addMinutesToTime('09:00', 90), '10:30');
assert.equal(Ops.externalChangeApprovalRequired(outputProject), true);
outputProject.settings.changeApprovalRequired = false;
assert.equal(Ops.externalChangeApprovalRequired(outputProject), false);

const mailProject = {
  name: '테스트',
  data: {
    columns: roster.columns,
    people: [{ ...people[0], values: { ...people[0].values, [roster.columns.find((column) => column.name === '전화번호').id]: '010-1234-5678' } }],
    roles,
    slots: [
      { id: 'mail-active', date: '2026-07-07', startTime: '09:00', endTime: '10:00', label: '진행 일정', status: 'confirmed' },
      { id: 'mail-cancelled', date: '2026-07-08', startTime: '09:00', endTime: '10:00', label: '취소 일정', status: 'cancelled' }
    ],
    assignments: [
      { id: 'mail-a1', slotId: 'mail-active', personId: 'p1', roleId: 'participant' },
      { id: 'mail-a2', slotId: 'mail-cancelled', personId: 'p1', roleId: 'participant' }
    ],
    externalArtifacts: [],
    communication: { subjectTemplate: '{이름} {전화번호}', bodyTemplate: '{전화번호}', bodyHtmlTemplate: '<p>{전화번호}</p>', mailEdits: {} }
  }
};
const mail = Ops.buildMailPackage(mailProject).entries[0];
assert.match(mail.subject, /010-1234-5678/);
assert.equal(mail.variables.전화번호, '010-1234-5678');
assert.equal(mail.assignments.length, 1);
assert.match(mail.variables.개인일정, /진행 일정/);
assert.doesNotMatch(mail.variables.개인일정, /취소 일정/);

const zoomFingerprint = Ops.externalOperationFingerprint(mailProject, 'zoom');
const renamedProject = JSON.parse(JSON.stringify(mailProject));
renamedProject.name = '이름이 바뀐 프로젝트';
assert.notEqual(Ops.externalOperationFingerprint(renamedProject, 'zoom'), zoomFingerprint, 'a project name change must invalidate a pending Zoom operation');

const gmailFingerprint = Ops.externalOperationFingerprint(mailProject, 'gmailDraft');
const personallyEditedProject = JSON.parse(JSON.stringify(mailProject));
personallyEditedProject.data.communication.mailEdits.p1 = { subject: '개인 제목', body: '개인 본문', bodyHtml: '<p>개인 본문</p>', updatedAt: new Date().toISOString() };
assert.notEqual(Ops.externalOperationFingerprint(personallyEditedProject, 'gmailDraft'), gmailFingerprint, 'a personal mail edit must invalidate a pending Gmail operation');

const gmailConnections = [{ id: 'gmail-main', type: 'gmail', status: 'connected', account: 'first@example.com', updatedAt: '2026-01-01T00:00:00.000Z' }];
const routedMailProject = JSON.parse(JSON.stringify(mailProject));
routedMailProject.settings = { defaultConnectionIds: { gmail: 'gmail-main', forms: 'forms-main' } };
const routedGmailFingerprint = Ops.externalOperationFingerprint(routedMailProject, 'gmailDraft', gmailConnections);
const reauthenticatedConnections = [{ ...gmailConnections[0], account: 'second@example.com', updatedAt: '2026-01-02T00:00:00.000Z' }];
assert.notEqual(Ops.externalOperationFingerprint(routedMailProject, 'gmailDraft', reauthenticatedConnections), routedGmailFingerprint, 'changing the authenticated Gmail account must invalidate a pending Gmail operation');

const formsProject = JSON.parse(JSON.stringify(routedMailProject));
formsProject.data.forms = { definitions: [{ id: 'definition-1', type: 'registration', title: '신청' }], linkedForms: [] };
const formsConnections = [{ id: 'forms-main', type: 'forms', status: 'connected', account: 'forms@example.com', updatedAt: '2026-01-01T00:00:00.000Z' }];
const formsFingerprint = Ops.externalOperationFingerprint(formsProject, 'googleForm', formsConnections);
formsProject.data.forms.definitions[0].title = '수정된 신청';
assert.notEqual(Ops.externalOperationFingerprint(formsProject, 'googleForm', formsConnections), formsFingerprint, 'editing a form definition must invalidate a pending Google Forms operation');

console.log('operations-core tests passed');
