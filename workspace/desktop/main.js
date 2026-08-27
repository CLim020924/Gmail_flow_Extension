const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const { JsonStorage } = require('./storage');
const { readWorkbookSheets, exportProjectWorkbook, exportWorkItemWorkbook } = require('./spreadsheet');
const { AuthManager } = require('./auth-manager');
const { ExtensionManager } = require('./extension-manager');
const { mimeDraft } = require('./mail-mime');
const { driveSnapshotIdentityMatches, preserveLocalConnectionContext } = require('./state-merge');
const { createTransactionQueue, createKeyedOperationCoordinator } = require('./transaction-queue');
const { mergeSelectedWorkspaceState, resolveExternalCommit } = require('./external-commit');
const { GmailFlowHost } = require('./gmail-flow-host');
const { DriveSyncGuardStore, connectionGuardKey, drivePayloadsEqual, isUsableDriveEtag } = require('./drive-sync-guard');
const WorkspaceCore = require('../workspace-core');
const OperationsCore = require('../operations-core');

const isSmokeTest = process.env.CMOE_SMOKE === '1' || process.argv.includes('--smoke-test') || app.commandLine.hasSwitch('smoke-test');
const smokeResultPath = path.join(app.getPath('temp'), 'cmoe-workspace-smoke-result.json');
function writeSmokeResult(status, details = {}) {
  if (!isSmokeTest) return;
  try { fs.writeFileSync(smokeResultPath, JSON.stringify({ status, ...details, updatedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
}
async function captureSmokePreview(webContents, filename, label) {
  if (!isSmokeTest || app.isPackaged) return null;
  const previewPath = path.join(app.getPath('temp'), filename);
  const preview = await webContents.capturePage();
  await fs.promises.writeFile(previewPath, preview.toPNG());
  console.log(`${label}: ${previewPath}`);
  return previewPath;
}
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
let quitReady = false;
let quitFlushInProgress = false;
let mainDriveSyncTimer = null;
let mainDriveSyncDirty = false;
let mainDriveSyncRevision = 0;
let mainDriveSyncPromise = null;
let mainDriveSyncError = null;
let driveSyncGuards;
const externalArtifactReservations = new Map();
const externalReservationOwners = new Set();
const runWorkspaceStateTransaction = createTransactionQueue();
const runDriveStateTransaction = createTransactionQueue();
const connectionOperations = createKeyedOperationCoordinator();

function releaseExternalReservation(token, ownerId = null) {
  let released = 0;
  for (const [key, reservation] of externalArtifactReservations) {
    if (reservation.token === token && (ownerId == null || reservation.ownerId === ownerId)) { externalArtifactReservations.delete(key); released += 1; }
  }
  return released;
}

function pruneExternalReservations(now = Date.now()) {
  for (const [key, reservation] of externalArtifactReservations) if (reservation.expiresAt <= now) externalArtifactReservations.delete(key);
}

function releaseExternalReservationsForOwner(ownerId) {
  for (const [key, reservation] of externalArtifactReservations) if (reservation.ownerId === ownerId) externalArtifactReservations.delete(key);
  externalReservationOwners.delete(ownerId);
}

function recomputeMergedScheduleProjects(stateInput, hints = []) {
  let next = stateInput;
  for (const projectId of [...new Set((Array.isArray(hints) ? hints : []).map((hint) => hint?.projectId).filter(Boolean))]) {
    const project = next.projects?.find((item) => item.id === projectId) || Object.values(next.quickWorkspaces || {}).find((item) => item?.id === projectId);
    if (!project) continue;
    const conflicts = OperationsCore.collectScheduleConflicts(project);
    next = WorkspaceCore.updateProject(next, projectId, { data: { conflicts } });
    if (conflicts.length) next = WorkspaceCore.setModuleStatus(next, projectId, 'schedule', 'needsReview', `병합 후 일정 문제 ${conflicts.length}건`);
  }
  return next;
}

async function persistAuthorizedConnection(connectionId, status) {
  return runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const applied = WorkspaceCore.applyConnectionAuthorization(current, connectionId, status);
    if (!applied.connection) return { ...status, state: current, connectionMissing: true, accountChanged: false };
    const next = applied.state;
    next.updatedAt = new Date().toISOString();
    next._revision = Number(current._revision || 0) + 1;
    next._baseRevision = next._revision;
    await storage.set('workspaceState', next);
    broadcastState(next);
    return {
      ...status,
      state: next,
      connectionMissing: false,
      accountChanged: applied.accountChanged,
      retiredArtifacts: applied.retiredArtifacts,
      reviewedForms: applied.reviewedForms
    };
  });
}

async function assertExpectedConnection(connectionId, expectedIdentity) {
  return runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const connection = current.connections.find((item) => item.id === connectionId);
    if (!connection || connection.status !== 'connected' || !WorkspaceCore.connectionIdentityMatches(connection, expectedIdentity)) {
      const error = new Error('계정 연결 상태가 변경되어 외부 작업을 중단했습니다. 최신 상태에서 다시 시도해주세요.');
      error.code = 'CONNECTION_STATE_CHANGED';
      throw error;
    }
    return connection;
  });
}

async function listDriveWorkspaceFiles(connectionId) {
  const name = 'cmoe-workspace-state.json';
  const query = encodeURIComponent(`name='${name}' and trashed=false`);
  const found = await authManager.request(connectionId, `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id%2Cname%2CmodifiedTime%2Cversion)&pageSize=10&orderBy=modifiedTime%20desc`);
  return Array.isArray(found.files) ? found.files : [];
}

async function fetchDriveWorkspaceMetadata(connectionId, fileId) {
  const result = await authManager.requestWithMetadata(connectionId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id%2CmodifiedTime%2Cversion%2Ctrashed`);
  return { ...result.data, etag: result.etag };
}

async function readStableDriveWorkspaceFile(connectionId, fileId, attempts = 2) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await fetchDriveWorkspaceMetadata(connectionId, fileId);
    if (before.trashed || !isUsableDriveEtag(before.etag)) {
      const error = new Error('Drive 데이터의 변경 버전을 확인하지 못해 안전하게 가져올 수 없습니다.');
      error.code = 'REMOTE_DRIVE_VERSION_MISSING';
      throw error;
    }
    const content = await authManager.requestWithMetadata(connectionId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    const after = await fetchDriveWorkspaceMetadata(connectionId, fileId);
    const expected = { fileId: before.id, modifiedTime: before.modifiedTime, etag: before.etag, version: before.version };
    if (isUsableDriveEtag(after.etag) && driveSnapshotIdentityMatches(expected, after)) {
      if (!content.data || typeof content.data !== 'object' || content.data.format !== 'cmoe-workspace') {
        const error = new Error('Drive의 Workspace 파일 형식을 확인할 수 없어 가져오기를 중단했습니다.');
        error.code = 'REMOTE_DRIVE_PAYLOAD_INVALID';
        throw error;
      }
      return { state: content.data, identity: { fileId: after.id, modifiedTime: after.modifiedTime, etag: after.etag, version: String(after.version || '') } };
    }
  }
  const error = new Error('가져오는 동안 다른 PC의 Drive 데이터가 계속 변경되었습니다. 최신 내용을 다시 가져와주세요.');
  error.code = 'REMOTE_DRIVE_STATE_CHANGED';
  throw error;
}

async function throwLatchedDriveConflict(connection, code, message, snapshot = {}) {
  try { await driveSyncGuards.markConflict(connection, message, snapshot); }
  catch (error) { console.error('Drive 충돌 잠금 저장 실패:', error); }
  const conflict = new Error(message);
  conflict.code = code;
  throw conflict;
}

async function createDriveWorkspaceFile(connection, latestState) {
  const boundary = `cmoe_workspace_${crypto.randomBytes(12).toString('hex')}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify({ name: 'cmoe-workspace-state.json', parents: ['appDataFolder'] }),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(latestState),
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const response = await authManager.requestWithMetadata(connection.id, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2CmodifiedTime%2Cversion', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const createdFileId = String(response.data?.id || '');
  const createdVersion = String(response.data?.version || '');
  if (!createdFileId || !createdVersion) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_VERSION_MISSING', 'Drive 파일은 생성됐지만 생성 버전을 확인하지 못했습니다. Drive 데이터를 다시 불러와 확인해주세요.', { fileId: createdFileId, version: createdVersion });
  }
  let snapshot;
  try { snapshot = await fetchDriveWorkspaceMetadata(connection.id, createdFileId); }
  catch (_) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_VERSION_MISSING', 'Drive 파일은 생성됐지만 안전한 변경 버전을 다시 확인하지 못했습니다. Drive 데이터를 다시 불러와 확인해주세요.', { fileId: createdFileId, version: createdVersion });
  }
  if (snapshot.trashed || String(snapshot.id || '') !== createdFileId || String(snapshot.version || '') !== createdVersion || !isUsableDriveEtag(snapshot.etag)) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_VERSION_MISSING', 'Drive 파일은 생성됐지만 안전한 변경 버전을 확인하지 못했습니다. Drive 데이터를 다시 불러와 확인해주세요.', snapshot);
  }
  const files = await listDriveWorkspaceFiles(connection.id);
  if (files.length !== 1 || String(files[0]?.id || '') !== createdFileId) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_DUPLICATE_FILES', '동시에 만들어진 Workspace Drive 파일이 둘 이상 확인되어 자동 저장을 중단했습니다. 데이터를 덮어쓰지 않았으니 Drive 상태를 점검해주세요.', snapshot);
  }
  await driveSyncGuards.observeRemote(connection, snapshot);
  return { ...snapshot, fileId: snapshot.id };
}

