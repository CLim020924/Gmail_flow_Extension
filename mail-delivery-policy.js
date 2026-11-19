(function initMailDeliveryPolicy(globalScope) {
  const policy = Object.freeze({
    sendIntervalMs: 5_000,
    maxAttempts: 8,
    maxRetryDelayMs: 24 * 60 * 60 * 1000
  });

  function parseRetryAfter(value, now = Date.now()) {
    const text = String(value || '').trim();
    if (!text) return 0;
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1000));
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
  }

  function errorText(error) {
    return [error?.message, error?.reason, ...(error?.reasons || [])].filter(Boolean).join(' ').toLowerCase();
  }

  function classify(error) {
    const status = Number(error?.status || 0);
    const text = errorText(error);
    const auth = ['AUTH_REQUIRED', 'OAUTH_NOT_CONFIGURED', 'ACCOUNT_MISMATCH'].includes(error?.code) || status === 401;
    const rateLimited = status === 429 || status === 403 && /rate.?limit|quota|limit exceeded|daily limit|mail sending/.test(text);
    const server = [500, 502, 503, 504].includes(status) || /backend.?error|service unavailable|temporar/.test(text);
    const network = ['NETWORK_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code) || error?.name === 'TypeError' && /fetch|network/.test(text);
    return { auth, rateLimited, server, network, retryable: !auth && (rateLimited || server || network) };
  }

  function retryDelayMs(error, attempt, random = Math.random) {
    const serverDelay = Math.max(0, Number(error?.retryAfterMs || 0));
    if (serverDelay) return Math.min(policy.maxRetryDelayMs, Math.max(1_000, serverDelay));
    const kind = classify(error);
    const base = kind.rateLimited ? 60_000 : kind.server ? 5_000 : 10_000;
    const exponent = Math.max(0, Math.min(10, Number(attempt || 1) - 1));
    const delay = Math.min(policy.maxRetryDelayMs, base * (2 ** exponent));
    return Math.min(policy.maxRetryDelayMs, delay + Math.floor(Math.max(0, Number(random()) || 0) * Math.min(base, 30_000)));
  }

  const api = { classify, parseRetryAfter, policy, retryDelayMs };
  globalScope.GmailFlowMailDeliveryPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
