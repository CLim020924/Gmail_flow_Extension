const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

class GmailFlowHost {
  constructor({ app, BrowserWindow, ipcMain, safeStorage, shell, rootPath, showWindow, isSmokeTest = false }) {
    this.app = app; this.BrowserWindow = BrowserWindow; this.ipcMain = ipcMain; this.safeStorage = safeStorage; this.shell = shell;
    this.rootPath = rootPath; this.showWindow = showWindow; this.isSmokeTest = isSmokeTest; this.timers = new Map(); this.alarmListeners = new Set(); this.runtimeListeners = new Set(); this.startupListeners = new Set(); this.installedListeners = new Set();
  }

  get preloadPath() { return path.join(this.rootPath, 'desktop', 'preload.js'); }
  get pagePath() { return path.join(this.rootPath, 'popup.html'); }

  async initialize() {
    if (!fs.existsSync(this.pagePath)) throw new Error(`Gmail Flow 모듈 파일을 찾지 못했습니다: ${this.pagePath}`);
    const { JsonStorage } = require(path.join(this.rootPath, 'desktop', 'storage.js'));
    const { DesktopOAuth, loadDesktopOAuthClientSecret } = require(path.join(this.rootPath, 'desktop', 'oauth.js'));
    const clientSecret = loadDesktopOAuthClientSecret(path.join(this.rootPath, 'desktop', 'oauth-credentials.local.js'));
    const accountRoot = this.isSmokeTest ? path.join(this.app.getPath('userData'), 'gmail-flow-desktop') : path.join(this.app.getPath('appData'), 'gmail-flow-desktop');
    await fs.promises.mkdir(accountRoot, { recursive: true });
    if (this.isSmokeTest) for (const name of ['gmail-flow-data.json', 'gmail-flow-oauth.json']) { try { await fs.promises.unlink(path.join(accountRoot, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    this.storage = new JsonStorage(path.join(accountRoot, 'gmail-flow-data.json'), (changes) => {
      this.BrowserWindow.getAllWindows().forEach((window) => { if (!window.isDestroyed()) window.webContents.send('storage:changed', changes); });
    });
    this.oauth = new DesktopOAuth({
      clientId: '1055778436707-kcjul780j0o7m4pu29bkpj2v6bn0e2r8.apps.googleusercontent.com', clientSecret,
      authFile: path.join(accountRoot, 'gmail-flow-oauth.json'), openExternal: (url) => this.openGoogleUrl(url),
      protect: (plain) => this.safeStorage.isEncryptionAvailable() ? `dpapi:${this.safeStorage.encryptString(plain).toString('base64')}` : `base64:${Buffer.from(plain, 'utf8').toString('base64')}`,
      unprotect: (protectedText) => { const [method, payload] = String(protectedText || '').split(':', 2); if (method === 'dpapi') return this.safeStorage.decryptString(Buffer.from(payload, 'base64')); if (method === 'base64') return Buffer.from(payload, 'base64').toString('utf8'); throw new Error('저장된 OAuth 정보를 해석하지 못했습니다.'); }
    });
    this.createChromeCompatibility();
    require(path.join(this.rootPath, 'background.js'));
    this.registerIpc();
    this.installedListeners.forEach((listener) => Promise.resolve(listener()).catch(console.error));
    this.startupListeners.forEach((listener) => Promise.resolve(listener()).catch(console.error));
  }

  async importLegacyRosters(rosters = []) {
    const migrationKey = 'workspaceRosterMigrationV1';
    if (await this.storage.get(migrationKey, false)) return { imported: 0 };
    const saved = await this.storage.get('savedRosters', []);
    const existingIds = new Set(saved.map((item) => item.id));
    const imported = (Array.isArray(rosters) ? rosters : []).filter((roster) => roster?.id && !existingIds.has(`workspace-${roster.id}`)).map((roster) => {
      const columns = (roster.columns || []).map((column, index) => ({
        id: column.id || `legacy-column-${index}`,
        name: String(column.name || `컬럼${index + 1}`),
        role: column.type === 'email' ? 'email' : 'variable',
        workspaceType: column.type || 'text'
      }));
      return {
        id: `workspace-${roster.id}`,
        name: roster.name || '이전 Workspace 명단',
        columns,
        rows: (roster.people || []).map((person) => ({ ...(person.values || {}), __workspacePersonId: person.id || '' })),
        linkedTemplateId: '', linkedStructureTemplateId: '',
        createdAt: roster.savedAt || new Date().toISOString(), updatedAt: roster.savedAt || new Date().toISOString()
      };
    });
    if (imported.length) await this.storage.set('savedRosters', [...imported, ...saved]);
    await this.storage.set(migrationKey, true);
    return { imported: imported.length };
  }

  createChromeCompatibility() {
    global.chrome = {
      storage: { local: { get: (keys) => this.storage.get(keys), set: (values) => this.storage.set(values) } },
      identity: { getAuthToken: ({ interactive = false, scopes, loginHint = '', selectAccount = false } = {}) => this.oauth.getToken(interactive, scopes, { loginHint, selectAccount }), removeCachedAuthToken: () => this.oauth.invalidateAccessToken(), clearAllCachedAuthTokens: () => this.oauth.clear(), getProfileUserInfo: () => this.oauth.getProfile() },
      runtime: { getManifest: () => ({ oauth2: { client_id: '1055778436707-kcjul780j0o7m4pu29bkpj2v6bn0e2r8.apps.googleusercontent.com' } }), onMessage: { addListener: (listener) => this.runtimeListeners.add(listener) }, onStartup: { addListener: (listener) => this.startupListeners.add(listener) }, onInstalled: { addListener: (listener) => this.installedListeners.add(listener) } },
      alarms: { clear: async (name) => { if (this.timers.has(name)) clearTimeout(this.timers.get(name)); this.timers.delete(name); return true; }, create: async (name, info = {}) => { if (this.timers.has(name)) clearTimeout(this.timers.get(name)); const delay = Math.max(0, Number(info.when || Date.now()) - Date.now()); this.timers.set(name, setTimeout(() => { this.timers.delete(name); this.alarmListeners.forEach((listener) => listener({ name, scheduledTime: info.when })); }, Math.min(delay, 2_147_483_647))); }, onAlarm: { addListener: (listener) => this.alarmListeners.add(listener) } }
    };
  }

  dispatchRuntimeMessage(message) {
    const listener = [...this.runtimeListeners][0]; if (!listener) return Promise.reject(new Error('Gmail Flow 백그라운드 작업이 준비되지 않았습니다.'));
    return new Promise((resolve, reject) => { let settled = false; const sendResponse = (response) => { if (!settled) { settled = true; resolve(response); } }; try { const result = listener(message, {}, sendResponse); if (result !== true && result !== undefined && !settled) Promise.resolve(result).then(sendResponse, reject); } catch (error) { reject(error); } });
  }

  async openGoogleUrl(url) {
    let parsed; try { parsed = new URL(url); } catch (_) { throw new Error('올바르지 않은 Gmail 주소입니다.'); }
    if (parsed.protocol !== 'https:' || !['accounts.google.com', 'mail.google.com'].includes(parsed.hostname)) throw new Error('허용되지 않은 외부 주소입니다.');
    const candidates = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'), process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')].filter(Boolean);
    const chromePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (chromePath) { const child = spawn(chromePath, [parsed.href], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); return { browser: 'chrome' }; }
    await this.shell.openExternal(parsed.href); return { browser: 'default' };
  }

  async summary() {
    let profile = { email: '' };
    try { profile = await this.oauth.getProfile(); } catch (_) {}
    const saved = await this.storage.get({ savedRosters: [], templates: [], structureTemplates: [] });
    return {
      connected: Boolean(profile?.email),
      email: profile?.email || '',
      rosters: Array.isArray(saved.savedRosters) ? saved.savedRosters.length : 0,
      templates: Array.isArray(saved.templates) ? saved.templates.length : 0,
      structures: Array.isArray(saved.structureTemplates) ? saved.structureTemplates.length : 0
    };
  }

  registerIpc() {
    this.ipcMain.handle('storage:get', (_event, keys) => this.storage.get(keys));
    this.ipcMain.handle('storage:set', (_event, values) => this.storage.set(values));
    this.ipcMain.handle('runtime:message', (_event, message) => this.dispatchRuntimeMessage(message));
    this.ipcMain.handle('identity:get-auth-token', (_event, options) => this.oauth.getToken(Boolean(options?.interactive), options?.scopes, { loginHint: options?.loginHint || '', selectAccount: Boolean(options?.selectAccount) }));
    this.ipcMain.handle('identity:clear-auth-tokens', () => this.oauth.clear());
    this.ipcMain.handle('identity:remove-cached-token', () => this.oauth.invalidateAccessToken());
    this.ipcMain.handle('identity:get-profile', () => this.oauth.getProfile());
    this.ipcMain.handle('gmail-flow:summary', () => this.summary());
    this.ipcMain.handle('window:show', () => { this.showWindow(); return { ok: true }; });
    this.ipcMain.handle('external:open-google', async (_event, url) => { try { return { ok: true, data: await this.openGoogleUrl(url) }; } catch (error) { return { ok: false, error: error.message }; } });
  }
}

module.exports = { GmailFlowHost };
