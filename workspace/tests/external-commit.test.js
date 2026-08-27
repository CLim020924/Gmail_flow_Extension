const assert = require('node:assert/strict');
const Core = require('../workspace-core');
const Ops = require('../operations-core');
const { mergeSelectedWorkspaceState, resolveExternalCommit, validateExternalCommit } = require('../desktop/external-commit');

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = Date.now();
const ownerId = 17;

let state = Core.createEmptyState();
({ state } = Core.addConnection(state, { id: 'zoom-1', type: 'zoom', label: 'Zoom 업무 계정', account: 'owner@example.com', status: 'connected' }));
let created;
({ state, project: created } = Core.createProject(state, {
  id: 'project-1',
  name: '동시 저장 테스트',
  installedModules: ['people', 'schedule', 'zoom'],
  data: {
    slots: [
      { id: 'slot-1', date: '2026-09-01', startTime: '09:00', endTime: '10:00', status: 'confirmed' },
      { id: 'slot-2', date: '2026-09-01', startTime: '10:00', endTime: '11:00', status: 'confirmed' }
    ],
    assignments: [{ id: 'assignment-1', slotId: 'slot-1', personId: 'person-1', roleId: 'member' }],
    people: [
      { id: 'person-1', name: '테스트 사용자', email: 'person@example.com', roleIds: ['member'], values: {} },
      { id: 'person-2', name: '삭제 대상', email: 'remove@example.com', roleIds: ['member'], values: {} }
    ],
    externalArtifacts: []
  },
  settings: { defaultConnectionIds: { zoom: 'zoom-1' } }
}));
state = Core.normalizeState(state);
state._revision = 4;
state._baseRevision = 4;
const project = state.projects.find((item) => item.id === created.id);
const connection = state.connections.find((item) => item.id === 'zoom-1');
const reservations = new Map([[
  'project-1:zoom:slot-1',
  { token: 'reservation-token', ownerId, expiresAt: now + 60_000 }
], [
  'project-1:zoom:slot-2',
  { token: 'reservation-token', ownerId, expiresAt: now + 60_000 }
]]);
const incoming = clone(state);
incoming.projects[0].data.externalArtifacts.push({ kind: 'zoom', slotId: 'slot-1', connectionId: 'zoom-1', externalId: 'meeting-1', status: 'created' });
const conflictState = clone(incoming);
conflictState.projects[0].data.externalArtifacts[0].status = 'stale';
conflictState.projects[0].moduleState.zoom.status = 'needsReview';
const guard = {
  token: 'reservation-token',
  projectId: 'project-1',
  kind: 'zoom',
  reservationKeys: ['slot-1', 'slot-2'],
  expectedFingerprint: Ops.externalOperationFingerprint(project, 'zoom', state.connections),
  expectedConnections: [Core.connectionIdentity(connection)],
  conflictState
};

const normalCommit = resolveExternalCommit(state, incoming, guard, reservations, ownerId, now);
assert.equal(normalCommit.ok, true);
assert.equal(normalCommit.state.projects[0].data.externalArtifacts[0].status, 'created');

const concurrentlyEditedProject = clone(state);
concurrentlyEditedProject.projects[0].data.slots[0].startTime = '09:30';
concurrentlyEditedProject._revision = 5;
concurrentlyEditedProject._baseRevision = 5;
const projectRace = resolveExternalCommit(concurrentlyEditedProject, incoming, guard, reservations, ownerId, now);
assert.equal(projectRace.ok, false, 'a project edit after the renderer check must fail the active-result guard');
assert.equal(projectRace.state.projects[0].data.externalArtifacts[0].status, 'stale', 'the external result must remain as a reviewable orphan instead of active');
assert.equal(projectRace.state.projects[0].moduleState.zoom.status, 'needsReview');

const rendererBase = clone(state);
const concurrentlyEditedRoster = clone(state);
concurrentlyEditedRoster._revision = 5;
concurrentlyEditedRoster._baseRevision = 5;
concurrentlyEditedRoster.projects[0].data.people = concurrentlyEditedRoster.projects[0].data.people
  .filter((person) => person.id !== 'person-2')
  .map((person) => person.id === 'person-1' ? { ...person, email: 'edited@example.com' } : person);
const rosterRace = resolveExternalCommit(concurrentlyEditedRoster, incoming, guard, reservations, ownerId, now);
assert.equal(rosterRace.ok, false, 'the authoritative project fingerprint must reject a roster edit in the final save gap');
const mergedRosterRace = mergeSelectedWorkspaceState(concurrentlyEditedRoster, rosterRace.state, { baseState: rendererBase });
const mergedProject = mergedRosterRace.state.projects.find((item) => item.id === 'project-1');
assert.equal(mergedRosterRace.merged, true, 'the conflict fallback must take the same revision merge path used by main workspace saves');
assert.equal(mergedProject.data.people.some((person) => person.id === 'person-2'), false, 'the concurrent person deletion must survive fallback merging');
assert.equal(mergedProject.data.people.find((person) => person.id === 'person-1').email, 'edited@example.com', 'the concurrent email edit must survive fallback merging');
assert.deepEqual(mergedProject.data.externalArtifacts.map((artifact) => [artifact.externalId, artifact.status]), [['meeting-1', 'stale']], 'only the newly created orphan artifact is added and it remains review-only');

const concurrentlySwitchedAccount = clone(state);
concurrentlySwitchedAccount.connections[0].account = 'other@example.com';
concurrentlySwitchedAccount.connections[0].updatedAt = '2026-09-01T00:00:01.000Z';
const accountRace = resolveExternalCommit(concurrentlySwitchedAccount, incoming, guard, reservations, ownerId, now);
assert.equal(accountRace.ok, false, 'an account change after the renderer check must fail the active-result guard');
assert.match(accountRace.reason, /계정/);
assert.equal(accountRace.state.projects[0].data.externalArtifacts[0].status, 'stale');

const archivedDuringOperation = clone(state);
archivedDuringOperation.projects[0].status = 'archived';
assert.equal(
  resolveExternalCommit(archivedDuringOperation, incoming, guard, reservations, ownerId, now).ok,
  false,
  'archiving a project while an external API call is running must force the result into review-only fallback'
);
const moduleRemovedDuringOperation = clone(state);
moduleRemovedDuringOperation.projects[0].installedModules = moduleRemovedDuringOperation.projects[0].installedModules.filter((moduleId) => moduleId !== 'zoom');
assert.equal(
  resolveExternalCommit(moduleRemovedDuringOperation, incoming, guard, reservations, ownerId, now).ok,
  false,
  'removing the target module while an external API call is running must reject an active result commit'
);

const missingBatchKey = new Map(reservations);
missingBatchKey.delete('project-1:zoom:slot-2');
assert.equal(validateExternalCommit(state, guard, missingBatchKey, ownerId, now).ok, false, 'losing any key from a batch reservation must reject the active result');
assert.equal(validateExternalCommit(state, { ...guard, reservationKeys: ['slot-1'] }, reservations, ownerId, now).ok, false, 'a guard cannot validate only a subset of the token reservation');
assert.equal(validateExternalCommit(state, guard, reservations, ownerId + 1, now).ok, false, 'another renderer cannot use the reservation owner commit');
assert.equal(validateExternalCommit(state, guard, reservations, ownerId, now + 120_000).ok, false, 'an expired external operation cannot commit an active result');

console.log('external commit tests passed');
