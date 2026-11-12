(function attachOnlineScheduler(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GmailFlowOnlineScheduler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

  function normalizeConfig(config = {}) {
    return {
      mode: config.mode === 'online' ? 'online' : 'local',
      url: String(config.url || '').trim(),
      secret: String(config.secret || '').trim()
    };
  }

  function validateConfig(config, { requireOnline = true } = {}) {
    const normalized = normalizeConfig(config);
    if (requireOnline && normalized.mode !== 'online') throw new Error('온라인 예약 발송이 선택되지 않았습니다.');
    let parsed;
    try { parsed = new URL(normalized.url); } catch (_) { throw new Error('Apps Script 웹 앱 주소가 올바르지 않습니다.'); }
    if (parsed.protocol !== 'https:' || !['script.google.com', 'script.googleusercontent.com'].includes(parsed.hostname)) {
      throw new Error('Google Apps Script에서 배포한 HTTPS 웹 앱 주소만 사용할 수 있습니다.');
    }
    if (normalized.secret.length < 24) throw new Error('온라인 예약 발송 연결 키를 확인해주세요.');
    return normalized;
  }

  async function request(config, action, payload = {}, fetchImpl = globalThis.fetch) {
    const normalized = validateConfig(config);
    if (typeof fetchImpl !== 'function') throw new Error('온라인 예약 발송에 필요한 네트워크 기능을 사용할 수 없습니다.');
    const body = JSON.stringify({ action, secret: normalized.secret, ...payload });
    if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
      throw new Error('온라인 예약 요청이 20MB를 초과했습니다. 첨부파일 크기나 대상 수를 줄여주세요.');
    }
    let response;
    try {
      response = await fetchImpl(normalized.url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body
      });
    } catch (cause) {
      const error = new Error(`온라인 예약 발송 서버에 연결하지 못했습니다. ${cause?.message || ''}`.trim());
      error.code = 'ONLINE_SCHEDULER_NETWORK';
      throw error;
    }
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; }
    catch (_) { throw new Error('Apps Script가 올바른 응답을 반환하지 않았습니다. 배포 주소와 실행 권한을 확인해주세요.'); }
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || `온라인 예약 발송 요청에 실패했습니다. (${response.status})`);
      error.code = result.code || 'ONLINE_SCHEDULER_ERROR';
      throw error;
    }
    return result.data;
  }

  return { MAX_REQUEST_BYTES, normalizeConfig, validateConfig, request };
});
