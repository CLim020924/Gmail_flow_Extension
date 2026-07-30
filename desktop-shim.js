(() => {
  const desktop = globalThis.gmailFlowDesktop;
  if (!desktop) return;

  document.documentElement.classList.add('desktop-app');
  const storageListeners = new Set();
  desktop.onStorageChanged((changes) => {
    storageListeners.forEach((listener) => listener(changes, 'local'));
  });

  globalThis.chrome = {
    storage: {
      local: {
        get: (keys) => desktop.storageGet(keys),
        set: (values) => desktop.storageSet(values)
      },
      onChanged: {
        addListener: (listener) => storageListeners.add(listener),
        removeListener: (listener) => storageListeners.delete(listener)
      }
    },
    runtime: {
      sendMessage: (message) => desktop.sendRuntimeMessage(message),
      getURL: (resource) => new URL(resource, globalThis.location.href).href
    },
    identity: {
      getAuthToken: (options = {}) => desktop.getAuthToken(options),
      clearAllCachedAuthTokens: () => desktop.clearAuthTokens(),
      removeCachedAuthToken: () => desktop.removeCachedAuthToken(),
      getProfileUserInfo: () => desktop.getProfileUserInfo()
    },
    windows: {
      create: () => desktop.openWindow()
    }
  };
})();
