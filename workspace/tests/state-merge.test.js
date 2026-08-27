const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveSnapshotIdentityMatches, mergeWorkspaceState, mergeScheduleArtifacts, overlayScheduleProjects, preserveLocalConnectionContext } = require('../desktop/state-merge');
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

const currentScheduleEdit = structuredClone(ancestorState);
currentScheduleEdit.updatedAt = '2026-01-01T00:00:12Z';
currentScheduleEdit.projects[0].updatedAt = currentScheduleEdit.updatedAt;
currentScheduleEdit.projects[0].data.slots[0].startTime = '10:00';
const incomingRosterEdit = structuredClone(ancestorState);
incomingRosterEdit.updatedAt = '2026-01-01T00:00:13Z';
incomingRosterEdit.projects[0].updatedAt = incomingRosterEdit.updatedAt;
incomingRosterEdit.projects[0].data.people[0].name = '명단 수정 이름';
const rosterAndScheduleMerged = mergeWorkspaceState(currentScheduleEdit, incomingRosterEdit, ancestorState);
const rosterAndScheduleOverlaid = overlayScheduleProjects(
  rosterAndScheduleMerged,
  incomingRosterEdit,
  [{ projectId: 'concurrent-project', changedSlotIds: [], scheduleOnly: false }],
  currentScheduleEdit
).projects[0];
assert.equal(rosterAndScheduleOverlaid.data.people[0].name, '명단 수정 이름');
assert.equal(rosterAndScheduleOverlaid.data.slots[0].startTime, '10:00');

const currentArtifactCleanup = structuredClone(ancestorState);
currentArtifactCleanup.updatedAt = '2026-01-01T00:00:14Z';
currentArtifactCleanup.projects[0].updatedAt = currentArtifactCleanup.updatedAt;
currentArtifactCleanup.projects[0].data.externalArtifacts[0].status = 'superseded';
currentArtifactCleanup.projects[0].data.externalArtifacts[0].replacedAt = currentArtifactCleanup.updatedAt;
const incomingArtifactStale = structuredClone(ancestorState);
incomingArtifactStale.updatedAt = '2026-01-01T00:00:15Z';
incomingArtifactStale.projects[0].updatedAt = incomingArtifactStale.updatedAt;
incomingArtifactStale.projects[0].data.slots[0].startTime = '10:30';
incomingArtifactStale.projects[0].data.externalArtifacts[0].status = 'stale';
const artifactPipelineMerged = mergeWorkspaceState(currentArtifactCleanup, incomingArtifactStale, ancestorState);
const artifactPipelineOverlaid = overlayScheduleProjects(
  artifactPipelineMerged,
  incomingArtifactStale,
  [{ projectId: 'concurrent-project', changedSlotIds: ['slot-1'], zoomReviewSlotIds: ['slot-1'], scheduleOnly: true }],
  currentArtifactCleanup
).projects[0];
assert.equal(artifactPipelineOverlaid.data.externalArtifacts[0].status, 'superseded');
assert.equal(artifactPipelineOverlaid.data.externalArtifacts[0].replacedAt, '2026-01-01T00:00:14Z');

