const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo';
const ZOOM_AUTH = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN = 'https://zoom.us/oauth/token';
const ZOOM_USERINFO = 'https://api.zoom.us/v2/users/me';

const base64Url = (value) => Buffer.from(value).toString('base64url');

class AuthManager {
  constructor({ filePath, openExternal, protect, unprotect }) {
    this.filePath = filePath;
    this.openExternal = openExternal;
    this.protect = protect;
    this.unprotect = unprotect;
    this.entries = {};
    this.pending = new Map();
    this.saveTail = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const envelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.entries = envelope?.format === 'cmoe-workspace-credentials-v1' ? JSON.parse(this.unprotect(envelope.data)) : {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('연결 자격증명 읽기 실패:', error);
      this.entries = {};
    }
  }

  async save() {
    const operation = this.saveTail.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const envelope = { format: 'cmoe-workspace-credentials-v1', data: this.protect(JSON.stringify(this.entries)) };
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.promises.writeFile(temporaryPath, JSON.stringify(envelope), 'utf8');
      try { await fs.promises.rename(temporaryPath, this.filePath); }
      catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        try { await fs.promises.unlink(this.filePath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        await fs.promises.rename(temporaryPath, this.filePath);
      }
    });
    this.saveTail = operation.catch(() => {});
    return operation;
  }

  async setConfig(connectionId, config) {
    const current = this.entries[connectionId] || {};
    this.entries[connectionId] = {
      ...current,
      provider: config.provider,
      type: config.type,
      clientId: String(config.clientId || '').trim(),
      clientSecret: String(config.clientSecret || '').trim() || current.clientSecret || '',
      redirectUri: String(config.redirectUri || '').trim(),
      updatedAt: new Date().toISOString()
    };
    await this.save();
    return this.publicStatus(connectionId);
  }

  publicStatus(connectionId) {
    const entry = this.entries[connectionId];
    return {
      configured: Boolean(entry?.clientId && entry?.clientSecret),
      connected: Boolean(entry?.refreshToken || (entry?.accessToken && Number(entry.expiresAt) > Date.now())),
      account: entry?.account || '',
      provider: entry?.provider || '',
      type: entry?.type || '',
      redirectUri: entry?.redirectUri || ''
    };
  }

  scopesFor(entry) {
    const identity = ['openid', 'email', 'profile'];
    if (entry.provider === 'google') {
      if (entry.type === 'forms') return [...identity, 'https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly', 'https://www.googleapis.com/auth/drive.file'];
      if (entry.type === 'drive') return [...identity, 'https://www.googleapis.com/auth/drive.appdata'];
      if (entry.type === 'gmail') return [...identity, 'https://www.googleapis.com/auth/gmail.compose'];
      return identity;
    }
    return ['meeting:write:meeting', 'user:read:user'];
  }

  async authorize(connectionId, options = {}) {
    if (this.pending.has(connectionId)) return this.pending.get(connectionId);
    const job = this.runAuthorize(connectionId, options).finally(() => this.pending.delete(connectionId));
    this.pending.set(connectionId, job);
    return job;
  }

  async runAuthorize(connectionId, { loginHint = '', selectAccount = true } = {}) {
    const entry = this.entries[connectionId];
    if (!entry?.clientId || !entry?.clientSecret) throw new Error('OAuth Client ID와 Client Secret을 먼저 등록해주세요.');
    const state = base64Url(crypto.randomBytes(24));
    const preferredRedirect = entry.provider === 'zoom' ? entry.redirectUri : '';
    const callback = await this.createCallbackServer(state, preferredRedirect);
    try {
      if (entry.provider === 'google') {
        const verifier = base64Url(crypto.randomBytes(48));
        const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
        const params = new URLSearchParams({ client_id: entry.clientId, redirect_uri: callback.redirectUri, response_type: 'code', scope: this.scopesFor(entry).join(' '), code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: selectAccount ? 'consent select_account' : 'consent' });
        if (loginHint) params.set('login_hint', loginHint);
        await this.openExternal(`${GOOGLE_AUTH}?${params}`);
        const code = await callback.codePromise;
        const tokens = await this.tokenRequest(GOOGLE_TOKEN, new URLSearchParams({ client_id: entry.clientId, client_secret: entry.clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: callback.redirectUri }));
        Object.assign(entry, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || entry.refreshToken || '', expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, scopes: this.scopesFor(entry) });
        const profile = await this.fetchJson(GOOGLE_USERINFO, entry.accessToken);
        entry.account = profile.email || '';
      } else if (entry.provider === 'zoom') {
        if (!entry.redirectUri) throw new Error('Zoom App Marketplace에 등록한 OAuth Redirect URL을 입력해주세요.');
        const params = new URLSearchParams({ response_type: 'code', client_id: entry.clientId, redirect_uri: callback.redirectUri, state });
        await this.openExternal(`${ZOOM_AUTH}?${params}`);
        const code = await callback.codePromise;
        const tokens = await this.tokenRequest(ZOOM_TOKEN, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri }), entry);
        Object.assign(entry, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || '', expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, scopes: this.scopesFor(entry) });
        const profile = await this.fetchJson(ZOOM_USERINFO, entry.accessToken);
        entry.account = profile.email || profile.id || '';
      } else throw new Error('지원하지 않는 OAuth 공급자입니다.');
      entry.updatedAt = new Date().toISOString();
      await this.save();
      return this.publicStatus(connectionId);
    } finally { callback.close(); }
  }

  createCallbackServer(expectedState, preferredRedirect = '') {
    let server;
    let timeout;
    let target;
    if (preferredRedirect) {
      target = new URL(preferredRedirect);
      if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol !== 'http:') throw new Error('데스크톱 Zoom OAuth Redirect URL은 http://127.0.0.1 또는 http://localhost 주소여야 합니다.');
    }
    const codePromise = new Promise((resolve, reject) => {
      server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const expectedPath = target?.pathname || '/oauth/callback';
        if (url.pathname !== expectedPath) { response.writeHead(404).end(); return; }
        const error = url.searchParams.get('error');
        const receivedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const success = !error && receivedState === expectedState && Boolean(code);
        response.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(success ? '<!doctype html><meta charset="utf-8"><h2>CMOE Workspace 계정 연결 완료</h2><p>이 창을 닫고 Workspace로 돌아가세요.</p>' : '<!doctype html><meta charset="utf-8"><h2>계정 연결 실패</h2><p>Workspace로 돌아가 다시 시도하세요.</p>');
        clearTimeout(timeout);
        if (error) reject(new Error(`로그인이 취소되었거나 거부되었습니다: ${error}`));
        else if (receivedState !== expectedState) reject(new Error('OAuth 상태 검증에 실패했습니다.'));
        else if (!code) reject(new Error('OAuth 인증 코드를 받지 못했습니다.'));
        else resolve(code);
      });
      server.on('error', reject);
      timeout = setTimeout(() => reject(new Error('계정 연결 시간이 초과되었습니다.')), 5 * 60 * 1000);
    });
    return new Promise((resolve, reject) => {
      server.listen(target ? Number(target.port) : 0, target?.hostname || '127.0.0.1', () => {
        const address = server.address();
        resolve({ redirectUri: target ? target.href : `http://127.0.0.1:${address.port}/oauth/callback`, codePromise, close: () => { clearTimeout(timeout); if (server.listening) server.close(); } });
      });
      server.once('error', reject);
    });
  }

  async tokenRequest(url, body, zoomEntry = null) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (zoomEntry) headers.Authorization = `Basic ${Buffer.from(`${zoomEntry.clientId}:${zoomEntry.clientSecret}`).toString('base64')}`;
    const response = await fetch(url, { method: 'POST', headers, body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || data.reason || data.message || data.error || 'OAuth 토큰 요청에 실패했습니다.');
    return data;
  }

  async refresh(connectionId) {
    const entry = this.entries[connectionId];
    if (!entry?.refreshToken) throw new Error('계정을 다시 연결해주세요.');
    let tokens;
    if (entry.provider === 'google') tokens = await this.tokenRequest(GOOGLE_TOKEN, new URLSearchParams({ client_id: entry.clientId, client_secret: entry.clientSecret, refresh_token: entry.refreshToken, grant_type: 'refresh_token' }));
    else tokens = await this.tokenRequest(ZOOM_TOKEN, new URLSearchParams({ refresh_token: entry.refreshToken, grant_type: 'refresh_token' }), entry);
    entry.accessToken = tokens.access_token; entry.refreshToken = tokens.refresh_token || entry.refreshToken; entry.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000; await this.save(); return entry.accessToken;
  }

  async getToken(connectionId) {
    const entry = this.entries[connectionId];
    if (!entry) throw new Error('연결 정보를 찾을 수 없습니다.');
    if (entry.accessToken && Number(entry.expiresAt) > Date.now() + 60_000) return entry.accessToken;
    return this.refresh(connectionId);
  }

  async fetchJsonWithMetadata(url, token, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data.message || data.reason || `API 요청 실패 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return { data, etag: response.headers?.get?.('etag') || '' };
  }

  async fetchJson(url, token, options = {}) {
    return (await this.fetchJsonWithMetadata(url, token, options)).data;
  }

  async request(connectionId, url, options = {}) {
    const token = await this.getToken(connectionId);
    return this.fetchJson(url, token, options);
  }

  async requestWithMetadata(connectionId, url, options = {}) {
    const token = await this.getToken(connectionId);
    return this.fetchJsonWithMetadata(url, token, options);
  }

  async disconnect(connectionId) {
    if (this.entries[connectionId]) {
      delete this.entries[connectionId].accessToken;
      delete this.entries[connectionId].refreshToken;
      delete this.entries[connectionId].expiresAt;
      delete this.entries[connectionId].account;
      await this.save();
    }
    return this.publicStatus(connectionId);
  }

  async remove(connectionId) {
    delete this.entries[connectionId];
    await this.save();
  }
}

module.exports = { AuthManager };
