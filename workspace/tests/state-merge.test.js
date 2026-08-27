const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeWorkspaceState, mergeScheduleArtifacts, overlayScheduleProjects } = require('../desktop/state-merge');
const { JsonStorage } = require('../desktop/storage');

async function run() {

const current = { updatedAt: '2026-01-01T00:00:06Z', installedExtensions: ['people'], deletedLibraryIds: ['gone'], projects: [{ id: 'a', updatedAt: '2026-01-01T00:00:01Z', name: 'A1' }], quickWorkspaces: { gmailFlow: { id: 'q', updatedAt: '2026-01-01T00:00:03Z', name: 'mail' } }, library: { rosters: [{ id: 'r', savedAt: '2026-01-01T00:00:01Z', name: 'old' }], mailTemplates: [{ id: 'gone', savedAt: '2026-01-01T00:00:01Z' }], layoutTemplates: [], workflowTemplates: [{ id: 'w', updatedAt: '2026-01-01T00:00:01Z', name: 'old workflow' }] } };
const incoming = { projects: [{ id: 'b', updatedAt: '2026-01-01T00:00:02Z', name: 'B' }], quickWorkspaces: { schedule: { id: 's', updatedAt: '2026-01-01T00:00:04Z', name: 'schedule' } }, library: { rosters: [{ id: 'r', savedAt: '2026-01-01T00:00:05Z', name: 'new' }], mailTemplates: [], layoutTemplates: [], workflowTemplates: [{ id: 'w', updatedAt: '2026-01-01T00:00:05Z', name: 'new workflow' }] } };
const merged = mergeWorkspaceState(current, incoming);
assert.deepEqual(merged.projects.map((item) => item.id).sort(), ['a', 'b']);
assert.equal(merged.library.rosters[0].name, 'new');
assert.ok(merged.quickWorkspaces.gmailFlow && merged.quickWorkspaces.schedule);
assert.deepEqual(merged.installedExtensions, ['people']);
assert.equal(merged.library.mailTemplates.length, 0);
assert.equal(merged.library.workflowTemplates[0].name, 'new workflow');

const terminalArtifacts = mergeScheduleArtifacts(
  [{ kind: 'zoom', slotId: 'slot-1', externalId: 'zoom-1', status: 'superseded', replacedAt: '2026-01-01T00:00:10Z' }],
  [{ kind: 'zoom', slotId: 'slot-1', externalId: 'zoom-1', status: 'stale' }],
  { zoomReviewSlotIds: ['slot-1'] }
);
assert.equal(terminalArtifacts[0].status, 'superseded');
assert.equal(terminalArtifacts[0].replacedAt, '2026-01-01T00:00:10Z');
const unrelatedArtifacts = mergeScheduleArtifacts(
  [{ kind: 'zoom', slotId: 'slot-1', externalId: 'zoom-2', status: 'stale', joinUrl: 'latest' }],
  [{ kind: 'zoom', slotId: 'slot-1', externalId: 'zoom-2', status: 'created', joinUrl: 'old' }],
  { zoomReviewSlotIds: ['slot-2'] }
);
assert.equal(unrelatedArtifacts[0].status, 'stale');
assert.equal(unrelatedArtifacts[0].joinUrl, 'latest');

const remoteProject = {
  id: 'schedule-project', updatedAt: '2026-01-01T00:00:10Z', counts: { sessions: 1, unresolved: 0 },
  data: {
    roles: [], slots: [{ id: 'slot-1', startTime: '09:00' }], availability: {}, assignments: [], conflicts: [], scheduleRules: {}, scheduleSheetInitialized: true, scheduleSheetColumns: [], scheduleCustomValues: {}, versions: [],
    communication: { subjectTemplate: '다른 창의 최신 메일' },
    externalArtifacts: [
      { kind: 'zoom', slotId: 'slot-1', externalId: 'zoom-race', status: 'created' },
      { kind: 'gmailDraft', personId: 'person-1', externalId: 'draft-race', status: 'created' }
    ]
  },
  moduleState: { schedule: { status: 'complete' }, zoom: { status: 'complete' }, gmailFlow: { status: 'complete' } },
  workflow: [{ id: 'schedule-step', moduleId: 'schedule', status: 'complete' }, { id: 'zoom-step', moduleId: 'zoom', status: 'complete' }, { id: 'mail-step', moduleId: 'gmailFlow', status: 'complete' }]
};
const localProject = {
  ...remoteProject, updatedAt: '2026-01-01T00:00:11Z', counts: { sessions: 1, unresolved: 1 },
  data: { ...remoteProject.data, slots: [{ id: 'slot-1', startTime: '10:00' }], communication: { subjectTemplate: '로컬의 과거 메일' }, externalArtifacts: [] },
  moduleState: { schedule: { status: 'needsReview' }, zoom: { status: 'stale' }, gmailFlow: { status: 'stale' } },
  workflow: [{ id: 'schedule-step', moduleId: 'schedule', status: 'needsReview' }, { id: 'zoom-step', moduleId: 'zoom', status: 'stale' }, { id: 'mail-step', moduleId: 'gmailFlow', status: 'stale' }]
};
const scheduleMerged = overlayScheduleProjects(
  { projects: [remoteProject], quickWorkspaces: {} },
  { projects: [localProject], quickWorkspaces: {} },
  [{ projectId: 'schedule-project', zoomReviewSlotIds: ['slot-1'], affectedPersonIds: ['person-1'], scheduleOnly: true }],
  { projects: [remoteProject], quickWorkspaces: {} }
).projects[0];
assert.equal(scheduleMerged.data.slots[0].startTime, '09:00');
assert.equal(scheduleMerged.data.communication.subjectTemplate, '다른 창의 최신 메일');
assert.deepEqual(scheduleMerged.data.externalArtifacts.map((item) => item.status), ['stale', 'stale']);
assert.equal(scheduleMerged.moduleState.zoom.status, 'stale');
assert.equal(scheduleMerged.workflow.find((step) => step.moduleId === 'gmailFlow').status, 'stale');

const currentTwoSlots = { ...remoteProject, data: { ...remoteProject.data, slots: [{ id: 'slot-1', startTime: '10:00' }, { id: 'slot-2', startTime: '11:30' }], assignments: [] } };
const staleSecondEdit = { ...localProject, data: { ...localProject.data, slots: [{ id: 'slot-1', startTime: '09:00' }, { id: 'slot-2', startTime: '12:00' }], assignments: [] } };
const twoSlotMerged = overlayScheduleProjects(
  { projects: [staleSecondEdit], quickWorkspaces: {} },
  { projects: [staleSecondEdit], quickWorkspaces: {} },
  [{ projectId: 'schedule-project', changedSlotIds: ['slot-2'], scheduleOnly: true }],
  { projects: [currentTwoSlots], quickWorkspaces: {} }
).projects[0];
assert.deepEqual(twoSlotMerged.data.slots.map((slot) => slot.startTime), ['10:00', '12:00']);

const ancestorProject = {
  id: 'concurrent-project', updatedAt: '2026-01-01T00:00:00Z', name: '동시 편집', counts: { sessions: 1, unresolved: 0 },
  data: {
    people: [{ id: 'person-1', name: '기존 이름', email: 'old@example.com', values: {} }],
    roles: [{ id: 'role-1', name: '참여자' }],
    slots: [{ id: 'slot-1', startTime: '09:00' }],
    availability: { 'person-1': ['slot-1'] },
    assignments: [{ id: 'assignment-1', personId: 'person-1', slotId: 'slot-1', roleId: 'role-1', locked: false }],
    conflicts: [], scheduleRules: { avoidRepeatPairing: true }, scheduleSheetInitialized: true,
    scheduleSheetColumns: [{ id: 'date', key: 'date' }], scheduleCustomValues: {}, versions: [],
    communication: { subjectTemplate: '기존 제목' },
    externalArtifacts: [{ kind: 'zoom', externalId: 'zoom-1', slotId: 'slot-1', status: 'created', joinUrl: 'old-link' }]
  },
  moduleState: { people: { status: 'complete' }, schedule: { status: 'complete' } },
  workflow: [{ id: 'people-step', moduleId: 'people', status: 'complete' }, { id: 'schedule-step', moduleId: 'schedule', status: 'complete' }]
};
const ancestorState = {
  updatedAt: '2026-01-01T00:00:00Z', activeProjectId: 'concurrent-project',
  installedExtensions: ['people', 'schedule'], projects: [ancestorProject], quickWorkspaces: {}, connections: [],
  library: { rosters: [], mailTemplates: [], layoutTemplates: [], workflowTemplates: [] },
  deletedConnectionIds: [], deletedLibraryIds: []
};
const currentConcurrent = structuredClone(ancestorState);
currentConcurrent.updatedAt = '2026-01-01T00:00:10Z';
currentConcurrent.installedExtensions = ['people', 'zoom'];
currentConcurrent.projects[0].updatedAt = currentConcurrent.updatedAt;
currentConcurrent.projects[0].data.communication.subjectTemplate = '다른 창 제목';
currentConcurrent.projects[0].data.externalArtifacts[0].joinUrl = 'latest-link';
const incomingConcurrent = structuredClone(ancestorState);
incomingConcurrent.updatedAt = '2026-01-01T00:00:11Z';
incomingConcurrent.installedExtensions = ['people', 'schedule', 'gmailFlow'];
incomingConcurrent.projects[0].updatedAt = incomingConcurrent.updatedAt;
incomingConcurrent.projects[0].data.people[0].name = '로컬 수정 이름';
incomingConcurrent.projects[0].data.people[0].email = 'new@example.com';
incomingConcurrent.projects[0].data.people.push({ id: 'person-2', name: '추가 고객', email: 'new-person@example.com', values: {} });
incomingConcurrent.projects[0].data.externalArtifacts[0].status = 'stale';

const concurrentMerged = mergeWorkspaceState(currentConcurrent, incomingConcurrent, ancestorState);
const concurrentProject = concurrentMerged.projects[0];
assert.equal(concurrentProject.data.communication.subjectTemplate, '다른 창 제목');
assert.equal(concurrentProject.data.people.find((person) => person.id === 'person-1').email, 'new@example.com');
assert.equal(concurrentProject.data.people.some((person) => person.id === 'person-2'), true);
assert.deepEqual(concurrentMerged.installedExtensions, ['people', 'zoom', 'gmailFlow']);
assert.equal(concurrentProject.data.externalArtifacts[0].joinUrl, 'latest-link');
assert.equal(concurrentProject.data.externalArtifacts[0].status, 'stale');

const hintedPeopleMerge = overlayScheduleProjects(
  { ...concurrentMerged, projects: [concurrentProject] },
  incomingConcurrent,
  [{ projectId: 'concurrent-project', changedSlotIds: [], scheduleOnly: true }],
  currentConcurrent
).projects[0];
assert.equal(hintedPeopleMerge.data.people.find((person) => person.id === 'person-1').name, '로컬 수정 이름');
assert.equal(hintedPeopleMerge.data.communication.subjectTemplate, '다른 창 제목');
assert.equal(hintedPeopleMerge.data.slots[0].startTime, '09:00');

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-storage-recovery-'));
const blockingParent = path.join(storageRoot, 'blocked');
const storagePath = path.join(blockingParent, 'workspace.json');
try {
  fs.writeFileSync(blockingParent, 'not a directory', 'utf8');
  const storage = new JsonStorage(storagePath);
  await assert.rejects(storage.set('workspaceState', { revision: 1 }));
  fs.unlinkSync(blockingParent);
  fs.mkdirSync(blockingParent);
  await storage.set('workspaceState', { revision: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, 'utf8')).workspaceState, { revision: 2 });
} finally {
  fs.rmSync(storageRoot, { recursive: true, force: true });
}

console.log('state-merge tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
