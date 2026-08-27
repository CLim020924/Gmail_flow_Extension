const assert = require('node:assert/strict');
const { GmailFlowHost } = require('../desktop/gmail-flow-host');

(async () => {
  const host = new GmailFlowHost({
    app: {}, BrowserWindow: {}, ipcMain: {}, safeStorage: {}, shell: {}, rootPath: '', showWindow: () => {}
  });
  const data = { savedRosters: [{ id: 'existing', name: '기존 명단' }] };
  let blockStorageWrite = false;
  let failStorageWrite = false;
  let releaseStorageWrite;
  host.storage = {
    async get(keys) {
      assert.equal(typeof keys, 'object', 'desktop JsonStorage defaults must be requested as an object');
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, Object.hasOwn(data, key) ? data[key] : fallback]));
    },
    async set(values) {
      assert.equal(typeof values, 'object', 'desktop JsonStorage writes must use an object payload');
      if (blockStorageWrite) {
        blockStorageWrite = false;
        await new Promise((resolve) => { releaseStorageWrite = resolve; });
      }
      if (failStorageWrite) {
        failStorageWrite = false;
        throw new Error('simulated storage failure');
      }
      Object.assign(data, values);
    }
  };

  const roster = {
    id: 'shared-1', name: 'Workspace 명단', savedAt: '2026-08-27T00:00:00.000Z',
    columns: [{ id: 'name', name: '이름', type: 'name' }],
    people: [{ id: 'person-1', values: { name: '김고객' } }]
  };
  assert.deepEqual(await host.importLegacyRosters([roster]), { imported: 1 });
  assert.equal(data.savedRosters.length, 2);
  assert.equal(data.savedRosters[0].id, 'workspace-shared-1');
  assert.equal(data.workspaceRosterMigrationV1, true);
  assert.deepEqual(await host.importLegacyRosters([roster]), { imported: 0 }, 'migration marker must make repeated startup idempotent');

  let oauthClearCount = 0;
  host.oauth = {
    getToken: async () => 'token',
    invalidateAccessToken: async () => {},
    clear: async () => { oauthClearCount += 1; },
    getProfile: async () => ({ email: 'sender@example.com' })
  };
  host.timers = new Map(); host.alarmListeners = new Set(); host.runtimeListeners = new Set(); host.startupListeners = new Set(); host.installedListeners = new Set();
  host.createChromeCompatibility();
  const ipcHandlers = new Map();
  host.ipcMain = { handle: (name, handler) => ipcHandlers.set(name, handler) };
  host.registerIpc();
  const events = [];
  let releaseMailOperation;
  const mailOperation = global.chrome.identity.runAccountOperation(async () => {
    events.push('mail-start');
    await new Promise((resolve) => { releaseMailOperation = resolve; });
    events.push('mail-end');
  });
  while (!releaseMailOperation) await new Promise((resolve) => setTimeout(resolve, 0));
  const accountTransition = host.runCloudIdentityOperation(async () => { events.push('account-transition'); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['mail-start'], 'account transition must wait for an active background Gmail operation');
  releaseMailOperation();
  await Promise.all([mailOperation, accountTransition]);
  assert.deepEqual(events, ['mail-start', 'mail-end', 'account-transition']);

  host.runtimeListeners.add((message, _sender, sendResponse) => {
    if (!['prepare-mail-queue-for-quit', 'resume-mail-queue-after-quit-canceled'].includes(message.type)) throw new Error('unexpected runtime message');
    setTimeout(() => sendResponse({ ok: true, data: message.type === 'prepare-mail-queue-for-quit' ? { idle: true } : { resumed: true } }), 0);
    return true;
  });
  let releasePendingIdentity;
  const pendingIdentity = host.runCloudIdentityOperation(async () => {
    await new Promise((resolve) => { releasePendingIdentity = resolve; });
  });
  while (!releasePendingIdentity) await new Promise((resolve) => setTimeout(resolve, 0));
  blockStorageWrite = true;
  const pendingStorageWrite = ipcHandlers.get('storage:set')({}, { pendingDuringQuit: true });
  while (!releaseStorageWrite) await new Promise((resolve) => setTimeout(resolve, 0));
  let flushSettled = false;
  const flush = host.flushMailQueue().then((result) => { flushSettled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(flushSettled, false, 'quit flush must wait for OAuth transitions and renderer storage writes already in flight');
  releaseStorageWrite();
  await pendingStorageWrite;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(flushSettled, false, 'finishing storage alone must not bypass a pending OAuth transition');
  releasePendingIdentity();
  assert.deepEqual(await flush, { idle: true }, 'host quit flush must wait through the background and identity runtime boundaries');
  await pendingIdentity;
  await assert.rejects(() => host.dispatchRuntimeMessage({ type: 'enqueue-mail-batch', payload: {} }), (error) => error.code === 'APP_SHUTTING_DOWN', 'runtime work arriving after the quit barrier must be rejected');
  await assert.rejects(() => host.dispatchRuntimeMessage({ type: 'resume-mail-queue-after-quit-canceled' }), (error) => error.code === 'APP_SHUTTING_DOWN', 'a renderer must not reopen the queue while the main process is still flushing for quit');
  await assert.rejects(() => ipcHandlers.get('identity:clear-auth-tokens')(), (error) => error.code === 'APP_SHUTTING_DOWN', 'OAuth transitions arriving after the quit barrier must be rejected');
  await assert.rejects(() => ipcHandlers.get('storage:set')({}, { lateWrite: true }), (error) => error.code === 'APP_SHUTTING_DOWN', 'storage writes arriving after the quit barrier must be rejected');
  assert.equal(data.lateWrite, undefined);
  assert.equal(oauthClearCount, 0);
  assert.deepEqual(await host.resumeMailQueue(), { resumed: true });
  await ipcHandlers.get('storage:set')({}, { afterQuitCanceled: true });
  assert.equal(data.afterQuitCanceled, true, 'storage writes must work again after quit is canceled');
  await ipcHandlers.get('identity:clear-auth-tokens')();
  assert.equal(oauthClearCount, 1, 'OAuth transitions must work again after quit is canceled');

  blockStorageWrite = true;
  failStorageWrite = true;
  releaseStorageWrite = null;
  const failedStorageWrite = ipcHandlers.get('storage:set')({}, { mustNotPersist: true });
  const observedStorageFailure = failedStorageWrite.catch((error) => error);
  while (!releaseStorageWrite) await new Promise((resolve) => setTimeout(resolve, 0));
  const failedFlush = host.flushMailQueue();
  while (!host.shutdownPrepared) await new Promise((resolve) => setTimeout(resolve, 0));
  releaseStorageWrite();
  assert.match((await observedStorageFailure).message, /simulated storage failure/);
  await assert.rejects(failedFlush, /simulated storage failure/, 'quit flush must fail if an in-flight durable storage write fails');
  assert.equal(data.mustNotPersist, undefined);
  assert.deepEqual(await host.resumeMailQueue(), { resumed: true });

  console.log('gmail-flow-host tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
