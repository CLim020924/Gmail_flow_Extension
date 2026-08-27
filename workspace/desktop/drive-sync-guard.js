const STORAGE_KEY = 'driveSyncGuardsV1';

function normalizeAccount(value) {
  return String(value || '').trim().toLowerCase();
}

function connectionGuardKey(connection = {}) {
  const id = String(connection.id || '').trim();
  const type = String(connection.type || '').trim();
  const account = normalizeAccount(connection.account);
  if (!id || type !== 'drive' || !account) return '';
  return JSON.stringify([id, type, account]);
}

function isUsableDriveEtag(value) {
  const etag = String(value || '').trim();
  return Boolean(etag && !/^W\//i.test(etag));
}

function normalizeSnapshot(snapshot = {}) {
  return {
    fileId: String(snapshot.fileId || snapshot.id || ''),
    etag: String(snapshot.etag || ''),
    modifiedTime: String(snapshot.modifiedTime || ''),
    version: String(snapshot.version || '')
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function drivePayloadsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeGuard(value) {
  if (!value || typeof value !== 'object') return null;
  const state = ['ready', 'empty', 'conflict'].includes(value.state) ? value.state : '';
  if (!state) return null;
  const snapshot = normalizeSnapshot(value);
  if (state === 'ready' && (!snapshot.fileId || !isUsableDriveEtag(snapshot.etag))) return null;
  return {
    state,
    ...snapshot,
    reason: String(value.reason || ''),
    observedAt: String(value.observedAt || '')
  };
}

class DriveSyncGuardStore {
  constructor(storage, { now = () => new Date().toISOString() } = {}) {
    this.storage = storage;
    this.now = now;
    this.memory = {};
  }

  async readAll() {
    const stored = await this.storage.get(STORAGE_KEY, {});
    const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const normalized = {};
    for (const [key, value] of Object.entries({ ...source, ...this.memory })) {
      const guard = normalizeGuard(value);
      if (guard) normalized[key] = guard;
    }
    return normalized;
  }

  async get(connection) {
    const key = connectionGuardKey(connection);
    if (!key) return null;
    const guards = await this.readAll();
    return guards[key] || null;
  }

  async write(connection, value) {
    const key = connectionGuardKey(connection);
    if (!key) throw new Error('Drive 동기화 기준을 저장할 연결 계정 정보가 올바르지 않습니다.');
    const guard = normalizeGuard({ ...value, observedAt: value?.observedAt || this.now() });
    if (!guard) throw new Error('Drive 동기화 기준 정보가 올바르지 않습니다.');
    this.memory[key] = guard;
    const guards = await this.readAll();
    guards[key] = guard;
    await this.storage.set(STORAGE_KEY, guards);
    return guard;
  }

  observeRemote(connection, snapshot) {
    return this.write(connection, { state: 'ready', ...normalizeSnapshot(snapshot), reason: '' });
  }

  observeEmpty(connection) {
    return this.write(connection, { state: 'empty', fileId: '', etag: '', modifiedTime: '', version: '', reason: '' });
  }

  markConflict(connection, reason, snapshot = {}) {
    return this.write(connection, { state: 'conflict', ...normalizeSnapshot(snapshot), reason: String(reason || '') });
  }
}

module.exports = {
  STORAGE_KEY,
  DriveSyncGuardStore,
  connectionGuardKey,
  canonicalJson,
  drivePayloadsEqual,
  isUsableDriveEtag,
  normalizeGuard,
  normalizeSnapshot
};