const pulledFromOtherComputer = {
  preferences: { storageMode: 'drive', workspaceDriveConnectionId: 'remote-drive' },
  connections: [
    { id: 'remote-drive', type: 'drive', status: 'connected', account: 'remote@example.com' },
    { id: 'remote-gmail', type: 'gmail', status: 'connected', account: 'local@example.com' },
    { id: 'remote-gmail-other', type: 'gmail', status: 'connected', account: 'other@example.com' },
    { id: 'remote-zoom', type: 'zoom', status: 'connected', account: 'remote-zoom@example.com' },
    { id: 'remote-forms', type: 'forms', status: 'connected', account: 'remote-forms@example.com' }
  ],
  deletedConnectionIds: ['local-drive'],
  projects: [{
    id: 'shared-project',
    settings: { defaultConnectionIds: { drive: 'remote-drive', gmail: 'remote-gmail', zoom: 'remote-zoom', forms: 'remote-forms' } },
    moduleState: { gmailFlow: { status: 'complete' }, zoom: { status: 'complete' }, forms: { status: 'complete' } },
    workflow: [{ id: 'mail', moduleId: 'gmailFlow', status: 'complete' }, { id: 'zoom', moduleId: 'zoom', status: 'complete' }, { id: 'forms', moduleId: 'forms', status: 'complete' }],
    data: {
      externalArtifacts: [
        { kind: 'gmailDraft', personId: 'person-1', connectionId: 'remote-gmail', externalId: 'draft-1', status: 'created' },
        { kind: 'gmailDraft', personId: 'person-2', connectionId: 'remote-gmail-other', externalId: 'draft-2', status: 'created' },
        { kind: 'zoom', slotId: 'slot-1', connectionId: 'remote-zoom', externalId: 'meeting-1', status: 'created' }
      ],
      slots: [{ id: 'slot-1', zoomConnectionId: 'remote-zoom' }],
      forms: { linkedForms: [{ formId: 'form-1', connectionId: 'remote-forms', needsReview: false }] }
    }
  }],
  quickWorkspaces: { gmailFlow: { id: 'quick-gmailFlow', settings: { defaultConnectionIds: { gmail: 'remote-gmail' } } } }
};
const localConnectionContext = {
  preferences: { storageMode: 'drive', workspaceDriveConnectionId: 'local-drive' },
  connections: [
    { id: 'local-drive', type: 'drive', status: 'connected', account: 'local@example.com' },
    { id: 'local-gmail', type: 'gmail', status: 'connected', account: 'local@example.com' },
    { id: 'local-gmail-default', type: 'gmail', status: 'connected', account: 'previous-default@example.com' }
  ],
  deletedConnectionIds: ['previously-deleted-local'],
  projects: [{ id: 'shared-project', settings: { defaultConnectionIds: { drive: 'local-drive', gmail: 'local-gmail-default' } } }],
  quickWorkspaces: { gmailFlow: { id: 'quick-gmailFlow', settings: { defaultConnectionIds: { gmail: 'local-gmail-default' } } } }
};
const pulledWithLocalConnections = preserveLocalConnectionContext(pulledFromOtherComputer, localConnectionContext);
assert.deepEqual(pulledWithLocalConnections.connections, localConnectionContext.connections, 'Drive pull must keep this computer\'s authenticated connection records');
assert.deepEqual(pulledWithLocalConnections.deletedConnectionIds, localConnectionContext.deletedConnectionIds, 'remote connection tombstones must not remove this computer\'s accounts');
assert.equal(pulledWithLocalConnections.preferences.workspaceDriveConnectionId, 'local-drive', 'an unmatched remote Workspace Drive choice must preserve this computer\'s explicit global sync account');
assert.equal(pulledWithLocalConnections.projects[0].settings.defaultConnectionIds.drive, null, 'an unmatched pulled default must require explicit account selection instead of silently using another local account');
assert.equal(pulledWithLocalConnections.projects[0].settings.defaultConnectionIds.gmail, 'local-gmail', 'a pulled default account must win when the same account is available under this computer\'s id');
assert.equal(pulledWithLocalConnections.quickWorkspaces.gmailFlow.settings.defaultConnectionIds.gmail, 'local-gmail');
assert.equal(pulledWithLocalConnections.projects[0].data.externalArtifacts[0].connectionId, 'local-gmail', 'same-account Gmail artifacts must route through this computer\'s connection id');
assert.equal(pulledWithLocalConnections.projects[0].data.externalArtifacts[0].status, 'created');
assert.equal(pulledWithLocalConnections.projects[0].data.externalArtifacts[1].connectionId, null);
assert.equal(pulledWithLocalConnections.projects[0].data.externalArtifacts[1].status, 'superseded', 'an unmatched Gmail draft must not block creation through this computer\'s account');
assert.equal(pulledWithLocalConnections.projects[0].data.externalArtifacts[2].connectionId, null);
assert.equal(pulledWithLocalConnections.projects[0].data.externalArtifacts[2].status, 'stale', 'an unmatched Zoom meeting must no longer block replacement creation');
assert.equal(pulledWithLocalConnections.projects[0].data.slots[0].zoomConnectionId, null);
assert.equal(pulledWithLocalConnections.projects[0].data.forms.linkedForms[0].connectionId, null);
assert.equal(pulledWithLocalConnections.projects[0].data.forms.linkedForms[0].needsReview, true);
assert.equal(pulledWithLocalConnections.projects[0].moduleState.zoom.status, 'needsReview');
assert.equal(pulledWithLocalConnections.projects[0].moduleState.forms.status, 'needsReview');
assert.equal(pulledWithLocalConnections.projects[0].moduleState.gmailFlow.status, 'needsReview');
assert.equal(pulledFromOtherComputer.connections[0].id, 'remote-drive', 'preserving local context must not mutate the downloaded snapshot');
assert.equal(driveSnapshotIdentityMatches(
  { fileId: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z' },
  { id: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z', trashed: false }
), true);
assert.equal(driveSnapshotIdentityMatches(
  { fileId: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z' },
  { id: 'drive-file-1', modifiedTime: '2026-08-27T08:01:00.000Z', trashed: false }
), false, 'a newer upload during pull confirmation must abort applying the stale snapshot');
assert.equal(driveSnapshotIdentityMatches(
  { fileId: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z' },
  { id: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z', trashed: true }
), false, 'a Drive file deleted during confirmation must not be applied');
assert.equal(driveSnapshotIdentityMatches(
  { fileId: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z', etag: '"etag-1"', version: '4' },
  { id: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z', etag: '"etag-2"', version: '5', trashed: false }
), false, 'an ETag/version change must abort even if Drive reports the same modified timestamp');

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
