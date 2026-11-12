const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const ALLOWED_SCOPES = new Set([GMAIL_MODIFY_SCOPE, DRIVE_APPDATA_SCOPE]);

function codedError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizedScopes(scopes) {
  const requested = Array.isArray(scopes) && scopes.length ? scopes : [GMAIL_MODIFY_SCOPE];
  const normalized = [...new Set(requested.map((scope) => String(scope || '').trim()).filter(Boolean))];
  if (normalized.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw codedError('Gmail Flow에서 허용하지 않은 Google 권한을 요청했습니다.', 'AUTH_SCOPE_UNSUPPORTED');
  }
  if (!normalized.includes(GMAIL_MODIFY_SCOPE)) normalized.unshift(GMAIL_MODIFY_SCOPE);
  return normalized;
}

class WorkspaceGmailIdentity {
  constructor({
    clientId = '',
    resolveConnection,
    ensureConnection,
    connectionStatus,
    hasScopes,
    authorizeConnection,
    getConnectionToken,
    disconnectConnection,
    invalidateConnectionToken
  } = {}) {
    for (const [name, dependency] of Object.entries({
      resolveConnection,
      ensureConnection,
      connectionStatus,
      hasScopes,
      authorizeConnection,
      getConnectionToken,
      disconnectConnection,
      invalidateConnectionToken
    })) {
      if (typeof dependency !== 'function') throw new TypeError(`Workspace Gmail 계정 공급자에 ${name} 함수가 필요합니다.`);
    }
    this.clientId = String(clientId || '').trim();
    this.resolveConnection = resolveConnection;
    this.ensureConnection = ensureConnection;
    this.connectionStatus = connectionStatus;
    this.hasScopes = hasScopes;
    this.authorizeConnection = authorizeConnection;
    this.getConnectionToken = getConnectionToken;
    this.disconnectConnection = disconnectConnection;
    this.invalidateConnectionToken = invalidateConnectionToken;
  }

  async migrateProtectionIfNeeded() { return { migrated: false, source: 'workspace' }; }
  async ensureClientBinding() { return { ready: Boolean(this.clientId), source: 'workspace' }; }

  async currentConnection({ create = false } = {}) {
    let connection = await this.resolveConnection();
    if (!connection && create) connection = await this.ensureConnection();
    return connection || null;
  }

  async getToken(interactive = false, scopes = [GMAIL_MODIFY_SCOPE], loginOptions = {}) {
    const requiredScopes = normalizedScopes(scopes);
    const connection = await this.currentConnection({ create: Boolean(interactive) });
    if (!connection?.id) {
      throw codedError('Workspace에서 사용할 Gmail 계정을 먼저 연결해주세요.', 'AUTH_REQUIRED');
    }

    let status = await this.connectionStatus(connection.id);
    let granted = await this.hasScopes(connection.id, requiredScopes);
    const shouldAuthorize = Boolean(interactive) && (!status?.connected || !granted || Boolean(loginOptions?.selectAccount));
    if (shouldAuthorize) {
      const authorization = await this.authorizeConnection(connection.id, {
        loginHint: loginOptions?.selectAccount ? '' : String(loginOptions?.loginHint || status?.account || connection.account || '').trim(),
        selectAccount: Boolean(loginOptions?.selectAccount),
        browserId: loginOptions?.browserId || 'system',
        browserProfileId: loginOptions?.browserProfileId || '',
        additionalScopes: requiredScopes
      });
      if (authorization?.cancelled) throw codedError('Google 계정 연결이 취소되었습니다.', 'AUTHORIZATION_CANCELLED');
      status = await this.connectionStatus(connection.id);
      granted = await this.hasScopes(connection.id, requiredScopes);
    }

    if (!status?.connected) {
      throw codedError('Workspace의 Gmail 계정을 다시 연결해주세요.', 'AUTH_REQUIRED', { rememberedEmail: status?.account || connection.account || '' });
    }
    if (!granted) {
      throw codedError('Gmail Flow에 필요한 권한을 추가하려면 이 계정을 한 번 다시 연결해주세요.', 'AUTH_SCOPE_REQUIRED', { rememberedEmail: status?.account || connection.account || '' });
    }
    return this.getConnectionToken(connection.id, requiredScopes);
  }

  async clear() {
    const connection = await this.currentConnection();
    if (!connection?.id) return { disconnected: false };
    await this.disconnectConnection(connection.id);
    return { disconnected: true, connectionId: connection.id };
  }

  async invalidateAccessToken() {
    const connection = await this.currentConnection();
    if (!connection?.id) return false;
    return this.invalidateConnectionToken(connection.id);
  }

  async getProfile() {
    const connection = await this.currentConnection();
    if (!connection?.id) return { email: '' };
    const status = await this.connectionStatus(connection.id);
    const hasGmailPermission = await this.hasScopes(connection.id, [GMAIL_MODIFY_SCOPE]);
    const rememberedEmail = String(status?.account || connection.account || '').trim();
    return {
      email: status?.connected ? rememberedEmail : '',
      rememberedEmail,
      needsAdditionalPermission: Boolean(status?.connected && !hasGmailPermission),
      source: 'workspace',
      connectionId: connection.id
    };
  }
}

module.exports = {
  WorkspaceGmailIdentity,
  GMAIL_MODIFY_SCOPE,
  DRIVE_APPDATA_SCOPE,
  normalizedScopes
};
