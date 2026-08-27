const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DriveSyncGuardStore, connectionGuardKey, drivePayloadsEqual, isUsableDriveEtag } = require('../desktop/drive-sync-guard');
const { JsonStorage } = require('../desktop/storage');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-drive-guard-'));
  const filePath = path.join(directory, 'workspace-data.json');
  const connection = { id: 'drive-1', type: 'drive', account: ' User@Example.com ' };
  const storage = new JsonStorage(filePath);
  const store = new DriveSyncGuardStore(storage, { now: () => '2026-08-27T09:00:00.000Z' });

  assert.equal(connectionGuardKey(connection), '["drive-1","drive","user@example.com"]');
  assert.equal(isUsableDriveEtag('"strong"'), true);
  assert.equal(isUsableDriveEtag('W/"weak"'), false, 'weak ETags cannot protect conditional writes');
  assert.equal(drivePayloadsEqual({ b: 2, a: { y: 1, x: 0 } }, { a: { x: 0, y: 1 }, b: 2 }), true, 'payload comparison must ignore object key order');
  assert.equal(drivePayloadsEqual({ projects: [{ id: 'a' }] }, { projects: [{ id: 'b' }] }), false);
  const preGuardRemote = { format: 'cmoe-workspace', version: 2, _revision: 9, projects: [{ id: 'project-1', name: '기존 일정' }], preferences: { storageMode: 'drive' } };
  const upgradedLocal = { preferences: { storageMode: 'drive' }, projects: [{ name: '기존 일정', id: 'project-1' }], _revision: 9, version: 2, format: 'cmoe-workspace' };
  assert.equal(drivePayloadsEqual(upgradedLocal, preGuardRemote), true, 'an upgrade from the pre-guard release may safely adopt an identical stable remote payload');
  assert.equal(drivePayloadsEqual({ ...upgradedLocal, projects: [{ id: 'project-1', name: '로컬에서 변경' }] }, preGuardRemote), false, 'baseline migration must not approve a locally changed payload');
  assert.equal(await store.get(connection), null);

  await store.observeRemote(connection, { fileId: 'file-1', etag: '"etag-1"', modifiedTime: '2026-08-27T08:00:00.000Z', version: '7' });
  assert.deepEqual(await store.get(connection), {
    state: 'ready', fileId: 'file-1', etag: '"etag-1"', modifiedTime: '2026-08-27T08:00:00.000Z', version: '7', reason: '', observedAt: '2026-08-27T09:00:00.000Z'
  });

  const reloaded = new DriveSyncGuardStore(new JsonStorage(filePath));
  assert.equal((await reloaded.get(connection)).etag, '"etag-1"', 'the last acknowledged remote version must survive an app restart');
  await reloaded.markConflict(connection, 'remote changed', { fileId: 'file-1', etag: '"etag-1"' });
  assert.equal((await reloaded.get(connection)).state, 'conflict', 'a conflict must remain latched until a verified pull');
  await reloaded.observeEmpty(connection);
  assert.equal((await reloaded.get(connection)).state, 'empty', 'an explicit empty-remote observation may unlock first creation');
  await reloaded.observeRemote(connection, { fileId: 'file-1', etag: '"etag-2"' });
  assert.equal((await reloaded.get(connection)).state, 'ready', 'a verified pull clears the conflict latch with its exact ETag');

  const differentAccount = { ...connection, account: 'other@example.com' };
  assert.equal(await reloaded.get(differentAccount), null, 'a different signed-in account must never inherit another account baseline');
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('drive-sync-guard tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
