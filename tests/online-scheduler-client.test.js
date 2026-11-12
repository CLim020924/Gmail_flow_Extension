const assert = require('node:assert/strict');
const scheduler = require('../online-scheduler-client.js');

(async () => {
  const config = {
    mode: 'online',
    url: 'https://script.google.com/macros/s/example/exec',
    secret: '12345678901234567890123456789012'
  };

  assert.deepEqual(scheduler.normalizeConfig({ mode: 'anything', url: ' x ', secret: ' y ' }), { mode: 'local', url: 'x', secret: 'y' });
  assert.throws(() => scheduler.validateConfig({ ...config, url: 'http://example.com' }), /Apps Script/);
  assert.throws(() => scheduler.validateConfig({ ...config, secret: 'short' }), /연결 키/);

  let requestBody;
  const success = await scheduler.request(config, 'health', {}, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { triggerReady: true } }) };
  });
  assert.equal(requestBody.action, 'health');
  assert.equal(requestBody.secret, config.secret);
  assert.equal(success.triggerReady, true);

  await assert.rejects(
    scheduler.request(config, 'health', {}, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, code: 'UNAUTHORIZED', error: 'bad key' }) })),
    (error) => error.code === 'UNAUTHORIZED' && /bad key/.test(error.message)
  );
  await assert.rejects(
    scheduler.request(config, 'health', {}, async () => { throw new Error('offline'); }),
    (error) => error.code === 'ONLINE_SCHEDULER_NETWORK'
  );

  const oversized = { data: 'a'.repeat(scheduler.MAX_REQUEST_BYTES) };
  await assert.rejects(scheduler.request(config, 'enqueue', oversized, async () => { throw new Error('must not run'); }), /20MB/);
  console.log('online-scheduler-client tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
