const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require('electron');
const { JsonStorage } = require('./storage');
const { DesktopOAuth, loadDesktopOAuthClientSecret } = require('./oauth');

const DESKTOP_OAUTH_CLIENT_ID = '1055778436707-kcjul780j0o7m4pu29bkpj2v6bn0e2r8.apps.googleusercontent.com';
const DESKTOP_OAUTH_CLIENT_SECRET = loadDesktopOAuthClientSecret();
const timers = new Map();
const alarmListeners = new Set();
const runtimeListeners = new Set();
const startupListeners = new Set();
const installedListeners = new Set();
const isSmokeTest = process.argv.includes('--smoke-test');
const hasSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

if (isSmokeTest) {
  app.setPath('userData', path.join(app.getPath('temp'), 'gmail-flow-desktop-smoke-test'));
}

let mainWindow;
let splashWindow;
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
      getAuthToken: ({ interactive = false, scopes, loginHint = '', selectAccount = false } = {}) =>
        oauth.getToken(interactive, scopes, { loginHint, selectAccount }),
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
    if (!isSmokeTest) {
      mainWindow.show();
      splashWindow?.close();
      splashWindow = null;
    }
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'popup.html'), { query: { mode: 'window', desktop: '1' } });
}

function createSplashWindow() {
  if (isSmokeTest) return;
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: '#fdfdfc',
    icon: path.join(__dirname, '..', 'icons', 'icon128.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
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

function findChromeExecutable() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function openGoogleUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('올바르지 않은 Gmail 주소입니다.'); }
  if (parsed.protocol !== 'https:' || !['accounts.google.com', 'mail.google.com'].includes(parsed.hostname)) {
    throw new Error('허용되지 않은 외부 주소입니다.');
  }
  const chromePath = findChromeExecutable();
  if (chromePath) {
    const child = spawn(chromePath, [parsed.href], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { browser: 'chrome' };
  }
  await shell.openExternal(parsed.href);
  return { browser: 'default' };
}

function registerIpc() {
  ipcMain.handle('storage:get', (_event, keys) => storage.get(keys));
  ipcMain.handle('storage:set', (_event, values) => storage.set(values));
  ipcMain.handle('runtime:message', (_event, message) => dispatchRuntimeMessage(message));
  ipcMain.handle('identity:get-auth-token', (_event, options) => oauth.getToken(
    Boolean(options?.interactive),
    options?.scopes,
    { loginHint: options?.loginHint || '', selectAccount: Boolean(options?.selectAccount) }
  ));
  ipcMain.handle('identity:clear-auth-tokens', () => oauth.clear());
  ipcMain.handle('identity:remove-cached-token', () => oauth.invalidateAccessToken());
  ipcMain.handle('identity:get-profile', () => oauth.getProfile());
  ipcMain.handle('window:show', () => { showWindow(); return { id: mainWindow.id }; });
  ipcMain.handle('external:open-google', async (_event, url) => {
    try { return { ok: true, data: await openGoogleUrl(url) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

app.setAppUserModelId('com.gmailflow.desktop');
app.on('before-quit', () => { isQuitting = true; });
app.on('activate', () => showWindow());
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  showWindow();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  createSplashWindow();
  const userDataPath = app.getPath('userData');
  if (isSmokeTest) {
    try { await fs.promises.unlink(path.join(userDataPath, 'gmail-flow-data.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  storage = new JsonStorage(path.join(userDataPath, 'gmail-flow-data.json'), broadcastStorageChanges);
  oauth = new DesktopOAuth({
    clientId: DESKTOP_OAUTH_CLIENT_ID,
    clientSecret: DESKTOP_OAUTH_CLIENT_SECRET,
    authFile: path.join(userDataPath, 'gmail-flow-oauth.json'),
    openExternal: (url) => openGoogleUrl(url),
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
    const timeout = setTimeout(() => {
      console.error('Smoke test timed out.');
      isQuitting = true;
      app.exit(1);
    }, 30_000);
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        mainWindow.setBounds({ x: 40, y: 40, width: 980, height: 820 });
        mainWindow.show();
        mainWindow.focus();
        const result = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const waitFor = async (predicate, label, timeout = 5000) => {
              const deadline = Date.now() + timeout;
              while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
              if (!predicate()) throw new Error('UI smoke test timeout: ' + label);
            };
            const assert = (condition, label) => { if (!condition) throw new Error('UI smoke test failed: ' + label); };
            const submitInputDialog = async (value) => {
              const dialog = document.querySelector('#inputDialog');
              assert(dialog.open, 'input dialog should be open');
              const input = document.querySelector('#inputDialogValue');
              input.value = value;
              document.querySelector('#inputDialogForm').requestSubmit();
              await waitFor(() => !dialog.open, 'input dialog close');
            };
            const confirmMessageDialog = async () => {
              const dialog = document.querySelector('#messageDialog');
              await waitFor(() => dialog.open, 'message dialog open');
              document.querySelector('#messageDialogForm').requestSubmit();
              await waitFor(() => !dialog.open, 'message dialog close');
            };

            await waitFor(() => document.querySelector('#addColumn'), 'initial roster render');
            assert(document.querySelectorAll('.roster-load-panel > .load-submenu').length === 2, 'roster and structure root menu items');
            assert(document.querySelector('#pasteTable') && document.querySelector('#fileInput'), 'table data and Excel/CSV root menu items');
            assert(document.querySelector('#rosterDragHelp')?.textContent.includes('Ctrl+C/X/V') && document.querySelector('#rosterFillDown'), 'roster range actions should be discoverable');
            document.querySelector('[data-page="roster"]').click();
            await waitFor(() => document.querySelector('#page-roster').classList.contains('active'), 'roster page activation');

            const addColumn = document.querySelector('#addColumn');
            addColumn.click();
            await submitInputDialog('Smoke Test Column');
            await waitFor(() => [...document.querySelectorAll('.column-header')].some((element) => element.textContent.includes('Smoke Test Column')), 'column creation');

            let cell = document.querySelector('#rosterBody .cell-input');
            await new Promise((resolve) => setTimeout(resolve, 50));
            const firstRect = cell.getBoundingClientRect();
            cell.closest('.data-cell').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: firstRect.left + firstRect.width / 2, clientY: firstRect.top + firstRect.height / 2 }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            assert(document.activeElement === cell, 'initial cell should focus on mouse press; active=' + document.activeElement?.tagName + '.' + document.activeElement?.className);
            const secondCell = document.querySelectorAll('#rosterBody .cell-input')[1];
            const secondRect = secondCell.getBoundingClientRect();
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: firstRect.left + firstRect.width / 2, clientY: firstRect.top + firstRect.height / 2 }));
            cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: secondRect.left + secondRect.width / 2, clientY: secondRect.top + secondRect.height / 2 }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            assert(document.querySelectorAll('#rosterBody .selected-cell').length === 2, 'input-captured mouse drag should select the cell under the real pointer');
            cell.value = 'Alpha';
            cell.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#rosterFillDown').click();
            assert([...document.querySelectorAll('#rosterBody .cell-input')].slice(0, 2).every((input) => input.value === 'Alpha'), 'fill-down should apply the first selected value to the selected cells');
            document.querySelector('#rosterUndo').click();
            cell = document.querySelector('#rosterBody .cell-input');
            assert(cell.value === 'Alpha' && document.querySelectorAll('#rosterBody .cell-input')[1].value === '', 'roster undo should restore the range before fill-down');
            await waitFor(() => !document.querySelector('#saveRoster').disabled, 'roster save enabled');

            await addAttachments([new File(['attachment smoke'], 'smoke.txt', { type: 'text/plain' })]);
            assert(state.attachments.length === 1 && document.querySelectorAll('.attachment-item').length === 1, 'multiple attachment pipeline UI');

            document.querySelector('#saveRoster').click();
            await submitInputDialog('Smoke Roster');
            await waitFor(() => document.querySelector('[data-quick-roster-id]'), 'saved roster quick item');

            document.querySelector('[data-structure-action="save"]').click();
            await submitInputDialog('Smoke Structure');
            await waitFor(() => document.querySelector('[data-quick-structure-id]'), 'saved structure quick item');

            document.querySelector('#resetRoster').click();
            await confirmMessageDialog();
            await waitFor(() => document.querySelectorAll('.column-header').length === 0 && document.querySelector('[data-paste-anchor="true"]'), 'roster reset');
            assert(document.activeElement === document.querySelector('#addColumn'), 'reset should immediately restore keyboard focus');

            const hwp = ['송아라','cs-smile@naver.com','010-8700-3977','cs-smile@naver.com','조민지','alswldmswl00@naver.com','010-8213-7220','alswldmswl00@naver.com','김미','k100mi@naver.com','010-2591-8813','k100mi@naver.com'].join('\\n');
            applyTable(parseDelimited(hwp));
            await waitFor(() => document.querySelectorAll('.column-header').length === 4, 'HWP vertical record inference');
            assert([...document.querySelectorAll('.column-header')].map((element) => element.textContent).join('|').includes('이름|이메일 · 수신 이메일|전화번호|아이디'), 'HWP inferred headers and email role');
            assert(document.querySelectorAll('.column-header').length === 4 && document.querySelectorAll('#rosterBody tr').length >= 3, 'HWP inferred records');
            let headerCells = document.querySelectorAll('.header-data-cell');
            headerCells[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            headerCells[3].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            assert(document.querySelectorAll('#rosterHead .selected-cell').length === 4, 'column name headers should support drag selection');
            const headerClipboard = new DataTransfer();
            document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: headerClipboard }));
            assert(headerClipboard.getData('text/plain') === '이름\\t이메일\\t전화번호\\t아이디', 'Ctrl+C should copy selected column headers as TSV');

            const firstHeader = document.querySelector('.header-data-cell');
            const lastDataCell = [...document.querySelectorAll('#rosterBody .data-cell[data-sheet-column="3"]')][2];
            firstHeader.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            lastDataCell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const mixedClipboard = new DataTransfer();
            document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: mixedClipboard }));
            assert(mixedClipboard.getData('text/plain').split('\\r\\n').length === 4, 'header-to-data range copy should include header and three rows');
            assert(mixedClipboard.getData('text/html').includes('<table>'), 'range copy should include Excel-compatible HTML');

            const accountUrl = new URL(buildGmailAccountUrl('sender@example.com', 'drafts', 'draft-id'));
            assert(accountUrl.hostname === 'accounts.google.com' && accountUrl.searchParams.get('Email') === 'sender@example.com', 'Gmail link should use connected account chooser');
            assert(decodeURIComponent(accountUrl.searchParams.get('continue')).includes('#drafts/draft-id'), 'Gmail account chooser should retain draft deep link');
            const blockedExternalUrl = await globalThis.gmailFlowDesktop.openGoogleUrl('https://example.com/').then(() => false, () => true);
            assert(blockedExternalUrl, 'desktop external URL bridge should reject non-Google hosts');
            state.columns[3].role = 'email';
            renderRoster();
            document.querySelectorAll('.column-header')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelector('#inputDialog').open, 'email column name dialog');
            await submitInputDialog('이메일');
            await waitFor(() => document.querySelector('#inputDialog').open && !document.querySelector('#inputDialogSelect').hidden, 'email column role dialog');
            await submitInputDialog('email');
            await waitFor(() => state.columns.filter((column) => column.role === 'email').length === 1, 'single recipient email role');

            document.querySelector('#resetRoster').click();
            await confirmMessageDialog();
            await waitFor(() => document.querySelectorAll('.column-header').length === 0, 'second roster reset');

            document.querySelector('[data-quick-structure-id]').click();
            await waitFor(() => document.querySelector('.column-header')?.textContent.includes('Smoke Test Column'), 'structure apply');
            cell = document.querySelector('#rosterBody .cell-input');
            assert(cell.value === '', 'structure apply should not restore row data');
            cell.focus();
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
            assert(document.activeElement === cell, 'structure-applied cell should focus on mouse press; active=' + document.activeElement?.tagName + '.' + document.activeElement?.className);

            document.querySelector('[data-quick-roster-id]').click();
            await waitFor(() => document.querySelector('#rosterBody .cell-input')?.value === 'Alpha', 'roster data restore');

            document.querySelector('[data-roster-action="more"]').click();
            await waitFor(() => !document.querySelector('#savedRosterList').hidden, 'roster more view');
            document.querySelector('[data-roster-id]').click();
            await waitFor(() => !document.querySelector('#savedRosterDetail').hidden, 'roster detail view');
            document.querySelector('#deleteRoster').click();
            await confirmMessageDialog();
            await waitFor(() => !document.querySelector('[data-roster-id]') && !document.querySelector('[data-quick-roster-id]'), 'roster deletion');
            document.querySelector('#backButton').click();
            await waitFor(() => !document.querySelector('#rosterEditor').hidden, 'return from roster list');

            document.querySelector('[data-structure-action="more"]').click();
            await waitFor(() => !document.querySelector('#structureTemplateList').hidden, 'structure more view');
            document.querySelector('[data-structure-template-id]').click();
            await waitFor(() => !document.querySelector('#structureTemplateDetail').hidden, 'structure detail view');
            document.querySelector('#deleteStructureTemplate').click();
            await confirmMessageDialog();
            await waitFor(() => !document.querySelector('[data-structure-template-id]') && !document.querySelector('[data-quick-structure-id]'), 'structure deletion');

            state.mailBatches = [{ id: 'progress-smoke', name: '진행 표시 테스트', method: '임시 저장', status: 'processing', total: 2, completed: 0, currentItemId: 'item-1', items: [{ id: 'item-1', status: 'queued', email: 'one@example.com', variables: { 이름: '첫 대상' } }, { id: 'item-2', status: 'queued', email: 'two@example.com', variables: {} }] }];
            renderQueue();
            renderOperationStatus();
            assert(!document.querySelector('#operationStatus').hidden && document.querySelector('#operationStatusText').textContent.includes('첫 대상 처리 중'), 'live operation progress banner');
            assert(document.querySelector('#queueItems progress'), 'queue progress bar');

            state.mailBatches = [{
              id: 'draft-edit-smoke', name: '초안 수정 테스트', method: '임시 저장', status: 'completed', total: 1, completed: 1,
              subjectTemplate: '안내 {{이름}}', bodyTemplate: '{{이름}}님 본문', postscriptTemplate: '추신', attachments: [],
              items: [{ id: 'draft-item-1', status: 'completed', draftId: 'draft-1', email: 'one@example.com', subject: '안내 첫 대상', body: '첫 대상님 본문\\n\\n추신', variables: { 이름: '첫 대상' }, externalDraftState: 'modified' }]
            }];
            showHistoryBatch('draft-edit-smoke');
            assert(!document.querySelector('#editDraftBatch').hidden, 'draft batch edit action should be visible');
            assert(!document.querySelector('#refreshDraftStatus').hidden, 'Gmail draft status refresh should be visible');
            assert(document.querySelector('#historyRecipients .external-modified')?.textContent.includes('수정됨'), 'externally modified draft status badge');
            openDraftBatchEditor();
            assert(document.querySelector('#draftEditDialog').open, 'draft batch edit dialog should open');
            assert(document.querySelector('#draftEditSubject').value === '안내 {{이름}}', 'draft subject template should load');
            assert(document.querySelector('#draftEditAttachmentInput').multiple, 'draft edit should accept multiple attachments');
            document.querySelector('#draftEditDialog').close();

            assert(document.querySelector('#dataStorageMode option[value="local"]') && document.querySelector('#dataStorageMode option[value="drive"]'), 'local and Google Drive storage choices');
            const originalRuntimeSend = chrome.runtime.sendMessage;
            let uploadedCloudSnapshot = null;
            chrome.runtime.sendMessage = async (message) => {
              if (message.type === 'authorize-drive-sync') return { ok: true, data: { authorized: true } };
              if (message.type === 'cloud-sync-download') return { ok: true, data: { file: null, snapshot: null } };
              if (message.type === 'cloud-sync-upload') { uploadedCloudSnapshot = message.snapshot; return { ok: true, data: { file: { id: 'cloud-smoke', modifiedTime: '2026-08-03T00:00:00.000Z' } } }; }
              return originalRuntimeSend(message);
            };
            state.connectedEmail = 'sync-smoke@example.com';
            const storageMode = document.querySelector('#dataStorageMode');
            storageMode.value = 'drive';
            storageMode.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => state.cloudSyncMeta?.fileId === 'cloud-smoke', 'Drive mode initial upload');
            assert(uploadedCloudSnapshot?.format === 'gmail-flow-cloud-sync', 'Drive snapshot format');
            assert(!('mailBatches' in uploadedCloudSnapshot.data) && !('attachments' in uploadedCloudSnapshot.data), 'Drive snapshot excludes queue and attachments');
            storageMode.value = 'local';
            storageMode.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => state.dataStorageMode === 'local', 'switch back to local-only mode');
            chrome.runtime.sendMessage = originalRuntimeSend;

            return { passed: true };
          })()
        `);
        clearTimeout(timeout);
        isQuitting = true;
        app.exit(result?.passed ? 0 : 1);
      } catch (error) {
        clearTimeout(timeout);
        console.error('Smoke test failed:', error);
        isQuitting = true;
        app.exit(1);
      }
    });
  }
});
