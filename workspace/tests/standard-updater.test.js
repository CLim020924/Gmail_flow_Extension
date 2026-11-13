const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { StandardUpdater, publicCheckResult } = require('../desktop/standard-updater');

class FakeUpdater extends EventEmitter {
  constructor(result) { super(); this.result = result; this.installCalls = []; }
  async checkForUpdates() { return this.result; }
  async downloadUpdate(token) {
    this.downloadToken = token;
    this.emit('download-progress', { transferred: 50, total: 100, percent: 50 });
    this.emit('update-downloaded', this.result.updateInfo);
    return ['C:/synthetic/update.exe'];
  }
  quitAndInstall(...args) { this.installCalls.push(args); }
}

(async () => {
  const result = {
    isUpdateAvailable: true,
    updateInfo: { version: '1.16.0', files: [{ url: 'CMOE-Workspace-Setup-1.16.0-Windows.exe', size: 100 }], releaseNotes: '표준 업데이터\n전체 창 종료' },
    cancellationToken: { canceled: false, cancel() { this.canceled = true; } }
  };
  assert.deepEqual(publicCheckResult('1.15.46', result), { currentVersion: '1.15.46', available: true, feed: { version: '1.16.0', bytes: 100, notes: ['표준 업데이터', '전체 창 종료'] } });
  const events = [];
  const fake = new FakeUpdater(result);
  const updater = new StandardUpdater({ autoUpdater: fake, currentVersion: '1.15.46', packaged: true, portable: false, broadcast: (event) => events.push(event), logger: { info() {}, warn() {}, error() {} } });
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.equal(fake.autoRunAppAfterInstall, true);
  assert.equal(fake.disableWebInstaller, true);
  assert.equal((await updater.check()).available, true);
  assert.deepEqual(await updater.download(), { ready: true, version: '1.16.0' });
  assert(events.some((event) => event.stage === 'downloading' && event.percent === 50));
  assert(events.some((event) => event.stage === 'verified' && event.percent === 100));
  updater.install();
  assert.deepEqual(fake.installCalls, [[false, true]]);
  assert.throws(() => updater.install(), /준비되지 않았습니다/);

  const cancelFake = new FakeUpdater(result);
  let resolveDownload;
  cancelFake.downloadUpdate = () => new Promise((resolve) => { resolveDownload = resolve; });
  const cancelUpdater = new StandardUpdater({ autoUpdater: cancelFake, currentVersion: '1.15.46', packaged: true, portable: false, logger: { info() {}, warn() {}, error() {} } });
  await cancelUpdater.check();
  const pending = cancelUpdater.download();
  assert.equal(cancelUpdater.cancel().canceled, true);
  assert.equal(result.cancellationToken.canceled, true);
  resolveDownload([]);
  await pending;

  await assert.rejects(new StandardUpdater({ autoUpdater: new FakeUpdater(null), currentVersion: '1.15.46', packaged: false, portable: false }).check(), /개발 실행/);
  console.log('standard updater tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
