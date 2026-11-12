const fs = require('node:fs');
const path = require('node:path');
const { createTransactionQueue } = require('./transaction-queue');
const { migrateLegacyGmailFlowData } = require('./gmail-data-migration');

const CLOUD_IDENTITY_MESSAGES = new Set(['connection-status', 'authorize-drive-sync', 'cloud-sync-download', 'cloud-sync-verify', 'cloud-sync-upload']);
function appShuttingDownError() {
  const error = new Error('앱 종료 준비 중에는 Gmail 계정이나 메일 작업을 변경할 수 없습니다.');
  error.code = 'APP_SHUTTING_DOWN';
  return error;
}

function createTrackedTransactionQueue() {
  const run = createTransactionQueue();
  const pending = new Set();
  const execute = (operation) => {
    const result = run(operation);
    pending.add(result);
    const remove = () => pending.delete(result);
    result.then(remove, remove);
    return result;
  };
  execute.drain = async () => {
    let failure = null;
    while (pending.size) {
      const results = await Promise.allSettled([...pending]);
      const rejected = results.find((result) => result.status === 'rejected');
      if (!failure && rejected) failure = rejected.reason;
    }
    if (failure) throw failure;
  };
  return execute;
}

async function retireLegacyWorkspaceOAuthFiles(accountRoot) {
  const names = ['gmail-flow-oauth.json', 'gmail-flow-oauth.json.bak'];
  const retiredRoot = path.join(accountRoot, 'retired-legacy-oauth');
  const retired = [];
  for (const name of names) {
    const sourcePath = path.join(accountRoot, name);
    try { await fs.promises.access(sourcePath); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await fs.promises.mkdir(retiredRoot, { recursive: true });
    let targetPath = path.join(retiredRoot, name);
    try { await fs.promises.access(targetPath); targetPath = path.join(retiredRoot, `${Date.now()}-${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.promises.rename(sourcePath, targetPath);
    retired.push(path.basename(targetPath));
  }
  return { retired, retiredRoot };
}

class GmailFlowHost {
  constructor({ app, BrowserWindow, ipcMain, safeStorage, shell, rootPath, showWindow, isSmokeTest = false, googleOAuthCredentials = null, loginBrowserLauncher = null, workspaceIdentity = null }) {
    this.app = app; this.BrowserWindow = BrowserWindow; this.ipcMain = ipcMain; this.safeStorage = safeStorage; this.shell = shell;
    this.rootPath = rootPath; this.showWindow = showWindow; this.isSmokeTest = isSmokeTest; this.googleOAuthCredentials = googleOAuthCredentials; this.loginBrowserLauncher = loginBrowserLauncher; this.workspaceIdentity = workspaceIdentity; this.timers = new Map(); this.alarmListeners = new Set(); this.runtimeListeners = new Set(); this.startupListeners = new Set(); this.installedListeners = new Set(); this.shutdownPrepared = false; this.shutdownGeneration = 0;
    this.runCloudIdentityOperation = createTrackedTransactionQueue();
    this.runStorageOperation = createTrackedTransactionQueue();
  }

  get preloadPath() { return path.join(this.rootPath, 'desktop', 'preload.js'); }
  get pagePath() { return path.join(this.rootPath, 'popup.html'); }

  async initialize() {
    if (!fs.existsSync(this.pagePath)) throw new Error(`Gmail Flow 모듈 파일을 찾지 못했습니다: ${this.pagePath}`);
    if (!this.workspaceIdentity) {
      const error = new Error('Workspace Gmail 계정 공급자를 준비하지 못해 Gmail Flow를 시작하지 않았습니다.');
      error.code = 'WORKSPACE_GMAIL_IDENTITY_REQUIRED';
      throw error;
    }
    const { JsonStorage } = require(path.join(this.rootPath, 'desktop', 'storage.js'));
    const accountRoot = path.join(this.app.getPath('userData'), 'gmail-flow-desktop');
    await fs.promises.mkdir(accountRoot, { recursive: true });
    if (!this.isSmokeTest) {
      this.legacyDataMigration = await migrateLegacyGmailFlowData({
        legacyRoot: path.join(this.app.getPath('appData'), 'gmail-flow-desktop'),
        targetRoot: accountRoot
      });
    }
    if (this.isSmokeTest) for (const name of ['gmail-flow-data.json', 'gmail-flow-data.json.bak']) { try { await fs.promises.unlink(path.join(accountRoot, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    this.storage = new JsonStorage(path.join(accountRoot, 'gmail-flow-data.json'), (changes) => {
      this.BrowserWindow.getAllWindows().forEach((window) => { if (!window.isDestroyed()) window.webContents.send('storage:changed', changes); });
    });
    this.oauth = this.workspaceIdentity;
    await this.oauth.migrateProtectionIfNeeded();
    await this.oauth.ensureClientBinding();
    try { this.legacyOAuthRetirement = await retireLegacyWorkspaceOAuthFiles(accountRoot); }
    catch (error) { console.warn('이전 Workspace Gmail OAuth 휴면 파일을 격리하지 못했습니다.', error); }
    this.createChromeCompatibility();
    require(path.join(this.rootPath, 'background.js'));
    this.registerIpc();
    this.installedListeners.forEach((listener) => Promise.resolve(listener()).catch(console.error));
    this.startupListeners.forEach((listener) => Promise.resolve(listener()).catch(console.error));
  }

  async importLegacyRosters(rosters = []) {
    const migrationKey = 'workspaceRosterMigrationV1';
    const migrationState = await this.storage.get({ [migrationKey]: false, savedRosters: [] });
    if (migrationState[migrationKey]) return { imported: 0 };
    const saved = Array.isArray(migrationState.savedRosters) ? migrationState.savedRosters : [];
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
    if (imported.length) await this.storage.set({ savedRosters: [...imported, ...saved] });
    await this.storage.set({ [migrationKey]: true });
    return { imported: imported.length };
  }

  createChromeCompatibility() {
    global.chrome = {
      storage: { local: { get: (keys) => this.storage.get(keys), set: (values) => this.runStorageOperation(() => this.storage.set(values)) } },
      identity: {
        getAuthToken: ({ interactive = false, scopes, loginHint = '', selectAccount = false, browserId = 'system', browserProfileId = '' } = {}) => this.oauth.getToken(interactive, scopes, { loginHint, selectAccount, browserId, browserProfileId }),
        removeCachedAuthToken: () => this.oauth.invalidateAccessToken(),
        clearAllCachedAuthTokens: () => this.oauth.clear(),
        getProfileUserInfo: () => this.oauth.getProfile(),
        runAccountOperation: (operation) => this.runCloudIdentityOperation(operation)
      },
      runtime: { getManifest: () => ({ oauth2: { client_id: this.oauth?.clientId || '1055778436707-pcmqgjp5icu0l6n368spm74amkcnnisv.apps.googleusercontent.com' } }), onMessage: { addListener: (listener) => this.runtimeListeners.add(listener) }, onStartup: { addListener: (listener) => this.startupListeners.add(listener) }, onInstalled: { addListener: (listener) => this.installedListeners.add(listener) } },
      alarms: { clear: async (name) => { if (this.timers.has(name)) clearTimeout(this.timers.get(name)); this.timers.delete(name); return true; }, create: async (name, info = {}) => { if (this.timers.has(name)) clearTimeout(this.timers.get(name)); const delay = Math.max(0, Number(info.when || Date.now()) - Date.now()); this.timers.set(name, setTimeout(() => { this.timers.delete(name); this.alarmListeners.forEach((listener) => listener({ name, scheduledTime: info.when })); }, Math.min(delay, 2_147_483_647))); }, onAlarm: { addListener: (listener) => this.alarmListeners.add(listener) } }
    };
  }

  dispatchRuntimeMessage(message, { allowDuringShutdown = false } = {}) {
    if (this.shutdownPrepared && !allowDuringShutdown) return Promise.reject(appShuttingDownError());
    const invoke = () => {
      const listener = [...this.runtimeListeners][0]; if (!listener) return Promise.reject(new Error('Gmail Flow 백그라운드 작업이 준비되지 않았습니다.'));
      return new Promise((resolve, reject) => { let settled = false; const sendResponse = (response) => { if (!settled) { settled = true; resolve(response); } }; try { const result = listener(message, {}, sendResponse); if (result !== true && result !== undefined && !settled) Promise.resolve(result).then(sendResponse, reject); } catch (error) { reject(error); } });
    };
    return CLOUD_IDENTITY_MESSAGES.has(message?.type) ? this.runCloudIdentityOperation(invoke) : invoke();
  }

  async openGoogleUrl(url) {
    if (String(url || '').length > 8192) throw new Error('Gmail 주소가 너무 깁니다.');
    let parsed; try { parsed = new URL(url); } catch (_) { throw new Error('올바르지 않은 Gmail 주소입니다.'); }
    if (parsed.protocol !== 'https:' || !['accounts.google.com', 'mail.google.com'].includes(parsed.hostname)) throw new Error('허용되지 않은 외부 주소입니다.');
    await this.shell.openExternal(parsed.href);
    return { browser: 'default' };
  }

  async openGoogleOAuthUrl(url, { browserId = 'system', browserProfileId = '' } = {}) {
    if (!this.loginBrowserLauncher || typeof this.loginBrowserLauncher.open !== 'function') {
      const error = new Error('Google 로그인 브라우저를 준비하지 못했습니다.');
      error.code = 'LOGIN_BROWSER_UNAVAILABLE';
      throw error;
    }
    return this.loginBrowserLauncher.open(url, {
      provider: 'google',
      authMode: 'public-pkce',
      browserId,
      browserProfileId
    });
  }

  async summary() {
    let profile = { email: '', rememberedEmail: '', needsAdditionalPermission: false, source: this.workspaceIdentity ? 'workspace' : 'legacy' };
    try { profile = await this.oauth.getProfile(); } catch (_) {}
    const saved = await this.storage.get({ savedRosters: [], templates: [], structureTemplates: [] });
    return {
      connected: Boolean(profile?.email) && !profile?.needsAdditionalPermission,
      email: profile?.needsAdditionalPermission ? '' : profile?.email || '',
      rememberedEmail: profile?.rememberedEmail || profile?.email || '',
      needsAdditionalPermission: Boolean(profile?.needsAdditionalPermission),
      source: profile?.source || (this.workspaceIdentity ? 'workspace' : 'legacy'),
      connectionId: profile?.connectionId || '',
      rosters: Array.isArray(saved.savedRosters) ? saved.savedRosters.length : 0,
      templates: Array.isArray(saved.templates) ? saved.templates.length : 0,
      structures: Array.isArray(saved.structureTemplates) ? saved.structureTemplates.length : 0
    };
  }

  notifyWorkspaceIdentityChanged(payload = {}) {
    const message = {
      revision: Number(payload?._revision || payload?.revision || 0),
      changedAt: new Date().toISOString()
    };
    this.BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send('workspace:account-changed', message);
    });
  }

  async flushMailQueue() {
    const generation = ++this.shutdownGeneration;
    const response = await this.dispatchRuntimeMessage({ type: 'prepare-mail-queue-for-quit' }, { allowDuringShutdown: true });
    if (!response?.ok) throw new Error(response?.error || 'Gmail 메일 작업 저장 완료를 확인하지 못했습니다.');
    if (generation !== this.shutdownGeneration) return { canceled: true };
    this.shutdownPrepared = true;
    // prepare-mail-queue-for-quit already waits for every durable Gmail batch
    // operation. Drive/OAuth work is remote-only and may remain pending without
    // risking the locally persisted queue, so only renderer storage writes are
    // part of the fatal quit barrier here.
    const drains = await Promise.allSettled([this.runStorageOperation.drain()]);
    const failed = drains.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (generation !== this.shutdownGeneration) return { canceled: true };
    return response.data || { idle: true };
  }

  async resumeMailQueue() {
    this.shutdownGeneration += 1;
    this.shutdownPrepared = false;
    const response = await this.dispatchRuntimeMessage({ type: 'resume-mail-queue-after-quit-canceled' }, { allowDuringShutdown: true });
    if (!response?.ok) throw new Error(response?.error || 'Gmail 메일 작업을 다시 시작하지 못했습니다.');
    return response.data || { resumed: true };
  }

  registerIpc() {
    this.ipcMain.handle('storage:get', (_event, keys) => this.storage.get(keys));
    this.ipcMain.handle('storage:set', (_event, values) => {
      if (this.shutdownPrepared) return Promise.reject(appShuttingDownError());
      return this.runStorageOperation(() => this.storage.set(values));
    });
    this.ipcMain.handle('runtime:message', (_event, message) => this.dispatchRuntimeMessage(message));
    const runRendererIdentityOperation = (operation) => {
      if (this.shutdownPrepared) return Promise.reject(appShuttingDownError());
      return this.runCloudIdentityOperation(operation);
    };
    this.ipcMain.handle('identity:get-auth-token', (_event, options) => runRendererIdentityOperation(() => this.oauth.getToken(Boolean(options?.interactive), options?.scopes, { loginHint: options?.loginHint || '', selectAccount: Boolean(options?.selectAccount), browserId: options?.browserId || 'system', browserProfileId: options?.browserProfileId || '' })));
    this.ipcMain.handle('identity:clear-auth-tokens', () => runRendererIdentityOperation(() => this.oauth.clear()));
    this.ipcMain.handle('identity:remove-cached-token', () => runRendererIdentityOperation(() => this.oauth.invalidateAccessToken()));
    this.ipcMain.handle('identity:get-profile', () => runRendererIdentityOperation(() => this.oauth.getProfile()));
    this.ipcMain.handle('gmail-flow:summary', () => runRendererIdentityOperation(() => this.summary()));
    this.ipcMain.handle('window:show', () => { this.showWindow(); return { ok: true }; });
    this.ipcMain.handle('external:open-google', async (_event, url) => { try { return { ok: true, data: await this.openGoogleUrl(url) }; } catch (error) { return { ok: false, error: error.message }; } });
  }
}

module.exports = { GmailFlowHost, retireLegacyWorkspaceOAuthFiles };
