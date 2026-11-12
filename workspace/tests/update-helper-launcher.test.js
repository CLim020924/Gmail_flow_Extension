const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launcher = require('../desktop/update-helper-launcher');

(async () => {
  assert.equal(launcher.windowsPowerShellPath({ SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-helper-launch-'));
  const installerPath = path.join(root, 'CMOE-Workspace-Setup-1.15.38-Windows.exe');
  const logPath = path.join(root, 'update-helper.log');
  fs.writeFileSync(logPath, 'stale helper ready');
  let spawnCall = null;
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, unref() {} });
  const result = await launcher.launchUpdateHelper({
    installerPath,
    expectedSha256: 'a'.repeat(64),
    expectedBytes: 123,
    expectedVersion: '1.15.38',
    appPath: 'C:/Apps/CMOE Workspace.exe',
    pid: 123
  }, {
    environment: { SystemRoot: 'C:\\Windows' },
    pollMs: 5,
    timeoutMs: 1000,
    spawnProcess(executable, args, options) {
      spawnCall = { executable, args, options };
      fs.writeFileSync(logPath, 'helper process started\nhelper ready\n');
      return child;
    }
  });
  assert.equal(result.pid, 4321);
  assert.equal(result.logPath, logPath);
  assert.equal(spawnCall.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(spawnCall.args.slice(0, 2), ['-NoProfile', '-NonInteractive']);
  assert.equal(spawnCall.options.detached, false);
  assert.equal(spawnCall.options.windowsHide, true);
  const bootstrap = Buffer.from(spawnCall.args.at(-1), 'base64').toString('utf16le');
  assert.match(bootstrap, /Start-Process/);
  assert.match(bootstrap, /-WindowStyle Hidden/);
  assert.match(bootstrap, /-Sta/);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('update helper launcher tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
