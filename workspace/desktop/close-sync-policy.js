function normalizeCloseFlushResult(result) {
  if (result === true) return { ok: true, localSaved: true, remotePending: false, remoteError: '' };
  if (!result || result.ok !== true || result.localSaved !== true) {
    throw new Error('이 창이 변경사항 저장 완료를 확인하지 못했습니다.');
  }
  return {
    ok: true,
    localSaved: true,
    remotePending: Boolean(result.remotePending),
    remoteError: String(result.remoteError || '').trim()
  };
}

function collectRemoteSyncWarnings(flushResults = [], mainDriveError = null) {
  const messages = [];
  for (const result of Array.isArray(flushResults) ? flushResults : []) {
    const normalized = normalizeCloseFlushResult(result);
    if (normalized.remotePending) messages.push(normalized.remoteError || 'Google Drive 동기화가 아직 완료되지 않았습니다.');
  }
  if (mainDriveError) messages.push(String(mainDriveError.message || mainDriveError).trim() || 'Google Drive 동기화가 아직 완료되지 않았습니다.');
  return [...new Set(messages.filter(Boolean))];
}

module.exports = { collectRemoteSyncWarnings, normalizeCloseFlushResult };
