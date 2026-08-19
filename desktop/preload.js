const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gmailFlowDesktop', {
  storageGet: (keys) => ipcRenderer.invoke('storage:get', keys),
  storageSet: (values) => ipcRenderer.invoke('storage:set', values),
  sendRuntimeMessage: (message) => ipcRenderer.invoke('runtime:message', message),
  getAuthToken: (options) => ipcRenderer.invoke('identity:get-auth-token', options),
  clearAuthTokens: () => ipcRenderer.invoke('identity:clear-auth-tokens'),
  removeCachedAuthToken: () => ipcRenderer.invoke('identity:remove-cached-token'),
  getProfileUserInfo: () => ipcRenderer.invoke('identity:get-profile'),
  openWindow: () => ipcRenderer.invoke('window:show'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open-main'),
  openGoogleUrl: async (url) => {
    const response = await ipcRenderer.invoke('external:open-google', url);
    if (!response?.ok) throw new Error(response?.error || 'Gmail을 열지 못했습니다.');
    return response.data;
  },
  onStorageChanged: (listener) => {
    const wrapped = (_event, changes) => listener(changes);
    ipcRenderer.on('storage:changed', wrapped);
    return () => ipcRenderer.removeListener('storage:changed', wrapped);
  }
});
