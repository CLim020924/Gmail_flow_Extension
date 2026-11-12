const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

function normalizedExternalUrl(rawUrl) {
  const value = String(rawUrl || '');
  if (value.length > 8192) return '';
  let parsed;
  try { parsed = new URL(value); }
  catch (_) { return ''; }
  return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : '';
}

function installWebContentsSecurity(app, shell, { logError = console.error } = {}) {
  const protectedSessions = new WeakSet();
  const protectSession = (targetSession) => {
    if (!targetSession || protectedSessions.has(targetSession)) return;
    protectedSessions.add(targetSession);
    targetSession.setPermissionCheckHandler?.(() => false);
    targetSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
  };
  const openExternally = (rawUrl) => {
    const url = normalizedExternalUrl(rawUrl);
    if (!url) return false;
    Promise.resolve().then(() => shell.openExternal(url)).catch(logError);
    return true;
  };
  const protectContents = (contents) => {
    protectSession(contents?.session);
    contents?.setWindowOpenHandler?.(({ url }) => {
      openExternally(url);
      return { action: 'deny' };
    });
    contents?.on?.('will-navigate', (event, url) => {
      event.preventDefault();
      openExternally(url);
    });
  };
  app.on('web-contents-created', (_event, contents) => protectContents(contents));
  return { protectContents, protectSession, openExternally };
}

module.exports = { ALLOWED_EXTERNAL_PROTOCOLS, normalizedExternalUrl, installWebContentsSecurity };
