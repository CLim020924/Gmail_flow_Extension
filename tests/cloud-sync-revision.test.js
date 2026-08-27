const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const GmailFlowCore = require('../core');

(async () => {
function extractFunctionSource(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain available to the popup sync flow`);
  const asyncStart = start - 6;
  if (asyncStart >= 0 && source.slice(asyncStart, start) === 'async ') start = asyncStart;
  const parametersStart = source.indexOf('(', start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    else if (source[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) { parametersEnd = index; break; }
    }
  }
  const bodyStart = source.indexOf('{', parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function extractFunction(source, name) {
  return vm.runInNewContext(`(${extractFunctionSource(source, name)})`);
}

const tracker = GmailFlowCore.createSyncRevisionTracker();
assert.equal(tracker.dirty, false);

tracker.markDirty();
const uploadedRevision = tracker.capture();
tracker.markDirty();
assert.equal(tracker.markUploaded(uploadedRevision), false);
assert.equal(tracker.dirty, true, 'an edit made during upload must stay dirty');

const latestRevision = tracker.capture();
assert.equal(tracker.markUploaded(latestRevision), true);
assert.equal(tracker.dirty, false, 'only the latest uploaded revision may clear dirty state');

tracker.markDirty();
tracker.clear();
assert.equal(tracker.dirty, false, 'applying a selected cloud snapshot clears local dirty state');

const baselineRosters = [{ id: 'roster-a', name: '기존 명단', rows: [], updatedAt: '2026-01-01T00:00:00Z' }];
const localRosters = [{ id: 'roster-a', name: '이 창에서 변경', rows: [], updatedAt: '2026-01-01T00:01:00Z' }];
const latestRosters = [
  { id: 'roster-b', name: '다른 창에서 추가', rows: [], updatedAt: '2026-01-01T00:02:00Z' },
  baselineRosters[0]
];
const mergedRosters = GmailFlowCore.mergeCloudStorageValue('savedRosters', baselineRosters, localRosters, latestRosters);
assert.deepEqual(mergedRosters.map(({ id, name }) => ({ id, name })), [
  { id: 'roster-a', name: '이 창에서 변경' },
  { id: 'roster-b', name: '다른 창에서 추가' }
], 'a stale full-array save must retain records added by another window');
assert.equal(baselineRosters.length, 1, 'merge must not mutate the renderer baseline');
assert.equal(localRosters.length, 1, 'merge must not mutate the requested local value');
assert.equal(latestRosters.length, 2, 'merge must not mutate the latest persisted value');

const sameRosterBaseline = [{ id: 'roster-a', name: '기존', linkedTemplateId: '', updatedAt: '2026-01-01T00:00:00Z' }];
const sameRosterLocal = [{ id: 'roster-a', name: '이름 변경', linkedTemplateId: '', updatedAt: '2026-01-01T00:01:00Z' }];
const sameRosterLatest = [{ id: 'roster-a', name: '기존', linkedTemplateId: 'template-b', updatedAt: '2026-01-01T00:02:00Z' }];
const mergedSameRoster = GmailFlowCore.mergeCloudStorageValue('savedRosters', sameRosterBaseline, sameRosterLocal, sameRosterLatest);
assert.equal(mergedSameRoster[0].name, '이름 변경');
assert.equal(mergedSameRoster[0].linkedTemplateId, 'template-b', 'independent edits to the same record must be combined');

assert.deepEqual(
  GmailFlowCore.mergeCloudStorageValue('templates', [{ id: 'a', name: 'A' }], [], [{ id: 'a', name: 'A' }]),
  [],
  'an explicit deletion must apply when the stored record is unchanged'
);
assert.deepEqual(
  GmailFlowCore.mergeCloudStorageValue('templates', [{ id: 'a', name: 'A' }], [], [{ id: 'a', name: 'A updated' }]),
  [{ id: 'a', name: 'A updated' }],
  'a concurrent edit must not be destroyed by a stale deletion'
);
assert.deepEqual(
  GmailFlowCore.mergeCloudStorageValue('templates', [{ id: 'a', name: 'A' }], [{ id: 'a', name: 'A' }], []),
  [],
  'an unchanged stale window must not resurrect a record deleted elsewhere'
);

const baselineDraft = {
  columns: [{ id: 'name', name: '이름', role: 'text' }],
  rows: [{ name: '기존 고객' }],
  compose: { subject: '기존 제목', body: '기존 본문', postscript: '' },
  updatedAt: '2026-01-01T00:00:00Z'
};
const localDraft = {
  ...baselineDraft,
  compose: { ...baselineDraft.compose, subject: '이 창의 제목' },
  updatedAt: '2026-01-01T00:01:00Z'
};
const latestDraft = {
  ...baselineDraft,
  rows: [{ name: '다른 창의 고객' }],
  compose: { ...baselineDraft.compose, body: '다른 창의 본문' },
  updatedAt: '2026-01-01T00:02:00Z'
};
const mergedDraft = GmailFlowCore.mergeCloudStorageValue('workspaceDraft', baselineDraft, localDraft, latestDraft);
assert.equal(mergedDraft.compose.subject, '이 창의 제목');
assert.equal(mergedDraft.compose.body, '다른 창의 본문');
assert.equal(mergedDraft.rows[0].name, '다른 창의 고객', 'unchanged draft rows must follow the latest persisted draft');

const rowA = { __gmailFlowRowId: 'row-a', name: '고객 A' };
const rowB = { __gmailFlowRowId: 'row-b', name: '고객 B' };
const concurrentRowBaseline = { rows: [rowA, rowB] };
const concurrentRowLocal = { rows: [rowB] };
const concurrentRowLatest = { rows: [rowA, { ...rowB, name: '고객 B 수정' }] };
const mergedConcurrentRows = GmailFlowCore.mergeCloudStorageValue(
  'workspaceDraft',
  concurrentRowBaseline,
  concurrentRowLocal,
  concurrentRowLatest
);
assert.deepEqual(
  mergedConcurrentRows.rows.map((row) => [row.__gmailFlowRowId, row.name]),
  [['row-b', '고객 B 수정']],
  'deleting one row while another window edits the following row must not duplicate or resurrect either row'
);

const mergedConcurrentInserts = GmailFlowCore.mergeCloudStorageValue(
  'workspaceDraft',
  { rows: [] },
  { rows: [{ __gmailFlowRowId: 'local-row', name: '이 창 추가' }] },
  { rows: [{ __gmailFlowRowId: 'remote-row', name: '다른 창 추가' }] }
);
assert.deepEqual(
  new Set(mergedConcurrentInserts.rows.map((row) => row.__gmailFlowRowId)),
  new Set(['local-row', 'remote-row']),
  'concurrent row insertions with stable identities must both survive'
);

const legacyDraftA = GmailFlowCore.normalizeCloudStorageValue('workspaceDraft', { rows: [{ name: '기존 고객' }] });
const legacyDraftB = GmailFlowCore.normalizeCloudStorageValue('workspaceDraft', { rows: [{ name: '기존 고객' }] });
assert.equal(
  legacyDraftA.rows[0].__gmailFlowRowId,
  legacyDraftB.rows[0].__gmailFlowRowId,
  'legacy rows must receive the same deterministic identity in every window'
);
assert.deepEqual(
  GmailFlowCore.activeRows([{ __gmailFlowRowId: 'blank-row' }, { __gmailFlowRowId: 'active-row', name: '고객' }]),
  [{ __gmailFlowRowId: 'active-row', name: '고객' }],
  'internal row identity metadata must not turn an empty row into a recipient'
);
assert.deepEqual(
  GmailFlowCore.activeRows([{ __gmailFlowRowId: 'polluted-row', undefined: '가짜 값' }], []),
  [],
  'zero-column placeholder pollution must not turn into an active recipient row'
);
const pollutedCompose = GmailFlowCore.validateCompose({ columns: [], rows: [{ undefined: '가짜 값' }], method: '임시 저장' });
assert.equal(pollutedCompose.valid, false, 'a polluted zero-column row must not enable draft creation');
assert.equal(pollutedCompose.rows.length, 0, 'compose validation must only count values belonging to current columns');

const baselineAfterLocalSave = localRosters;
const desiredOnNextSave = localRosters;
const latestAfterMerge = mergedRosters;
assert.deepEqual(
  GmailFlowCore.mergeCloudStorageValue('savedRosters', baselineAfterLocalSave, desiredOnNextSave, latestAfterMerge),
  mergedRosters,
  'the renderer baseline must remain its submitted view so a later save does not infer deletion of remote additions'
);

const popupSource = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const resolveCloudSyncState = extractFunction(popupSource, 'resolveCloudSyncState');
let mismatchedRemoteNetworkCalls = 0;
let mismatchedRemoteApplyCalls = 0;
const remoteAccountHarness = vm.runInNewContext(`
  ${extractFunctionSource(popupSource, 'validateCloudSnapshot')}
  ${extractFunctionSource(popupSource, 'reconcileCloudConflict')}
  ({ validateCloudSnapshot, reconcileCloudConflict });
`, {
  cloudSyncBaselineData: () => null,
  normalizeCloudSyncData: (data) => data,
  cloudSyncTracker: { capture: () => 17 },
  cloudSyncContextMatches: () => true,
  withCloudNetworkLock: async (operation) => {
    mismatchedRemoteNetworkCalls += 1;
    return operation();
  },
  sendRuntimeMessage: async () => { throw new Error('mismatched snapshot must not reach an upload'); },
  applyCloudSnapshot: async () => { mismatchedRemoteApplyCalls += 1; return true; }
});
const otherAccountSnapshot = {
  format: 'gmail-flow-cloud-sync',
  schemaVersion: 1,
  accountEmail: 'account-a@example.com',
  data: { savedRosters: [], templates: [], structureTemplates: [], workspaceDraft: null }
};
assert.throws(
  () => remoteAccountHarness.validateCloudSnapshot(otherAccountSnapshot, 'account-b@example.com'),
  (error) => error?.code === 'ACCOUNT_MISMATCH'
);
await assert.rejects(
  remoteAccountHarness.reconcileCloudConflict({
    remote: { file: { id: 'account-b-file' }, snapshot: otherAccountSnapshot },
    localData: { savedRosters: [], templates: [], structureTemplates: [], workspaceDraft: null },
    expectedRevision: 17,
    expectedContext: { account: 'account-b@example.com' }
  }),
  (error) => error?.code === 'ACCOUNT_MISMATCH'
);
assert.equal(mismatchedRemoteNetworkCalls, 0, 'a remote snapshot labeled for another account must fail before upload/PATCH');
assert.equal(mismatchedRemoteApplyCalls, 0, 'a remote snapshot labeled for another account must fail before local storage apply');
assert.throws(
  () => remoteAccountHarness.validateCloudSnapshot({ ...otherAccountSnapshot, accountEmail: '' }, 'account-b@example.com'),
  (error) => error?.code === 'ACCOUNT_MISMATCH',
  'missing legacy account metadata must fail closed because released snapshots always included accountEmail'
);
const syncedData = {
  savedRosters: [],
  templates: [],
  structureTemplates: [],
  workspaceDraft: { compose: { subject: 'Drive에 저장된 제목' } }
};
assert.equal(resolveCloudSyncState(true, syncedData, structuredClone(syncedData)), 'clean');
assert.equal(
  resolveCloudSyncState(true, {
    ...syncedData,
    workspaceDraft: { compose: { subject: '창으로 열기 직전에 저장한 제목' } }
  }, syncedData),
  'upload-local',
  'replacing or reopening a renderer must upload local data that diverged while the Drive file metadata stayed unchanged'
);
assert.equal(
  resolveCloudSyncState(false, syncedData, syncedData),
  'remote-changed',
  'changed Drive metadata must continue through the remote reconciliation path'
);
assert.match(
  popupSource,
  /syncResolution === 'upload-local'[\s\S]*cloudSyncTracker\.markDirty\(\)[\s\S]*uploadCloudData/,
  'the popup must mark renderer-replacement differences dirty and upload them'
);

const metadataState = {
  connectedEmail: 'sync@example.com',
  cloudSyncMeta: {
    accountEmail: 'sync@example.com',
    fileId: 'cloud-file',
    modifiedTime: '2026-08-27T00:00:00.000Z'
  }
};
const metadataHelpers = vm.runInNewContext(`
  ${extractFunctionSource(popupSource, 'expectedCloudFileFromMeta')}
  ${extractFunctionSource(popupSource, 'cloudSyncMetaMatchesFile')}
  ({ cloudSyncMetaMatchesFile });
`, { state: metadataState });
const observedCloudFile = { id: 'cloud-file', modifiedTime: '2026-08-27T00:00:00.000Z', version: '7', etag: 'etag-7' };
assert.equal(metadataHelpers.cloudSyncMetaMatchesFile(observedCloudFile), false, 'legacy metadata without a Drive generation or ETag must not authorize an upload-local decision');
metadataState.cloudSyncMeta.version = '7';
assert.equal(metadataHelpers.cloudSyncMetaMatchesFile(observedCloudFile), true, 'a matching Drive generation may establish the upload baseline');

const cloudHelpers = vm.runInNewContext(`
  ${extractFunctionSource(popupSource, 'defaultCloudSyncData')}
  ${extractFunctionSource(popupSource, 'normalizeCloudSyncData')}
  ${extractFunctionSource(popupSource, 'cloudSyncConflictSections')}
  ${extractFunctionSource(popupSource, 'applyPreferredCloudArrayDeletions')}
  ${extractFunctionSource(popupSource, 'mergeCloudSyncData')}
  ({ cloudSyncConflictSections, mergeCloudSyncData });
`, { GmailFlowCore, CLOUD_SYNC_KEYS: ['savedRosters', 'templates', 'structureTemplates', 'workspaceDraft'] });

const threeWayBase = {
  savedRosters: [{ id: 'roster-a', name: '기존 명단' }], templates: [], structureTemplates: [],
  workspaceDraft: { compose: { subject: '기존 제목', body: '기존 본문' } }
};
const threeWayLocal = {
  ...structuredClone(threeWayBase),
  savedRosters: [{ id: 'roster-a', name: '이 PC 명단' }]
};
const threeWayRemote = {
  ...structuredClone(threeWayBase),
  templates: [{ id: 'template-b', name: 'Drive 양식' }]
};
assert.deepEqual([...cloudHelpers.cloudSyncConflictSections(threeWayBase, threeWayLocal, threeWayRemote)], []);
const independentMerge = cloudHelpers.mergeCloudSyncData(threeWayBase, threeWayLocal, threeWayRemote, 'local');
assert.equal(independentMerge.savedRosters[0].name, '이 PC 명단');
assert.equal(independentMerge.templates[0].name, 'Drive 양식', 'independent cross-PC changes must both survive the three-way merge');

const scalarLocal = structuredClone(threeWayBase);
scalarLocal.workspaceDraft.compose.subject = '이 PC 제목';
const scalarRemote = structuredClone(threeWayBase);
scalarRemote.workspaceDraft.compose.subject = 'Drive 제목';
assert.deepEqual([...cloudHelpers.cloudSyncConflictSections(threeWayBase, scalarLocal, scalarRemote)], ['workspaceDraft'], 'same-section concurrent edits must enter the explicit conflict path');
assert.equal(cloudHelpers.mergeCloudSyncData(threeWayBase, scalarLocal, scalarRemote, 'local').workspaceDraft.compose.subject, '이 PC 제목');
assert.equal(cloudHelpers.mergeCloudSyncData(threeWayBase, scalarLocal, scalarRemote, 'remote').workspaceDraft.compose.subject, 'Drive 제목');

const deletionConflictBase = {
  savedRosters: [{ id: 'roster-delete', name: '기존 명단' }],
  templates: [{ id: 'template-delete', name: '기존 양식' }],
  structureTemplates: [],
  workspaceDraft: null
};
const deletionConflictLocal = {
  ...structuredClone(deletionConflictBase),
  savedRosters: [],
  templates: [{ id: 'template-delete', name: '이 PC에서 수정한 양식' }]
};
const deletionConflictRemote = {
  ...structuredClone(deletionConflictBase),
  savedRosters: [{ id: 'roster-delete', name: 'Drive에서 수정한 명단' }],
  templates: []
};
const localDeletionPreference = cloudHelpers.mergeCloudSyncData(
  deletionConflictBase, deletionConflictLocal, deletionConflictRemote, 'local'
);
assert.deepEqual(localDeletionPreference.savedRosters, [], 'this-PC preference must preserve a local roster deletion against a Drive edit');
assert.equal(localDeletionPreference.templates[0].name, '이 PC에서 수정한 양식', 'this-PC preference must preserve a local template edit against a Drive deletion');
const remoteDeletionPreference = cloudHelpers.mergeCloudSyncData(
  deletionConflictBase, deletionConflictLocal, deletionConflictRemote, 'remote'
);
assert.equal(remoteDeletionPreference.savedRosters[0].name, 'Drive에서 수정한 명단', 'Drive preference must preserve a Drive roster edit against a local deletion');
assert.deepEqual(remoteDeletionPreference.templates, [], 'Drive preference must preserve a Drive template deletion against a local edit');

const rowDeletionBase = {
  savedRosters: [], templates: [], structureTemplates: [],
  workspaceDraft: { rows: [{ __gmailFlowRowId: 'row-delete', name: '기존 고객' }] }
};
const rowDeletionLocal = structuredClone(rowDeletionBase);
rowDeletionLocal.workspaceDraft.rows = [];
const rowDeletionRemote = structuredClone(rowDeletionBase);
rowDeletionRemote.workspaceDraft.rows[0].name = 'Drive에서 수정한 고객';
assert.deepEqual(
  cloudHelpers.mergeCloudSyncData(rowDeletionBase, rowDeletionLocal, rowDeletionRemote, 'local').workspaceDraft.rows,
  [],
  'this-PC preference must preserve a nested roster-row deletion against a Drive edit'
);
assert.equal(
  cloudHelpers.mergeCloudSyncData(rowDeletionBase, rowDeletionLocal, rowDeletionRemote, 'remote').workspaceDraft.rows[0].name,
  'Drive에서 수정한 고객',
  'Drive preference must preserve a nested roster-row edit against a local deletion'
);

assert.match(popupSource, /cloud-sync-upload'[\s\S]*expectedFile/, 'every popup upload must carry the last observed remote identity');
assert.match(popupSource, /\['CLOUD_SYNC_CONFLICT', 'CLOUD_SYNC_BASELINE_REQUIRED'\][\s\S]*reconcileCloudConflict/, 'remote mismatch must re-download and reconcile instead of blind retry');
assert.match(popupSource, /applyCloudSnapshot[\s\S]*cloud-sync-verify[\s\S]*withCloudStorageLock/, 'downloaded data must be revalidated before local apply starts');
assert.match(popupSource, /error\.code = response\?\.code/, 'runtime conflict codes must reach the popup reconciliation path');
const initializeSource = extractFunctionSource(popupSource, 'initializeCloudSync');
assert.ok(initializeSource.indexOf("type: 'cloud-sync-download'") < initializeSource.indexOf("syncResolution === 'upload-local'"), 'initialization must observe Drive before deciding that local data is safe to upload');

console.log('cloud sync revision tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
