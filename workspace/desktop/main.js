const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const { JsonStorage } = require('./storage');
const { readWorkbookSheets, exportProjectWorkbook, exportWorkItemWorkbook } = require('./spreadsheet');
const { AuthManager } = require('./auth-manager');
const { ExtensionManager } = require('./extension-manager');
const { mimeDraft } = require('./mail-mime');
const { mergeWorkspaceState } = require('./state-merge');
const { GmailFlowHost } = require('./gmail-flow-host');

const isSmokeTest = process.env.CMOE_SMOKE === '1' || process.argv.includes('--smoke-test') || app.commandLine.hasSwitch('smoke-test');
const hasSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

if (isSmokeTest) { app.disableHardwareAcceleration(); app.setPath('userData', path.join(app.getPath('temp'), 'cmoe-workspace-smoke-test')); }

let mainWindow;
const programWindows = new Map();
let storage;
let authManager;
let extensionManager;
let gmailFlowHost;
let isQuitting = false;

function jsonBody(value) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

const PROGRAMS = new Set(['people', 'schedule', 'layout', 'forms', 'zoom', 'gmailFlow']);
const PROGRAM_LABELS = { people: 'CMOE 명단 관리', schedule: 'CMOE 일정 조율', layout: 'CMOE Excel 출력', forms: 'CMOE Google Forms', zoom: 'CMOE Zoom', gmailFlow: 'CMOE Gmail Flow' };
const PROGRAM_ICON_INDEX = { people: 264, schedule: 168, layout: 268, forms: 260, zoom: 18, gmailFlow: 220 };
function requestedProgram(argv = process.argv) {
  const value = argv.find((item) => item.startsWith('--app='))?.slice('--app='.length);
  return /^[a-z][a-zA-Z0-9.-]{1,63}$/.test(value || '') ? value : '';
}

function extensionManifest(programId) { return extensionManager?.list().find((item) => item.id === programId); }
function isProgramId(programId) { return PROGRAMS.has(programId) || Boolean(extensionManifest(programId)?.declarative); }
function programLabel(programId) { return PROGRAM_LABELS[programId] || extensionManifest(programId)?.name || programId; }

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createProgramWindow(programId) {
  const existing = programWindows.get(programId);
  if (existing && !existing.isDestroyed()) { if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); return existing; }
  const legacyGmail = programId === 'gmailFlow' && gmailFlowHost;
  const window = new BrowserWindow({ width: legacyGmail ? 1040 : 1220, height: 820, minWidth: legacyGmail ? 760 : 900, minHeight: 640, show: false, backgroundColor: legacyGmail ? '#f5f5f3' : '#f3f4f6', title: legacyGmail ? 'Gmail Flow' : `CMOE · ${programId}`, webPreferences: { preload: legacyGmail ? gmailFlowHost.preloadPath : path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => programWindows.delete(programId));
  if (legacyGmail) window.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1' } });
  else window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { mode: 'standalone', app: programId } });
  programWindows.set(programId, window);
  return window;
}

