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
const WorkspaceCore = require('../workspace-core');

const isSmokeTest = process.env.CMOE_SMOKE === '1' || process.argv.includes('--smoke-test') || app.commandLine.hasSwitch('smoke-test');
const hasSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

if (isSmokeTest) { app.disableHardwareAcceleration(); app.setPath('userData', path.join(app.getPath('temp'), 'cmoe-workspace-smoke-test')); }

let mainWindow;
const programWindows = new Map();
const rosterPickerWindows = new Map();
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

function createProgramWindow(programId, options = {}) {
  const existing = programWindows.get(programId);
  if (existing && !existing.isDestroyed()) {
    if (programId === 'people' && options.projectId) existing.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1', rosterManager: '1', page: 'roster', projectId: options.projectId } });
    if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); return existing;
  }
  const legacyGmail = (programId === 'gmailFlow' || programId === 'people') && gmailFlowHost;
  const window = new BrowserWindow({ width: legacyGmail ? 1040 : 1220, height: 820, minWidth: legacyGmail ? 760 : 900, minHeight: 640, show: false, backgroundColor: legacyGmail ? '#f5f5f3' : '#f3f4f6', title: legacyGmail ? 'Gmail Flow' : `CMOE · ${programId}`, webPreferences: { preload: legacyGmail ? gmailFlowHost.preloadPath : path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => programWindows.delete(programId));
  if (programId === 'people') window.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1', rosterManager: '1', page: 'roster', projectId: options.projectId || '' } });
  else if (legacyGmail) window.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1' } });
  else window.loadFile(path.join(__dirname, '..', 'index.html'), { query: { mode: 'standalone', app: programId } });
  programWindows.set(programId, window);
  return window;
}

function createRosterPickerWindow(projectId, parentWindow = mainWindow) {
  const key = String(projectId || 'quick');
  const existing = rosterPickerWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show(); existing.focus();
    return existing;
  }
  const hasParent = Boolean(parentWindow && !parentWindow.isDestroyed());
  const window = new BrowserWindow({
    parent: hasParent ? parentWindow : undefined,
    modal: hasParent,
    width: 1080,
    height: 840,
    minWidth: 780,
    minHeight: 660,
    show: false,
    backgroundColor: '#f5f5f3',
    title: 'CMOE · 명단 준비',
    webPreferences: { preload: gmailFlowHost.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => { window.show(); window.focus(); });
  window.on('closed', () => rosterPickerWindows.delete(key));
  window.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1', rosterManager: '1', page: 'roster', projectId: key === 'quick' ? '' : key } });
  rosterPickerWindows.set(key, window);
  return window;
}

function broadcastState(next) {
  [mainWindow, ...programWindows.values(), ...rosterPickerWindows.values()].forEach((window) => { if (window && !window.isDestroyed()) window.webContents.send('workspace:state-changed', next); });
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
  ipcMain.handle('program:open', (_event, programId, options = {}) => { if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.'); createProgramWindow(programId, options); return { ok: true }; });
  ipcMain.handle('workspace:roster:open-picker', (event, projectId) => { createRosterPickerWindow(projectId, BrowserWindow.fromWebContents(event.sender) || mainWindow); return { ok: true }; });
  ipcMain.handle('workspace:roster:get', async (_event, projectId) => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const project = current.projects.find((item) => item.id === projectId) || current.quickWorkspaces?.people;
    if (!project) throw new Error('명단을 연결할 프로젝트를 찾지 못했습니다.');
    return {
      projectId: project.id,
      projectName: project.name,
      rosterName: project.data.rosterName || '',
      columns: project.data.columns.map((column) => ({ id: column.id, name: column.name, role: column.type === 'email' ? 'email' : 'variable', workspaceType: column.type || 'text' })),
      rows: project.data.people.map((person) => ({ ...person.values, __workspacePersonId: person.id, __workspaceActive: person.active !== false })),
      peopleMeta: Object.fromEntries(project.data.people.map((person) => [person.id, { roleIds: person.roleIds, active: person.active }]))
    };
  });
  ipcMain.handle('workspace:roster:save', async (_event, projectId, payload = {}) => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const projectIndex = current.projects.findIndex((item) => item.id === projectId);
    const project = projectIndex >= 0 ? current.projects[projectIndex] : current.quickWorkspaces?.people;
    if (!project) throw new Error('명단을 저장할 프로젝트를 찾지 못했습니다.');
    const oldPeople = new Map(project.data.people.map((person) => [person.id, person]));
    const aliases = { name: /^(이름|성명|name)$/i, email: /^(이메일|메일|email|e-mail)$/i, phone: /^(전화번호|휴대폰|연락처|phone|mobile)$/i, group: /^(그룹|분류|소속|group)$/i, id: /^(아이디|id)$/i };
    const columns = (payload.columns || []).map((column, index) => {
      let type = column.workspaceType || '';
      if (!type) type = Object.entries(aliases).find(([, pattern]) => pattern.test(String(column.name || '').trim()))?.[0] || (column.role === 'email' ? 'email' : 'text');
      return { id: column.id || `column-${Date.now().toString(36)}-${index}`, name: String(column.name || `컬럼${index + 1}`).trim(), type };
    });
    const people = (payload.rows || []).filter((row) => columns.some((column) => String(row[column.id] || '').trim())).map((row, index) => {
      const id = row.__workspacePersonId || `person-${Date.now().toString(36)}-${index}`;
      const previous = oldPeople.get(id);
      const values = Object.fromEntries(columns.map((column) => [column.id, String(row[column.id] ?? '')]));
      const valueFor = (type) => values[columns.find((column) => column.type === type)?.id] || '';
      const active = Object.prototype.hasOwnProperty.call(row, '__workspaceActive') ? row.__workspaceActive !== false : previous?.active !== false;
      return { id, sourceOrder: index, values, name: valueFor('name'), email: valueFor('email'), phone: valueFor('phone'), group: valueFor('group'), roleIds: previous?.roleIds || ['participant'], active };
    });
    const keptIds = new Set(people.map((person) => person.id));
    project.data.rosterName = String(payload.name || project.data.rosterName || `${project.name} 명단`).trim();
    project.data.columns = columns; project.data.people = people;
    project.data.assignments = project.data.assignments.filter((item) => keptIds.has(item.personId));
    project.data.availability = Object.fromEntries(Object.entries(project.data.availability || {}).filter(([personId]) => keptIds.has(personId)));
    project.updatedAt = new Date().toISOString();
    let next;
    if (projectIndex >= 0) next = WorkspaceCore.setModuleStatus(WorkspaceCore.updateProject(current, project.id, { data: project.data }), project.id, 'people', people.length ? 'complete' : 'inProgress', `${people.length}명 명단 저장`);
    else { current.quickWorkspaces.people = WorkspaceCore.normalizeState({ ...current, quickWorkspaces: { ...current.quickWorkspaces, people: project } }).quickWorkspaces.people; next = current; }
    next._revision = Number(current._revision || 0) + 1; next._baseRevision = next._revision;
    await storage.set('workspaceState', next);
    return { ok: true, count: people.length, state: next };
  });
  ipcMain.handle('window:close-self', (event) => { BrowserWindow.fromWebContents(event.sender)?.close(); return { ok: true }; });
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
  const preMigrationState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
  await gmailFlowHost.importLegacyRosters(preMigrationState.library?.rosters || []);
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
            document.querySelector('#newProjectTemplatePicker input[value="template-education"]').click();
            document.querySelector('#projectName').value = 'Smoke Project A';
            document.querySelector('#newProjectForm').requestSubmit();
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project A', 'first project');
            document.querySelector('#newProjectButton').click();
            document.querySelector('#newProjectTemplatePicker input[value="template-education"]').click();
            document.querySelector('#projectName').value = 'Smoke Project B';
            document.querySelector('#newProjectForm').requestSubmit();
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project B', 'second project');
            document.querySelector('[data-workflow-open="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'empty people page');
            assert(document.querySelector('#openRosterManager')?.textContent.includes('명단 가져오기'), 'shared roster manager button');
            assert(!document.querySelector('#rosterEditorTable'), 'duplicate roster editor must be removed');
            document.querySelector('#page-people [data-nav-link="dashboard"]').click();
            const switcher = document.querySelector('#projectSwitcher');
            assert(switcher.options.length === 2, 'project switcher should list two projects');
            switcher.value = [...switcher.options].find((option) => option.textContent.includes('Project A')).value;
            switcher.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project A', 'project switch');
            assert(document.querySelector('#activeWorkflowTemplate')?.textContent.includes('교육 프로그램 운영'), 'workflow template badge');
            const checklistCard = [...document.querySelectorAll('#workflowGrid .workflow-card')].find((card) => card.querySelector('h3')?.textContent.includes('출결·수료'));
            checklistCard.querySelector('[data-workflow-step-open]').click();
            await waitFor(() => document.querySelector('#page-workflowTask').classList.contains('active'), 'generic workflow task page');
            document.querySelector('#workflowChecklistInput').value = '수료 여부 확인'; document.querySelector('#workflowChecklistAdd').click();
            await waitFor(() => document.querySelectorAll('#workflowChecklist [data-workflow-check]').length === 1, 'workflow checklist item');
            document.querySelector('#workflowTaskNotes').value = '확인 필요 1건'; document.querySelector('#workflowTaskStatus').value = 'needsReview'; document.querySelector('#saveWorkflowTask').click();
            await waitFor(() => document.querySelector('#workflowTaskStatus').value === 'needsReview', 'workflow task saved');
            document.querySelector('#page-workflowTask [data-nav-link="dashboard"]').click();
            document.querySelector('#editWorkflowButton').click();
            await waitFor(() => document.querySelector('#workflowEditorDialog').open, 'workflow editor');
            document.querySelector('#workflowStepType').value = 'aiReview'; document.querySelector('#addWorkflowStep').click();
            assert(document.querySelectorAll('#workflowEditorList [data-workflow-editor-step]').length === 7, 'workflow step added');
            document.querySelector('#workflowEditorForm').requestSubmit();
            await waitFor(() => !document.querySelector('#workflowEditorDialog').open && document.querySelectorAll('#workflowGrid .workflow-card').length === 7, 'workflow editor saved');
            document.querySelector('[data-workflow-open="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'people page');
            assert(document.querySelector('#page-people h1')?.textContent === '명단 준비', 'people page purpose label');
            const smokeState = await globalThis.workspaceDesktop.loadState();
            await globalThis.workspaceDesktop.saveWorkspaceRoster(smokeState.activeProjectId, {
              columns: [
                { id: 'smoke-name', name: '이름', role: 'variable', workspaceType: 'name' },
                { id: 'smoke-email', name: '이메일', role: 'email', workspaceType: 'email' },
                { id: 'smoke-phone', name: '전화번호', role: 'variable', workspaceType: 'phone' }
              ],
              rows: [
                { 'smoke-name': '송아라', 'smoke-email': 'one@example.com', 'smoke-phone': '010-1111-1111' },
                { 'smoke-name': '조민지', 'smoke-email': 'two@example.com', 'smoke-phone': '010-2222-2222' }
              ]
            });
            await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '2', 'shared roster reflected in workspace');
            assert(!document.querySelector('#rosterPasteInput, #sharedRosterSelect'), 'legacy roster controls must be removed');
            document.querySelector('#createRosterView').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'create derived roster name'); document.querySelector('#nameInputValue').value = '필기 응시자'; document.querySelector('#nameInputForm').requestSubmit();
            await waitFor(() => [...document.querySelector('#rosterViewSelect').options].some((option) => option.textContent === '필기 응시자'), 'derived roster created');
            document.querySelector('[data-roster-view-toggle]').click(); await waitFor(() => document.querySelector('.roster-view-person.excluded'), 'derived roster exclusion');
            document.querySelector('#saveRosterViewAs').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'save next roster name'); document.querySelector('#nameInputValue').value = '필기 합격자'; document.querySelector('#nameInputForm').requestSubmit();
            await waitFor(() => [...document.querySelector('#rosterViewSelect').options].some((option) => option.textContent === '필기 합격자'), 'next derived roster created');
            assert(document.querySelectorAll('#rosterViewPeople .roster-view-person').length === 1, 'next roster contains included people only');
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
            const arrangementCopy = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: arrangementCopy, bubbles: true, cancelable: true }));
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
            assert(document.querySelectorAll('#sessionCalendarBoard [data-session-slot]').length === 1, 'session calendar card');
            assert(document.querySelectorAll('#sessionPersonPool [data-session-person]').length === 2, 'session roster person pool');
            const unassignedPerson = [...document.querySelectorAll('#sessionPersonPool [data-session-person]')].find((chip) => ![...document.querySelectorAll('[data-session-assignment]')].some((assignment) => assignment.dataset.sessionPerson === chip.dataset.sessionPerson));
            unassignedPerson.click(); document.querySelector('[data-session-slot]').click(); await waitFor(() => document.querySelectorAll('[data-session-assignment]').length === 2, 'click person into session');
            document.querySelector('[data-session-edit]').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'reschedule session dialog'); document.querySelector('#nameInputValue').value = '2026-07-06 10:00-11:00 변경 세션'; document.querySelector('#nameInputForm').requestSubmit(); await waitFor(() => document.querySelector('[data-session-slot]')?.textContent.includes('10:00–11:00'), 'session time changed');
            document.querySelector('#sessionAddEmptyTime').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'add another session dialog'); document.querySelector('#nameInputValue').value = '2026-07-06 11:00-12:00 추가 세션'; document.querySelector('#nameInputForm').requestSubmit(); await waitFor(() => document.querySelectorAll('[data-session-slot]').length === 2, 'another session added');
            const moveChip = document.querySelector('[data-session-assignment]'); const moveTransfer = new DataTransfer(); moveChip.dispatchEvent(new DragEvent('dragstart', { dataTransfer: moveTransfer, bubbles: true })); const targetSession = document.querySelectorAll('[data-session-slot]')[1]; targetSession.dispatchEvent(new DragEvent('drop', { dataTransfer: moveTransfer, bubbles: true, cancelable: true })); await waitFor(() => document.querySelectorAll('[data-session-slot]')[1]?.querySelector('[data-session-assignment]'), 'assignment moved between sessions');
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
            assert(document.querySelector('#openMailRosterManager')?.textContent.includes('명단 가져오기') && document.querySelectorAll('#mailRosterPeople .resource-chip').length === 2 && document.querySelector('#mailRosterSummary')?.textContent.trim(), 'gmail page should show the applied shared roster');
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
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#toastRegion').replaceChildren(); document.querySelector('#dashboardContent').scrollIntoView({block:'start'});`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const workflowPreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-workflow-smoke.png');
        const workflowPreview = await mainWindow.webContents.capturePage();
        await fs.promises.writeFile(workflowPreviewPath, workflowPreview.toPNG());
        console.log(`Workspace workflow preview: ${workflowPreviewPath}`);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#newProjectButton').click()`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const templatePreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-template-picker-smoke.png');
        const templatePreview = await mainWindow.webContents.capturePage();
        await fs.promises.writeFile(templatePreviewPath, templatePreview.toPNG());
        console.log(`Workspace template picker preview: ${templatePreviewPath}`);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-close-dialog="newProjectDialog"]').click()`);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-workflow-open="schedule"]').click(); document.querySelector('#toastRegion').replaceChildren(); document.querySelector('.session-planner-panel').scrollIntoView({block:'start'});`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const sessionPreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-session-planner-smoke.png');
        const sessionPreview = await mainWindow.webContents.capturePage();
        await fs.promises.writeFile(sessionPreviewPath, sessionPreview.toPNG());
        console.log(`Workspace session planner preview: ${sessionPreviewPath}`);
        await mainWindow.webContents.executeJavaScript(`document.querySelector('.schedule-board-panel').scrollIntoView({block:'start'});`);
        await new Promise((resolve) => setTimeout(resolve, 250));
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
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-nav="dashboard"]').click(); document.querySelector('[data-workflow-open="gmailFlow"]').click(); document.querySelector('#toastRegion').replaceChildren(); document.querySelector('#page-gmailFlow').scrollIntoView({block:'start'});`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const gmailPreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-gmail-smoke.png');
        const gmailPreview = await mainWindow.webContents.capturePage();
        await fs.promises.writeFile(gmailPreviewPath, gmailPreview.toPNG());
        console.log(`Workspace Gmail preview: ${gmailPreviewPath}`);
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
        const smokeState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
        const rosterManager = createRosterPickerWindow(smokeState.activeProjectId, mainWindow);
        if (!rosterManager.isModal() || rosterManager.getParentWindow() !== mainWindow) throw new Error('Shared roster picker must open as a modal child window.');
        if (rosterManager.webContents.isLoading()) await new Promise((resolve) => rosterManager.webContents.once('did-finish-load', resolve));
        const rosterManagerResult = await rosterManager.webContents.executeJavaScript(`(async () => {
          const end = Date.now() + 5000;
          while ((!document.querySelector('#page-roster')?.classList.contains('active') || !document.querySelector('#useRoster')?.textContent.includes('프로젝트에 적용')) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            managerMode: document.body.classList.contains('roster-manager-mode'),
            rosterPage: document.querySelector('#page-roster')?.classList.contains('active'),
            projectRows: document.querySelectorAll('#rosterBody tr').length >= 5,
            applyAction: document.querySelector('#useRoster')?.textContent.includes('프로젝트에 적용'),
            composeHidden: getComputedStyle(document.querySelector('[data-page="compose"]')).display === 'none'
          };
        })()`);
        if (!Object.values(rosterManagerResult).every(Boolean)) throw new Error(`Shared roster manager smoke failed: ${JSON.stringify(rosterManagerResult)}`);
        const singleCellSetup = await rosterManager.webContents.executeJavaScript(`(() => {
          const cell = document.querySelector('#rosterBody [data-sheet-row="0"][data-sheet-column="0"]'); const input = cell?.querySelector('input'); if (!cell || !input) return false;
          cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          input.value = 'ABCDE'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(5, 5);
          return cell.classList.contains('selection-anchor') && !cell.classList.contains('selected-cell');
        })()`);
        if (!singleCellSetup) throw new Error('Single roster cell did not enter text editing mode.');
        rosterManager.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); rosterManager.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const singleCellEdited = await rosterManager.webContents.executeJavaScript(`document.querySelector('#rosterBody input[data-row-index="0"]')?.value === 'ABCD'`);
        if (!singleCellEdited) throw new Error('Backspace cleared a roster cell instead of deleting one character.');
        const rosterSheetTools = await rosterManager.webContents.executeJavaScript(`(() => {
          const first = document.querySelector('#rosterBody [data-sheet-row="0"][data-sheet-column="0"]');
          const second = document.querySelector('#rosterBody [data-sheet-row="1"][data-sheet-column="0"]');
          first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          const transfer = new DataTransfer(); transfer.setData('text/plain', '일괄 값'); first.querySelector('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
          const filled = [...document.querySelectorAll('#rosterBody input[data-column-index="0"]')].slice(0, 2).every((input) => input.value === '일괄 값');
          document.querySelector('#rosterUndo').click(); const originalValue = document.querySelector('#rosterBody input[data-column-index="0"]').value; const undone = originalValue !== '일괄 값'; const clearFirst = document.querySelector('#rosterBody [data-sheet-row="0"][data-sheet-column="0"]'); const clearSecond = document.querySelector('#rosterBody [data-sheet-row="1"][data-sheet-column="0"]'); clearFirst.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); clearSecond.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); clearFirst.querySelector('input').focus();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); const cleared = [...document.querySelectorAll('#rosterBody input[data-column-index="0"]')].slice(0, 2).every((input) => input.value === '');
          document.querySelector('#rosterUndo').click(); const restored = document.querySelector('#rosterBody input[data-column-index="0"]').value === originalValue;
          return { filled, undone, cleared, restored };
        })()`);
        if (![rosterSheetTools.filled, rosterSheetTools.undone, rosterSheetTools.cleared, rosterSheetTools.restored].every(Boolean)) throw new Error(`Roster sheet tools smoke failed: ${JSON.stringify(rosterSheetTools)}`);
        const rosterExclusionTools = await rosterManager.webContents.executeJavaScript(`(async () => {
          const secondInput = document.querySelector('#rosterBody input[data-row-index="1"]');
          if (secondInput && !secondInput.value) { secondInput.value = '선별 저장 대상'; secondInput.dispatchEvent(new Event('input', { bubbles: true })); }
          const toggle = document.querySelector('[data-toggle-roster-row="0"]');
          if (!toggle) return { toggleFound: false };
          toggle.click();
          const syncEnd = Date.now() + 5000;
          while (!document.querySelector('#rosterMessage')?.textContent.includes('프로젝트에 반영') && Date.now() < syncEnd) await new Promise((resolve) => setTimeout(resolve, 25));
          const excluded = document.querySelector('#rosterBody tr')?.classList.contains('roster-row-excluded');
          const lockedInput = document.querySelector('#rosterBody input[data-row-index="0"]'); const lockedValue = lockedInput.value; const lockedReadOnly = lockedInput.readOnly;
          const overwriteTransfer = new DataTransfer(); overwriteTransfer.setData('text/plain', '잠금 변경\tlocked@example.com'); lockedInput.dispatchEvent(new ClipboardEvent('paste', { clipboardData: overwriteTransfer, bubbles: true, cancelable: true }));
          const pasteProtected = document.querySelector('#rosterBody input[data-row-index="0"]').value === lockedValue;
          const rowSelector = document.querySelector('#rosterBody [data-select-row="0"]'); rowSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); document.querySelector('#rosterDeleteRows').click();
          const deleteProtected = document.querySelector('#rosterBody tr')?.classList.contains('roster-row-excluded') && document.querySelector('#rosterBody input[data-row-index="0"]')?.value === lockedValue;
          const filteredButton = document.querySelector('#saveFilteredRoster'); filteredButton.click();
          const dialogEnd = Date.now() + 3000;
          while (!document.querySelector('#inputDialog')?.open && Date.now() < dialogEnd) await new Promise((resolve) => setTimeout(resolve, 25));
          const input = document.querySelector('#inputDialogValue'); input.value = '연기 테스트 선별 명단'; document.querySelector('#inputDialogForm').requestSubmit();
          const saveEnd = Date.now() + 5000;
          let filteredSaved = false;
          while (!filteredSaved && Date.now() < saveEnd) {
            filteredSaved = [...document.querySelectorAll('#rosterQuickMenu [data-quick-roster-id]')].some((button) => button.textContent.includes('연기 테스트 선별 명단'));
            if (!filteredSaved) await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return { toggleFound: true, excluded, lockedReadOnly, pasteProtected, deleteProtected, filteredSaved };
        })()`);
        if (!Object.values(rosterExclusionTools).every(Boolean)) throw new Error(`Roster exclusion tools smoke failed: ${JSON.stringify(rosterExclusionTools)}`);
        const excludedState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
        const excludedProject = excludedState.projects.find((project) => project.id === smokeState.activeProjectId);
        if (excludedProject?.data.people[0]?.active !== false) throw new Error('Temporary roster exclusion was not applied to the project.');
        const rosterRestoreResult = await rosterManager.webContents.executeJavaScript(`(async () => {
          document.querySelector('[data-toggle-roster-row="0"]')?.click();
          const end = Date.now() + 5000;
          while (!document.querySelector('#rosterMessage')?.textContent.includes('복원해 프로젝트에 반영') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
          return !document.querySelector('#rosterBody tr')?.classList.contains('roster-row-excluded') && document.querySelector('#rosterMessage')?.textContent.includes('복원해 프로젝트에 반영');
        })()`);
        if (!rosterRestoreResult) throw new Error('Temporary roster exclusion could not be restored.');
        const restoredState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
        const restoredProject = restoredState.projects.find((project) => project.id === smokeState.activeProjectId);
        if (restoredProject?.data.people[0]?.active === false) throw new Error('Restored roster member remained inactive in the project.');
        const rosterPreviewPath = path.join(app.getPath('temp'), 'cmoe-workspace-roster-manager-smoke.png');
        const rosterPreview = await rosterManager.webContents.capturePage();
        await fs.promises.writeFile(rosterPreviewPath, rosterPreview.toPNG());
        console.log(`Workspace roster manager preview: ${rosterPreviewPath}`);
        await rosterManager.webContents.executeJavaScript(`(() => { const input = document.querySelector('#rosterBody .cell-input'); input.value = '송아라 수정'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#useRoster').click(); })()`);
        const closeDeadline = Date.now() + 5000;
        while (!rosterManager.isDestroyed() && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
        if (!rosterManager.isDestroyed()) throw new Error('Shared roster manager did not close after applying the project roster.');
        const appliedState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
        const appliedProject = appliedState.projects.find((project) => project.id === smokeState.activeProjectId);
        if (appliedProject?.data.people[0]?.name !== '송아라 수정') throw new Error('Shared roster manager changes were not applied to the project.');
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
