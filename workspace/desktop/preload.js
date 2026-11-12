const { contextBridge, ipcRenderer } = require('electron');

const DOCUMENT_EDITOR_MODES = new Set(['pptxPdf', 'documentSplit', 'excelDeduplicate', 'certificateMaker', 'pdfMerge', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge']);
const documentEditorModeListeners = new Set();
let pendingDocumentEditorMode = '';

// A second shortcut can target the already-created document editor while its
// renderer is still loading Workspace state. Listen from preload startup so
// that request cannot fall into the gap before app.js subscribes.
ipcRenderer.on('document-editor:select-mode', (_event, rawMode) => {
  const mode = String(rawMode || '');
  if (!DOCUMENT_EDITOR_MODES.has(mode)) return;
  if (!documentEditorModeListeners.size) {
    pendingDocumentEditorMode = mode;
    return;
  }
  pendingDocumentEditorMode = '';
  [...documentEditorModeListeners].forEach((listener) => listener(mode));
});

function sanitizeIpcErrorMessage(value, fallback = '요청을 실행하지 못했습니다.') {
  let raw = String(value || '')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/^(?:(?:error invoking remote method\s+["'][^"']+["']\s*:\s*)|(?:uncaught exception\s*:\s*)|(?:error\s*:\s*))+/i, '')
    .replace(/(["'`])(?:(?:file:\/\/\/)?[A-Z]:[\\/]|\\\\)[^"'`\r\n]+\1/gi, '[로컬 경로]')
    .replace(/(?:file:\/\/\/)?(?:[A-Z]:[\\/]|\\\\)[^\r\n]*?office-automation\.ps1\s*:?\s*/gi, '[로컬 스크립트] ')
    .replace(/(?:file:\/\/\/)?(?:[A-Z]:[\\/]|\\\\)[^\r\n<>|?*]*?\.(?:ps1|pptx|pptm|potx|pdf|xlsx|xlsm|xls|csv|tsv|json|asar|exe|dll)(?=\s|[)\]}'",;:]|$)/gi, '[로컬 경로]')
    .replace(/(?:file:\/\/\/)?(?:[A-Z]:[\\/]|\\\\)[^\r\n]*/gi, '[로컬 경로]')
    .replace(/([.!?])\s+/g, '$1\n');
  const lines = [];
  for (const candidate of raw.split(/\r?\n|\s*[·|]\s*/)) {
    let line = candidate.trim();
    if (!line || /^(?:at\s+|node:internal\b|caused by\s*:|---\s*end of inner exception stack trace|\+\s|(?:categoryinfo|fullyqualifiederrorid|scriptstacktrace|stacktrace)\s*:|위치\s+.*(?:\.ps1|줄\s+\d+))/i.test(line)) continue;
    if ((line.match(/\uFFFD/g) || []).length >= 2) continue;
    line = line.replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim();
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines.join(' · ').replace(/\s+([,.;:!?])/g, '$1').trim().slice(0, 1_000) || fallback;
}

function createIpcError(payload, fallbackCode) {
  const error = new Error(sanitizeIpcErrorMessage(payload?.message ?? payload));
  error.code = String(payload?.code || fallbackCode || 'IPC_REQUEST_FAILED').replace(/[^A-Z0-9_.-]/gi, '_').slice(0, 80) || 'IPC_REQUEST_FAILED';
  const oauthStage = String(payload?.oauthStage || '');
  const oauthProviderCode = String(payload?.oauthProviderCode || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const status = Number(payload?.status);
  if (['callback_start', 'authorization_callback', 'token_exchange', 'profile_lookup', 'credential_persist'].includes(oauthStage)) error.oauthStage = oauthStage;
  if (oauthProviderCode) error.oauthProviderCode = oauthProviderCode;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  if (payload?.details && typeof payload.details === 'object' && !Array.isArray(payload.details)) {
    error.details = Object.fromEntries(Object.entries(payload.details).slice(0, 20).flatMap(([key, value]) => {
      const safeKey = String(key || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
      if (!safeKey) return [];
      const sanitizeValue = (item) => typeof item === 'string'
        ? item.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500)
        : (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean' ? item : undefined);
      const safeValue = Array.isArray(value)
        ? value.slice(0, 100).map(sanitizeValue).filter((item) => item !== undefined)
        : sanitizeValue(value);
      if (safeValue === undefined) return [];
      return [[safeKey, safeValue]];
    }));
  }
  if (payload?.remoteIdentity && typeof payload.remoteIdentity === 'object') {
    error.remoteIdentity = {
      fileId: String(payload.remoteIdentity.fileId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 240),
      modifiedTime: String(payload.remoteIdentity.modifiedTime || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100),
      version: String(payload.remoteIdentity.version || '').replace(/[^0-9]/g, '').slice(0, 80),
      etag: String(payload.remoteIdentity.etag || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500)
    };
  }
  return error;
}

async function invokeWithStructuredError(channel, ...args) {
  let result;
  try { result = await ipcRenderer.invoke(channel, ...args); }
  catch (error) { throw createIpcError(error, 'IPC_REQUEST_FAILED'); }
  if (result?.__cmoeIpcError) {
    throw createIpcError(result.__cmoeIpcError, 'IPC_REQUEST_BLOCKED');
  }
  return result;
}

contextBridge.exposeInMainWorld('workspaceDesktop', {
  setGuideMode: (active) => ipcRenderer.invoke('workspace:guide-mode', Boolean(active)),
  loadState: () => ipcRenderer.invoke('workspace:load'),
  saveState: (state) => invokeWithStructuredError('workspace:save', state),
  loadWorkspaceRoster: (projectId) => ipcRenderer.invoke('workspace:roster:get', projectId),
  saveWorkspaceRoster: (projectId, roster) => ipcRenderer.invoke('workspace:roster:save', projectId, roster),
  listSharedRosters: (projectId) => ipcRenderer.invoke('workspace:roster:sources', projectId),
  listCertificateRosterSources: () => invokeWithStructuredError('workspace:roster:certificate-catalog'),
  readCertificateRosterSource: (payload) => invokeWithStructuredError('workspace:roster:certificate-read', payload),
  saveSharedRoster: (roster) => ipcRenderer.invoke('workspace:roster:library-save', roster),
  deleteSharedRoster: (rosterId) => ipcRenderer.invoke('workspace:roster:library-delete', rosterId),
  getAppInfo: () => ipcRenderer.invoke('workspace:app-info'),
  getUpdateStatus: () => ipcRenderer.invoke('workspace:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('workspace:update-check'),
  installUpdate: () => ipcRenderer.invoke('workspace:update-install'),
  cancelUpdate: () => ipcRenderer.invoke('workspace:update-cancel'),
  openUpdateDownloads: () => ipcRenderer.invoke('workspace:update-open-downloads'),
  createCloudBackup: () => invokeWithStructuredError('workspace:cloud-backup-create'),
  latestCloudBackup: () => invokeWithStructuredError('workspace:cloud-backup-latest'),
  restoreCloudBackup: () => invokeWithStructuredError('workspace:cloud-backup-restore'),
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('workspace:update-progress', listener);
    return () => ipcRenderer.removeListener('workspace:update-progress', listener);
  },
  reserveExternalArtifacts: (projectId, kind, keys) => ipcRenderer.invoke('workspace:external-reserve', { projectId, kind, keys }),
  releaseExternalArtifacts: (token) => ipcRenderer.invoke('workspace:external-release', token),
  gmailFlowSummary: () => ipcRenderer.invoke('gmail-flow:summary'),
  openProgram: (programId, options) => ipcRenderer.invoke('program:open', programId, options),
  openRosterPicker: (projectId) => ipcRenderer.invoke('workspace:roster:open-picker', projectId),
  openWorkspace: () => ipcRenderer.invoke('workspace:open-main'),
  openExternal: (url) => ipcRenderer.invoke('workspace:open-external', url),
  writeClipboardText: (text) => invokeWithStructuredError('workspace:clipboard-write', text),
  createProgramShortcuts: (programId, options) => ipcRenderer.invoke('program:shortcuts', programId, options),
  removeProgramShortcuts: (programId) => ipcRenderer.invoke('program:remove-shortcuts', programId),
  openProgramLocation: () => ipcRenderer.invoke('program:open-location'),
  listExtensions: () => ipcRenderer.invoke('extensions:list'),
  installExtensionFile: () => ipcRenderer.invoke('extensions:install'),
  removeExtensionFile: (extensionId) => ipcRenderer.invoke('extensions:remove-file', extensionId),
  documentToolCapabilities: (refresh) => invokeWithStructuredError('document-tools:capabilities', Boolean(refresh)),
  choosePptxFiles: () => invokeWithStructuredError('document-tools:pptx:choose'),
  chooseDocumentConversionFiles: (payload) => invokeWithStructuredError('document-tools:conversion:choose', payload),
  getDocumentConversionTargets: (payload) => invokeWithStructuredError('document-tools:conversion:targets', payload),
  convertDocumentBatch: (payload) => invokeWithStructuredError('document-tools:conversion:run', payload),
  prepareDocumentDependencies: (payload) => invokeWithStructuredError('document-tools:dependencies:prepare', payload),
  chooseAndInstallDocumentFont: (payload) => invokeWithStructuredError('document-tools:font-file:install', payload),
  chooseDocumentMergeFiles: (payload) => invokeWithStructuredError('document-tools:merge:choose', payload),
  inspectDocumentMergeFiles: (payload) => invokeWithStructuredError('document-tools:merge:inspect', payload),
  mergeDocumentFiles: (payload) => invokeWithStructuredError('document-tools:merge:run', payload),
  chooseDocumentSplitFile: (payload) => invokeWithStructuredError('document-tools:split:choose', payload),
  splitDocumentFile: (payload) => invokeWithStructuredError('document-tools:split:run', payload),
  chooseExcelDeduplicateFile: () => invokeWithStructuredError('document-tools:excel-deduplicate:choose'),
  analyzeExcelDeduplicateCriteria: (payload) => invokeWithStructuredError('document-tools:excel-deduplicate:analyze-criteria', payload),
  analyzeExcelDeduplicateReview: (payload) => invokeWithStructuredError('document-tools:excel-deduplicate:review', payload),
  runExcelDeduplicate: (payload) => invokeWithStructuredError('document-tools:excel-deduplicate:run', payload),
  chooseExcelCompareFile: (payload) => invokeWithStructuredError('document-tools:excel-compare:choose', payload),
  analyzeExcelComparePlan: (payload) => invokeWithStructuredError('document-tools:excel-compare:analyze', payload),
  runExcelCompareGroup: (payload) => invokeWithStructuredError('document-tools:excel-compare:run', payload),
  chooseDocumentsToMerge: () => invokeWithStructuredError('document-tools:merge:choose', { kind: 'documents' }),
  inspectDocumentsToMerge: (payload) => invokeWithStructuredError('document-tools:merge:inspect', { ...payload, kind: 'documents' }),
  mergeDocumentsToPdf: (payload) => invokeWithStructuredError('document-tools:merge:run', { ...payload, kind: 'documents' }),
  chooseDocumentOutputDirectory: () => invokeWithStructuredError('document-tools:output:choose'),
  openDocumentOutputDirectory: (outputToken) => invokeWithStructuredError('document-tools:output:open', outputToken),
  openDocumentOutputFile: (outputFileToken) => invokeWithStructuredError('document-tools:output-file:open', outputFileToken),
  convertPptxBatch: (payload) => invokeWithStructuredError('document-tools:pptx:convert', payload),
  chooseCertificateTemplate: () => invokeWithStructuredError('document-tools:certificate:choose-template'),
  inspectCertificateReadiness: (payload) => invokeWithStructuredError('document-tools:certificate:readiness', payload),
  chooseCertificateData: () => invokeWithStructuredError('document-tools:certificate:choose-data'),
  previewCertificate: (payload) => invokeWithStructuredError('document-tools:certificate:preview', payload),
  generateCertificates: (payload) => invokeWithStructuredError('document-tools:certificate:generate', payload),
  cancelDocumentToolJob: (requestId) => invokeWithStructuredError('document-tools:cancel', requestId),
  listCertificateProfiles: () => invokeWithStructuredError('document-tools:certificate:profiles'),
  openCertificateProfile: (profileId) => invokeWithStructuredError('document-tools:certificate:profile-open', profileId),
  saveCertificateProfile: (payload) => invokeWithStructuredError('document-tools:certificate:profile-save', payload),
  deleteCertificateProfile: (profileId) => invokeWithStructuredError('document-tools:certificate:profile-delete', profileId),
  onDocumentToolProgress: (listener) => {
    const wrapped = (_event, progress) => listener(progress && typeof progress === 'object' && progress.error
      ? { ...progress, error: sanitizeIpcErrorMessage(progress.error) }
      : progress);
    ipcRenderer.on('document-tools:progress', wrapped);
    return () => ipcRenderer.removeListener('document-tools:progress', wrapped);
  },
  onDocumentEditorModeRequested: (listener) => {
    if (typeof listener !== 'function') return () => {};
    documentEditorModeListeners.add(listener);
    if (pendingDocumentEditorMode) {
      const mode = pendingDocumentEditorMode;
      pendingDocumentEditorMode = '';
      // app.js performs its original URL-based navigation immediately after
      // subscribing. Deliver the newer, buffered request on the next microtask
      // so that the user's last shortcut choice remains the final mode.
      Promise.resolve().then(() => {
        if (documentEditorModeListeners.has(listener)) listener(mode);
      });
    }
    return () => documentEditorModeListeners.delete(listener);
  },
  chooseSpreadsheet: () => ipcRenderer.invoke('spreadsheet:choose'),
  exportSpreadsheet: (project) => ipcRenderer.invoke('spreadsheet:export', project),
  exportWorkItem: (item) => ipcRenderer.invoke('spreadsheet:export-work-item', item),
  configureConnection: (connectionId, config) => ipcRenderer.invoke('connection:config', connectionId, config),
  listLoginBrowsers: () => invokeWithStructuredError('connection:login-browsers'),
  listLoginBrowserProfiles: (browserId) => invokeWithStructuredError('connection:login-browser-profiles', browserId),
  connectionProviderStatus: (type) => ipcRenderer.invoke('connection:provider-status', type),
  connectionStatus: (connectionId) => ipcRenderer.invoke('connection:status', connectionId),
  authorizeConnection: (connectionId, options) => invokeWithStructuredError('connection:authorize', connectionId, options),
  cancelConnectionAuthorization: (connectionId) => invokeWithStructuredError('connection:cancel-authorization', connectionId),
  disconnectConnection: (connectionId) => ipcRenderer.invoke('connection:disconnect', connectionId),
  removeConnection: (connectionId) => invokeWithStructuredError('connection:remove', connectionId),
  createGoogleFormShell: (connectionId, definition, expectedIdentity) => invokeWithStructuredError('forms:create-shell', connectionId, definition, expectedIdentity),
  configureGoogleForm: (connectionId, formId, definition, requestsOrRevisionOrExpectedIdentity, revisionOrExpectedIdentity, legacyExpectedIdentity) => {
    const rendererRequests = Array.isArray(requestsOrRevisionOrExpectedIdentity) ? requestsOrRevisionOrExpectedIdentity : null;
    const requiredRevisionId = typeof requestsOrRevisionOrExpectedIdentity === 'string'
      ? requestsOrRevisionOrExpectedIdentity
      : (rendererRequests && typeof revisionOrExpectedIdentity === 'string' ? revisionOrExpectedIdentity : '');
    const expectedIdentity = rendererRequests
      ? (requiredRevisionId ? legacyExpectedIdentity : revisionOrExpectedIdentity)
      : (typeof requestsOrRevisionOrExpectedIdentity === 'string' ? revisionOrExpectedIdentity : requestsOrRevisionOrExpectedIdentity);
    return invokeWithStructuredError('forms:configure', connectionId, formId, definition, rendererRequests, requiredRevisionId, expectedIdentity);
  },
  getGoogleForm: (connectionId, formIdOrUrl, expectedIdentity) => invokeWithStructuredError('forms:get', connectionId, formIdOrUrl, expectedIdentity),
  fetchGoogleFormResponses: (connectionId, formId, expectedIdentity) => invokeWithStructuredError('forms:responses', connectionId, formId, expectedIdentity),
  createZoomMeeting: (connectionId, meeting, expectedIdentity) => ipcRenderer.invoke('zoom:create', connectionId, meeting, expectedIdentity),
  createGmailDraft: (connectionId, mail, expectedIdentity) => ipcRenderer.invoke('gmail:create-draft', connectionId, mail, expectedIdentity),
  updateGmailDraft: (connectionId, draftId, mail, expectedIdentity) => ipcRenderer.invoke('gmail:update-draft', connectionId, draftId, mail, expectedIdentity),
  pushDriveState: (connectionId, state, expectedIdentity) => invokeWithStructuredError('drive:push', connectionId, state, expectedIdentity),
  resolveDriveConflictWithLocal: (connectionId, expectedIdentity, expectedWorkspaceIdentity, expectedRemoteIdentity) => invokeWithStructuredError('drive:resolve-push', connectionId, expectedIdentity, expectedWorkspaceIdentity, expectedRemoteIdentity),
  pullDriveState: (connectionId, expectedIdentity) => invokeWithStructuredError('drive:pull', connectionId, expectedIdentity),
  applyPulledDriveState: (connectionId, pulledState, fileId, modifiedTime, expectedIdentity, expectedWorkspaceIdentity, etag, version) => invokeWithStructuredError('drive:apply-pull', connectionId, pulledState, fileId, modifiedTime, expectedIdentity, expectedWorkspaceIdentity, etag, version),
  onStateChanged: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('workspace:state-changed', wrapped);
    return () => ipcRenderer.removeListener('workspace:state-changed', wrapped);
  }
});
