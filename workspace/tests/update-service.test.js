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
  assert.equal(updater.compareVersions('1.15.29', '1.15.28'), 1);
  assert.equal(updater.compareVersions('1.15.3', '1.15.28'), -1);
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
  assert.match(command, /Get-Process -Id 123/); assert.match(command, /SilentlyContinue/); assert.match(command, /try\{\$targetPath=\$target\.Path\}catch\{\}/); assert.match(command, /Get-CimInstance Win32_Process/); assert.match(command, /APP_PROCESSES_STILL_RUNNING/); assert.match(command, /System\.Windows\.Forms\.Form/); assert.match(command, /CmoeNativeWindow/); assert.match(command, /ShowWindow\(\$form\.Handle,5\)/); assert.match(command, /ShowInTaskbar=\$true/); assert.match(command, /ControlBox=\$false/); assert.match(command, /PROGRAM UPDATE/); assert.match(command, /Set-Stage 2 '설치 파일을 최종 검증/); assert.match(command, /Set-Stage 4 '설치된 새 버전을 확인/); assert.match(command, /Set-Determinate/); assert.match(command, /Set-Activity/); assert.match(command, /설치 중 · /); assert.doesNotMatch(command, /System\.Windows\.Forms\.ProgressBar/); assert.match(command, /update-helper\.log/); assert.match(command, /helper ready/); assert.match(command, /ERROR '\+\$_.Exception.Message/); assert.match(command, /업데이트를 설치하고 있습니다/); assert.match(command, /while\(!\$process\.HasExited\)/); assert.doesNotMatch(command, /Wait-Process -Id 123 -ErrorAction Stop/); assert.match(command, /-ArgumentList '\/S' -PassThru/); assert.doesNotMatch(command, /-ArgumentList '\/S','--updated'/); assert.match(command, /\.Length -ne 123/); assert.doesNotMatch(command, /Get-FileHash/); assert.match(command, /Security\.Cryptography\.SHA256/); assert.match(command, /TransformBlock/); assert.match(command, /BitConverter/); assert.match(command, /FileVersion/); assert.match(command, /Start-Process -FilePath \$app -ArgumentList '--updated'/); assert.match(command, /--update-failed/); assert.match(command, /1\.5\.10/); assert.match(command, /test''s setup\.exe/);
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
    const progressEvents = [];
    const downloaded = await updater.downloadInstaller(cancelFeed, path.join(directory, 'update.exe'), async () => new Response(oneByte, { status: 200, headers: { 'content-length': String(oneByte.length) } }), (progress) => progressEvents.push(progress));
    assert.equal(fs.readFileSync(downloaded).equals(oneByte), true);
    assert.deepEqual([...new Set(progressEvents.map(({ stage }) => stage))], ['connecting', 'downloading', 'verifying', 'verified']);
    assert.equal(progressEvents.at(-1).percent, 100);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const backupFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-update-backup-'));
  try {
    const dataRoot = path.join(backupFixture, 'user-data');
    const backupRoot = path.join(backupFixture, 'backups');
    fs.mkdirSync(path.join(dataRoot, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'workspace-data.json'), '{"project":"synthetic"}');
    fs.writeFileSync(path.join(dataRoot, 'extensions', 'sample.cmoe-extension'), '{"id":"synthetic"}');
    const backup = await updater.createUpdateDataBackup({
      version: '1.15.2', backupRoot,
      entries: [
        { source: path.join(dataRoot, 'workspace-data.json'), relativePath: 'workspace/workspace-data.json' },
        { source: path.join(dataRoot, 'extensions'), relativePath: 'workspace/extensions' },
        { source: path.join(dataRoot, 'missing.json'), relativePath: 'workspace/missing.json' }
      ]
    });
    assert.equal(fs.readFileSync(path.join(backup.snapshotPath, 'workspace', 'workspace-data.json'), 'utf8'), '{"project":"synthetic"}');
    assert.equal(fs.existsSync(path.join(backup.snapshotPath, 'workspace', 'extensions', 'sample.cmoe-extension')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.snapshotPath, 'backup-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.entries, ['workspace/workspace-data.json', 'workspace/extensions']);
    await assert.rejects(
      updater.createUpdateDataBackup({ version: '1.15.2', backupRoot: path.join(dataRoot, 'nested-backup'), entries: [{ source: dataRoot, relativePath: 'workspace' }] }),
      /겹칩/
    );
  } finally { fs.rmSync(backupFixture, { recursive: true, force: true }); }
  console.log('update-service tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
