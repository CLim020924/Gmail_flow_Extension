const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { URL } = require('node:url');

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

const base64Url = (value) => Buffer.from(value).toString('base64url');

function loadDesktopOAuthClientSecret(credentialsPath = require('node:path').join(__dirname, 'oauth-credentials.local.js')) {
  if (!fs.existsSync(credentialsPath)) return '';
  const credentials = require(credentialsPath);
  return String(credentials?.clientSecret || '').trim();
}

class DesktopOAuth {
  constructor({ clientId, clientSecret, authFile, openExternal, protect = (value) => value, unprotect = (value) => value }) {
    this.clientId = clientId;
    this.clientSecret = String(clientSecret || '').trim();
    this.authFile = authFile;
    this.openExternal = openExternal;
    this.protect = protect;
    this.unprotect = unprotect;
    this.auth = {};
    this.pendingLogin = null;
    this.load();
  }

  load() {
    try {
      const envelope = JSON.parse(fs.readFileSync(this.authFile, 'utf8')) || {};
      this.auth = envelope.format === 'gmail-flow-oauth-v1'
        ? JSON.parse(this.unprotect(envelope.data))
        : envelope;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backupPath = `${this.authFile}.unreadable-${Date.now()}.bak`;
        try {
          fs.renameSync(this.authFile, backupPath);
          this.recovery = { required: true, backupPath };
          console.warn('저장된 Google 로그인을 읽을 수 없어 안전하게 백업했습니다. 계정을 다시 연결해주세요.');
        } catch (backupError) {
          this.recovery = { required: true, backupPath: '', error: backupError.message };
          console.warn('저장된 Google 로그인을 읽을 수 없습니다. 계정을 다시 연결해주세요.');
        }
      }
      this.auth = {};
    }
  }

  async save() {
    await fs.promises.mkdir(require('node:path').dirname(this.authFile), { recursive: true });
    const envelope = {
      format: 'gmail-flow-oauth-v1',
      data: this.protect(JSON.stringify(this.auth))
    };
    await fs.promises.writeFile(this.authFile, JSON.stringify(envelope, null, 2), 'utf8');
  }

  grantedScopes() {
    return Array.isArray(this.auth.scopes) && this.auth.scopes.length ? this.auth.scopes : (this.auth.refreshToken ? [GMAIL_SCOPE] : []);
  }

  async getToken(interactive = false, requestedScopes = [GMAIL_SCOPE], loginOptions = {}) {
    const scopes = [...new Set((requestedScopes?.length ? requestedScopes : [GMAIL_SCOPE]).filter(Boolean))];
    const missingScopes = scopes.filter((scope) => !this.grantedScopes().includes(scope));
    if (missingScopes.length) {
      if (!interactive) throw this.authError('Google Drive 동기화 권한 승인이 필요합니다.');
      return this.login([...new Set([...this.grantedScopes(), ...scopes])], loginOptions);
    }
    if (this.auth.accessToken && Number(this.auth.expiresAt || 0) > Date.now() + 60_000) {
      return this.auth.accessToken;
    }
    if (this.auth.refreshToken) {
      try {
        return await this.refreshToken();
      } catch (error) {
        console.error('OAuth 토큰 갱신 실패:', error);
        await this.invalidateAccessToken();
        if (!interactive) throw this.authError('Google 계정을 다시 연결해 주세요.');
      }
    }
    if (!interactive) throw this.authError('Gmail 계정 연결이 필요합니다.');
    return this.login(scopes, loginOptions);
  }

  authError(message) {
    const error = new Error(message);
    error.code = 'AUTH_REQUIRED';
    return error;
  }

  async login(scopes = [GMAIL_SCOPE], loginOptions = {}) {
    if (this.pendingLogin) return this.pendingLogin;
    this.pendingLogin = this.runLogin(scopes, loginOptions).finally(() => { this.pendingLogin = null; });
    return this.pendingLogin;
  }

  async runLogin(scopes, { loginHint = '', selectAccount = false } = {}) {
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64Url(crypto.randomBytes(24));

    const callback = await this.createCallbackServer(state);
    const rememberedEmail = String(loginHint || (!selectAccount ? this.auth.email : '') || '').trim();
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: callback.redirectUri,
      response_type: 'code',
      scope: [...new Set([GMAIL_SCOPE, ...scopes])].join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: selectAccount ? 'consent select_account' : 'consent'
    });
    if (rememberedEmail) params.set('login_hint', rememberedEmail);

    await this.openExternal(`${AUTHORIZATION_URL}?${params.toString()}`);

    try {
      const code = await callback.codePromise;
      const tokens = await this.exchangeCode(code, callback.redirectUri, verifier);
      this.auth = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || this.auth.refreshToken || '',
        expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        scopes: [...new Set([GMAIL_SCOPE, ...scopes])],
        email: ''
      };
      this.auth.email = await this.fetchEmail(this.auth.accessToken);
      await this.save();
      return this.auth.accessToken;
    } finally {
      callback.close();
    }
  }

  createCallbackServer(expectedState) {
    let server;
    let timeout;
    const codePromise = new Promise((resolve, reject) => {
      server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname !== '/oauth2/callback') {
          response.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const success = !error && state === expectedState && Boolean(code);
        response.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(success
          ? '<!doctype html><meta charset="utf-8"><title>Gmail Flow</title><h2>Gmail Flow 계정 연결이 완료되었습니다.</h2><p>이 창을 닫고 앱으로 돌아가세요.</p>'
          : '<!doctype html><meta charset="utf-8"><title>Gmail Flow</title><h2>계정 연결을 완료하지 못했습니다.</h2><p>앱으로 돌아가 다시 시도하세요.</p>');
        clearTimeout(timeout);
        if (error) reject(this.authError(`Google 로그인이 취소되었습니다: ${error}`));
        else if (state !== expectedState) reject(this.authError('로그인 상태 확인에 실패했습니다.'));
        else if (!code) reject(this.authError('Google 인증 코드를 받지 못했습니다.'));
        else resolve(code);
      });
      server.on('error', reject);
      timeout = setTimeout(() => reject(this.authError('Google 로그인 시간이 초과되었습니다.')), 5 * 60 * 1000);
    });

    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({
          redirectUri: `http://127.0.0.1:${port}/oauth2/callback`,
          codePromise,
          close: () => {
            clearTimeout(timeout);
            if (server.listening) server.close();
          }
        });
      });
      server.once('error', reject);
    });
  }

  async exchangeCode(code, redirectUri, verifier) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    return this.tokenRequest(body);
  }

  async refreshToken() {
    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.auth.refreshToken,
      grant_type: 'refresh_token'
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const tokens = await this.tokenRequest(body);
    this.auth.accessToken = tokens.access_token;
    this.auth.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
    await this.save();
    return this.auth.accessToken;
  }

  async tokenRequest(body) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json();
    if (!response.ok) throw this.authError(data.error_description || data.error || 'Google OAuth 요청에 실패했습니다.');
    return data;
  }

  async fetchEmail(token) {
    const response = await fetch(GMAIL_PROFILE_URL, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'Gmail 계정 정보를 가져오지 못했습니다.');
    return data.emailAddress || '';
  }

  async getProfile() {
    if (!this.auth.email && this.auth.refreshToken) {
      const token = await this.getToken(false);
      this.auth.email = await this.fetchEmail(token);
      await this.save();
    }
    return { email: this.auth.email || '', id: '' };
  }

  async invalidateAccessToken() {
    this.auth.accessToken = '';
    this.auth.expiresAt = 0;
    await this.save();
  }

  async clear() {
    const token = this.auth.refreshToken || this.auth.accessToken;
    this.auth = {};
    try { await fs.promises.unlink(this.authFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (token) {
      try {
        await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      } catch (_) {}
    }
  }
}

module.exports = { DesktopOAuth, loadDesktopOAuthClientSecret };
