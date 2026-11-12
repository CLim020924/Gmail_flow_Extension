const assert = require('node:assert/strict');
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
  const checked = await updater.checkForUpdate('1.3.0', async (url, options) => {
    assert.equal(url, updater.FEED_URL); assert.equal(options.redirect, 'error');
    return { ok: true, status: 200, json: async () => feed };
  });
  assert.equal(checked.available, true);
  const command = updater.helperCommand({ installerPath: `C:/Temp/test's setup.exe`, expectedSha256: 'a'.repeat(64), appPath: 'C:/Apps/CMOE Workspace.exe', pid: 123 });
  assert.match(command, /Wait-Process -Id 123/); assert.match(command, /Get-FileHash/); assert.match(command, /test''s setup\.exe/);
  console.log('update-service tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
