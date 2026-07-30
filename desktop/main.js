const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require('electron');
const { JsonStorage } = require('./storage');
const { DesktopOAuth } = require('./oauth');

const DESKTOP_OAUTH_CLIENT_ID = '1055778436707-kcjul780j0o7m4pu29bkpj2v6bn0e2r8.apps.googleusercontent.com';
const timers = new Map();
const alarmListeners = new Set();
const runtimeListeners = new Set();
const startupListeners = new Set();
const installedListeners = new Set();
const isSmokeTest = process.argv.includes('--smoke-test');

if (isSmokeTest) {
  app.setPath('userData', path.join(app.getPath('temp'), 'gmail-flow-desktop-smoke-test'));
}

let mainWindow;
let tray;
let isQuitting = false;
let storage;
let oauth;

function broadcastStorageChanges(changes) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send('storage:changed', changes);
  });
}

function createChromeCompatibility() {
  global.chrome = {
    storage: {
      local: {
        get: (keys) => storage.get(keys),
        set: (values) => storage.set(values)
      }
    },
    identity: {
      getAuthToken: ({ interactive = false } = {}) => oauth.getToken(interactive),
      removeCachedAuthToken: () => oauth.invalidateAccessToken(),
      clearAllCachedAuthTokens: () => oauth.clear(),
      getProfileUserInfo: () => oauth.getProfile()
    },
    runtime: {
      getManifest: () => ({ oauth2: { client_id: DESKTOP_OAUTH_CLIENT_ID } }),
      onMessage: { addListener: (listener) => runtimeListeners.add(listener) },
      onStartup: { addListener: (listener) => startupListeners.add(listener) },
      onInstalled: { addListener: (listener) => installedListeners.add(listener) }
    },
    alarms: {
      clear: async (name) => {
        if (timers.has(name)) clearTimeout(timers.get(name));
        timers.delete(name);
        return true;
      },
      create: async (name, info = {}) => {
        if (timers.has(name)) clearTimeout(timers.get(name));
        const delay = Math.max(0, Number(info.when || Date.now()) - Date.now());
        const timer = setTimeout(() => {
          timers.delete(name);
          alarmListeners.forEach((listener) => listener({ name, scheduledTime: info.when }));
        }, Math.min(delay, 2_147_483_647));
        timers.set(name, timer);
      },
      onAlarm: { addListener: (listener) => alarmListeners.add(listener) }
    }
  };
}

function dispatchRuntimeMessage(message) {
  const listener = [...runtimeListeners][0];
  if (!listener) return Promise.reject(new Error('백그라운드 작업이 준비되지 않았습니다.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    try {
      const result = listener(message, {}, sendResponse);
      if (result !== true && result !== undefined && !settled) {
        Promise.resolve(result).then(sendResponse, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f5f3',
    icon: path.join(__dirname, '..', 'icons', 'icon128.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL() && /^https?:/i.test(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) mainWindow.show();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'popup.html'), { query: { mode: 'window', desktop: '1' } });
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'icons', 'icon32.png'));
  tray = new Tray(image);
  tray.setToolTip('Gmail Flow');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Gmail Flow 열기', click: () => showWindow() },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function registerIpc() {
  ipcMain.handle('storage:get', (_event, keys) => storage.get(keys));
  ipcMain.handle('storage:set', (_event, values) => storage.set(values));
  ipcMain.handle('runtime:message', (_event, message) => dispatchRuntimeMessage(message));
  ipcMain.handle('identity:get-auth-token', (_event, options) => oauth.getToken(Boolean(options?.interactive)));
  ipcMain.handle('identity:clear-auth-tokens', () => oauth.clear());
  ipcMain.handle('identity:remove-cached-token', () => oauth.invalidateAccessToken());
  ipcMain.handle('identity:get-profile', () => oauth.getProfile());
  ipcMain.handle('window:show', () => { showWindow(); return { id: mainWindow.id }; });
}

app.setAppUserModelId('com.gmailflow.desktop');
app.on('before-quit', () => { isQuitting = true; });
app.on('activate', () => showWindow());

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  storage = new JsonStorage(path.join(userDataPath, 'gmail-flow-data.json'), broadcastStorageChanges);
  oauth = new DesktopOAuth({
    clientId: DESKTOP_OAUTH_CLIENT_ID,
    authFile: path.join(userDataPath, 'gmail-flow-oauth.json'),
    openExternal: (url) => shell.openExternal(url),
    protect: (plainText) => safeStorage.isEncryptionAvailable()
      ? `dpapi:${safeStorage.encryptString(plainText).toString('base64')}`
      : `base64:${Buffer.from(plainText, 'utf8').toString('base64')}`,
    unprotect: (protectedText) => {
      const [method, payload] = String(protectedText || '').split(':', 2);
      if (method === 'dpapi') return safeStorage.decryptString(Buffer.from(payload, 'base64'));
      if (method === 'base64') return Buffer.from(payload, 'base64').toString('utf8');
      throw new Error('저장된 OAuth 정보를 해석하지 못했습니다.');
    }
  });
  createChromeCompatibility();
  require(path.join(__dirname, '..', 'background.js'));
  registerIpc();
  createWindow();
  createTray();
  installedListeners.forEach((listener) => Promise.resolve(listener()).catch(console.error));
  startupListeners.forEach((listener) => Promise.resolve(listener()).catch(console.error));
  if (isSmokeTest) {
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 2500);
  }
});