function broadcastState(next) {
  [mainWindow, ...programWindows.values()].forEach((window) => { if (window && !window.isDestroyed()) window.webContents.send('workspace:state-changed', next); });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2 || isSmokeTest) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => { if (isQuitting) mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('workspace:load', () => storage.get('workspaceState', null));
  ipcMain.handle('workspace:save', async (_event, incoming) => {
    const current = await storage.get('workspaceState', null);
    const currentRevision = Number(current?._revision || 0);
    const baseRevision = Number(incoming?._baseRevision ?? currentRevision);
    const next = baseRevision === currentRevision ? { ...incoming } : mergeWorkspaceState(current || {}, incoming || {});
    next._revision = currentRevision + 1; next._baseRevision = next._revision;
    await storage.set('workspaceState', next);
    return { ok: true, state: next, merged: baseRevision !== currentRevision };
  });
  ipcMain.handle('workspace:app-info', () => ({ version: app.getVersion(), userDataPath: app.getPath('userData') }));
  ipcMain.handle('program:open', (_event, programId) => { if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.'); createProgramWindow(programId); return { ok: true }; });
  ipcMain.handle('workspace:open-main', () => { showWindow(); return { ok: true }; });
  ipcMain.handle('program:shortcuts', async (_event, programId, options = {}) => {
    if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.');
    const label = programLabel(programId);
    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const systemIcons = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shell32.dll');
    const details = { target: executable, args: `--app=${programId}`, cwd: path.dirname(executable), description: `${label} 바로 실행`, icon: systemIcons, iconIndex: PROGRAM_ICON_INDEX[programId] || 0 };
    const paths = [];
    if (isSmokeTest && options.smoke) paths.push(path.join(app.getPath('temp'), `${label}-smoke.lnk`));
    if (options.desktop) paths.push(path.join(app.getPath('desktop'), `${label}.lnk`));
    if (options.startMenu) { const directory = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CMOE Workspace'); await fs.promises.mkdir(directory, { recursive: true }); paths.push(path.join(directory, `${label}.lnk`)); }
    paths.forEach((shortcutPath) => { if (!shell.writeShortcutLink(shortcutPath, 'create', details)) throw new Error(`바로가기를 만들지 못했습니다: ${shortcutPath}`); });
    return { ok: true, paths };
  });
  ipcMain.handle('program:remove-shortcuts', async (_event, programId) => {
    if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.');
    const label = programLabel(programId);
    const paths = isSmokeTest ? [path.join(app.getPath('temp'), `${label}-smoke.lnk`)] : [path.join(app.getPath('desktop'), `${label}.lnk`), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CMOE Workspace', `${label}.lnk`)];
    for (const shortcutPath of paths) { try { await fs.promises.unlink(shortcutPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return { ok: true, paths };
  });
  ipcMain.handle('program:open-location', () => { shell.showItemInFolder(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath); return { ok: true }; });
  ipcMain.handle('extensions:list', () => extensionManager.list());
  ipcMain.handle('extensions:install', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'CMOE 확장', extensions: ['cmoe-extension'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, extension: await extensionManager.install(result.filePaths[0]) };
  });
  ipcMain.handle('extensions:remove-file', (_event, extensionId) => extensionManager.remove(extensionId));
  ipcMain.handle('spreadsheet:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const sheets = await readWorkbookSheets(result.filePaths[0]); const first = sheets[0] || { name: '', matrix: [] };
    return { canceled: false, filePath: result.filePaths[0], sheets, sheetName: first.name, matrix: first.matrix };
  });
  ipcMain.handle('spreadsheet:export', async (_event, project) => {
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: `${String(project?.name || '일정').replace(/[\\/:*?"<>|]/g, '_')}-일정.xlsx`, filters: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportProjectWorkbook(result.filePath, project);
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('spreadsheet:export-work-item', async (_event, item) => {
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: `${String(item?.name || '명단 작업').replace(/[\\/:*?"<>|]/g, '_')}.xlsx`, filters: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportWorkItemWorkbook(result.filePath, item); return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('connection:config', (_event, connectionId, config) => authManager.setConfig(connectionId, config));
  ipcMain.handle('connection:status', (_event, connectionId) => authManager.publicStatus(connectionId));
  ipcMain.handle('connection:authorize', (_event, connectionId, options) => authManager.authorize(connectionId, options));
  ipcMain.handle('connection:disconnect', (_event, connectionId) => authManager.disconnect(connectionId));
  ipcMain.handle('connection:remove', (_event, connectionId) => authManager.remove(connectionId));
  ipcMain.handle('forms:create', async (_event, connectionId, definition, requests) => {
    const created = await authManager.request(connectionId, 'https://forms.googleapis.com/v1/forms', jsonBody({ info: { title: definition.title, documentTitle: definition.title } }));
    const updated = await authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${encodeURIComponent(created.formId)}:batchUpdate`, jsonBody({ requests }));
    const questionIds = {};
    const createReplies = (updated.replies || []).filter((reply) => reply.createItem);
    definition.questions.forEach((question, index) => {
      const id = createReplies[index]?.createItem?.item?.questionItem?.question?.questionId;
      if (id) questionIds[question.key] = id;
    });
    return { formId: created.formId, responderUri: created.responderUri || '', editUri: `https://docs.google.com/forms/d/${created.formId}/edit`, questionIds };
  });
  ipcMain.handle('forms:responses', async (_event, connectionId, formId) => {
    const id = encodeURIComponent(formId);
    const [form, responseData] = await Promise.all([
      authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${id}`),
      authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${id}/responses`)
    ]);
    return { form, responses: responseData.responses || [] };
  });
  ipcMain.handle('zoom:create', async (_event, connectionId, meeting) => {
    return authManager.request(connectionId, 'https://api.zoom.us/v2/users/me/meetings', jsonBody({
      topic: meeting.topic,
      type: 2,
      start_time: `${meeting.date}T${meeting.startTime}:00`,
      duration: meeting.duration,
      timezone: meeting.timezone || 'Asia/Seoul',
      agenda: meeting.agenda || '',
      settings: { waiting_room: true, join_before_host: false, mute_upon_entry: true }
    }));
  });
  ipcMain.handle('gmail:create-draft', async (_event, connectionId, mail) => {
    return authManager.request(connectionId, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', jsonBody({ message: { raw: mimeDraft({ to: mail.email, subject: mail.subject, body: mail.body, bodyHtml: mail.bodyHtml }) } }));
  });
  ipcMain.handle('gmail:update-draft', async (_event, connectionId, draftId, mail) => {
    return authManager.request(connectionId, `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, { ...jsonBody({ id: draftId, message: { raw: mimeDraft({ to: mail.email, subject: mail.subject, body: mail.body, bodyHtml: mail.bodyHtml }) } }), method: 'PUT' });
  });
  ipcMain.handle('drive:push', async (_event, connectionId, state) => {
    const name = 'cmoe-workspace-state.json';
    const query = encodeURIComponent(`name='${name}' and trashed=false`);
    const found = await authManager.request(connectionId, `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc`);
    let fileId = found.files?.[0]?.id;
    if (!fileId) {
      const created = await authManager.request(connectionId, 'https://www.googleapis.com/drive/v3/files', jsonBody({ name, parents: ['appDataFolder'] }));
      fileId = created.id;
    }
    const uploaded = await authManager.request(connectionId, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
    return { fileId, modifiedTime: uploaded.modifiedTime || new Date().toISOString() };
  });
  ipcMain.handle('drive:pull', async (_event, connectionId) => {
    const name = 'cmoe-workspace-state.json';
    const query = encodeURIComponent(`name='${name}' and trashed=false`);
    const found = await authManager.request(connectionId, `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc`);
    const file = found.files?.[0];
    if (!file) return { exists: false };
    const state = await authManager.request(connectionId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
    return { exists: true, state, fileId: file.id, modifiedTime: file.modifiedTime };
  });
}

app.setAppUserModelId('kr.co.cmoe.workspace');
app.on('before-quit', () => { isQuitting = true; });
app.on('activate', () => { if (!mainWindow && !programWindows.size) showWindow(); });
app.on('second-instance', (_event, argv) => {
  const programId = requestedProgram(argv);
  if (programId) createProgramWindow(programId);
  else { if (mainWindow?.isMinimized()) mainWindow.restore(); showWindow(); }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const userDataPath = app.getPath('userData');
  if (isSmokeTest) {
    try { await fs.promises.unlink(path.join(userDataPath, 'workspace-data.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  storage = new JsonStorage(path.join(userDataPath, 'workspace-data.json'), (changes) => {
    const next = changes.workspaceState?.newValue;
    if (next) broadcastState(next);
  });
  authManager = new AuthManager({
    filePath: path.join(userDataPath, 'workspace-credentials.json'),
    openExternal: (url) => shell.openExternal(url),
    protect: (plain) => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : Buffer.from(plain, 'utf8').toString('base64'),
    unprotect: (encrypted) => safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : Buffer.from(encrypted, 'base64').toString('utf8')
  });
  extensionManager = new ExtensionManager({ bundledPath: path.join(__dirname, '..', 'extensions'), userPath: path.join(userDataPath, 'extensions') });
  const gmailFlowRoot = app.isPackaged ? path.join(process.resourcesPath, 'gmail-flow') : path.join(__dirname, '..', '..');
  gmailFlowHost = new GmailFlowHost({ app, BrowserWindow, ipcMain, safeStorage, shell, rootPath: gmailFlowRoot, showWindow: () => createProgramWindow('gmailFlow'), isSmokeTest });
  await gmailFlowHost.initialize();
  registerIpc();
  const initialProgram = requestedProgram();
  if (initialProgram && !isSmokeTest) createProgramWindow(initialProgram); else createWindow();

  if (isSmokeTest) {
    const timeout = setTimeout(() => {
      console.error('Workspace smoke test timed out.');
      isQuitting = true;
      app.exit(1);
    }, 30_000);
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const waitFor = async (predicate, label, timeout = 5000) => {
              const end = Date.now() + timeout;
              while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
              if (!predicate()) throw new Error('timeout: ' + label);
            };
            const assert = (condition, label) => { if (!condition) throw new Error(label); };
            await waitFor(() => document.querySelector('#newProjectButton'), 'app ready');
            assert(document.querySelector('#dashboardEmpty h1')?.textContent.includes('어떤 작업'), 'first-use choice should be understandable');
            assert(document.querySelector('[data-nav="modules"]')?.textContent.includes('추가 프로그램'), 'navigation should use user-facing names');
            document.querySelector('#newProjectButton').click();
            document.querySelector('#projectName').value = 'Smoke Project A';
            document.querySelector('#newProjectForm').requestSubmit();
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project A', 'first project');
            document.querySelector('#newProjectButton').click();
            document.querySelector('#projectName').value = 'Smoke Project B';
            document.querySelector('#newProjectForm').requestSubmit();
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project B', 'second project');
            document.querySelector('[data-workflow-open="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'empty people page');
            document.querySelector('[data-empty-sheet-add-column]').click();
            await waitFor(() => document.querySelectorAll('#rosterEditorTable tbody tr').length === 5, 'blank roster rows after first column');
            assert(document.querySelectorAll('#rosterEditorTable [data-person-row]').length === 5, 'first column must keep editable blank rows');
            document.querySelector('#page-people [data-nav-link="dashboard"]').click();
            const switcher = document.querySelector('#projectSwitcher');
            assert(switcher.options.length === 2, 'project switcher should list two projects');
            switcher.value = [...switcher.options].find((option) => option.textContent.includes('Project A')).value;
            switcher.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project A', 'project switch');
            document.querySelector('[data-workflow-open="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'people page');
            assert(document.querySelector('#page-people h1')?.textContent === '명단 준비', 'people page purpose label');
            assert(document.querySelectorAll('#rosterEditorTable tbody .empty-sheet-cell').length === 5, 'blank spreadsheet should be visible before import');
            assert(document.querySelector('#rosterCellAddress').textContent === 'A1', 'blank spreadsheet should start at A1');
            document.querySelector('#rosterPasteInput').value = ['송아라','one@example.com','010-1111-1111','one@example.com','조민지','two@example.com','010-2222-2222','two@example.com'].join('\\n');
            const rosterTransfer = new DataTransfer(); rosterTransfer.setData('text/plain', document.querySelector('#rosterPasteInput').value);
            document.querySelector('#rosterEditorTable [data-sheet-row="0"][data-sheet-col="0"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: rosterTransfer, bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelector('#rosterEditorTable [data-person-row="0"]')?.value === '송아라', 'vertical roster import');
            assert(document.querySelectorAll('#rosterEditorTable tbody tr').length >= 5, 'imported roster should keep trailing blank rows');
            assert(document.querySelectorAll('#rosterEditorTable thead tr:last-child th').length === 6, 'row number, inferred four columns and inline add column');
            assert(!document.querySelector('#rosterEditorTable .role-checks, #rosterEditorTable [data-person-active]'), 'source roster must not impose roles or management fields');
            const firstCell = document.querySelector('#rosterEditorTable tbody [data-sheet-row="1"][data-sheet-col="0"]');
            firstCell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            assert(firstCell.classList.contains('sheet-selected') && document.querySelector('#rosterCellAddress').textContent === 'A2', 'spreadsheet cell selection');
            const secondCell = document.querySelector('#rosterEditorTable tbody [data-sheet-row="2"][data-sheet-col="1"]');
            secondCell.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            const copied = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: copied, bubbles: true, cancelable: true }));
            assert(copied.getData('text/plain').includes('\t') && copied.getData('text/html').includes('<table>'), 'spreadsheet range copy');
            const headerCell = document.querySelector('#rosterEditorTable thead [data-sheet-row="0"][data-sheet-col="0"]');
            headerCell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            assert(headerCell.classList.contains('sheet-selected') && document.querySelector('#rosterCellAddress').textContent === 'A1', 'column header selection');
            document.querySelector('#saveRosterData').click();
            document.querySelector('#rosterStartTask').click();
            await waitFor(() => document.querySelector('#rosterTaskChooserDialog').open, 'roster task chooser');
            document.querySelector('[data-roster-task="grouping"]').click();
            await waitFor(() => document.querySelector('#arrangementSetupDialog').open, 'arrangement setup');
            document.querySelector('#arrangementName').value = 'Smoke 그룹 작업'; document.querySelector('#arrangementGroupSize').value = '2'; document.querySelector('#arrangementMethod').value = 'sequential'; document.querySelector('#arrangementSetupForm').requestSubmit();
            await waitFor(() => document.querySelector('#page-arrange').classList.contains('active'), 'arrangement page');
            assert(document.querySelector('#arrangementTitle').textContent === 'Smoke 그룹 작업', 'arrangement title');
            assert(document.querySelectorAll('#arrangementBoard tbody [data-arrangement-input]').length >= 10, 'editable arrangement grid');
            assert(document.querySelector('#arrangementBoard tbody [data-arrangement-row="0"][data-arrangement-col="0"] input').value === '그룹 1', 'sequential group draft');
            const arrangementCell = document.querySelector('#arrangementBoard [data-arrangement-row="0"][data-arrangement-col="0"]'); arrangementCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const arrangementCopy = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: arrangementCopy, bubbles: true, cancelable: true })); assert(arrangementCopy.getData('text/plain') === '그룹 1', 'arrangement Excel copy');
            document.querySelector('#page-arrange [data-nav-link="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'back to people');
            document.querySelector('#rosterStartTask').click(); await waitFor(() => document.querySelector('[data-open-arrangement]'), 'saved arrangement listed'); document.querySelector('[data-open-arrangement]').click(); await waitFor(() => document.querySelector('#page-arrange').classList.contains('active'), 'reopen saved arrangement'); document.querySelector('#page-arrange [data-nav-link="people"]').click();
            document.querySelector('#page-people [data-nav-link="dashboard"]').click();
            document.querySelector('[data-workflow-open="schedule"]').click();
            await waitFor(() => document.querySelector('#page-schedule').classList.contains('active'), 'schedule page');
            assert(document.querySelector('#page-schedule h1')?.textContent === '일정 편성' && document.querySelector('#generateScheduleButton')?.textContent.includes('일정표 만들기'), 'schedule page purpose labels');
            document.querySelector('#slotBulkInput').value = '2026-07-06 09:30-10:30 오전 세션';
            document.querySelector('#addSlotsButton').click();
            await waitFor(() => document.querySelectorAll('[data-availability-all]').length === 2, 'availability matrix');
            document.querySelectorAll('[data-availability-all]').forEach((checkbox) => { checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); });
            await waitFor(() => [...document.querySelectorAll('[data-availability-person]')].every((checkbox) => checkbox.checked), 'all availability');
            document.querySelector('#generateScheduleButton').click();
            await waitFor(() => [...document.querySelectorAll('#scheduleBoard .schedule-role-cell input')].some((input) => input.value.split(',').filter(Boolean).length >= 1), 'generated assignments');
            const scheduleCell = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="0"]');
            scheduleCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
            const scheduleSecondCell = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="1"]');
            scheduleSecondCell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            assert(scheduleCell.classList.contains('sheet-selected') && scheduleSecondCell.classList.contains('sheet-selected') && document.querySelector('#scheduleSelectionStatus').textContent === 'A2:B2', 'schedule spreadsheet drag selection');
            const scheduleCopied = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: scheduleCopied, bubbles: true, cancelable: true }));
            assert(scheduleCopied.getData('text/plain').includes('\t') && scheduleCopied.getData('text/html').includes('<table>'), 'schedule spreadsheet drag and Excel copy');
            scheduleCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const schedulePaste = new DataTransfer(); schedulePaste.setData('text/plain', '날짜\\t시작\\t종료\\t세션명\\t참여자\\t운영 메모\\n2026-07-06\\t09:30\\t10:30\\t오전 세션\\t송아라, 조민지\\t확인 완료');
            scheduleCell.querySelector('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: schedulePaste, bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelector('#confirmDialog').open, 'schedule paste replacement confirm'); document.querySelector('#confirmAction').click();
            await waitFor(() => [...document.querySelectorAll('[data-schedule-rename-column]')].some((button) => button.textContent === '운영 메모'), 'dynamic schedule column import');
            assert([...document.querySelectorAll('#scheduleBoard tbody input')].some((input) => input.value === '확인 완료'), 'custom schedule cell persisted in editor');
            document.querySelector('#saveScheduleVersion').click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            document.querySelector('#page-schedule [data-nav-link="dashboard"]').click();
            document.querySelector('[data-workflow-open="layout"]').click();
            await waitFor(() => document.querySelectorAll('#outputPreviewTable tbody tr').length >= 1, 'output preview');
            assert(document.querySelector('#page-layout h1')?.textContent === '일정표 저장·내보내기', 'output page purpose label');
            document.querySelector('[data-nav="modules"]').click();
            await waitFor(() => document.querySelector('#page-modules').classList.contains('active'), 'modules page');
            const zoomBefore = document.querySelector('[data-module-toggle="zoom"]').textContent;
            document.querySelector('[data-module-toggle="zoom"]').click();
            await waitFor(() => document.querySelector('[data-module-toggle="zoom"]').textContent !== zoomBefore, 'zoom module toggled');
            document.querySelector('[data-nav="dashboard"]').click();
            document.querySelector('[data-workflow-open="gmailFlow"]').click();
            await waitFor(() => document.querySelector('#page-gmailFlow').classList.contains('active'), 'gmail page');
            assert(document.querySelector('#page-gmailFlow h1')?.textContent === '안내 메일 준비' && document.querySelector('#createGmailDrafts')?.textContent.includes('임시보관함'), 'gmail page purpose labels');
            assert(document.querySelector('#gmailFlowAccountButton') && document.querySelector('#openOriginalGmailFlow'), 'Gmail account and original app controls should be visible');
            const mailEditor = document.querySelector('#mailBodyEditor');
            document.querySelector('#mailSubjectTemplate').value += ' {전화번호} {없는컬럼}';
            document.querySelector('#mailSubjectTemplate').dispatchEvent(new Event('input', { bubbles: true }));
            assert([...document.querySelectorAll('#templateTokenStatus .variable-chip.valid')].some((item) => item.textContent === '{전화번호}') && document.querySelector('#templateTokenStatus .variable-chip.invalid')?.textContent === '{없는컬럼}', 'template column token validation');
            mailEditor.focus(); document.execCommand('selectAll', false, null);
            const transfer = new DataTransfer(); transfer.setData('text/html', '<html><head><style>.xl65{background-color:#ffff00;font-weight:bold;border:1px solid #777}</style></head><body><!--StartFragment--><table><tr><td class="xl65" onclick="alert(1)">Excel 셀</td></tr></table><script>alert(2)</script><!--EndFragment--></body></html>');
            mailEditor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
            assert(mailEditor.querySelector('table') && mailEditor.querySelector('td')?.style.backgroundColor && !mailEditor.querySelector('script') && !mailEditor.querySelector('[onclick]') && !mailEditor.textContent.includes('alert(2)'), 'rich paste should keep table/class styles and remove unsafe content: ' + mailEditor.innerHTML);
            document.querySelector('#prepareMailPackage').click();
            await waitFor(() => document.querySelectorAll('[data-mail-edit]').length === 2, 'mail preview');
            document.querySelector('[data-mail-edit]').click();
            await waitFor(() => document.querySelector('#mailEditDialog').open, 'personal mail editor');
            document.querySelector('#mailEditSubject').value += ' 개인수정';
            document.querySelector('#mailEditForm').requestSubmit();
            await waitFor(() => !document.querySelector('#mailEditDialog').open, 'personal mail saved');
            const persisted = await globalThis.workspaceDesktop.loadState();
            assert(persisted.projects.length === 2, 'projects persisted');
            const projectA = persisted.projects.find((project) => project.name === 'Smoke Project A');
            assert(projectA.data.people.length === 2 && projectA.data.slots.length === 1 && projectA.data.workItems.length === 1, 'operational project data persisted: ' + JSON.stringify({ people: projectA.data.people.length, slots: projectA.data.slots.length, workItems: projectA.data.workItems.length }));
            assert(projectA.data.communication.bodyHtmlTemplate.includes('<table') && !projectA.data.communication.bodyHtmlTemplate.includes('<script'), 'safe rich mail template persisted');
            assert(Object.keys(projectA.data.communication.mailEdits).length === 1, 'personal mail edit persisted');
            document.querySelector('[data-nav="dashboard"]').click();
            document.querySelector('[data-workflow-open="gmailFlow"]').click();
            await waitFor(() => document.querySelector('#page-gmailFlow').classList.contains('active'), 'gmail capture page');
            document.querySelector('[data-nav="dashboard"]').click();
            await waitFor(() => document.querySelectorAll('#homeQuickLaunch [data-program-launch]').length >= 5, 'home quick launch programs');
            return { passed: true };
          })()
        `);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-workflow-open="schedule"]').click(); document.querySelector('#toastRegion').replaceChildren(); document.querySelector('.schedule-board-panel').scrollIntoView({block:'start'});`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const schedulePreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-schedule-smoke.png');
        const schedulePreview = await mainWindow.webContents.capturePage();
        await fs.promises.writeFile(schedulePreviewPath, schedulePreview.toPNG());
        console.log(`Workspace schedule preview: ${schedulePreviewPath}`);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-workflow-open="people"]').click()`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const peoplePreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-people-smoke.png');
        const peoplePreview = await mainWindow.webContents.capturePage();
        await fs.promises.writeFile(peoplePreviewPath, peoplePreview.toPNG());
        console.log(`Workspace people preview: ${peoplePreviewPath}`);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#rosterStartTask').click(); document.querySelector('[data-open-arrangement]')?.click();`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const arrangementPreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-arrangement-smoke.png');
        const arrangementPreview = await mainWindow.webContents.capturePage();
        await fs.promises.writeFile(arrangementPreviewPath, arrangementPreview.toPNG());
        console.log(`Workspace arrangement preview: ${arrangementPreviewPath}`);
        const standalone = createProgramWindow('gmailFlow');
        if (standalone.webContents.isLoading()) await new Promise((resolve) => standalone.webContents.once('did-finish-load', resolve));
        const standaloneResult = await standalone.webContents.executeJavaScript(`
          (async () => {
            const end = Date.now() + 5000;
            while ((!document.querySelector('#page-compose') || document.querySelector('#openWorkspaceButton')?.hidden) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
            return {
              compose: document.querySelector('#page-compose')?.classList.contains('active'),
              originalNavigation: document.querySelectorAll('[data-page]').length >= 5,
              roster: Boolean(document.querySelector('#rosterTable') && document.querySelector('#pasteTable')),
              sendModes: document.querySelector('#sendMethod')?.options.length === 3,
              attachments: Boolean(document.querySelector('#attachmentInput')?.multiple),
              history: Boolean(document.querySelector('[data-page="history"]')),
              queue: Boolean(document.querySelector('[data-page="queue"]')),
              workspaceReturn: !document.querySelector('#openWorkspaceButton')?.hidden,
              workspaceQuery: new URLSearchParams(location.search).get('workspace') === '1'
            };
          })()
        `);
        if (!Object.values(standaloneResult).every(Boolean)) throw new Error(`Standalone Gmail Flow smoke failed: ${JSON.stringify(standaloneResult)}`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const previewPath = path.join(app.getPath('temp'), 'cmoe-workspace-standalone-smoke.png');
        const preview = await standalone.webContents.capturePage();
        await fs.promises.writeFile(previewPath, preview.toPNG());
        console.log(`Workspace smoke preview: ${previewPath}`);
        clearTimeout(timeout);
        isQuitting = true;
        app.exit(result?.passed ? 0 : 1);
      } catch (error) {
        clearTimeout(timeout);
        console.error('Workspace smoke test failed:', error);
        isQuitting = true;
        app.exit(1);
      }
    });
  }
});
