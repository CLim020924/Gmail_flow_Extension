const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_TOKEN_TIMEOUT_MS,
  DEFAULT_DRIVE_TIMEOUT_MS,
  fetchAndReadWithTimeout
} = require('./network-timeout');
const { secureStorageUnavailableError } = require('./credential-protection');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo';
const ZOOM_AUTH = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN = 'https://zoom.us/oauth/token';
const ZOOM_USERINFO = 'https://api.zoom.us/v2/users/me';
const GOOGLE_GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const CREDENTIAL_FORMAT_V1 = 'cmoe-workspace-credentials-v1';
const CREDENTIAL_FORMAT_V2 = 'cmoe-workspace-credentials-v2';
const GOOGLE_PROVIDER_CONFIG_ID = 'provider-config-google';

const base64Url = (value) => Buffer.from(value).toString('base64url');

function normalizedConnectionId(value) {
  const connectionId = String(value || '').trim();
  if (!connectionId || connectionId.length > 200 || /[\u0000-\u001f\u007f]/.test(connectionId) || ['__proto__', 'prototype', 'constructor', GOOGLE_PROVIDER_CONFIG_ID].includes(connectionId)) throw new Error('계정 연결 ID가 올바르지 않습니다.');
  return connectionId;
}

function normalizedGoogleClientId(value) {
  const clientId = String(value || '').trim();
  return clientId && clientId.length <= 512 && /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)
    ? clientId
    : '';
}

function normalizedGoogleClientSecret(value) {
  const clientSecret = String(value || '').trim();
  return clientSecret && clientSecret.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(clientSecret)
    ? clientSecret
    : '';
}

