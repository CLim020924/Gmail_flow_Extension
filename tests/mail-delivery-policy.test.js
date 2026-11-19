const assert = require('node:assert/strict');
const Delivery = require('../mail-delivery-policy');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(Delivery.policy.sendIntervalMs, 5_000);
assert.equal(Delivery.normalizeSendIntervalMs(10_000), 10_000);
assert.equal(Delivery.normalizeSendIntervalMs(0), 2_000);
assert.equal(Delivery.normalizeSendIntervalMs(90_000), 60_000);
assert.equal(Delivery.normalizeSendIntervalMs(undefined), 5_000);
assert.equal(Delivery.policy.maxAttempts, 8);
assert.equal(Delivery.parseRetryAfter('120', 0), 120_000);
assert.equal(Delivery.parseRetryAfter('Thu, 01 Jan 2026 00:02:00 GMT', Date.parse('2026-01-01T00:00:00Z')), 120_000);
assert.deepEqual(Delivery.classify({ status: 429, message: 'User-rate limit exceeded (Mail sending)' }), { auth: false, rateLimited: true, server: false, network: false, retryable: true });
assert.equal(Delivery.classify({ status: 403, reasons: ['userRateLimitExceeded'] }).retryable, true);
assert.equal(Delivery.classify({ status: 503, message: 'Backend error' }).retryable, true);
assert.equal(Delivery.classify({ status: 400, message: 'Invalid recipient' }).retryable, false);
assert.equal(Delivery.classify({ status: 401, code: 'AUTH_REQUIRED' }).auth, true);
assert.equal(Delivery.retryDelayMs({ status: 429 }, 1, () => 0), 60_000);
assert.equal(Delivery.retryDelayMs({ status: 429, retryAfterMs: 900_000 }, 1, () => 0), 900_000);
assert.equal(Delivery.retryDelayMs({ status: 503 }, 3, () => 0), 20_000);

const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const popupScript = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
assert.match(popupHtml, /id="retryFailedBatch"/);
assert.match(popupHtml, /id="sendReviewIntervalSeconds"[^>]*min="2"[^>]*max="60"[^>]*value="5"/);
assert.match(popupScript, /sendIntervalMs: \(sendReviewResult\?\.sendIntervalSeconds \|\| 5\) \* 1000/);
assert.match(popupScript, /filter\(\(item\) => item\.status === 'failed'\)/);
assert.match(popupScript, /이미 성공한 대상은 포함하지 않습니다/);

console.log('mail delivery pacing and backoff tests passed');
