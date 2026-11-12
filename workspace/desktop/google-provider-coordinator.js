const { createTransactionQueue } = require('./transaction-queue');

const GOOGLE_CONNECTION_TYPES = new Set(['forms', 'drive', 'gmail']);

function createGoogleProviderOperationGate(runSerial = createTransactionQueue()) {
  return {
    run(provider, operation) {
      if (typeof operation !== 'function') return Promise.reject(new TypeError('Provider operation must be a function.'));
      return String(provider || '').toLowerCase() === 'google'
        ? runSerial(operation)
        : Promise.resolve().then(operation);
    }
  };
}

function reconcileWorkspaceProviderConnections(stateInput, statusForConnection, options = {}) {
  if (typeof statusForConnection !== 'function') throw new TypeError('A connection status reader is required.');
  const provider = String(options.provider || 'google').trim().toLowerCase();
  const connectionTypes = new Set(Array.isArray(options.connectionTypes) && options.connectionTypes.length
    ? options.connectionTypes.map((type) => String(type || '').trim()).filter(Boolean)
    : provider === 'zoom' ? ['zoom'] : [...GOOGLE_CONNECTION_TYPES]);
  const providerLabel = String(options.providerLabel || (provider === 'zoom' ? 'Zoom' : 'Google')).trim();
  let state = structuredClone(stateInput || {});
  const originalRevision = Number(state._revision || 0);
  const now = String(options.now || new Date().toISOString());
  const forceNeedsAuth = Boolean(options.forceNeedsAuth);
  const applyAuthorization = typeof options.applyAuthorization === 'function' ? options.applyAuthorization : null;
  const authorizationReason = String(options.authorizationReason || `${providerLabel} 로그인 계정 확인 후 기존 외부 항목 재확인 필요`).trim();
  const forcedReason = String(options.reason || `${providerLabel} 앱 연결 설정이 변경되어 다시 로그인이 필요합니다.`).trim();
  const missingTokenReason = String(options.missingTokenReason || `저장된 ${providerLabel} 로그인 토큰을 확인할 수 없어 다시 로그인이 필요합니다.`).trim();
  const changedConnectionIds = [];
  const invalidatedConnectionIds = [];
  const recoveredConnectionIds = [];
  let retiredArtifacts = 0;
  let reviewedForms = 0;

  const providerConnectionIds = (Array.isArray(state.connections) ? state.connections : [])
    .filter((connection) => connectionTypes.has(connection?.type))
    .map((connection) => connection.id);
  for (const connectionId of providerConnectionIds) {
    let connection = state.connections.find((item) => item.id === connectionId);
    if (!connectionTypes.has(connection?.type)) continue;
    const actual = statusForConnection(connection.id) || {};
    const actualMatchesConnection = actual.provider === provider && actual.type === connection.type;
    const actualConnected = actualMatchesConnection && Boolean(actual.connected);
    const displayedConnected = connection.status === 'connected';
    const actualAccount = String(actual.account || '').trim();
    const displayedAccount = String(connection.account || '').trim();
    const accountMismatch = actualConnected && actualAccount && actualAccount.toLowerCase() !== displayedAccount.toLowerCase();
    let changed = false;

    if (forceNeedsAuth) {
      changed = true;
      connection.status = 'needsAuth';
      connection.lastAuthError = forcedReason;
      invalidatedConnectionIds.push(connection.id);
    } else if (actualConnected && (!displayedConnected || accountMismatch)) {
      if (applyAuthorization) {
        const applied = applyAuthorization(state, connection.id, actual, authorizationReason);
        if (!applied?.state || !applied.connection) throw new Error(`${providerLabel} 연결 상태를 복구할 수 없습니다: ${connection.id}`);
        state = applied.state;
        connection = state.connections.find((item) => item.id === connectionId);
        retiredArtifacts += Number(applied.retiredArtifacts || 0);
        reviewedForms += Number(applied.reviewedForms || 0);
      } else {
        connection.status = 'connected';
        if (actualAccount) connection.account = actualAccount;
        if (Object.hasOwn(connection, 'lastAuthError')) delete connection.lastAuthError;
      }
      recoveredConnectionIds.push(connection.id);
      changed = true;
    } else if (!actualConnected && displayedConnected) {
      connection.status = 'needsAuth';
      connection.lastAuthError = missingTokenReason;
      invalidatedConnectionIds.push(connection.id);
      changed = true;
    }

    if (!changed) continue;
    connection.updatedAt = now;
    changedConnectionIds.push(connection.id);
  }

  if (changedConnectionIds.length) {
    state.updatedAt = now;
    state._revision = originalRevision + 1;
    state._baseRevision = state._revision;
  }
  return { state, changedConnectionIds, invalidatedConnectionIds, recoveredConnectionIds, retiredArtifacts, reviewedForms };
}

function reconcileWorkspaceGoogleConnections(stateInput, statusForConnection, options = {}) {
  return reconcileWorkspaceProviderConnections(stateInput, statusForConnection, {
    ...options,
    provider: 'google',
    providerLabel: 'Google',
    connectionTypes: [...GOOGLE_CONNECTION_TYPES]
  });
}

function reconcileWorkspaceZoomConnections(stateInput, statusForConnection, options = {}) {
  return reconcileWorkspaceProviderConnections(stateInput, statusForConnection, {
    ...options,
    provider: 'zoom',
    providerLabel: 'Zoom',
    connectionTypes: ['zoom']
  });
}

function sanitizeGoogleProviderStatus(status = {}) {
  return {
    provider: status.provider === 'google' ? 'google' : '',
    type: GOOGLE_CONNECTION_TYPES.has(status.type) ? status.type : '',
    ready: Boolean(status.ready),
    source: String(status.source || ''),
    authMode: String(status.authMode || ''),
    requiresPublicClientId: Boolean(status.requiresPublicClientId),
    requiresClientSecret: Boolean(status.requiresClientSecret),
    hasInvalidOverride: Boolean(status.hasInvalidOverride),
    loginUrl: String(status.loginUrl || '')
  };
}

module.exports = {
  GOOGLE_CONNECTION_TYPES,
  createGoogleProviderOperationGate,
  reconcileWorkspaceProviderConnections,
  reconcileWorkspaceGoogleConnections,
  reconcileWorkspaceZoomConnections,
  sanitizeGoogleProviderStatus
};
