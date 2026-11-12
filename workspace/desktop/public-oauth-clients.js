// Public OAuth identifiers may be bundled with a desktop app. Never put client secrets in this file.
const clients = {
  googleDesktopClientId: '1055778436707-pcmqgjp5icu0l6n368spm74amkcnnisv.apps.googleusercontent.com',
  // Before filling this, register http://127.0.0.1/oauth/callback in the Zoom app's OAuth allow list.
  // Development builds use the Local Test client; packaged installers use the Production client below.
  zoomDevelopmentPublicClientId: 'YqhQuaRcQkm3i_f55yKkw',
  zoomPublicClientId: 'OYhgklB2QUmFU1szRWbYZA'
};

function selectZoomPublicClientId({ isPackaged = false, environment = process.env } = {}) {
  if (isPackaged) return String(clients.zoomPublicClientId || '').trim();
  return String(environment?.CMOE_ZOOM_PUBLIC_CLIENT_ID || clients.zoomDevelopmentPublicClientId || clients.zoomPublicClientId || '').trim();
}

module.exports = Object.freeze({ ...clients, selectZoomPublicClientId });
