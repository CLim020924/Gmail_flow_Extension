const assert = require('node:assert/strict');
const { mergeWorkspaceState, mergeScheduleArtifacts, overlayScheduleProjects } = require('../desktop/state-merge');

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
assert.equal(scheduleMerged.data.slots[0].startTime, '10:00');
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
console.log('state-merge tests passed');