async function uploadLatestWorkspaceStateToDrive(connectionId, expectedIdentity) {
  const connection = await assertExpectedConnection(connectionId, expectedIdentity);
  if (!connectionGuardKey(connection)) {
    const error = new Error('Drive 동기화 기준을 계정별로 보호할 수 없어 저장을 중단했습니다. Drive 계정에 다시 로그인해주세요.');
    error.code = 'DRIVE_ACCOUNT_IDENTITY_MISSING';
    throw error;
  }
  const latestState = await runWorkspaceStateTransaction(async () => WorkspaceCore.normalizeState(await storage.get('workspaceState', null)));
  const guard = await driveSyncGuards.get(connection);
  if (guard?.state === 'conflict') {
    const error = new Error(guard.reason || '다른 PC의 Drive 변경이 확인되어 자동 저장이 잠겼습니다. 최신 Drive 데이터를 다시 불러와 확인해주세요.');
    error.code = 'REMOTE_DRIVE_CONFLICT_LATCHED';
    throw error;
  }
  const files = await listDriveWorkspaceFiles(connectionId);
  const canonicalFile = files[0] || null;
  if (files.length > 1) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_DUPLICATE_FILES', 'Drive에 Workspace 파일이 둘 이상 있어 어느 데이터를 기준으로 할지 안전하게 판단할 수 없습니다. 자동 저장을 중단했습니다.', canonicalFile || guard || {});
  }
  if (!guard || guard.state === 'empty') {
    if (canonicalFile) {
      const stableRemote = await readStableDriveWorkspaceFile(connectionId, canonicalFile.id);
      const normalizedRemote = WorkspaceCore.normalizeState(stableRemote.state);
      if (drivePayloadsEqual(latestState, normalizedRemote)) {
        await driveSyncGuards.observeRemote(connection, stableRemote.identity);
        return { fileId: stableRemote.identity.fileId, modifiedTime: stableRemote.identity.modifiedTime, version: stableRemote.identity.version, migratedBaseline: true };
      }
      await throwLatchedDriveConflict(connection, 'DRIVE_SYNC_BASELINE_REQUIRED', '이 PC가 아직 확인하지 않은 Workspace 데이터가 Drive에 있습니다. 덮어쓰지 않고 중단했으니 먼저 Drive 자료를 가져와 확인해주세요.', canonicalFile);
    }
    const created = await createDriveWorkspaceFile(connection, latestState);
    return { fileId: created.fileId, modifiedTime: created.modifiedTime || new Date().toISOString(), version: created.version || '' };
  }
  if (guard.state !== 'ready' || !guard.fileId || !isUsableDriveEtag(guard.etag)) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_VERSION_MISSING', '마지막으로 확인한 Drive 변경 버전이 없어 자동 저장을 중단했습니다. 최신 Drive 데이터를 다시 불러와 확인해주세요.', guard || {});
  }
  if (!canonicalFile || String(canonicalFile.id || '') !== guard.fileId) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_STATE_CHANGED', '다른 PC에서 Drive의 Workspace 파일이 바뀌거나 삭제되어 자동 저장을 중단했습니다. 최신 Drive 데이터를 다시 불러와 확인해주세요.', guard);
  }
  let currentRemote;
  try {
    currentRemote = await fetchDriveWorkspaceMetadata(connectionId, guard.fileId);
  } catch (error) {
    if (error?.status === 404) await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_STATE_CHANGED', 'Drive의 Workspace 파일이 삭제되어 자동 저장을 중단했습니다. Drive 자료를 다시 확인해주세요.', guard);
    throw error;
  }
  if (currentRemote.trashed
    || String(currentRemote.id || '') !== guard.fileId
    || !isUsableDriveEtag(currentRemote.etag)
    || currentRemote.etag !== guard.etag
    || (guard.version && String(currentRemote.version || '') !== guard.version)) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_STATE_CHANGED', '다른 PC에서 Drive 데이터가 변경되어 이 PC의 자동 저장을 중단했습니다. 최신 Drive 데이터를 다시 불러와 확인해주세요.', currentRemote);
  }
  let uploaded;
  try {
    uploaded = await authManager.requestWithMetadata(connectionId, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(guard.fileId)}?uploadType=media&fields=id%2CmodifiedTime%2Cversion`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': guard.etag },
      body: JSON.stringify(latestState)
    });
  } catch (error) {
    if ([404, 412].includes(error?.status)) await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_STATE_CHANGED', '다른 PC에서 Drive 데이터가 먼저 변경되어 이 PC의 자동 저장을 중단했습니다. 최신 Drive 데이터를 다시 불러와 확인해주세요.', guard);
    throw error;
  }
  const uploadedVersion = String(uploaded.data?.version || '');
  if (!uploadedVersion) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_VERSION_MISSING', 'Drive 저장은 완료됐지만 새 파일 버전을 확인하지 못했습니다. 추가 덮어쓰기를 막았으니 Drive 데이터를 다시 불러와 확인해주세요.', { fileId: guard.fileId });
  }
  let snapshot;
  try { snapshot = await fetchDriveWorkspaceMetadata(connectionId, guard.fileId); }
  catch (_) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_VERSION_MISSING', 'Drive 저장은 완료됐지만 새 변경 버전을 다시 확인하지 못했습니다. 추가 덮어쓰기를 막았으니 Drive 데이터를 다시 불러와 확인해주세요.', { fileId: guard.fileId, version: uploadedVersion });
  }
  if (snapshot.trashed || String(snapshot.id || '') !== guard.fileId || String(snapshot.version || '') !== uploadedVersion || !isUsableDriveEtag(snapshot.etag)) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_STATE_CHANGED', 'Drive 저장 직후 다른 변경이 확인되어 추가 자동 저장을 중단했습니다. 최신 Drive 데이터를 다시 불러와 확인해주세요.', snapshot);
  }
  const confirmedFiles = await listDriveWorkspaceFiles(connectionId);
  if (confirmedFiles.length !== 1 || String(confirmedFiles[0]?.id || '') !== guard.fileId) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_DUPLICATE_FILES', 'Drive 저장 중 Workspace 파일 계보가 둘 이상 확인되어 추가 자동 저장을 중단했습니다.', snapshot);
  }
  await driveSyncGuards.observeRemote(connection, snapshot);
  return { fileId: snapshot.id, modifiedTime: snapshot.modifiedTime || new Date().toISOString(), version: snapshot.version || '' };
}

function markMainDriveStateDirty(nextState) {
  mainDriveSyncRevision += 1;
  if (nextState?.preferences?.storageMode !== 'drive') {
    mainDriveSyncDirty = false;
    mainDriveSyncError = null;
    clearTimeout(mainDriveSyncTimer);
    mainDriveSyncTimer = null;
    return;
  }
  mainDriveSyncDirty = true;
  clearTimeout(mainDriveSyncTimer);
  mainDriveSyncTimer = setTimeout(() => {
    mainDriveSyncTimer = null;
    void flushMainDriveStateSync().catch((error) => { mainDriveSyncError = error; });
  }, 1500);
}

async function flushMainDriveStateSync() {
  clearTimeout(mainDriveSyncTimer);
  mainDriveSyncTimer = null;
  if (mainDriveSyncPromise) return mainDriveSyncPromise;
  mainDriveSyncPromise = (async () => {
    while (mainDriveSyncDirty) {
      const capturedRevision = mainDriveSyncRevision;
      const latestState = await runWorkspaceStateTransaction(async () => WorkspaceCore.normalizeState(await storage.get('workspaceState', null)));
      if (latestState.preferences.storageMode !== 'drive') { mainDriveSyncDirty = false; break; }
      const connection = latestState.connections.find((item) => item.type === 'drive' && item.status === 'connected');
      if (!connection) throw new Error('Google Drive 저장 모드이지만 연결된 Drive 계정이 없습니다. Drive 계정을 다시 연결하거나 저장 위치를 이 PC로 바꿔주세요.');
      await connectionOperations.run(connection.id, () => runDriveStateTransaction(() => uploadLatestWorkspaceStateToDrive(connection.id, WorkspaceCore.connectionIdentity(connection))));
      if (mainDriveSyncRevision === capturedRevision) mainDriveSyncDirty = false;
    }
    mainDriveSyncError = null;
    return true;
  })();
  try { return await mainDriveSyncPromise; }
  finally { mainDriveSyncPromise = null; }
}

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

function flushWorkspaceWindow(targetWindow, timeoutMs = 10_000) {
  if (!targetWindow || targetWindow.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('변경사항 저장 시간이 초과되었습니다.')), timeoutMs);
    targetWindow.webContents.executeJavaScript('globalThis.flushWorkspaceEdits?.()').then((result) => {
      clearTimeout(timeout);
      if (result !== true) reject(new Error('이 창이 변경사항 저장 완료를 확인하지 못했습니다.')); else resolve();
    }, (error) => { clearTimeout(timeout); reject(error); });
  });
}

function protectWorkspaceWindowClose(targetWindow) {
  let closeReady = false;
  let flushing = false;
  targetWindow.on('close', (event) => {
    if (isQuitting || closeReady || targetWindow.isDestroyed()) return;
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    targetWindow.setEnabled(false);
    flushWorkspaceWindow(targetWindow).then(() => {
      if (targetWindow.isDestroyed()) return;
      closeReady = true;
      targetWindow.close();
    }).catch((error) => {
      if (targetWindow.isDestroyed()) return;
      flushing = false;
      targetWindow.setEnabled(true);
      targetWindow.show(); targetWindow.focus();
      void dialog.showMessageBox(targetWindow, { type: 'warning', title: '변경사항 저장 필요', message: '아직 저장하지 못한 변경사항이 있어 창을 닫지 않았습니다.', detail: error?.message || '잠시 후 다시 시도해주세요.' });
    });
  });
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
  protectWorkspaceWindowClose(window);
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
  protectWorkspaceWindowClose(window);
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
  protectWorkspaceWindowClose(mainWindow);
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2 || isSmokeTest) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'), isSmokeTest ? { query: { smoke: '1' } } : undefined);
}

function registerIpc() {
  ipcMain.handle('workspace:load', () => storage.get('workspaceState', null));
  ipcMain.handle('workspace:save', (event, incoming) => runWorkspaceStateTransaction(async () => {
    const mergeHints = incoming?._mergeHints && typeof incoming._mergeHints === 'object' ? incoming._mergeHints : {};
    const externalCommit = incoming?._externalCommit && typeof incoming._externalCommit === 'object' ? incoming._externalCommit : null;
    let cleanIncoming = { ...(incoming || {}) };
    delete cleanIncoming._mergeHints;
    delete cleanIncoming._externalCommit;
    const current = await storage.get('workspaceState', null);
    let externalConflict = false; let externalConflictReason = '';
    if (externalCommit) {
      pruneExternalReservations();
      const resolved = resolveExternalCommit(WorkspaceCore.normalizeState(current), cleanIncoming, externalCommit, externalArtifactReservations, event.sender.id);
      cleanIncoming = resolved.state;
      externalConflict = !resolved.ok;
      externalConflictReason = resolved.reason;
    }
    const mergedState = mergeSelectedWorkspaceState(current, cleanIncoming, mergeHints);
    const { currentRevision } = mergedState;
    let next = mergedState.state;
    next = recomputeMergedScheduleProjects(next, mergeHints.scheduleProjects);
    next._revision = currentRevision + 1; next._baseRevision = next._revision;
    await storage.set('workspaceState', next);
    return { ok: true, state: next, merged: mergedState.merged, externalConflict, externalConflictReason };
  }));
  ipcMain.handle('workspace:app-info', () => ({ version: app.getVersion(), userDataPath: app.getPath('userData') }));
  ipcMain.handle('workspace:external-reserve', (event, payload = {}) => {
    pruneExternalReservations();
    const projectId = String(payload.projectId || '').trim(); const kind = String(payload.kind || '').trim();
    const keys = [...new Set((Array.isArray(payload.keys) ? payload.keys : []).map((key) => String(key || '').trim()).filter(Boolean))];
    if (!projectId || !['zoom', 'gmailDraft', 'googleForm', 'connection'].includes(kind) || !keys.length || keys.some((key) => key.length > 200)) throw new Error('외부 작업 예약 정보가 올바르지 않습니다.');
    const logicalKeys = keys.map((key) => `${projectId}:${kind}:${key}`);
    const busyKeys = logicalKeys.filter((key) => externalArtifactReservations.has(key)).map((key) => key.slice(`${projectId}:${kind}:`.length));
    if (busyKeys.length) return { ok: false, busyKeys };
    const token = crypto.randomUUID(); const ownerId = event.sender.id; const expiresAt = Date.now() + 15 * 60 * 1000;
    logicalKeys.forEach((key) => externalArtifactReservations.set(key, { token, ownerId, expiresAt }));
    if (!externalReservationOwners.has(ownerId)) { externalReservationOwners.add(ownerId); event.sender.once('destroyed', () => releaseExternalReservationsForOwner(ownerId)); }
    return { ok: true, token, expiresAt, keys };
  });
  ipcMain.handle('workspace:external-release', (event, token) => ({ ok: true, released: releaseExternalReservation(String(token || ''), event.sender.id) }));
  ipcMain.handle('program:open', (_event, programId, options = {}) => { if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.'); createProgramWindow(programId, options); return { ok: true }; });
  ipcMain.handle('workspace:roster:open-picker', (event, projectId) => { createRosterPickerWindow(projectId, BrowserWindow.fromWebContents(event.sender) || mainWindow); return { ok: true }; });
  ipcMain.handle('workspace:roster:sources', async (_event, projectId) => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const project = current.projects.find((item) => item.id === (projectId || current.activeProjectId)) || current.quickWorkspaces?.people;
    const toPopupRoster = (roster, source) => ({
      id: roster.id,
      name: roster.name,
      source,
      columns: (roster.columns || []).map((column) => ({ id: column.id, name: column.name, role: column.type === 'email' ? 'email' : 'variable', workspaceType: column.type || 'text' })),
      rows: (roster.people || []).map((person) => ({ ...person.values, __workspacePersonId: person.id, __workspaceActive: person.active !== false }))
    });
    const projectRoster = project ? toPopupRoster({ id: project.id, name: project.data.rosterName || `${project.name} 명단`, columns: project.data.columns, people: project.data.people }, 'project') : null;
    return { projectRoster, savedRosters: current.library.rosters.map((roster) => toPopupRoster(roster, 'saved')) };
  });
  ipcMain.handle('workspace:roster:library-save', (_event, payload = {}) => runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const aliases = { name: /^(이름|성명|name)$/i, email: /^(이메일|메일|email|e-mail)$/i, phone: /^(전화번호|휴대폰|연락처|phone|mobile)$/i, group: /^(그룹|분류|소속|group)$/i, id: /^(아이디|id)$/i };
    const columns = (payload.columns || []).map((column, index) => {
      const type = column.workspaceType || Object.entries(aliases).find(([, pattern]) => pattern.test(String(column.name || '').trim()))?.[0] || (column.role === 'email' ? 'email' : 'text');
      return { id: column.id || `column-${Date.now().toString(36)}-${index}`, name: String(column.name || `컬럼${index + 1}`).trim(), type };
    });
    const people = (payload.rows || []).filter((row) => columns.some((column) => String(row[column.id] || '').trim())).map((row, index) => {
      const values = Object.fromEntries(columns.map((column) => [column.id, String(row[column.id] ?? '')]));
      const valueFor = (type) => values[columns.find((column) => column.type === type)?.id] || '';
      return { id: row.__workspacePersonId || `person-${Date.now().toString(36)}-${index}`, sourceOrder: index, values, name: valueFor('name'), email: valueFor('email'), phone: valueFor('phone'), group: valueFor('group'), roleIds: ['participant'], active: row.__workspaceActive !== false };
    });
    const now = new Date().toISOString();
    const id = String(payload.id || `roster-${Date.now().toString(36)}`);
    const existingIndex = current.library.rosters.findIndex((item) => item.id === id);
    const item = { id, name: String(payload.name || '저장 명단').trim(), columns, people, savedAt: existingIndex >= 0 ? current.library.rosters[existingIndex].savedAt : now, updatedAt: now };
    if (existingIndex >= 0) current.library.rosters[existingIndex] = item; else current.library.rosters.unshift(item);
    current.updatedAt = now;
    current._revision = Number(current._revision || 0) + 1; current._baseRevision = current._revision;
    await storage.set('workspaceState', current); broadcastState(current);
    return {
      ok: true,
      roster: {
        id: item.id, name: item.name, source: 'saved',
        columns: item.columns.map((column) => ({ id: column.id, name: column.name, role: column.type === 'email' ? 'email' : 'variable', workspaceType: column.type || 'text' })),
        rows: item.people.map((person) => ({ ...person.values, __workspacePersonId: person.id, __workspaceActive: person.active !== false }))
      }
    };
  }));
  ipcMain.handle('workspace:roster:library-delete', (_event, rosterId) => runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    current.library.rosters = current.library.rosters.filter((item) => item.id !== rosterId);
    current.updatedAt = new Date().toISOString();
    current._revision = Number(current._revision || 0) + 1; current._baseRevision = current._revision;
    await storage.set('workspaceState', current); broadcastState(current); return { ok: true };
  }));
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
  ipcMain.handle('workspace:roster:save', (_event, projectId, payload = {}) => runWorkspaceStateTransaction(async () => {
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
    const removedIds = new Set(project.data.people.filter((person) => !keptIds.has(person.id)).map((person) => person.id));
    const lockedRemovedAssignment = project.data.assignments.find((assignment) => removedIds.has(assignment.personId) && (assignment.locked || project.data.slots.some((slot) => slot.id === assignment.slotId && slot.locked)));
    if (lockedRemovedAssignment) throw new Error('잠긴 일정에 배정된 인원이 명단에서 제외되었습니다. 해당 일정의 잠금을 해제한 뒤 다시 저장해주세요.');
    const beforeAssignments = project.data.assignments.map((assignment) => ({ ...assignment }));
    const personSignature = (person) => JSON.stringify(person ? [person.name, person.email, person.phone, person.group, person.active !== false, [...(person.roleIds || [])].sort(), Object.entries(person.values || {}).sort(([left], [right]) => left.localeCompare(right))] : null);
    const columnsChanged = JSON.stringify(project.data.columns.map((column) => [column.id, column.name, column.type])) !== JSON.stringify(columns.map((column) => [column.id, column.name, column.type]));
    const rosterChanged = columnsChanged || project.data.people.length !== people.length || people.some((person) => personSignature(person) !== personSignature(oldPeople.get(person.id)));
    project.data.rosterName = String(payload.name || project.data.rosterName || `${project.name} 명단`).trim();
    project.data.columns = columns; project.data.people = people;
    project.data.assignments = project.data.assignments.filter((item) => keptIds.has(item.personId));
    project.data.availability = Object.fromEntries(Object.entries(project.data.availability || {}).filter(([personId]) => keptIds.has(personId)));
    project.data.conflicts = OperationsCore.collectScheduleConflicts(project);
    const zoomReviewSlotIds = project.data.slots.filter((slot) => beforeAssignments.some((assignment) => assignment.slotId === slot.id) && !project.data.assignments.some((assignment) => assignment.slotId === slot.id)).map((slot) => slot.id);
    if (rosterChanged) {
      const now = new Date().toISOString();
      project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
        if (artifact.kind === 'gmailDraft' && removedIds.has(artifact.personId)) return { ...artifact, status: 'superseded', replacedAt: now };
        if (artifact.kind === 'gmailDraft' && artifact.status !== 'superseded') return { ...artifact, status: 'stale' };
        if (artifact.kind === 'zoom' && zoomReviewSlotIds.includes(artifact.slotId) && artifact.status !== 'superseded') return { ...artifact, status: 'stale' };
        return artifact;
      });
      project.data.slots.filter((slot) => zoomReviewSlotIds.includes(slot.id) && slot.status === 'confirmed').forEach((slot) => { slot.status = 'changed'; });
    }
    project.updatedAt = new Date().toISOString();
    let next;
    if (projectIndex >= 0) {
      next = WorkspaceCore.setModuleStatus(WorkspaceCore.updateProject(current, project.id, { data: project.data }), project.id, 'people', people.length ? 'complete' : 'inProgress', `${people.length}명 명단 저장`);
      if (project.data.slots.length && rosterChanged) next = WorkspaceCore.setModuleStatus(next, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'stale', project.data.conflicts.length ? `명단 변경 후 문제 ${project.data.conflicts.length}건` : '명단 변경 후 일정 재검토 필요');
      if (project.data.externalArtifacts.some((artifact) => artifact.kind === 'gmailDraft' && artifact.status === 'stale')) next = WorkspaceCore.setModuleStatus(next, project.id, 'gmailFlow', 'stale', '명단 변경 후 안내 메일 확인 필요');
      if (project.data.externalArtifacts.some((artifact) => artifact.kind === 'zoom' && artifact.status === 'stale')) next = WorkspaceCore.setModuleStatus(next, project.id, 'zoom', 'stale', '명단 변경 후 Zoom 확인 필요');
    }
    else { current.quickWorkspaces.people = WorkspaceCore.normalizeState({ ...current, quickWorkspaces: { ...current.quickWorkspaces, people: project } }).quickWorkspaces.people; next = current; }
    next.updatedAt = new Date().toISOString();
    next._revision = Number(current._revision || 0) + 1; next._baseRevision = next._revision;
    await storage.set('workspaceState', next);
    broadcastState(next);
    return { ok: true, count: people.length, state: next };
  }));
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
  ipcMain.handle('connection:config', (_event, connectionId, config) => connectionOperations.transition(connectionId, () => authManager.setConfig(connectionId, config)));
  ipcMain.handle('connection:status', (_event, connectionId) => authManager.publicStatus(connectionId));
  ipcMain.handle('connection:authorize', (_event, connectionId, options) => connectionOperations.transition(connectionId, async () => {
    const status = await authManager.authorize(connectionId, options);
    return persistAuthorizedConnection(connectionId, status);
  }));
  ipcMain.handle('connection:disconnect', (_event, connectionId) => connectionOperations.transition(connectionId, async () => {
    const status = await authManager.disconnect(connectionId);
    return persistAuthorizedConnection(connectionId, status);
  }));
  ipcMain.handle('connection:remove', (_event, connectionId) => connectionOperations.transition(connectionId, () => authManager.remove(connectionId)));
  ipcMain.handle('forms:create', (_event, connectionId, definition, requests, expectedIdentity) => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    const created = await authManager.request(connectionId, 'https://forms.googleapis.com/v1/forms', jsonBody({ info: { title: definition.title, documentTitle: definition.title } }));
    const updated = await authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${encodeURIComponent(created.formId)}:batchUpdate`, jsonBody({ requests }));
    const questionIds = {};
    const createReplies = (updated.replies || []).filter((reply) => reply.createItem);
    definition.questions.forEach((question, index) => {
      const id = createReplies[index]?.createItem?.item?.questionItem?.question?.questionId;
      if (id) questionIds[question.key] = id;
    });
    return { formId: created.formId, responderUri: created.responderUri || '', editUri: `https://docs.google.com/forms/d/${created.formId}/edit`, questionIds };
  }));
  ipcMain.handle('forms:responses', (_event, connectionId, formId, expectedIdentity) => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    const id = encodeURIComponent(formId);
    const form = await authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${id}`);
    const responseData = await authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${id}/responses`);
    return { form, responses: responseData.responses || [] };
  }));
  ipcMain.handle('zoom:create', (_event, connectionId, meeting, expectedIdentity) => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    return authManager.request(connectionId, 'https://api.zoom.us/v2/users/me/meetings', jsonBody({
      topic: meeting.topic,
      type: 2,
      start_time: `${meeting.date}T${meeting.startTime}:00`,
      duration: meeting.duration,
      timezone: meeting.timezone || 'Asia/Seoul',
      agenda: meeting.agenda || '',
      settings: { waiting_room: true, join_before_host: false, mute_upon_entry: true }
    }));
  }));
  ipcMain.handle('gmail:create-draft', (_event, connectionId, mail, expectedIdentity) => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    return authManager.request(connectionId, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', jsonBody({ message: { raw: mimeDraft({ to: mail.email, subject: mail.subject, body: mail.body, bodyHtml: mail.bodyHtml }) } }));
  }));
  ipcMain.handle('gmail:update-draft', (_event, connectionId, draftId, mail, expectedIdentity) => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    return authManager.request(connectionId, `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, { ...jsonBody({ id: draftId, message: { raw: mimeDraft({ to: mail.email, subject: mail.subject, body: mail.body, bodyHtml: mail.bodyHtml }) } }), method: 'PUT' });
  }));
  ipcMain.handle('drive:push', (_event, connectionId, _rendererState, expectedIdentity) => {
    const capturedRevision = mainDriveSyncRevision;
    return connectionOperations.run(connectionId, () => runDriveStateTransaction(() => uploadLatestWorkspaceStateToDrive(connectionId, expectedIdentity))).then((result) => {
      if (mainDriveSyncRevision === capturedRevision) mainDriveSyncDirty = false;
      mainDriveSyncError = null;
      return result;
    });
  });
  ipcMain.handle('drive:pull', (_event, connectionId, expectedIdentity) => connectionOperations.run(connectionId, () => runDriveStateTransaction(async () => {
    const connection = await assertExpectedConnection(connectionId, expectedIdentity);
    if (!connectionGuardKey(connection)) {
      const error = new Error('Drive 동기화 기준을 계정별로 확인할 수 없습니다. Drive 계정에 다시 로그인해주세요.');
      error.code = 'DRIVE_ACCOUNT_IDENTITY_MISSING';
      throw error;
    }
    const files = await listDriveWorkspaceFiles(connectionId);
    if (files.length > 1) {
      const error = new Error('Drive에 Workspace 파일이 둘 이상 있어 안전하게 가져올 수 없습니다. 데이터를 덮어쓰지 않았으니 Drive 상태를 점검해주세요.');
      error.code = 'REMOTE_DRIVE_DUPLICATE_FILES';
      throw error;
    }
    const file = files[0];
    if (!file) {
      await driveSyncGuards.observeEmpty(connection);
      return { exists: false };
    }
    const stable = await readStableDriveWorkspaceFile(connectionId, file.id);
    return { exists: true, state: stable.state, ...stable.identity };
  })));
  ipcMain.handle('drive:apply-pull', (_event, connectionId, pulledState, fileId, modifiedTime, expectedIdentity, expectedWorkspaceIdentity, etag, version) => connectionOperations.run(connectionId, () => runDriveStateTransaction(() => runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const connection = current.connections.find((item) => item.id === connectionId);
    if (!connection || connection.status !== 'connected' || !WorkspaceCore.connectionIdentityMatches(connection, expectedIdentity)) {
      const error = new Error('Drive 데이터를 확인하는 동안 계정 연결 상태가 변경되었습니다. 최신 상태에서 다시 시도해주세요.');
      error.code = 'CONNECTION_STATE_CHANGED';
      throw error;
    }
    const expectedRevision = Number(expectedWorkspaceIdentity?._revision || 0);
    const expectedUpdatedAt = String(expectedWorkspaceIdentity?.updatedAt || '');
    if (Number(current._revision || 0) !== expectedRevision || String(current.updatedAt || '') !== expectedUpdatedAt) {
      const error = new Error('Drive 데이터를 확인하는 동안 이 PC의 Workspace가 변경되었습니다. 변경 내용을 보호하기 위해 불러오기를 중단했습니다.');
      error.code = 'WORKSPACE_STATE_CHANGED';
      throw error;
    }
    if (!isUsableDriveEtag(etag)) {
      const error = new Error('가져온 Drive 데이터의 변경 버전을 확인할 수 없어 적용을 중단했습니다.');
      error.code = 'REMOTE_DRIVE_VERSION_MISSING';
      throw error;
    }
    const files = await listDriveWorkspaceFiles(connectionId);
    if (files.length !== 1 || String(files[0]?.id || '') !== String(fileId || '')) {
      const error = new Error('확인하는 동안 Drive의 Workspace 파일이 바뀌었습니다. 최신 내용을 다시 불러와 확인해주세요.');
      error.code = 'REMOTE_DRIVE_STATE_CHANGED';
      throw error;
    }
    const remoteFile = await fetchDriveWorkspaceMetadata(connectionId, fileId);
    if (!driveSnapshotIdentityMatches({ fileId, modifiedTime, etag, version }, remoteFile)) {
      const error = new Error('확인하는 동안 다른 PC의 Drive 데이터가 변경되었습니다. 최신 내용을 다시 불러와 확인해주세요.');
      error.code = 'REMOTE_DRIVE_STATE_CHANGED';
      throw error;
    }
    if (!isUsableDriveEtag(remoteFile.etag)) {
      const error = new Error('Drive 데이터의 변경 버전을 확인하지 못해 안전하게 불러올 수 없습니다. 잠시 후 다시 시도해주세요.');
      error.code = 'REMOTE_DRIVE_VERSION_MISSING';
      throw error;
    }
    const next = WorkspaceCore.normalizeState(preserveLocalConnectionContext(pulledState, current));
    next.preferences.storageMode = 'drive';
    next.preferences.lastDriveSyncAt = modifiedTime || new Date().toISOString();
    next.updatedAt = new Date().toISOString();
    next._revision = Number(current._revision || 0) + 1;
    next._baseRevision = next._revision;
    await storage.set('workspaceState', next);
    await driveSyncGuards.observeRemote(connection, { fileId, modifiedTime: remoteFile.modifiedTime, etag: remoteFile.etag, version: remoteFile.version });
    broadcastState(next);
    return { ok: true, state: next };
  }))));
}

app.setAppUserModelId('kr.co.cmoe.workspace');
app.on('before-quit', (event) => {
  if (quitReady) { isQuitting = true; return; }
  event.preventDefault();
  if (quitFlushInProgress) return;
  quitFlushInProgress = true;
  const windows = [...new Set([mainWindow, ...programWindows.values(), ...rosterPickerWindows.values()].filter((window) => window && !window.isDestroyed()))];
  windows.forEach((window) => window.setEnabled(false));
  Promise.all(windows.map((window) => flushWorkspaceWindow(window, 15_000)))
    .then(() => gmailFlowHost?.flushMailQueue?.())
    .then(() => flushMainDriveStateSync()).then(() => {
    quitReady = true; isQuitting = true; app.quit();
  }).catch((error) => {
    quitFlushInProgress = false; isQuitting = false;
    void gmailFlowHost?.resumeMailQueue?.().catch(console.error);
    windows.forEach((window) => { if (!window.isDestroyed()) window.setEnabled(true); });
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    void dialog.showMessageBox(parent, { type: 'warning', title: '변경사항 저장 필요', message: '아직 저장하지 못한 변경사항이 있어 앱을 종료하지 않았습니다.', detail: error?.message || '잠시 후 다시 시도해주세요.' });
  });
});
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
    if (next) { broadcastState(next); markMainDriveStateDirty(next); }
  });
  driveSyncGuards = new DriveSyncGuardStore(storage);
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
  const centralRosterMigrationKey = 'workspaceCentralRosterMigrationV1';
  const centralRosterMigrationState = await gmailFlowHost.storage.get({ [centralRosterMigrationKey]: false, savedRosters: [] });
  if (!centralRosterMigrationState[centralRosterMigrationKey]) {
    const legacyRosters = Array.isArray(centralRosterMigrationState.savedRosters) ? centralRosterMigrationState.savedRosters : [];
    const existingIds = new Set(preMigrationState.library.rosters.map((roster) => roster.id));
    let imported = 0;
    for (const roster of Array.isArray(legacyRosters) ? legacyRosters : []) {
      if (!roster?.id || String(roster.id).startsWith('workspace-') || existingIds.has(roster.id)) continue;
      const columns = (roster.columns || []).map((column, index) => ({ id: column.id || `legacy-column-${index}`, name: String(column.name || `컬럼${index + 1}`), type: column.workspaceType || (column.role === 'email' ? 'email' : 'text') }));
      const people = (roster.rows || []).filter((row) => columns.some((column) => String(row[column.id] || '').trim())).map((row, index) => {
        const values = Object.fromEntries(columns.map((column) => [column.id, String(row[column.id] ?? '')]));
        const valueFor = (type) => values[columns.find((column) => column.type === type)?.id] || '';
        return { id: row.__workspacePersonId || `person-${Date.now().toString(36)}-${index}`, sourceOrder: index, values, name: valueFor('name'), email: valueFor('email'), phone: valueFor('phone'), group: valueFor('group'), roleIds: ['participant'], active: row.__workspaceActive !== false };
      });
      preMigrationState.library.rosters.push({ id: roster.id, name: roster.name || '이전 Gmail Flow 명단', columns, people, savedAt: roster.createdAt || new Date().toISOString(), updatedAt: roster.updatedAt || new Date().toISOString() });
      existingIds.add(roster.id); imported += 1;
    }
    if (imported) {
      preMigrationState.updatedAt = new Date().toISOString(); preMigrationState._revision = Number(preMigrationState._revision || 0) + 1; preMigrationState._baseRevision = preMigrationState._revision;
      await storage.set('workspaceState', preMigrationState);
    }
    await gmailFlowHost.storage.set({ [centralRosterMigrationKey]: true });
  }
  await gmailFlowHost.importLegacyRosters(preMigrationState.library?.rosters || []);
  registerIpc();
  const initialProgram = requestedProgram();
  if (initialProgram && !isSmokeTest) createProgramWindow(initialProgram); else createWindow();

  if (isSmokeTest) {
    writeSmokeResult('running', { step: 'started' });
    const timeout = setTimeout(() => {
      console.error('Workspace smoke test timed out.');
      writeSmokeResult('timeout', { step: 'global-timeout' });
      isQuitting = true;
      app.exit(1);
    }, 45_000);
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
            assert(document.querySelector('#openRosterManager')?.textContent.includes('공용 명단 관리'), 'shared roster manager button');
            assert(document.querySelector('#rosterEditorTable') && document.querySelector('#rosterCellValue'), 'inline roster spreadsheet and formula bar');
            assert(document.querySelector('#rosterPasteInput') && document.querySelector('#chooseExcelRoster') && document.querySelector('#sharedRosterSelect'), 'inline roster paste, file import, and save-load controls');
            assert(document.querySelector('.roster-editor-guide')?.textContent.includes('드래그로 범위 선택 · Ctrl+C/V · 제외 행 잠금'), 'persistent roster spreadsheet guide');
            const projectBId = (await globalThis.workspaceDesktop.loadState()).activeProjectId;
            document.querySelector('[data-empty-sheet-add-column]').click();
            await waitFor(() => document.querySelectorAll('#rosterEditorTable [data-column-name]').length === 1, 'first roster column persisted and rerendered');
            let projectBState = await globalThis.workspaceDesktop.loadState(); let projectB = projectBState.projects.find((project) => project.id === projectBId);
            assert(projectB.data.columns.length === 1, 'roster add-column action persists immediately');
            let projectBType = document.querySelector('#rosterEditorTable [data-column-type]'); projectBType.value = 'name'; projectBType.dispatchEvent(new Event('change', { bubbles: true })); await globalThis.flushWorkspaceEdits();
            document.querySelector('[data-roster-add-column]').click();
            await waitFor(() => document.querySelectorAll('#rosterEditorTable [data-column-name]').length === 2, 'second roster column persisted and rerendered');
            projectBType = document.querySelectorAll('#rosterEditorTable [data-column-type]')[1]; projectBType.value = 'email'; projectBType.dispatchEvent(new Event('change', { bubbles: true })); await globalThis.flushWorkspaceEdits();
            const editRosterFormula = async (row, col, value) => {
              const cell = document.querySelector('#rosterEditorTable [data-sheet-row="' + row + '"][data-sheet-col="' + col + '"]');
              cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
              const formula = document.querySelector('#rosterCellValue'); formula.focus(); formula.value = value; formula.dispatchEvent(new Event('input', { bubbles: true })); formula.blur(); await globalThis.flushWorkspaceEdits();
            };
            await editRosterFormula(1, 0, '베타 사용자'); await editRosterFormula(1, 1, 'beta@example.com'); await editRosterFormula(1, 0, '베타 사용자 수정');
            projectBState = await globalThis.workspaceDesktop.loadState(); projectB = projectBState.projects.find((project) => project.id === projectBId); const projectBPerson = projectB.data.people[0];
            assert(projectBPerson && projectBPerson.name === '베타 사용자 수정' && projectBPerson.email === 'beta@example.com', 'formula bar creates and persists a blank roster row');
            assert(projectBPerson.values[projectB.data.columns.find((column) => column.type === 'name').id] === projectBPerson.name && projectBPerson.values[projectB.data.columns.find((column) => column.type === 'email').id] === projectBPerson.email, 'formula bar keeps roster identity fields and values synchronized');
            document.querySelector('#page-people [data-nav-link="dashboard"]').click(); await waitFor(() => document.querySelector('#page-dashboard').classList.contains('active'), 'project B dashboard after roster checks'); document.querySelector('[data-workflow-open="schedule"]').click(); await waitFor(() => document.querySelector('#page-schedule').classList.contains('active'), 'project B schedule page');
            const projectBRolesBefore = projectB.data.roles.length; document.querySelector('#addRoleButton').click(); await waitFor(() => document.querySelectorAll('#roleEditor [data-role-row]').length === projectBRolesBefore + 1, 'new role rerendered after save');
            let addedRoleName = document.querySelector('#roleEditor [data-role-row]:last-child [data-role-field="name"]'); addedRoleName.value = '검증 코치'; addedRoleName.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); await globalThis.flushWorkspaceEdits();
            projectB = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === projectBId);
            assert(projectB.data.roles.some((role) => role.name === '검증 코치') && [...document.querySelectorAll('#scheduleBoard [data-schedule-rename-column]')].some((button) => button.textContent === '검증 코치'), 'new role and its schedule column persist after naming');
            document.querySelector('[data-schedule-add-column-inline]').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'new-project schedule column dialog'); document.querySelector('#nameInputValue').value = '검증 메모'; document.querySelector('#nameInputForm').requestSubmit();
            await waitFor(() => [...document.querySelectorAll('#scheduleBoard [data-schedule-rename-column]')].some((button) => button.textContent === '검증 메모'), 'new-project schedule column added');
            projectB = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === projectBId); const projectBColumn = projectB.data.scheduleSheetColumns.find((column) => column.name === '검증 메모');
            assert(projectB.data.scheduleSheetInitialized && projectBColumn, 'new-project schedule sheet initialization and added column persist');
            const projectBHeader = [...document.querySelectorAll('#scheduleBoard [data-schedule-row="-1"]')].find((cell) => cell.querySelector('[data-schedule-rename-column]')?.textContent === '검증 메모'); projectBHeader.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const scheduleFormula = document.querySelector('#scheduleCellValue'); scheduleFormula.focus(); scheduleFormula.value = '검증 메모 수정'; scheduleFormula.dispatchEvent(new Event('input', { bubbles: true })); scheduleFormula.blur(); await globalThis.flushWorkspaceEdits();
            projectB = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === projectBId); assert(projectB.data.scheduleSheetColumns.some((column) => column.id === projectBColumn.id && column.name === '검증 메모 수정'), 'schedule formula-bar header rename persists');
            const projectBRemove = document.querySelector('#scheduleBoard [data-schedule-remove-column="' + projectBColumn.id + '"]'); assert(projectBRemove, 'renamed new-project schedule column keeps its remove action'); projectBRemove.click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'new-project schedule column remove confirm'); document.querySelector('#confirmAction').click();
            await waitFor(() => ![...document.querySelectorAll('#scheduleBoard [data-schedule-rename-column]')].some((button) => button.textContent === '검증 메모 수정'), 'new-project schedule column removed');
            projectB = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === projectBId); assert(!projectB.data.scheduleSheetColumns.some((column) => column.id === projectBColumn.id), 'new-project schedule column removal persists');
            document.querySelector('#page-schedule [data-nav-link="dashboard"]').click();
            const switcher = document.querySelector('#projectSwitcher');
            assert(switcher.options.length === 2, 'project switcher should list two projects');
            switcher.value = [...switcher.options].find((option) => option.textContent.includes('Project A')).value;
            switcher.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project A', 'project switch');
            const reservationState = await globalThis.workspaceDesktop.loadState(); const reservationProjectId = reservationState.activeProjectId;
            const firstReservation = await globalThis.workspaceDesktop.reserveExternalArtifacts(reservationProjectId, 'gmailDraft', ['reservation-person']);
            const competingReservation = await globalThis.workspaceDesktop.reserveExternalArtifacts(reservationProjectId, 'gmailDraft', ['reservation-person']);
            assert(firstReservation.ok && !competingReservation.ok, 'the same external artifact key cannot be processed by two windows at once');
            assert(JSON.stringify(firstReservation.keys) === JSON.stringify(['reservation-person']), 'reservation IPC must return the exact normalized key set used by the commit guard');
            await globalThis.workspaceDesktop.releaseExternalArtifacts(firstReservation.token);
            const releasedReservation = await globalThis.workspaceDesktop.reserveExternalArtifacts(reservationProjectId, 'gmailDraft', ['reservation-person']);
            assert(releasedReservation.ok, 'released external artifact keys can be reserved again'); await globalThis.workspaceDesktop.releaseExternalArtifacts(releasedReservation.token);
            const formsReservation = await globalThis.workspaceDesktop.reserveExternalArtifacts(reservationProjectId, 'googleForm', ['forms']);
            const competingFormsReservation = await globalThis.workspaceDesktop.reserveExternalArtifacts(reservationProjectId, 'googleForm', ['forms']);
            assert(formsReservation.ok && !competingFormsReservation.ok, 'Google Forms operations are serialized per project'); await globalThis.workspaceDesktop.releaseExternalArtifacts(formsReservation.token);
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
            const rosterPayload = {
              columns: [
                { id: 'smoke-name', name: '이름', role: 'variable', workspaceType: 'name' },
                { id: 'smoke-email', name: '이메일', role: 'email', workspaceType: 'email' },
                { id: 'smoke-phone', name: '전화번호', role: 'variable', workspaceType: 'phone' }
              ],
              rows: [
                { 'smoke-name': '송아라', 'smoke-email': 'one@example.com', 'smoke-phone': '010-1111-1111', __workspacePersonId: 'smoke-person-1', __workspaceActive: true },
                { 'smoke-name': '조민지', 'smoke-email': 'two@example.com', 'smoke-phone': '010-2222-2222', __workspacePersonId: 'smoke-person-2', __workspaceActive: true }
              ]
            };
            await globalThis.workspaceDesktop.saveWorkspaceRoster(smokeState.activeProjectId, rosterPayload);
            await globalThis.workspaceDesktop.saveSharedRoster({
              name: '공용 저장 명단 테스트',
              columns: [
                { id: 'saved-name', name: '이름', role: 'variable', workspaceType: 'name' },
                { id: 'saved-email', name: '이메일', role: 'email', workspaceType: 'email' }
              ],
              rows: [
                { 'saved-name': '저장 명단 사용자', 'saved-email': 'saved@example.com' },
                { 'saved-name': '송아라 중복', 'saved-email': 'one@example.com' }
              ]
            });
            await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '2', 'shared roster reflected in workspace');
            await waitFor(() => document.querySelectorAll('#rosterEditorTable tbody [data-sheet-row] input').length >= 6, 'inline roster rows rendered');
            const rosterTable = document.querySelector('#rosterEditorTable');
            const rosterDragStart = rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"]');
            const rosterDragEnd = rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="1"]');
            rosterDragStart.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }));
            rosterDragEnd.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 1 }));
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            assert(document.querySelector('#rosterSelectionStatus').textContent === 'A2:B3' && rosterTable.querySelectorAll('.sheet-selected').length === 4, 'roster pointer drag selects a rectangular range');
            rosterDragStart.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            rosterDragEnd.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, shiftKey: true })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            assert(document.querySelector('#rosterSelectionStatus').textContent === 'A2:B3', 'roster Shift selection preserves the anchor');
            const rosterCopy = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: rosterCopy, bubbles: true, cancelable: true }));
            assert(rosterCopy.getData('text/plain') === '송아라\\tone@example.com\\r\\n조민지\\ttwo@example.com', 'roster range copy exports TSV');
            const rosterAppendCell = rosterTable.querySelector('[data-sheet-row="3"][data-sheet-col="0"]');
            rosterAppendCell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            const rosterPaste = new DataTransfer(); rosterPaste.setData('text/plain', '김도윤\\tthree@example.com');
            rosterTable.dispatchEvent(new ClipboardEvent('paste', { clipboardData: rosterPaste, bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '3', 'roster paste auto-expands rows');
            const expandedRosterState = await globalThis.workspaceDesktop.loadState(); const expandedRosterProject = expandedRosterState.projects.find((project) => project.id === expandedRosterState.activeProjectId);
            assert(expandedRosterProject.data.people.some((person) => person.name === '김도윤' && person.email === 'three@example.com'), 'auto-expanded roster row persists');
            await globalThis.workspaceDesktop.saveWorkspaceRoster(smokeState.activeProjectId, { ...rosterPayload, rows: [rosterPayload.rows[0], { ...rosterPayload.rows[1], __workspaceActive: false }] });
            await waitFor(() => document.querySelector('[data-roster-inactive="smoke-person-2"]'), 'excluded roster row rendered as locked');
            const lockedRosterInput = document.querySelector('[data-roster-inactive="smoke-person-2"] input');
            assert(lockedRosterInput.readOnly && getComputedStyle(lockedRosterInput).textDecorationLine.includes('line-through'), 'excluded roster row is read-only and struck through');
            assert(document.querySelector('[data-roster-inactive="smoke-person-2"]')?.getAttribute('aria-label')?.includes('제외됨') && document.querySelector('#rosterEditorTable')?.getAttribute('aria-describedby')?.includes('rosterSelectionStatus'), 'roster exclusion and range status are announced to assistive technology');
            lockedRosterInput.value = '잠금 훼손 시도'; lockedRosterInput.dispatchEvent(new Event('input', { bubbles: true }));
            assert(lockedRosterInput.value === '조민지', 'excluded roster row rejects inline edits');
            document.querySelector('#saveSharedRoster').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'save inline roster without excluded rows');
            document.querySelector('#nameInputValue').value = '인라인 제외 반영 명단'; document.querySelector('#nameInputForm').requestSubmit();
            await waitFor(() => [...document.querySelector('#sharedRosterSelect').options].some((option) => option.textContent.includes('인라인 제외 반영 명단')), 'inline shared roster saved');
            const excludedSavedState = await globalThis.workspaceDesktop.loadState(); const excludedSavedRoster = excludedSavedState.library.rosters.find((roster) => roster.name === '인라인 제외 반영 명단');
            assert(excludedSavedRoster?.people.length === 1 && excludedSavedRoster.people[0].email === 'one@example.com' && excludedSavedRoster.people[0].active !== false && excludedSavedRoster.people[0].sourceOrder === 0, 'inline shared roster save omits excluded rows and reindexes active people');
            await globalThis.workspaceDesktop.saveWorkspaceRoster(smokeState.activeProjectId, rosterPayload);
            await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '2' && !document.querySelector('[data-roster-inactive]'), 'active roster restored after inline spreadsheet checks');
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
            assert(arrangementCopy.getData('text/plain') === '그룹 1' && arrangementCopy.getData('text/html').includes('<table>'), 'arrangement copy remains independent from the roster spreadsheet');
            const focusedArrangementInput = arrangementCell.querySelector('input'); focusedArrangementInput.focus(); focusedArrangementInput.value = '종료 직전 저장'; focusedArrangementInput.dispatchEvent(new Event('input', { bubbles: true }));
            await globalThis.flushWorkspaceEdits();
            const flushedArrangementState = await globalThis.workspaceDesktop.loadState(); const flushedArrangementProject = flushedArrangementState.projects.find((project) => project.id === flushedArrangementState.activeProjectId);
            assert(flushedArrangementProject.data.workItems.some((item) => item.rows.some((row) => Object.values(row.values).includes('종료 직전 저장'))), 'focused arrangement cell must be committed by the quit flush');
            const arrangementItemBeforeFormula = flushedArrangementProject.data.workItems.find((item) => item.id === flushedArrangementProject.data.activeWorkItemId); const arrangementBlankRow = arrangementItemBeforeFormula.rows.length; const arrangementUpdatedBefore = arrangementItemBeforeFormula.updatedAt;
            const arrangementBlankCell = document.querySelector('#arrangementBoard [data-arrangement-row="' + arrangementBlankRow + '"][data-arrangement-col="0"]'); arrangementBlankCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            let arrangementFormula = document.querySelector('#arrangementCellValue'); arrangementFormula.focus(); arrangementFormula.value = '수식줄 새 행'; arrangementFormula.dispatchEvent(new Event('input', { bubbles: true })); arrangementFormula.blur(); await globalThis.flushWorkspaceEdits();
            const arrangementHeader = document.querySelector('#arrangementBoard [data-arrangement-row="-1"][data-arrangement-col="0"]'); arrangementHeader.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            arrangementFormula = document.querySelector('#arrangementCellValue'); arrangementFormula.focus(); arrangementFormula.value = '수식줄 그룹명'; arrangementFormula.dispatchEvent(new Event('input', { bubbles: true })); arrangementFormula.blur(); await globalThis.flushWorkspaceEdits();
            const arrangementFormulaState = await globalThis.workspaceDesktop.loadState(); const arrangementFormulaProject = arrangementFormulaState.projects.find((project) => project.id === arrangementFormulaState.activeProjectId); const arrangementFormulaItem = arrangementFormulaProject.data.workItems.find((item) => item.id === arrangementItemBeforeFormula.id);
            assert(arrangementFormulaItem.rows.some((row) => Object.values(row.values).includes('수식줄 새 행')), 'arrangement formula bar creates and persists a blank row');
            assert(arrangementFormulaItem.columns[0].name === '수식줄 그룹명' && arrangementFormulaItem.updatedAt > arrangementUpdatedBefore, 'arrangement formula-bar header edit persists and advances updatedAt');
            document.querySelector('#page-arrange [data-nav-link="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'back to people');
            document.querySelector('#rosterStartTask').click(); await waitFor(() => document.querySelector('[data-open-arrangement]'), 'saved arrangement listed'); document.querySelector('[data-open-arrangement]').click(); await waitFor(() => document.querySelector('#page-arrange').classList.contains('active'), 'reopen saved arrangement'); document.querySelector('#page-arrange [data-nav-link="people"]').click();
            document.querySelector('[data-nav="library"]').click();
            await waitFor(() => document.querySelector('#page-library').classList.contains('active'), 'saved library page');
            await waitFor(() => [...document.querySelectorAll('#libraryRosterList .version-item')].some((row) => row.textContent.includes('공용 저장 명단 테스트')), 'saved roster rendered in library');
            assert(document.querySelector('#openLibraryRosterManager') && document.querySelector('#libraryRosterList [data-library-rename][data-library-kind="roster"]') && document.querySelector('#libraryRosterList [data-library-duplicate][data-library-kind="roster"]') && document.querySelector('#libraryRosterList [data-library-remove][data-library-kind="roster"]'), 'library should keep direct roster actions and the shared manager');
            document.querySelector('[data-nav="dashboard"]').click();
            await waitFor(() => document.querySelector('#page-dashboard').classList.contains('active'), 'dashboard after library');
            document.querySelector('[data-workflow-open="schedule"]').click();
            await waitFor(() => document.querySelector('#page-schedule').classList.contains('active'), 'schedule page');
            assert(document.querySelector('#page-schedule h1')?.textContent === '일정 편성' && document.querySelector('#generateScheduleButton')?.textContent.includes('일정표 만들기'), 'schedule page purpose labels');
            document.querySelector('#page-schedule [data-related-program="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'schedule related roster opens the full people page');
            assert(document.querySelector('#rosterEditorTable') && document.querySelector('#rosterViewSelect'), 'related roster route includes inline and derived rosters');
            document.querySelector('#page-people [data-nav-link="dashboard"]').click(); await waitFor(() => document.querySelector('#page-dashboard').classList.contains('active'), 'dashboard after related roster');
            document.querySelector('[data-workflow-open="schedule"]').click(); await waitFor(() => document.querySelector('#page-schedule').classList.contains('active'), 'return to schedule after related roster');
            assert(document.querySelector('#scheduleRosterSelect') && document.querySelector('#scheduleMergeRoster')?.textContent.includes('중복 제외') && document.querySelector('#openScheduleRosterManager'), 'schedule direct saved-roster merge controls');
            const scheduleSavedRosterOption = [...document.querySelector('#scheduleRosterSelect').options].find((option) => option.textContent.includes('공용 저장 명단 테스트'));
            assert(scheduleSavedRosterOption, 'saved roster offered to schedule');
            const scheduleDerivedViewOption = [...document.querySelector('#sessionRosterView').options].find((option) => option.textContent === '필기 합격자');
            assert(scheduleDerivedViewOption, 'derived roster offered as the schedule candidate view');
            document.querySelector('#sessionRosterView').value = scheduleDerivedViewOption.value; document.querySelector('#sessionRosterView').dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 150));
            const selectedScheduleViewState = await globalThis.workspaceDesktop.loadState();
            assert(selectedScheduleViewState.projects.find((project) => project.id === smokeState.activeProjectId).data.scheduleRules.rosterViewId === scheduleDerivedViewOption.value, 'selected schedule candidate view persisted');
            document.querySelector('#scheduleRosterSelect').value = scheduleSavedRosterOption.value; document.querySelector('#scheduleMergeRoster').click();
            await waitFor(() => document.querySelector('#scheduleProjectRosterStatus')?.textContent.includes('외 2명'), 'additive saved-roster merge');
            const mergedRosterState = await globalThis.workspaceDesktop.loadState(); const mergedRosterProject = mergedRosterState.projects.find((project) => project.id === smokeState.activeProjectId);
            assert(mergedRosterProject.data.people.length === 3 && mergedRosterProject.data.people.filter((person) => person.email === 'one@example.com').length === 1 && mergedRosterProject.data.people.some((person) => person.email === 'saved@example.com'), 'schedule merge must add only the new person and deduplicate existing email');
            const mergedScheduleView = mergedRosterProject.data.rosterViews.find((view) => view.id === scheduleDerivedViewOption.value); const mergedScheduleIds = new Set(mergedScheduleView?.personIds || []); const mergedExcludedIds = new Set(mergedScheduleView?.excludedPersonIds || []);
            assert(mergedRosterProject.data.people.filter((person) => person.active !== false).every((person) => mergedScheduleIds.has(person.id) && !mergedExcludedIds.has(person.id)), 'schedule merge adds both new and deduplicated existing people to the selected candidate view');
            document.querySelector('#slotBulkInput').value = '2026-07-06 09:30-10:30 오전 세션';
            document.querySelector('#addSlotsButton').click();
            await waitFor(() => document.querySelectorAll('[data-availability-all]').length === 3, 'availability matrix');
            document.querySelectorAll('[data-availability-all]').forEach((checkbox) => { checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); });
            await waitFor(() => [...document.querySelectorAll('[data-availability-person]')].every((checkbox) => checkbox.checked), 'all availability');
            document.querySelector('#generateScheduleButton').click();
            await waitFor(() => [...document.querySelectorAll('#scheduleBoard .schedule-role-cell input')].some((input) => input.value.split(',').filter(Boolean).length >= 1), 'generated assignments');
            assert(!document.querySelector('#scheduleSetupDetails').open, 'setup folds after initial schedule generation');
            assert(document.querySelectorAll('#sessionCalendarBoard [data-session-slot]').length === 1, 'session calendar card');
            assert(document.querySelectorAll('#sessionPersonPool [data-session-person]').length === 3, 'session roster person pool');
            const unassignedPerson = [...document.querySelectorAll('#sessionPersonPool [data-session-person]')].find((chip) => ![...document.querySelectorAll('[data-session-assignment]')].some((assignment) => assignment.dataset.sessionPerson === chip.dataset.sessionPerson));
            const beforePreviewState = await globalThis.workspaceDesktop.loadState(); const beforePreviewProject = beforePreviewState.projects.find((project) => project.id === beforePreviewState.activeProjectId); const beforePreviewAssignments = JSON.stringify(beforePreviewProject.data.assignments);
            unassignedPerson.click(); document.querySelector('[data-session-slot]').click();
            await waitFor(() => !document.querySelector('#sessionChangePreview').hidden, 'click assignment preview');
            assert(document.querySelectorAll('[data-session-assignment]').length === beforePreviewProject.data.assignments.length, 'preview does not mutate calendar');
            const duringPreviewState = await globalThis.workspaceDesktop.loadState(); assert(JSON.stringify(duringPreviewState.projects.find((project) => project.id === duringPreviewState.activeProjectId).data.assignments) === beforePreviewAssignments, 'preview does not persist assignments');
            document.querySelector('#sessionCancelChange').click(); await waitFor(() => document.querySelector('#sessionChangePreview').hidden, 'cancel assignment preview');
            document.querySelector('[data-session-slot]').click(); await waitFor(() => !document.querySelector('#sessionChangePreview').hidden, 'reopen assignment preview'); document.querySelector('#sessionApplyChange').click();
            await waitFor(() => document.querySelectorAll('[data-session-assignment]').length === 2, 'apply person into session');
            document.querySelector('[data-session-edit]').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'reschedule session dialog'); document.querySelector('#nameInputValue').value = '2026-07-06 10:00-11:00 변경 세션'; document.querySelector('#nameInputForm').requestSubmit(); await waitFor(() => document.querySelector('#confirmDialog').open, 'session time impact confirm'); document.querySelector('#confirmAction').click(); await waitFor(() => document.querySelector('[data-session-slot]')?.textContent.includes('10:00–11:00'), 'session time changed');
            document.querySelector('#sessionAddEmptyTime').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'add another session dialog'); document.querySelector('#nameInputValue').value = '2026-07-06 11:00-12:00 추가 세션'; document.querySelector('#nameInputForm').requestSubmit(); await waitFor(() => document.querySelectorAll('[data-session-slot]').length === 2, 'another session added');
            const moveChip = document.querySelector('[data-session-assignment]'); const movedAssignmentId = moveChip.dataset.sessionAssignment; const moveTransfer = new DataTransfer(); moveChip.dispatchEvent(new DragEvent('dragstart', { dataTransfer: moveTransfer, bubbles: true })); const targetSession = document.querySelectorAll('[data-session-slot]')[1]; targetSession.dispatchEvent(new DragEvent('drop', { dataTransfer: moveTransfer, bubbles: true, cancelable: true }));
            await waitFor(() => !document.querySelector('#sessionChangePreview').hidden, 'drag assignment preview'); assert(!document.querySelectorAll('[data-session-slot]')[1]?.querySelector('[data-session-assignment="' + movedAssignmentId + '"]'), 'drag preview does not move assignment'); document.querySelector('#sessionApplyChange').click();
            await waitFor(() => document.querySelectorAll('[data-session-slot]')[1]?.querySelector('[data-session-assignment="' + movedAssignmentId + '"]'), 'assignment moved between sessions');
            document.querySelector('#sessionUndo').click(); await waitFor(() => document.querySelectorAll('[data-session-slot]')[0]?.querySelector('[data-session-assignment="' + movedAssignmentId + '"]'), 'session undo without spreadsheet selection');
            document.querySelector('#sessionRedo').click(); await waitFor(() => document.querySelectorAll('[data-session-slot]')[1]?.querySelector('[data-session-assignment="' + movedAssignmentId + '"]'), 'session redo without spreadsheet selection');
            let editableRoleCell = document.querySelector('#scheduleBoard tbody [data-schedule-row="0"].schedule-role-cell'); let editableRoleInput = editableRoleCell.querySelector('input'); const editableRoleColumnIndex = Number(editableRoleCell.dataset.scheduleCol); editableRoleInput.focus(); editableRoleInput.value = '송아라'; editableRoleInput.dispatchEvent(new Event('input', { bubbles: true })); editableRoleInput.blur(); await globalThis.flushWorkspaceEdits();
            let scheduleEditState = await globalThis.workspaceDesktop.loadState(); let scheduleEditProject = scheduleEditState.projects.find((project) => project.id === scheduleEditState.activeProjectId); let editableRoleColumn = scheduleEditProject.data.scheduleSheetColumns[editableRoleColumnIndex]; const editableSlotId = scheduleEditProject.data.slots[0].id;
            assert(scheduleEditProject.data.assignments.some((assignment) => assignment.slotId === editableSlotId && assignment.roleId === editableRoleColumn.roleId && assignment.personName === '송아라'), 'direct schedule role-cell edit persists assignments');
            editableRoleCell = document.querySelector('#scheduleBoard tbody [data-schedule-row="0"][data-schedule-col="' + editableRoleColumnIndex + '"]'); editableRoleCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const roleFormula = document.querySelector('#scheduleCellValue'); roleFormula.focus(); roleFormula.value = '조민지'; roleFormula.dispatchEvent(new Event('input', { bubbles: true })); roleFormula.blur(); await globalThis.flushWorkspaceEdits();
            scheduleEditState = await globalThis.workspaceDesktop.loadState(); scheduleEditProject = scheduleEditState.projects.find((project) => project.id === scheduleEditState.activeProjectId); assert(scheduleEditProject.data.assignments.some((assignment) => assignment.slotId === editableSlotId && assignment.roleId === editableRoleColumn.roleId && assignment.personName === '조민지') && !scheduleEditProject.data.assignments.some((assignment) => assignment.slotId === editableSlotId && assignment.roleId === editableRoleColumn.roleId && assignment.personName === '송아라'), 'schedule formula-bar role edit replaces and persists assignments');
            const dateColumnIndex = scheduleEditProject.data.scheduleSheetColumns.findIndex((column) => column.key === 'date'); let dateInput = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="' + dateColumnIndex + '"] input'); const validScheduleDate = dateInput.value; dateInput.focus(); dateInput.value = '잘못된 날짜'; dateInput.dispatchEvent(new Event('input', { bubbles: true })); dateInput.blur(); await globalThis.flushWorkspaceEdits();
            scheduleEditProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === scheduleEditState.activeProjectId); assert(scheduleEditProject.data.conflicts.some((conflict) => conflict.code === 'invalidDate'), 'direct system-cell edit refreshes and persists schedule conflicts');
            dateInput = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="' + dateColumnIndex + '"] input'); dateInput.focus(); dateInput.value = validScheduleDate; dateInput.dispatchEvent(new Event('input', { bubbles: true })); dateInput.blur(); await globalThis.flushWorkspaceEdits();
            scheduleEditProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === scheduleEditState.activeProjectId); assert(!scheduleEditProject.data.conflicts.some((conflict) => conflict.code === 'invalidDate'), 'corrected system-cell edit clears stale schedule conflicts');
            editableRoleCell = document.querySelector('#scheduleBoard tbody [data-schedule-row="0"][data-schedule-col="' + editableRoleColumnIndex + '"]'); editableRoleCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); const roleCut = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('cut', { clipboardData: roleCut, bubbles: true, cancelable: true })); await globalThis.flushWorkspaceEdits();
            scheduleEditProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === scheduleEditState.activeProjectId); assert(roleCut.getData('text/plain') === '조민지' && !scheduleEditProject.data.assignments.some((assignment) => assignment.slotId === editableSlotId && assignment.roleId === editableRoleColumn.roleId), 'schedule role-cell cut clears and persists assignments');
            const scheduleCell = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="0"]');
            scheduleCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
            const scheduleSecondCell = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="1"]');
            scheduleSecondCell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            assert(scheduleCell.classList.contains('sheet-selected') && scheduleSecondCell.classList.contains('sheet-selected') && document.querySelector('#scheduleSelectionStatus').textContent === 'A2:B2', 'schedule spreadsheet drag selection');
            const scheduleCopied = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: scheduleCopied, bubbles: true, cancelable: true }));
            assert(scheduleCopied.getData('text/plain').includes('\t') && scheduleCopied.getData('text/html').includes('<table>'), 'schedule spreadsheet drag and Excel copy');
            scheduleCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const schedulePaste = new DataTransfer(); schedulePaste.setData('text/plain', '날짜\\t시작\\t종료\\t세션명\\t참여자\\t운영 메모\\n2026-07-06\\t09:30\\t10:30\\t오전 세션\\t송아라, 조민지, 저장 명단 사용자\\t확인 완료');
            scheduleCell.querySelector('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: schedulePaste, bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelector('#confirmDialog').open, 'schedule paste replacement confirm'); document.querySelector('#confirmAction').click();
            await waitFor(() => [...document.querySelectorAll('[data-schedule-rename-column]')].some((button) => button.textContent === '운영 메모'), 'dynamic schedule column import');
            assert([...document.querySelectorAll('#scheduleBoard tbody input')].some((input) => input.value === '확인 완료'), 'custom schedule cell persisted in editor');
            await waitFor(() => document.querySelectorAll('[data-session-assignment]').length === 3, 'generic participant column mapped to assignments');
            assert([...document.querySelectorAll('#sessionPersonPool [data-session-person]')].every((chip) => chip.textContent.includes('일정 1개')), 'customer counts, calendar cards, and spreadsheet assignments must stay consistent');
            let customScheduleState = await globalThis.workspaceDesktop.loadState(); let customScheduleProject = customScheduleState.projects.find((project) => project.id === customScheduleState.activeProjectId); const customScheduleColumn = customScheduleProject.data.scheduleSheetColumns.find((column) => column.name === '운영 메모'); const customScheduleColumnIndex = customScheduleProject.data.scheduleSheetColumns.findIndex((column) => column.id === customScheduleColumn.id); let customScheduleInput = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="' + customScheduleColumnIndex + '"] input'); customScheduleInput.focus(); customScheduleInput.value = '직접 수정 완료'; customScheduleInput.dispatchEvent(new Event('input', { bubbles: true })); customScheduleInput.blur(); await globalThis.flushWorkspaceEdits();
            customScheduleProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === customScheduleState.activeProjectId); assert(customScheduleProject.data.scheduleCustomValues[customScheduleProject.data.slots[0].id][customScheduleColumn.id] === '직접 수정 완료', 'direct custom schedule-cell edit persists');
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
            assert(document.querySelector('#openMailRosterManager')?.textContent.includes('명단 관리') && document.querySelectorAll('#mailRosterPeople .resource-chip').length === 3 && document.querySelector('#mailRosterSummary')?.textContent.trim(), 'gmail page should show the applied shared roster');
            assert(document.querySelector('#gmailSharedRosterSelect') && [...document.querySelector('#gmailSharedRosterSelect').options].some((option) => option.textContent.includes('공용 저장 명단 테스트')) && document.querySelector('#loadGmailSharedRoster')?.textContent.includes('전체 교체') && document.querySelector('#gmailRosterPaste') && document.querySelector('#applyGmailRosterPaste'), 'gmail direct saved-roster and paste controls');
            const gmailPeopleBeforeReplace = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === smokeState.activeProjectId).data.people.map((person) => person.email).sort().join('|');
            document.querySelector('#gmailSharedRosterSelect').value = [...document.querySelector('#gmailSharedRosterSelect').options].find((option) => option.textContent.includes('공용 저장 명단 테스트')).value;
            document.querySelector('#loadGmailSharedRoster').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'saved Gmail roster replacement confirmation');
            assert(document.querySelector('#confirmMessage').textContent.includes('전체 교체') && document.querySelector('#confirmMessage').textContent.includes('기존 일정 배정'), 'saved Gmail roster replacement explains its impact');
            document.querySelector('#confirmDialog .dialog-footer [data-confirm-result="false"]').click(); await waitFor(() => !document.querySelector('#confirmDialog').open, 'cancel saved Gmail roster replacement');
            assert((await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === smokeState.activeProjectId).data.people.map((person) => person.email).sort().join('|') === gmailPeopleBeforeReplace, 'cancelled saved Gmail roster replacement preserves the project roster');
            document.querySelector('#gmailRosterPaste').value = '이름\\t이메일\\n교체 취소\\tcancel@example.com'; document.querySelector('#applyGmailRosterPaste').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'pasted Gmail roster replacement confirmation');
            document.querySelector('#confirmDialog .dialog-footer [data-confirm-result="false"]').click(); await waitFor(() => !document.querySelector('#confirmDialog').open, 'cancel pasted Gmail roster replacement');
            assert(document.querySelector('#gmailRosterPaste').value.includes('cancel@example.com') && (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === smokeState.activeProjectId).data.people.map((person) => person.email).sort().join('|') === gmailPeopleBeforeReplace, 'cancelled pasted Gmail roster replacement preserves both text and project roster');
            const mailEditor = document.querySelector('#mailBodyEditor');
            const mailSubject = document.querySelector('#mailSubjectTemplate');
            mailSubject.value = '{전'; mailSubject.focus(); mailSubject.setSelectionRange(2, 2); mailSubject.dispatchEvent(new Event('input', { bubbles: true }));
            await waitFor(() => !document.querySelector('#templateVariableAutocomplete').hidden && [...document.querySelectorAll('#templateVariableAutocomplete [data-template-autocomplete]')].some((item) => item.dataset.templateAutocomplete === '전화번호'), 'workspace subject variable autocomplete');
            mailSubject.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            assert(mailSubject.value === '{전화번호}', 'workspace subject autocomplete insertion');
            mailEditor.focus(); document.execCommand('insertText', false, '{이'); mailEditor.dispatchEvent(new Event('input', { bubbles: true }));
            await waitFor(() => !document.querySelector('#templateVariableAutocomplete').hidden && [...document.querySelectorAll('#templateVariableAutocomplete [data-template-autocomplete]')].some((item) => item.dataset.templateAutocomplete === '이름'), 'workspace body variable autocomplete');
            mailEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            assert(mailEditor.textContent.includes('{이름}'), 'workspace body autocomplete insertion');
            document.querySelector('#mailSubjectTemplate').value += ' {전화번호} {없는컬럼}';
            document.querySelector('#mailSubjectTemplate').dispatchEvent(new Event('input', { bubbles: true }));
            assert([...document.querySelectorAll('#templateTokenStatus .variable-chip.valid')].some((item) => item.textContent === '{전화번호}') && document.querySelector('#templateTokenStatus .variable-chip.invalid')?.textContent === '{없는컬럼}', 'template column token validation');
            mailEditor.focus(); document.execCommand('selectAll', false, null);
            const transfer = new DataTransfer(); transfer.setData('text/html', '<html><head><style>.xl65{background-color:#ffff00;font-weight:bold;border:1px solid #777}</style></head><body><!--StartFragment--><table><tr><td class="xl65" onclick="alert(1)">Excel 셀</td></tr></table><script>alert(2)</script><!--EndFragment--></body></html>');
            mailEditor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
            assert(mailEditor.querySelector('table') && mailEditor.querySelector('td')?.style.backgroundColor && !mailEditor.querySelector('script') && !mailEditor.querySelector('[onclick]') && !mailEditor.textContent.includes('alert(2)'), 'rich paste should keep table/class styles and remove unsafe content: ' + mailEditor.innerHTML);
            document.querySelector('#prepareMailPackage').click();
            await waitFor(() => document.querySelectorAll('[data-mail-edit]').length === 3, 'mail preview');
            document.querySelector('[data-mail-edit]').click();
            await waitFor(() => document.querySelector('#mailEditDialog').open, 'personal mail editor');
            document.querySelector('#mailEditSubject').value += ' 개인수정'; document.querySelector('#mailEditSubject').focus(); document.querySelector('#mailEditSubject').dispatchEvent(new Event('input', { bubbles: true }));
            await globalThis.flushWorkspaceEdits();
            const flushedPersonalMailState = await globalThis.workspaceDesktop.loadState(); const flushedPersonalMailProject = flushedPersonalMailState.projects.find((project) => project.id === flushedPersonalMailState.activeProjectId);
            assert(flushedPersonalMailProject.data.communication.mailEdits[document.querySelector('#mailEditPersonId').value]?.subject.endsWith('개인수정'), 'open personal mail editor must be committed by the quit flush');
            document.querySelector('#mailEditForm').requestSubmit();
            await waitFor(() => !document.querySelector('#mailEditDialog').open, 'personal mail saved');
            const persisted = await globalThis.workspaceDesktop.loadState();
            assert(persisted.projects.length === 2, 'projects persisted');
            const projectA = persisted.projects.find((project) => project.name === 'Smoke Project A');
            assert(projectA.data.people.length === 3 && projectA.data.slots.length === 1 && projectA.data.workItems.length === 1, 'operational project data persisted: ' + JSON.stringify({ people: projectA.data.people.length, slots: projectA.data.slots.length, workItems: projectA.data.workItems.length }));
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
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-workflow-smoke.png', 'Workspace workflow preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#newProjectButton').click()`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-template-picker-smoke.png', 'Workspace template picker preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-close-dialog="newProjectDialog"]').click()`);
        await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label) => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          document.querySelector('[data-workflow-open="schedule"]').click();
          await waitFor(() => document.querySelector('#page-schedule')?.classList.contains('active'), 'schedule screenshot page');
          await waitFor(() => document.querySelectorAll('[data-session-assignment]').length === 3 && document.querySelectorAll('[data-session-slot]').length === 1, 'consistent schedule screenshot state');
          document.querySelector('#sessionAddEmptyTime').click();
          await waitFor(() => document.querySelector('#nameInputDialog').open, 'visual target slot dialog');
          document.querySelector('#nameInputValue').value = '2026-07-06 11:00-12:00 변경 후보'; document.querySelector('#nameInputForm').requestSubmit();
          await waitFor(() => document.querySelectorAll('[data-session-slot]').length === 2, 'visual target slot');
          document.querySelector('[data-session-assignment]').click();
          await waitFor(() => !document.querySelector('#sessionSelectedPersonPanel').hidden, 'selected customer');
          document.querySelectorAll('[data-session-slot]')[1].click();
          await waitFor(() => !document.querySelector('#sessionChangePreview').hidden, 'visible before-and-after preview');
          document.querySelector('#toastRegion').replaceChildren(); document.querySelector('.session-planner-panel').scrollIntoView({block:'start'}); window.scrollBy(0, -70);
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-session-planner-smoke.png', 'Workspace session planner preview');
        writeSmokeResult('running', { step: app.isPackaged ? 'session-planner-verified' : 'session-planner-preview' });
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#sessionCancelChange').click()`);
        writeSmokeResult('running', { step: 'cleanup-preview-cancelled' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const removalStarted = await mainWindow.webContents.executeJavaScript(`(() => { const extra = [...document.querySelectorAll('[data-session-slot]')].find((card) => card.textContent.includes('11:00–12:00')); const remove = extra?.querySelector('[data-session-remove]'); if (!remove) return false; remove.click(); return true; })()`);
        if (!removalStarted) throw new Error('Visual target cleanup button was not found.');
        writeSmokeResult('running', { step: 'cleanup-remove-clicked' });
        const confirmDeadline = Date.now() + 5000;
        while (!await mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('#confirmDialog').open)`) && Date.now() < confirmDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
        if (!await mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('#confirmDialog').open)`)) throw new Error('Timed out waiting for visual target cleanup confirmation.');
        writeSmokeResult('running', { step: 'cleanup-confirm-visible' });
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#confirmAction').click()`);
        writeSmokeResult('running', { step: 'cleanup-confirm-clicked' });
        const cleanupDeadline = Date.now() + 5000;
        while (!await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('[data-session-slot]').length === 1`) && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
        if (!await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('[data-session-slot]').length === 1`)) throw new Error('Timed out waiting for visual target cleanup.');
        writeSmokeResult('running', { step: 'cleanup-complete' });
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-session-clear-person]')?.click(); document.querySelector('#toastRegion').replaceChildren(); document.querySelector('.schedule-board-panel').scrollIntoView({block:'start'}); window.scrollBy(0, -70);`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-schedule-smoke.png', 'Workspace schedule preview');
        writeSmokeResult('running', { step: 'schedule-preview' });
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-workflow-open="people"]').click()`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-people-smoke.png', 'Workspace people preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#rosterStartTask').click(); document.querySelector('[data-open-arrangement]')?.click();`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-arrangement-smoke.png', 'Workspace arrangement preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-nav="dashboard"]').click(); document.querySelector('[data-workflow-open="gmailFlow"]').click(); document.querySelector('#toastRegion').replaceChildren(); document.querySelector('#page-gmailFlow').scrollIntoView({block:'start'});`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-gmail-smoke.png', 'Workspace Gmail preview');
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
        const disconnectedCleanFlush = await standalone.webContents.executeJavaScript(`(async () => {
          const previousMode = state.dataStorageMode; const previousEmail = state.connectedEmail; const previousContextRevision = cloudSyncContextRevision;
          try {
            state.dataStorageMode = 'drive'; state.connectedEmail = ''; cloudSyncTracker.clear();
            const clean = await globalThis.flushWorkspaceEdits();
            cloudSyncTracker.markDirty();
            let dirtyBlocked = false;
            try { await globalThis.flushWorkspaceEdits(); } catch (error) { dirtyBlocked = /연결된 Google 계정/.test(error.message); }
            cloudSyncTracker.clear(); state.connectedEmail = 'smoke@example.com';
            const beforeDraft = await storage.get(WORKSPACE_DRAFT_KEY, null);
            const expectedRevision = cloudSyncTracker.capture(); const expectedContext = captureCloudSyncContext();
            const applyPromise = applyCloudSnapshot({ format: 'gmail-flow-cloud-sync', schemaVersion: 1, data: { savedRosters: [], templates: [], structureTemplates: [], workspaceDraft: { remote: true } } }, { id: 'remote-smoke' }, expectedRevision, expectedContext);
            cloudSyncContextRevision += 1; state.dataStorageMode = 'local';
            const staleApplyBlocked = await applyPromise === false && JSON.stringify(await storage.get(WORKSPACE_DRAFT_KEY, null)) === JSON.stringify(beforeDraft);
            return clean === true && dirtyBlocked && staleApplyBlocked;
          } finally {
            state.dataStorageMode = previousMode; state.connectedEmail = previousEmail; cloudSyncContextRevision = previousContextRevision; cloudSyncTracker.clear();
          }
        })()`);
        if (disconnectedCleanFlush !== true) throw new Error('Drive flush/context guards did not protect clean, dirty, and mode-switch states.');
        await new Promise((resolve) => setTimeout(resolve, 600));
        await captureSmokePreview(standalone.webContents, 'cmoe-workspace-standalone-smoke.png', 'Workspace smoke preview');
        const gmailRosterResult = await standalone.webContents.executeJavaScript(`(async () => {
          document.querySelector('.nav-item[data-page="roster"]').click();
          const end = Date.now() + 5000;
          while (!document.querySelector('#page-roster')?.classList.contains('active') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
          document.querySelector('#importSharedRoster').click();
          const dialogEnd = Date.now() + 5000;
          while (!document.querySelector('#inputDialog')?.open && Date.now() < dialogEnd) await new Promise((resolve) => setTimeout(resolve, 25));
          const sourceSelect = document.querySelector('#inputDialogSelect');
          const projectOption = [...sourceSelect.options].find((option) => option.value.startsWith('project:'));
          const savedOption = [...sourceSelect.options].find((option) => option.textContent.includes('공용 저장 명단 테스트'));
          if (savedOption) { sourceSelect.value = savedOption.value; document.querySelector('#inputDialogForm').requestSubmit(); }
          const importEnd = Date.now() + 5000;
          while ((document.querySelector('#inputDialog')?.open || document.querySelector('#rosterBody input[data-row-index="0"][data-column-index="0"]')?.value !== '저장 명단 사용자') && Date.now() < importEnd) await new Promise((resolve) => setTimeout(resolve, 25));
          const savedRosterImported = document.querySelector('#rosterBody input[data-row-index="0"][data-column-index="0"]')?.value === '저장 명단 사용자';
          document.querySelector('.nav-item[data-page="compose"]').click();
          const subject = document.querySelector('#subject'); subject.value = '안녕하세요 {이'; subject.focus(); subject.setSelectionRange(subject.value.length, subject.value.length); subject.dispatchEvent(new Event('input', { bubbles: true }));
          const autocompleteEnd = Date.now() + 3000;
          while (document.querySelector('#variableAutocomplete')?.hidden && Date.now() < autocompleteEnd) await new Promise((resolve) => setTimeout(resolve, 25));
          const autocompleteOffered = [...document.querySelectorAll('#variableAutocomplete [data-variable-autocomplete]')].some((button) => button.dataset.variableAutocomplete === '이름');
          subject.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          const autocompleteInserted = subject.value === '안녕하세요 {이름}';
          document.querySelector('.nav-item[data-page="roster"]').click();
          const before = document.querySelectorAll('#rosterBody tr:not(.sheet-add-row)').length;
          document.querySelector('#addRosterRow').click();
          const after = document.querySelectorAll('#rosterBody tr:not(.sheet-add-row)').length;
          const rows = Array.from({ length: 23 }, (_, index) => ['테스트' + (index + 1), 'person' + (index + 1) + '@example.com', '010-0000-' + String(index + 1).padStart(4, '0')]);
          const transfer = new DataTransfer(); transfer.setData('text/plain', rows.map((row) => row.join('\\t')).join('\\n'));
          document.querySelector('#rosterBody .cell-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
          return {
            rosterNavLabel: document.querySelector('.nav-item[data-page="roster"]')?.textContent.trim() === '명단',
            internalRosterPage: document.querySelector('#page-roster')?.classList.contains('active'),
            importButton: document.querySelector('#importSharedRoster')?.textContent.includes('명단 가져오기'),
            projectSourceOffered: Boolean(projectOption),
            savedSourceOffered: Boolean(savedOption),
            savedRosterImported,
            autocompleteOffered,
            autocompleteInserted,
            rowAdded: after === before + 1,
            pasted23Rows: document.querySelector('#rosterBody input[data-row-index="22"][data-column-index="0"]')?.value === '테스트23',
            extraBlankRows: document.querySelectorAll('#rosterBody tr:not(.sheet-add-row)').length >= 25,
            addRowStillAvailable: Boolean(document.querySelector('#addRosterRow')),
            saveLabel: document.querySelector('#saveFilteredRoster')?.textContent.trim() === '명단 저장'
          };
        })()`);
        if (!Object.values(gmailRosterResult).every(Boolean)) throw new Error(`Gmail Flow shared roster smoke failed: ${JSON.stringify(gmailRosterResult)}`);
        await captureSmokePreview(standalone.webContents, 'cmoe-workspace-gmail-roster-smoke.png', 'Workspace Gmail roster preview');
        const smokeState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#openMailRosterManager').click()`);
        const pickerDeadline = Date.now() + 5000;
        let rosterManager;
        while ((!rosterManager || rosterManager.isDestroyed()) && Date.now() < pickerDeadline) {
          rosterManager = rosterPickerWindows.get(String(smokeState.activeProjectId || 'quick'));
          if (!rosterManager || rosterManager.isDestroyed()) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!rosterManager || rosterManager.isDestroyed()) throw new Error('Clicking the roster import button did not open the shared roster picker.');
        if (!rosterManager.isModal() || rosterManager.getParentWindow() !== mainWindow) throw new Error('Shared roster picker must open as a modal child window.');
        if (rosterManager.webContents.isLoading()) await new Promise((resolve) => rosterManager.webContents.once('did-finish-load', resolve));
        const rosterManagerResult = await rosterManager.webContents.executeJavaScript(`(async () => {
          const end = Date.now() + 5000;
          while ((!document.querySelector('#page-roster')?.classList.contains('active') || !document.querySelector('#useRoster')?.textContent.includes('프로젝트에 저장')) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            managerMode: document.body.classList.contains('roster-manager-mode'),
            rosterPage: document.querySelector('#page-roster')?.classList.contains('active'),
            projectRows: document.querySelectorAll('#rosterBody tr').length >= 5,
            copyAction: document.querySelector('#saveFilteredRoster')?.textContent.includes('저장 자료로 복사'),
            applyAction: document.querySelector('#useRoster')?.textContent.includes('프로젝트에 저장'),
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
        const centrallySavedRoster = excludedState.library.rosters.find((roster) => roster.name === '연기 테스트 선별 명단');
        const includedProjectPeople = excludedProject?.data.people.filter((person) => person.active !== false).length || 0;
        if (!centrallySavedRoster || centrallySavedRoster.people.length !== includedProjectPeople || centrallySavedRoster.people.some((person) => person.active === false)) throw new Error('Named roster was not saved to the shared workspace library without excluded people.');
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
        await captureSmokePreview(rosterManager.webContents, 'cmoe-workspace-roster-manager-smoke.png', 'Workspace roster manager preview');
        await rosterManager.webContents.executeJavaScript(`(async () => { const input = document.querySelector('#rosterBody .cell-input'); input.value = '송아라 종료저장'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); await globalThis.flushWorkspaceEdits(); })()`);
        const flushedRosterState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
        const flushedRosterProject = flushedRosterState.projects.find((project) => project.id === smokeState.activeProjectId);
        if (flushedRosterProject?.data.people[0]?.name !== '송아라 종료저장') throw new Error('Shared roster manager close flush did not persist the focused cell edit.');
        await rosterManager.webContents.executeJavaScript(`(() => { const input = document.querySelector('#rosterBody .cell-input'); input.value = '송아라 수정'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#useRoster').click(); })()`);
        const closeDeadline = Date.now() + 5000;
        while (!rosterManager.isDestroyed() && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
        if (!rosterManager.isDestroyed()) throw new Error('Shared roster manager did not close after applying the project roster.');
        const appliedState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
        const appliedProject = appliedState.projects.find((project) => project.id === smokeState.activeProjectId);
        if (appliedProject?.data.people[0]?.name !== '송아라 수정') throw new Error('Shared roster manager changes were not applied to the project.');
        const replacementGuards = await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label, timeout = 5000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          const openGmail = async () => {
            document.querySelector('[data-nav="dashboard"]').click(); document.querySelector('[data-workflow-open="gmailFlow"]').click();
            await waitFor(() => document.querySelector('#page-gmailFlow')?.classList.contains('active'), 'Gmail replacement page');
          };
          const chooseSavedRoster = () => {
            const select = document.querySelector('#gmailSharedRosterSelect'); const option = [...select.options].find((item) => item.textContent.includes('공용 저장 명단 테스트'));
            if (!option) throw new Error('Saved roster replacement option missing'); select.value = option.value; return option.value;
          };
          await openGmail();
          let loaded = await globalThis.workspaceDesktop.loadState(); let project = loaded.projects.find((item) => item.id === loaded.activeProjectId); let saved = loaded.library.rosters.find((item) => item.name === '공용 저장 명단 테스트');
          const savedId = chooseSavedRoster(); const projectPeopleBefore = project.data.people.map((person) => person.id).join('|');
          document.querySelector('#loadGmailSharedRoster').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'source concurrency confirmation');
          const savedColumns = saved.columns.map((column) => ({ id: column.id, name: column.name, role: column.type === 'email' ? 'email' : 'variable', workspaceType: column.type || 'text' }));
          const savedRows = saved.people.map((person) => ({ ...person.values, __workspacePersonId: person.id, __workspaceActive: person.active !== false }));
          await globalThis.workspaceDesktop.saveSharedRoster({ id: saved.id, name: saved.name + ' 동시 수정', columns: savedColumns, rows: savedRows });
          await new Promise((resolve) => setTimeout(resolve, 100)); document.querySelector('#confirmAction').click();
          await waitFor(() => !document.querySelector('#confirmDialog').open && document.querySelector('#toastRegion').textContent.includes('저장 명단이 바뀌었습니다'), 'stale saved roster rejection');
          loaded = await globalThis.workspaceDesktop.loadState(); project = loaded.projects.find((item) => item.id === loaded.activeProjectId);
          const sourceGuarded = project.data.people.map((person) => person.id).join('|') === projectPeopleBefore;
          await globalThis.workspaceDesktop.saveSharedRoster({ id: saved.id, name: saved.name, columns: savedColumns, rows: savedRows }); await new Promise((resolve) => setTimeout(resolve, 100));

          chooseSavedRoster(); document.querySelector('#loadGmailSharedRoster').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'target concurrency confirmation');
          loaded = await globalThis.workspaceDesktop.loadState(); project = loaded.projects.find((item) => item.id === loaded.activeProjectId);
          const targetColumns = project.data.columns.map((column, index) => ({ id: column.id, name: index === 0 ? column.name + ' 동시 수정' : column.name, role: column.type === 'email' ? 'email' : 'variable', workspaceType: column.type || 'text' }));
          const targetRows = project.data.people.map((person) => ({ ...person.values, __workspacePersonId: person.id, __workspaceActive: person.active !== false }));
          await globalThis.workspaceDesktop.saveWorkspaceRoster(project.id, { columns: targetColumns, rows: targetRows }); await new Promise((resolve) => setTimeout(resolve, 100));
          document.querySelector('#confirmAction').click(); await waitFor(() => !document.querySelector('#confirmDialog').open && document.querySelector('#toastRegion').textContent.includes('명단·일정'), 'stale project roster rejection');
          loaded = await globalThis.workspaceDesktop.loadState(); project = loaded.projects.find((item) => item.id === loaded.activeProjectId);
          const targetGuarded = project.data.columns[0].name.endsWith('동시 수정') && project.data.people.map((person) => person.id).join('|') === projectPeopleBefore;

          const hadScheduleHistory = !document.querySelector('#scheduleUndo').disabled;
          chooseSavedRoster(); document.querySelector('#loadGmailSharedRoster').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'accepted roster replacement confirmation'); document.querySelector('#confirmAction').click();
          await waitFor(() => document.querySelectorAll('#mailRosterPeople .resource-chip').length === 2, 'accepted roster replacement');
          document.querySelector('[data-nav="dashboard"]').click(); document.querySelector('[data-workflow-open="schedule"]').click(); await waitFor(() => document.querySelector('#page-schedule')?.classList.contains('active'), 'schedule after roster replacement');
          loaded = await globalThis.workspaceDesktop.loadState(); project = loaded.projects.find((item) => item.id === loaded.activeProjectId);
          return { sourceGuarded, targetGuarded, hadScheduleHistory, historyCleared: document.querySelector('#scheduleUndo').disabled && document.querySelector('#sessionUndo').disabled, assignmentsCleared: project.data.assignments.length === 0 && Object.keys(project.data.availability || {}).length === 0, savedIdStable: savedId === saved.id };
        })()`);
        if (!Object.values(replacementGuards).every(Boolean)) throw new Error(`Roster replacement guards failed: ${JSON.stringify(replacementGuards)}`);
        clearTimeout(timeout);
        console.log('Workspace smoke test passed.');
        writeSmokeResult('passed', { step: 'complete' });
        isQuitting = true;
        app.exit(result?.passed ? 0 : 1);
      } catch (error) {
        clearTimeout(timeout);
        console.error('Workspace smoke test failed:', error);
        writeSmokeResult('failed', { step: 'exception', error: error?.stack || error?.message || String(error) });
        try {
          const diagnostics = await mainWindow.webContents.executeJavaScript(`({
            page: [...document.querySelectorAll('.page.active')].map((item) => item.dataset.page),
            project: document.querySelector('#activeProjectName')?.textContent || '',
            roleCells: [...document.querySelectorAll('#scheduleBoard .schedule-role-cell input')].map((input) => input.value),
            sessionAssignments: [...document.querySelectorAll('[data-session-assignment]')].map((item) => ({ id: item.dataset.sessionAssignment, person: item.dataset.sessionPerson, text: item.textContent })),
            scheduleSummary: document.querySelector('#scheduleBoardSummary')?.textContent || '',
            saveStatus: document.querySelector('#saveStatus')?.textContent || '',
            navigationTrace: globalThis.__workspaceNavigationTrace || []
          })`);
          const failedState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null)); const failedProject = failedState.projects.find((project) => project.id === failedState.activeProjectId);
          console.error('Workspace smoke diagnostics:', JSON.stringify({ dom: diagnostics, state: { activeProjectId: failedState.activeProjectId, revision: failedState._revision, slots: failedProject?.data.slots.length, assignments: failedProject?.data.assignments, conflicts: failedProject?.data.conflicts } }));
          await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-failed-smoke.png', 'Workspace failed smoke preview');
        } catch (diagnosticError) { console.error('Workspace smoke diagnostics failed:', diagnosticError); }
        isQuitting = true;
        app.exit(1);
      }
    });
  }
});
