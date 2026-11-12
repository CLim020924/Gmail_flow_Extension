const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installedAppShortcutPaths, repairInstalledAppShortcuts } = require('../desktop/install-shortcuts');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-shortcuts-'));
  try {
    const desktopPath = path.join(root, 'Desktop');
    const appDataPath = path.join(root, 'AppData', 'Roaming');
    const appPath = path.join(root, 'Programs', 'CMOE Workspace', 'CMOE Workspace.exe');
    fs.mkdirSync(path.dirname(appPath), { recursive: true });
    fs.mkdirSync(desktopPath, { recursive: true });
    fs.writeFileSync(appPath, 'synthetic updated executable');
    const expectedPaths = installedAppShortcutPaths({ desktopPath, appDataPath });
    fs.writeFileSync(expectedPaths[0], 'old shortcut');
    const writes = [];
    const result = await repairInstalledAppShortcuts({
      appPath, desktopPath, appDataPath,
      shellApi: {
        writeShortcutLink(shortcutPath, operation, details) {
          writes.push({ shortcutPath, operation, details, oldShortcutRemoved: !fs.existsSync(shortcutPath) });
          fs.writeFileSync(shortcutPath, JSON.stringify(details));
          return true;
        }
      }
    });
    assert.deepEqual(result.paths, expectedPaths);
    assert.equal(writes.length, 2);
    writes.forEach((write) => {
      assert.equal(write.operation, 'create');
      assert.equal(write.oldShortcutRemoved, true);
      assert.equal(write.details.target, appPath);
      assert.equal(write.details.cwd, path.dirname(appPath));
      assert.equal(write.details.icon, appPath);
      assert.equal(write.details.appUserModelId, 'kr.co.cmoe.workspace');
    });
    assert.throws(() => installedAppShortcutPaths({ desktopPath: 'relative', appDataPath }), /위치/);
    await assert.rejects(repairInstalledAppShortcuts({ appPath: path.join(root, 'missing.exe'), desktopPath, appDataPath, shellApi: {} }), /실행 파일/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('install shortcut tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
