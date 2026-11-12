const crypto = require('node:crypto');

const WORKSPACE_FILE_NAME = 'cmoe-workspace-state.json';
const BACKUP_FILE_PREFIX = 'cmoe-workspace-backup-';

function normalizeIdentity(value = {}) {
  return {
    fileId: String(value.fileId || value.id || ''),
    modifiedTime: String(value.modifiedTime || value.modifiedDate || ''),
    version: String(value.version || ''),
    etag: String(value.etag || ''),
    trashed: Boolean(value.trashed ?? value.labels?.trashed)
  };
}

function isStrongEtag(value) {
  const etag = String(value || '').trim();
  return Boolean(etag && !/^W\//i.test(etag));
}

function hasStableReadIdentity(value) {
  const identity = normalizeIdentity(value);
  return Boolean(identity.fileId && identity.modifiedTime && identity.version && !identity.trashed);
}

function identitiesMatch(expectedInput, actualInput, { requireEtag = false } = {}) {
  const expected = normalizeIdentity(expectedInput);
  const actual = normalizeIdentity(actualInput);
  if (!expected.fileId || actual.trashed || expected.fileId !== actual.fileId) return false;
  if (expected.modifiedTime && expected.modifiedTime !== actual.modifiedTime) return false;
  if (expected.version && expected.version !== actual.version) return false;
  if (requireEtag && (!isStrongEtag(expected.etag) || expected.etag !== actual.etag)) return false;
  if (!requireEtag && expected.etag && expected.etag !== actual.etag) return false;
  return true;
}

function authoritativeIdentityMatches(expectedInput, actualInput, { requireEtag = false } = {}) {
  const expected = normalizeIdentity(expectedInput);
  const actual = normalizeIdentity(actualInput);
  if (!expected.fileId || actual.trashed || expected.fileId !== actual.fileId) return false;
  if (expected.modifiedTime && expected.modifiedTime !== actual.modifiedTime) return false;
  if (requireEtag && (!isStrongEtag(expected.etag) || expected.etag !== actual.etag)) return false;
  if (!requireEtag && expected.etag && expected.etag !== actual.etag) return false;
  return true;
}

function versionIsNotOlder(actualValue, expectedValue) {
  const actual = String(actualValue || '');
  const expected = String(expectedValue || '');
  if (!actual || !expected) return false;
  if (/^\d+$/.test(actual) && /^\d+$/.test(expected)) return BigInt(actual) >= BigInt(expected);
  return actual === expected;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function driveError(code, message, snapshot = {}, cause = null) {
  const error = new Error(message);
  error.code = code;
  error.snapshot = snapshot;
  if (cause) {
    error.cause = cause;
    if (Number.isFinite(Number(cause.status))) error.status = Number(cause.status);
  }
  return error;
}

function annotateError(error, fallbackCode, snapshot = {}) {
  const target = error instanceof Error ? error : new Error(String(error || 'Drive API 요청이 실패했습니다.'));
  if (!target.code) target.code = fallbackCode;
  if (!target.snapshot) target.snapshot = snapshot;
  return target;
}

function assertWorkspacePayload(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.format !== 'cmoe-workspace') {
    throw driveError('REMOTE_DRIVE_PAYLOAD_INVALID', 'Workspace 형식을 확인할 수 없는 데이터는 Drive에 저장하지 않습니다.', { format: String(state?.format || '') });
  }
}

class DriveWorkspaceClient {
  constructor(authManager, { randomBytes = crypto.randomBytes } = {}) {
    if (!authManager || typeof authManager.request !== 'function' || typeof authManager.requestWithMetadata !== 'function') {
      throw new TypeError('DriveWorkspaceClient requires an authenticated request manager.');
    }
    if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function.');
    this.authManager = authManager;
    this.randomBytes = randomBytes;
  }

  async listWorkspaceFiles(connectionId) {
    const query = encodeURIComponent(`name='${WORKSPACE_FILE_NAME}' and trashed=false`);
    try {
      const files = [];
      const seenPageTokens = new Set();
      let pageToken = '';
      for (let page = 0; page < 100; page += 1) {
        const pageParameter = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const found = await this.authManager.request(connectionId, `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=nextPageToken%2Cfiles(id%2Cname%2CmodifiedTime%2Cversion)&pageSize=10&orderBy=modifiedTime%20desc${pageParameter}`);
        for (const file of Array.isArray(found?.files) ? found.files : []) {
          files.push({
            id: String(file?.id || ''),
            name: String(file?.name || ''),
            modifiedTime: String(file?.modifiedTime || ''),
            version: String(file?.version || '')
          });
          // Callers only need to distinguish zero, one, and duplicate files.
          if (files.length > 1) return files;
        }
        const nextPageToken = String(found?.nextPageToken || '');
        if (!nextPageToken) return files;
        if (seenPageTokens.has(nextPageToken)) {
          throw driveError('DRIVE_API_ERROR', 'Drive 파일 목록의 다음 페이지를 안전하게 확인하지 못했습니다.', { operation: 'list-workspace-files' });
        }
        seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw driveError('DRIVE_API_ERROR', 'Drive 파일 목록이 너무 많은 페이지로 나뉘어 안전하게 확인하지 못했습니다.', { operation: 'list-workspace-files' });
    } catch (error) {
      throw annotateError(error, 'DRIVE_API_ERROR', { operation: 'list-workspace-files' });
    }
  }

  async listBackupFiles(connectionId) {
    const query = encodeURIComponent(`name contains '${BACKUP_FILE_PREFIX}' and trashed=false`);
    try {
      const found = await this.authManager.request(connectionId, `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id%2Cname%2CcreatedTime%2CmodifiedTime%2Cversion)&pageSize=10&orderBy=createdTime%20desc`);
      return (Array.isArray(found?.files) ? found.files : []).map((file) => ({
        id: String(file?.id || ''), name: String(file?.name || ''), createdTime: String(file?.createdTime || ''),
        modifiedTime: String(file?.modifiedTime || ''), version: String(file?.version || '')
      })).filter((file) => file.id && file.name.startsWith(BACKUP_FILE_PREFIX));
    } catch (error) {
      throw annotateError(error, 'DRIVE_API_ERROR', { operation: 'list-backup-files' });
    }
  }

  async createBackupFile(connectionId, payload) {
    if (!payload || payload.format !== 'cmoe-workspace-cloud-backup') throw driveError('REMOTE_DRIVE_PAYLOAD_INVALID', 'Drive 백업 형식을 확인할 수 없습니다.');
    const compactTime = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const version = String(payload.appVersion || 'unknown').replace(/[^0-9A-Za-z.-]/g, '_').slice(0, 32);
    const name = `${BACKUP_FILE_PREFIX}${compactTime}-v${version}-${this.randomBytes(4).toString('hex')}.json`;
    const boundary = `cmoe_backup_${this.randomBytes(12).toString('hex')}`;
    const body = [
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
      JSON.stringify({ name, parents: ['appDataFolder'] }),
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
      JSON.stringify(payload), `--${boundary}--`, ''
    ].join('\r\n');
    let response;
    try {
      response = await this.authManager.requestWithMetadata(connectionId, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2Cname%2CcreatedTime%2CmodifiedTime%2Cversion', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
      });
    } catch (error) { throw annotateError(error, 'DRIVE_API_ERROR', { operation: 'create-backup-file' }); }
    const fileId = String(response?.data?.id || '');
    if (!fileId) throw driveError('REMOTE_DRIVE_VERSION_MISSING', 'Drive 백업 파일 ID를 확인하지 못했습니다.');
    const restored = await this.readBackupFile(connectionId, fileId);
    if (restored.payload.digest !== payload.digest) throw driveError('REMOTE_DRIVE_STATE_CHANGED', 'Drive 백업 저장 직후 내용이 일치하지 않습니다.', restored.identity);
    return { ...restored.identity, name };
  }

  async readBackupFile(connectionId, fileId) {
    const normalizedFileId = String(fileId || '');
    if (!normalizedFileId) throw driveError('REMOTE_DRIVE_VERSION_MISSING', 'Drive 백업 파일 ID를 확인할 수 없습니다.');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.fetchWorkspaceMetadata(connectionId, normalizedFileId);
      if (!hasStableReadIdentity(before)) throw driveError('REMOTE_DRIVE_VERSION_MISSING', 'Drive 백업의 안정된 변경 버전을 확인할 수 없습니다.', before);
      let content;
      try { content = await this.authManager.requestWithMetadata(connectionId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(normalizedFileId)}?alt=media`); }
      catch (error) { throw annotateError(error, 'DRIVE_API_ERROR', { operation: 'read-backup-file', fileId: normalizedFileId }); }
      const after = await this.fetchWorkspaceMetadata(connectionId, normalizedFileId);
      if (!hasStableReadIdentity(after) || !identitiesMatch(before, after)) continue;
      if (!content?.data || content.data.format !== 'cmoe-workspace-cloud-backup') throw driveError('REMOTE_DRIVE_PAYLOAD_INVALID', 'Drive 백업 파일 형식을 확인할 수 없습니다.', after);
      return { payload: content.data, identity: after };
    }
    throw driveError('REMOTE_DRIVE_STATE_CHANGED', 'Drive 백업을 읽는 동안 파일이 변경되었습니다.', { fileId: normalizedFileId });
  }

  async readLatestBackup(connectionId) {
    const files = await this.listBackupFiles(connectionId);
    if (!files.length) return null;
    const result = await this.readBackupFile(connectionId, files[0].id);
    return { ...result, file: files[0] };
  }

  async fetchWorkspaceMetadata(connectionId, fileId) {
    const normalizedFileId = String(fileId || '');
    if (!normalizedFileId) throw driveError('REMOTE_DRIVE_VERSION_MISSING', 'Drive 파일 ID를 확인할 수 없습니다.', { fileId: '' });
    try {
      const result = await this.authManager.requestWithMetadata(connectionId, `https://www.googleapis.com/drive/v2/files/${encodeURIComponent(normalizedFileId)}?fields=id%2CmodifiedDate%2Cversion%2Clabels%2Ftrashed%2Cetag`);
      const data = result?.data || {};
      return normalizeIdentity({
        fileId: data.id,
        modifiedTime: data.modifiedDate,
        version: data.version,
        trashed: data.labels?.trashed,
        etag: data.etag || result?.etag || ''
      });
    } catch (error) {
      throw annotateError(error, 'DRIVE_API_ERROR', { operation: 'fetch-workspace-metadata', fileId: normalizedFileId });
    }
  }

  async readStableWorkspaceFile(connectionId, fileId, attempts = 2) {
    const normalizedFileId = String(fileId || '');
    const attemptCount = Math.max(1, Math.min(5, Math.trunc(Number(attempts) || 0)));
    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
      const before = await this.fetchWorkspaceMetadata(connectionId, normalizedFileId);
      if (!hasStableReadIdentity(before)) {
        throw driveError('REMOTE_DRIVE_VERSION_MISSING', 'Drive 데이터의 안정된 변경 버전을 확인할 수 없습니다.', before);
      }
      let content;
      try {
        content = await this.authManager.requestWithMetadata(connectionId, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(normalizedFileId)}?alt=media`);
      } catch (error) {
        throw annotateError(error, 'DRIVE_API_ERROR', { operation: 'read-workspace-content', fileId: normalizedFileId, version: before.version });
      }
      const after = await this.fetchWorkspaceMetadata(connectionId, normalizedFileId);
      if (!hasStableReadIdentity(after) || !identitiesMatch(before, after)) continue;
      if (!content?.data || typeof content.data !== 'object' || Array.isArray(content.data) || content.data.format !== 'cmoe-workspace') {
        throw driveError('REMOTE_DRIVE_PAYLOAD_INVALID', 'Drive의 Workspace 파일 형식을 확인할 수 없습니다.', after);
      }
      return { state: content.data, identity: after };
    }
    throw driveError('REMOTE_DRIVE_STATE_CHANGED', 'Drive 데이터를 읽는 동안 파일이 변경되었습니다. 최신 내용을 다시 확인해주세요.', { fileId: normalizedFileId, attempts: attemptCount });
  }

  async createWorkspaceFile(connectionId, state) {
    assertWorkspacePayload(state);
    const boundaryBytes = this.randomBytes(12);
    const boundary = `cmoe_workspace_${Buffer.from(boundaryBytes).toString('hex')}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name: WORKSPACE_FILE_NAME, parents: ['appDataFolder'] }),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(state),
      `--${boundary}--`,
      ''
    ].join('\r\n');
    let response;
    try {
      response = await this.authManager.requestWithMetadata(connectionId, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2CmodifiedTime%2Cversion', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      });
    } catch (error) {
      throw annotateError(error, 'DRIVE_API_ERROR', { operation: 'create-workspace-file' });
    }
    const createdFileId = String(response?.data?.id || '');
    const createdVersion = String(response?.data?.version || '');
    if (!createdFileId || !createdVersion) {
      throw driveError('REMOTE_DRIVE_VERSION_MISSING', 'Drive 파일은 생성됐지만 생성 ID와 버전을 확인하지 못했습니다.', { fileId: createdFileId, version: createdVersion });
    }

    const initialMetadata = await this.fetchWorkspaceMetadata(connectionId, createdFileId);
    if (!hasStableReadIdentity(initialMetadata) || initialMetadata.fileId !== createdFileId) {
      throw driveError('REMOTE_DRIVE_STATE_CHANGED', '생성한 Drive 파일의 변경 버전이 확인 결과와 일치하지 않습니다.', initialMetadata);
    }
    const stable = await this.readStableWorkspaceFile(connectionId, createdFileId);
    if (!authoritativeIdentityMatches(initialMetadata, stable.identity) || !versionIsNotOlder(stable.identity.version, createdVersion) || !payloadsEqual(state, stable.state)) {
      throw driveError('REMOTE_DRIVE_STATE_CHANGED', '생성한 Drive 파일의 내용이 저장 요청과 정확히 일치하지 않습니다.', { ...stable.identity, payloadMismatch: !payloadsEqual(state, stable.state) });
    }
    const files = await this.listWorkspaceFiles(connectionId);
    if (files.length !== 1 || files[0].id !== createdFileId) {
      throw driveError('REMOTE_DRIVE_DUPLICATE_FILES', 'Workspace Drive 파일이 둘 이상이거나 생성한 파일 계보를 확인할 수 없습니다.', { fileId: createdFileId, fileCount: files.length });
    }
    return { fileId: stable.identity.fileId, modifiedTime: stable.identity.modifiedTime, version: stable.identity.version, etag: stable.identity.etag };
  }

  async updateWorkspaceFile(connectionId, expectedInput, state) {
    assertWorkspacePayload(state);
    const expected = normalizeIdentity(expectedInput);
    if (!expected.fileId || !isStrongEtag(expected.etag)) {
      throw driveError('REMOTE_DRIVE_VERSION_MISSING', '강한 Drive ETag가 없어 기존 파일을 안전하게 덮어쓸 수 없습니다.', expected);
    }
    const before = await this.fetchWorkspaceMetadata(connectionId, expected.fileId);
    if (!hasStableReadIdentity(before) || !authoritativeIdentityMatches(expected, before, { requireEtag: true })) {
      throw driveError('REMOTE_DRIVE_STATE_CHANGED', 'Drive 파일이 마지막으로 확인한 버전과 달라 저장하지 않았습니다.', before);
    }

    let uploaded;
    try {
      uploaded = await this.authManager.requestWithMetadata(connectionId, `https://www.googleapis.com/upload/drive/v2/files/${encodeURIComponent(expected.fileId)}?uploadType=media&fields=id%2CmodifiedDate%2Cversion%2Cetag`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'If-Match': expected.etag },
        body: JSON.stringify(state)
      });
    } catch (error) {
      const code = [404, 412].includes(Number(error?.status)) ? 'REMOTE_DRIVE_STATE_CHANGED' : 'DRIVE_API_ERROR';
      const annotated = annotateError(error, code, expected);
      if ([404, 412].includes(Number(error?.status))) annotated.code = 'REMOTE_DRIVE_STATE_CHANGED';
      throw annotated;
    }
    const uploadedFileId = String(uploaded?.data?.id || '');
    const uploadedVersion = String(uploaded?.data?.version || '');
    if (uploadedFileId !== expected.fileId || !uploadedVersion) {
      throw driveError('REMOTE_DRIVE_VERSION_MISSING', 'Drive 저장 응답에서 새 파일 버전을 확인할 수 없습니다.', { fileId: uploadedFileId, version: uploadedVersion });
    }

    const after = await this.fetchWorkspaceMetadata(connectionId, expected.fileId);
    if (!hasStableReadIdentity(after) || after.fileId !== expected.fileId || !versionIsNotOlder(after.version, uploadedVersion) || !isStrongEtag(after.etag)) {
      throw driveError('REMOTE_DRIVE_STATE_CHANGED', 'Drive 저장 직후 확인한 파일 버전이 저장 응답과 일치하지 않습니다.', after);
    }
    const stable = await this.readStableWorkspaceFile(connectionId, expected.fileId);
    if (!authoritativeIdentityMatches(after, stable.identity, { requireEtag: true }) || !versionIsNotOlder(stable.identity.version, uploadedVersion) || !payloadsEqual(state, stable.state)) {
      throw driveError('REMOTE_DRIVE_STATE_CHANGED', 'Drive 저장 직후 파일 내용이 요청한 Workspace와 일치하지 않습니다.', { ...stable.identity, payloadMismatch: !payloadsEqual(state, stable.state) });
    }
    const files = await this.listWorkspaceFiles(connectionId);
    if (files.length !== 1 || files[0].id !== expected.fileId) {
      throw driveError('REMOTE_DRIVE_DUPLICATE_FILES', 'Drive 저장 뒤 Workspace 파일 계보를 하나로 확인할 수 없습니다.', { fileId: expected.fileId, fileCount: files.length });
    }
    return { fileId: stable.identity.fileId, modifiedTime: stable.identity.modifiedTime, version: stable.identity.version, etag: stable.identity.etag };
  }
}

module.exports = {
  BACKUP_FILE_PREFIX,
  DriveWorkspaceClient,
  WORKSPACE_FILE_NAME,
  authoritativeIdentityMatches,
  canonicalJson,
  hasStableReadIdentity,
  identitiesMatch,
  isStrongEtag,
  normalizeIdentity,
  payloadsEqual
};
