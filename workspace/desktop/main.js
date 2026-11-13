const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const { JsonStorage } = require('./storage');
const { readWorkbookSheets, exportProjectWorkbook, exportWorkItemWorkbook } = require('./spreadsheet');
const { AuthManager } = require('./auth-manager');
const { ExtensionManager } = require('./extension-manager');
const { mimeDraft } = require('./mail-mime');
const { driveSnapshotIdentityMatches, preserveLocalConnectionContext } = require('./state-merge');
const { createTransactionQueue, createKeyedOperationCoordinator } = require('./transaction-queue');
const { mergeSelectedWorkspaceState, resolveExternalCommit } = require('./external-commit');
const { GmailFlowHost } = require('./gmail-flow-host');
const { WorkspaceGmailIdentity } = require('./workspace-gmail-identity');
const {
  DriveSyncGuardStore,
  connectionGuardKey,
  drivePayloadsEqual,
  hasStableDriveReadIdentity,
  isUsableDriveEtag
} = require('./drive-sync-guard');
const { DriveWorkspaceClient, authoritativeIdentityMatches } = require('./drive-workspace-client');
const { assertGoogleFormStableDuringResponseFetch, fetchAllFormResponses } = require('./google-forms');
const { configureGoogleForm, createGoogleFormShell } = require('./google-form-creation');
const { handleStartupFailure } = require('./startup-failure');
const { installWebContentsSecurity } = require('./web-contents-security');
const { createSafeStorageCredentialProtection } = require('./credential-protection');
const {
  createGoogleProviderOperationGate,
  reconcileWorkspaceGoogleConnections,
  reconcileWorkspaceZoomConnections,
  sanitizeGoogleProviderStatus
} = require('./google-provider-coordinator');
const { withOperationTimeout } = require('./network-timeout');
const { collectRemoteSyncWarnings, normalizeCloseFlushResult } = require('./close-sync-policy');
const { safeShortcutLabel, shortcutPathInside } = require('./shortcut-path');
const { repairInstalledAppShortcuts } = require('./install-shortcuts');
const { DocumentTools } = require('./document-tools');
const { createLoginBrowserLauncher } = require('./login-browser');
const UpdateService = require('./update-service');
const UpdateHelperLauncher = require('./update-helper-launcher');
const { createUpdateLaunchNotice } = require('./update-launch-notice');
const CloudBackup = require('./cloud-backup');
const PUBLIC_OAUTH_CLIENTS = require('./public-oauth-clients');
const { loadGoogleOAuthReleaseConfig } = require('./google-oauth-release-config');
const WorkspaceCore = require('../workspace-core');
const OperationsCore = require('../operations-core');
const CertificateRosterCore = require('../certificate-roster-core');
const {
  PROJECT_CALENDAR_ID,
  DOCUMENT_EDITOR_ID,
  programWindowKey,
  standaloneLaunchQuery,
  requestedProjectId,
  requestedDocumentMode,
  programShortcutArgs,
  resolveProgramLaunch
} = require('../extensions/project-calendar/launch');

const isSmokeTest = process.env.CMOE_SMOKE === '1' || process.argv.includes('--smoke-test') || app.commandLine.hasSwitch('smoke-test');
if (isSmokeTest) {
  // Packaged smoke runs are intentionally launched without a visible desktop
  // window. Keep requestAnimationFrame-driven layout checks active even when
  // Windows marks that test window as occluded.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

// The release owner provisions this pair once while building CMOE Workspace. End
// users only choose a Google account; they never download or enter OAuth settings.
let googleOAuthReleaseConfig;
const googleOAuthReleaseOptions = {
  generatedPath: path.join(__dirname, 'google-oauth-client.generated.json'),
  publicClientId: PUBLIC_OAUTH_CLIENTS.googleDesktopClientId,
  expectedClientId: PUBLIC_OAUTH_CLIENTS.googleDesktopClientId
};
try {
  const managedClientId = app.isPackaged ? '' : String(process.env.CMOE_GOOGLE_PUBLIC_CLIENT_ID || '').trim();
  const managedClientSecret = app.isPackaged ? '' : String(process.env.CMOE_GOOGLE_CLIENT_SECRET || '').trim();
  if (managedClientId && managedClientSecret) {
    try {
      googleOAuthReleaseConfig = loadGoogleOAuthReleaseConfig({ ...googleOAuthReleaseOptions, managedClientId, managedClientSecret });
    } catch (error) {
      console.error(`CMOE Google OAuth development override was ignored (${String(error?.code || 'GOOGLE_OAUTH_MANAGED_CONFIG_INVALID')}).`);
      googleOAuthReleaseConfig = loadGoogleOAuthReleaseConfig(googleOAuthReleaseOptions);
    }
  } else {
    if (managedClientId || managedClientSecret) console.error('Incomplete CMOE Google OAuth development override was ignored.');
    googleOAuthReleaseConfig = loadGoogleOAuthReleaseConfig(googleOAuthReleaseOptions);
  }
} catch (error) {
  googleOAuthReleaseConfig = {
    clientId: String(PUBLIC_OAUTH_CLIENTS.googleDesktopClientId || '').trim(),
    clientSecret: '',
    source: 'invalid',
    ready: false,
    errorCode: String(error?.code || 'GOOGLE_OAUTH_RELEASE_CONFIG_INVALID')
  };
  console.error(`CMOE Google OAuth release configuration is unavailable (${googleOAuthReleaseConfig.errorCode}).`);
}
const effectiveGoogleOAuthReleaseConfig = isSmokeTest && !app.isPackaged && !googleOAuthReleaseConfig.ready
  ? { clientId: 'cmoe-workspace-smoke.apps.googleusercontent.com', clientSecret: 'smoke-only-placeholder', source: 'smoke', ready: true }
  : googleOAuthReleaseConfig;
const GOOGLE_DESKTOP_PUBLIC_CLIENT_ID = effectiveGoogleOAuthReleaseConfig.clientId;
const GOOGLE_DESKTOP_CLIENT_SECRET = effectiveGoogleOAuthReleaseConfig.clientSecret;
Object.keys(process.env).filter((key) => key.toLowerCase() === 'cmoe_google_client_secret').forEach((key) => { delete process.env[key]; });
const ZOOM_PUBLIC_CLIENT_ID = PUBLIC_OAUTH_CLIENTS.selectZoomPublicClientId({ isPackaged: app.isPackaged, environment: process.env });

installWebContentsSecurity(app, shell);

if (isSmokeTest) {
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', (error) => {
      if (error?.code !== 'EPIPE') throw error;
    });
  }
}
const smokeResultPath = path.join(app.getPath('temp'), 'cmoe-workspace-smoke-result.json');
let lastSmokeStep = 'boot';
function writeSmokeResult(status, details = {}) {
  if (!isSmokeTest) return;
  if (details.step) lastSmokeStep = details.step;
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
let loginBrowserLauncher;
let extensionManager;
let gmailFlowHost;
let runGmailFlowIdentityOperation;
let documentTools;
let isQuitting = false;
let quitReady = false;
let quitFlushInProgress = false;
let mainDriveSyncTimer = null;
let mainDriveSyncDirty = false;
let mainDriveSyncRevision = 0;
let mainDriveSyncPromise = null;
let mainDriveSyncError = null;
let remoteSyncWarningFingerprint = '';
let remoteSyncWarningAt = 0;
let driveSyncGuards;
let driveWorkspaceClient;
let lastUpdateCheck = null;
let updateDownloadPromise = null;
let updateDownloadAbortController = null;
let pendingUpdateLaunch = null;
const updateLaunchNotice = createUpdateLaunchNotice(process.argv);
const externalArtifactReservations = new Map();
const externalReservationOwners = new Set();
const guideModeOwners = new Set();
const guideModeOwnerCleanup = new Set();
const runWorkspaceStateTransaction = createTransactionQueue();
const runDriveStateTransaction = createTransactionQueue();
const connectionOperations = createKeyedOperationCoordinator();
const googleProviderOperations = createGoogleProviderOperationGate();
const activeConnectionAuthorizationRequests = new Set();
const startedConnectionAuthorizationRequests = new Set();
const queuedConnectionAuthorizationCancels = new Set();

function broadcastUpdateProgress(progress, preferredSender = null) {
  const senders = new Set([
    preferredSender,
    mainWindow?.webContents,
    ...[...programWindows.values()].map((window) => window?.webContents)
  ].filter((sender) => sender && !sender.isDestroyed()));
  senders.forEach((sender) => sender.send('workspace:update-progress', progress));
}

function activeBrowserPickerWindowHandle() {
  const owner = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!owner || owner.isDestroyed()) return '';
  try {
    const bytes = owner.getNativeWindowHandle();
    if (!Buffer.isBuffer(bytes) || bytes.length < 4) return '';
    const handle = bytes.length >= 8 ? bytes.readBigUInt64LE(0) : BigInt(bytes.readUInt32LE(0));
    return handle > 0n ? handle.toString() : '';
  } catch (_) {
    return '';
  }
}

function setGuideModeOwner(event, active) {
  const ownerId = event.sender.id;
  if (active) guideModeOwners.add(ownerId); else guideModeOwners.delete(ownerId);
  if (!guideModeOwnerCleanup.has(ownerId)) {
    guideModeOwnerCleanup.add(ownerId);
    event.sender.once('destroyed', () => { guideModeOwners.delete(ownerId); guideModeOwnerCleanup.delete(ownerId); });
  }
  return { ok: true, active: guideModeOwners.has(ownerId) };
}

function assertGuideModeAllows(event, action = '이 작업') {
  if (!guideModeOwners.has(event.sender.id)) return;
  const error = new Error(`가이드 연습 중에는 ${action}을 실제로 실행하지 않습니다.`);
  error.code = 'GUIDE_MODE_BLOCKED';
  throw error;
}

function guideModeBlockedResult(event, action = '이 작업') {
  if (!guideModeOwners.has(event.sender.id)) return null;
  return {
    __cmoeIpcError: {
      code: 'GUIDE_MODE_BLOCKED',
      message: `가이드 연습 중에는 ${action}을 실제로 실행하지 않습니다.`
    }
  };
}

const DOCUMENT_TOOL_ERROR_FALLBACK = '문서 작업을 완료하지 못했습니다.';
const DOCUMENT_TOOL_MESSAGE_LIMIT = 1_000;

function sanitizeDocumentToolErrorCode(value) {
  const code = String(value || 'DOCUMENT_TOOL_FAILED').replace(/[^A-Z0-9_.-]/gi, '_').slice(0, 80);
  return code || 'DOCUMENT_TOOL_FAILED';
}

function isDocumentToolDiagnosticLine(line) {
  return /^(?:at\s+|node:internal\b|caused by\s*:|---\s*end of inner exception stack trace|\+\s|(?:categoryinfo|fullyqualifiederrorid|scriptstacktrace|stacktrace)\s*:|위치\s+.*(?:\.ps1|줄\s+\d+))/i.test(line);
}

function redactDocumentToolPaths(value) {
  return value
    .replace(/(["'`])(?:(?:file:\/\/\/)?[A-Z]:[\\/]|\\\\)[^"'`\r\n]+\1/gi, '[로컬 경로]')
    .replace(/(?:file:\/\/\/)?(?:[A-Z]:[\\/]|\\\\)[^\r\n]*?office-automation\.ps1\s*:?\s*/gi, '[로컬 스크립트] ')
    .replace(/(?:file:\/\/\/)?(?:[A-Z]:[\\/]|\\\\)[^\r\n<>|?*]*?\.(?:ps1|pptx|pptm|potx|pdf|xlsx|xlsm|xls|csv|tsv|json|asar|exe|dll)(?=\s|[)\]}'",;:]|$)/gi, '[로컬 경로]')
    .replace(/(?:file:\/\/\/)?(?:[A-Z]:[\\/]|\\\\)[^\r\n]*/gi, '[로컬 경로]');
}

function sanitizeDocumentToolMessage(value, fallback = DOCUMENT_TOOL_ERROR_FALLBACK) {
  let raw = String(value || '')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/^(?:(?:error invoking remote method\s+["'][^"']+["']\s*:\s*)|(?:uncaught exception\s*:\s*)|(?:error\s*:\s*))+/i, '')
    .replace(/([.!?])\s+/g, '$1\n');
  raw = redactDocumentToolPaths(raw);

  const lines = [];
  for (const candidate of raw.split(/\r?\n|\s*[·|]\s*/)) {
    let line = candidate.trim();
    if (!line || isDocumentToolDiagnosticLine(line)) continue;
    if ((line.match(/\uFFFD/g) || []).length >= 2) continue;
    line = line.replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim();
    if (!line || lines.includes(line)) continue;
    lines.push(line);
  }

  const message = lines.join(' · ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .trim()
    .slice(0, DOCUMENT_TOOL_MESSAGE_LIMIT);
  return message || fallback;
}

function sanitizeDocumentToolPayload(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || depth > 8) return value;
  if (value instanceof Error) return sanitizeDocumentToolMessage(value.message);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDocumentToolPayload(item, depth + 1, seen));

  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (['stack', 'stderr', 'stdout', 'command', 'scriptpath'].includes(normalizedKey)) continue;
    if (['error', 'diagnostic', 'reason'].includes(normalizedKey)) {
      if (item == null || item === '') sanitized[key] = item;
      else sanitized[key] = sanitizeDocumentToolMessage(item instanceof Error ? item.message : item);
      continue;
    }
    sanitized[key] = sanitizeDocumentToolPayload(item, depth + 1, seen);
  }
  return sanitized;
}

async function runDocumentToolIpc(operation) {
  try { return sanitizeDocumentToolPayload(await operation()); }
  catch (error) {
    const ipcError = {
      code: sanitizeDocumentToolErrorCode(error?.code),
      message: sanitizeDocumentToolMessage(error?.message)
    };
    if (error?.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
      const details = {};
      for (const [key, value] of Object.entries(error.details).slice(0, 20)) {
        const safeKey = String(key || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
        if (!safeKey) continue;
        const sanitizeValue = (item) => typeof item === 'string'
          ? sanitizeDocumentToolMessage(item, '')
          : (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean' ? item : undefined);
        const safeValue = Array.isArray(value)
          ? value.slice(0, 100).map(sanitizeValue).filter((item) => item !== undefined)
          : sanitizeValue(value);
        if (safeValue !== undefined) details[safeKey] = safeValue;
      }
      if (Object.keys(details).length) ipcError.details = details;
    }
    return { __cmoeIpcError: ipcError };
  }
}

const CONNECTION_AUTH_STAGES = new Set(['callback_start', 'authorization_callback', 'token_exchange', 'profile_lookup', 'credential_persist']);

function connectionIpcError(error, fallbackCode = 'CONNECTION_REQUEST_FAILED') {
  const rawMessage = String(error?.message || '계정 연결 요청을 완료하지 못했습니다.')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[인증정보]')
    .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|code[_ -]?verifier)\b\s*[:=]?\s*[^\s,;]+/gi, '[보호된 값]')
    .replace(/https?:\/\/\S+/gi, '[외부 주소]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || '계정 연결 요청을 완료하지 못했습니다.';
  const code = String(error?.code || fallbackCode).replace(/[^A-Z0-9_.-]/gi, '_').slice(0, 80) || fallbackCode;
  const oauthStage = CONNECTION_AUTH_STAGES.has(error?.oauthStage) ? error.oauthStage : '';
  const oauthProviderCode = String(error?.oauthProviderCode || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const status = Number(error?.status);
  const remoteIdentity = error?.remoteIdentity && typeof error.remoteIdentity === 'object'
    ? {
        fileId: String(error.remoteIdentity.fileId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 240),
        modifiedTime: String(error.remoteIdentity.modifiedTime || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100),
        version: String(error.remoteIdentity.version || '').replace(/[^0-9]/g, '').slice(0, 80),
        etag: String(error.remoteIdentity.etag || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500)
      }
    : null;
  return {
    __cmoeIpcError: {
      code,
      message: rawMessage,
      ...(oauthStage ? { oauthStage } : {}),
      ...(oauthProviderCode ? { oauthProviderCode } : {}),
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
      ...(remoteIdentity?.fileId ? { remoteIdentity } : {})
    }
  };
}

async function runDriveIpc(operation) {
  try { return await operation(); }
  catch (error) { return connectionIpcError(error, 'DRIVE_REQUEST_FAILED'); }
}

function sendDocumentToolProgress(event, metadata, progress) {
  if (event.sender.isDestroyed()) return;
  const safeProgress = sanitizeDocumentToolPayload(progress);
  event.sender.send('document-tools:progress', {
    ...(safeProgress && typeof safeProgress === 'object' ? safeProgress : {}),
    requestId: metadata.requestId,
    kind: metadata.kind
  });
}

function guideModeOperationAllowed(event, action) {
  assertGuideModeAllows(event, action);
  return true;
}

function formsIpcError(error, fallbackCode = 'GOOGLE_FORMS_REQUEST_FAILED') {
  const result = connectionIpcError(error, fallbackCode);
  if (error?.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
    const details = {};
    Object.entries(error.details).slice(0, 20).forEach(([key, value]) => {
      const safeKey = String(key || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
      if (!safeKey || !['string', 'number', 'boolean'].includes(typeof value)) return;
      details[safeKey] = typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500)
        : value;
    });
    if (Object.keys(details).length) result.__cmoeIpcError.details = details;
  }
  return result;
}

async function runFormsIpc(event, action, operation) {
  try {
    assertGuideModeAllows(event, action);
    return await operation();
  } catch (error) {
    return formsIpcError(error);
  }
}

function releaseExternalReservation(token, ownerId = null) {
  let released = 0;
  for (const [key, reservation] of externalArtifactReservations) {
    if (reservation.token === token && (ownerId == null || reservation.ownerId === ownerId)) { externalArtifactReservations.delete(key); released += 1; }
  }
  return released;
}

function pruneExternalReservations(now = Date.now()) {
  for (const [key, reservation] of externalArtifactReservations) {
    const ownerDestroyed = reservation.owner?.isDestroyed?.() === true;
    const legacyLeaseExpired = !reservation.owner && Number(reservation.expiresAt || 0) <= now;
    if (ownerDestroyed || legacyLeaseExpired) externalArtifactReservations.delete(key);
  }
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

async function resolveWorkspaceGmailConnection() {
  return runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const connectionId = WorkspaceCore.resolveDefaultConnectionId(current, null, 'gmail');
    const connection = current.connections.find((item) => item.id === connectionId && item.type === 'gmail');
    return connection ? { ...connection } : null;
  });
}

async function ensureWorkspaceGmailConnection() {
  const connection = await runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const connectionId = WorkspaceCore.resolveDefaultConnectionId(current, null, 'gmail');
    const existing = current.connections.find((item) => item.id === connectionId && item.type === 'gmail');
    if (existing) return { ...existing };
    const gmailConnections = current.connections.filter((item) => item.type === 'gmail');
    if (gmailConnections.length > 1) {
      const error = new Error('연결된 Gmail 계정이 여러 개입니다. 계정 연결 화면에서 Workspace 기본 Gmail 계정을 선택해주세요.');
      error.code = 'WORKSPACE_GMAIL_DEFAULT_REQUIRED';
      throw error;
    }
    if (gmailConnections.length === 1) return { ...gmailConnections[0] };
    const added = WorkspaceCore.addConnection(current, { type: 'gmail', label: 'Gmail 계정', account: '', status: 'needsAuth' });
    added.state._revision = Number(current._revision || 0) + 1;
    added.state._baseRevision = added.state._revision;
    await storage.set('workspaceState', added.state);
    return { ...added.connection };
  });
  if (!authManager.publicStatus(connection.id).configured) {
    await connectionOperations.transition(connection.id, () => authManager.setConfig(connection.id, { provider: 'google', type: 'gmail', authMode: 'public-pkce' }));
  }
  return connection;
}

async function authorizeWorkspaceGmailConnection(connectionId, options = {}) {
  return connectionOperations.transition(connectionId, async () => {
    if (!authManager.publicStatus(connectionId).configured) {
      await authManager.setConfig(connectionId, { provider: 'google', type: 'gmail', authMode: 'public-pkce' });
    }
    const status = await authManager.authorize(connectionId, options);
    return persistAuthorizedConnection(connectionId, status);
  });
}

async function disconnectWorkspaceGmailConnection(connectionId) {
  return connectionOperations.transition(connectionId, async () => {
    const status = await authManager.disconnect(connectionId);
    return persistAuthorizedConnection(connectionId, status);
  });
}

function providerForConnection(connectionId, fallbackProvider = '') {
  const provider = String(fallbackProvider || authManager?.publicStatus?.(connectionId)?.provider || '').toLowerCase();
  return provider === 'zoom' ? 'zoom' : 'google';
}

function runConnectionProviderOperation(connectionId, operation, fallbackProvider = '') {
  return googleProviderOperations.run(providerForConnection(connectionId, fallbackProvider), operation);
}

async function reconcilePersistedProviderConnections(provider, options = {}) {
  return runWorkspaceStateTransaction(async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const reconcileConnections = provider === 'zoom' ? reconcileWorkspaceZoomConnections : reconcileWorkspaceGoogleConnections;
    const reconciliation = reconcileConnections(
      current,
      (connectionId) => authManager.publicStatus(connectionId),
      {
        ...options,
        applyAuthorization: (state, connectionId, status, reason) => WorkspaceCore.applyConnectionAuthorization(state, connectionId, status, reason)
      }
    );
    if (reconciliation.changedConnectionIds.length) {
      await storage.set('workspaceState', reconciliation.state);
      broadcastState(reconciliation.state);
    }
    return {
      changed: reconciliation.changedConnectionIds.length,
      invalidated: reconciliation.invalidatedConnectionIds.length,
      recovered: reconciliation.recoveredConnectionIds.length,
      retiredArtifacts: reconciliation.retiredArtifacts,
      reviewedForms: reconciliation.reviewedForms
    };
  });
}

async function reconcilePersistedGoogleConnections(options = {}) {
  return reconcilePersistedProviderConnections('google', options);
}

async function reconcilePersistedZoomConnections(options = {}) {
  return reconcilePersistedProviderConnections('zoom', options);
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
  return driveWorkspaceClient.listWorkspaceFiles(connectionId);
}

async function fetchDriveWorkspaceMetadata(connectionId, fileId) {
  const snapshot = await driveWorkspaceClient.fetchWorkspaceMetadata(connectionId, fileId);
  return { ...snapshot, id: snapshot.fileId };
}

async function readStableDriveWorkspaceFile(connectionId, fileId, attempts = 2) {
  return driveWorkspaceClient.readStableWorkspaceFile(connectionId, fileId, attempts);
}

async function throwLatchedDriveConflict(connection, code, message, snapshot = {}) {
  try { await driveSyncGuards.markConflict(connection, message, snapshot); }
  catch (error) { console.error('Drive 충돌 잠금 저장 실패:', error); }
  const conflict = new Error(message);
  conflict.code = code;
  throw conflict;
}

async function createDriveWorkspaceFile(connection, latestState) {
  try {
    const snapshot = await driveWorkspaceClient.createWorkspaceFile(connection.id, latestState);
    await driveSyncGuards.observeRemote(connection, snapshot);
    return snapshot;
  } catch (error) {
    if (['REMOTE_DRIVE_VERSION_MISSING', 'REMOTE_DRIVE_STATE_CHANGED', 'REMOTE_DRIVE_DUPLICATE_FILES', 'REMOTE_DRIVE_PAYLOAD_INVALID'].includes(error?.code)) {
      await throwLatchedDriveConflict(connection, error.code, error.message, error.snapshot || {});
    }
    throw error;
  }
}