function normalizedGoogleCredentials(clientIdValue, clientSecretValue) {
  const clientId = normalizedGoogleClientId(clientIdValue);
  const clientSecret = normalizedGoogleClientSecret(clientSecretValue);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function temporaryPathFor(filePath) {
  return `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
}

async function replaceWithoutDeletingLiveFile(sourcePath, targetPath) {
  try { await fs.promises.rename(sourcePath, targetPath); }
  catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await fs.promises.copyFile(sourcePath, targetPath);
    await fs.promises.unlink(sourcePath);
  }
}

function normalizedProtectedPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const protection = String(value.protection || '');
    const data = String(value.data || '');
    if (!protection || !data) throw new Error('자격증명 보호 결과가 올바르지 않습니다.');
    if (protection === 'base64') throw secureStorageUnavailableError();
    return { protection, data };
  }
  const text = String(value || '');
  const separator = text.indexOf(':');
  if (separator > 0) {
    const protection = text.slice(0, separator);
    const data = text.slice(separator + 1);
    if (protection === 'base64') throw secureStorageUnavailableError();
    if (protection === 'dpapi') return { protection, data };
  }
  if (!text) throw new Error('자격증명 보호 결과가 비어 있습니다.');
  return { protection: 'custom', data: text };
}

function credentialEntriesFromRaw(raw, unprotect) {
  const envelope = JSON.parse(raw);
  let plainText;
  let needsProtectionMigration = false;
  if (envelope?.format === CREDENTIAL_FORMAT_V2 && typeof envelope.data === 'string' && typeof envelope.protection === 'string') {
    plainText = unprotect(envelope.data, envelope.protection);
  } else if (envelope?.format === CREDENTIAL_FORMAT_V1 && typeof envelope.data === 'string') {
    // V1 was written after app.ready on Windows, so its unlabelled payload is DPAPI ciphertext.
    // Never guess that an unreadable payload is plaintext base64; preserve it for recovery instead.
    plainText = unprotect(envelope.data, 'legacy-dpapi');
    needsProtectionMigration = true;
  } else throw new Error('지원하지 않는 Workspace 자격증명 파일입니다.');
  const entries = JSON.parse(plainText);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Workspace 자격증명 내용이 올바른 객체가 아닙니다.');
  return { entries, needsProtectionMigration };
}

class AuthManager {
  constructor({ filePath, openExternal, protect, unprotect, clientDefaults = {}, networkTimeouts = {} }) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.openExternal = openExternal;
    this.protect = protect;
    this.unprotect = unprotect;
    this.clientDefaults = {
      googleClientId: String(clientDefaults.googleClientId || '').trim(),
      googleClientSecret: String(clientDefaults.googleClientSecret || '').trim(),
      zoomPublicClientId: String(clientDefaults.zoomPublicClientId || '').trim()
    };
    this.networkTimeouts = {
      token: Number(networkTimeouts.token) > 0 ? Number(networkTimeouts.token) : DEFAULT_TOKEN_TIMEOUT_MS,
      api: Number(networkTimeouts.api) > 0 ? Number(networkTimeouts.api) : DEFAULT_API_TIMEOUT_MS,
      drive: Number(networkTimeouts.drive) > 0 ? Number(networkTimeouts.drive) : DEFAULT_DRIVE_TIMEOUT_MS
    };
    this.entries = {};
    this.recoveredFromBackup = false;
    this.needsProtectionMigration = false;
    this.credentialRecovery = null;
    this.pending = new Map();
    this.activeAuthorizations = new Map();
    this.saveTail = Promise.resolve();
    this.load();
  }

  load() {
    let primaryError = null;
    try {
      const loaded = credentialEntriesFromRaw(fs.readFileSync(this.filePath, 'utf8'), this.unprotect);
      this.entries = loaded.entries;
      this.needsProtectionMigration = loaded.needsProtectionMigration;
      return;
    } catch (error) {
      primaryError = error;
    }
    try {
      const loaded = credentialEntriesFromRaw(fs.readFileSync(this.backupPath, 'utf8'), this.unprotect);
      this.entries = loaded.entries;
      this.needsProtectionMigration = loaded.needsProtectionMigration;
      this.recoveredFromBackup = true;
      console.error('기본 연결 자격증명 파일을 읽지 못해 안전 백업을 사용합니다:', primaryError);
      return;
    } catch (backupError) {
      if (primaryError?.code === 'ENOENT' && backupError.code === 'ENOENT') { this.entries = {}; return; }
      this.entries = {};
      this.credentialRecovery = {
        required: true,
        reason: primaryError?.code === 'SECURE_STORAGE_UNAVAILABLE' || backupError?.code === 'SECURE_STORAGE_UNAVAILABLE'
          ? 'SECURE_STORAGE_UNAVAILABLE'
          : 'AUTH_RECONNECT_REQUIRED',
        primaryError,
        backupError,
        timestamp: Date.now(),
        preservedPaths: []
      };
      console.error('저장된 계정 자격증명을 읽지 못했습니다. Workspace는 계속 시작하고 계정만 다시 연결해야 합니다.', primaryError, backupError);
    }
  }

  async preserveUnreadableCredentialFiles() {
    if (!this.credentialRecovery?.required || this.credentialRecovery.preservedPaths.length) return;
    const timestamp = this.credentialRecovery.timestamp;
    const preservedPaths = [];
    for (const sourcePath of [this.filePath, this.backupPath]) {
      try {
        const destinationPath = `${sourcePath}.unreadable-${timestamp}.bak`;
        await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
        const [sourceStat, destinationStat] = await Promise.all([fs.promises.stat(sourcePath), fs.promises.stat(destinationPath)]);
        if (sourceStat.size !== destinationStat.size) throw new Error('자격증명 복구 사본 크기가 원본과 일치하지 않습니다.');
        preservedPaths.push(destinationPath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error.code === 'EEXIST') {
          preservedPaths.push(`${sourcePath}.unreadable-${timestamp}.bak`);
          continue;
        }
        throw error;
      }
    }
    this.credentialRecovery.preservedPaths = preservedPaths;
  }

  async save() {
    const operation = this.saveTail.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const sealed = normalizedProtectedPayload(this.protect(JSON.stringify(this.entries)));
      const envelope = { format: CREDENTIAL_FORMAT_V2, protection: sealed.protection, data: sealed.data };
      await this.preserveUnreadableCredentialFiles();
      const temporaryPath = temporaryPathFor(this.filePath);
      await fs.promises.writeFile(temporaryPath, JSON.stringify(envelope), 'utf8');
      try {
        let currentRaw = null;
        try {
          currentRaw = await fs.promises.readFile(this.filePath, 'utf8');
          credentialEntriesFromRaw(currentRaw, this.unprotect);
        } catch (error) {
          currentRaw = null;
          if (error.code !== 'ENOENT' && !this.recoveredFromBackup && !this.credentialRecovery?.required) throw error;
        }
        if (currentRaw != null) {
          const backupTemporaryPath = temporaryPathFor(this.backupPath);
          await fs.promises.writeFile(backupTemporaryPath, currentRaw, 'utf8');
          try { await replaceWithoutDeletingLiveFile(backupTemporaryPath, this.backupPath); }
          finally { try { await fs.promises.unlink(backupTemporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        }
        await replaceWithoutDeletingLiveFile(temporaryPath, this.filePath);
        this.recoveredFromBackup = false;
        this.needsProtectionMigration = false;
        if (this.credentialRecovery) this.credentialRecovery.required = false;
      } finally {
        try { await fs.promises.unlink(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    });
    this.saveTail = operation.catch(() => {});
    return operation;
  }

  async migrateProtectionIfNeeded() {
    if (!this.needsProtectionMigration) return { migrated: false };
    await this.save();
    return { migrated: true };
  }

  async replaceEntryAndSave(connectionId, nextEntry) {
    connectionId = normalizedConnectionId(connectionId);
    const previousEntries = this.entries;
    const nextEntries = { ...previousEntries };
    if (nextEntry == null) delete nextEntries[connectionId];
    else nextEntries[connectionId] = nextEntry;
    this.entries = nextEntries;
    try { await this.save(); }
    catch (error) {
      // Only roll back the exact immutable snapshot we installed. A newer
      // deletion/configuration creates a different map and must always win.
      if (this.entries === nextEntries) this.entries = previousEntries;
      throw error;
    }
  }

  async replaceEntriesAndSave(nextEntries) {
    if (!nextEntries || typeof nextEntries !== 'object' || Array.isArray(nextEntries)) throw new TypeError('계정 자격증명 상태가 올바르지 않습니다.');
    const previousEntries = this.entries;
    this.entries = nextEntries;
    try { await this.save(); }
    catch (error) {
      if (this.entries === nextEntries) this.entries = previousEntries;
      throw error;
    }
  }

  reusableGoogleClientCredentials() {
    const providerConfig = this.entries[GOOGLE_PROVIDER_CONFIG_ID];
    const candidates = [
      { source: 'bundled', clientId: this.clientDefaults.googleClientId, clientSecret: this.clientDefaults.googleClientSecret },
      { source: 'legacy-override', clientId: providerConfig?.provider === 'google' ? providerConfig.clientId : '', clientSecret: providerConfig?.provider === 'google' ? providerConfig.clientSecret : '' },
      ...Object.entries(this.entries)
        .filter(([connectionId, entry]) => connectionId !== GOOGLE_PROVIDER_CONFIG_ID && entry?.provider === 'google')
        .map(([, entry]) => ({ source: 'existing-connection', clientId: entry.clientId, clientSecret: entry.clientSecret }))
    ];
    for (const candidate of candidates) {
      const credentials = normalizedGoogleCredentials(candidate.clientId, candidate.clientSecret);
      if (credentials) return { source: candidate.source, ...credentials };
    }
    return null;
  }

  availableGoogleClientId() {
    const providerConfig = this.entries[GOOGLE_PROVIDER_CONFIG_ID];
    const candidates = [
      { source: 'bundled', clientId: this.clientDefaults.googleClientId },
      { source: 'legacy-override', clientId: providerConfig?.provider === 'google' ? providerConfig.clientId : '' },
      ...Object.entries(this.entries)
        .filter(([connectionId, entry]) => connectionId !== GOOGLE_PROVIDER_CONFIG_ID && entry?.provider === 'google')
        .map(([, entry]) => ({ source: 'existing-connection', clientId: entry.clientId }))
    ];
    for (const candidate of candidates) {
      const clientId = normalizedGoogleClientId(candidate.clientId);
      if (clientId) return { source: candidate.source, clientId };
    }
    return null;
  }

  reusablePublicClientId(provider) {
    if (provider === 'google') return this.reusableGoogleClientCredentials()?.clientId || '';
    const configuredDefault = provider === 'zoom' ? this.clientDefaults.zoomPublicClientId : '';
    if (configuredDefault) return configuredDefault;
    const reusable = Object.values(this.entries).find((entry) => entry?.provider === provider
      && entry?.clientId
      && (entry.clientValidatedAt || entry.refreshToken || entry.accessToken)
      && entry.authMode === 'public-pkce');
    return String(reusable?.clientId || '').trim();
  }

  reusableGoogleClientSecret() {
    return this.reusableGoogleClientCredentials()?.clientSecret || '';
  }

  providerCredentials(provider) {
    if (provider !== 'google') return null;
    const credentials = this.reusableGoogleClientCredentials();
    return credentials ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret } : null;
  }

  async reconcileGoogleConnectionCredentials() {
    const credentials = this.reusableGoogleClientCredentials();
    if (!credentials || !['legacy-override', 'bundled'].includes(credentials.source)) return { updated: 0, invalidated: 0, hydrated: 0, removedLegacyOverride: false };
    const clientId = String(credentials.clientId || '').trim();
    const clientSecret = String(credentials.clientSecret || '').trim();
    if (!clientId || !clientSecret) return { updated: 0, invalidated: 0, hydrated: 0 };

    const nextEntries = { ...this.entries };
    const removedLegacyOverride = credentials.source === 'bundled' && Object.hasOwn(nextEntries, GOOGLE_PROVIDER_CONFIG_ID);
    if (removedLegacyOverride) delete nextEntries[GOOGLE_PROVIDER_CONFIG_ID];
    const updatedAt = new Date().toISOString();
    let updated = 0;
    let invalidated = 0;
    let hydrated = 0;
    Object.entries(nextEntries).forEach(([connectionId, entry]) => {
      if (connectionId === GOOGLE_PROVIDER_CONFIG_ID || entry?.provider !== 'google') return;
      const previousClientId = String(entry.clientId || '').trim();
      const previousClientSecret = String(entry.clientSecret || '').trim();
      if (previousClientId === clientId && previousClientSecret === clientSecret) return;
      const clientIdentityChanged = previousClientId !== clientId;
      const next = { ...entry, clientId, clientSecret, authMode: 'public-pkce', updatedAt };
      if (clientIdentityChanged) {
        ['accessToken', 'refreshToken', 'expiresAt', 'account', 'scopes', 'clientValidatedAt'].forEach((key) => delete next[key]);
        invalidated += 1;
      } else if (!previousClientSecret) hydrated += 1;
      nextEntries[connectionId] = next;
      updated += 1;
    });
    if (!updated && !removedLegacyOverride) return { updated: 0, invalidated: 0, hydrated: 0, removedLegacyOverride: false };
    await this.replaceEntriesAndSave(nextEntries);
    return { updated, invalidated, hydrated, removedLegacyOverride };
  }

  async reconcileZoomConnectionCredentials() {
    const clientId = String(this.clientDefaults.zoomPublicClientId || '').trim();
    if (!clientId) return { updated: 0, invalidated: 0, hydrated: 0 };

    const nextEntries = { ...this.entries };
    const updatedAt = new Date().toISOString();
    let updated = 0;
    let invalidated = 0;
    let hydrated = 0;
    Object.entries(nextEntries).forEach(([connectionId, entry]) => {
      if (entry?.provider !== 'zoom') return;
      const previousClientId = String(entry.clientId || '').trim();
      const previousAuthMode = String(entry.authMode || (entry.clientSecret ? 'confidential' : 'public-pkce')).trim();
      const alreadyBundled = previousClientId === clientId
        && previousAuthMode === 'public-pkce'
        && !entry.clientSecret
        && !entry.redirectUri;
      if (alreadyBundled) return;
      const tokenIdentityChanged = previousClientId !== clientId || previousAuthMode !== 'public-pkce';
      const next = { ...entry, clientId, clientSecret: '', authMode: 'public-pkce', redirectUri: '', updatedAt };
      if (tokenIdentityChanged) {
        ['accessToken', 'refreshToken', 'expiresAt', 'account', 'scopes', 'clientValidatedAt'].forEach((key) => delete next[key]);
        invalidated += 1;
      } else hydrated += 1;
      nextEntries[connectionId] = next;
      updated += 1;
    });
    if (!updated) return { updated: 0, invalidated: 0, hydrated: 0 };
    await this.replaceEntriesAndSave(nextEntries);
    return { updated, invalidated, hydrated };
  }

  async setConfig(connectionId, config) {
    connectionId = normalizedConnectionId(connectionId);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('계정 연결 설정이 올바르지 않습니다.');
    const current = this.entries[connectionId] || {};
    const provider = config.provider;
    const type = config.type;
    const requestedClientId = String(config.clientId || '').trim();
    const requestedMode = String(config.authMode || '').trim();
    const requestedSecret = String(config.clientSecret || '').trim();
    const requestedRedirect = String(config.redirectUri || '').trim();
    if (requestedClientId.length > 512 || requestedSecret.length > 4096 || requestedRedirect.length > 2048) throw new Error('계정 연결 설정 값이 너무 깁니다.');
    if (!['google', 'zoom'].includes(provider)) throw new Error('지원하지 않는 OAuth 공급자입니다.');
    if ((provider === 'zoom' && type !== 'zoom') || (provider === 'google' && !['forms', 'drive', 'gmail'].includes(type))) throw new Error('서비스와 OAuth 공급자 설정이 일치하지 않습니다.');
    let clientId;
    let clientSecret;
    if (provider === 'google') {
      const credentials = this.reusableGoogleClientCredentials();
      clientId = credentials?.clientId || '';
      clientSecret = credentials?.clientSecret || '';
    } else {
      clientId = requestedClientId || current.clientId || this.reusablePublicClientId(provider);
      clientSecret = requestedMode === 'public-pkce' ? '' : requestedSecret || current.clientSecret || '';
    }
    const authMode = provider === 'zoom'
      ? requestedMode || current.authMode || (clientSecret ? 'confidential' : 'public-pkce')
      : 'public-pkce';
    if (!clientId) {
      if (provider === 'zoom') {
        const error = new Error('이 설치본에서 Zoom 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.');
        error.code = 'ZOOM_OAUTH_CONFIG_REQUIRED';
        throw error;
      }
      const error = new Error('이 설치본에서 Google 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.');
      error.code = 'GOOGLE_OAUTH_CONFIG_REQUIRED';
      throw error;
    }
    if (provider === 'google' && !clientSecret) {
      const error = new Error('이 설치본에서 Google 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.');
      error.code = 'GOOGLE_OAUTH_CONFIG_REQUIRED';
      throw error;
    }
    if (provider === 'zoom' && authMode === 'confidential' && (!clientSecret || !String(requestedRedirect || current.redirectUri || '').trim())) {
      throw new Error('이전 Zoom 연결을 계속 사용할 수 없습니다. 계정을 삭제한 뒤 다시 연결해주세요.');
    }
    const next = {
      ...current,
      provider,
      type,
      authMode,
      clientId,
      clientSecret,
      redirectUri: authMode === 'public-pkce' ? '' : String(requestedRedirect || current.redirectUri || '').trim(),
      updatedAt: new Date().toISOString()
    };
    const clientChanged = Boolean(current.clientId && (current.clientId !== clientId || current.clientSecret !== clientSecret || current.provider !== provider || current.type !== type || (current.authMode || (current.clientSecret ? 'confidential' : 'public-pkce')) !== authMode));
    if (clientChanged) {
      ['accessToken', 'refreshToken', 'expiresAt', 'account', 'scopes', 'clientValidatedAt'].forEach((key) => delete next[key]);
    }
    await this.replaceEntryAndSave(connectionId, next);
    return this.publicStatus(connectionId);
  }

  publicStatus(connectionId) {
    connectionId = normalizedConnectionId(connectionId);
    const entry = this.entries[connectionId];
    const configured = entry?.provider === 'google'
      ? Boolean(entry.clientId && entry.clientSecret)
      : entry?.provider === 'zoom'
        ? Boolean(entry.clientId && (entry.authMode === 'public-pkce' || (entry.clientSecret && entry.redirectUri)))
        : false;
    return {
      configured,
      connected: Boolean(entry?.refreshToken || (entry?.accessToken && Number(entry.expiresAt) > Date.now())),
      account: entry?.account || '',
      provider: entry?.provider || '',
      type: entry?.type || '',
      authMode: entry?.authMode || '',
      redirectUri: entry?.redirectUri || ''
    };
  }

  providerStatus(type) {
    if (!['forms', 'drive', 'gmail', 'zoom'].includes(type)) throw new Error('지원하지 않는 계정 연결 종류입니다.');
    const provider = type === 'zoom' ? 'zoom' : 'google';
    const googleCredentials = provider === 'google' ? this.reusableGoogleClientCredentials() : null;
    const googleClientId = provider === 'google' ? this.availableGoogleClientId() : null;
    const savedGoogleOverride = provider === 'google' ? this.entries[GOOGLE_PROVIDER_CONFIG_ID] : null;
    const hasInvalidOverride = Boolean(savedGoogleOverride?.provider === 'google'
      && !normalizedGoogleCredentials(savedGoogleOverride.clientId, savedGoogleOverride.clientSecret));
    const clientId = provider === 'google' ? googleCredentials?.clientId || '' : this.reusablePublicClientId(provider);
    return {
      provider,
      type,
      ready: provider === 'google' ? Boolean(googleCredentials) : Boolean(clientId),
      source: provider === 'google' ? googleCredentials?.source || googleClientId?.source || 'missing' : clientId ? (this.clientDefaults.zoomPublicClientId ? 'bundled' : 'existing-connection') : 'missing',
      authMode: 'public-pkce',
      requiresPublicClientId: provider === 'google' ? !googleClientId : !clientId,
      requiresClientSecret: provider === 'google' && !googleCredentials,
      hasInvalidOverride,
      loginUrl: provider === 'zoom' ? ZOOM_AUTH : GOOGLE_AUTH
    };
  }

  scopesFor(entry, requestedScopes = []) {
    const identity = ['openid', 'email', 'profile'];
    if (entry.provider === 'google') {
      if (entry.type === 'forms') return [...identity, 'https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly', 'https://www.googleapis.com/auth/drive.file'];
      if (entry.type === 'drive') return [...identity, GOOGLE_DRIVE_APPDATA_SCOPE];
      if (entry.type === 'gmail') {
        const allowedAdditionalScopes = new Set([...identity, GOOGLE_GMAIL_MODIFY_SCOPE, GOOGLE_DRIVE_APPDATA_SCOPE]);
        const preservedScopes = (Array.isArray(entry.scopes) ? entry.scopes : [])
          .map((scope) => String(scope || '').trim())
          .filter((scope) => allowedAdditionalScopes.has(scope));
        const additionalScopes = (Array.isArray(requestedScopes) ? requestedScopes : [])
          .map((scope) => String(scope || '').trim())
          .filter((scope) => allowedAdditionalScopes.has(scope));
        return [...new Set([...identity, GOOGLE_GMAIL_MODIFY_SCOPE, ...preservedScopes, ...additionalScopes])];
      }
      return identity;
    }
    return ['meeting:write:meeting', 'user:read:user'];
  }

  hasScopes(connectionId, requiredScopes = []) {
    connectionId = normalizedConnectionId(connectionId);
    const entry = this.entries[connectionId];
    if (!entry) return false;
    const granted = new Set(Array.isArray(entry.scopes) ? entry.scopes.map((scope) => String(scope || '').trim()).filter(Boolean) : []);
    return (Array.isArray(requiredScopes) ? requiredScopes : []).every((scope) => granted.has(String(scope || '').trim()));
  }

  async authorize(connectionId, options = {}) {
    connectionId = normalizedConnectionId(connectionId);
    if (this.pending.has(connectionId)) return this.pending.get(connectionId);
    const session = { controller: new AbortController(), launcherController: new AbortController(), callback: null };
    this.activeAuthorizations.set(connectionId, session);
    const job = this.runAuthorize(connectionId, options, session).finally(() => {
      if (this.activeAuthorizations.get(connectionId) === session) this.activeAuthorizations.delete(connectionId);
      this.pending.delete(connectionId);
    });
    this.pending.set(connectionId, job);
    return job;
  }

  authorizationCancelledError(message = '계정 연결이 취소되었습니다.') {
    const error = new Error(message);
    error.code = 'AUTHORIZATION_CANCELLED';
    return error;
  }

  assertAuthorizationActive(connectionId, session) {
    if (this.activeAuthorizations.get(connectionId) !== session || session.controller.signal.aborted) {
      const reason = session.controller.signal.reason;
      throw reason?.code === 'AUTHORIZATION_CANCELLED' ? reason : this.authorizationCancelledError();
    }
  }

  cancelAuthorization(connectionId, message = '계정 설정이 삭제되어 진행 중인 로그인을 취소했습니다.') {
    connectionId = normalizedConnectionId(connectionId);
    const session = this.activeAuthorizations.get(connectionId);
    if (!session) return false;
    const error = this.authorizationCancelledError(message);
    session.controller.abort(error);
    session.launcherController?.abort?.(error);
    session.callback?.cancel?.(error);
    return true;
  }

  async runAuthorize(connectionId, { loginHint = '', selectAccount = true, browserId = 'system', browserProfileId = '', additionalScopes = [] } = {}, session = null) {
    connectionId = normalizedConnectionId(connectionId);
    session ||= { controller: new AbortController(), launcherController: new AbortController(), callback: null };
    session.launcherController ||= new AbortController();
    loginHint = String(loginHint || '').trim();
    if (loginHint.length > 320 || /[\u0000-\u001f\u007f]/.test(loginHint)) throw new Error('로그인 계정 힌트가 올바르지 않습니다.');
    browserId = String(browserId || 'system').trim().toLowerCase();
    browserProfileId = String(browserProfileId || '').trim();
    if (browserProfileId.length > 128 || /[\u0000-\u001f\u007f]/.test(browserProfileId)) throw new Error('브라우저 사용자 선택값이 올바르지 않습니다.');
    if (this.entries[connectionId]?.provider === 'google') await this.reconcileGoogleConnectionCredentials();
    if (this.entries[connectionId]?.provider === 'zoom') await this.reconcileZoomConnectionCredentials();
    this.assertAuthorizationActive(connectionId, session);
    const storedEntry = this.entries[connectionId];
    if (!storedEntry?.clientId) {
      const error = new Error(storedEntry?.provider === 'zoom'
        ? '이 설치본에서 Zoom 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.'
        : '이 설치본에서 계정 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.');
      if (storedEntry?.provider === 'zoom') error.code = 'ZOOM_OAUTH_CONFIG_REQUIRED';
      throw error;
    }
    if (storedEntry.provider === 'google' && !storedEntry.clientSecret) {
      const error = new Error('이 설치본에서 Google 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.');
      error.code = 'GOOGLE_OAUTH_CONFIG_REQUIRED';
      throw error;
    }
    if (storedEntry.provider === 'zoom' && storedEntry.authMode !== 'public-pkce' && !storedEntry.clientSecret) throw new Error('이전 Zoom 연결을 계속 사용할 수 없습니다. 계정을 삭제한 뒤 다시 연결해주세요.');
    const entry = { ...storedEntry };
    const authorizedScopes = this.scopesFor(entry, additionalScopes);
    const state = base64Url(crypto.randomBytes(24));
    const publicPkce = entry.provider === 'google' || entry.authMode === 'public-pkce';
    const preferredRedirect = entry.provider === 'zoom' && !publicPkce ? entry.redirectUri : '';
    let callback;
    try { callback = await this.createCallbackServer(state, preferredRedirect, storedEntry.provider); }
    catch (error) { if (!error.oauthStage) error.oauthStage = 'callback_start'; throw error; }
    // Attach a rejection handler before launching the browser. Deletion can
    // cancel the callback while shell.openExternal/spawn is still pending;
    // keeping the outcome promise non-rejecting prevents a transient unhandled
    // rejection before this flow reaches the callback await.
    const callbackOutcome = callback.codePromise.then(
      (code) => ({ code, error: null }),
      (error) => ({ code: '', error })
    );
    const awaitCallbackCode = async () => {
      const outcome = await callbackOutcome;
      if (outcome.error) throw outcome.error;
      return outcome.code;
    };
    session.callback = callback;
    try {
      this.assertAuthorizationActive(connectionId, session);
      if (entry.provider === 'google') {
        const verifier = base64Url(crypto.randomBytes(48));
        const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
        const params = new URLSearchParams({ client_id: entry.clientId, redirect_uri: callback.redirectUri, response_type: 'code', scope: authorizedScopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: selectAccount ? 'consent select_account' : 'consent' });
        if (!selectAccount && loginHint) params.set('login_hint', loginHint);
        await this.openExternal(`${GOOGLE_AUTH}?${params}`, { provider: 'google', authMode: entry.authMode, browserId, ...(browserProfileId ? { browserProfileId } : {}), signal: session.launcherController.signal });
        this.assertAuthorizationActive(connectionId, session);
        const code = await awaitCallbackCode();
        this.assertAuthorizationActive(connectionId, session);
        const body = new URLSearchParams({ client_id: entry.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: callback.redirectUri });
        if (entry.clientSecret) body.set('client_secret', entry.clientSecret);
        let tokens;
        try { tokens = await this.tokenRequest(GOOGLE_TOKEN, body, null, { signal: session.controller.signal }); }
        catch (error) { if (!error.oauthStage && error.code !== 'AUTHORIZATION_CANCELLED') error.oauthStage = 'token_exchange'; throw error; }
        Object.assign(entry, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || entry.refreshToken || '', expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, scopes: authorizedScopes });
        let profile;
        try { profile = await this.fetchJson(GOOGLE_USERINFO, entry.accessToken, { requestTimeoutMs: this.networkTimeouts.token, signal: session.controller.signal }); }
        catch (error) { if (!error.oauthStage && error.code !== 'AUTHORIZATION_CANCELLED') error.oauthStage = 'profile_lookup'; throw error; }
        entry.account = profile.email || '';
      } else if (entry.provider === 'zoom') {
        const params = new URLSearchParams({ response_type: 'code', client_id: entry.clientId, redirect_uri: callback.redirectUri, state });
        let verifier = '';
        if (publicPkce) {
          verifier = base64Url(crypto.randomBytes(48));
          const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
          params.set('code_challenge', challenge);
          params.set('code_challenge_method', 'S256');
        }
        await this.openExternal(`${ZOOM_AUTH}?${params}`, { provider: 'zoom', authMode: entry.authMode, browserId, ...(browserProfileId ? { browserProfileId } : {}), signal: session.launcherController.signal });
        this.assertAuthorizationActive(connectionId, session);
        const code = await awaitCallbackCode();
        this.assertAuthorizationActive(connectionId, session);
        const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri });
        if (publicPkce) { body.set('client_id', entry.clientId); body.set('code_verifier', verifier); }
        let tokens;
        try { tokens = await this.tokenRequest(ZOOM_TOKEN, body, publicPkce ? null : entry, { signal: session.controller.signal }); }
        catch (error) { if (!error.oauthStage && error.code !== 'AUTHORIZATION_CANCELLED') error.oauthStage = 'token_exchange'; throw error; }
        Object.assign(entry, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || '', expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, scopes: authorizedScopes });
        let profile;
        try { profile = await this.fetchJson(ZOOM_USERINFO, entry.accessToken, { requestTimeoutMs: this.networkTimeouts.token, signal: session.controller.signal }); }
        catch (error) { if (!error.oauthStage && error.code !== 'AUTHORIZATION_CANCELLED') error.oauthStage = 'profile_lookup'; throw error; }
        entry.account = profile.email || profile.id || '';
      } else throw new Error('지원하지 않는 OAuth 공급자입니다.');
      this.assertAuthorizationActive(connectionId, session);
      entry.clientValidatedAt = new Date().toISOString();
      entry.updatedAt = entry.clientValidatedAt;
      try { await this.replaceEntryAndSave(connectionId, entry); }
      catch (error) { if (!error.oauthStage && error.code !== 'AUTHORIZATION_CANCELLED') error.oauthStage = 'credential_persist'; throw error; }
      this.assertAuthorizationActive(connectionId, session);
      return this.publicStatus(connectionId);
    } catch (error) {
      if (!error.oauthStage && error.code !== 'AUTHORIZATION_CANCELLED') error.oauthStage = 'callback_start';
      throw error;
    } finally {
      session.launcherController?.abort?.();
      if (session.callback === callback) session.callback = null;
      callback.close();
    }
  }

  createCallbackServer(expectedState, preferredRedirect = '', provider = '') {
    let server;
    let timeout;
    let target;
    if (preferredRedirect) {
      target = new URL(preferredRedirect);
      if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol !== 'http:' || !Number(target.port)) throw new Error('기존 Zoom OAuth Redirect URL은 http://127.0.0.1:포트/경로 형식이어야 합니다.');
    }
    let rejectCodePromise = null;
    let settled = false;
    const codePromise = new Promise((resolve, reject) => {
      rejectCodePromise = (error) => { if (!settled) { settled = true; reject(error); } };
      server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const expectedPath = target?.pathname || '/oauth/callback';
        if (url.pathname !== expectedPath) { response.writeHead(404).end(); return; }
        const error = url.searchParams.get('error');
        const receivedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const success = !error && receivedState === expectedState && Boolean(code);
        response.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        const providerName = provider === 'zoom' ? 'Zoom' : provider === 'google' ? 'Google' : '계정';
        response.end(success
          ? `<!doctype html><meta charset="utf-8"><h2>${providerName} 인증 응답을 받았습니다.</h2><p>최종 연결 결과는 CMOE Workspace에서 확인해주세요. 이 창은 닫아도 됩니다.</p>`
          : `<!doctype html><meta charset="utf-8"><h2>${providerName} 인증 응답을 확인하지 못했습니다.</h2><p>CMOE Workspace로 돌아가 다시 시도해주세요.</p>`);
        clearTimeout(timeout);
        if (error) {
          const denied = new Error(`로그인이 취소되었거나 거부되었습니다: ${error}`);
          denied.code = 'OAUTH_AUTHORIZATION_DENIED';
          denied.oauthStage = 'authorization_callback';
          denied.oauthProviderCode = String(error).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
          rejectCodePromise(denied);
        } else if (receivedState !== expectedState) {
          const invalidState = new Error('OAuth 상태 검증에 실패했습니다.');
          invalidState.code = 'OAUTH_STATE_MISMATCH';
          invalidState.oauthStage = 'authorization_callback';
          rejectCodePromise(invalidState);
        } else if (!code) {
          const missingCode = new Error('OAuth 인증 코드를 받지 못했습니다.');
          missingCode.code = 'OAUTH_CODE_MISSING';
          missingCode.oauthStage = 'authorization_callback';
          rejectCodePromise(missingCode);
        } else if (!settled) { settled = true; resolve(code); }
      });
      server.on('error', (error) => rejectCodePromise(error));
      timeout = setTimeout(() => {
        const error = new Error('계정 연결 시간이 초과되었습니다.');
        error.code = 'AUTHORIZATION_TIMEOUT';
        error.oauthStage = 'authorization_callback';
        rejectCodePromise(error);
      }, 5 * 60 * 1000);
    });
    return new Promise((resolve, reject) => {
      server.listen(target ? Number(target.port) : 0, target?.hostname || '127.0.0.1', () => {
        const address = server.address();
        const close = () => { clearTimeout(timeout); if (server.listening) server.close(); };
        resolve({
          redirectUri: target ? target.href : `http://127.0.0.1:${address.port}/oauth/callback`,
          codePromise,
          close,
          cancel: (reason) => { rejectCodePromise(reason || this.authorizationCancelledError()); close(); }
        });
      });
      server.once('error', reject);
    });
  }

  async tokenRequest(url, body, zoomEntry = null, options = {}) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (zoomEntry) headers.Authorization = `Basic ${Buffer.from(`${zoomEntry.clientId}:${zoomEntry.clientSecret}`).toString('base64')}`;
    const { response, body: data } = await fetchAndReadWithTimeout(url, { method: 'POST', headers, body, signal: options?.signal }, {
      timeoutMs: this.networkTimeouts.token,
      read: (targetResponse) => targetResponse.json()
    });
    if (!response.ok) {
      const providerCode = String(data?.error || '').trim();
      const providerMessage = String(data?.error_description || data?.reason || data?.message || providerCode).trim();
      const clientSecretProblem = /client[_\s-]*secret[\s\S]{0,80}\b(?:missing|invalid)\b/i.test(providerMessage)
        || /\b(?:missing|invalid)\b[\s\S]{0,80}client[_\s-]*secret/i.test(providerMessage);
      const googleConfigMissing = String(url).includes('googleapis.com/token')
        && (/^(?:invalid_client|unauthorized_client)$/i.test(providerCode) || clientSecretProblem);
      const error = new Error(googleConfigMissing
        ? '이 설치본의 Google 로그인을 확인할 수 없습니다. 최신 설치본을 다시 설치해주세요.'
        : providerMessage || 'OAuth 토큰 요청에 실패했습니다.');
      error.code = googleConfigMissing ? 'GOOGLE_OAUTH_CONFIG_REQUIRED' : 'OAUTH_TOKEN_REQUEST_FAILED';
      error.oauthStage = 'token_exchange';
      error.oauthProviderCode = providerCode.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async refresh(connectionId) {
    connectionId = normalizedConnectionId(connectionId);
    const storedEntry = this.entries[connectionId];
    if (!storedEntry?.refreshToken) throw new Error('계정을 다시 연결해주세요.');
    const entry = { ...storedEntry };
    let tokens;
    if (entry.provider === 'google') {
      const body = new URLSearchParams({ client_id: entry.clientId, refresh_token: entry.refreshToken, grant_type: 'refresh_token' });
      if (entry.clientSecret) body.set('client_secret', entry.clientSecret);
      tokens = await this.tokenRequest(GOOGLE_TOKEN, body);
    } else if (entry.authMode === 'public-pkce') {
      tokens = await this.tokenRequest(ZOOM_TOKEN, new URLSearchParams({ client_id: entry.clientId, refresh_token: entry.refreshToken, grant_type: 'refresh_token' }));
    } else tokens = await this.tokenRequest(ZOOM_TOKEN, new URLSearchParams({ refresh_token: entry.refreshToken, grant_type: 'refresh_token' }), entry);
    if (this.entries[connectionId] !== storedEntry) {
      const error = new Error('계정 연결 상태가 변경되어 토큰 갱신 결과를 저장하지 않았습니다.');
      error.code = 'CONNECTION_STATE_CHANGED';
      throw error;
    }
    entry.accessToken = tokens.access_token; entry.refreshToken = tokens.refresh_token || entry.refreshToken; entry.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000; await this.replaceEntryAndSave(connectionId, entry); return entry.accessToken;
  }

  async getToken(connectionId, requiredScopes = []) {
    connectionId = normalizedConnectionId(connectionId);
    const entry = this.entries[connectionId];
    if (!entry) throw new Error('연결 정보를 찾을 수 없습니다.');
    if ((Array.isArray(requiredScopes) ? requiredScopes : []).length && !this.hasScopes(connectionId, requiredScopes)) {
      const error = new Error('이 기능에 필요한 Google 권한을 추가하려면 계정을 한 번 다시 연결해주세요.');
      error.code = 'AUTH_SCOPE_REQUIRED';
      throw error;
    }
    if (entry.accessToken && Number(entry.expiresAt) > Date.now() + 60_000) return entry.accessToken;
    return this.refresh(connectionId);
  }

  async invalidateAccessToken(connectionId) {
    connectionId = normalizedConnectionId(connectionId);
    const storedEntry = this.entries[connectionId];
    if (!storedEntry) return false;
    const next = { ...storedEntry };
    delete next.accessToken;
    delete next.expiresAt;
    await this.replaceEntryAndSave(connectionId, next);
    return true;
  }

  async fetchJsonWithMetadata(url, token, options = {}) {
    const { requestTimeoutMs, ...requestOptions } = options || {};
    const timeoutMs = Number(requestTimeoutMs) > 0
      ? Number(requestTimeoutMs)
      : /\/upload\/drive\/|\/drive\/v\d\//i.test(String(url)) ? this.networkTimeouts.drive : this.networkTimeouts.api;
    const { response, body: text } = await fetchAndReadWithTimeout(url, { ...requestOptions, headers: { ...(requestOptions.headers || {}), Authorization: `Bearer ${token}` } }, {
      timeoutMs,
      read: (targetResponse) => targetResponse.text()
    });
    let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data.message || data.reason || `API 요청 실패 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return { data, etag: response.headers?.get?.('etag') || String(data?.etag || '') };
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
    connectionId = normalizedConnectionId(connectionId);
    if (this.entries[connectionId]) {
      const next = { ...this.entries[connectionId] };
      delete next.accessToken;
      delete next.refreshToken;
      delete next.expiresAt;
      delete next.account;
      await this.replaceEntryAndSave(connectionId, next);
    }
    return this.publicStatus(connectionId);
  }

  async remove(connectionId) {
    connectionId = normalizedConnectionId(connectionId);
    this.cancelAuthorization(connectionId);
    if (this.entries[connectionId]) await this.replaceEntryAndSave(connectionId, null);
  }
}

module.exports = { AuthManager, normalizedConnectionId };
