const fs = require('node:fs');
const path = require('node:path');

const MAIN_SHORTCUT_NAME = 'CMOE Workspace.lnk';

function installedAppShortcutPaths({ desktopPath, appDataPath }) {
  if (!path.isAbsolute(String(desktopPath || '')) || !path.isAbsolute(String(appDataPath || ''))) throw new Error('바로가기 위치가 올바르지 않습니다.');
  return [
    path.join(desktopPath, MAIN_SHORTCUT_NAME),
    path.join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs', MAIN_SHORTCUT_NAME)
  ];
}

async function repairInstalledAppShortcuts({ appPath, desktopPath, appDataPath, shellApi, fileSystem = fs }) {
  if (!path.isAbsolute(String(appPath || '')) || !fileSystem.existsSync(appPath)) throw new Error('업데이트된 앱 실행 파일을 확인하지 못했습니다.');
  if (!shellApi || typeof shellApi.writeShortcutLink !== 'function') throw new Error('Windows 바로가기 기능을 사용할 수 없습니다.');
  const details = {
    target: appPath,
    args: '',
    cwd: path.dirname(appPath),
    description: 'CMOE Workspace',
    icon: appPath,
    iconIndex: 0,
    appUserModelId: 'kr.co.cmoe.workspace'
  };
  const paths = installedAppShortcutPaths({ desktopPath, appDataPath });
  for (const shortcutPath of paths) {
    await fileSystem.promises.mkdir(path.dirname(shortcutPath), { recursive: true });
    // Recreate instead of merely retaining the old .lnk so Windows also drops
    // the old target/icon metadata after an in-place update.
    try { await fileSystem.promises.unlink(shortcutPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!shellApi.writeShortcutLink(shortcutPath, 'create', details)) throw new Error(`업데이트된 바로가기를 만들지 못했습니다: ${shortcutPath}`);
  }
  return { paths, target: appPath };
}

module.exports = { MAIN_SHORTCUT_NAME, installedAppShortcutPaths, repairInstalledAppShortcuts };