async function uploadLatestWorkspaceStateToDrive(connectionId, expectedIdentity) {
  const connection = await assertExpectedConnection(connectionId, expectedIdentity);
  if (!connectionGuardKey(connection)) {
    const error = new Error('Drive 동기화 기준을 계정별로 보호할 수 없어 저장을 중단했습니다. Drive 계정에 다시 로그인해주세요.');
    error.code = 'DRIVE_ACCOUNT_IDENTITY_MISSING';
    throw error;
  }
  const latestState = await runWorkspaceStateTransaction(async () => WorkspaceCore.normalizeState(await storage.get('workspaceState', null)));
  const selectedConnection = latestState.preferences.storageMode === 'drive' ? WorkspaceCore.workspaceDriveConnection(latestState) : null;
  if (!selectedConnection || selectedConnection.id !== connectionId) {
    const error = new Error('Workspace 전체 동기화 계정이 변경되어 이전 계정으로의 저장을 중단했습니다. 환경 설정에서 선택한 계정을 확인해주세요.');
    error.code = 'DRIVE_SYNC_ACCOUNT_CHANGED';
    throw error;
  }
  const guard = await driveSyncGuards.get(connection);
  const files = await listDriveWorkspaceFiles(connectionId);
  const canonicalFile = files[0] || null;
  if (files.length > 1) {
    await throwLatchedDriveConflict(connection, 'REMOTE_DRIVE_DUPLICATE_FILES', 'Drive에 Workspace 파일이 둘 이상 있어 어느 데이터를 기준으로 할지 안전하게 판단할 수 없습니다. 자동 저장을 중단했습니다.', canonicalFile || guard || {});
  }
  if (guard?.state === 'conflict') {
    if (canonicalFile && (!guard.fileId || String(canonicalFile.id || '') === guard.fileId)) {
      try {
        const stableRemote = await readStableDriveWorkspaceFile(connectionId, canonicalFile.id);
        const normalizedRemote = WorkspaceCore.normalizeState(stableRemote.state);
        if (drivePayloadsEqual(latestState, normalizedRemote)) {
          await driveSyncGuards.observeRemote(connection, stableRemote.identity);
          return {
            fileId: stableRemote.identity.fileId,
            modifiedTime: stableRemote.identity.modifiedTime,
            version: stableRemote.identity.version,
            migratedBaseline: true,
            recoveredConflict: true
          };
        }
        const resolutionMessage = 'Drive 저장본과 이 PC의 내용이 달라 자동으로 덮어쓰지 않았습니다. 어느 쪽을 유지할지 선택해주세요.';
        // Bind the user's later local-wins confirmation to the exact remote
        // snapshot that caused this prompt. A fresh ETag must not silently
        // broaden an earlier confirmation to cover a newer, unseen upload.
        await driveSyncGuards.markConflict(connection, resolutionMessage, stableRemote.identity);
        const error = new Error(resolutionMessage);
        error.code = 'DRIVE_SYNC_RESOLUTION_REQUIRED';
        error.remoteIdentity = stableRemote.identity;
        throw error;
      } catch (error) {
        if (error?.code === 'DRIVE_SYNC_RESOLUTION_REQUIRED' || !String(error?.code || '').startsWith('REMOTE_DRIVE_')) throw error;
      }
    }
    const error = new Error(guard.reason || '다른 PC의 Drive 변경이 확인되어 자동 저장이 잠겼습니다. 최신 Drive 데이터를 다시 불러와 확인해주세요.');
    error.code = 'REMOTE_DRIVE_CONFLICT_LATCHED';
    throw error;
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
  let snapshot;
  try {
    snapshot = await driveWorkspaceClient.updateWorkspaceFile(connectionId, guard, latestState);
  } catch (error) {
    if ([404, 412].includes(error?.status) || ['REMOTE_DRIVE_VERSION_MISSING', 'REMOTE_DRIVE_STATE_CHANGED', 'REMOTE_DRIVE_DUPLICATE_FILES', 'REMOTE_DRIVE_PAYLOAD_INVALID'].includes(error?.code)) {
      await throwLatchedDriveConflict(connection, error?.code || 'REMOTE_DRIVE_STATE_CHANGED', error.message, error.snapshot || guard);
    }
    throw error;
  }
  await driveSyncGuards.observeRemote(connection, snapshot);
  return { fileId: snapshot.fileId, modifiedTime: snapshot.modifiedTime || new Date().toISOString(), version: snapshot.version || '' };
}

async function resolveLatchedDriveConflictWithLocal(connectionId, expectedIdentity, expectedWorkspaceIdentity, expectedRemoteIdentity) {
  const connection = await assertExpectedConnection(connectionId, expectedIdentity);
  if (!connectionGuardKey(connection)) {
    const error = new Error('Drive 동기화 기준을 계정별로 보호할 수 없어 저장을 중단했습니다. Drive 계정에 다시 로그인해주세요.');
    error.code = 'DRIVE_ACCOUNT_IDENTITY_MISSING';
    throw error;
  }
  const latestState = await runWorkspaceStateTransaction(async () => WorkspaceCore.normalizeState(await storage.get('workspaceState', null)));
  const selectedConnection = latestState.preferences.storageMode === 'drive' ? WorkspaceCore.workspaceDriveConnection(latestState) : null;
  if (!selectedConnection || selectedConnection.id !== connectionId) {
    const error = new Error('Workspace 전체 동기화 계정이 변경되어 저장을 중단했습니다. 환경 설정에서 선택한 계정을 확인해주세요.');
    error.code = 'DRIVE_SYNC_ACCOUNT_CHANGED';
    throw error;
  }
  if (Number(latestState._revision || 0) !== Number(expectedWorkspaceIdentity?._revision || 0)
    || String(latestState.updatedAt || '') !== String(expectedWorkspaceIdentity?.updatedAt || '')) {
    const error = new Error('확인하는 동안 이 PC의 Workspace가 변경되었습니다. 최신 상태에서 다시 선택해주세요.');
    error.code = 'WORKSPACE_STATE_CHANGED';
    throw error;
  }
  const guard = await driveSyncGuards.get(connection);
  if (guard?.state !== 'conflict') {
    const error = new Error('해결할 Drive 충돌 상태가 이미 바뀌었습니다. 최신 상태에서 다시 저장해주세요.');
    error.code = 'DRIVE_SYNC_CONFLICT_CHANGED';
    throw error;
  }
  const files = await listDriveWorkspaceFiles(connectionId);
  if (files.length !== 1 || (guard.fileId && String(files[0]?.id || '') !== guard.fileId)) {
    const code = files.length > 1 ? 'REMOTE_DRIVE_DUPLICATE_FILES' : 'REMOTE_DRIVE_STATE_CHANGED';
    await throwLatchedDriveConflict(connection, code, 'Drive의 Workspace 파일 구성이 달라져 이 PC 내용으로 바꾸지 않았습니다. Drive 자료를 다시 확인해주세요.', files[0] || guard);
  }
  const stableRemote = await readStableDriveWorkspaceFile(connectionId, files[0].id);
  if (!authoritativeIdentityMatches(expectedRemoteIdentity, stableRemote.identity, { requireEtag: true })) {
    await throwLatchedDriveConflict(
      connection,
      'REMOTE_DRIVE_STATE_CHANGED',
      '선택 화면을 확인하는 동안 Drive 저장본이 다시 변경되어 이 PC 내용으로 바꾸지 않았습니다. 최신 상태에서 다시 선택해주세요.',
      stableRemote.identity
    );
  }
  const normalizedRemote = WorkspaceCore.normalizeState(stableRemote.state);
  if (drivePayloadsEqual(latestState, normalizedRemote)) {
    await driveSyncGuards.observeRemote(connection, stableRemote.identity);
    return {
      fileId: stableRemote.identity.fileId,
      modifiedTime: stableRemote.identity.modifiedTime,
      version: stableRemote.identity.version,
      resolvedConflict: true,
      writeSkipped: true
    };
  }
  let snapshot;
  try {
    snapshot = await driveWorkspaceClient.updateWorkspaceFile(connectionId, stableRemote.identity, latestState);
  } catch (error) {
    if ([404, 412].includes(error?.status) || ['REMOTE_DRIVE_VERSION_MISSING', 'REMOTE_DRIVE_STATE_CHANGED', 'REMOTE_DRIVE_DUPLICATE_FILES', 'REMOTE_DRIVE_PAYLOAD_INVALID'].includes(error?.code)) {
      await throwLatchedDriveConflict(connection, error?.code || 'REMOTE_DRIVE_STATE_CHANGED', error.message, error.snapshot || stableRemote.identity);
    }
    throw error;
  }
  await driveSyncGuards.observeRemote(connection, snapshot);
  return {
    fileId: snapshot.fileId,
    modifiedTime: snapshot.modifiedTime || new Date().toISOString(),
    version: snapshot.version || '',
    resolvedConflict: true,
    writeSkipped: false
  };
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
      const connection = WorkspaceCore.workspaceDriveConnection(latestState);
      if (!connection) {
        const connectedDriveCount = latestState.connections.filter((item) => item.type === 'drive' && item.status === 'connected').length;
        throw new Error(latestState.preferences.workspaceDriveConnectionId
          ? '선택한 Workspace Drive 계정에 다시 로그인하거나 환경 설정에서 다른 계정을 선택해주세요.'
          : connectedDriveCount > 1
          ? '연결된 Drive 계정이 여러 개입니다. 환경 설정에서 Workspace 전체 동기화 계정을 선택해주세요.'
          : 'Google Drive 저장 모드이지만 연결된 Drive 계정이 없습니다. Drive 계정을 다시 연결하거나 저장 위치를 이 PC로 바꿔주세요.');
      }
      await googleProviderOperations.run('google', () => connectionOperations.run(connection.id, () => runDriveStateTransaction(() => uploadLatestWorkspaceStateToDrive(connection.id, WorkspaceCore.connectionIdentity(connection)))));
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

const PROGRAMS = new Set(['people', 'schedule', PROJECT_CALENDAR_ID, 'layout', 'forms', 'zoom', 'gmailFlow', DOCUMENT_EDITOR_ID]);
const PROGRAM_LABELS = { people: 'CMOE 명단', schedule: 'CMOE 일정 편성', projectCalendar: 'CMOE 캘린더', layout: 'CMOE 일정표', forms: 'CMOE 설문', zoom: 'CMOE Zoom', gmailFlow: 'CMOE 메일', documentEditor: 'CMOE 문서 편집' };
const LEGACY_PROGRAM_LABELS = {
  people: ['CMOE 명단 관리'], schedule: ['CMOE 일정 조율'], projectCalendar: ['CMOE 프로젝트 캘린더'], layout: ['CMOE Excel 출력'], forms: ['CMOE Google Forms'], gmailFlow: ['CMOE Gmail Flow'],
  documentEditor: ['CMOE PPTX 일괄 PDF 변환', 'CMOE 템플릿 문서 만들기']
};
const PROGRAM_ICON_INDEX = { people: 264, schedule: 168, projectCalendar: 21, layout: 268, forms: 260, zoom: 18, gmailFlow: 220, documentEditor: 70 };
function requestedProgram(argv = process.argv) {
  const value = argv.find((item) => item.startsWith('--app='))?.slice('--app='.length);
  return /^[a-z][a-zA-Z0-9.-]{1,63}$/.test(value || '') ? value : '';
}

function extensionManifest(programId) { return extensionManager?.list().find((item) => item.id === programId); }
function isProgramId(programId) { const resolved = resolveProgramLaunch(programId).programId; return PROGRAMS.has(resolved) || Boolean(extensionManifest(resolved)?.declarative); }
function programLabel(programId) { const resolved = resolveProgramLaunch(programId).programId; return PROGRAM_LABELS[resolved] || extensionManifest(resolved)?.name || resolved; }

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function workspacePersistentBackupEntries() {
  const userDataPath = app.getPath('userData');
  const entries = [
    'workspace-data.json', 'workspace-data.json.bak', 'workspace-credentials.json', 'workspace-credentials.json.bak',
    'extensions', 'document-tools/document-tools-data.json', 'document-tools/document-tools-data.json.bak',
    'document-tools/templates', 'gmail-flow-desktop'
  ].map((relativePath) => ({ source: path.join(userDataPath, ...relativePath.split('/')), relativePath: `workspace/${relativePath}` }));
  entries.push({ source: path.join(app.getPath('appData'), 'gmail-flow-desktop'), relativePath: 'legacy-gmail-flow-desktop' });
  return entries;
}

async function backupWorkspacePersistentData(version) {
  return UpdateService.createUpdateDataBackup({
    version,
    backupRoot: path.join(app.getPath('appData'), 'CMOE Workspace Backups'),
    entries: workspacePersistentBackupEntries()
  });
}

function selectedWorkspaceDriveConnection(state) {
  const connection = WorkspaceCore.workspaceDriveConnection(state);
  if (!connection || connection.status !== 'connected') throw new Error('Drive 백업에 사용할 Google 계정을 먼저 연결하고 선택해주세요.');
  return connection;
}

async function createWorkspaceCloudBackup(version = app.getVersion(), { recordState = true } = {}) {
  const workspaceState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
  const connection = selectedWorkspaceDriveConnection(workspaceState);
  const gmailData = await gmailFlowHost.storage.get(null);
  const documentProfiles = await documentTools.storage.get('certificateProfiles', []);
  const payload = await CloudBackup.createCloudBackupPayload({
    version,
    workspaceState,
    gmailData,
    documentProfiles,
    fileRoots: {
      extensions: path.join(app.getPath('userData'), 'extensions'),
      'document-templates': path.join(app.getPath('userData'), 'document-tools', 'templates')
    }
  });
  const uploaded = await driveWorkspaceClient.createBackupFile(connection.id, payload);
  if (recordState) {
    workspaceState.preferences.lastCloudBackupAt = payload.createdAt;
    workspaceState.preferences.lastCloudBackupFile = uploaded.name;
    workspaceState.updatedAt = new Date().toISOString();
    workspaceState._revision = Number(workspaceState._revision || 0) + 1;
    workspaceState._baseRevision = workspaceState._revision;
    await storage.set('workspaceState', workspaceState);
  }
  return { createdAt: payload.createdAt, name: uploaded.name, fileId: uploaded.fileId, files: payload.files.length };
}

async function restoreLatestWorkspaceCloudBackup() {
  const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
  const connection = selectedWorkspaceDriveConnection(current);
  const downloaded = await driveWorkspaceClient.readLatestBackup(connection.id);
  if (!downloaded) throw new Error('선택한 Google Drive 계정에 복원할 Workspace 백업이 없습니다.');
  const payload = CloudBackup.validateCloudBackupPayload(downloaded.payload);
  const restoredState = WorkspaceCore.normalizeState(preserveLocalConnectionContext(payload.workspaceState, current));
  restoredState.preferences.storageMode = 'drive';
  restoredState.preferences.workspaceDriveConnectionId = connection.id;
  restoredState.preferences.lastCloudBackupAt = payload.createdAt;
  restoredState.preferences.lastCloudRestoreAt = new Date().toISOString();
  restoredState.updatedAt = new Date().toISOString();
  restoredState._revision = Number(current._revision || 0) + 1;
  restoredState._baseRevision = restoredState._revision;
  const fileResult = await CloudBackup.restoreCloudBackupFiles(payload, {
    extensions: path.join(app.getPath('userData'), 'extensions'),
    'document-templates': path.join(app.getPath('userData'), 'document-tools', 'templates')
  });
  await gmailFlowHost.storage.set(CloudBackup.safeGmailData(payload.gmailData));
  await documentTools.storage.set('certificateProfiles', Array.isArray(payload.documentData?.certificateProfiles) ? payload.documentData.certificateProfiles : []);
  await storage.set('workspaceState', restoredState);
  broadcastState(restoredState);
  return { createdAt: payload.createdAt, appVersion: payload.appVersion, files: fileResult.restored.length };
}

function flushWorkspaceWindow(targetWindow, timeoutMs = 10_000) {
  if (!targetWindow || targetWindow.isDestroyed()) return Promise.resolve(normalizeCloseFlushResult(true));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('변경사항 저장 시간이 초과되었습니다.')), timeoutMs);
    targetWindow.webContents.executeJavaScript('globalThis.flushWorkspaceEdits?.()').then((result) => {
      clearTimeout(timeout);
      try { resolve(normalizeCloseFlushResult(result)); }
      catch (error) { reject(error); }
    }, (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function showRemoteSyncPendingWarning(parentWindow, warnings) {
  const messages = [...new Set((warnings || []).map((message) => String(message || '').trim()).filter(Boolean))];
  if (!messages.length) return;
  const fingerprint = messages.join('\n');
  const now = Date.now();
  if (fingerprint === remoteSyncWarningFingerprint && now - remoteSyncWarningAt < 10_000) return;
  remoteSyncWarningFingerprint = fingerprint;
  remoteSyncWarningAt = now;
  const options = {
    type: 'warning',
    title: 'Google Drive 동기화 보류',
    message: '변경사항은 이 PC에 안전하게 저장했습니다.',
    detail: `Google Drive에는 아직 반영되지 않았습니다. 다음 실행이나 계정 재로그인 후 자동으로 다시 시도합니다. 그전에는 다른 PC에서 최신 변경이 보이지 않을 수 있습니다.\n\n${messages.join('\n')}`,
    buttons: ['확인'],
    defaultId: 0,
    noLink: true
  };
  if (parentWindow && !parentWindow.isDestroyed()) await dialog.showMessageBox(parentWindow, options);
  else await dialog.showMessageBox(options);
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
    flushWorkspaceWindow(targetWindow).then(async (flushResult) => {
      if (targetWindow.isDestroyed()) return;
      if (flushResult.remotePending) {
        await showRemoteSyncPendingWarning(targetWindow, [flushResult.remoteError || 'Google Drive 동기화가 아직 완료되지 않았습니다.']).catch(console.error);
      }
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
  const resolvedLaunch = resolveProgramLaunch(programId, options);
  programId = resolvedLaunch.programId; options = resolvedLaunch.options;
  const windowKey = programWindowKey(programId, options);
  const existing = programWindows.get(windowKey);
  if (existing && !existing.isDestroyed()) {
    if (programId === 'people' && options.projectId) existing.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1', rosterManager: '1', page: 'roster', projectId: options.projectId } });
    if (programId === DOCUMENT_EDITOR_ID && options.documentMode) {
      const selectMode = () => { if (!existing.isDestroyed()) existing.webContents.send('document-editor:select-mode', options.documentMode); };
      if (existing.webContents.isLoadingMainFrame()) existing.webContents.once('did-finish-load', selectMode); else selectMode();
    }
    if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); return existing;
  }
  const legacyGmail = (programId === 'gmailFlow' || programId === 'people') && gmailFlowHost;
  const window = new BrowserWindow({ width: legacyGmail ? 1040 : 1220, height: 820, minWidth: legacyGmail ? 760 : 900, minHeight: 640, show: false, backgroundColor: legacyGmail ? '#f5f5f3' : '#f3f4f6', title: legacyGmail ? 'Gmail Flow' : programLabel(programId), webPreferences: { preload: legacyGmail ? gmailFlowHost.preloadPath : path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  protectWorkspaceWindowClose(window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => programWindows.delete(windowKey));
  if (programId === 'people') window.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1', rosterManager: '1', page: 'roster', projectId: options.projectId || '' } });
  else if (legacyGmail) window.loadFile(gmailFlowHost.pagePath, { query: { mode: 'window', desktop: '1', workspace: '1' } });
  else window.loadFile(path.join(__dirname, '..', 'index.html'), { query: standaloneLaunchQuery(programId, options) });
  programWindows.set(windowKey, window);
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

function workspaceGmailIdentityFingerprint(stateInput) {
  const state = WorkspaceCore.normalizeState(stateInput);
  const connectionId = WorkspaceCore.resolveDefaultConnectionId(state, null, 'gmail');
  const connection = state.connections.find((item) => item.id === connectionId && item.type === 'gmail');
  return JSON.stringify({
    connectionId: connection?.id || '',
    status: connection?.status || '',
    account: String(connection?.account || '').trim().toLowerCase(),
    updatedAt: connection?.updatedAt || ''
  });
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
  mainWindow.webContents.on('console-message', (details) => {
    if (['warning', 'error'].includes(details.level) || isSmokeTest) console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'), isSmokeTest ? { query: { smoke: '1' } } : undefined);
}

function registerIpc() {
  ipcMain.handle('workspace:guide-mode', (event, active) => setGuideModeOwner(event, Boolean(active)));
  ipcMain.handle('workspace:load', () => storage.get('workspaceState', null));
  ipcMain.handle('workspace:save', (event, incoming) => {
    const initialBlock = guideModeBlockedResult(event, 'Workspace 저장');
    if (initialBlock) return initialBlock;
    return runWorkspaceStateTransaction(async () => {
      const queuedBlock = guideModeBlockedResult(event, 'Workspace 저장');
      if (queuedBlock) return queuedBlock;
      const mergeHints = incoming?._mergeHints && typeof incoming._mergeHints === 'object' ? incoming._mergeHints : {};
      const externalCommit = incoming?._externalCommit && typeof incoming._externalCommit === 'object' ? incoming._externalCommit : null;
      let cleanIncoming = { ...(incoming || {}) };
      delete cleanIncoming._mergeHints;
      delete cleanIncoming._externalCommit;
      const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
      cleanIncoming = WorkspaceCore.normalizeState(cleanIncoming);
      const normalizedMergeHints = { ...mergeHints, ...(mergeHints.baseState ? { baseState: WorkspaceCore.normalizeState(mergeHints.baseState) } : {}) };
      let externalConflict = false; let externalConflictReason = '';
      if (externalCommit) {
        pruneExternalReservations();
        const resolved = resolveExternalCommit(WorkspaceCore.normalizeState(current), cleanIncoming, externalCommit, externalArtifactReservations, event.sender.id);
        cleanIncoming = resolved.state;
        externalConflict = !resolved.ok;
        externalConflictReason = resolved.reason;
      }
      const mergedState = mergeSelectedWorkspaceState(current, cleanIncoming, normalizedMergeHints);
      const { currentRevision } = mergedState;
      let next = mergedState.state;
      next = recomputeMergedScheduleProjects(next, normalizedMergeHints.scheduleProjects);
      next._revision = currentRevision + 1; next._baseRevision = next._revision;
      await storage.set('workspaceState', next);
      return { ok: true, state: next, merged: mergedState.merged, externalConflict, externalConflictReason };
    });
  });
  ipcMain.handle('workspace:app-info', () => ({ version: app.getVersion(), userDataPath: app.getPath('userData'), ...updateLaunchNotice.consume() }));
  ipcMain.handle('workspace:update-status', () => ({ currentVersion: app.getVersion(), packaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR), checked: lastUpdateCheck }));
  ipcMain.handle('workspace:update-check', async () => {
    lastUpdateCheck = await UpdateService.checkForUpdate(app.getVersion());
    return { ...lastUpdateCheck, packaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR) };
  });
  ipcMain.handle('workspace:update-install', async (event) => {
    if (!app.isPackaged) throw new Error('개발 실행에서는 업데이트 설치를 시작하지 않습니다.');
    if (process.env.PORTABLE_EXECUTABLE_DIR) throw new Error('휴대형은 자동 설치하지 않습니다. 다운로드 페이지에서 새 휴대형 파일을 받아주세요.');
    if (!lastUpdateCheck?.available) throw new Error('먼저 새 버전 확인을 완료해주세요.');
    if (updateDownloadPromise) return updateDownloadPromise;
    const feed = lastUpdateCheck.feed;
    const updateRoot = path.join(app.getPath('temp'), 'cmoe-workspace-update', feed.version);
    const installerPath = path.join(updateRoot, path.basename(new URL(feed.url).pathname));
    updateDownloadAbortController = new AbortController();
    broadcastUpdateProgress({ stage: 'starting', message: `CMOE Workspace ${feed.version} 업데이트를 준비하고 있습니다.`, received: 0, total: feed.bytes, percent: 0 }, event.sender);
    updateDownloadPromise = UpdateService.downloadInstaller(feed, installerPath, globalThis.fetch, (progress) => {
      broadcastUpdateProgress(progress, event.sender);
    }, { signal: updateDownloadAbortController.signal }).then((downloadedPath) => {
      pendingUpdateLaunch = { installerPath: downloadedPath, expectedSha256: feed.sha256, expectedBytes: feed.bytes, expectedVersion: feed.version, appPath: process.execPath, pid: process.pid };
      broadcastUpdateProgress({ stage: 'saving', message: '작업 내용을 저장하고 안전 백업을 준비하고 있습니다.', received: feed.bytes, total: feed.bytes, percent: 100 }, event.sender);
      setTimeout(() => app.quit(), 300);
      return { ready: true, version: feed.version };
    }).finally(() => { updateDownloadPromise = null; updateDownloadAbortController = null; });
    return updateDownloadPromise;
  });
  ipcMain.handle('workspace:update-cancel', () => {
    if (!updateDownloadAbortController || !updateDownloadPromise) return { canceled: false };
    updateDownloadAbortController.abort();
    return { canceled: true };
  });
  ipcMain.handle('workspace:update-open-downloads', () => shell.openExternal('https://cresero.com/downloads/cmoe-workspace'));
  ipcMain.handle('workspace:cloud-backup-create', () => createWorkspaceCloudBackup());
  ipcMain.handle('workspace:cloud-backup-latest', async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const connection = selectedWorkspaceDriveConnection(current);
    const files = await driveWorkspaceClient.listBackupFiles(connection.id);
    return files[0] || null;
  });
  ipcMain.handle('workspace:cloud-backup-restore', () => restoreLatestWorkspaceCloudBackup());
  ipcMain.handle('workspace:external-reserve', (event, payload = {}) => {
    assertGuideModeAllows(event, '외부 서비스 작업');
    pruneExternalReservations();
    const projectId = String(payload.projectId || '').trim(); const kind = String(payload.kind || '').trim();
    const rawKeys = Array.isArray(payload.keys) ? payload.keys : [];
    if (rawKeys.length > 1000) throw new Error('한 번에 예약할 외부 작업이 너무 많습니다.');
    const keys = [...new Set(rawKeys.map((key) => String(key || '').trim()).filter(Boolean))];
    if (!projectId || projectId.length > 200 || /[\u0000-\u001f\u007f]/.test(projectId) || !['zoom', 'gmailDraft', 'googleForm', 'connection'].includes(kind) || !keys.length || keys.some((key) => key.length > 200 || /[\u0000-\u001f\u007f]/.test(key))) throw new Error('외부 작업 예약 정보가 올바르지 않습니다.');
    const logicalKeys = keys.map((key) => `${projectId}:${kind}:${key}`);
    const busyKeys = logicalKeys.filter((key) => externalArtifactReservations.has(key)).map((key) => key.slice(`${projectId}:${kind}:`.length));
    if (busyKeys.length) return { ok: false, busyKeys };
    const token = crypto.randomUUID(); const ownerId = event.sender.id; const expiresAt = Number.MAX_SAFE_INTEGER;
    logicalKeys.forEach((key) => externalArtifactReservations.set(key, { token, ownerId, owner: event.sender, leaseMode: 'owner-lifetime', expiresAt }));
    if (!externalReservationOwners.has(ownerId)) { externalReservationOwners.add(ownerId); event.sender.once('destroyed', () => releaseExternalReservationsForOwner(ownerId)); }
    return { ok: true, token, expiresAt, keys };
  });
  ipcMain.handle('workspace:external-release', (event, token) => ({ ok: true, released: releaseExternalReservation(String(token || ''), event.sender.id) }));
  ipcMain.handle('program:open', (event, programId, options = {}) => { assertGuideModeAllows(event, '별도 프로그램 열기'); if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.'); createProgramWindow(programId, options); return { ok: true }; });
  ipcMain.handle('workspace:roster:open-picker', (event, projectId) => { assertGuideModeAllows(event, '공용 명단 관리 창 열기'); createRosterPickerWindow(projectId, BrowserWindow.fromWebContents(event.sender) || mainWindow); return { ok: true }; });
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
  ipcMain.handle('workspace:roster:certificate-catalog', async () => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    return CertificateRosterCore.buildCatalog(current);
  });
  ipcMain.handle('workspace:roster:certificate-read', async (_event, payload = {}) => {
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    return CertificateRosterCore.readForCertificate(current, payload);
  });
  ipcMain.handle('workspace:roster:library-save', (event, payload = {}) => guideModeOperationAllowed(event, '공용 명단 저장') && runWorkspaceStateTransaction(async () => {
    assertGuideModeAllows(event, '공용 명단 저장');
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
  ipcMain.handle('workspace:roster:library-delete', (event, rosterId) => guideModeOperationAllowed(event, '공용 명단 삭제') && runWorkspaceStateTransaction(async () => {
    assertGuideModeAllows(event, '공용 명단 삭제');
    const current = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
    const normalizedRosterId = String(rosterId || '');
    if (!current.library.rosters.some((item) => String(item.id) === normalizedRosterId)) return { ok: true, deleted: false };
    if (!current.knownLibraryIds.includes(normalizedRosterId)) current.knownLibraryIds.push(normalizedRosterId);
    if (!current.deletedLibraryIds.includes(normalizedRosterId)) current.deletedLibraryIds.push(normalizedRosterId);
    current.library.rosters = current.library.rosters.filter((item) => String(item.id) !== normalizedRosterId);
    current.updatedAt = new Date().toISOString();
    current._revision = Number(current._revision || 0) + 1; current._baseRevision = current._revision;
    await storage.set('workspaceState', current); broadcastState(current); return { ok: true, deleted: true };
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
  ipcMain.handle('workspace:roster:save', (event, projectId, payload = {}) => guideModeOperationAllowed(event, '프로젝트 명단 저장') && runWorkspaceStateTransaction(async () => {
    assertGuideModeAllows(event, '프로젝트 명단 저장');
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
    WorkspaceCore.pruneRosterReferences(project);
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
  ipcMain.handle('workspace:open-external', async (event, rawUrl) => {
    assertGuideModeAllows(event, '외부 주소 열기');
    if (String(rawUrl || '').length > 8192) throw new Error('외부 주소가 너무 깁니다.');
    let url;
    try { url = new URL(String(rawUrl || '')); } catch (_) { throw new Error('외부 주소가 올바르지 않습니다.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('안전한 웹 주소만 열 수 있습니다.');
    await shell.openExternal(url.toString()); return { ok: true };
  });
  ipcMain.handle('workspace:clipboard-write', (event, rawText) => {
    assertGuideModeAllows(event, '클립보드에 복사');
    const text = String(rawText || '');
    if (!text || text.length > 8192) throw new Error(text ? '복사할 내용이 너무 깁니다.' : '복사할 내용이 없습니다.');
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle('program:shortcuts', async (event, programId, options = {}) => {
    assertGuideModeAllows(event, '프로그램 바로가기 만들기');
    if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.');
    const resolvedLaunch = resolveProgramLaunch(programId, options); programId = resolvedLaunch.programId; options = resolvedLaunch.options;
    const label = programLabel(programId);
    const shortcutLabel = safeShortcutLabel(label);
    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const systemIcons = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shell32.dll');
    const details = { target: executable, args: programShortcutArgs(programId, options), cwd: path.dirname(executable), description: `${label} 바로 실행`, icon: systemIcons, iconIndex: PROGRAM_ICON_INDEX[programId] || 0 };
    const paths = [];
    if (isSmokeTest && options.smoke) paths.push(shortcutPathInside(app.getPath('temp'), shortcutLabel, '-smoke'));
    if (options.desktop) paths.push(shortcutPathInside(app.getPath('desktop'), shortcutLabel));
    if (options.startMenu) { const directory = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CMOE Workspace'); await fs.promises.mkdir(directory, { recursive: true }); paths.push(shortcutPathInside(directory, shortcutLabel)); }
    const selectedDirectories = [...new Set(paths.map((shortcutPath) => path.dirname(shortcutPath)))];
    const legacyLabels = (LEGACY_PROGRAM_LABELS[programId] || []).map(safeShortcutLabel);
    for (const directory of selectedDirectories) {
      for (const legacyLabel of legacyLabels) {
        const legacyPath = shortcutPathInside(directory, legacyLabel, isSmokeTest && options.smoke ? '-smoke' : '');
        try { await fs.promises.unlink(legacyPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    paths.forEach((shortcutPath) => {
      const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create';
      if (!shell.writeShortcutLink(shortcutPath, operation, details)) throw new Error(`바로가기를 만들지 못했습니다: ${shortcutPath}`);
    });
    return { ok: true, paths };
  });
  ipcMain.handle('program:remove-shortcuts', async (event, programId) => {
    assertGuideModeAllows(event, '프로그램 바로가기 삭제');
    if (!isProgramId(programId)) throw new Error('알 수 없는 프로그램입니다.');
    programId = resolveProgramLaunch(programId).programId;
    const labels = [...new Set([programLabel(programId), ...(LEGACY_PROGRAM_LABELS[programId] || [])].map(safeShortcutLabel))];
    const paths = labels.flatMap((shortcutLabel) => isSmokeTest
      ? [shortcutPathInside(app.getPath('temp'), shortcutLabel, '-smoke')]
      : [shortcutPathInside(app.getPath('desktop'), shortcutLabel), shortcutPathInside(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CMOE Workspace'), shortcutLabel)]);
    for (const shortcutPath of paths) { try { await fs.promises.unlink(shortcutPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return { ok: true, paths };
  });
  ipcMain.handle('program:open-location', (event) => { assertGuideModeAllows(event, '설치 위치 열기'); shell.showItemInFolder(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath); return { ok: true }; });
  ipcMain.handle('extensions:list', () => extensionManager.list());
  ipcMain.handle('extensions:install', async (event) => {
    assertGuideModeAllows(event, '확장 프로그램 설치');
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'CMOE 확장', extensions: ['cmoe-extension'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, extension: await extensionManager.install(result.filePaths[0]) };
  });
  ipcMain.handle('extensions:remove-file', (event, extensionId) => { assertGuideModeAllows(event, '확장 프로그램 삭제'); return extensionManager.remove(extensionId); });
  ipcMain.handle('document-tools:capabilities', (_event, refresh) => runDocumentToolIpc(() => documentTools.publicCapabilities(Boolean(refresh))));
  ipcMain.handle('document-tools:cancel', (event, requestId) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 작업 중단');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.cancelJob(ownerId, requestId);
  }));
  ipcMain.handle('document-tools:pptx:choose', (event) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'PPTX 파일 선택');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.choosePptxFiles(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow);
  }));
  ipcMain.handle('document-tools:conversion:choose', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '변환할 문서 파일 선택');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseDocumentConversionFiles(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow, payload);
  }));
  ipcMain.handle('document-tools:conversion:targets', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 변환 형식 확인');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.getDocumentConversionTargets(ownerId, payload);
  }));
  ipcMain.handle('document-tools:output:choose', (event) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 저장 폴더 선택');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseOutputDirectory(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow);
  }));
  ipcMain.handle('document-tools:output:open', (event, outputToken) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 저장 폴더 열기');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.openOutputDirectory(ownerId, outputToken);
  }));
  ipcMain.handle('document-tools:output-file:open', (event, outputFileToken) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 결과 미리보기');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.openOutputFile(ownerId, outputFileToken);
  }));
  ipcMain.handle('document-tools:merge:choose', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '합칠 문서 선택');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseDocumentMergeFiles(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow, payload);
  }));
  ipcMain.handle('document-tools:merge:inspect', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '합칠 문서 확인');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.inspectDocumentMergeFiles(ownerId, payload);
  }));
  ipcMain.handle('document-tools:merge:run', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 파일 합치기');
    const ownerId = documentTools.registerOwner(event.sender);
    const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.mergeDocumentFiles(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'documentMerge' }, progress);
    });
  }));
  ipcMain.handle('document-tools:split:choose', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '나눌 문서 선택');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseDocumentSplitFile(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow, payload);
  }));
  ipcMain.handle('document-tools:split:run', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 파일 나누기');
    const ownerId = documentTools.registerOwner(event.sender);
    const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.splitDocumentFile(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'documentSplit' }, progress);
    });
  }));
  ipcMain.handle('document-tools:excel-deduplicate:choose', (event) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'Excel 중복 행 분석');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseExcelDeduplicateFile(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow);
  }));
  ipcMain.handle('document-tools:excel-deduplicate:analyze-criteria', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'Excel 기준 열 중복 분석');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.analyzeExcelDeduplicateCriteria(ownerId, payload);
  }));
  ipcMain.handle('document-tools:excel-deduplicate:review', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'Excel 중복 묶음 검토');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.analyzeExcelDeduplicateReview(ownerId, payload);
  }));
  ipcMain.handle('document-tools:excel-deduplicate:run', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'Excel 중복 행 정리');
    const ownerId = documentTools.registerOwner(event.sender);
    const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.runExcelDeduplicate(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'excelDeduplicate' }, progress);
    });
  }));
  ipcMain.handle('document-tools:excel-compare:choose', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'Excel 비교 파일 분석');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseExcelCompareFile(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow, payload);
  }));
  ipcMain.handle('document-tools:excel-compare:analyze', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'Excel 명단 비교·분류 분석');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.analyzeExcelComparePlan(ownerId, payload);
  }));
  ipcMain.handle('document-tools:excel-compare:run', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'Excel 명단 비교·분류');
    const ownerId = documentTools.registerOwner(event.sender); const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.runExcelCompareGroup(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'excelCompareGroup' }, progress);
    });
  }));
  ipcMain.handle('document-tools:pptx:convert', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'PPTX PDF 변환');
    const ownerId = documentTools.registerOwner(event.sender);
    const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.convertPptxBatch(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'pptxPdf' }, progress);
    });
  }));
  ipcMain.handle('document-tools:conversion:run', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 일괄 변환');
    const ownerId = documentTools.registerOwner(event.sender);
    const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.convertDocumentBatch(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'documentConversion' }, progress);
    });
  }));
  ipcMain.handle('document-tools:dependencies:prepare', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '문서 프로그램 자동 준비');
    const ownerId = documentTools.registerOwner(event.sender);
    const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.prepareDocumentDependencies(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'documentPreparation' }, progress);
    });
  }));
  ipcMain.handle('document-tools:font-file:install', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '정식 글꼴 파일 선택 및 설치');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseAndInstallUserFont(
      ownerId,
      BrowserWindow.fromWebContents(event.sender) || mainWindow,
      payload
    );
  }));
  ipcMain.handle('document-tools:certificate:choose-template', (event) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, 'PPTX 양식 선택');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.chooseCertificateTemplate(ownerId, BrowserWindow.fromWebContents(event.sender) || mainWindow);
  }));
  ipcMain.handle('document-tools:certificate:readiness', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '템플릿 문서 PDF 준비 상태 확인');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.inspectCertificateReadiness(ownerId, payload);
  }));
  ipcMain.handle('document-tools:certificate:choose-data', (event) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '템플릿 문서 데이터 파일 선택');
    return documentTools.chooseCertificateData(BrowserWindow.fromWebContents(event.sender) || mainWindow);
  }));
  ipcMain.handle('document-tools:certificate:preview', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '템플릿 문서 미리보기 생성');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.previewCertificate(ownerId, payload);
  }));
  ipcMain.handle('document-tools:certificate:generate', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '템플릿 문서 일괄 생성');
    const ownerId = documentTools.registerOwner(event.sender);
    const requestId = String(payload.requestId || '').slice(0, 80);
    return documentTools.generateCertificates(ownerId, payload, (progress) => {
      sendDocumentToolProgress(event, { requestId, kind: 'certificateMaker' }, progress);
    });
  }));
  ipcMain.handle('document-tools:certificate:profiles', () => runDocumentToolIpc(() => documentTools.listProfiles()));
  ipcMain.handle('document-tools:certificate:profile-open', (event, profileId) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '저장된 템플릿 양식 열기');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.openProfile(ownerId, profileId);
  }));
  ipcMain.handle('document-tools:certificate:profile-save', (event, payload = {}) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '템플릿 양식 저장');
    const ownerId = documentTools.registerOwner(event.sender);
    return documentTools.saveProfile(ownerId, payload);
  }));
  ipcMain.handle('document-tools:certificate:profile-delete', (event, profileId) => runDocumentToolIpc(() => {
    assertGuideModeAllows(event, '템플릿 양식 삭제');
    return documentTools.deleteProfile(profileId);
  }));
  ipcMain.handle('spreadsheet:choose', async (event) => {
    assertGuideModeAllows(event, 'Excel 파일 선택');
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const sheets = await readWorkbookSheets(result.filePaths[0]); const first = sheets[0] || { name: '', matrix: [] };
    return { canceled: false, filePath: result.filePaths[0], sheets, sheetName: first.name, matrix: first.matrix };
  });
  ipcMain.handle('spreadsheet:export', async (event, project) => {
    assertGuideModeAllows(event, 'Excel 파일 저장');
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: `${safeShortcutLabel(project?.name, '일정')}-일정.xlsx`, filters: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportProjectWorkbook(result.filePath, project);
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('spreadsheet:export-work-item', async (event, item) => {
    assertGuideModeAllows(event, '작업표 파일 저장');
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: `${safeShortcutLabel(item?.name, '명단 작업')}.xlsx`, filters: [{ name: 'Excel 통합 문서', extensions: ['xlsx'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await exportWorkItemWorkbook(result.filePath, item); return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('connection:config', (event, connectionId, config) => {
    assertGuideModeAllows(event, '계정 설정 저장');
    const type = String(config?.type || '').trim();
    const provider = type === 'zoom' ? 'zoom' : ['forms', 'drive', 'gmail'].includes(type) ? 'google' : '';
    if (!provider || String(config?.provider || '').trim() !== provider) throw new Error('지원하지 않는 계정 연결 종류입니다.');
    const bundledConfig = { provider, type, authMode: 'public-pkce' };
    return runConnectionProviderOperation(connectionId, () => connectionOperations.transition(connectionId, () => authManager.setConfig(connectionId, bundledConfig)), provider);
  });
  ipcMain.handle('connection:login-browsers', () => loginBrowserLauncher.list());
  ipcMain.handle('connection:login-browser-profiles', (_event, browserId) => loginBrowserLauncher.listProfiles(browserId));
  ipcMain.handle('connection:provider-status', (_event, type) => googleProviderOperations.run(type === 'zoom' ? 'zoom' : 'google', () => authManager.providerStatus(type)));
  ipcMain.handle('connection:status', (_event, connectionId) => runConnectionProviderOperation(connectionId, () => authManager.publicStatus(connectionId)));
  ipcMain.handle('connection:authorize', async (event, connectionId, options) => {
    assertGuideModeAllows(event, '계정 로그인');
    const authorizationRequestId = String(connectionId || '').trim();
    activeConnectionAuthorizationRequests.add(authorizationRequestId);
    try {
      return await runConnectionProviderOperation(connectionId, () => connectionOperations.transition(connectionId, async () => {
        try {
          if (queuedConnectionAuthorizationCancels.delete(authorizationRequestId)) return { cancelled: true };
          const authorizationPromise = authManager.authorize(connectionId, options);
          startedConnectionAuthorizationRequests.add(authorizationRequestId);
          if (queuedConnectionAuthorizationCancels.delete(authorizationRequestId)) {
            authManager.cancelAuthorization(connectionId, '사용자가 계정 로그인을 취소했습니다.');
          }
          const status = await authorizationPromise;
          return persistAuthorizedConnection(connectionId, status);
        } catch (error) {
          if (error?.code === 'AUTHORIZATION_CANCELLED') return { cancelled: true };
          throw error;
        }
      }));
    } catch (error) { return connectionIpcError(error, 'CONNECTION_AUTHORIZATION_FAILED'); }
    finally {
      activeConnectionAuthorizationRequests.delete(authorizationRequestId);
      startedConnectionAuthorizationRequests.delete(authorizationRequestId);
      queuedConnectionAuthorizationCancels.delete(authorizationRequestId);
    }
  });
  ipcMain.handle('connection:cancel-authorization', (event, connectionId) => {
    assertGuideModeAllows(event, '계정 로그인 취소');
    try {
      const authorizationRequestId = String(connectionId || '').trim();
      const cancelledActiveSession = authManager.cancelAuthorization(connectionId, '사용자가 계정 로그인을 취소했습니다.');
      const cancelledQueuedRequest = activeConnectionAuthorizationRequests.has(authorizationRequestId)
        && !startedConnectionAuthorizationRequests.has(authorizationRequestId);
      if (cancelledQueuedRequest) queuedConnectionAuthorizationCancels.add(authorizationRequestId);
      return {
        cancelled: cancelledActiveSession || cancelledQueuedRequest
      };
    } catch (error) { return connectionIpcError(error, 'CONNECTION_AUTHORIZATION_CANCEL_FAILED'); }
  });
  ipcMain.handle('connection:disconnect', (event, connectionId) => {
    assertGuideModeAllows(event, '계정 연결 해제');
    return runConnectionProviderOperation(connectionId, () => connectionOperations.transition(connectionId, async () => {
      const status = await authManager.disconnect(connectionId);
      return persistAuthorizedConnection(connectionId, status);
    }));
  });
  ipcMain.handle('connection:remove', async (event, connectionId) => {
    assertGuideModeAllows(event, '계정 설정 삭제');
    try {
      connectionOperations.invalidate(connectionId);
      authManager.cancelAuthorization(connectionId);
      await authManager.remove(connectionId);
      return { removed: true };
    } catch (error) { return connectionIpcError(error, 'CONNECTION_REMOVE_FAILED'); }
  });
  ipcMain.handle('forms:create-shell', (event, connectionId, definition, expectedIdentity) => runFormsIpc(event, 'Google 설문 생성', () => googleProviderOperations.run('google', () => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    OperationsCore.googleFormsApiRequests(definition);
    const normalizedDefinition = OperationsCore.normalizeGoogleFormDefinition(definition);
    return createGoogleFormShell((url, options) => authManager.request(connectionId, url, options), normalizedDefinition);
  }))));
  ipcMain.handle('forms:configure', (event, connectionId, formId, definition, _rendererRequests, requiredRevisionIdOrExpectedIdentity, maybeExpectedIdentity) => runFormsIpc(event, 'Google 설문 질문 구성', () => googleProviderOperations.run('google', () => connectionOperations.run(connectionId, async () => {
    const hasRevisionArgument = typeof requiredRevisionIdOrExpectedIdentity === 'string';
    const requiredRevisionId = hasRevisionArgument ? requiredRevisionIdOrExpectedIdentity.trim() : '';
    const expectedIdentity = hasRevisionArgument ? maybeExpectedIdentity : requiredRevisionIdOrExpectedIdentity;
    if (requiredRevisionId.length > 1_000 || /[\u0000-\u001f\u007f]/.test(requiredRevisionId)) {
      const error = new Error('Google 설문 수정 기준 정보가 올바르지 않습니다.');
      error.code = 'GOOGLE_FORM_REVISION_INVALID';
      throw error;
    }
    await assertExpectedConnection(connectionId, expectedIdentity);
    OperationsCore.googleFormsApiRequests(definition);
    const normalizedDefinition = OperationsCore.normalizeGoogleFormDefinition(definition);
    const trustedRequests = OperationsCore.googleFormsApiRequests(normalizedDefinition);
    return configureGoogleForm((url, options) => authManager.request(connectionId, url, options), formId, normalizedDefinition, trustedRequests, requiredRevisionId);
  }))));
  ipcMain.handle('forms:get', (event, connectionId, formIdOrUrl, expectedIdentity) => runFormsIpc(event, 'Google 설문 불러오기', () => googleProviderOperations.run('google', () => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    const formId = OperationsCore.googleFormIdFromInput(formIdOrUrl);
    if (!formId) {
      const error = new Error('Google 설문의 편집 주소 또는 Form ID를 확인해주세요.');
      error.code = 'GOOGLE_FORM_ID_INVALID';
      throw error;
    }
    const form = await authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${encodeURIComponent(formId)}`);
    return OperationsCore.googleFormDefinitionFromApi(form);
  }))));
  ipcMain.handle('forms:responses', (event, connectionId, formId, expectedIdentity) => runFormsIpc(event, 'Google 설문 응답 가져오기', () => googleProviderOperations.run('google', () => connectionOperations.run(connectionId, async () => {
    await assertExpectedConnection(connectionId, expectedIdentity);
    const normalizedFormId = OperationsCore.googleFormIdFromInput(formId);
    if (!normalizedFormId) throw new Error('응답을 가져올 Google Form ID가 올바르지 않습니다.');
    const id = encodeURIComponent(normalizedFormId);
    const formBefore = await authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${id}`);
    const responseData = await fetchAllFormResponses((url) => authManager.request(connectionId, url), normalizedFormId);
    const formAfter = await authManager.request(connectionId, `https://forms.googleapis.com/v1/forms/${id}`);
    const form = assertGoogleFormStableDuringResponseFetch(formBefore, formAfter);
    return { form, responses: responseData.responses, pagesFetched: responseData.pagesFetched };
  }))));
  ipcMain.handle('zoom:create', (event, connectionId, meeting, expectedIdentity) => guideModeOperationAllowed(event, 'Zoom 회의 생성') && connectionOperations.run(connectionId, async () => {
    assertGuideModeAllows(event, 'Zoom 회의 생성');
    await assertExpectedConnection(connectionId, expectedIdentity);
    const timezone = String(meeting?.timezone || 'Asia/Seoul').trim() || 'Asia/Seoul';
    const slot = {
      date: String(meeting?.date || '').trim(),
      endDate: String(meeting?.endDate || meeting?.date || '').trim(),
      startTime: String(meeting?.startTime || '').trim(),
      endTime: String(meeting?.endTime || '').trim()
    };
    const readiness = OperationsCore.zoomMeetingSlotReadiness(slot, timezone);
    const interval = readiness.interval;
    const duration = Number(meeting?.duration);
    if (!readiness.ready || !interval?.valid || !Number.isSafeInteger(duration) || duration <= 0 || duration !== interval.durationMinutes) {
      const error = new Error(readiness.message || 'Zoom 회의의 날짜·시간 또는 소요 시간이 프로젝트 일정과 일치하지 않습니다. 일정을 다시 확인해주세요.');
      error.code = 'ZOOM_MEETING_TIME_INVALID';
      throw error;
    }
    return authManager.request(connectionId, 'https://api.zoom.us/v2/users/me/meetings', jsonBody({
      topic: meeting.topic,
      type: 2,
      start_time: `${meeting.date}T${meeting.startTime}:00`,
      duration,
      timezone,
      agenda: meeting.agenda || '',
      settings: { waiting_room: true, join_before_host: false, mute_upon_entry: true }
    }));
  }));
  ipcMain.handle('gmail:create-draft', (event, connectionId, mail, expectedIdentity) => guideModeOperationAllowed(event, 'Gmail 초안 생성') && googleProviderOperations.run('google', () => connectionOperations.run(connectionId, async () => {
    assertGuideModeAllows(event, 'Gmail 초안 생성');
    await assertExpectedConnection(connectionId, expectedIdentity);
    return authManager.request(connectionId, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', jsonBody({ message: { raw: mimeDraft({ to: mail.email, subject: mail.subject, body: mail.body, bodyHtml: mail.bodyHtml }) } }));
  })));
  ipcMain.handle('gmail:update-draft', (event, connectionId, draftId, mail, expectedIdentity) => guideModeOperationAllowed(event, 'Gmail 초안 수정') && googleProviderOperations.run('google', () => connectionOperations.run(connectionId, async () => {
    assertGuideModeAllows(event, 'Gmail 초안 수정');
    await assertExpectedConnection(connectionId, expectedIdentity);
    return authManager.request(connectionId, `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, { ...jsonBody({ id: draftId, message: { raw: mimeDraft({ to: mail.email, subject: mail.subject, body: mail.body, bodyHtml: mail.bodyHtml }) } }), method: 'PUT' });
  })));
  ipcMain.handle('drive:push', (event, connectionId, _rendererState, expectedIdentity) => runDriveIpc(async () => {
    assertGuideModeAllows(event, 'Drive 업로드');
    const capturedRevision = mainDriveSyncRevision;
    const result = await googleProviderOperations.run('google', () => connectionOperations.run(connectionId, () => runDriveStateTransaction(() => uploadLatestWorkspaceStateToDrive(connectionId, expectedIdentity))));
    if (mainDriveSyncRevision === capturedRevision) mainDriveSyncDirty = false;
    mainDriveSyncError = null;
    return result;
  }));
  ipcMain.handle('drive:resolve-push', (event, connectionId, expectedIdentity, expectedWorkspaceIdentity, expectedRemoteIdentity) => runDriveIpc(async () => {
    assertGuideModeAllows(event, '이 PC 내용으로 Drive 충돌 해결');
    const capturedRevision = mainDriveSyncRevision;
    const result = await googleProviderOperations.run('google', () => connectionOperations.run(connectionId, () => runDriveStateTransaction(() => resolveLatchedDriveConflictWithLocal(connectionId, expectedIdentity, expectedWorkspaceIdentity, expectedRemoteIdentity))));
    if (mainDriveSyncRevision === capturedRevision) mainDriveSyncDirty = false;
    mainDriveSyncError = null;
    return result;
  }));
  ipcMain.handle('drive:pull', (event, connectionId, expectedIdentity) => runDriveIpc(async () => {
    guideModeOperationAllowed(event, 'Drive 자료 가져오기');
    return googleProviderOperations.run('google', () => connectionOperations.run(connectionId, () => runDriveStateTransaction(async () => {
    assertGuideModeAllows(event, 'Drive 자료 가져오기');
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
  }));
  ipcMain.handle('drive:apply-pull', (event, connectionId, pulledState, fileId, modifiedTime, expectedIdentity, expectedWorkspaceIdentity, etag, version) => runDriveIpc(async () => {
    guideModeOperationAllowed(event, 'Drive 자료 적용');
    return googleProviderOperations.run('google', () => connectionOperations.run(connectionId, () => runDriveStateTransaction(() => runWorkspaceStateTransaction(async () => {
    assertGuideModeAllows(event, 'Drive 자료 적용');
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
    if (!hasStableDriveReadIdentity({ fileId, modifiedTime, version })) {
      const error = new Error('가져온 Drive 데이터의 파일 ID·버전·수정 시각을 확인할 수 없어 적용을 중단했습니다.');
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
    if (!hasStableDriveReadIdentity(remoteFile)) {
      const error = new Error('Drive 데이터의 안정된 변경 버전을 확인하지 못해 불러오기를 중단했습니다. 잠시 후 다시 시도해주세요.');
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
  }));
}

app.setAppUserModelId('kr.co.cmoe.workspace');
app.on('before-quit', (event) => {
  if (quitReady) {
    isQuitting = true;
    return;
  }
  event.preventDefault();
  if (quitFlushInProgress) return;
  quitFlushInProgress = true;
  if (pendingUpdateLaunch) broadcastUpdateProgress({ stage: 'saving', message: '열린 작업과 메일 상태를 안전하게 저장하고 있습니다.', percent: 100 });
  documentTools?.requestShutdownDrain?.();
  const windows = [...new Set([mainWindow, ...programWindows.values(), ...rosterPickerWindows.values()].filter((window) => window && !window.isDestroyed()))];
  windows.forEach((window) => window.setEnabled(false));
  (async () => {
    const flushResults = await Promise.all(windows.map((window) => flushWorkspaceWindow(window, 15_000)));
    await withOperationTimeout(
      documentTools?.waitForIdle?.(), 30 * 60_000,
      '문서 변환이 아직 진행 중이라 종료를 취소했습니다. 작업이 끝난 뒤 다시 종료해주세요.',
      'QUIT_DOCUMENT_TOOLS_TIMEOUT'
    );
    await withOperationTimeout(
      gmailFlowHost?.flushMailQueue?.(), 90_000,
      '메일 작업이 아직 진행 중이라 종료를 취소했습니다. 작업이 끝난 뒤 다시 종료해주세요.',
      'QUIT_MAIL_DRAIN_TIMEOUT'
    );
    let mainDriveError = null;
    try {
      await withOperationTimeout(
        flushMainDriveStateSync(), 5_000,
        'Google Drive 동기화가 아직 완료되지 않았습니다.',
        'QUIT_DRIVE_SYNC_TIMEOUT'
      );
    } catch (error) {
      mainDriveSyncError = error;
      mainDriveError = error;
    }
    const remoteWarnings = collectRemoteSyncWarnings(flushResults, mainDriveError);
    if (remoteWarnings.length) {
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : windows.find((window) => !window.isDestroyed());
      await showRemoteSyncPendingWarning(parent, remoteWarnings).catch(console.error);
    }
    if (pendingUpdateLaunch) {
      broadcastUpdateProgress({ stage: 'backup-local', message: '사용자 자료의 로컬 안전 백업을 만들고 있습니다.', percent: 100 });
      const backup = await backupWorkspacePersistentData(pendingUpdateLaunch.expectedVersion);
      pendingUpdateLaunch.backupPath = backup.snapshotPath;
      const updateState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
      if (updateState.preferences.storageMode === 'drive') {
        broadcastUpdateProgress({ stage: 'backup-cloud', message: 'Google Drive 안전 백업을 만들고 있습니다.', percent: 100 });
        const cloudBackup = await withOperationTimeout(
          createWorkspaceCloudBackup(pendingUpdateLaunch.expectedVersion, { recordState: false }), 5 * 60_000,
          'Google Drive 업데이트 백업이 완료되지 않아 업데이트를 취소했습니다.',
          'UPDATE_CLOUD_BACKUP_TIMEOUT'
        );
        pendingUpdateLaunch.cloudBackupFile = cloudBackup.name;
      }
      broadcastUpdateProgress({ stage: 'installing', message: '백업이 완료되었습니다. 앱을 종료하고 업데이트를 설치합니다.', percent: 100 });
      await UpdateHelperLauncher.launchUpdateHelper(pendingUpdateLaunch);
      pendingUpdateLaunch = null;
    }
    quitReady = true; isQuitting = true; app.quit();
  })().catch((error) => {
    quitFlushInProgress = false; isQuitting = false;
    documentTools?.resumeAfterShutdownAbort?.();
    void gmailFlowHost?.resumeMailQueue?.().catch(console.error);
    windows.forEach((window) => { if (!window.isDestroyed()) window.setEnabled(true); });
    if (pendingUpdateLaunch) {
      broadcastUpdateProgress({ stage: 'error', message: error?.message || '업데이트 전에 작업을 저장하지 못했습니다.', percent: 100 });
      pendingUpdateLaunch = null;
    }
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    void dialog.showMessageBox(parent, { type: 'warning', title: '변경사항 저장 필요', message: '아직 저장하지 못한 변경사항이 있어 앱을 종료하지 않았습니다.', detail: error?.message || '잠시 후 다시 시도해주세요.' });
  });
});
app.on('activate', () => { if (!mainWindow && !programWindows.size) showWindow(); });
app.on('second-instance', (_event, argv) => {
  const programId = requestedProgram(argv);
  if (programId) createProgramWindow(programId, { projectId: requestedProjectId(argv), documentMode: requestedDocumentMode(argv) });
  else { if (mainWindow?.isMinimized()) mainWindow.restore(); showWindow(); }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const userDataPath = app.getPath('userData');
  const versionMarkerPath = path.join(userDataPath, 'installed-version.json');
  const startedAfterUpdate = process.argv.includes('--updated');
  if (app.isPackaged && !isSmokeTest) {
    let previousVersion = '';
    try { previousVersion = String(JSON.parse(await fs.promises.readFile(versionMarkerPath, 'utf8'))?.version || ''); } catch (error) { if (error.code !== 'ENOENT') console.warn('이전 실행 버전 표시를 읽지 못했습니다.', error); }
    const hasPersistentData = workspacePersistentBackupEntries().some((entry) => fs.existsSync(entry.source));
    if (hasPersistentData && previousVersion !== app.getVersion()) await backupWorkspacePersistentData(app.getVersion());
  }
  if (isSmokeTest) {
    for (const name of ['workspace-data.json', 'workspace-data.json.bak', 'workspace-credentials.json', 'workspace-credentials.json.bak']) {
      try { await fs.promises.unlink(path.join(userDataPath, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  storage = new JsonStorage(path.join(userDataPath, 'workspace-data.json'), (changes) => {
    const next = changes.workspaceState?.newValue;
    if (next) {
      broadcastState(next);
      markMainDriveStateDirty(next);
      const previous = changes.workspaceState?.oldValue;
      if (workspaceGmailIdentityFingerprint(previous) !== workspaceGmailIdentityFingerprint(next)) gmailFlowHost?.notifyWorkspaceIdentityChanged(next);
    }
  });
  driveSyncGuards = new DriveSyncGuardStore(storage);
  const credentialProtection = createSafeStorageCredentialProtection(safeStorage);
  loginBrowserLauncher = createLoginBrowserLauncher({
    shell,
    getOwnerWindowHandle: activeBrowserPickerWindowHandle,
    applicationPickerScriptPath: app.isPackaged
      ? path.join(process.resourcesPath, 'browser-tools', 'url-application-picker.ps1')
      : path.join(__dirname, 'url-application-picker.ps1')
  });
  authManager = new AuthManager({
    filePath: path.join(userDataPath, 'workspace-credentials.json'),
    openExternal: (url, context) => loginBrowserLauncher.open(url, context),
    protect: credentialProtection.protect,
    unprotect: credentialProtection.unprotect,
    clientDefaults: { googleClientId: GOOGLE_DESKTOP_PUBLIC_CLIENT_ID, googleClientSecret: GOOGLE_DESKTOP_CLIENT_SECRET, zoomPublicClientId: ZOOM_PUBLIC_CLIENT_ID }
  });
  driveWorkspaceClient = new DriveWorkspaceClient(authManager);
  await authManager.migrateProtectionIfNeeded();
  await googleProviderOperations.run('google', () => authManager.reconcileGoogleConnectionCredentials());
  await googleProviderOperations.run('google', () => reconcilePersistedGoogleConnections());
  await googleProviderOperations.run('zoom', () => authManager.reconcileZoomConnectionCredentials());
  await googleProviderOperations.run('zoom', () => reconcilePersistedZoomConnections());
  extensionManager = new ExtensionManager({ bundledPath: path.join(__dirname, '..', 'extensions'), userPath: path.join(userDataPath, 'extensions') });
  documentTools = new DocumentTools({ dialog, shell, userDataPath });
  const gmailFlowRoot = app.isPackaged ? path.join(process.resourcesPath, 'gmail-flow') : path.join(__dirname, '..', '..');
  const workspaceGmailIdentity = new WorkspaceGmailIdentity({
    clientId: authManager.providerCredentials('google')?.clientId || GOOGLE_DESKTOP_PUBLIC_CLIENT_ID,
    resolveConnection: resolveWorkspaceGmailConnection,
    ensureConnection: ensureWorkspaceGmailConnection,
    connectionStatus: async (connectionId) => authManager.publicStatus(connectionId),
    hasScopes: async (connectionId, scopes) => authManager.hasScopes(connectionId, scopes),
    authorizeConnection: authorizeWorkspaceGmailConnection,
    getConnectionToken: (connectionId, scopes) => connectionOperations.run(connectionId, () => authManager.getToken(connectionId, scopes)),
    disconnectConnection: disconnectWorkspaceGmailConnection,
    invalidateConnectionToken: (connectionId) => connectionOperations.transition(connectionId, () => authManager.invalidateAccessToken(connectionId))
  });
  gmailFlowHost = new GmailFlowHost({ app, BrowserWindow, ipcMain, safeStorage, shell, rootPath: gmailFlowRoot, showWindow: () => createProgramWindow('gmailFlow'), isSmokeTest, googleOAuthCredentials: authManager.providerCredentials('google'), loginBrowserLauncher, workspaceIdentity: workspaceGmailIdentity });
  runGmailFlowIdentityOperation = gmailFlowHost.runCloudIdentityOperation;
  const runCoordinatedGmailFlowIdentityOperation = (operation) => googleProviderOperations.run('google', () => runGmailFlowIdentityOperation(operation));
  runCoordinatedGmailFlowIdentityOperation.drain = () => googleProviderOperations.run('google', () => runGmailFlowIdentityOperation.drain());
  gmailFlowHost.runCloudIdentityOperation = runCoordinatedGmailFlowIdentityOperation;
  await gmailFlowHost.initialize();
  const storedWorkspaceState = await storage.get('workspaceState', null);
  const preMigrationState = WorkspaceCore.normalizeState(storedWorkspaceState);
  if (JSON.stringify(storedWorkspaceState) !== JSON.stringify(preMigrationState)) await storage.set('workspaceState', preMigrationState);
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
  const startupWorkspaceState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null));
  if (startupWorkspaceState.preferences.storageMode === 'drive') markMainDriveStateDirty(startupWorkspaceState);
  const initialProgram = requestedProgram();
  if (app.isPackaged && !isSmokeTest) {
    if (startedAfterUpdate) {
      try {
        await repairInstalledAppShortcuts({
          appPath: process.execPath,
          desktopPath: app.getPath('desktop'),
          appDataPath: app.getPath('appData'),
          shellApi: shell
        });
      } catch (error) {
        // A locked .lnk must not prevent the newly installed app from opening.
        // The NSIS hook already performed the first repair attempt.
        console.warn('업데이트된 바로가기를 다시 만들지 못했습니다.', error);
      }
    }
    await fs.promises.writeFile(versionMarkerPath, `${JSON.stringify({ version: app.getVersion(), executablePath: process.execPath, confirmedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }
  if (initialProgram && !isSmokeTest) createProgramWindow(initialProgram, { projectId: requestedProjectId(), documentMode: requestedDocumentMode() }); else createWindow();

  if (isSmokeTest) {
    writeSmokeResult('running', { step: 'started' });
    // The interactive catalog intentionally walks every reviewed guide step.
    // Keep enough headroom as the catalog grows so a complete UI audit is not
    // mistaken for a hung renderer on slower or packaged Windows machines.
    const smokeTimeoutMs = app.isPackaged ? 420_000 : 360_000;
    const timeout = setTimeout(() => {
      console.error('Workspace smoke test timed out.');
      writeSmokeResult('timeout', { step: 'global-timeout', failedAfterStep: lastSmokeStep, timeoutMs: smokeTimeoutMs });
      isQuitting = true;
      app.exit(1);
    }, smokeTimeoutMs);
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const waitFor = async (predicate, label, timeout = ${app.isPackaged ? 12000 : 5000}) => {
              const end = Date.now() + timeout;
              while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
              if (!predicate()) throw new Error('timeout: ' + label);
            };
            const assert = (condition, label) => { if (!condition) throw new Error(label); };
            await waitFor(() => document.querySelector('#newProjectButton'), 'app ready');
            const updateDialog = document.querySelector('#appUpdateDialog');
            const updateProgress = document.querySelector('#appUpdateDialogProgress');
            assert(updateDialog && updateProgress && document.querySelector('#cancelAppUpdateDialog') && document.querySelector('#closeAppUpdateDialog'), 'global update progress dialog controls must exist');
            updateDialog.showModal(); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const updateDialogRect = updateDialog.getBoundingClientRect();
            assert(updateDialogRect.width > 300 && updateDialogRect.left >= 0 && updateDialogRect.right <= innerWidth, 'global update progress dialog must fit in the window');
            updateDialog.close();
            assert(document.querySelector('#dashboardEmpty h1')?.textContent.includes('어떤 작업'), 'first-use choice should be understandable');
            assert(document.querySelector('[data-nav="modules"]')?.textContent.includes('추가 프로그램'), 'navigation should use user-facing names');
            const plusTile = document.querySelector('#dashboardEmpty .empty-illustration[data-open-new-project]');
            assert(plusTile?.tagName === 'BUTTON' && plusTile.type === 'button' && plusTile.getAttribute('aria-label') === '새 프로젝트 만들기', 'dashboard plus tile must be an accessible project creation button');
            plusTile.click();
            await waitFor(() => document.querySelector('#newProjectDialog').open, 'plus tile project dialog');
            assert(document.querySelector('#newProjectDialog').contains(document.activeElement), 'plus tile project dialog receives keyboard focus');
            assert(document.querySelector('#projectName').value === '' && document.querySelector('#newProjectTemplateId').value === 'template-blank', 'plus tile uses the same reset project creation flow');
            document.querySelector('#newProjectTemplatePicker input[value="template-education"]').click();
            const startSteps = document.querySelector('#newProjectWorkflowDetails'); startSteps.open = true;
            const startStepType = document.querySelector('#newProjectWorkflowStepType');
            assert([...startStepType.options].some((option) => option.value === 'documentEditor') && ![...startStepType.options].some((option) => option.value === 'pptxPdf' || option.value === 'certificateMaker'), 'new project step picker exposes one unified document editor');
            startStepType.value = 'documentEditor'; document.querySelector('#addNewProjectWorkflowStep').click();
            assert(document.querySelector('[data-new-project-workflow-step]') && [...document.querySelectorAll('#newProjectStepPreview span')].some((item) => item.textContent.includes('문서 편집')), 'new project workflow preview includes the unified document editor');
            document.querySelector('#projectName').value = 'Smoke Project A';
            document.querySelector('#newProjectForm').requestSubmit();
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project A', 'first project');
            const firstProjectState = await globalThis.workspaceDesktop.loadState(); const firstProject = firstProjectState.projects.find((project) => project.id === firstProjectState.activeProjectId);
            assert(firstProject.workflow.some((step) => step.moduleId === 'documentEditor'), 'unified document editor persists in the newly created project workflow');
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
            assert(document.querySelector('.roster-editor-guide')?.textContent.includes('드래그로 범위 선택 · 우클릭 셀 작업 · Ctrl+C/V'), 'persistent roster spreadsheet guide');
            const sheetChoiceCancelProbe = document.querySelector('#sheetChoiceDialog'); sheetChoiceCancelProbe.showModal(); sheetChoiceCancelProbe.dispatchEvent(new Event('cancel', { cancelable: true })); assert(!sheetChoiceCancelProbe.open, 'sheet chooser Escape resolves and closes instead of leaving its workflow pending');
            const projectBInitialState = await globalThis.workspaceDesktop.loadState(); const projectBId = projectBInitialState.activeProjectId; const projectBInitial = projectBInitialState.projects.find((project) => project.id === projectBId);
            assert(projectBInitial.data.columns.length === 0 && projectBInitial.data.people.length === 0, 'new project roster starts without columns or people');
            assert(document.querySelectorAll('#rosterEditorTable tbody input').length === 0 && document.querySelector('[data-empty-roster-paste-anchor="true"]'), 'zero-column inline roster has a non-editable paste target and no input cells');
            assert(document.querySelector('#rosterCellValue').disabled && document.querySelector('#rosterCellAddress').textContent === '—' && document.querySelector('#rosterSelectionStatus').textContent === '선택 없음' && !document.querySelector('#rosterEditorTable [data-sheet-row][data-sheet-col], #rosterEditorTable [data-select-roster-all]'), 'zero-column inline roster has no editable formula target or phantom selection');
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
              const target = cell.querySelector('input') || cell; const rect = target.getBoundingClientRect(); target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: rect.left + 4, clientY: rect.top + 4 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: rect.left + 4, clientY: rect.top + 4 }));
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
            const scheduleColumnsBeforeCancel = document.querySelectorAll('#scheduleBoard [data-schedule-rename-column]').length; document.querySelector('[data-schedule-add-column-inline]').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'schedule column name cancel dialog'); document.querySelector('#nameInputDialog').dispatchEvent(new Event('cancel', { cancelable: true })); await waitFor(() => !document.querySelector('#nameInputDialog').open, 'schedule column name cancel resolves'); assert(document.querySelectorAll('#scheduleBoard [data-schedule-rename-column]').length === scheduleColumnsBeforeCancel, 'name dialog Escape leaves schedule columns unchanged');
            document.querySelector('[data-schedule-add-column-inline]').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'new-project schedule column dialog'); document.querySelector('#nameInputValue').value = '검증 메모'; document.querySelector('#nameInputForm').requestSubmit();
            await waitFor(() => [...document.querySelectorAll('#scheduleBoard [data-schedule-rename-column]')].some((button) => button.textContent === '검증 메모'), 'new-project schedule column added');
            projectB = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === projectBId); const projectBColumn = projectB.data.scheduleSheetColumns.find((column) => column.name === '검증 메모');
            assert(projectB.data.scheduleSheetInitialized && projectBColumn, 'new-project schedule sheet initialization and added column persist');
            const projectBHeader = [...document.querySelectorAll('#scheduleBoard [data-schedule-row="-1"]')].find((cell) => cell.querySelector('[data-schedule-rename-column]')?.textContent === '검증 메모'); projectBHeader.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const scheduleFormula = document.querySelector('#scheduleCellValue'); scheduleFormula.focus(); scheduleFormula.value = '검증 메모 수정'; scheduleFormula.dispatchEvent(new Event('input', { bubbles: true })); scheduleFormula.blur(); await globalThis.flushWorkspaceEdits();
            projectB = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === projectBId); assert(projectB.data.scheduleSheetColumns.some((column) => column.id === projectBColumn.id && column.name === '검증 메모 수정'), 'schedule formula-bar header rename persists');
            const projectBRemove = document.querySelector('#scheduleBoard [data-schedule-remove-column="' + projectBColumn.id + '"]'); assert(projectBRemove, 'renamed new-project schedule column keeps its remove action'); projectBRemove.click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'new-project schedule column remove cancel probe'); document.querySelector('#confirmDialog').dispatchEvent(new Event('cancel', { cancelable: true })); await waitFor(() => !document.querySelector('#confirmDialog').open, 'confirm dialog Escape resolves'); assert(document.querySelector('#scheduleBoard [data-schedule-remove-column="' + projectBColumn.id + '"]'), 'confirm dialog Escape leaves the column unchanged'); document.querySelector('#scheduleBoard [data-schedule-remove-column="' + projectBColumn.id + '"]').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'new-project schedule column remove confirm'); document.querySelector('#confirmAction').click();
            await waitFor(() => ![...document.querySelectorAll('#scheduleBoard [data-schedule-rename-column]')].some((button) => button.textContent === '검증 메모 수정'), 'new-project schedule column removed');
            await globalThis.flushWorkspaceEdits();
            projectB = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === projectBId); assert(!projectB.data.scheduleSheetColumns.some((column) => column.id === projectBColumn.id), 'new-project schedule column removal persists');
            document.querySelector('#page-schedule [data-nav-link="dashboard"]').click();
            const switcher = document.querySelector('#projectSwitcher');
            assert(switcher.options.length === 2, 'project switcher should list two projects');
            switcher.value = [...switcher.options].find((option) => option.textContent.includes('Project A')).value;
            switcher.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === 'Smoke Project A', 'project switch');
            document.querySelector('#projectSettingsButton').click(); await waitFor(() => document.querySelector('#projectSettingsDialog').open, 'project settings');
            assert(!document.querySelector('[data-default-connection-type="drive"]'), 'Workspace Drive sync must not be presented as a project default');
            assert(document.querySelector('#settingsParticipantMinLabel').textContent.includes('배정 인원') && document.querySelector('#settingsCoachRequiredRow').hidden, 'project quick settings use the actual generic role and hide unavailable facilitator settings');
            document.querySelector('#settingsParticipantMin').value = '2'; document.querySelector('#settingsParticipantMax').value = '2'; document.querySelector('#projectSettingsForm').requestSubmit(); await waitFor(() => !document.querySelector('#projectSettingsDialog').open, 'project role quick settings saved');
            let projectSettingsState = await globalThis.workspaceDesktop.loadState(); let projectSettingsProject = projectSettingsState.projects.find((project) => project.id === projectSettingsState.activeProjectId); assert(projectSettingsProject.data.roles[0].minPerSession === 2 && projectSettingsProject.data.roles[0].maxPerSession === 2 && projectSettingsProject.settings.participantMin === 2 && projectSettingsProject.settings.participantMax === 2, 'project quick settings update the canonical role used by schedule generation');
            document.querySelector('#projectSettingsButton').click(); await waitFor(() => document.querySelector('#projectSettingsDialog').open, 'project settings reopen'); document.querySelector('#settingsParticipantMin').value = '1'; document.querySelector('#settingsParticipantMax').value = '1'; document.querySelector('#settingsDuration').value = '90'; document.querySelector('#settingsChangeApproval').checked = false; document.querySelector('#projectSettingsForm').requestSubmit();
            await waitFor(() => !document.querySelector('#projectSettingsDialog').open, 'project settings saved'); projectSettingsState = await globalThis.workspaceDesktop.loadState(); projectSettingsProject = projectSettingsState.projects.find((project) => project.id === projectSettingsState.activeProjectId); assert(projectSettingsProject.data.roles[0].minPerSession === 1 && projectSettingsProject.data.roles[0].maxPerSession === 1, 'project quick role test restores the schedule defaults');
            document.querySelector('[data-nav="settings"]').click(); await waitFor(() => document.querySelector('#page-settings').classList.contains('active'), 'settings page');
            const settingsPage = document.querySelector('#page-settings');
            assert(!settingsPage.querySelector('.connection-admin-settings, [data-google-oauth-admin-import], [data-google-oauth-admin-reset], #googleOAuthAdminStatus, #resetGoogleOAuthDefault'), 'settings never expose Google OAuth administrator controls');
            assert(!/최초 1회|최초1회|관리자용 연결 설정|OAuth JSON|Google Cloud|Client Secret|Client ID/i.test(settingsPage.innerText), 'settings use no OAuth setup language for first-time users');
            assert(typeof globalThis.workspaceDesktop.importGoogleOAuthCredentials === 'undefined' && typeof globalThis.workspaceDesktop.resetGoogleOAuthCredentials === 'undefined', 'renderer bridge exposes no runtime OAuth configuration import or reset API');
            assert(document.querySelector('#workspaceDriveConnection')?.disabled && document.querySelector('#pushDriveState')?.disabled, 'local mode with no Drive account disables the global push action');
            assert(document.querySelector('#driveSyncStatus')?.textContent.includes('계정 연결'), 'local Drive push state gives an actionable account prompt');
            document.querySelector('[data-nav="dashboard"]').click();
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
            const workflowStepCountBeforeAdd = document.querySelectorAll('#workflowEditorList [data-workflow-editor-step]').length;
            document.querySelector('#workflowStepType').value = 'aiReview'; document.querySelector('#addWorkflowStep').click();
            assert(document.querySelectorAll('#workflowEditorList [data-workflow-editor-step]').length === workflowStepCountBeforeAdd + 1, 'workflow step added');
            document.querySelector('#workflowEditorForm').requestSubmit();
            await waitFor(() => !document.querySelector('#workflowEditorDialog').open && document.querySelectorAll('#workflowGrid .workflow-card').length === workflowStepCountBeforeAdd + 1, 'workflow editor saved');
            document.querySelector('[data-workflow-open="people"]').click();
            await waitFor(() => document.querySelector('#page-people').classList.contains('active'), 'people page');
            assert(document.querySelector('#page-people h1')?.textContent === '명단', 'people page purpose label');
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
            const tombstoneProbe = await globalThis.workspaceDesktop.saveSharedRoster({ name: '삭제 tombstone 검증', columns: [{ id: 'probe-name', name: '이름', role: 'variable', workspaceType: 'name' }], rows: [{ 'probe-name': '검증 사용자' }] });
            const tombstoneProbeId = tombstoneProbe.roster.id;
            assert((await globalThis.workspaceDesktop.deleteSharedRoster(tombstoneProbeId)).deleted, 'existing shared roster deletion reports a real deletion');
            const tombstoneState = await globalThis.workspaceDesktop.loadState();
            assert(tombstoneState.knownLibraryIds.includes(tombstoneProbeId) && tombstoneState.deletedLibraryIds.includes(tombstoneProbeId) && !tombstoneState.library.rosters.some((roster) => roster.id === tombstoneProbeId), 'shared roster deletion persists known/deleted tombstones in the same commit');
            const missingProbeId = 'missing-roster-must-not-tombstone';
            assert(!(await globalThis.workspaceDesktop.deleteSharedRoster(missingProbeId)).deleted && !(await globalThis.workspaceDesktop.loadState()).deletedLibraryIds.includes(missingProbeId), 'missing shared roster deletion never creates a tombstone');
            await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '2', 'shared roster reflected in workspace');
            await waitFor(() => document.querySelectorAll('#rosterEditorTable tbody [data-sheet-row] input').length >= 6, 'inline roster rows rendered');
            const rosterTable = document.querySelector('#rosterEditorTable');
            const rosterDragStart = rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"]');
            const rosterDragEnd = rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="1"]');
            rosterDragEnd.scrollIntoView({ block: 'center', inline: 'center' });
            const rosterEndRect = rosterDragEnd.querySelector('input').getBoundingClientRect();
            const dragFromInputTo = (startCell, endCell) => { const startInput = startCell.querySelector('input'); const startRect = startInput.getBoundingClientRect(); const targetRect = endCell.querySelector('input').getBoundingClientRect(); startInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: startRect.left + 5, clientY: startRect.top + 5 })); startInput.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: targetRect.left + 5, clientY: targetRect.top + 5, cancelable: true })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: targetRect.left + 5, clientY: targetRect.top + 5 })); };
            const clickRosterCell = (cell, shiftKey = false) => { const input = cell.querySelector('input'); const rect = input.getBoundingClientRect(); input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, shiftKey, clientX: rect.left + 5, clientY: rect.top + 5 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: rect.left + 5, clientY: rect.top + 5 })); };
            dragFromInputTo(rosterDragStart, rosterDragEnd);
            const rosterDragHit = document.elementFromPoint(rosterEndRect.left + 5, rosterEndRect.top + 5)?.closest?.('[data-sheet-row][data-sheet-col]');
            assert(document.querySelector('#rosterSelectionStatus').textContent === 'A2:B3' && rosterTable.querySelectorAll('.sheet-selected').length === 4 && !rosterTable.classList.contains('range-selecting'), 'roster input-origin drag selects a rectangular range and releases drag mode: ' + JSON.stringify({ status: document.querySelector('#rosterSelectionStatus').textContent, selected: rosterTable.querySelectorAll('.sheet-selected').length, hit: rosterDragHit ? [rosterDragHit.dataset.sheetRow, rosterDragHit.dataset.sheetCol] : null }));
            clickRosterCell(rosterDragStart); clickRosterCell(rosterDragEnd, true);
            assert(document.querySelector('#rosterSelectionStatus').textContent === 'A2:B3', 'roster Shift selection preserves the anchor');
            const rosterContextInput = rosterDragEnd.querySelector('input'); const rosterContextRect = rosterContextInput.getBoundingClientRect(); rosterContextInput.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rosterContextRect.left + 6, clientY: rosterContextRect.top + 6 })); const rosterContextMenu = document.querySelector('#sheetContextMenu'); const rosterContextBounds = rosterContextMenu.getBoundingClientRect(); assert(!rosterContextMenu.hidden && rosterContextMenu.dataset.sheetKind === 'roster' && rosterContextMenu.querySelector('[data-sheet-context-action="clear"]') && rosterContextBounds.left >= 0 && rosterContextBounds.right <= innerWidth && rosterContextBounds.top >= 0 && rosterContextBounds.bottom <= innerHeight && document.querySelector('#rosterSelectionStatus').textContent === 'A2:B3', 'roster right-click menu opens inside the viewport without losing the selected range'); rosterContextMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); assert(rosterContextMenu.hidden, 'roster right-click menu closes with Escape');
            const rosterCopy = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: rosterCopy, bubbles: true, cancelable: true }));
            assert(rosterCopy.getData('text/plain') === '송아라\\tone@example.com\\r\\n조민지\\ttwo@example.com', 'roster range copy exports TSV');
            assert(['rosterUndo', 'rosterRedo', 'rosterClearSelection', 'rosterFillDown', 'rosterInsertRow', 'rosterDeleteRows', 'rosterInsertColumn', 'rosterDeleteColumns'].every((id) => document.getElementById(id)), 'inline roster sheet tools are visible');
            const selectRosterRange = (startRow, startCol, endRow = startRow, endCol = startCol) => { const start = rosterTable.querySelector('[data-sheet-row="' + startRow + '"][data-sheet-col="' + startCol + '"]'); const end = rosterTable.querySelector('[data-sheet-row="' + endRow + '"][data-sheet-col="' + endCol + '"]'); end.scrollIntoView({ block: 'center', inline: 'center' }); dragFromInputTo(start, end); };
            selectRosterRange(2, 1, 1, 0); const rosterBackwardPaste = new DataTransfer(); rosterBackwardPaste.setData('text/plain', '좌상\\t우상\\n좌하\\t우하'); rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="1"] input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: rosterBackwardPaste, bubbles: true, cancelable: true })); await waitFor(() => rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input')?.value === '좌상' && rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="1"] input')?.value === '우하', 'roster structured paste starts at selection top-left'); document.querySelector('#rosterUndo').click(); await waitFor(() => rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input')?.value === '송아라' && rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="1"] input')?.value === 'two@example.com', 'roster backward paste undo');
            selectRosterRange(1, 0, 2, 1); const rosterRangeFill = new DataTransfer(); rosterRangeFill.setData('text/plain', '범위 채움'); rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: rosterRangeFill, bubbles: true, cancelable: true }));
            await waitFor(() => [1, 2].every((row) => [0, 1].every((col) => rosterTable.querySelector('[data-sheet-row="' + row + '"][data-sheet-col="' + col + '"] input')?.value === '범위 채움')), 'roster single-value range fill'); await globalThis.flushWorkspaceEdits();
            let rosterToolState = await globalThis.workspaceDesktop.loadState(); let rosterToolProject = rosterToolState.projects.find((project) => project.id === rosterToolState.activeProjectId); assert(rosterToolProject.data.people.slice(0, 2).every((person) => person.values['smoke-name'] === '범위 채움' && person.values['smoke-email'] === '범위 채움'), 'roster range fill persists');
            document.querySelector('#rosterUndo').click(); await waitFor(() => rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input')?.value === '송아라' && rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="1"] input')?.value === 'two@example.com', 'roster range fill undo'); await globalThis.flushWorkspaceEdits();
            selectRosterRange(1, 0, 2, 0); document.querySelector('#rosterFillDown').click(); await waitFor(() => rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="0"] input')?.value === '송아라', 'roster fill down'); await globalThis.flushWorkspaceEdits(); document.querySelector('#rosterUndo').click(); await waitFor(() => rosterTable.querySelector('[data-sheet-row="2"][data-sheet-col="0"] input')?.value === '조민지', 'roster fill down undo');
            selectRosterRange(1, 0, 2, 1); document.querySelector('#rosterClearSelection').click(); await waitFor(() => [1, 2].every((row) => [0, 1].every((col) => rosterTable.querySelector('[data-sheet-row="' + row + '"][data-sheet-col="' + col + '"] input')?.value === '')), 'roster clear selection'); document.querySelector('#rosterUndo').click(); await waitFor(() => rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input')?.value === '송아라', 'roster clear undo');
            clickRosterCell(rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"]')); document.querySelector('#rosterInsertRow').click(); await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '3', 'roster insert row'); document.querySelector('#rosterUndo').click(); await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '2', 'roster insert row undo');
            let rosterRowSelector = rosterTable.querySelector('[data-select-roster-row="2"]'); rosterRowSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); document.querySelector('#rosterDeleteRows').click(); await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '1', 'roster delete row'); document.querySelector('#rosterUndo').click(); await waitFor(() => document.querySelector('#rosterPeopleMetric')?.textContent === '2', 'roster delete row undo');
            clickRosterCell(rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"]')); document.querySelector('#rosterInsertColumn').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'roster insert column dialog'); document.querySelector('#nameInputValue').value = '검증 삽입열'; document.querySelector('#nameInputForm').requestSubmit(); await waitFor(() => document.querySelector('#rosterColumnMetric')?.textContent === '4', 'roster insert column'); document.querySelector('#rosterUndo').click(); await waitFor(() => document.querySelector('#rosterColumnMetric')?.textContent === '3', 'roster insert column undo');
            const rosterColumnSelector = rosterTable.querySelector('[data-select-roster-column="2"]'); rosterColumnSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); assert(rosterColumnSelector.classList.contains('sheet-selector-selected'), 'roster column selector'); document.querySelector('#rosterDeleteColumns').click(); await waitFor(() => document.querySelector('#rosterColumnMetric')?.textContent === '2', 'roster delete column'); document.querySelector('#rosterUndo').click(); await waitFor(() => document.querySelector('#rosterColumnMetric')?.textContent === '3', 'roster delete column undo'); await globalThis.flushWorkspaceEdits();
            rosterToolState = await globalThis.workspaceDesktop.loadState(); rosterToolProject = rosterToolState.projects.find((project) => project.id === rosterToolState.activeProjectId); assert(rosterToolProject.data.people.length === 2 && rosterToolProject.data.columns.length === 3 && rosterToolProject.data.people[0].name === '송아라' && rosterToolProject.data.people[1].name === '조민지', 'roster sheet action undos persist the original roster');
            let rosterDirectInput = rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input'); rosterDirectInput.focus(); rosterDirectInput.value = '명단 redo 검증'; rosterDirectInput.dispatchEvent(new Event('input', { bubbles: true })); rosterDirectInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); await waitFor(() => rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input')?.value === '송아라', 'roster direct edit Ctrl+Z', 12000); document.querySelector('#rosterRedo').click(); await waitFor(() => rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input')?.value === '명단 redo 검증', 'roster direct edit Ctrl+Y', 12000); document.querySelector('#rosterUndo').click(); await waitFor(() => rosterTable.querySelector('[data-sheet-row="1"][data-sheet-col="0"] input')?.value === '송아라', 'roster direct edit cleanup undo', 12000);
            const rosterAppendCell = rosterTable.querySelector('[data-sheet-row="3"][data-sheet-col="0"]');
            clickRosterCell(rosterAppendCell);
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
            const arrangementCell = document.querySelector('#arrangementBoard [data-arrangement-row="0"][data-arrangement-col="0"]'); const arrangementDragEnd = document.querySelector('#arrangementBoard [data-arrangement-row="1"][data-arrangement-col="1"]'); arrangementDragEnd.scrollIntoView({ block: 'center', inline: 'center' }); const arrangementStartInput = arrangementCell.querySelector('input'); const arrangementStartRect = arrangementStartInput.getBoundingClientRect(); const arrangementEndRect = arrangementDragEnd.querySelector('input').getBoundingClientRect(); arrangementStartInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: arrangementStartRect.left + 5, clientY: arrangementStartRect.top + 5 })); arrangementStartInput.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: arrangementEndRect.left + 5, clientY: arrangementEndRect.top + 5, cancelable: true })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: arrangementEndRect.left + 5, clientY: arrangementEndRect.top + 5 })); const arrangementUnselected = document.querySelector('#arrangementBoard [data-arrangement-row="0"][data-arrangement-col="2"]'); const arrangementSelectedStyle = getComputedStyle(arrangementCell); const arrangementUnselectedStyle = getComputedStyle(arrangementUnselected); assert(document.querySelector('#arrangementSelectionStatus').textContent === 'A2:B3' && !document.querySelector('#arrangementBoard').classList.contains('range-selecting') && (arrangementSelectedStyle.backgroundColor !== arrangementUnselectedStyle.backgroundColor || arrangementSelectedStyle.boxShadow !== arrangementUnselectedStyle.boxShadow), 'arrangement input-origin drag selection is visibly highlighted'); arrangementStartInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: arrangementStartRect.left + 5, clientY: arrangementStartRect.top + 5 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: arrangementStartRect.left + 5, clientY: arrangementStartRect.top + 5 }));
            arrangementStartInput.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: arrangementStartRect.left + 6, clientY: arrangementStartRect.top + 6 })); assert(!document.querySelector('#sheetContextMenu').hidden && document.querySelector('#sheetContextMenu').dataset.sheetKind === 'arrangement' && document.querySelector('#sheetContextMenu [data-sheet-context-action="fill-down"]'), 'arrangement right-click menu exposes spreadsheet actions'); document.querySelector('#sheetContextMenu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            const arrangementCopy = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: arrangementCopy, bubbles: true, cancelable: true }));
            assert(arrangementCopy.getData('text/plain') === '그룹 1' && arrangementCopy.getData('text/html').includes('<table>'), 'arrangement copy remains independent from the roster spreadsheet');
            assert(['arrangementUndo', 'arrangementRedo', 'arrangementClearSelection', 'arrangementFillDown', 'arrangementInsertRow', 'arrangementDeleteRows', 'arrangementInsertColumn', 'arrangementDeleteColumns'].every((id) => document.getElementById(id)), 'arrangement sheet tools are visible');
            const arrangementBoard = document.querySelector('#arrangementBoard');
            const selectArrangementRange = (startRow, startCol, endRow = startRow, endCol = startCol) => { const startCell = arrangementBoard.querySelector('[data-arrangement-row="' + startRow + '"][data-arrangement-col="' + startCol + '"]'); const endCell = arrangementBoard.querySelector('[data-arrangement-row="' + endRow + '"][data-arrangement-col="' + endCol + '"]'); endCell.scrollIntoView({ block: 'center', inline: 'center' }); const startInput = startCell.querySelector('input'); const startBounds = startInput.getBoundingClientRect(); const endBounds = endCell.querySelector('input').getBoundingClientRect(); startInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: startBounds.left + 5, clientY: startBounds.top + 5 })); startInput.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: endBounds.left + 5, clientY: endBounds.top + 5, cancelable: true })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: endBounds.left + 5, clientY: endBounds.top + 5 })); };
            selectArrangementRange(1, 1, 0, 0); const arrangementBackwardPaste = new DataTransfer(); arrangementBackwardPaste.setData('text/plain', '작업좌상\\t작업우상\\n작업좌하\\t작업우하'); arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: arrangementBackwardPaste, bubbles: true, cancelable: true })); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '작업좌상' && arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input')?.value === '작업우하', 'arrangement structured paste starts at selection top-left'); document.querySelector('#arrangementUndo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '그룹 1' && arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input')?.value === '조민지', 'arrangement backward paste undo');
            selectArrangementRange(0, 0, 1, 1); const arrangementRangeFill = new DataTransfer(); arrangementRangeFill.setData('text/plain', '작업 범위'); arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: arrangementRangeFill, bubbles: true, cancelable: true }));
            await waitFor(() => [0, 1].every((row) => [0, 1].every((col) => arrangementBoard.querySelector('[data-arrangement-row="' + row + '"][data-arrangement-col="' + col + '"] input')?.value === '작업 범위')), 'arrangement single-value range fill'); await globalThis.flushWorkspaceEdits();
            let arrangementToolState = await globalThis.workspaceDesktop.loadState(); let arrangementToolItem = arrangementToolState.projects.find((project) => project.id === arrangementToolState.activeProjectId).data.workItems.find((item) => item.id === arrangementToolState.projects.find((project) => project.id === arrangementToolState.activeProjectId).data.activeWorkItemId); assert(arrangementToolItem.rows.slice(0, 2).every((row) => row.values[arrangementToolItem.columns[0].id] === '작업 범위' && row.values[arrangementToolItem.columns[1].id] === '작업 범위'), 'arrangement range fill persists');
            const arrangementBeforeUndoDiagnostics = globalThis.__workspaceSheetDiagnostics(); assert(arrangementBeforeUndoDiagnostics.arrangementHistory.at(-1)?.rows?.[0]?.[0] === '그룹 1', 'arrangement range fill captured pre-edit history: ' + JSON.stringify(arrangementBeforeUndoDiagnostics));
            document.querySelector('#arrangementUndo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '그룹 1' && arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input')?.value === '조민지', 'arrangement range fill undo');
            selectArrangementRange(0, 1, 1, 1); document.querySelector('#arrangementFillDown').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input')?.value === '송아라', 'arrangement fill down'); document.querySelector('#arrangementUndo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input')?.value === '조민지', 'arrangement fill down undo');
            selectArrangementRange(0, 0, 1, 1); document.querySelector('#arrangementClearSelection').click(); await waitFor(() => [0, 1].every((row) => [0, 1].every((col) => arrangementBoard.querySelector('[data-arrangement-row="' + row + '"][data-arrangement-col="' + col + '"] input')?.value === '')), 'arrangement clear selection'); document.querySelector('#arrangementUndo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '그룹 1', 'arrangement clear undo');
            selectArrangementRange(0, 0); document.querySelector('#arrangementInsertRow').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '', 'arrangement insert row'); document.querySelector('#arrangementUndo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '그룹 1', 'arrangement insert row undo');
            const arrangementRowSelector = arrangementBoard.querySelector('[data-select-arrangement-row="1"]'); arrangementRowSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); document.querySelector('#arrangementDeleteRows').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input')?.value === '', 'arrangement delete row'); document.querySelector('#arrangementUndo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="1"][data-arrangement-col="1"] input')?.value === '조민지', 'arrangement delete row undo');
            selectArrangementRange(0, 0); document.querySelector('#arrangementInsertColumn').click(); await waitFor(() => document.querySelector('#nameInputDialog').open, 'arrangement insert column dialog'); document.querySelector('#nameInputValue').value = '작업 삽입열'; document.querySelector('#nameInputForm').requestSubmit(); await waitFor(() => document.querySelectorAll('#arrangementBoard [data-arrangement-rename-column]').length === 5, 'arrangement insert column'); document.querySelector('#arrangementUndo').click(); await waitFor(() => document.querySelectorAll('#arrangementBoard [data-arrangement-rename-column]').length === 4, 'arrangement insert column undo');
            const arrangementColumnSelector = arrangementBoard.querySelector('[data-select-arrangement-column="3"]'); arrangementColumnSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); assert(arrangementColumnSelector.classList.contains('sheet-selector-selected'), 'arrangement column selector'); document.querySelector('#arrangementDeleteColumns').click(); await waitFor(() => document.querySelectorAll('#arrangementBoard [data-arrangement-rename-column]').length === 3, 'arrangement delete column'); document.querySelector('#arrangementUndo').click(); await waitFor(() => document.querySelectorAll('#arrangementBoard [data-arrangement-rename-column]').length === 4, 'arrangement delete column undo'); await globalThis.flushWorkspaceEdits();
            arrangementToolState = await globalThis.workspaceDesktop.loadState(); arrangementToolItem = arrangementToolState.projects.find((project) => project.id === arrangementToolState.activeProjectId).data.workItems.find((item) => item.id === arrangementToolState.projects.find((project) => project.id === arrangementToolState.activeProjectId).data.activeWorkItemId); assert(arrangementToolItem.rows.length === 2 && arrangementToolItem.columns.length === 4 && arrangementToolItem.rows[0].values[arrangementToolItem.columns[1].id] === '송아라' && arrangementToolItem.rows[1].values[arrangementToolItem.columns[1].id] === '조민지', 'arrangement sheet action undos persist the original work item');
            let arrangementDirectUndoInput = arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input'); arrangementDirectUndoInput.focus(); arrangementDirectUndoInput.value = '작업표 redo 검증'; arrangementDirectUndoInput.dispatchEvent(new Event('input', { bubbles: true })); arrangementDirectUndoInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '그룹 1', 'arrangement direct edit Ctrl+Z'); document.querySelector('#arrangementRedo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '작업표 redo 검증', 'arrangement direct edit Ctrl+Y'); document.querySelector('#arrangementUndo').click(); await waitFor(() => arrangementBoard.querySelector('[data-arrangement-row="0"][data-arrangement-col="0"] input')?.value === '그룹 1', 'arrangement direct edit cleanup undo');
            const focusedArrangementInput = document.querySelector('#arrangementBoard [data-arrangement-row="0"][data-arrangement-col="0"] input'); focusedArrangementInput.focus(); focusedArrangementInput.value = '종료 직전 저장'; focusedArrangementInput.dispatchEvent(new Event('input', { bubbles: true }));
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
            await globalThis.flushWorkspaceEdits();
            assert(!document.querySelector('#scheduleSetupDetails').open, 'setup folds after initial schedule generation');
            assert(document.querySelectorAll('#sessionCalendarBoard [data-session-slot]').length === 1, 'session calendar card');
            assert(document.querySelectorAll('#sessionPersonPool [data-session-person]').length === 3, 'session roster person pool');
            const unassignedPerson = [...document.querySelectorAll('#sessionPersonPool [data-session-person]')].find((chip) => ![...document.querySelectorAll('[data-session-assignment]')].some((assignment) => assignment.dataset.sessionPerson === chip.dataset.sessionPerson));
            assert(unassignedPerson, 'an unassigned schedule candidate is available for the click preview');
            const beforePreviewState = await globalThis.workspaceDesktop.loadState(); const beforePreviewProject = beforePreviewState.projects.find((project) => project.id === beforePreviewState.activeProjectId); const beforePreviewAssignments = JSON.stringify(beforePreviewProject.data.assignments);
            unassignedPerson.click(); await waitFor(() => !document.querySelector('#sessionSelectedPersonPanel').hidden && document.querySelector('[data-session-origin-new].selected'), 'unassigned person selection'); document.querySelector('[data-session-slot]').click();
            await waitFor(() => !document.querySelector('#sessionChangePreview').hidden, 'click assignment preview');
            assert(document.querySelectorAll('[data-session-assignment]').length === beforePreviewProject.data.assignments.length, 'preview does not mutate calendar');
            const duringPreviewState = await globalThis.workspaceDesktop.loadState(); assert(JSON.stringify(duringPreviewState.projects.find((project) => project.id === duringPreviewState.activeProjectId).data.assignments) === beforePreviewAssignments, 'preview does not persist assignments');
            document.querySelector('#sessionCancelChange').click(); await waitFor(() => document.querySelector('#sessionChangePreview').hidden, 'cancel assignment preview');
            const keyboardSessionSlot = document.querySelector('[data-session-slot]'); keyboardSessionSlot.focus(); keyboardSessionSlot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await waitFor(() => !document.querySelector('#sessionChangePreview').hidden, 'reopen assignment preview with keyboard'); document.querySelector('#sessionApplyChange').click();
            await waitFor(() => document.querySelectorAll('[data-session-assignment]').length === 2, 'apply person into session');
            document.querySelector('[data-session-edit]').click(); await waitFor(() => document.querySelector('#calendarEventDialog').open, 'friendly reschedule session dialog'); document.querySelector('#calendarEventTitle').value = '변경 세션'; document.querySelector('#calendarEventStartDate').value = '2026-07-06'; document.querySelector('#calendarEventEndDate').value = '2026-07-06'; document.querySelector('#calendarEventStartTime').value = '10:00'; document.querySelector('#calendarEventEndTime').value = '11:00'; document.querySelector('#calendarEventForm').requestSubmit(); await waitFor(() => document.querySelector('[data-session-slot]')?.textContent.includes('10:00–11:00'), 'session time changed with date/time controls');
            document.querySelector('#sessionAddEmptyTime').click(); await waitFor(() => document.querySelector('#calendarEventDialog').open, 'add another session dialog'); assert(document.querySelector('#calendarEventStartTime').value === '09:00' && document.querySelector('#calendarEventEndTime').value === '10:30', 'new session default uses the project duration'); document.querySelector('#calendarEventTitle').value = '추가 세션'; document.querySelector('#calendarEventStartDate').value = '2026-07-06'; document.querySelector('#calendarEventEndDate').value = '2026-07-06'; document.querySelector('#calendarEventStartTime').value = '11:00'; document.querySelector('#calendarEventEndTime').value = '12:00'; document.querySelector('#calendarEventForm').requestSubmit(); await waitFor(() => document.querySelectorAll('[data-session-slot]').length === 2, 'another session added');
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
            const scheduleSecondCell = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="1"]');
            scheduleSecondCell.scrollIntoView({ block: 'center', inline: 'center' });
            const scheduleStartInput = scheduleCell.querySelector('input'); const scheduleStartRect = scheduleStartInput.getBoundingClientRect(); const scheduleEndRect = scheduleSecondCell.querySelector('input').getBoundingClientRect(); scheduleStartInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: scheduleStartRect.left + 5, clientY: scheduleStartRect.top + 5 })); scheduleStartInput.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: scheduleEndRect.left + 5, clientY: scheduleEndRect.top + 5, cancelable: true })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: scheduleEndRect.left + 5, clientY: scheduleEndRect.top + 5 }));
            const scheduleUnselectedCell = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="2"]'); const scheduleSelectedStyle = getComputedStyle(scheduleCell); const scheduleUnselectedStyle = getComputedStyle(scheduleUnselectedCell); assert(scheduleCell.classList.contains('sheet-selected') && scheduleSecondCell.classList.contains('sheet-selected') && document.querySelector('#scheduleSelectionStatus').textContent === 'A2:B2' && !document.querySelector('#scheduleBoard').classList.contains('range-selecting') && (scheduleSelectedStyle.backgroundColor !== scheduleUnselectedStyle.backgroundColor || scheduleSelectedStyle.boxShadow !== scheduleUnselectedStyle.boxShadow), 'schedule input-origin spreadsheet drag selection is visibly highlighted');
            scheduleStartInput.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: scheduleStartRect.left + 6, clientY: scheduleStartRect.top + 6 })); assert(!document.querySelector('#sheetContextMenu').hidden && document.querySelector('#sheetContextMenu').dataset.sheetKind === 'schedule' && document.querySelector('#sheetContextMenu [data-sheet-context-action="insert-column"]'), 'schedule right-click menu exposes schedule-safe actions'); document.querySelector('#sheetContextMenu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            const scheduleCopied = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: scheduleCopied, bubbles: true, cancelable: true }));
            assert(scheduleCopied.getData('text/plain').includes('\t') && scheduleCopied.getData('text/html').includes('<table>'), 'schedule spreadsheet drag and Excel copy');
            const scheduleOriginalFirst = scheduleCell.querySelector('input').value; const scheduleOriginalSecond = scheduleSecondCell.querySelector('input').value; const reverseStart = scheduleSecondCell.querySelector('input'); const reverseStartRect = reverseStart.getBoundingClientRect(); const reverseEndRect = scheduleCell.querySelector('input').getBoundingClientRect(); reverseStart.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: reverseStartRect.left + 5, clientY: reverseStartRect.top + 5 })); reverseStart.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: reverseEndRect.left + 5, clientY: reverseEndRect.top + 5, cancelable: true })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: reverseEndRect.left + 5, clientY: reverseEndRect.top + 5 })); const scheduleBackwardPaste = new DataTransfer(); scheduleBackwardPaste.setData('text/plain', '2026-07-07\\t2026-07-08'); reverseStart.dispatchEvent(new ClipboardEvent('paste', { clipboardData: scheduleBackwardPaste, bubbles: true, cancelable: true })); await waitFor(() => document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="0"] input')?.value === '2026-07-07' && document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="1"] input')?.value === '2026-07-08', 'schedule structured paste starts at selection top-left with native date fields'); await globalThis.flushWorkspaceEdits(); document.querySelector('#scheduleUndo').click(); await waitFor(() => document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="0"] input')?.value === scheduleOriginalFirst && document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="1"] input')?.value === scheduleOriginalSecond, 'schedule backward paste undo');
            const scheduleReplacementCell = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="0"]'); scheduleReplacementCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 })); globalThis.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            const schedulePaste = new DataTransfer(); schedulePaste.setData('text/plain', '날짜\\t시작\\t종료\\t세션명\\t참여자\\t운영 메모\\n2026-07-06\\t09:30\\t10:30\\t오전 세션\\t송아라, 조민지, 저장 명단 사용자\\t확인 완료');
            scheduleReplacementCell.querySelector('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: schedulePaste, bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelector('#confirmDialog').open, 'schedule paste replacement confirm'); document.querySelector('#confirmAction').click();
            await waitFor(() => [...document.querySelectorAll('[data-schedule-rename-column]')].some((button) => button.textContent === '운영 메모'), 'dynamic schedule column import');
            assert([...document.querySelectorAll('#scheduleBoard tbody input')].some((input) => input.value === '확인 완료'), 'custom schedule cell persisted in editor');
            await waitFor(() => document.querySelectorAll('[data-session-assignment]').length === 3, 'generic participant column mapped to assignments');
            assert([...document.querySelectorAll('#sessionPersonPool [data-session-person]')].every((chip) => chip.textContent.includes('일정 1개')), 'customer counts, calendar cards, and spreadsheet assignments must stay consistent');
            await globalThis.flushWorkspaceEdits();
            let customScheduleState = await globalThis.workspaceDesktop.loadState(); let customScheduleProject = customScheduleState.projects.find((project) => project.id === customScheduleState.activeProjectId); const customScheduleColumn = customScheduleProject.data.scheduleSheetColumns.find((column) => column.name === '운영 메모'); assert(customScheduleColumn, 'imported custom schedule column persists before direct editing'); const customScheduleColumnIndex = customScheduleProject.data.scheduleSheetColumns.findIndex((column) => column.id === customScheduleColumn.id); let customScheduleInput = document.querySelector('#scheduleBoard [data-schedule-row="0"][data-schedule-col="' + customScheduleColumnIndex + '"] input'); customScheduleInput.focus(); customScheduleInput.value = '직접 수정 완료'; customScheduleInput.dispatchEvent(new Event('input', { bubbles: true })); customScheduleInput.blur(); await globalThis.flushWorkspaceEdits();
            customScheduleProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === customScheduleState.activeProjectId); assert(customScheduleProject.data.scheduleCustomValues[customScheduleProject.data.slots[0].id][customScheduleColumn.id] === '직접 수정 완료', 'direct custom schedule-cell edit persists');
            const calendarProjectId = customScheduleState.activeProjectId; const calendarSlotId = customScheduleProject.data.slots[0].id; const calendarTargetDate = customScheduleProject.data.slots[0].date; const originalCalendarStart = customScheduleProject.data.slots[0].startTime; const originalCalendarEnd = customScheduleProject.data.slots[0].endTime;
            document.querySelector('#page-schedule [data-related-program="projectCalendar"]').click();
            await waitFor(() => document.querySelector('#page-projectCalendar').classList.contains('active'), 'project calendar page');
            await waitFor(() => document.querySelector('[data-session-overview]'), 'session overview surface');
            const schedulerSmokeRoot = document.querySelector('[data-session-overview]').closest('.pss');
            const schedulerSmokeDates = [...schedulerSmokeRoot.querySelectorAll('[data-overview-date]:not(.outside)')];
            assert(schedulerSmokeDates.length >= 12, 'session overview exposes enough in-month dates for range drag');
            const schedulerSmokeDragStart = schedulerSmokeDates[7]; const schedulerSmokeDragEnd = schedulerSmokeDates[11];
            const schedulerSmokeStartDate = schedulerSmokeDragStart.dataset.overviewDate; const schedulerSmokeEndDate = schedulerSmokeDragEnd.dataset.overviewDate;
            const schedulerSmokeOriginalSetPointerCapture = schedulerSmokeRoot.setPointerCapture; const schedulerSmokeOriginalReleasePointerCapture = schedulerSmokeRoot.releasePointerCapture; const schedulerSmokeOriginalElementFromPoint = document.elementFromPoint;
            try {
              schedulerSmokeRoot.setPointerCapture = () => {}; schedulerSmokeRoot.releasePointerCapture = () => {}; document.elementFromPoint = () => schedulerSmokeDragEnd;
              const schedulerSmokeStartRect = schedulerSmokeDragStart.getBoundingClientRect(); const schedulerSmokeEndRect = schedulerSmokeDragEnd.getBoundingClientRect();
              schedulerSmokeDragStart.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 191, clientX: schedulerSmokeStartRect.left + 8, clientY: schedulerSmokeStartRect.top + 8 }));
              schedulerSmokeRoot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, buttons: 1, pointerId: 191, clientX: schedulerSmokeEndRect.left + 8, clientY: schedulerSmokeEndRect.top + 8 }));
              schedulerSmokeRoot.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 191, clientX: schedulerSmokeEndRect.left + 8, clientY: schedulerSmokeEndRect.top + 8 }));
            } finally {
              if (schedulerSmokeOriginalSetPointerCapture) schedulerSmokeRoot.setPointerCapture = schedulerSmokeOriginalSetPointerCapture; else delete schedulerSmokeRoot.setPointerCapture;
              if (schedulerSmokeOriginalReleasePointerCapture) schedulerSmokeRoot.releasePointerCapture = schedulerSmokeOriginalReleasePointerCapture; else delete schedulerSmokeRoot.releasePointerCapture;
              document.elementFromPoint = schedulerSmokeOriginalElementFromPoint;
            }
            await waitFor(() => document.querySelector('#pssSessionDialog')?.open && document.querySelector('#pssSessionDialog [name="startDate"]')?.value === schedulerSmokeStartDate && document.querySelector('#pssSessionDialog [name="endDate"]')?.value === schedulerSmokeEndDate, 'session overview pointer drag fills the selected date range');
            const schedulerSmokeSessionForm = document.querySelector('#pssSessionDialog form'); schedulerSmokeSessionForm.elements.title.value = 'Smoke 그룹 편성 세션'; schedulerSmokeSessionForm.requestSubmit();
            await waitFor(() => document.querySelector('[data-session-detail]')?.textContent.includes('Smoke 그룹 편성 세션'), 'new session opens its group scheduling workspace');
            const schedulerSmokeSessionId = document.querySelector('[data-session-detail]').getAttribute('data-session-detail');
            const schedulerSmokePeople = customScheduleProject.data.people.filter((person) => person.active !== false).slice(0, 2); const schedulerSmokeRole = customScheduleProject.data.roles.find((role) => role.active !== false);
            assert(schedulerSmokePeople.length === 2 && schedulerSmokeRole, 'session group smoke has two roster people and an active role');
            const createSchedulerSmokeGroup = async (name, person) => {
              document.querySelector('.pss-session-toolbar [data-action="add-group"]').click();
              await waitFor(() => document.querySelector('#pssGroupDialog')?.open, name + ' group dialog');
              const form = document.querySelector('#pssGroupDialog form'); form.elements.name.value = name;
              const member = form.querySelector('[data-member-toggle="' + person.id + '"]'); assert(member, name + ' exposes its roster member'); member.checked = true; member.dispatchEvent(new Event('change', { bubbles: true }));
              const role = form.elements['role:' + person.id]; assert(role && role.value === schedulerSmokeRole.id, name + ' automatically selects the first active role');
              form.requestSubmit();
              await waitFor(() => !document.querySelector('#pssGroupDialog')?.open && [...document.querySelectorAll('[data-drag-group]')].some((card) => card.textContent.includes(name)), name + ' group saved');
            };
            await createSchedulerSmokeGroup('Smoke A조', schedulerSmokePeople[0]); await createSchedulerSmokeGroup('Smoke B조', schedulerSmokePeople[1]);
            const placeSchedulerSmokeGroup = async (name) => {
              const beforeCount = document.querySelectorAll('[data-session-placement]').length; const card = [...document.querySelectorAll('[data-drag-group]')].find((candidate) => candidate.textContent.includes(name)); assert(card, name + ' group card exists'); card.click();
              await waitFor(() => document.querySelector('#pssPlacementDialog')?.open, name + ' placement dialog');
              const form = document.querySelector('#pssPlacementDialog form'); form.elements.date.value = schedulerSmokeStartDate; form.elements.startTime.value = '10:00'; form.elements.endTime.value = '11:00'; form.requestSubmit();
              await waitFor(() => !document.querySelector('#pssPlacementDialog')?.open && document.querySelectorAll('[data-session-placement]').length === beforeCount + 1, name + ' placed on the session calendar');
            };
            await placeSchedulerSmokeGroup('Smoke A조'); await placeSchedulerSmokeGroup('Smoke B조');
            let schedulerSmokePlacements = [...document.querySelectorAll('[data-session-placement]')];
            assert(schedulerSmokePlacements.length === 2 && schedulerSmokePlacements.every((placement) => placement.textContent.includes('10:00') && placement.textContent.includes('11:00')), 'two groups render at the same time');
            assert(schedulerSmokePlacements[0].closest('[data-time-date]') === schedulerSmokePlacements[1].closest('[data-time-date]') && schedulerSmokePlacements[0].style.left !== schedulerSmokePlacements[1].style.left, 'same-time groups occupy separate visual lanes');
            document.querySelector('[data-session-view="day"]').click(); await waitFor(() => document.querySelector('[data-session-view="day"]')?.classList.contains('active') && document.querySelector('.pss-time-board.day-view'), 'session day view');
            document.querySelector('[data-session-view="week"]').click(); await waitFor(() => document.querySelector('[data-session-view="week"]')?.classList.contains('active') && document.querySelector('.pss-time-board.week-view'), 'session week view');
            document.querySelector('[data-session-view="month"]').click(); await waitFor(() => document.querySelector('[data-session-view="month"]')?.classList.contains('active') && document.querySelector('.pss-placement-month'), 'session month view');
            delete globalThis.__sessionSchedulerLastPrintHtml; document.querySelector('.pss-print-button').click();
            await waitFor(() => typeof globalThis.__sessionSchedulerLastPrintHtml === 'string', 'isolated session print document');
            const schedulerSmokePrintHtml = globalThis.__sessionSchedulerLastPrintHtml;
            assert(schedulerSmokePrintHtml.includes('<!doctype html>') && schedulerSmokePrintHtml.includes('@page { size: A4 landscape;') && schedulerSmokePrintHtml.includes('구성원 · 역할'), 'session printing builds an isolated A4 document');
            assert(schedulerSmokePrintHtml.includes('Smoke A조') && schedulerSmokePrintHtml.includes('Smoke B조') && schedulerSmokePrintHtml.includes(schedulerSmokePeople[0].name) && schedulerSmokePrintHtml.includes(schedulerSmokePeople[1].name) && schedulerSmokePrintHtml.includes(schedulerSmokeRole.name), 'isolated print contains both groups, members, and roles');
            document.querySelector('[data-session-view="week"]').click(); await waitFor(() => document.querySelector('.pss-time-board.week-view') && document.querySelectorAll('[data-session-placement]').length === 2, 'return to week view before unassign');
            const schedulerSmokePlacementToRemove = [...document.querySelectorAll('[data-session-placement]')].find((placement) => placement.textContent.includes('Smoke A조')); const schedulerSmokeUnassignDrop = document.querySelector('[data-unassign-drop]'); assert(schedulerSmokePlacementToRemove && schedulerSmokeUnassignDrop, 'placement and unassigned drop zone exist');
            const schedulerSmokeTransfer = new DataTransfer(); schedulerSmokePlacementToRemove.dispatchEvent(new DragEvent('dragstart', { dataTransfer: schedulerSmokeTransfer, bubbles: true })); schedulerSmokeUnassignDrop.dispatchEvent(new DragEvent('dragover', { dataTransfer: schedulerSmokeTransfer, bubbles: true, cancelable: true })); schedulerSmokeUnassignDrop.dispatchEvent(new DragEvent('drop', { dataTransfer: schedulerSmokeTransfer, bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelectorAll('[data-session-placement]').length === 1, 'drop into group pool removes one placement');
            assert([...document.querySelectorAll('.pss-group-card')].some((card) => card.textContent.includes('Smoke A조') && card.textContent.includes('미배치')), 'removed group remains visible as unassigned');
            document.querySelector('[data-action="show-overview"]').click(); await waitFor(() => document.querySelector('[data-session-overview]') && !document.querySelector('[data-session-detail]'), 'large back button returns to session overview');
            const schedulerSmokeSessionCard = document.querySelector('[data-session-card="' + schedulerSmokeSessionId + '"]'); assert(schedulerSmokeSessionCard, 'created session remains on the overview'); schedulerSmokeSessionCard.click();
            await waitFor(() => document.querySelector('[data-session-detail="' + schedulerSmokeSessionId + '"]'), 'reopen session for cleanup'); document.querySelector('[data-action="edit-session"]').click(); await waitFor(() => document.querySelector('#pssSessionDialog')?.open, 'session cleanup dialog'); document.querySelector('#pssSessionDialog [data-action="delete-session"]').click();
            await waitFor(() => document.querySelector('#confirmDialog').open, 'session cleanup confirmation'); document.querySelector('#confirmAction').click();
            await waitFor(() => document.querySelector('[data-session-overview]') && !document.querySelector('[data-session-card="' + schedulerSmokeSessionId + '"]'), 'session cleanup returns to overview');
            const schedulerSmokeCleanupState = await globalThis.workspaceDesktop.loadState(); const schedulerSmokeCleanupProject = schedulerSmokeCleanupState.projects.find((project) => project.id === calendarProjectId); const schedulerSmokeCleanupModel = schedulerSmokeCleanupProject.data.extensionData.projectCalendar;
            assert(!schedulerSmokeCleanupModel.sessions.some((session) => session.id === schedulerSmokeSessionId) && !schedulerSmokeCleanupModel.groups.some((group) => group.sessionId === schedulerSmokeSessionId) && !schedulerSmokeCleanupProject.data.slots.some((slot) => slot.calendarSessionId === schedulerSmokeSessionId), 'session cleanup removes its groups and placements without touching later smoke data');
            document.querySelector('[data-session-open-legacy]').click();
            await waitFor(() => !document.querySelector('#legacyCalendarWorkspace').hidden, 'legacy calendar compatibility surface');
            assert(document.querySelectorAll('#projectCalendarGrid [data-calendar-date]').length === 42, 'month calendar renders the complete six-week grid');
            assert(document.querySelector('#calendarRoleFilter').value === '', 'project calendar starts without an unintended role filter');
            const calendarSearch = document.querySelector('#calendarSearch'); calendarSearch.value = '__no_matching_calendar_event__'; calendarSearch.dispatchEvent(new Event('input', { bubbles: true }));
            await waitFor(() => !document.querySelector('#calendarFilterEmpty').hidden && document.querySelector('#projectCalendarGrid').hidden, 'project calendar filtered-empty guidance');
            document.querySelector('#calendarResetFilters').click(); await waitFor(() => document.querySelector('#calendarFilterEmpty').hidden && !document.querySelector('#projectCalendarGrid').hidden && calendarSearch.value === '' && document.querySelector('#calendarRoleFilter').value === '', 'project calendar filter reset');
            for (let calendarPageTurn = 0; calendarPageTurn < 24 && !document.querySelector('#projectCalendarGrid [data-calendar-date="' + calendarTargetDate + '"]'); calendarPageTurn += 1) { const visibleDates = [...document.querySelectorAll('#projectCalendarGrid [data-calendar-date]')].map((cell) => cell.dataset.calendarDate).sort(); document.querySelector(calendarTargetDate < visibleDates[0] ? '#calendarPrevious' : '#calendarNext').click(); }
            await waitFor(() => document.querySelector('#projectCalendarGrid [data-calendar-event="' + calendarSlotId + '"]'), 'project calendar event card');
            const calendarEvent = document.querySelector('#projectCalendarGrid [data-calendar-event="' + calendarSlotId + '"]');
            assert(calendarEvent && calendarEvent.classList.contains('phase-past') && calendarEvent.textContent.includes('종료'), 'past project event is visibly grey and labelled complete: ' + (calendarEvent?.className || 'missing') + ' / ' + (calendarEvent?.textContent || ''));
            calendarEvent.click(); await waitFor(() => !document.querySelector('#calendarDetail').hidden, 'calendar event detail');
            assert(document.querySelector('#calendarDetailTitle').textContent.includes('오전 세션') && document.querySelectorAll('#calendarAssignments .calendar-person-tag').length === 3, 'calendar detail shows event and role assignments');
            document.querySelector('#calendarDetailClose').click(); await waitFor(() => document.querySelector('#calendarDetail').hidden, 'calendar event detail close'); assert(document.activeElement?.dataset?.calendarEvent === calendarSlotId, 'closing calendar detail restores focus to the rerendered event card'); document.activeElement.click(); await waitFor(() => !document.querySelector('#calendarDetail').hidden, 'calendar event detail reopen after focus restore');
            document.querySelector('#calendarAddActivity').click(); await waitFor(() => document.querySelector('#calendarActivityDialog').open, 'calendar activity dialog');
            document.querySelector('#calendarActivityTitle').value = '오리엔테이션'; document.querySelector('#calendarActivityDescription').value = '스모크 진행 메모'; document.querySelector('#calendarActivityStart').value = '09:40'; document.querySelector('#calendarActivityEnd').value = '10:00';
            const calendarActivityOwner = document.querySelector('[data-calendar-activity-assignment]'); assert(calendarActivityOwner, 'calendar activity offers current assignees'); calendarActivityOwner.checked = true;
            document.querySelector('#calendarActivityForm').requestSubmit();
            await waitFor(() => !document.querySelector('#calendarActivityDialog').open && document.querySelector('#calendarAgenda .calendar-agenda-item')?.textContent.includes('오리엔테이션'), 'calendar activity saved');
            await globalThis.flushWorkspaceEdits();
            let calendarSavedState = await globalThis.workspaceDesktop.loadState(); let calendarSavedProject = calendarSavedState.projects.find((project) => project.id === calendarProjectId); const calendarActivity = calendarSavedProject.data.activities.find((activity) => activity.title === '오리엔테이션');
            assert(calendarActivity && (calendarActivity.eventId || calendarActivity.slotId) === calendarSlotId && calendarSavedProject.data.activityAssignments.some((link) => link.activityId === calendarActivity.id), 'calendar activity and owner persist in the active project');
            document.querySelector('#calendarAdjustEvent').click(); await waitFor(() => document.querySelector('#calendarAdjustmentDialog').open, 'calendar adjustment dialog');
            assert(document.querySelectorAll('#calendarAdjustmentImpact .calendar-impact-card').length === 4, 'calendar adjustment renders its impact preview');
            document.querySelector('#calendarAdjustStart').value = '09:45'; document.querySelector('#calendarAdjustStart').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#calendarAdjustEnd').value = '10:45'; document.querySelector('#calendarAdjustEnd').dispatchEvent(new Event('input', { bubbles: true }));
            await waitFor(() => !document.querySelector('#calendarApplyAdjustment').disabled && document.querySelector('#calendarApplyAdjustment').textContent.includes('1개 변경'), 'calendar adjustment can be applied after preview');
            document.querySelector('#calendarAdjustmentForm').requestSubmit();
            await waitFor(() => !document.querySelector('#calendarAdjustmentDialog').open && document.querySelector('#calendarDetailTime').textContent.includes('09:45–10:45'), 'calendar adjustment applied');
            await globalThis.flushWorkspaceEdits();
            calendarSavedState = await globalThis.workspaceDesktop.loadState(); calendarSavedProject = calendarSavedState.projects.find((project) => project.id === calendarProjectId); assert(calendarSavedProject.data.slots.find((slot) => slot.id === calendarSlotId)?.startTime === '09:45' && calendarSavedProject.data.slots.find((slot) => slot.id === calendarSlotId)?.endTime === '10:45', 'calendar adjustment persists to the project schedule');
            document.querySelector('#calendarUndo').click(); await waitFor(() => document.querySelector('#calendarDetailTime').textContent.includes(originalCalendarStart + '–' + originalCalendarEnd), 'calendar adjustment undo');
            await globalThis.flushWorkspaceEdits();
            calendarSavedProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === calendarProjectId); assert(calendarSavedProject.data.slots.find((slot) => slot.id === calendarSlotId)?.startTime === originalCalendarStart && calendarSavedProject.data.activities.some((activity) => activity.id === calendarActivity.id), 'calendar undo restores schedule while retaining the saved activity');
            document.querySelector('#calendarRedo').click(); await waitFor(() => document.querySelector('#calendarDetailTime').textContent.includes('09:45–10:45'), 'calendar adjustment redo');
            await globalThis.flushWorkspaceEdits();
            calendarSavedProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === calendarProjectId); assert(calendarSavedProject.data.slots.find((slot) => slot.id === calendarSlotId)?.startTime === '09:45' && calendarSavedProject.data.activities.some((activity) => activity.id === calendarActivity.id), 'calendar redo persists the adjusted schedule and activity');
            for (let calendarPageTurn = 0; calendarPageTurn < 24 && (!document.querySelector('#projectCalendarGrid [data-calendar-date="2026-08-07"]') || !document.querySelector('#projectCalendarGrid [data-calendar-date="2026-08-09"]')); calendarPageTurn += 1) { const visibleDates = [...document.querySelectorAll('#projectCalendarGrid [data-calendar-date]')].map((cell) => cell.dataset.calendarDate).sort(); document.querySelector('2026-08-07' < visibleDates[0] ? '#calendarPrevious' : '#calendarNext').click(); }
            const dragStartDay = document.querySelector('#projectCalendarGrid [data-calendar-date="2026-08-07"]'); const dragEndDay = document.querySelector('#projectCalendarGrid [data-calendar-date="2026-08-09"]'); const dragCalendarGrid = document.querySelector('#projectCalendarGrid'); assert(dragStartDay && dragEndDay, 'calendar drag range dates are visible'); dragStartDay.scrollIntoView({ block: 'center' });
            const dragStartRect = dragStartDay.getBoundingClientRect(); const dragEndRect = dragEndDay.getBoundingClientRect(); const originalSetPointerCapture = dragCalendarGrid.setPointerCapture; const originalHasPointerCapture = dragCalendarGrid.hasPointerCapture; const originalReleasePointerCapture = dragCalendarGrid.releasePointerCapture; const originalElementFromPoint = document.elementFromPoint; dragCalendarGrid.setPointerCapture = () => {}; dragCalendarGrid.hasPointerCapture = () => false; dragCalendarGrid.releasePointerCapture = () => {}; document.elementFromPoint = () => dragEndDay;
            dragStartDay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 77, clientX: dragStartRect.left + 8, clientY: dragStartRect.top + 8 })); dragCalendarGrid.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, buttons: 1, pointerId: 77, clientX: dragEndRect.left + 8, clientY: dragEndRect.top + 8 })); dragCalendarGrid.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 77, clientX: dragEndRect.left + 8, clientY: dragEndRect.top + 8 })); dragCalendarGrid.setPointerCapture = originalSetPointerCapture; dragCalendarGrid.hasPointerCapture = originalHasPointerCapture; dragCalendarGrid.releasePointerCapture = originalReleasePointerCapture; document.elementFromPoint = originalElementFromPoint;
            await waitFor(() => document.querySelector('#calendarEventDialog').open && document.querySelector('#calendarEventStartDate').value === '2026-08-07' && document.querySelector('#calendarEventEndDate').value === '2026-08-09', 'calendar pointer drag opens the selected multi-day range'); document.querySelector('#calendarEventTitle').value = '다일 운영 일정'; document.querySelector('#calendarEventStartTime').value = '09:00'; document.querySelector('#calendarEventEndTime').value = '18:00'; document.querySelector('#calendarEventForm').requestSubmit();
            await waitFor(() => document.querySelectorAll('#projectCalendarGrid [data-calendar-event]').length >= 3 && document.querySelector('#calendarDetailTitle').textContent === '다일 운영 일정', 'multi-day event renders on every covered day');
            await globalThis.flushWorkspaceEdits(); calendarSavedProject = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === calendarProjectId); const multiDayCalendarSlot = calendarSavedProject.data.slots.find((slot) => slot.label === '다일 운영 일정'); const multiDayCalendarSlotId = multiDayCalendarSlot?.id; assert(multiDayCalendarSlot?.endDate === '2026-08-09', 'multi-day event end date persists');
            assert(document.querySelectorAll('#projectCalendarGrid [data-calendar-event="' + multiDayCalendarSlotId + '"]').length === 3, 'multi-day event appears on start, middle, and end dates');
            document.querySelector('#calendarAddActivity').click(); await waitFor(() => document.querySelector('#calendarActivityDialog').open, 'multi-day activity editor'); document.querySelector('#calendarActivityTitle').value = '둘째 날 점검'; document.querySelector('#calendarActivityStartDate').value = '2026-08-08'; document.querySelector('#calendarActivityStart').value = '10:00'; document.querySelector('#calendarActivityEndDate').value = '2026-08-08'; document.querySelector('#calendarActivityEnd').value = '11:00'; document.querySelector('#calendarActivityForm').requestSubmit(); await waitFor(() => document.querySelector('#calendarAgenda')?.textContent.includes('둘째 날 점검'), 'second-day activity saved');
            document.querySelector('#page-projectCalendar [data-related-program="schedule"]').click(); await waitFor(() => document.querySelector('#page-schedule').classList.contains('active'), 'return to schedule from project calendar');
            assert([...document.querySelectorAll('[data-schedule-rename-column]')].some((button) => button.textContent === '종료 날짜') && [...document.querySelectorAll('#scheduleBoard tbody input[type="date"]')].some((input) => input.value === '2026-08-09'), 'schedule sheet exposes native start/end date pickers for multi-day events');
            document.querySelector('#saveScheduleVersion').click();
            await new Promise((resolve) => setTimeout(resolve, 250));
            document.querySelector('#page-schedule [data-nav-link="dashboard"]').click(); await waitFor(() => document.querySelector('#page-dashboard').classList.contains('active'), 'global dashboard after schedule');
            for (let dashboardPageTurn = 0; dashboardPageTurn < 24 && !document.querySelector('#dashboardCalendarGrid [data-dashboard-calendar-slot="' + multiDayCalendarSlotId + '"]'); dashboardPageTurn += 1) { const visibleDates = [...document.querySelectorAll('#dashboardCalendarGrid [data-dashboard-calendar-date]')].map((cell) => cell.dataset.dashboardCalendarDate).sort(); assert(visibleDates.length, 'global dashboard calendar renders date cells'); document.querySelector(multiDayCalendarSlot.date < visibleDates[0] ? '#dashboardCalendarPrevious' : '#dashboardCalendarNext').click(); }
            await waitFor(() => document.querySelector('#dashboardCalendarGrid [data-dashboard-calendar-slot="' + multiDayCalendarSlotId + '"]'), 'global dashboard calendar contains project event'); document.querySelector('#dashboardCalendarGrid [data-dashboard-calendar-slot="' + multiDayCalendarSlotId + '"]').click(); await waitFor(() => document.querySelector('#page-projectCalendar').classList.contains('active') && document.querySelector('#calendarDetailTitle').textContent === '다일 운영 일정', 'global calendar click opens owning project and event'); document.querySelector('#page-projectCalendar [data-nav-link="dashboard"]').click();
            document.querySelector('[data-workflow-open="layout"]').click();
            await waitFor(() => document.querySelectorAll('#outputPreviewTable tbody tr').length >= 1, 'output preview');
            assert(document.querySelector('#page-layout h1')?.textContent === '일정표', 'output page purpose label');
            const layoutType = document.querySelector('#layoutType'); layoutType.value = 'calendarCoach'; layoutType.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => {
              const headers = [...document.querySelectorAll('#outputPreviewTable thead th')].map((cell) => cell.textContent);
              const fixed = new Set(['날짜', '시작', '종료', '세션명', '상태']);
              return headers.some((header) => !fixed.has(header) && header !== 'Zoom 참가 링크');
            }, 'dynamic role output preview');
            const roleOutputSignature = [...document.querySelectorAll('#outputPreviewTable thead th')].map((cell) => cell.textContent).join('|');
            layoutType.value = 'calendarZoom'; layoutType.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => [...document.querySelectorAll('#outputPreviewTable thead th')].some((cell) => cell.textContent === 'Zoom 참가 링크'), 'Zoom output preview');
            assert([...document.querySelectorAll('#outputPreviewTable thead th')].map((cell) => cell.textContent).join('|') !== roleOutputSignature, 'output choices render materially different columns');
            document.querySelector('[data-nav="modules"]').click();
            await waitFor(() => document.querySelector('#page-modules').classList.contains('active'), 'modules page');
            const zoomBefore = document.querySelector('[data-module-toggle="zoom"]').textContent;
            document.querySelector('[data-module-toggle="zoom"]').click();
            await waitFor(() => document.querySelector('[data-module-toggle="zoom"]').textContent !== zoomBefore, 'zoom module toggled');
            document.querySelector('[data-nav="dashboard"]').click();
            document.querySelector('[data-workflow-open="gmailFlow"]').click();
            await waitFor(() => document.querySelector('#page-gmailFlow').classList.contains('active'), 'gmail page');
            assert(document.querySelector('#page-gmailFlow h1')?.textContent === '메일' && document.querySelector('#createGmailDrafts')?.textContent.includes('임시보관함'), 'gmail page purpose labels');
            assert(document.querySelector('#gmailFlowAccountButton') && document.querySelector('#openOriginalGmailFlow'), 'Gmail account and original app controls should be visible');
            assert(document.querySelector('#openMailRosterManager')?.textContent.includes('명단 관리') && document.querySelectorAll('#mailRosterPeople .resource-chip').length === 3 && document.querySelector('#mailRosterSummary')?.textContent.trim(), 'gmail page should show the applied shared roster');
            assert(document.querySelector('#gmailSharedRosterSelect') && [...document.querySelector('#gmailSharedRosterSelect').options].some((option) => option.textContent.includes('공용 저장 명단 테스트')) && document.querySelector('#loadGmailSharedRoster')?.textContent.includes('전체 교체') && document.querySelector('#gmailRosterPaste') && document.querySelector('#applyGmailRosterPaste'), 'gmail direct saved-roster and paste controls');
            const gmailPeopleBeforeReplace = (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === smokeState.activeProjectId).data.people.map((person) => person.email).sort().join('|');
            document.querySelector('#gmailSharedRosterSelect').value = [...document.querySelector('#gmailSharedRosterSelect').options].find((option) => option.textContent.includes('공용 저장 명단 테스트')).value;
            document.querySelector('#loadGmailSharedRoster').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'saved Gmail roster replacement confirmation');
            assert(document.querySelector('#confirmMessage').textContent.includes('전체 교체') && document.querySelector('#confirmMessage').textContent.includes('기존 일정 배정'), 'saved Gmail roster replacement explains its impact');
            document.querySelector('#confirmDialog .dialog-footer [data-confirm-result="false"]').click(); await waitFor(() => !document.querySelector('#confirmDialog').open, 'cancel saved Gmail roster replacement');
            assert((await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === smokeState.activeProjectId).data.people.map((person) => person.email).sort().join('|') === gmailPeopleBeforeReplace, 'cancelled saved Gmail roster replacement preserves the project roster');
            document.querySelector('#gmailRosterPaste').value = '이름\\t이메일\\n교체 취소\\tcancel@example.com'; document.querySelector('#applyGmailRosterPaste').click(); await waitFor(() => document.querySelector('#rosterImportPreviewDialog').open, 'pasted Gmail roster preview');
            assert(document.querySelector('#rosterImportPreviewDescription').textContent.includes('1명') && document.querySelectorAll('#rosterImportPreviewTable tbody tr').length === 1, 'pasted Gmail roster preview shows the interpreted rows');
            document.querySelector('[data-roster-import-result="apply"]').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'pasted Gmail roster replacement confirmation');
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
            assert(projectA.data.people.length === 3 && projectA.data.slots.length === 2 && projectA.data.workItems.length === 1, 'operational project data, including the added multi-day event, persisted: ' + JSON.stringify({ people: projectA.data.people.length, slots: projectA.data.slots.length, workItems: projectA.data.workItems.length }));
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
        const integrationResult = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const waitFor = async (predicate, label, timeout = 5000) => {
              const end = Date.now() + timeout;
              while (!await predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
              if (!await predicate()) throw new Error('timeout: ' + label);
            };
            const assert = (condition, label) => { if (!condition) throw new Error(label); };
            await globalThis.flushWorkspaceEdits();
            let integrationState = await globalThis.workspaceDesktop.loadState();
            let integrationProject = integrationState.projects.find((project) => project.id === integrationState.activeProjectId);
            const now = new Date().toISOString();
            const connections = [
              { id: 'smoke-drive-config-error', type: 'drive', label: '이전 Drive 설정', account: '', status: 'error', lastAuthError: '이전 Google 연결 구성 오류', createdAt: now, updatedAt: now },
              { id: 'smoke-gmail-a', type: 'gmail', label: 'Workspace Gmail A', account: 'workspace-a@example.com', status: 'connected', createdAt: now, updatedAt: now },
              { id: 'smoke-gmail-b', type: 'gmail', label: 'Workspace Gmail B', account: 'workspace-b@example.com', status: 'connected', createdAt: now, updatedAt: now },
              { id: 'smoke-zoom-a', type: 'zoom', label: 'Zoom A', account: 'zoom-a@example.com', status: 'connected', createdAt: now, updatedAt: now },
              { id: 'smoke-zoom-b', type: 'zoom', label: 'Zoom B', account: 'zoom-b@example.com', status: 'connected', createdAt: now, updatedAt: now }
            ];
            integrationState.connections = [...integrationState.connections.filter((connection) => !connection.id.startsWith('smoke-')), ...connections];
            integrationState.preferences.globalDefaultConnectionIds = { gmail: 'smoke-gmail-a', zoom: 'smoke-zoom-a' };
            integrationProject.settings.defaultConnectionIds.gmail = null;
            integrationProject.settings.defaultConnectionIds.zoom = null;
            integrationProject.installedModules = [...new Set([...integrationProject.installedModules, 'forms', 'zoom', 'gmailFlow'])];
            if (!integrationProject.workflow.some((step) => step.moduleId === 'zoom')) integrationProject.workflow.push({ id: 'smoke-zoom-step', type: 'zoom', moduleId: 'zoom', name: 'Zoom 회의', order: integrationProject.workflow.length, status: 'complete', notes: '', checklist: [], updatedAt: now });
            const smokePersonId = integrationProject.data.people[0].id;
            const smokeSlotId = integrationProject.data.slots[0].id;
            integrationProject.data.externalArtifacts = integrationProject.data.externalArtifacts.filter((artifact) => !String(artifact.externalId || '').startsWith('smoke-route-'));
            integrationProject.data.externalArtifacts.push(
              { kind: 'gmailDraft', personId: smokePersonId, connectionId: 'smoke-gmail-a', status: 'created', externalId: 'smoke-route-gmail-a', createdAt: now },
              { kind: 'zoom', slotId: smokeSlotId, connectionId: 'smoke-zoom-a', status: 'created', externalId: 'smoke-route-zoom-a', joinUrl: 'https://zoom.example/a', createdAt: now }
            );
            const overrideProject = integrationState.projects.find((project) => project.id !== integrationProject.id);
            overrideProject.settings.defaultConnectionIds.gmail = 'smoke-gmail-a';
            overrideProject.settings.defaultConnectionIds.zoom = 'smoke-zoom-a';
            overrideProject.data.externalArtifacts = overrideProject.data.externalArtifacts.filter((artifact) => !String(artifact.externalId || '').startsWith('smoke-override-'));
            overrideProject.data.externalArtifacts.push(
              { kind: 'gmailDraft', personId: 'override-person', connectionId: 'smoke-gmail-a', status: 'created', externalId: 'smoke-override-gmail-a', createdAt: now },
              { kind: 'zoom', slotId: 'override-slot', connectionId: 'smoke-zoom-a', status: 'created', externalId: 'smoke-override-zoom-a', joinUrl: 'https://zoom.example/override', createdAt: now }
            );
            integrationProject.data.forms.linkedForms = [
              { formId: 'smoke-form-first', type: 'registration', title: '신청 설문', connectionId: '', connectedAt: now },
              { formId: 'smoke-form-second', type: 'availability', title: '가능 시간 설문', connectionId: '', connectedAt: now }
            ];
            integrationProject.data.forms.selectedFormId = 'smoke-form-first';
            integrationState.library.mailTemplates = integrationState.library.mailTemplates.filter((template) => template.id !== 'smoke-mail-template');
            integrationState.library.mailTemplates.push({ id: 'smoke-mail-template', name: 'Smoke 저장 양식', subject: '저장 양식 제목', bodyHtml: '<p>저장 양식 본문</p>', savedAt: now });
            integrationState.updatedAt = now;
            const integrationSave = await globalThis.workspaceDesktop.saveState(integrationState);
            await waitFor(() => document.querySelector('#activeProjectName')?.textContent === integrationProject.name
              && Number(globalThis.__workspaceStateDeferral?.().stateRevision || 0) >= Number(integrationSave.state?._revision || 0), 'integration state applied');

            document.querySelector('[data-nav="connections"]').click();
            await waitFor(() => document.querySelector('#page-connections').classList.contains('active'), 'Workspace connection defaults page');
            await waitFor(() => document.querySelectorAll('[data-service-card]').length === 4, 'four global service cards');
            const connectionGridColumns = getComputedStyle(document.querySelector('#connectionList')).gridTemplateColumns.split(' ').filter(Boolean);
            assert(connectionGridColumns.length === 2, 'account services render as a two-column card grid on desktop');
            assert(document.querySelector('[data-service-card="gmail"] [data-service-default="gmail"]').value === 'smoke-gmail-a'
              && document.querySelector('[data-service-card="zoom"] [data-service-default="zoom"]').value === 'smoke-zoom-a'
              && document.querySelectorAll('[data-service-card="gmail"] .service-account-row').length === 2
              && document.querySelectorAll('[data-service-card="zoom"] .service-account-row').length === 2, 'Gmail and Zoom accounts and Workspace defaults stay inside their service cards');
            assert(!document.querySelector('#connectionDialog') && !document.querySelector('input[type="password"]') && !document.querySelector('[id*="ClientSecret"]'), 'card login flow removes the technical service picker and never asks for a password or client secret');
            const legacyDriveCardText = document.querySelector('[data-service-card="drive"]').textContent;
            assert(/연결 오류/.test(legacyDriveCardText)
              && !/OAuth JSON|OAuth 관리자 설정|Google Cloud|client[_ ]secret/i.test(legacyDriveCardText), 'legacy Google configuration errors are sanitized on ordinary account cards');
            const zoomCard = document.querySelector('[data-service-card="zoom"]');
            const zoomConnectionCountBeforeSetup = (await globalThis.workspaceDesktop.loadState()).connections.filter((connection) => connection.type === 'zoom').length;
            assert(zoomCard.querySelectorAll('[data-service-connect="zoom"]').length === 1
              && zoomCard.querySelector('[data-service-connect="zoom"]').textContent.includes('계정 연결')
              && !zoomCard.querySelector('input')
              && !/Public Client|allow list|허용 목록|관리자 설정/i.test(zoomCard.textContent), 'ordinary Zoom card exposes one login action and no OAuth configuration fields');
            const zoomProvider = await globalThis.workspaceDesktop.connectionProviderStatus('zoom');
            if (!zoomProvider.ready) {
              document.querySelector('[data-service-card="zoom"] [data-service-connect="zoom"]').click();
              await waitFor(() => [...document.querySelectorAll('#toastRegion .toast')].some((toast) => toast.textContent.includes('최신 설치본')), 'misconfigured Zoom build shows a user-safe update message');
              assert(!document.querySelector('#zoomPublicClientIdInput')
                && (await globalThis.workspaceDesktop.loadState()).connections.filter((connection) => connection.type === 'zoom').length === zoomConnectionCountBeforeSetup, 'missing Zoom deployment configuration never creates an account or asks the user for a client ID');
            } else {
              assert(zoomProvider.source === 'bundled', 'release Zoom login must use the bundled CMOE public client');
              const loginBrowsers = await globalThis.workspaceDesktop.listLoginBrowsers();
              assert(Array.isArray(loginBrowsers)
                && loginBrowsers.length > 0
                && loginBrowsers.every((browser) => ['system', 'windows-picker', 'chrome', 'edge'].includes(browser.id)), 'login browser choices expose only the fixed safe browser list');
              document.querySelector('[data-service-card="zoom"] [data-service-connect="zoom"]').click();
              await waitFor(() => document.querySelector('#loginBrowserDialog')?.open, 'login browser picker');
              const renderedBrowserIds = [...document.querySelectorAll('#loginBrowserChoices [data-login-browser-choice]')].map((button) => button.dataset.loginBrowserChoice);
              assert(loginBrowsers.every((browser) => renderedBrowserIds.includes(browser.id)), 'installed login browsers are rendered in the account picker');
              if (renderedBrowserIds.length > 1) {
                const browserGridColumns = getComputedStyle(document.querySelector('#loginBrowserChoices')).gridTemplateColumns.split(' ').filter(Boolean);
                assert(browserGridColumns.length === 2, 'login browser choices use a two-column card grid on desktop');
              }
              if (renderedBrowserIds.includes('chrome')) {
                const profiles = await globalThis.workspaceDesktop.listLoginBrowserProfiles('chrome');
                assert(Array.isArray(profiles)
                  && profiles.every((profile) => /^[A-Za-z0-9_-]{43}$/.test(profile.id))
                  && profiles.every((profile) => !Object.hasOwn(profile, 'executablePath') && !Object.hasOwn(profile, 'profileDirectory')), 'Chrome profile choices expose only opaque IDs and user-facing labels');
                document.querySelector('#loginBrowserDialog [data-login-browser-choice="chrome"]').click();
                await waitFor(() => document.querySelector('#loginBrowserBack') && !document.querySelector('#loginBrowserBack').hidden, 'Chrome profile picker stage');
                if (profiles.length) {
                  await waitFor(() => document.querySelectorAll('[data-login-browser-profile]').length === profiles.length, 'Chrome profile cards');
                } else {
                  await waitFor(() => !document.querySelector('#loginBrowserStatus').hidden, 'missing Chrome profile guidance');
                }
                document.querySelector('#loginBrowserBack').click();
                await waitFor(() => document.querySelector('#loginBrowserBack').hidden && document.querySelector('[data-login-browser-choice="chrome"]'), 'return to browser picker');
              }
              document.querySelector('#loginBrowserDialog [data-login-browser-choice=""]').click();
              await waitFor(() => !document.querySelector('#loginBrowserDialog')?.open, 'login browser picker cancellation');
              assert((await globalThis.workspaceDesktop.loadState()).connections.filter((connection) => connection.type === 'zoom').length === zoomConnectionCountBeforeSetup, 'canceling the browser picker does not create an empty account');

              let deletionState = await globalThis.workspaceDesktop.loadState();
              deletionState.connections.push({ id: 'smoke-zoom-error-delete', type: 'zoom', label: '삭제할 Zoom 오류 계정', account: '', status: 'error', lastAuthError: 'Zoom 로그인 확인 필요', createdAt: now, updatedAt: now });
              await globalThis.workspaceDesktop.saveState(deletionState);
              await waitFor(() => document.querySelector('[data-connection-remove="smoke-zoom-error-delete"]'), 'failed Zoom account row');
              const heldConnectionReservation = await globalThis.workspaceDesktop.reserveExternalArtifacts('workspace-connections', 'connection', ['smoke-zoom-error-delete']);
              assert(heldConnectionReservation.ok, 'failed account deletion smoke holds a competing connection reservation');
              document.querySelector('[data-connection-remove="smoke-zoom-error-delete"]').click();
              await waitFor(() => document.querySelector('#confirmDialog')?.open, 'failed account delete confirmation');
              document.querySelector('#confirmAction').click();
              await waitFor(async () => !(await globalThis.workspaceDesktop.loadState()).connections.some((connection) => connection.id === 'smoke-zoom-error-delete'), 'failed account deleted despite competing reservation');
              assert(!document.querySelector('[data-connection-remove="smoke-zoom-error-delete"]'), 'failed account disappears immediately after deletion');
              await globalThis.workspaceDesktop.releaseExternalArtifacts(heldConnectionReservation.token);
            }
            document.querySelector('[data-service-card="zoom"] [data-service-default="zoom"]').value = 'smoke-zoom-b';
            document.querySelector('[data-service-card="zoom"] [data-service-default="zoom"]').dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(async () => {
              const saved = await globalThis.workspaceDesktop.loadState();
              const project = saved.projects.find((item) => item.id === saved.activeProjectId);
              const overridden = saved.projects.find((item) => item.id !== saved.activeProjectId);
              return saved.preferences.globalDefaultConnectionIds.zoom === 'smoke-zoom-b'
                && project.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-route-zoom-a')?.status === 'superseded'
                && project.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-route-gmail-a')?.status === 'stale'
                && project.moduleState.gmailFlow.status === 'stale'
                && overridden.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-override-zoom-a')?.status === 'created'
                && overridden.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-override-gmail-a')?.status === 'created';
            }, 'Workspace Zoom default invalidates inherited Zoom links and Gmail drafts only');
            document.querySelector('[data-service-card="gmail"] [data-service-default="gmail"]').value = 'smoke-gmail-b';
            document.querySelector('[data-service-card="gmail"] [data-service-default="gmail"]').dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(async () => (await globalThis.workspaceDesktop.loadState()).preferences.globalDefaultConnectionIds.gmail === 'smoke-gmail-b', 'Workspace Gmail default saved');
            await waitFor(async () => {
              const saved = await globalThis.workspaceDesktop.loadState();
              const project = saved.projects.find((item) => item.id === saved.activeProjectId);
              const overridden = saved.projects.find((item) => item.id !== saved.activeProjectId);
              return project.settings.defaultConnectionIds.gmail === null
                && project.settings.defaultConnectionIds.zoom === null
                && project.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-route-gmail-a')?.status === 'superseded'
                && project.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-route-zoom-a')?.status === 'superseded'
                && overridden.settings.defaultConnectionIds.gmail === 'smoke-gmail-a'
                && overridden.settings.defaultConnectionIds.zoom === 'smoke-zoom-a'
                && overridden.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-override-gmail-a')?.status === 'created'
                && overridden.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-override-zoom-a')?.status === 'created';
            }, 'Workspace default route artifacts superseded');
            const defaultRouteState = await globalThis.workspaceDesktop.loadState();
            const defaultRouteProject = defaultRouteState.projects.find((project) => project.id === defaultRouteState.activeProjectId);
            assert(defaultRouteProject.moduleState.gmailFlow.status === 'stale' && defaultRouteProject.moduleState.zoom.status === 'stale', 'Workspace Gmail and Zoom changes mark inherited modules stale');
            document.querySelector('#projectSettingsButton').click();
            await waitFor(() => document.querySelector('#projectSettingsDialog').open, 'project override settings');
            assert(document.querySelector('[data-default-connection-type="gmail"]').value === '' && document.querySelector('[data-default-connection-type="gmail"] option').textContent.includes('Workspace 기본값 사용'), 'project settings inherit the Workspace default unless an exception is chosen');
            document.querySelector('[data-close-dialog="projectSettingsDialog"]').click();

            document.querySelector('[data-workflow-open="forms"]').click();
            await waitFor(() => document.querySelector('#page-forms').classList.contains('active'), 'forms linked list page');
            assert(document.querySelector('#linkedFormSelect').options.length === 2 && document.querySelector('#linkedFormSelect').value === 'smoke-form-first', 'linked Forms list restores the selected form');
            document.querySelector('#linkedFormSelect').value = 'smoke-form-second';
            document.querySelector('#linkedFormSelect').dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(async () => (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === defaultRouteState.activeProjectId).data.forms.selectedFormId === 'smoke-form-second', 'selected Form persisted');
            assert(document.querySelector('#syncFormResponses').textContent.includes('응답')
              && document.querySelector('#copyLinkedForm')
              && document.querySelector('#removeLinkedForm')
              && document.querySelector('#importGoogleForm'), 'selected Form sync, import, copy, and management controls');

            const draftBeforeFreeForm = document.querySelector('#projectFormDraftSelect').value;
            document.querySelector('#newBlankForm').click();
            await waitFor(() => document.querySelector('#confirmDialog')?.open || document.querySelector('#projectFormDraftSelect').value !== draftBeforeFreeForm, 'start explicit free-form draft');
            if (document.querySelector('#confirmDialog')?.open) document.querySelector('#confirmAction').click();
            await waitFor(() => document.querySelector('#projectFormDraftSelect').value !== draftBeforeFreeForm
              && document.querySelector('#formQuestionList .form-editor-card [data-form-duplicate-item]:not(:disabled)'), 'editable free-form draft');
            await globalThis.flushWorkspaceEdits();
            await waitFor(() => !document.querySelector('.form-builder-layout')?.inert, 'Forms editor merge lock released');
            const initialDraftId = document.querySelector('#projectFormDraftSelect').value;
            const initialDraftCount = document.querySelector('#projectFormDraftSelect').options.length;
            assert(initialDraftId && initialDraftCount >= 1 && document.querySelectorAll('#formQuestionList .form-editor-card').length >= 1, 'free-form editor creates and selects an editable project draft');
            assert(!document.querySelector('#formDefinitionType, #buildFormDefinition, #downloadFormDefinition, #saveLinkedForm'), 'legacy fixed survey builder controls stay removed');
            assert(!document.querySelector('#formPreviewDialog').open, 'response preview remains closed until the bottom preview button is used');
            assert(Boolean(document.querySelector('#formQuestionList').compareDocumentPosition(document.querySelector('#previewGoogleFormDraft')) & Node.DOCUMENT_POSITION_FOLLOWING), 'response preview action stays after the question editor in the page flow');

            const titleInput = document.querySelector('#formTitleInput');
            titleInput.value = 'Smoke 자유 설문'; titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            let firstCard = document.querySelector('#formQuestionList .form-editor-card');
            let firstTitle = firstCard.querySelector('[data-form-item-field="title"]');
            firstTitle.value = '참여 방식을 선택해주세요'; firstTitle.dispatchEvent(new Event('input', { bubbles: true }));
            let firstType = firstCard.querySelector('[data-form-item-field="kind"]');
            firstType.value = 'radio'; firstType.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelectorAll('#formQuestionList [data-form-entry-kind="options"]').length >= 2, 'choice question options');
            const firstOption = document.querySelector('#formQuestionList [data-form-entry-kind="options"]');
            firstOption.value = '온라인'; firstOption.dispatchEvent(new Event('input', { bubbles: true }));
            firstType = document.querySelector('#formQuestionList .form-editor-card [data-form-item-field="kind"]');
            firstType.value = 'checkbox'; firstType.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelector('#formQuestionList .form-editor-card [data-form-item-field="kind"]')?.value === 'checkbox'
              && document.querySelector('#formQuestionList [data-form-entry-kind="options"]')?.value === '온라인', 'compatible choice type change preserves options');
            const requiredToggle = document.querySelector('#formQuestionList [data-form-item-field="required"]');
            requiredToggle.checked = true; requiredToggle.dispatchEvent(new Event('input', { bubbles: true }));
            await globalThis.flushWorkspaceEdits();
            await waitFor(() => !document.querySelector('.form-builder-layout')?.inert, 'Forms editor ready for structure actions');
            document.querySelector('#formQuestionList .form-editor-card [data-form-duplicate-item]').click();
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card').length === 2, 'question duplicate action');
            const duplicatedCards = [...document.querySelectorAll('#formQuestionList .form-editor-card')];
            const duplicatedTitles = duplicatedCards.map((card) => card.querySelector('[data-form-item-field="title"]')?.value || '');
            assert(duplicatedTitles[1].includes('복사본'), 'duplicated question title');
            document.querySelectorAll('#formQuestionList .form-editor-card')[1].querySelector('[data-form-remove-item]').click();
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card').length === 1, 'ordinary question delete action');
            assert(!document.querySelector('#undoFormStructure').disabled, 'destructive Form structure edits expose undo');
            document.querySelector('#undoFormStructure').click();
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card').length === 2, 'ordinary question delete undo');
            document.querySelectorAll('#formQuestionList .form-editor-card')[1].querySelector('[data-form-remove-item]').click();
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card').length === 1, 'ordinary question delete after undo');
            document.querySelector('#addFormQuestion').click();
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card').length === 2, 'second free-form question');
            let secondCard = document.querySelectorAll('#formQuestionList .form-editor-card')[1];
            const secondType = secondCard.querySelector('[data-form-item-field="kind"]');
            secondType.value = 'radioGrid'; secondType.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card')[1]?.querySelectorAll('[data-form-item-field="rowTitle"]').length === 1, 'grid question rows');
            secondCard = document.querySelectorAll('#formQuestionList .form-editor-card')[1]; secondCard.querySelector('[data-form-add-entry="rows"]').click();
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card')[1]?.querySelectorAll('[data-form-item-field="rowTitle"]').length === 2, 'grid row added');
            secondCard = document.querySelectorAll('#formQuestionList .form-editor-card')[1];
            const wholeGridRequired = secondCard.querySelector('[data-form-item-field="required"]'); wholeGridRequired.checked = true; wholeGridRequired.dispatchEvent(new Event('input', { bubbles: true }));
            assert([...secondCard.querySelectorAll('[data-form-item-field="rowRequired"]')].every((control) => control.checked), 'whole-grid required immediately checks every visible row');
            wholeGridRequired.checked = false; wholeGridRequired.dispatchEvent(new Event('input', { bubbles: true }));
            assert([...secondCard.querySelectorAll('[data-form-item-field="rowRequired"]')].every((control) => !control.checked), 'whole-grid required immediately clears every visible row');
            const firstRowRequired = secondCard.querySelector('[data-form-item-field="rowRequired"]'); firstRowRequired.checked = true; firstRowRequired.dispatchEvent(new Event('input', { bubbles: true }));
            secondCard.querySelectorAll('[data-form-remove-entry="rows"]')[1].click();
            await waitFor(() => {
              const card = document.querySelectorAll('#formQuestionList .form-editor-card')[1];
              return card?.querySelectorAll('[data-form-item-field="rowTitle"]').length === 1 && card.querySelector('[data-form-item-field="required"]')?.checked;
            }, 'grid whole-required state recalculated after row deletion');
            secondCard = document.querySelectorAll('#formQuestionList .form-editor-card')[1]; secondCard.querySelector('[data-form-add-entry="rows"]').click();
            await waitFor(() => [...document.querySelectorAll('#formQuestionList .form-editor-card')[1].querySelectorAll('[data-form-item-field="rowRequired"]')].length === 2
              && [...document.querySelectorAll('#formQuestionList .form-editor-card')[1].querySelectorAll('[data-form-item-field="rowRequired"]')].every((control) => control.checked), 'new grid row inherits recalculated whole-required state');

            const quizToggle = document.querySelector('#formQuizMode');
            quizToggle.checked = true; quizToggle.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelector('#formQuestionList .form-grading-editor'), 'quiz grading editor');
            const gradingAnswer = document.querySelector('#formQuestionList [data-form-item-field="correctAnswers"]');
            gradingAnswer.value = '온라인'; gradingAnswer.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#formQuestionList [data-form-clear-grading]').click();
            await waitFor(() => document.querySelector('#formQuestionList [data-form-item-field="correctAnswers"]')?.value === '', 'question grading cleared independently');
            const restoredGradingAnswer = document.querySelector('#formQuestionList [data-form-item-field="correctAnswers"]'); restoredGradingAnswer.value = '온라인'; restoredGradingAnswer.dispatchEvent(new Event('input', { bubbles: true }));
            quizToggle.checked = false; quizToggle.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(() => document.querySelector('#confirmDialog')?.open, 'quiz grading removal confirmation');
            document.querySelector('#confirmAction').click();
            await waitFor(() => !document.querySelector('#formQuizMode').checked && !document.querySelector('#formQuestionList .form-grading-editor'), 'quiz grading safely removed');

            const cspViolations = [];
            const cspListener = (event) => { if (event.effectiveDirective === 'img-src') cspViolations.push(event.blockedURI); };
            document.addEventListener('securitypolicyviolation', cspListener);
            document.querySelector('[data-add-form-item="image"]').click();
            await waitFor(() => document.querySelectorAll('#formQuestionList .form-editor-card').length === 3, 'image item added');
            const imageCard = document.querySelectorAll('#formQuestionList .form-editor-card')[2];
            const imageSource = imageCard.querySelector('[data-form-item-field="sourceUri"]'); imageSource.value = 'https://example.invalid/forms-preview.png'; imageSource.dispatchEvent(new Event('input', { bubbles: true }));

            document.querySelector('#previewGoogleFormDraft').click();
            await waitFor(() => document.querySelector('#formPreviewDialog')?.open, 'explicit response preview dialog');
            assert(document.querySelector('#formDefinitionPreview').textContent.includes('Smoke 자유 설문')
              && document.querySelector('#formDefinitionPreview').textContent.includes('참여 방식을 선택해주세요')
              && document.querySelector('#formDefinitionPreview').textContent.includes('온라인'), 'preview reflects the current free-form title, question, and option');
            const previewImage = document.querySelector('#formDefinitionPreview img[src^="https://example.invalid/"]');
            assert(previewImage && previewImage.referrerPolicy === 'no-referrer', 'HTTPS form image is rendered only in explicit preview without a referrer');
            await new Promise((resolve) => setTimeout(resolve, 150));
            document.removeEventListener('securitypolicyviolation', cspListener);
            assert(!cspViolations.length, 'HTTPS form preview image is allowed by the renderer image policy');
            document.querySelector('#closeFormPreview').click();
            await waitFor(() => !document.querySelector('#formPreviewDialog').open, 'response preview close');

            document.querySelector('#saveSharedFormTemplate').click();
            await waitFor(() => document.querySelector('#nameInputDialog')?.open, 'global form template name');
            document.querySelector('#nameInputValue').value = 'Smoke 전역 설문 양식';
            document.querySelector('#nameInputForm').requestSubmit();
            await waitFor(async () => (await globalThis.workspaceDesktop.loadState()).library.formTemplates.some((template) => template.name === 'Smoke 전역 설문 양식'), 'global form template persisted');
            const formTemplateState = await globalThis.workspaceDesktop.loadState();
            const smokeFormTemplate = formTemplateState.library.formTemplates.find((template) => template.name === 'Smoke 전역 설문 양식');
            document.querySelector('#sharedFormTemplateSelect').value = smokeFormTemplate.id;
            document.querySelector('#loadSharedFormTemplate').click();
            await waitFor(() => document.querySelector('#confirmDialog')?.open, 'global form template load confirmation');
            document.querySelector('#confirmAction').click();
            await waitFor(() => document.querySelector('#projectFormDraftSelect').options.length === initialDraftCount + 1, 'global template creates a separate project draft');
            const loadedDraftId = document.querySelector('#projectFormDraftSelect').value;
            assert(loadedDraftId && loadedDraftId !== initialDraftId && document.querySelector('#formTitleInput').value === 'Smoke 자유 설문', 'loaded global template is selected without overwriting the first draft');
            document.querySelector('#projectFormDraftSelect').value = initialDraftId;
            document.querySelector('#projectFormDraftSelect').dispatchEvent(new Event('change', { bubbles: true }));
            await globalThis.flushWorkspaceEdits();
            await waitFor(async () => (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === defaultRouteState.activeProjectId).data.forms.activeDefinitionId === initialDraftId, 'project draft selector persists the active draft', 15000);

            const importedState = await globalThis.workspaceDesktop.loadState();
            const importedProject = importedState.projects.find((project) => project.id === importedState.activeProjectId);
            const importedAt = new Date().toISOString();
            const staleImportedDefinition = {
              id: 'smoke-imported-stale', schemaVersion: 2, type: 'custom', source: 'google', formId: 'smoke-imported-form',
              title: '오래된 가져오기', description: '', collectEmail: 'DO_NOT_COLLECT', settings: { emailCollectionType: 'DO_NOT_COLLECT', isQuiz: false },
              items: [{ id: 'smoke-stale-question', kind: 'shortText', title: '오래된 질문', description: '', required: false }], createdAt: importedAt, updatedAt: importedAt
            };
            const latestImportedDefinition = {
              id: 'smoke-imported-latest', schemaVersion: 2, type: 'custom', source: 'google', formId: 'smoke-imported-form',
              title: '최신 가져오기', description: '', collectEmail: 'DO_NOT_COLLECT', settings: { emailCollectionType: 'DO_NOT_COLLECT', isQuiz: false },
              items: [
                { id: 'smoke-imported-file', kind: 'fileUpload', title: '증빙 파일', description: '', required: false, readOnly: true, unsupportedReason: 'Google Forms API는 파일 업로드 질문 생성을 지원하지 않습니다.', fileUpload: {} },
                { id: 'smoke-imported-name', kind: 'shortText', title: '이름', description: '', required: false, questionImage: { contentUri: 'https://example.invalid/temporary-question.png', altText: '질문 임시 이미지' } },
                { id: 'smoke-imported-choice', kind: 'radio', title: '참여 유형', description: '', required: false, options: [
                  { id: 'smoke-imported-option-a', value: '온라인', image: { contentUri: 'https://example.invalid/temporary-option.png', altText: '선택지 임시 이미지' } },
                  { id: 'smoke-imported-option-b', value: '오프라인' }
                ] }
              ], createdAt: importedAt, updatedAt: importedAt
            };
            importedProject.data.forms.definitions = importedProject.data.forms.definitions.filter((definition) => !String(definition.id).startsWith('smoke-imported-'));
            importedProject.data.forms.definitions.push(staleImportedDefinition, latestImportedDefinition);
            importedProject.data.forms.linkedForms = importedProject.data.forms.linkedForms.filter((linked) => linked.formId !== 'smoke-imported-form');
            importedProject.data.forms.linkedForms.push({ formId: 'smoke-imported-form', definitionId: latestImportedDefinition.id, type: 'custom', title: latestImportedDefinition.title, source: 'google', connectionId: '', connectedAt: importedAt });
            importedProject.data.forms.selectedFormId = 'smoke-imported-form';
            await globalThis.workspaceDesktop.saveState(importedState);
            await waitFor(() => document.querySelector('#linkedFormSelect').value === 'smoke-imported-form', 'latest imported Form link rendered');
            document.querySelector('#copyLinkedForm').click();
            await waitFor(() => document.querySelector('#formTitleInput').value === '최신 가져오기 사본', 'linked Form copies its latest imported definition');
            assert(document.querySelector('#createGoogleForm').disabled, 'unsupported imported items block a new Google Form until repaired');
            const importedCard = (kind, title) => [...document.querySelectorAll('#formQuestionList .form-editor-card')].find((card) => card.querySelector('[data-form-item-field="kind"]')?.value === kind && (!title || card.querySelector('[data-form-item-field="title"]')?.value === title));
            const importedFileRemove = importedCard('fileUpload', '증빙 파일')?.querySelector('[data-form-remove-item]');
            assert(importedFileRemove && !importedFileRemove.disabled, 'read-only imported file upload remains removable from the copy');
            importedCard('shortText', '이름').querySelector('[data-form-remove-question-image]').click();
            await waitFor(() => importedCard('shortText', '이름')?.querySelector('[data-form-nested-group="questionImage"][data-form-item-field="sourceUri"]')?.value === ''
              && !importedCard('shortText', '이름')?.textContent.includes('임시 미리보기 주소'), 'temporary imported question image removed');
            importedCard('radio', '참여 유형').querySelector('[data-form-remove-option-image]').click();
            await waitFor(() => importedCard('radio', '참여 유형')?.querySelector('[data-form-item-field="optionImageSourceUri"]')?.value === ''
              && !importedCard('radio', '참여 유형')?.textContent.includes('임시 미리보기 주소'), 'temporary imported option image removed');
            await globalThis.flushWorkspaceEdits();
            const currentImportedFileRemove = importedCard('fileUpload', '증빙 파일')?.querySelector('[data-form-remove-item]');
            assert(currentImportedFileRemove?.isConnected && !currentImportedFileRemove.disabled, 'read-only imported item delete action remains active after image repairs');
            currentImportedFileRemove.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await waitFor(() => document.querySelector('#confirmDialog')?.open, 'read-only imported item removal confirmation');
            document.querySelector('#confirmAction').click();
            await waitFor(() => !importedCard('fileUpload', '증빙 파일') && !document.querySelector('#createGoogleForm').disabled, 'imported copy becomes creatable after unsupported content is removed');
            await globalThis.flushWorkspaceEdits();
            const repairedImportState = await globalThis.workspaceDesktop.loadState();
            const repairedImportProject = repairedImportState.projects.find((project) => project.id === repairedImportState.activeProjectId);
            const preservedOriginal = repairedImportProject.data.forms.definitions.find((definition) => definition.id === latestImportedDefinition.id);
            const repairedCopy = repairedImportProject.data.forms.definitions.find((definition) => definition.id === repairedImportProject.data.forms.activeDefinitionId);
            assert(preservedOriginal?.items.some((item) => item.kind === 'fileUpload') && preservedOriginal.items.some((item) => item.questionImage?.contentUri), 'repairing a copy never mutates the linked imported original');
            assert(repairedCopy && !repairedCopy.formId && repairedCopy.source === 'workspace' && !repairedCopy.items.some((item) => item.kind === 'fileUpload' || item.questionImage || item.options?.some((option) => option.image)), 'the repaired draft is a clean independent copy ready for creation');

            document.querySelector('#page-forms [data-nav-link="dashboard"]').click();
            document.querySelector('[data-workflow-open="zoom"]').click();
            await waitFor(() => document.querySelector('#page-zoom').classList.contains('active'), 'zoom route page');
            let zoomRouteState = await globalThis.workspaceDesktop.loadState();
            let zoomRouteProject = zoomRouteState.projects.find((project) => project.id === zoomRouteState.activeProjectId);
            zoomRouteProject.data.externalArtifacts.push(
              { kind: 'zoom', slotId: smokeSlotId, connectionId: 'smoke-zoom-b', status: 'created', externalId: 'smoke-route-zoom-b', joinUrl: 'https://zoom.example/b', createdAt: new Date().toISOString() },
              { kind: 'gmailDraft', personId: smokePersonId, connectionId: 'smoke-gmail-b', status: 'created', externalId: 'smoke-route-gmail-b-slot', createdAt: new Date().toISOString() }
            );
            await globalThis.workspaceDesktop.saveState(zoomRouteState);
            await waitFor(() => document.querySelector('[data-zoom-slot-connection="' + smokeSlotId + '"]') && document.querySelector('#zoomPlanTable').textContent.includes('만들기 완료'), 'per-slot Zoom route control');
            const zoomRouteSelect = document.querySelector('[data-zoom-slot-connection="' + smokeSlotId + '"]');
            zoomRouteSelect.value = 'smoke-zoom-a'; zoomRouteSelect.dispatchEvent(new Event('change', { bubbles: true }));
            await waitFor(async () => {
              const saved = await globalThis.workspaceDesktop.loadState();
              const project = saved.projects.find((item) => item.id === saved.activeProjectId);
              return project.data.slots.find((slot) => slot.id === smokeSlotId)?.zoomConnectionId === 'smoke-zoom-a'
                && project.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-route-zoom-b')?.status === 'superseded'
                && project.data.externalArtifacts.find((artifact) => artifact.externalId === 'smoke-route-gmail-b-slot')?.status === 'stale'
                && project.moduleState.gmailFlow.status === 'stale';
            }, 'per-slot Zoom route artifact superseded');

            document.querySelector('#page-zoom [data-nav-link="dashboard"]').click();
            document.querySelector('[data-workflow-open="gmailFlow"]').click();
            await waitFor(() => document.querySelector('#page-gmailFlow').classList.contains('active'), 'Gmail integration page');
            assert(document.querySelector('#gmailFlowAccountText').textContent.includes('workspace-b@example.com') && document.querySelector('#gmailFlowAccountStatus').textContent.includes('Workspace 기본 계정'), 'Gmail account chip uses the Workspace default connection');
            assert(document.querySelector('#legacyGmailFlowStatus').textContent.includes('같은 Workspace 계정'), 'standalone Gmail Flow must advertise the same Workspace Gmail account');
            document.querySelector('#sharedMailTemplateSelect').value = 'smoke-mail-template'; document.querySelector('#loadSharedMailTemplate').click();
            await waitFor(async () => (await globalThis.workspaceDesktop.loadState()).projects.find((project) => project.id === defaultRouteState.activeProjectId).data.communication.subjectTemplate === '저장 양식 제목', 'loaded mail template persisted');
            document.querySelector('#page-gmailFlow [data-nav-link="dashboard"]').click();
            document.querySelector('[data-workflow-open="gmailFlow"]').click();
            await waitFor(() => document.querySelector('#mailSubjectTemplate').value === '저장 양식 제목' && document.querySelector('#mailBodyEditor').textContent.includes('저장 양식 본문'), 'loaded mail template survives navigation');
            document.querySelector('#page-gmailFlow [data-nav-link="dashboard"]').click();
            return { passed: true };
          })()
        `);
        if (!result?.passed || !integrationResult?.passed) throw new Error('Workspace renderer smoke did not return success.');
        await mainWindow.webContents.executeJavaScript(`(async () => {
          const end = Date.now() + 5000;
          document.querySelector('[data-workflow-open="forms"]').click();
          while (!document.querySelector('#page-forms')?.classList.contains('active') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
          if (!document.querySelector('#page-forms')?.classList.contains('active')) throw new Error('Timed out waiting for Google Forms editor preview.');
          document.querySelector('#toastRegion').replaceChildren(); document.querySelector('#page-forms').scrollIntoView({ block: 'start' });
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-google-forms-editor-smoke.png', 'Workspace Google Forms editor preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#page-forms [data-nav-link="dashboard"]').click();`);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#toastRegion').replaceChildren(); document.querySelector('#dashboardContent').scrollIntoView({block:'start'});`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-workflow-smoke.png', 'Workspace workflow preview');
        await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label) => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          document.querySelector('[data-nav="connections"]').click();
          await waitFor(() => document.querySelector('#page-connections')?.classList.contains('active'), 'connection preview page');
          await waitFor(() => document.querySelectorAll('[data-service-card]').length === 4, 'connection service card preview');
          const provider = await globalThis.workspaceDesktop.connectionProviderStatus('forms');
          if (!provider?.ready || provider?.requiresClientSecret) throw new Error('Packaged Google connections must be ready before the user clicks login.');
          const formsCard = document.querySelector('[data-service-card="forms"]');
          const loginButton = formsCard.querySelector('[data-service-connect="forms"]');
          if (!loginButton || !loginButton.textContent.includes('Google')) throw new Error('Google card must expose one direct login action.');
          if (document.querySelector('[data-google-oauth-admin-import], [data-google-oauth-admin-reset], .connection-admin-settings, input[type="password"], input[name*="secret" i]')) throw new Error('The packaged app must never expose runtime OAuth setup controls.');
          if (/OAuth JSON|최초 1회|최초1회|관리자용 연결 설정|Google Cloud|Client Secret|Client ID/i.test(document.querySelector('#page-settings')?.innerText || '')) throw new Error('Packaged settings must use user-facing login language only.');
          document.querySelector('#toastRegion').replaceChildren(); window.scrollTo({ top: 0, behavior: 'instant' });
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-account-login-smoke.png', 'Workspace account login preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-nav="dashboard"]').click();`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label) => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          document.querySelector('[data-workflow-open="projectCalendar"]').click();
          await waitFor(() => document.querySelector('#page-projectCalendar')?.classList.contains('active'), 'project calendar preview page');
          await waitFor(() => document.querySelector('[data-session-overview]'), 'project calendar session overview preview');
          document.querySelector('[data-session-open-legacy]').click();
          await waitFor(() => !document.querySelector('#legacyCalendarWorkspace').hidden, 'project calendar legacy preview');
          await waitFor(() => document.querySelectorAll('#projectCalendarGrid [data-calendar-date]').length === 42 && document.querySelector('[data-calendar-event]'), 'project calendar preview events');
          const event = document.querySelector('[data-calendar-event]');
          if (!event.classList.contains('phase-past')) throw new Error('Project calendar preview event should show its past state.');
          event.click(); await waitFor(() => !document.querySelector('#calendarDetail').hidden, 'project calendar preview detail');
          if (!document.querySelector('#calendarAgenda .calendar-agenda-item')) throw new Error('Project calendar preview should include the saved activity.');
          document.querySelector('#toastRegion').replaceChildren(); document.querySelector('#page-projectCalendar').scrollIntoView({block:'start'});
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-project-calendar-smoke.png', 'Workspace project calendar preview');
        writeSmokeResult('running', { step: 'project-calendar-preview' });
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#page-projectCalendar [data-nav-link="dashboard"]').click()`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await mainWindow.webContents.executeJavaScript(`document.querySelector('#newProjectButton').click()`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-template-picker-smoke.png', 'Workspace template picker preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-close-dialog="newProjectDialog"]').click()`);
        await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label) => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          const assert = (condition, label) => { if (!condition) throw new Error(label); };
          const trigger = document.createElement('button'); trigger.type = 'button'; trigger.dataset.navLink = 'documentEditor'; document.body.append(trigger); trigger.click(); trigger.remove();
          await waitFor(() => document.querySelector('#page-documentEditor')?.classList.contains('active'), 'document editor preview page');
          const topModes = [...document.querySelectorAll('#page-documentEditor > .document-mode-picker [data-document-mode]')];
          assert(topModes.length === 5, 'document editor must expose five concise primary modes');
          assert(topModes.map((button) => button.querySelector('strong')?.textContent.trim()).join('|') === '변환|합치기|나누기|정리|일괄 만들기', 'document editor primary modes must remain short and clear');
          const ui = globalThis.CMOEDocumentToolsUI;
          const settleRoute = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const sourceSelect = document.querySelector('#documentConversionSource');
          const sourceIcon = document.querySelector('#documentConversionSourceIcon');
          const sourceSummary = document.querySelector('#documentConversionSourceSummary');
          const targetValues = () => [...document.querySelectorAll('#documentConversionTargets [data-document-target]')].map((button) => button.dataset.documentTarget);
          const chooseSource = async (extension) => { sourceSelect.value = extension; sourceSelect.dispatchEvent(new Event('change', { bubbles: true })); await settleRoute(); };
          const conversionCatalog = ui.converter.capabilities?.conversionCatalog;
          assert(Boolean(document.querySelector('#documentConversionRoutePicker') && sourceSelect && sourceSummary), 'conversion must begin with a visible source-to-target route picker');
          assert(sourceSelect.value === '' && sourceSummary.textContent.includes('자동 감지 → PDF'), 'conversion must initially explain automatic source detection to PDF');
          const initialPdfMark = document.querySelector('#documentConversionTargets [data-document-target="pdf"] [data-document-format-icon="pdf"]');
          assert(sourceIcon?.dataset.documentFormatIcon === 'auto' && sourceIcon.getAttribute('aria-hidden') === 'true' && sourceIcon.textContent.trim() && initialPdfMark?.getAttribute('aria-hidden') === 'true' && initialPdfMark.textContent.trim(), 'automatic source and PDF target must expose decorative visible format marks');
           assert(Array.isArray(conversionCatalog?.sources) && conversionCatalog.sources.length === 19, 'renderer must receive the complete backend conversion catalog');
           assert(conversionCatalog.sources.reduce((sum, source) => sum + source.targets.length, 0) === 121, 'renderer must expose exactly the documented 121 conversion routes');
           for (const source of conversionCatalog.sources) {
             await chooseSource(source.extension);
             assert(targetValues().join('|') === source.targets.join('|'), source.extension.toUpperCase() + ' targets must match the backend conversion catalog');
             assert(sourceIcon.dataset.documentFormatIcon === source.extension && sourceIcon.getAttribute('aria-hidden') === 'true' && sourceIcon.textContent.trim() && [...document.querySelectorAll('#documentConversionTargets [data-document-target]')].every((button) => { const mark = button.querySelector('[data-document-format-icon="' + button.dataset.documentTarget + '"]'); return mark?.getAttribute('aria-hidden') === 'true' && mark.textContent.trim() && button.getAttribute('aria-label')?.toLowerCase().includes(button.dataset.documentTarget); }), source.extension.toUpperCase() + ' route must render matching decorative marks while preserving full button labels');
           }
           await chooseSource('hwp');
           assert(targetValues().join('|') === 'pdf|docx|odt|rtf|hwpx' && sourceSummary.textContent.includes('HWP → PDF'), 'HWP must expose only verified Hancom Writer results');
           const firstRouteTarget = document.querySelector('#documentConversionTargets [data-document-target]');
           firstRouteTarget.focus(); firstRouteTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await settleRoute();
           const focusedRouteTarget = document.activeElement;
           assert(focusedRouteTarget?.dataset.documentTarget === 'docx' && focusedRouteTarget.getAttribute('aria-checked') === 'true', 'result-format radio cards must support keyboard selection with matching focus state');
           await chooseSource('docx');
           assert(targetValues().includes('hwp') && targetValues().includes('hwpx') && sourceSummary.textContent.includes('DOCX → PDF'), 'DOCX must expose direct HWP and HWPX results');
           await chooseSource('docm');
           assert(!targetValues().includes('hwp') && !targetValues().includes('hwpx'), 'undocumented DOCM-to-Hancom routes must remain hidden');
           await chooseSource('xlsx');
           assert(targetValues().includes('cell') && targetValues().includes('nxl') && sourceSummary.textContent.includes('XLSX → PDF'), 'XLSX must expose direct CELL and NXL results');
           await chooseSource('xlsb');
           assert(!targetValues().includes('cell') && !targetValues().includes('nxl'), 'undocumented XLSB-to-Hancom routes must remain hidden');
          window.__documentGuideSnapshotExpected = { sourceExtension: ui.converter.sourceExtension, targetExtension: ui.converter.targetExtension };
          const mergeModes = [...document.querySelectorAll('[data-document-merge-mode]')];
          assert(mergeModes.length === 5 && mergeModes.map((button) => button.dataset.documentMergeMode).join('|') === 'pdfMerge|pptxMerge|wordMerge|excelMerge|documentPdfMerge', 'merge mode must expose PDF, PowerPoint, Word, Excel, and mixed documents in a predictable order');
          assert(Boolean(document.querySelector('#certificateDependencyCard') && document.querySelector('#prepareCertificateDependencies')), 'certificate mode must expose one-click dependency preparation');
          ui.enterGuideDemo('documentEditor');
          ui.simulateGuideAction('document-pptx-files');
          assert(sourceSummary.textContent.includes('PPTX·DOCX·HWPX → PDF'), 'automatic mixed conversion must show the actual detected source formats');
          assert([...document.querySelectorAll('#pptxPdfFileList .document-file-row-with-format')].length === 3 && [...document.querySelectorAll('#pptxPdfFileList [data-document-format-icon]')].map((node) => node.dataset.documentFormatIcon).join('|') === 'pptx|docx|hwpx' && [...document.querySelectorAll('#pptxPdfFileList [data-document-format-icon]')].every((node) => node.getAttribute('aria-hidden') === 'true' && node.textContent.trim()), 'conversion file rows must expose one decorative matching format mark per selected file');
          sourceSelect.value = 'pptx'; sourceSelect.dispatchEvent(new Event('change', { bubbles: true })); await settleRoute();
          assert(ui.converter.files.length === 3 && !document.querySelector('#documentConversionSourceMismatch').hidden && document.querySelector('#runPptxPdf').disabled, 'direct source mismatch must preserve the file list, explain the mismatch, and block conversion');
          ui.converter.routeChecking = true; ui.setDocumentMode('pptxPdf', { force: true });
          assert(sourceSelect.disabled && document.querySelector('#choosePptxFiles').disabled && document.querySelector('#choosePptxPdfOutput').disabled && document.querySelector('#runPptxPdf').disabled && [...document.querySelectorAll('#documentConversionTargets button, [data-pptx-remove]')].every((button) => button.disabled), 'conversion route checking must lock every route and file mutation');
          ui.converter.routeChecking = false; ui.setDocumentMode('pptxPdf', { force: true });
          sourceSelect.value = ''; sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
          await waitFor(() => !ui.converter.routeChecking, 'automatic mixed conversion route');
          assert(document.querySelector('#documentConversionSourceMismatch').hidden && sourceSummary.textContent.includes('PPTX·DOCX·HWPX'), 'returning to automatic detection must clear the mismatch without deleting files');
          ui.simulateGuideAction('document-merge-documents-files'); ui.simulateGuideAction('document-merge-documents-output'); ui.simulateGuideAction('document-merge-documents-run');
          const mixedState = ui.mergeStates.documentPdfMerge;
          assert(mixedState.files.map((file) => file.extension).join('|') === 'pptx|hwpx|xlsx' && mixedState.completed && !document.querySelector('#previewDocumentMergeOutput').hidden, 'mixed document merge guide must reach a previewable PDF result in source order');

          ui.simulateGuideAction('document-merge-word-files');
          const wordState = ui.mergeStates.wordMerge;
          const originalWordNames = wordState.files.map((file) => file.name);
          const renderedWordNames = [...document.querySelectorAll('#documentMergeFileList [data-document-merge-index] .document-file-copy strong')].map((node) => node.textContent.trim());
          assert(JSON.stringify(originalWordNames) === JSON.stringify(['과정 운영 계획.docx', '참가자 안내.doc', '결과 보고서.odt']) && JSON.stringify(renderedWordNames) === JSON.stringify(originalWordNames), 'Word merge must preserve the selected document order in state and on screen');
          assert(document.querySelector('#documentMergeFileSummary').textContent.includes('새 페이지') && [...document.querySelectorAll('#documentMergePreview .document-merge-preview-item small')].every((node) => node.textContent.includes('다음 문서는 새 페이지에서 시작')), 'Word merge preview must explain the next-page boundary without promising fixed final page ranges');
          document.querySelector('#reverseDocumentMergeFiles').click();
          assert(JSON.stringify(wordState.files.map((file) => file.name)) === JSON.stringify(originalWordNames.slice().reverse()), 'Word merge reverse control must reverse the actual selected-document order');
          ui.simulateGuideAction('document-merge-word-output'); ui.simulateGuideAction('document-merge-word-run');
          const wordPreviewButton = document.querySelector('#previewDocumentMergeOutput');
          assert(wordState.completed && wordState.outcome === 'success' && Boolean(wordState.outputFileToken) && document.querySelector('#documentMergeOutputExtension').textContent.trim() === '.docx' && wordState.runStatus.includes('.docx') && wordState.runStatus.includes('새 페이지'), 'Word merge guide must complete as DOCX in the reversed document order with next-page semantics');
          assert(!wordPreviewButton.hidden && wordPreviewButton.textContent.includes('결과 미리보기') && !document.querySelector('#openDocumentMergeOutput').hidden, 'completed Word merge must expose the result preview and output-folder actions');

          ui.simulateGuideAction('document-merge-excel-files');
          const excelState = ui.mergeStates.excelMerge;
          const excelEngineBadge = document.querySelector('#documentMergeFormatBadge');
          const excelApplicationMark = excelEngineBadge?.querySelector('.document-application-mark-excel');
          assert(excelEngineBadge?.dataset.documentApp === 'excel' && excelEngineBadge.getAttribute('aria-label') === excelEngineBadge.textContent.replace('X', '').trim() && excelApplicationMark?.textContent === 'X' && excelApplicationMark.getAttribute('aria-hidden') === 'true', 'Microsoft Excel requirement badge must include a decorative application mark without duplicating its accessible label');
          const originalExcelNames = excelState.files.map((file) => file.name);
          const originalExcelSheetOrder = excelState.files.map((file) => file.sheets.map((sheet) => sheet.name).join('>'));
          const originalExcelFlattened = excelState.files.flatMap((file) => file.sheets.map((sheet) => sheet.name));
          assert(JSON.stringify(originalExcelNames) === JSON.stringify(['참가자.xlsx', '운영 현황.xls', '설문 결과.ods']) && originalExcelFlattened.join('|') === '명단|일정|요약|명단|응답|차트', 'Excel merge must flatten files first and then retain every worksheet and chart-sheet order');
          assert(document.querySelector('#documentMergePreview').textContent.includes('명단 (2)'), 'Excel merge preview must show the deterministic duplicate sheet-name mapping before running');
          document.querySelector('#reverseDocumentMergeFiles').click();
          const reversedExcelFlattened = excelState.files.flatMap((file) => file.sheets.map((sheet) => sheet.name));
          assert(JSON.stringify(excelState.files.map((file) => file.name)) === JSON.stringify(originalExcelNames.slice().reverse()) && reversedExcelFlattened.join('|') === '응답|차트|요약|명단|명단|일정', 'Excel merge reverse control must reverse files while preserving the sheet order inside every file');
          assert(excelState.files.every((file) => file.sheets.map((sheet) => sheet.name).join('>') === originalExcelSheetOrder[originalExcelNames.indexOf(file.name)]), 'Excel merge reversal must preserve each source workbook internal sheet order');
          ui.simulateGuideAction('document-merge-excel-output'); ui.simulateGuideAction('document-merge-excel-run');
          const excelPreviewButton = document.querySelector('#previewDocumentMergeOutput');
          assert(excelState.completed && excelState.outcome === 'success' && Boolean(excelState.outputFileToken) && document.querySelector('#documentMergeOutputExtension').textContent.trim() === '.xlsx' && excelState.runStatus.includes('.xlsx'), 'Excel merge guide must complete as XLSX in the currently selected file order');
          assert(excelState.resultSheetNames.join('|') === '응답|차트|요약|명단|명단 (2)|일정' && excelState.resultSheetCount === 6 && excelState.sourceSheetCounts.join('|') === '2|2|2', 'Excel merge result must expose the flattened six-sheet order and deterministic duplicate-name mapping');
          assert(!excelPreviewButton.hidden && excelPreviewButton.textContent.includes('결과 미리보기') && !document.querySelector('#openDocumentMergeOutput').hidden, 'completed Excel merge must expose the result preview and output-folder actions');

          ui.simulateGuideAction('document-merge-pdf-files');
          const mergeState = ui.mergeStates.pdfMerge; const originalMergeNames = mergeState.files.map((file) => file.name);
          const originalRows = [...document.querySelectorAll('#documentMergeFileList li[data-document-merge-index]')];
          assert(originalRows.every((row) => row.draggable === false), 'only the merge drag handle may be draggable');
          const handleStates = originalRows.map((row) => { const handle = row.querySelector('[data-document-merge-drag-handle]'); return { present: Boolean(handle), property: handle?.draggable, attribute: handle?.getAttribute('draggable') }; });
          assert(handleStates.every((handle) => handle.present && handle.property === true && handle.attribute === 'true'), 'every idle merge row exposes a draggable handle: ' + JSON.stringify(handleStates));
          const transfer = new DataTransfer(); const firstHandle = originalRows[0].querySelector('[data-document-merge-drag-handle]'); const lastRow = originalRows.at(-1);
          firstHandle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          lastRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          lastRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          firstHandle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
          assert(JSON.stringify(mergeState.files.map((file) => file.name)) === JSON.stringify([originalMergeNames[1], originalMergeNames[2], originalMergeNames[0]]), 'drag handle changes the actual output order');
          ui.simulateGuideAction('document-merge-pdf-files');
          document.querySelector('#reverseDocumentMergeFiles').click();
          assert(JSON.stringify(mergeState.files.map((file) => file.name)) === JSON.stringify(originalMergeNames.slice().reverse()), 'reverse control changes the actual output order');
          document.querySelector('[data-document-merge-move="down"][data-document-merge-index="0"]').click();
          assert(mergeState.files[0]?.name === originalMergeNames.at(-2) && mergeState.files[1]?.name === originalMergeNames.at(-1), 'document merge down control changes the actual output order after reversal');
          const removedName = mergeState.files[1]?.name;
          document.querySelector('[data-document-merge-remove="1"]').click();
          assert(mergeState.files.length === 2 && !mergeState.files.some((file) => file.name === removedName), 'document merge remove control deletes exactly the selected file');
          ui.simulateGuideAction('document-merge-pdf-files'); ui.simulateGuideAction('document-merge-pdf-output'); ui.simulateGuideAction('document-merge-pdf-run');
          const previewButton = document.querySelector('#previewDocumentMergeOutput'); const folderButton = document.querySelector('#openDocumentMergeOutput');
          assert(!previewButton.hidden && !folderButton.hidden, 'completed merge exposes both result actions');
          document.querySelector('#reverseDocumentMergeFiles').click();
          assert(!mergeState.completed && previewButton.hidden && folderButton.hidden, 'changing file order invalidates stale result actions');
          ui.simulateGuideAction('document-merge-pdf-run');
          const folderStyle = getComputedStyle(folderButton); const folderRect = folderButton.getBoundingClientRect();
          assert(!previewButton.hidden && previewButton.textContent.includes('결과 미리보기'), 'completed merge exposes the actual result preview action');
          assert(!folderButton.hidden && folderButton.classList.contains('completion-folder-button') && folderRect.height >= 44 && folderStyle.backgroundColor !== 'rgba(0, 0, 0, 0)', 'completed output folder action is a prominent call to action');
          assert(document.querySelector('#documentMergePreviewTitle').textContent.trim() === '합칠 순서 확인', 'the order summary must not be mislabeled as a result preview');

          ui.simulateGuideAction('document-split-file');
          const splitPdfState = ui.splitStates.pdf;
          const equalSplitRows = [...document.querySelectorAll('#documentSplitPlanPreview .document-split-plan-item')];
          const equalSplitRanges = ['1–2쪽', '3–4쪽', '5–6쪽', '7–8쪽', '9–10쪽'];
          const equalSplitTotals = [...document.querySelectorAll('#documentSplitTotals strong')].map((node) => node.textContent.trim());
          assert(splitPdfState.file?.pageCount === 10 && String(splitPdfState.equalSize) === '2' && equalSplitRows.length === 5, 'a 10-page guide PDF split by two must produce five planned files');
          assert(equalSplitRanges.every((range, index) => equalSplitRows[index]?.querySelector('small')?.textContent.includes(range)), 'equal PDF split preview must show the five expected page ranges');
          assert(equalSplitTotals.join('|') === '5|10|0', 'equal PDF split totals must show five files, ten selected pages, and no omissions');

          const customSplitMethod = document.querySelector('#documentSplitMethodCustom');
          customSplitMethod.checked = true; customSplitMethod.dispatchEvent(new Event('change', { bubbles: true }));
          const customSplitRows = [...document.querySelectorAll('#documentSplitPlanPreview .document-split-plan-item')];
          const customSplitRanges = ['1, 3, 5–6쪽', '4, 7–9쪽', '2쪽'];
          const customSplitTotals = [...document.querySelectorAll('#documentSplitTotals strong')].map((node) => node.textContent.trim());
          const omissionWarning = document.querySelector('#documentSplitValidationSummary').textContent.replace(/\\s+/g, ' ').trim();
          assert(splitPdfState.method === 'custom' && splitPdfState.groups.map((group) => group.pages).join('|') === '1, 3, 5-6|4, 7-9|2' && customSplitRows.length === 3, 'custom PDF guide split must keep the three requested groups');
          assert(customSplitRanges.every((range, index) => customSplitRows[index]?.querySelector('small')?.textContent.includes(range)), 'custom PDF split preview must show each requested group in order');
          assert(customSplitTotals.join('|') === '3|9|1' && omissionWarning.includes('10') && omissionWarning.includes('선택되지') && omissionWarning.includes('포함되지'), 'custom PDF split must warn that page 10 is omitted');

          ui.simulateGuideAction('document-split-output'); ui.simulateGuideAction('document-split-run');
          const splitResultRows = [...document.querySelectorAll('#documentSplitResults .document-split-result-row')];
          const splitPreviewButtons = [...document.querySelectorAll('#documentSplitResults [data-document-split-preview]')];
          const splitFolderButton = document.querySelector('#openDocumentSplitOutput'); const splitFolderStyle = getComputedStyle(splitFolderButton); const splitFolderRect = splitFolderButton.getBoundingClientRect();
          assert(splitPdfState.completed && splitPdfState.results.length === 3 && splitResultRows.length === 3 && splitPreviewButtons.length === 3 && splitPreviewButtons.every((button) => !button.hidden && button.textContent.includes('결과 미리보기')), 'completed custom split must expose one preview action for each of the three result files');
          assert(!splitFolderButton.hidden && splitFolderButton.classList.contains('completion-folder-button') && splitFolderRect.height >= 44 && splitFolderStyle.backgroundColor !== 'rgba(0, 0, 0, 0)', 'completed split folder action must be a prominent call to action');

          const pdfSplitSnapshot = JSON.stringify({
            method: splitPdfState.method,
            equalSize: splitPdfState.equalSize,
            groups: splitPdfState.groups,
            outputToken: splitPdfState.outputToken,
            outputName: splitPdfState.outputName,
            completed: splitPdfState.completed,
            results: splitPdfState.results
          });
          const splitPptxState = ui.splitStates.pptx;
          Object.assign(splitPptxState, {
            file: { token: 'guide-split-pptx', name: '교육 운영 자료.pptx', bytes: 2482000, slideCount: 12 },
            method: 'equal', equalSize: 3, completed: false, outcome: '', results: [], progressValue: 0, progressVisible: false,
            runTitle: '나누기 준비', runStatus: '나누는 방법과 저장 폴더를 준비해주세요.'
          });
          document.querySelector('[data-document-split-kind="pptx"]').click();
          const pptxSplitRows = [...document.querySelectorAll('#documentSplitPlanPreview .document-split-plan-item')];
          assert(ui.documentSplitKind === 'pptx' && document.querySelector('#documentSplitTitle').textContent.includes('PowerPoint') && document.querySelector('#documentSplitSourceSummary').textContent.includes('12슬라이드'), 'switching to PowerPoint must render its independent 12-slide sample');
          assert(document.querySelector('#documentSplitRuleTitle').textContent.includes('슬라이드') && document.querySelector('#documentSplitPreviewTitle').textContent.includes('슬라이드') && document.querySelector('#documentSplitEqualUnitLabel').textContent.includes('슬라이드') && document.querySelector('label[for="documentSplitMethodCustom"] strong').textContent.includes('슬라이드'), 'PowerPoint split labels must dynamically use 슬라이드');
          assert(pptxSplitRows.length === 4 && ['1–3슬라이드', '4–6슬라이드', '7–9슬라이드', '10–12슬라이드'].every((range, index) => pptxSplitRows[index]?.querySelector('small')?.textContent.includes(range)), 'PowerPoint guide state must have its own slide ranges');
          const pptxEqualSize = document.querySelector('#documentSplitEqualSize'); pptxEqualSize.value = '4'; pptxEqualSize.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('[data-document-split-kind="pdf"]').click();
          assert(JSON.stringify({ method: splitPdfState.method, equalSize: splitPdfState.equalSize, groups: splitPdfState.groups, outputToken: splitPdfState.outputToken, outputName: splitPdfState.outputName, completed: splitPdfState.completed, results: splitPdfState.results }) === pdfSplitSnapshot, 'returning to PDF must restore the completed PDF split without mixing PowerPoint state');
          assert(document.querySelector('#documentSplitValidationSummary').textContent.includes('10') && document.querySelectorAll('#documentSplitResults [data-document-split-preview]').length === 3, 'restored PDF split must retain its omission warning and result preview actions');
          document.querySelector('[data-document-split-kind="pptx"]').click();
          assert(String(splitPptxState.equalSize) === '4' && document.querySelectorAll('#documentSplitPlanPreview .document-split-plan-item').length === 3, 'returning to PowerPoint must retain its independently edited split size');
          document.querySelector('[data-document-split-kind="pdf"]').click();
          document.querySelector('.document-split-output').scrollIntoView({ block: 'start' }); window.scrollBy(0, -76); document.querySelector('#toastRegion').replaceChildren();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-document-split-smoke.png', 'Workspace document split preview');
        await mainWindow.webContents.executeJavaScript(`globalThis.CMOEDocumentToolsUI.show('pptxPdf'); document.querySelector('#documentConversionRoutePicker').scrollIntoView({ block: 'start' }); window.scrollBy(0, -76);`);
        await new Promise((resolve) => setTimeout(resolve, 180));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-document-conversion-route-smoke.png', 'Workspace document conversion route preview');
        await mainWindow.webContents.executeJavaScript(`globalThis.CMOEDocumentToolsUI.show('pdfMerge'); document.querySelector('.document-merge-output').scrollIntoView({ block: 'center' });`);
        await new Promise((resolve) => setTimeout(resolve, 180));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-document-editor-smoke.png', 'Workspace document editor preview');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('.document-merge-source').scrollIntoView({ block: 'start' }); window.scrollBy(0, -76);`);
        await new Promise((resolve) => setTimeout(resolve, 180));
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-document-editor-order-smoke.png', 'Workspace document editor order controls preview');
        await mainWindow.webContents.executeJavaScript(`(() => {
          const ui = globalThis.CMOEDocumentToolsUI; const expected = window.__documentGuideSnapshotExpected;
          ui.exitGuideDemo();
          if (!expected || ui.converter.sourceExtension !== expected.sourceExtension || ui.converter.targetExtension !== expected.targetExtension) throw new Error('Document guide must restore the exact source and target route.');
          delete window.__documentGuideSnapshotExpected;
          return true;
        })()`);
        const splitFallbackSmoke = await mainWindow.webContents.executeJavaScript(`(async () => {
          const ui = globalThis.CMOEDocumentToolsUI;
          const original = {
            capabilities: ui.converter.capabilities == null ? null : JSON.parse(JSON.stringify(ui.converter.capabilities)),
            state: JSON.parse(JSON.stringify(ui.splitStates.pptx)),
            mode: ui.documentMode,
            kind: ui.documentSplitKind
          };
          window.__documentSplitFallbackSmokeRestore = original;
          ui.setDocumentSplitKind('pdf', { force: true, refresh: false }); ui.setDocumentMode('documentSplit', { force: true });
          ui.setDocumentSplitKind('pptx', { force: true, refresh: false });
          const state = ui.splitStates.pptx;
          Object.assign(state, {
            file: { token: 'smoke-split-pptx', name: '분할 호환성 확인.pptx', bytes: 1200000, slideCount: 6 },
            method: 'equal', equalSize: 2, groups: state.groups, outputToken: 'smoke-split-output', outputName: '분할 결과', requestId: '',
            running: false, cancelling: false, confirming: false, completed: false, outcome: '', results: [],
            runTitle: '나누기 준비', runStatus: '파일, 나누는 방법, 저장 폴더를 준비해주세요.', progressValue: 0, progressVisible: false,
            engine: '', compatibilityFallback: false, requiresPreview: false, warnings: []
          });
          const rerender = () => {
            const size = document.querySelector('#documentSplitEqualSize');
            size.value = String(state.equalSize); size.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const setPowerPoint = (installed, running) => {
            ui.converter.capabilities = { ...(ui.converter.capabilities || {}), powerPoint: installed, powerPointRunning: running };
            rerender();
          };
          const inspectFallback = (expectedReason) => {
            const badge = document.querySelector('#documentSplitFormatBadge');
            const notice = document.querySelector('#documentSplitFidelityNotice');
            const run = document.querySelector('#runDocumentSplit');
            return badge.classList.contains('limited')
              && badge.textContent.includes('내장 분할') && badge.textContent.includes('결과 확인 필요')
              && badge.getAttribute('aria-label') === '내장 분할 · 결과 확인 필요'
              && badge.getAttribute('aria-describedby') === 'documentSplitFidelityNotice'
              && !badge.querySelector('.document-application-mark')
              && !notice.hidden && notice.getAttribute('role') === 'status' && notice.getAttribute('aria-live') === 'polite'
              && notice.textContent.includes(expectedReason) && ['글꼴', '배치', '애니메이션', '미디어'].every((word) => notice.textContent.includes(word))
              && run.disabled === false;
          };
          setPowerPoint(false, false); const missing = inspectFallback('PowerPoint 없이');
          setPowerPoint(true, true); const running = inspectFallback('PowerPoint가 열려');
          setPowerPoint(true, false);
          const idleBadge = document.querySelector('#documentSplitFormatBadge'); const idleMark = idleBadge.querySelector('.document-application-mark-powerpoint');
          const idle = idleBadge.classList.contains('ready') && idleBadge.textContent.includes('Microsoft PowerPoint 우선')
            && idleBadge.getAttribute('aria-label') === 'Microsoft PowerPoint 우선' && idleMark?.getAttribute('aria-hidden') === 'true'
            && !idleBadge.hasAttribute('aria-describedby')
            && document.querySelector('#documentSplitFidelityNotice').hidden && document.querySelector('#runDocumentSplit').disabled === false;
          setPowerPoint(false, false);
          state.method = 'custom'; state.groups = [{ id: 'smoke-split-group', pages: '1-2, 4', name: '호환 분할 확인' }];
          ui.setDocumentSplitKind('pptx', { force: true, refresh: false });
          const run = document.querySelector('#runDocumentSplit'); const confirmDialog = document.querySelector('#confirmDialog');
          run.click();
          const confirmationDeadline = Date.now() + 3000;
          while (!confirmDialog.open && Date.now() < confirmationDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
          const confirmationText = document.querySelector('#confirmMessage').textContent;
          const combinedConfirmation = confirmDialog.open && document.querySelectorAll('dialog[open]').length === 1
            && document.querySelector('#confirmTitle').textContent.includes('PPTX 나누기 전 확인')
            && document.querySelector('#confirmAction').textContent.includes('확인하고 나누기')
            && ['내장 분할', '글꼴·배치·애니메이션·미디어', '3, 5–6', '어떤 결과 파일에도 포함되지', '원본 파일은 변경하지 않고'].every((phrase) => confirmationText.includes(phrase));
          document.querySelector('[data-confirm-result="false"]').click();
          const cancellationDeadline = Date.now() + 3000;
          while ((confirmDialog.open || state.confirming) && Date.now() < cancellationDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
          const cancelledCleanly = !confirmDialog.open && !state.confirming && !state.running && !state.completed;
          Object.assign(state, {
            groups: [
              { id: 'smoke-result-a', pages: '1-2, 4', name: '호환 분할 확인 A' },
              { id: 'smoke-result-b', pages: '3, 5-6', name: '호환 분할 확인 B' }
            ],
            completed: true, outcome: 'success', engine: 'pptx-package', compatibilityFallback: true, requiresPreview: true,
            warnings: ['내장 호환 분할 결과를 확인해주세요.'],
            results: [
              { outputName: '호환 분할 확인 A.pptx', outputFileToken: 'smoke-result-token-a', pages: [1, 2, 4], requiresPreview: true },
              { outputName: '호환 분할 확인 B.pptx', outputFileToken: 'smoke-result-token-b', pages: [3, 5, 6], requiresPreview: true }
            ],
            runTitle: 'PowerPoint 나누기 완료 · 결과 확인 필요',
            runStatus: '2개 결과 파일을 저장했습니다. 미리보기에서 글꼴·배치·애니메이션·미디어 동작을 확인해주세요.'
          });
          ui.setDocumentSplitKind('pptx', { force: true, refresh: false });
          const reviewRows = [...document.querySelectorAll('#documentSplitResults .document-split-result-row')];
          const reviewResults = !document.querySelector('#documentSplitResults').hidden && reviewRows.length === 2
            && reviewRows.every((row) => row.classList.contains('needs-review') && row.textContent.includes('확인 권장') && row.querySelector('[data-document-split-preview]'))
            && document.querySelector('#documentSplitRunTitle').textContent.includes('결과 확인 필요')
            && document.querySelector('#documentSplitRunStatus').textContent.includes('글꼴·배치·애니메이션·미디어');
          document.querySelector('#documentSplitFidelityNotice').scrollIntoView({ block: 'center' });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const visible = ui.documentMode === 'documentSplit' && !document.querySelector('#documentSplitPanel').hidden;
          return { visible, missing, running, idle, fallbackRestored: inspectFallback('PowerPoint 없이'), combinedConfirmation, cancelledCleanly, reviewResults };
        })()`);
        if (!Object.values(splitFallbackSmoke).every(Boolean)) throw new Error(`PPTX split fallback UI smoke failed: ${JSON.stringify(splitFallbackSmoke)}`);
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-document-split-fallback-smoke.png', 'Workspace PPTX split fallback preview');
        await mainWindow.webContents.executeJavaScript(`(() => {
          const ui = globalThis.CMOEDocumentToolsUI; const original = window.__documentSplitFallbackSmokeRestore;
          if (!original) throw new Error('PPTX split fallback smoke restore state is missing.');
          const state = ui.splitStates.pptx; Object.keys(state).forEach((key) => { delete state[key]; }); Object.assign(state, original.state);
          ui.converter.capabilities = original.capabilities;
          ui.setDocumentSplitKind(original.kind, { force: true, refresh: false }); ui.setDocumentMode(original.mode, { force: true });
          delete window.__documentSplitFallbackSmokeRestore;
          return true;
        })()`);
        const regularWindowBounds = mainWindow.getBounds();
        try {
          mainWindow.setSize(980, 680);
          await new Promise((resolve) => setTimeout(resolve, 200));
          const minimumWindowLayout = await mainWindow.webContents.executeJavaScript(`(async () => {
            const waitFor = async (predicate, label, timeout = 5000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
            document.querySelector('[data-workflow-open="schedule"]').click();
            await waitFor(() => document.querySelector('#page-schedule')?.classList.contains('active'), 'minimum-width schedule page');
            const setup = document.querySelector('#scheduleSetupDetails'); setup.open = true;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const editor = document.querySelector('#roleEditor'); const editorRect = editor.getBoundingClientRect();
            const roleRows = [...editor.querySelectorAll('[data-role-row]')];
            const outside = (rect, container) => rect.left < container.left - 1 || rect.right > container.right + 1;
            const roleOverflow = roleRows.some((row) => outside(row.getBoundingClientRect(), editorRect) || [...row.querySelectorAll('label,input,select,button')].some((item) => outside(item.getBoundingClientRect(), editorRect)));
            const assignmentOverflow = [...document.querySelectorAll('.session-assignment-chip')].some((chip) => { const card = chip.closest('.session-slot-card'); return card && outside(chip.getBoundingClientRect(), card.getBoundingClientRect()); });
            const navigatePage = async (pageId) => { const trigger = document.createElement('button'); trigger.type = 'button'; trigger.dataset.navLink = pageId; document.body.append(trigger); trigger.click(); trigger.remove(); await waitFor(() => document.querySelector('#page-' + pageId)?.classList.contains('active'), 'minimum-width ' + pageId + ' page'); };
            const documentToolsUi = globalThis.CMOEDocumentToolsUI;
            const compactRect = (node) => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, display: getComputedStyle(node).display, flex: getComputedStyle(node).flex, justifySelf: getComputedStyle(node).justifySelf }; };
            const converterCancel = document.querySelector('#cancelPptxPdf'); const converterCancelHidden = converterCancel.hidden; const converterCancelText = converterCancel.textContent;
            const converterRunning = documentToolsUi.converter.running; const converterCancelling = documentToolsUi.converter.cancelling;
            await navigatePage('documentEditor'); documentToolsUi.converter.running = true; documentToolsUi.converter.cancelling = true; documentToolsUi.setDocumentMode('pptxPdf', { force: true });
            await waitFor(() => !converterCancel.hidden && converterCancel.textContent === '중단 요청됨…' && document.querySelector('#runPptxPdf').textContent === '변환 중…', 'converter cancellation actions');
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const converterCard = document.querySelector('#pptxPdfRunStatus').closest('.document-run-card'); const converterActions = converterCancel.closest('.document-run-actions');
            const converterActionOverflow = outside(converterActions.getBoundingClientRect(), converterCard.getBoundingClientRect()) || [...converterActions.querySelectorAll('button')].some((button) => outside(button.getBoundingClientRect(), converterCard.getBoundingClientRect()) || button.scrollWidth > button.clientWidth + 1);
            const converterActionDiagnostics = { card: compactRect(converterCard), actions: compactRect(converterActions), buttons: [...converterActions.querySelectorAll('button')].map((button) => ({ text: button.textContent, ...compactRect(button) })) };
            const conversionRoutePicker = document.querySelector('#documentConversionRoutePicker'); const conversionRouteRect = conversionRoutePicker.getBoundingClientRect();
            const conversionRouteTargets = [...conversionRoutePicker.querySelectorAll('.document-conversion-route-controls, .document-route-selector, .document-route-target, #documentConversionSource, #documentConversionTargets')].filter((node) => node.getClientRects().length);
            const conversionRouteOverflow = conversionRoutePicker.scrollWidth > conversionRoutePicker.clientWidth + 1 || conversionRouteTargets.some((node) => outside(node.getBoundingClientRect(), conversionRouteRect) || node.scrollWidth > node.clientWidth + 2);
            documentToolsUi.converter.running = converterRunning; documentToolsUi.converter.cancelling = converterCancelling; documentToolsUi.setDocumentMode('pptxPdf', { force: true });
            const certificatePanel = document.querySelector('#certificateOutputPanel'); const certificatePanelHidden = certificatePanel.hidden;
            const certificateCancel = document.querySelector('#cancelCertificates'); const certificateCancelHidden = certificateCancel.hidden; const certificateCancelText = certificateCancel.textContent;
            const rangeSource = document.querySelector('#certificateTextRangeSource'); const rangeStatus = document.querySelector('#certificateTextRangeStatus'); const rangeApply = document.querySelector('#applyCertificateTextRange');
            rangeSource.value = '성명: 홍길동 님'; rangeSource.setSelectionRange(4, 7); rangeSource.dispatchEvent(new Event('select', { bubbles: true }));
            const certificateTextRangeControl = !rangeApply.disabled && rangeStatus.textContent.includes('홍길동') && rangeStatus.textContent.includes('3글자');
            if (!certificateTextRangeControl) throw new Error('Certificate exact-text range selection control did not recognize the dragged substring.');
            documentToolsUi.enterGuideDemo('documentEditor');
            documentToolsUi.certificate.running = true; documentToolsUi.certificate.cancelling = true; documentToolsUi.setDocumentMode('certificateMaker', { force: true }); certificatePanel.hidden = false;
            await waitFor(() => !certificateCancel.hidden && certificateCancel.textContent === '중단 요청됨…' && document.querySelector('#generateCertificates').textContent === '생성 중…', 'certificate cancellation actions');
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const certificateActions = certificateCancel.closest('.document-run-actions'); const certificateControls = certificateActions.closest('.certificate-output-controls');
            const certificateActionOverflow = outside(certificateActions.getBoundingClientRect(), certificateControls.getBoundingClientRect()) || [...certificateActions.querySelectorAll('button')].some((button) => outside(button.getBoundingClientRect(), certificateControls.getBoundingClientRect()) || button.scrollWidth > button.clientWidth + 1);
            const certificateActionDiagnostics = { controls: compactRect(certificateControls), actions: compactRect(certificateActions), buttons: [...certificateActions.querySelectorAll('button')].map((button) => ({ text: button.textContent, ...compactRect(button) })) };
            documentToolsUi.certificate.running = false; documentToolsUi.certificate.cancelling = false; documentToolsUi.setDocumentMode('certificateMaker', { force: true }); certificatePanel.hidden = false;
            const previewViewport = document.querySelector('#certificatePreviewViewport'); const previewStage = document.querySelector('#certificatePreviewStage'); const previewImage = document.querySelector('#certificatePreviewImage');
            const originalViewportStyle = previewViewport.getAttribute('style'); const originalStageStyle = previewStage.getAttribute('style'); let certificateOverlayGeometry = null;
            documentToolsUi.show('certificateMaker');
            try {
              const portraitSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><rect width="600" height="900" fill="white"/></svg>';
              const portraitUrl = 'data:image/svg+xml;base64,' + btoa(portraitSvg);
              const imageLoaded = new Promise((resolve, reject) => { previewImage.addEventListener('load', resolve, { once: true }); previewImage.addEventListener('error', reject, { once: true }); });
              documentToolsUi.certificate.template = { token: 'smoke-portrait-template', slideSize: { width: 600, height: 900 }, slides: [{ number: 1, blockCount: 2, visibleBlockCount: 2, blocks: [
                { id: 'smoke-negative-block', name: '부분 이탈', text: '부분 이탈', x: -30, y: 90, width: 180, height: 90, sourceLayer: 'master', zOrder: 1 },
                { id: 'smoke-tiny-block', name: '작은 요소', text: '작은 요소', x: 300, y: 450, width: 6, height: 4.5, sourceLayer: 'slide', zOrder: 3 }
              ] }, { number: 2, blockCount: 1, visibleBlockCount: 1, blocks: [
                { id: 'smoke-page-two-block', name: '두 번째 페이지', text: '두 번째 페이지', x: 120, y: 200, width: 360, height: 80, sourceLayer: 'slide', zOrder: 1 }
              ] }] };
              documentToolsUi.certificate.slideNumber = 1; documentToolsUi.certificate.fields = []; documentToolsUi.certificate.rows = [{ values: [] }];
              documentToolsUi.certificate.previewCache = {
                '1': { imageUrl: portraitUrl, imageWidth: 600, imageHeight: 900, slideWidth: 600, slideHeight: 900, engine: 'guide', fidelity: 'native' },
                '2': { imageUrl: portraitUrl, imageWidth: 600, imageHeight: 900, slideWidth: 600, slideHeight: 900, engine: 'guide', fidelity: 'native' }
              };
              documentToolsUi.certificate.previewCacheOrder = ['1', '2']; documentToolsUi.certificate.slideDrafts = {};
              document.querySelector('#certificateEditor').hidden = false;
              previewStage.classList.remove('actual-preview', 'fallback-preview'); previewViewport.style.width = '360px'; previewViewport.style.height = '420px'; previewViewport.style.padding = '10px';
              documentToolsUi.refreshCertificateViewer();
              await imageLoaded; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const measure = () => {
                const viewportStyle = getComputedStyle(previewViewport); const viewportRect = previewViewport.getBoundingClientRect(); const stageRect = previewStage.getBoundingClientRect(); const overlay = document.querySelector('#certificateBlockOverlay'); const overlayRect = overlay.getBoundingClientRect();
                const negativeRect = document.querySelector('[data-certificate-block="smoke-negative-block"]').getBoundingClientRect(); const tiny = document.querySelector('[data-certificate-block="smoke-tiny-block"]'); const tinyRect = tiny.getBoundingClientRect();
                const availableWidth = previewViewport.clientWidth - parseFloat(viewportStyle.paddingLeft) - parseFloat(viewportStyle.paddingRight); const availableHeight = previewViewport.clientHeight - parseFloat(viewportStyle.paddingTop) - parseFloat(viewportStyle.paddingBottom);
                const expectedWidth = Math.min(availableWidth, availableHeight * (600 / 900)); const expectedHeight = expectedWidth / (600 / 900);
                const near = (actual, expected) => Math.abs(actual - expected) <= 1.5;
                if (overlay.dataset.boundsReady !== 'true' || !near(overlayRect.left, stageRect.left) || !near(overlayRect.top, stageRect.top) || !near(overlayRect.width, stageRect.width) || !near(overlayRect.height, stageRect.height)) throw new Error('Certificate overlay and rendered slide do not share one canvas.');
                if (!near(stageRect.width, expectedWidth) || !near(stageRect.height, expectedHeight) || stageRect.bottom > viewportRect.bottom + 1 || stageRect.right > viewportRect.right + 1) throw new Error('Portrait certificate canvas did not fit inside the viewer viewport.');
                if (!near(negativeRect.left, stageRect.left - expectedWidth * .05) || !near(negativeRect.width, expectedWidth * .30)) throw new Error('Certificate overlay clamped a negative or exact-width block coordinate.');
                if (!near(tinyRect.width, expectedWidth * .01) || !near(tinyRect.height, expectedHeight * .005)) throw new Error('Certificate overlay visually enlarged a small block geometry.');
                if (Number(tiny.style.zIndex) <= Number(document.querySelector('[data-certificate-block="smoke-negative-block"]').style.zIndex)) throw new Error('Certificate overlay did not preserve source-layer and z-order stacking.');
                return { stageWidth: stageRect.width, overlayWidth: overlayRect.width, overlayHeight: overlayRect.height, tinyWidth: tinyRect.width, tinyHeight: tinyRect.height };
              };
              const beforeResize = measure(); previewViewport.style.width = '420px'; previewViewport.style.height = '500px';
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const afterResize = measure();
              if (afterResize.overlayWidth <= beforeResize.overlayWidth) throw new Error('Certificate overlay did not update after resize.');
              document.querySelector('[data-certificate-block="smoke-tiny-block"]').click();
              documentToolsUi.certificate.rows[0].values[0] = '페이지별 입력 보존';
              await documentToolsUi.switchCertificateSlide(2); await documentToolsUi.switchCertificateSlide(1);
              const draftPreserved = documentToolsUi.certificate.fields[0]?.blockId === 'smoke-tiny-block' && documentToolsUi.certificate.rows[0]?.values[0] === '페이지별 입력 보존';
              if (!draftPreserved || document.querySelectorAll('#certificateSlideRail [data-certificate-slide]').length !== 2) throw new Error('Certificate multi-page viewer did not preserve page-specific selections and rows.');
              document.querySelector('[data-certificate-block="smoke-negative-block"]').click();
              documentToolsUi.certificate.fields[0].label = '이름'; documentToolsUi.certificate.fields[1].label = '과정';
              documentToolsUi.certificate.rows = Array.from({ length: 3 }, () => ({ values: ['', ''] }));
              documentToolsUi.certificate.filenameTemplate = '{A}'; documentToolsUi.certificate.outputToken = 'smoke-output'; documentToolsUi.certificate.outputName = 'smoke-output';
              documentToolsUi.refreshCertificateViewer();
              document.querySelector('#importCertificateRoster').click();
              await waitFor(() => document.querySelector('#certificateRosterDialog').open && document.querySelector('[data-certificate-roster-source]'), 'certificate roster source picker');
              const rosterSourceCards = [...document.querySelectorAll('[data-certificate-roster-source]')];
              const rosterSourcesSeparated = rosterSourceCards.some((card) => card.textContent.includes('프로젝트')) && document.querySelector('#certificateRosterSourceList').textContent.includes('Workspace에 저장한 명단');
              const currentRosterCard = rosterSourceCards.find((card) => card.querySelector('.source-badge.current')) || rosterSourceCards.find((card) => !card.disabled); currentRosterCard?.click();
              await waitFor(() => !document.querySelector('#certificateRosterMappingStep').hidden, 'certificate roster mapping');
              const rosterMappingVisible = document.querySelectorAll('[data-certificate-roster-mapping]').length === documentToolsUi.certificate.fields.length && document.querySelector('#certificateRosterSelectedSummary').textContent.includes('프로젝트');
              document.querySelector('#certificateRosterDialog').close();
              const grid = document.querySelector('#certificateDataTable');
              const focusGridCell = (row, col) => {
                const selector = 'input[data-certificate-row="' + row + '"][data-certificate-col="' + col + '"]';
                let input = grid.querySelector(selector);
                if (!input) throw new Error('Certificate grid cell ' + row + ':' + col + ' is missing.');
                // A real pointer interaction selects the cell on mousedown before the
                // browser moves focus. Reproduce that sequence explicitly: focus()
                // alone is not a user action and can be deferred when a packaged
                // smoke window is occluded. A focusout may also commit an edit and
                // rebuild the tbody, so always return the currently connected cell.
                input.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true, cancelable: true }));
                globalThis.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
                input.focus({ preventScroll: true });
                input = grid.querySelector(selector);
                if (!input?.isConnected) throw new Error('Certificate grid cell ' + row + ':' + col + ' was detached while focusing.');
                return input;
              };
              let firstCell = focusGridCell(0, 0);
              firstCell.value = '직접 입력'; firstCell.dispatchEvent(new Event('input', { bubbles: true }));
              firstCell = grid.querySelector('input[data-certificate-row="0"][data-certificate-col="0"]');
              firstCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
              const immediateUndo = documentToolsUi.certificate.rows[0].values[0] === '';
              const undoFocusRestored = document.activeElement?.matches?.('#certificateDataTable [data-certificate-cell]');
              document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
              const immediateRedo = documentToolsUi.certificate.rows[0].values[0] === '직접 입력' && document.activeElement?.matches?.('#certificateDataTable [data-certificate-cell]');
              firstCell = focusGridCell(0, 0);
              const pasteData = new DataTransfer(); pasteData.setData('text/plain', '임찬영\\t레벨2\\n김가람\\t레벨3');
              firstCell.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: pasteData }));
              const matrixPaste = documentToolsUi.certificate.rows[0].values.join('|') === '임찬영|레벨2' && documentToolsUi.certificate.rows[1].values.join('|') === '김가람|레벨3';
              document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
              const matrixPasteUndo = documentToolsUi.certificate.rows[0].values.join('|') === '직접 입력|' && documentToolsUi.certificate.rows[1].values.join('|') === '|';
              document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
              const matrixPasteRedo = documentToolsUi.certificate.rows[0].values.join('|') === '임찬영|레벨2' && documentToolsUi.certificate.rows[1].values.join('|') === '김가람|레벨3';
              let secondCell = focusGridCell(0, 1); secondCell.setSelectionRange(0, 0); secondCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
              const singleCellDelete = documentToolsUi.certificate.rows[0].values[1] === '';
              secondCell = focusGridCell(0, 1); secondCell.value = '레벨2'; secondCell.dispatchEvent(new Event('input', { bubbles: true })); secondCell.blur();
              const columnHeader = grid.querySelector('[data-certificate-column-select="0"]'); columnHeader.click();
              const columnSelection = document.querySelector('#certificateSelectionAddress').textContent === 'A2:A4';
              const copyAnchor = document.querySelector('#certificateCellValue'); copyAnchor.focus();
              const copyAnchorFocused = document.activeElement === copyAnchor;
              const copyData = new DataTransfer(); copyAnchor.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: copyData }));
              const columnCopyText = copyData.getData('text/plain');
              const columnCopy = columnCopyText.replaceAll(String.fromCharCode(13), '').split(String.fromCharCode(10)).slice(0, 2).join('|') === '임찬영|김가람';
              const rowHeader = grid.querySelector('[data-certificate-row-select="0"]'); rowHeader.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
              const rowContextMenu = !document.querySelector('#certificateContextMenu').hidden; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              const currentRowHeader = grid.querySelector('[data-certificate-row-select="0"]'); currentRowHeader.focus({ preventScroll: true }); const cutData = new DataTransfer(); currentRowHeader.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: cutData }));
              const rowCut = cutData.getData('text/plain') === '임찬영\\t레벨2' && documentToolsUi.certificate.rows[0].values.every((value) => value === '');
              const cutFocusRestored = document.activeElement?.matches?.('#certificateDataTable [data-certificate-cell]');
              document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
              const cutUndo = documentToolsUi.certificate.rows[0].values.join('|') === '임찬영|레벨2';
              firstCell = focusGridCell(0, 0);
              const filenameExpected = '[CMOE] ICTP_Certificate_2026(레벨2 이수증)_임찬영_레벨2.pdf';
              const filenameInput = document.querySelector('#certificateFilenameTemplate'); filenameInput.value = '[CMOE] ICTP_Certificate_2026(레벨2 이수증)_{A}_{과정}.pdf'; filenameInput.dispatchEvent(new Event('input', { bubbles: true }));
              const filenamePreview = document.querySelector('#certificateFilenamePreview').textContent;
              const filenameGenerateDisabled = document.querySelector('#generateCertificates').disabled;
              const filenameValid = filenamePreview === filenameExpected && !filenameGenerateDisabled;
              filenameInput.value = '{없는열}'; filenameInput.dispatchEvent(new Event('input', { bubbles: true }));
              const unknownFilenameBlocked = filenameInput.getAttribute('aria-invalid') === 'true' && document.querySelector('#generateCertificates').disabled && document.querySelector('#saveCertificateProfile').disabled;
              filenameInput.value = '{A}'; filenameInput.dispatchEvent(new Event('input', { bubbles: true }));
              const filenameTokens = document.querySelectorAll('#certificateFilenameVariables [data-certificate-filename-token]').length;
              const certificateGridChecks = { rosterSourcesSeparated, rosterMappingVisible, immediateUndo, undoFocusRestored, immediateRedo, matrixPaste, matrixPasteUndo, matrixPasteRedo, singleCellDelete, columnSelection, copyAnchorFocused, columnCopy, columnCopyText: JSON.stringify(columnCopyText), rowContextMenu, rowCut, cutFocusRestored, cutUndo, filenameValid, unknownFilenameBlocked, filenameTokens };
              const filenameDiagnostics = { filenamePreview, filenameExpected, filenameGenerateDisabled, filenameRunStatus: document.querySelector('#certificateRunStatus').textContent, filenameTemplateState: documentToolsUi.certificate.filenameTemplate, filenameCurrentRow: documentToolsUi.certificate.currentRow, filenameCurrentValues: documentToolsUi.certificate.rows[documentToolsUi.certificate.currentRow]?.values, certificatePreviewing: documentToolsUi.certificate.previewing, certificatePdfChecked: document.querySelector('#certificateOutputPdf').checked, certificatePptxChecked: document.querySelector('#certificateOutputPptx').checked };
              if (!Object.entries(certificateGridChecks).every(([key, value]) => key === 'filenameTokens' ? value === 4 : key === 'columnCopyText' ? Boolean(columnCopy) : Boolean(value))) throw new Error('Certificate roster, data-grid, or filename-template regression failed: ' + JSON.stringify({ ...certificateGridChecks, filenameDiagnostics }));
              certificateOverlayGeometry = { beforeResize, afterResize, draftPreserved, rosterSourcesSeparated, rosterMappingVisible, gridAndFilename: { immediateUndo, undoFocusRestored, immediateRedo, matrixPaste, matrixPasteUndo, matrixPasteRedo, singleCellDelete, columnSelection, columnCopy, rowContextMenu, rowCut, cutFocusRestored, cutUndo, filenameValid, unknownFilenameBlocked, filenameTokens } };
            } finally {
              documentToolsUi.exitGuideDemo();
              if (originalViewportStyle == null) previewViewport.removeAttribute('style'); else previewViewport.setAttribute('style', originalViewportStyle);
              if (originalStageStyle == null) previewStage.removeAttribute('style'); else previewStage.setAttribute('style', originalStageStyle);
              previewStage.dispatchEvent(new Event('resize'));
            }
            converterCancel.hidden = converterCancelHidden; converterCancel.textContent = converterCancelText; certificateCancel.hidden = certificateCancelHidden; certificateCancel.textContent = certificateCancelText; certificatePanel.hidden = certificatePanelHidden;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await navigatePage('documentEditor'); documentToolsUi.enterGuideDemo('pdfMerge'); documentToolsUi.simulateGuideAction('document-merge-pdf-files'); documentToolsUi.simulateGuideAction('document-merge-pdf-output'); documentToolsUi.simulateGuideAction('document-merge-pdf-run');
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const documentPageRect = document.querySelector('#page-documentEditor').getBoundingClientRect();
            const mergeModeSwitch = document.querySelector('#documentMergeModeSwitch'); const mergeModeSwitchRect = mergeModeSwitch.getBoundingClientRect();
            const mergeModeTabs = [...mergeModeSwitch.querySelectorAll('[data-document-merge-mode]')];
            const mergeModeOverflow = mergeModeTabs.length !== 5
              || mergeModeTabs.map((button) => button.dataset.documentMergeMode).join('|') !== 'pdfMerge|pptxMerge|wordMerge|excelMerge|documentPdfMerge'
              || mergeModeSwitch.scrollWidth > mergeModeSwitch.clientWidth + 1
              || mergeModeTabs.some((button) => { const rect = button.getBoundingClientRect(); return outside(rect, mergeModeSwitchRect) || outside(rect, documentPageRect) || rect.top < mergeModeSwitchRect.top - 1 || rect.bottom > mergeModeSwitchRect.bottom + 1; });
            const mergeLayoutTargets = [...document.querySelectorAll('.document-submode-switch, .document-merge-list-toolbar, .document-merge-file-row, .document-merge-row-actions, .document-completion-actions')].filter((node) => node.getClientRects().length);
            const documentMergeOverflow = mergeLayoutTargets.some((node) => outside(node.getBoundingClientRect(), documentPageRect) || [...node.querySelectorAll('button')].some((button) => outside(button.getBoundingClientRect(), documentPageRect) || button.scrollWidth > button.clientWidth + 2));
            const mergeCompletionVisible = !document.querySelector('#previewDocumentMergeOutput').hidden && !document.querySelector('#openDocumentMergeOutput').hidden;
            documentToolsUi.exitGuideDemo();
            documentToolsUi.enterGuideDemo('documentSplit'); documentToolsUi.simulateGuideAction('document-split-file');
            const minimumSplitCustom = document.querySelector('#documentSplitMethodCustom'); minimumSplitCustom.checked = true; minimumSplitCustom.dispatchEvent(new Event('change', { bubbles: true }));
            documentToolsUi.simulateGuideAction('document-split-output'); documentToolsUi.simulateGuideAction('document-split-run');
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const splitPanel = document.querySelector('#documentSplitPanel'); const splitPanelRect = splitPanel.getBoundingClientRect();
            const splitFidelityNotice = document.querySelector('#documentSplitFidelityNotice'); const splitFidelityNoticeHidden = splitFidelityNotice.hidden;
            splitFidelityNotice.hidden = false;
            const splitFidelityNoticeAccessible = splitFidelityNotice.getAttribute('role') === 'status' && splitFidelityNotice.getAttribute('aria-live') === 'polite'
              && ['글꼴', '배치', '애니메이션', '미디어'].every((word) => splitFidelityNotice.textContent.includes(word));
            const splitLayoutTargets = [...splitPanel.querySelectorAll('.document-split-kind-switch, #documentSplitFidelityNotice, .document-split-layout, .document-split-source, .document-split-preview, .document-split-output, .document-split-method-options, .document-split-custom-controls, .document-split-group, .document-split-plan-item, .document-run-card, .document-split-result-row, #documentSplitOutputSummary, #openDocumentSplitOutput')].filter((node) => node.getClientRects().length);
            const documentSplitOverflow = splitPanel.scrollWidth > splitPanel.clientWidth + 1 || splitLayoutTargets.some((node) => outside(node.getBoundingClientRect(), documentPageRect) || node.scrollWidth > node.clientWidth + 2);
            const splitControls = [...splitPanel.querySelectorAll('button, input')].filter((node) => node.getClientRects().length);
            const documentSplitControlClipping = splitControls.some((control) => {
              const container = control.closest('.document-split-group, .document-split-kind-switch, .document-split-output, .document-split-source') || splitPanel;
              return outside(control.getBoundingClientRect(), container.getBoundingClientRect()) || control.tagName === 'BUTTON' && control.scrollWidth > control.clientWidth + 2;
            });
            const minimumSplitPreviews = [...document.querySelectorAll('#documentSplitResults [data-document-split-preview]')]; const minimumSplitFolder = document.querySelector('#openDocumentSplitOutput');
            const splitCompletionVisible = !document.querySelector('#documentSplitResults').hidden && minimumSplitPreviews.length === 3 && minimumSplitPreviews.every((button) => button.getClientRects().length && !button.hidden) && !minimumSplitFolder.hidden && minimumSplitFolder.getClientRects().length && minimumSplitFolder.classList.contains('completion-folder-button') && minimumSplitFolder.getBoundingClientRect().height >= 44;
            splitFidelityNotice.hidden = splitFidelityNoticeHidden;
            documentToolsUi.exitGuideDemo();
            await navigatePage('forms'); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const formsPage = document.querySelector('#page-forms'); const formsPageRect = formsPage.getBoundingClientRect();
            const formLayoutTargets = [...formsPage.querySelectorAll('.form-template-controls, .form-builder-layout, .form-editor-section-card, .form-editor-actions, .form-side-column > .workbench-panel')].filter((node) => node.getClientRects().length);
            const formsOverflow = formLayoutTargets.some((node) => outside(node.getBoundingClientRect(), formsPageRect));
            const formsControlClipping = [...formsPage.querySelectorAll('button, select, input, textarea')].filter((node) => node.getClientRects().length).some((node) => node.getBoundingClientRect().right > formsPageRect.right + 1 || node.scrollWidth > node.clientWidth + 2 && node.tagName === 'BUTTON');
            await navigatePage('schedule');
            const result = { innerWidth, clientWidth: document.documentElement.clientWidth, documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, roleOverflow, assignmentOverflow, converterActionOverflow, converterActionDiagnostics, conversionRouteOverflow, certificateTextRangeControl, certificateActionOverflow, certificateActionDiagnostics, mergeModeOverflow, documentMergeOverflow, mergeCompletionVisible, documentSplitOverflow, documentSplitControlClipping, splitCompletionVisible, splitFidelityNoticeAccessible, formsOverflow, formsControlClipping, certificateOverlayGeometry, roleRows: roleRows.length };
            setup.open = false;
            return result;
          })()`);
          if (minimumWindowLayout.documentOverflow || minimumWindowLayout.roleOverflow || minimumWindowLayout.assignmentOverflow || minimumWindowLayout.converterActionOverflow || minimumWindowLayout.conversionRouteOverflow || !minimumWindowLayout.certificateTextRangeControl || minimumWindowLayout.certificateActionOverflow || minimumWindowLayout.mergeModeOverflow || minimumWindowLayout.documentMergeOverflow || !minimumWindowLayout.mergeCompletionVisible || minimumWindowLayout.documentSplitOverflow || minimumWindowLayout.documentSplitControlClipping || !minimumWindowLayout.splitCompletionVisible || !minimumWindowLayout.splitFidelityNoticeAccessible || minimumWindowLayout.formsOverflow || minimumWindowLayout.formsControlClipping || !minimumWindowLayout.roleRows) throw new Error(`Minimum-window layout overflow: ${JSON.stringify(minimumWindowLayout)}`);
          writeSmokeResult('running', { step: 'minimum-window-layout', layout: minimumWindowLayout });
        } finally {
          mainWindow.setBounds(regularWindowBounds);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label) => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          document.querySelector('[data-workflow-open="schedule"]').click();
          await waitFor(() => document.querySelector('#page-schedule')?.classList.contains('active'), 'schedule screenshot page');
          await waitFor(() => document.querySelectorAll('[data-session-assignment]').length === 3 && document.querySelectorAll('[data-session-slot]').length === 2, 'consistent schedule screenshot state');
          document.querySelector('#sessionAddEmptyTime').click();
          await waitFor(() => document.querySelector('#calendarEventDialog').open, 'visual target slot dialog');
          document.querySelector('#calendarEventTitle').value = '변경 후보'; document.querySelector('#calendarEventStartDate').value = '2026-07-06'; document.querySelector('#calendarEventEndDate').value = '2026-07-06'; document.querySelector('#calendarEventStartTime').value = '11:00'; document.querySelector('#calendarEventEndTime').value = '12:00'; document.querySelector('#calendarEventForm').requestSubmit();
          await waitFor(() => document.querySelectorAll('[data-session-slot]').length === 3, 'visual target slot');
          document.querySelector('[data-session-assignment]').click();
          await waitFor(() => !document.querySelector('#sessionSelectedPersonPanel').hidden, 'selected customer');
          [...document.querySelectorAll('[data-session-slot]')].find((card) => card.textContent.includes('11:00–12:00'))?.click();
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
        while (!await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('[data-session-slot]').length === 2`) && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
        if (!await mainWindow.webContents.executeJavaScript(`document.querySelectorAll('[data-session-slot]').length === 2`)) throw new Error('Timed out waiting for visual target cleanup.');
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
            const pending = await globalThis.flushWorkspaceEdits();
            const dirtyDeferred = pending?.ok === true && pending?.localSaved === true && pending?.remotePending === true
              && /연결된 Google 계정/.test(pending.remoteError || '') && cloudSyncTracker.dirty;
            cloudSyncTracker.clear(); state.connectedEmail = 'smoke@example.com';
            const beforeDraft = await storage.get(WORKSPACE_DRAFT_KEY, null);
            const expectedRevision = cloudSyncTracker.capture(); const expectedContext = captureCloudSyncContext();
            const applyPromise = applyCloudSnapshot({ format: 'gmail-flow-cloud-sync', schemaVersion: 1, data: { savedRosters: [], templates: [], structureTemplates: [], workspaceDraft: { remote: true } } }, { id: 'remote-smoke' }, expectedRevision, expectedContext);
            cloudSyncContextRevision += 1; state.dataStorageMode = 'local';
            const staleApplyBlocked = await applyPromise === false && JSON.stringify(await storage.get(WORKSPACE_DRAFT_KEY, null)) === JSON.stringify(beforeDraft);
            return clean === true && dirtyDeferred && staleApplyBlocked;
          } finally {
            state.dataStorageMode = previousMode; state.connectedEmail = previousEmail; cloudSyncContextRevision = previousContextRevision; cloudSyncTracker.clear();
          }
        })()`);
        if (disconnectedCleanFlush !== true) throw new Error('Drive close flush did not preserve clean, locally-saved pending, and mode-switch states.');
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
          input.value = 'ABCDE'; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); input.scrollIntoView({ block: 'center', inline: 'center' }); const bounds = input.getBoundingClientRect();
          return { x: Math.round(bounds.right - 6), y: Math.round(bounds.top + bounds.height / 2) };
        })()`);
        if (!singleCellSetup) throw new Error('Single roster cell did not enter text editing mode.');
        rosterManager.focus(); rosterManager.webContents.focus();
        rosterManager.webContents.sendInputEvent({ type: 'mouseMove', x: singleCellSetup.x, y: singleCellSetup.y });
        rosterManager.webContents.sendInputEvent({ type: 'mouseDown', x: singleCellSetup.x, y: singleCellSetup.y, button: 'left', clickCount: 1 });
        rosterManager.webContents.sendInputEvent({ type: 'mouseUp', x: singleCellSetup.x, y: singleCellSetup.y, button: 'left', clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 75));
        const trustedCaretReady = await rosterManager.webContents.executeJavaScript(`(() => { const input = document.querySelector('#rosterBody input[data-row-index="0"][data-column-index="0"]'); const cell = input?.closest('[data-sheet-row][data-sheet-column]'); return document.activeElement === input && input.selectionStart === 5 && input.selectionEnd === 5 && cell?.classList.contains('selection-anchor') && !cell.classList.contains('selected-cell'); })()`);
        if (!trustedCaretReady) throw new Error('Trusted roster input click did not preserve native caret editing.');
        rosterManager.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); rosterManager.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const singleCellEdited = await rosterManager.webContents.executeJavaScript(`document.querySelector('#rosterBody input[data-row-index="0"]')?.value === 'ABCD'`);
        if (!singleCellEdited) throw new Error('Backspace cleared a roster cell instead of deleting one character.');
        const trustedDragCoordinates = await rosterManager.webContents.executeJavaScript(`(() => {
          const first = document.querySelector('#rosterBody [data-sheet-row="0"][data-sheet-column="0"] input'); const second = document.querySelector('#rosterBody [data-sheet-row="1"][data-sheet-column="0"] input'); if (!first || !second) return null;
          second.scrollIntoView({ block: 'center', inline: 'center' }); document.activeElement?.blur(); const firstBounds = first.getBoundingClientRect(); const secondBounds = second.getBoundingClientRect();
          return { first: { x: Math.round(firstBounds.left + Math.min(18, firstBounds.width / 3)), y: Math.round(firstBounds.top + firstBounds.height / 2) }, second: { x: Math.round(secondBounds.left + Math.min(18, secondBounds.width / 3)), y: Math.round(secondBounds.top + secondBounds.height / 2) } };
        })()`);
        if (!trustedDragCoordinates) throw new Error('Trusted roster drag coordinates were not available.');
        const sendRosterMouse = (type, point, extra = {}) => rosterManager.webContents.sendInputEvent({ type, x: point.x, y: point.y, ...extra });
        sendRosterMouse('mouseMove', trustedDragCoordinates.first); sendRosterMouse('mouseDown', trustedDragCoordinates.first, { button: 'left', clickCount: 1 }); sendRosterMouse('mouseUp', trustedDragCoordinates.first, { button: 'left', clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await rosterManager.webContents.executeJavaScript(`document.querySelector('#rosterBody [data-sheet-row="0"][data-sheet-column="0"] input')?.select()`);
        sendRosterMouse('mouseMove', trustedDragCoordinates.first); sendRosterMouse('mouseDown', trustedDragCoordinates.first, { button: 'left', clickCount: 1 });
        sendRosterMouse('mouseMove', { x: trustedDragCoordinates.first.x + 3, y: trustedDragCoordinates.first.y }, { button: 'left', modifiers: ['leftButtonDown'] });
        await new Promise((resolve) => setTimeout(resolve, 40));
        sendRosterMouse('mouseMove', trustedDragCoordinates.second, { button: 'left', modifiers: ['leftButtonDown'] }); sendRosterMouse('mouseUp', trustedDragCoordinates.second, { button: 'left', clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const trustedInputDrag = await rosterManager.webContents.executeJavaScript(`(() => ({ selected: document.querySelectorAll('#rosterBody .selected-cell').length, anchors: document.querySelectorAll('#rosterBody .selection-anchor').length, status: document.querySelector('#rosterMessage')?.textContent.trim() || '', released: !document.querySelector('#rosterTable').classList.contains('range-selecting') }))()`);
        if (trustedInputDrag.selected !== 2 || trustedInputDrag.anchors !== 1 || !trustedInputDrag.status || !trustedInputDrag.released) throw new Error(`Trusted input-origin roster drag failed: ${JSON.stringify(trustedInputDrag)}`);
        const trustedRowDragCoordinates = await rosterManager.webContents.executeJavaScript(`(() => { const first = document.querySelector('#rosterBody [data-select-row="0"]'); const second = document.querySelector('#rosterBody [data-select-row="1"]'); if (!first || !second) return null; const a = first.getBoundingClientRect(); const b = second.getBoundingClientRect(); return { first: { x: Math.round(a.left + a.width / 2), y: Math.round(a.top + a.height / 2) }, second: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } }; })()`);
        if (!trustedRowDragCoordinates) throw new Error('Trusted roster row-selector drag coordinates were not available.');
        sendRosterMouse('mouseMove', trustedRowDragCoordinates.first); sendRosterMouse('mouseDown', trustedRowDragCoordinates.first, { button: 'left', clickCount: 1 }); sendRosterMouse('mouseMove', trustedRowDragCoordinates.second, { button: 'left', modifiers: ['leftButtonDown'] }); sendRosterMouse('mouseUp', trustedRowDragCoordinates.second, { button: 'left', clickCount: 1 }); await new Promise((resolve) => setTimeout(resolve, 75));
        const trustedRowDrag = await rosterManager.webContents.executeJavaScript(`(() => ({ selectors: document.querySelectorAll('#rosterBody [data-select-row].selected-selector').length, selected: document.querySelectorAll('#rosterBody .selected-cell').length }))()`);
        if (trustedRowDrag.selectors !== 2 || trustedRowDrag.selected < 2) throw new Error(`Trusted roster row-selector drag failed: ${JSON.stringify(trustedRowDrag)}`);
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

          const hadScheduleHistory = globalThis.__workspaceSeedScheduleHistory?.() === true
            && globalThis.__workspaceScheduleHistoryDiagnostics?.().historyLength > 0
            && !document.querySelector('#scheduleUndo').disabled;
          chooseSavedRoster(); document.querySelector('#loadGmailSharedRoster').click(); await waitFor(() => document.querySelector('#confirmDialog').open, 'accepted roster replacement confirmation'); document.querySelector('#confirmAction').click();
          await waitFor(() => document.querySelectorAll('#mailRosterPeople .resource-chip').length === 2, 'accepted roster replacement');
          document.querySelector('[data-nav="dashboard"]').click(); document.querySelector('[data-workflow-open="schedule"]').click(); await waitFor(() => document.querySelector('#page-schedule')?.classList.contains('active'), 'schedule after roster replacement');
          loaded = await globalThis.workspaceDesktop.loadState(); project = loaded.projects.find((item) => item.id === loaded.activeProjectId);
          return { sourceGuarded, targetGuarded, hadScheduleHistory, historyCleared: document.querySelector('#scheduleUndo').disabled && document.querySelector('#sessionUndo').disabled, assignmentsCleared: project.data.assignments.length === 0 && Object.keys(project.data.availability || {}).length === 0, savedIdStable: savedId === saved.id };
        })()`);
        if (!Object.values(replacementGuards).every(Boolean)) throw new Error(`Roster replacement guards failed: ${JSON.stringify(replacementGuards)}`);
        const guideSmoke = await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label, timeout = 5000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          const guideReady = (index) => globalThis.__workspaceGuide?.stepIndex === index && document.querySelector('.guide-target-active') && !document.querySelector('#guideNext')?.disabled;
          const guideGeometryReady = () => {
            const target = document.querySelector('.guide-target-active'); const spotlight = document.querySelector('#guideSpotlight');
            if (!target || !spotlight || spotlight.hidden) return false;
            const targetRect = target.getBoundingClientRect(); const spotlightRect = spotlight.getBoundingClientRect();
            const aligned = Math.abs(spotlightRect.left - (targetRect.left - 6)) <= 2 && Math.abs(spotlightRect.top - (targetRect.top - 6)) <= 2 && Math.abs(spotlightRect.width - (targetRect.width + 12)) <= 2 && Math.abs(spotlightRect.height - (targetRect.height + 12)) <= 2;
            const hit = document.elementFromPoint(targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2);
            return aligned && target.contains(hit);
          };
          let before = await globalThis.workspaceDesktop.loadState();
          document.querySelector('[data-nav="settings"]').click(); await waitFor(() => document.querySelector('#page-settings')?.classList.contains('active'), 'guide settings page');
          document.querySelector('#openGuideLibrary').click(); await waitFor(() => document.querySelector('#guideLibraryDialog')?.open, 'guide chooser');
          const chooserCards = document.querySelectorAll('[data-guide-start]').length;
          const programCards = document.querySelectorAll('#guideProgramCatalog [data-guide-start]').length;
          const expectedChooserCards = globalThis.WorkspaceGuideCore.GUIDES.length;
          const expectedProgramCards = globalThis.WorkspaceGuideCore.GUIDES.filter((guide) => guide.group === 'program').length;
          document.querySelector('[data-guide-start="people"]').click(); await waitFor(() => globalThis.__workspaceGuide?.active && globalThis.__workspaceGuide.guideId === 'people', 'people guide start');
          await waitFor(() => document.body.classList.contains('guide-mode') && document.querySelector('#guideLayer')?.matches(':popover-open') && document.querySelector('.guide-target-active'), 'guide overlay');
          before = await globalThis.workspaceDesktop.loadState(); globalThis.__guideSmokeBefore = JSON.stringify(before);
          const demoProjectId = globalThis.__workspaceGuide.demoProjectId; const practiceLabel = document.querySelector('.guide-practice-badge')?.textContent.trim(); const saveLabel = document.querySelector('#saveStatus')?.textContent.trim();
          document.querySelector('#newProjectButton').click(); const outsideBlocked = !document.querySelector('#newProjectDialog').open;
          document.querySelector('#guideNext').click(); await waitFor(() => guideReady(1), 'people columns step');
          document.querySelector('#guideNext').click(); await waitFor(() => guideReady(2), 'people cell step');
          const cell = document.querySelector('#rosterEditorTable [data-sheet-row="1"][data-sheet-col="0"] input'); cell.focus(); cell.value = '가이드 편집 연습'; cell.dispatchEvent(new Event('input', { bubbles: true })); cell.dispatchEvent(new Event('change', { bubbles: true }));
          await waitFor(() => document.querySelector('#rosterEditorTable [data-sheet-row="1"][data-sheet-col="0"] input')?.classList.contains('guide-target-active'), 'guide target reattached after roster render');
          const ipcBlocked = await globalThis.workspaceDesktop.saveState(before).then(() => false, (error) => /가이드 연습|GUIDE_MODE_BLOCKED/.test(String(error?.message || error)));
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await waitFor(() => !globalThis.__workspaceGuide.active, 'people guide escape');
          const afterPeople = await globalThis.workspaceDesktop.loadState(); const peopleRestored = JSON.stringify(afterPeople) === globalThis.__guideSmokeBefore && !document.body.classList.contains('guide-mode') && !document.querySelector('#guideLayer')?.matches(':popover-open');
          document.querySelector('#openGuideLibrary').click(); await waitFor(() => document.querySelector('#guideLibraryDialog')?.open, 'calendar guide chooser'); document.querySelector('[data-guide-start="project-calendar"]').click();
          await waitFor(() => globalThis.__workspaceGuide?.active && globalThis.__workspaceGuide.guideId === 'project-calendar', 'calendar guide start');
          const advanceCalendarGuide = async (index, label) => {
            const next = document.querySelector('#guideNext');
            if (!next) throw new Error('Calendar guide next button missing before ' + label);
            next.click(); await waitFor(() => guideReady(index), label);
          };
          await advanceCalendarGuide(1, 'calendar session range step');
          await advanceCalendarGuide(2, 'calendar session open step');
          const sessionCard = document.querySelector('[data-session-card="guide-calendar-session"]');
          if (!sessionCard) throw new Error('Calendar guide session card missing');
          sessionCard.click(); await waitFor(() => guideReady(3), 'calendar session views step');
          await advanceCalendarGuide(4, 'calendar session time step');
          await advanceCalendarGuide(5, 'calendar session groups step');
          await advanceCalendarGuide(6, 'calendar session board step');
          await advanceCalendarGuide(7, 'calendar session unassign step');
          await advanceCalendarGuide(8, 'calendar session print step');
          await advanceCalendarGuide(9, 'calendar individual entry step');
          const legacyCalendarButton = document.querySelector('[data-session-open-legacy]');
          if (!legacyCalendarButton) throw new Error('Calendar guide individual calendar button missing');
          legacyCalendarButton.click(); await waitFor(() => guideReady(10), 'calendar individual toolbar step');
          await advanceCalendarGuide(11, 'calendar individual grid step');
          await advanceCalendarGuide(12, 'calendar event step');
          const calendarEvent = document.querySelector('[data-calendar-event="guide-slot-future-a"]');
          if (!calendarEvent) throw new Error('Calendar guide future event missing');
          calendarEvent.click(); await waitFor(() => guideReady(13) && !document.querySelector('#calendarDetail').hidden, 'calendar detail guide step');
          await advanceCalendarGuide(14, 'calendar edit step');
          await advanceCalendarGuide(15, 'calendar agenda step');
          await advanceCalendarGuide(16, 'calendar adjust button step');
          const adjustButton = document.querySelector('#calendarAdjustEvent');
          if (!adjustButton) throw new Error('Calendar guide adjustment button missing');
          adjustButton.click(); await waitFor(() => guideReady(17) && document.querySelector('#calendarAdjustmentDialog').open && document.querySelector('#calendarAdjustmentDialog .guide-target-active') && guideGeometryReady(), 'calendar adjustment dialog guide geometry');
          const target = document.querySelector('#calendarAdjustmentDialog .guide-target-active'); const targetRect = target?.getBoundingClientRect(); const spotlightRect = document.querySelector('#guideSpotlight')?.getBoundingClientRect(); const nextRect = document.querySelector('#guideNext')?.getBoundingClientRect(); const dialogRect = document.querySelector('#calendarAdjustmentDialog')?.getBoundingClientRect();
          const coachHit = nextRect ? document.elementFromPoint(nextRect.left + nextRect.width / 2, nextRect.top + nextRect.height / 2) : null;
          const targetHit = targetRect ? document.elementFromPoint(targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2) : null;
          const dialogProbe = dialogRect ? document.elementsFromPoint(Math.max(1, dialogRect.left + 8), Math.max(1, dialogRect.top + 24)).find((item) => !document.querySelector('#guideLayer').contains(item)) : null;
          const spotlightAligned = Boolean(targetRect && spotlightRect && Math.abs(spotlightRect.left - (targetRect.left - 6)) <= 2 && Math.abs(spotlightRect.top - (targetRect.top - 6)) <= 2 && Math.abs(spotlightRect.width - (targetRect.width + 12)) <= 2 && Math.abs(spotlightRect.height - (targetRect.height + 12)) <= 2);
          return { chooserCards, programCards, expectedChooserCards, expectedProgramCards, demoProjectId, practiceLabel, saveLabel, outsideBlocked, ipcBlocked, peopleRestored, calendarDialogOpen: document.querySelector('#calendarAdjustmentDialog').open, dialogNonModal: !document.querySelector('#calendarAdjustmentDialog').matches(':modal'), layerAboveDialog: document.querySelector('#guideLayer').matches(':popover-open'), dialogAboveSidebar: document.querySelector('#calendarAdjustmentDialog').contains(dialogProbe), coachHitTest: document.querySelector('#guideNext').contains(coachHit), targetHitTest: target.contains(targetHit), spotlightAligned, nextPoint: nextRect && { x: Math.round(nextRect.left + nextRect.width / 2), y: Math.round(nextRect.top + nextRect.height / 2) }, targetRect: targetRect && { left: targetRect.left, top: targetRect.top, width: targetRect.width, height: targetRect.height }, spotlightRect: spotlightRect && { left: spotlightRect.left, top: spotlightRect.top, width: spotlightRect.width, height: spotlightRect.height } };
        })()`);
        console.log('Interactive guide smoke:', JSON.stringify(guideSmoke));
        if (guideSmoke.chooserCards !== guideSmoke.expectedChooserCards || guideSmoke.programCards !== guideSmoke.expectedProgramCards || guideSmoke.demoProjectId !== 'guide-demo-project' || !guideSmoke.practiceLabel.includes('연습 모드') || !guideSmoke.saveLabel.includes('저장 안 함') || !guideSmoke.outsideBlocked || !guideSmoke.ipcBlocked || !guideSmoke.peopleRestored || !guideSmoke.calendarDialogOpen || !guideSmoke.dialogNonModal || !guideSmoke.layerAboveDialog || !guideSmoke.dialogAboveSidebar || !guideSmoke.coachHitTest || !guideSmoke.targetHitTest || !guideSmoke.spotlightAligned || !guideSmoke.nextPoint) throw new Error(`Interactive guide smoke failed: ${JSON.stringify(guideSmoke)}`);
        await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-interactive-guide-smoke.png', 'Workspace interactive guide preview');
        mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: guideSmoke.nextPoint.x, y: guideSmoke.nextPoint.y });
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: guideSmoke.nextPoint.x, y: guideSmoke.nextPoint.y, button: 'left', clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: guideSmoke.nextPoint.x, y: guideSmoke.nextPoint.y, button: 'left', clickCount: 1 });
        const physicalGuideClick = await mainWindow.webContents.executeJavaScript(`(async () => {
           const end = Date.now() + 5000; while (globalThis.__workspaceGuide?.stepIndex !== 18 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
           return globalThis.__workspaceGuide?.stepIndex === 18 && document.querySelector('#calendarRelatedPicker')?.classList.contains('guide-target-active');
        })()`);
        if (!physicalGuideClick) throw new Error('Interactive guide physical coach click failed.');
        const guideRestore = await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label, timeout = 5000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await waitFor(() => !globalThis.__workspaceGuide.active, 'calendar guide escape restore');
          await waitFor(() => document.activeElement === document.querySelector('#openGuideLibrary'), 'guide focus restore');
          const after = await globalThis.workspaceDesktop.loadState();
          return { stateRestored: JSON.stringify(after) === globalThis.__guideSmokeBefore, dialogClosed: !document.querySelector('#calendarAdjustmentDialog').open, demoGone: !document.body.textContent.includes('가이드 체험 프로젝트'), focusRestored: document.activeElement === document.querySelector('#openGuideLibrary'), layerHiddenAndInert: document.querySelector('#guideLayer').inert && document.querySelector('#guideLayer').getAttribute('aria-hidden') === 'true' };
        })()`);
        if (!Object.values(guideRestore).every(Boolean)) throw new Error(`Interactive guide restore failed: ${JSON.stringify(guideRestore)}`);
        const guideCatalogSmoke = await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label, timeout = ${app.isPackaged ? 15000 : 7000}) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          const baseline = JSON.stringify(await globalThis.workspaceDesktop.loadState()); const report = [];
          for (const guide of globalThis.WorkspaceGuideCore.GUIDES) {
            await globalThis.__workspaceGuide.start(guide.id);
            await waitFor(() => globalThis.__workspaceGuide?.active && globalThis.__workspaceGuide.guideId === guide.id, guide.id + ' start');
            let transitions = 0;
            while (globalThis.__workspaceGuide.active) {
              const index = globalThis.__workspaceGuide.stepIndex; const step = guide.steps[index];
              await waitFor(() => globalThis.__workspaceGuide.stepIndex !== index || document.querySelector('.guide-target-active') || !document.querySelector('#guideTargetMissing')?.hidden, guide.id + '/' + step.id + ' ready');
              if (!globalThis.__workspaceGuide.active || globalThis.__workspaceGuide.stepIndex !== index) continue;
              if (!document.querySelector('#guideTargetMissing')?.hidden) throw new Error(guide.id + '/' + step.id + ' target missing');
              const target = document.querySelector(step.target); const rect = target?.getBoundingClientRect();
              if (!target?.classList.contains('guide-target-active') || !rect || rect.width <= 0 || rect.height <= 0) throw new Error(guide.id + '/' + step.id + ' target is not visible');
              const visible = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom) };
              const layer = document.querySelector('#guideLayer'); const hit = document.elementsFromPoint((visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2).find((item) => !layer.contains(item));
              if (!hit || (hit !== target && !target.contains(hit))) throw new Error(guide.id + '/' + step.id + ' target is not hit-testable');
              if (step.interaction === 'target' || step.interaction === 'simulate') {
                target.click();
                if (step.interaction === 'simulate' && index === guide.steps.length - 1) {
                  await waitFor(() => !document.querySelector('#guideNext').hidden && !document.querySelector('#guideNext').disabled, guide.id + '/' + step.id + ' simulated finish');
                  document.querySelector('#guideNext').click();
                }
              } else document.querySelector('#guideNext').click();
              await waitFor(() => !globalThis.__workspaceGuide.active || globalThis.__workspaceGuide.stepIndex !== index, guide.id + '/' + step.id + ' advance');
              transitions += 1; if (transitions > guide.steps.length + 2) throw new Error(guide.id + ' transition loop');
            }
            const restored = JSON.stringify(await globalThis.workspaceDesktop.loadState());
            if (restored !== baseline) throw new Error(guide.id + ' changed persisted state');
            if ([...document.querySelectorAll('dialog[open]')].length || document.body.classList.contains('guide-mode') || document.querySelector('#activeProjectName')?.textContent.includes('가이드 체험 프로젝트')) throw new Error(guide.id + ' did not clean up');
            const mergeDemoLeft = Object.values(globalThis.CMOEDocumentToolsUI?.mergeStates || {}).some((state) => state.files?.some((file) => String(file.token || '').startsWith('guide-merge-')));
            if (globalThis.CMOEDocumentToolsUI?.guideDemoActive || globalThis.CMOEDocumentToolsUI?.converter.files.some((file) => String(file.token || '').startsWith('guide-pptx-')) || globalThis.CMOEDocumentToolsUI?.certificate.template?.token === 'guide-template' || mergeDemoLeft) throw new Error(guide.id + ' left document-tool demo data behind');
            report.push({ id: guide.id, steps: guide.steps.length });
          }
          return {
            guides: report.length,
            steps: report.reduce((sum, item) => sum + item.steps, 0),
            expectedGuides: globalThis.WorkspaceGuideCore.GUIDES.length,
            expectedSteps: globalThis.WorkspaceGuideCore.GUIDES.reduce((sum, guide) => sum + guide.steps.length, 0),
            report
          };
        })()`);
        console.log('Interactive guide catalog smoke:', JSON.stringify(guideCatalogSmoke));
        if (guideCatalogSmoke.guides !== guideCatalogSmoke.expectedGuides || guideCatalogSmoke.steps !== guideCatalogSmoke.expectedSteps) throw new Error(`Interactive guide catalog smoke failed: ${JSON.stringify(guideCatalogSmoke)}`);
        const guideFailureSmoke = await mainWindow.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, label, timeout = 5000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); if (!predicate()) throw new Error('Timed out waiting for ' + label); };
          const baseline = JSON.stringify(await globalThis.workspaceDesktop.loadState()); const originalFactory = globalThis.WorkspaceGuideCore.createDemoState;
          try { globalThis.WorkspaceGuideCore.createDemoState = () => { throw new Error('intentional guide startup failure'); }; await globalThis.__workspaceGuide.start('people'); }
          finally { globalThis.WorkspaceGuideCore.createDemoState = originalFactory; }
          await waitFor(() => !globalThis.__workspaceGuide.starting && !globalThis.__workspaceGuide.active, 'failed guide rollback');
          const failedStartRestored = JSON.stringify(await globalThis.workspaceDesktop.loadState()) === baseline && !document.body.classList.contains('guide-mode') && !document.querySelector('#guideLayer').matches(':popover-open') && !document.querySelector('#activeProjectName')?.textContent.includes('가이드 체험 프로젝트');
          const first = globalThis.__workspaceGuide.start('people'); const second = globalThis.__workspaceGuide.start('forms'); await Promise.all([first, second]);
          await waitFor(() => globalThis.__workspaceGuide.active, 'concurrent guide start'); const singleGuide = globalThis.__workspaceGuide.guideId === 'people';
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await waitFor(() => !globalThis.__workspaceGuide.active, 'concurrent guide cleanup');
          return { failedStartRestored, singleGuide, finalStateRestored: JSON.stringify(await globalThis.workspaceDesktop.loadState()) === baseline };
        })()`);
        if (!Object.values(guideFailureSmoke).every(Boolean)) throw new Error(`Interactive guide failure guard failed: ${JSON.stringify(guideFailureSmoke)}`);
        clearTimeout(timeout);
        writeSmokeResult('passed', { step: 'complete' });
        console.log('Workspace smoke test passed.');
        const shutdownWatchdog = setTimeout(() => {
          console.error('Workspace smoke test failed: graceful shutdown timed out.');
          writeSmokeResult('failed', { step: 'shutdown-timeout' });
          isQuitting = true;
          app.exit(1);
        }, 30_000);
        shutdownWatchdog.unref?.();
        app.once('quit', () => clearTimeout(shutdownWatchdog));
        app.quit();
      } catch (error) {
        clearTimeout(timeout);
        const failedAfterStep = lastSmokeStep;
        console.error('Workspace smoke test failed:', error);
        writeSmokeResult('failed', { step: 'exception', failedAfterStep, error: error?.stack || error?.message || String(error) });
        try {
          const diagnostics = await mainWindow.webContents.executeJavaScript(`({
            page: [...document.querySelectorAll('.page.active')].map((item) => item.dataset.page),
            project: document.querySelector('#activeProjectName')?.textContent || '',
            roleCells: [...document.querySelectorAll('#scheduleBoard .schedule-role-cell input')].map((input) => input.value),
            sessionAssignments: [...document.querySelectorAll('[data-session-assignment]')].map((item) => ({ id: item.dataset.sessionAssignment, person: item.dataset.sessionPerson, text: item.textContent })),
            scheduleSummary: document.querySelector('#scheduleBoardSummary')?.textContent || '',
            saveStatus: document.querySelector('#saveStatus')?.textContent || '',
            stateDeferral: globalThis.__workspaceStateDeferral?.() || null,
            sheetDiagnostics: globalThis.__workspaceSheetDiagnostics?.() || null,
            navigationTrace: globalThis.__workspaceNavigationTrace || []
          })`);
          const failedState = WorkspaceCore.normalizeState(await storage.get('workspaceState', null)); const failedProject = failedState.projects.find((project) => project.id === failedState.activeProjectId);
          const stateDiagnostics = { activeProjectId: failedState.activeProjectId, revision: failedState._revision, slots: failedProject?.data.slots.length, assignmentCount: failedProject?.data.assignments.length, conflictCount: failedProject?.data.conflicts.length };
          console.error('Workspace smoke diagnostics:', JSON.stringify({ dom: diagnostics, state: stateDiagnostics }));
          writeSmokeResult('failed', { step: 'exception', failedAfterStep, error: error?.stack || error?.message || String(error), diagnostics: { dom: diagnostics, state: stateDiagnostics } });
          await captureSmokePreview(mainWindow.webContents, 'cmoe-workspace-failed-smoke.png', 'Workspace failed smoke preview');
        } catch (diagnosticError) { console.error('Workspace smoke diagnostics failed:', diagnosticError); }
        isQuitting = true;
        app.exit(1);
      }
    });
  }
}).catch((error) => handleStartupFailure({
  error,
  isSmokeTest,
  writeSmokeResult,
  dialog,
  shell,
  app,
  userDataPath: app.getPath('userData')
}));
