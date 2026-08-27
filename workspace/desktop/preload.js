const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workspaceDesktop', {
  loadState: () => ipcRenderer.invoke('workspace:load'),
  saveState: (state) => ipcRenderer.invoke('workspace:save', state),
  loadWorkspaceRoster: (projectId) => ipcRenderer.invoke('workspace:roster:get', projectId),
  saveWorkspaceRoster: (projectId, roster) => ipcRenderer.invoke('workspace:roster:save', projectId, roster),
  listSharedRosters: (projectId) => ipcRenderer.invoke('workspace:roster:sources', projectId),
  saveSharedRoster: (roster) => ipcRenderer.invoke('workspace:roster:library-save', roster),
  deleteSharedRoster: (rosterId) => ipcRenderer.invoke('workspace:roster:library-delete', rosterId),
  getAppInfo: () => ipcRenderer.invoke('workspace:app-info'),
  reserveExternalArtifacts: (projectId, kind, keys) => ipcRenderer.invoke('workspace:external-reserve', { projectId, kind, keys }),
  releaseExternalArtifacts: (token) => ipcRenderer.invoke('workspace:external-release', token),
  gmailFlowSummary: () => ipcRenderer.invoke('gmail-flow:summary'),
  openProgram: (programId, options) => ipcRenderer.invoke('program:open', programId, options),
  openRosterPicker: (projectId) => ipcRenderer.invoke('workspace:roster:open-picker', projectId),
  openWorkspace: () => ipcRenderer.invoke('workspace:open-main'),
  createProgramShortcuts: (programId, options) => ipcRenderer.invoke('program:shortcuts', programId, options),
  removeProgramShortcuts: (programId) => ipcRenderer.invoke('program:remove-shortcuts', programId),
  openProgramLocation: () => ipcRenderer.invoke('program:open-location'),
  listExtensions: () => ipcRenderer.invoke('extensions:list'),
  installExtensionFile: () => ipcRenderer.invoke('extensions:install'),
  removeExtensionFile: (extensionId) => ipcRenderer.invoke('extensions:remove-file', extensionId),
  chooseSpreadsheet: () => ipcRenderer.invoke('spreadsheet:choose'),
  exportSpreadsheet: (project) => ipcRenderer.invoke('spreadsheet:export', project),
  exportWorkItem: (item) => ipcRenderer.invoke('spreadsheet:export-work-item', item),
  configureConnection: (connectionId, config) => ipcRenderer.invoke('connection:config', connectionId, config),
  connectionStatus: (connectionId) => ipcRenderer.invoke('connection:status', connectionId),
  authorizeConnection: (connectionId, options) => ipcRenderer.invoke('connection:authorize', connectionId, options),
  disconnectConnection: (connectionId) => ipcRenderer.invoke('connection:disconnect', connectionId),
  removeConnection: (connectionId) => ipcRenderer.invoke('connection:remove', connectionId),
  createGoogleForm: (connectionId, definition, requests, expectedIdentity) => ipcRenderer.invoke('forms:create', connectionId, definition, requests, expectedIdentity),
  fetchGoogleFormResponses: (connectionId, formId, expectedIdentity) => ipcRenderer.invoke('forms:responses', connectionId, formId, expectedIdentity),
  createZoomMeeting: (connectionId, meeting, expectedIdentity) => ipcRenderer.invoke('zoom:create', connectionId, meeting, expectedIdentity),
  createGmailDraft: (connectionId, mail, expectedIdentity) => ipcRenderer.invoke('gmail:create-draft', connectionId, mail, expectedIdentity),
  updateGmailDraft: (connectionId, draftId, mail, expectedIdentity) => ipcRenderer.invoke('gmail:update-draft', connectionId, draftId, mail, expectedIdentity),
  pushDriveState: (connectionId, state, expectedIdentity) => ipcRenderer.invoke('drive:push', connectionId, state, expectedIdentity),
  pullDriveState: (connectionId, expectedIdentity) => ipcRenderer.invoke('drive:pull', connectionId, expectedIdentity),
  applyPulledDriveState: (connectionId, pulledState, fileId, modifiedTime, expectedIdentity, expectedWorkspaceIdentity, etag, version) => ipcRenderer.invoke('drive:apply-pull', connectionId, pulledState, fileId, modifiedTime, expectedIdentity, expectedWorkspaceIdentity, etag, version),
  onStateChanged: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('workspace:state-changed', wrapped);
    return () => ipcRenderer.removeListener('workspace:state-changed', wrapped);
  }
});
