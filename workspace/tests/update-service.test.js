const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../desktop/update-service');

const feed = {
  schemaVersion: 1, product: 'cmoe-workspace', platform: 'windows-x64', version: '1.5.10', bytes: 123,
  sha256: 'a'.repeat(64), url: 'https://github.com/CLim020924/cresero-downloads/releases/download/cmoe-workspace-v1.5.10/CMOE-Workspace-Setup-1.5.10-Windows.exe', notes: ['변경']
};

(async () => {
  assert.equal(updater.compareVersions('1.5.10', '1.5.4'), 1);
  assert.equal(updater.compareVersions('1.3.0', '1.3.0'), 0);
  assert.equal(updater.compareVersions('1.2.9', '1.3.0'), -1);
  assert.throws(() => updater.validateFeed({ ...feed, product: 'other' }), /다른 제품/);
  assert.throws(() => updater.validateFeed({ ...feed, url: 'https://example.com/update.exe' }), /허용되지 않은/);
  assert.throws(() => updater.validateFeed({ ...feed, version: '1.5.11' }), /버전과 공식 설치 파일 경로/);
  const checked = await updater.checkForUpdate('1.3.0', async (url, options) => {
    assert.equal(url, updater.FEED_URL); assert.equal(options.redirect, 'error');
    return { ok: true, status: 200, json: async () => feed };
  });
  assert.equal(checked.available, true);
  const command = updater.helperCommand({ installerPath: `C:/Temp/test's setup.exe`, expectedSha256: 'a'.repeat(64), expectedBytes: 123, expectedVersion: '1.5.10', appPath: 'C:/Apps/CMOE Workspace.exe', pid: 123 });
  assert.match(command, /Get-Process -Id 123/); assert.match(command, /\.Path/); assert.match(command, /Wait-Process -Id 123/); assert.match(command, /\.Length -ne 123/); assert.match(command, /Get-FileHash/); assert.match(command, /FileVersion/); assert.match(command, /1\.5\.10/); assert.match(command, /test''s setup\.exe/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-update-cancel-'));
  const cancelController = new AbortController(); cancelController.abort();
  const oneByte = Buffer.from([0]);
  const cancelFeed = { ...feed, bytes: oneByte.length, sha256: crypto.createHash('sha256').update(oneByte).digest('hex') };
  try {
    await assert.rejects(
      updater.downloadInstaller(cancelFeed, path.join(directory, 'update.exe'), async (_url, options) => {
        if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
        throw new Error('the aborted request must not continue');
      }, () => {}, { signal: cancelController.signal }),
      /취소/
    );
    assert.equal(fs.existsSync(path.join(directory, 'update.exe.partial')), false, 'a canceled update must remove the partial installer');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('update-service tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
