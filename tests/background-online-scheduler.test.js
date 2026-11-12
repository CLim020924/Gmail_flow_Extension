const assert = require('node:assert/strict');

const data = {};
let runtimeListener;
let alarmCreates = 0;
const scriptRequests = [];
const senderEmail = 'scheduler@example.com';

global.chrome = {
  storage: { local: {
    get: async (key) => ({ [key]: data[key] }),
    set: async (values) => Object.assign(data, values)
  } },
  identity: {
    getAuthToken: async () => ({ token: 'gmail-token' }),
    removeCachedAuthToken: async () => {},
    getProfileUserInfo: async () => ({ email: senderEmail })
  },
  runtime: {
    getManifest: () => ({ oauth2: { client_id: 'configured-client' } }),
    onMessage: { addListener: (listener) => { runtimeListener = listener; } },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} }
  },
  alarms: {
    clear: async () => true,
    create: async () => { alarmCreates += 1; },
    onAlarm: { addListener: () => {} }
  }
};

let remoteStatus = 'scheduled';
global.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/gmail/v1/users/me/profile')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ emailAddress: senderEmail }) };
  }
  assert.match(String(url), /^https:\/\/script\.google\.com\//);
  const request = JSON.parse(options.body);
  scriptRequests.push(request);
  if (request.action === 'health') return response({ senderEmail, triggerReady: true });
  if (request.action === 'enqueue') return response(remoteJob(request.job));
  if (request.action === 'status') return response({ jobs: [remoteJob({ id: request.jobIds[0], name: '온라인 테스트', senderEmail, scheduledAt: '2030-01-01T00:00:00.000Z', items: [{ id: 'item-1', email: 'to@example.com', subject: '제목', body: '본문', variables: {} }] })], checkedAt: new Date().toISOString() });
  if (request.action === 'cancel') { remoteStatus = 'canceled'; return response(remoteJob({ id: request.jobId, name: '온라인 테스트', senderEmail, scheduledAt: '2030-01-01T00:00:00.000Z', items: [{ id: 'item-1', email: 'to@example.com', subject: '제목', body: '본문', variables: {} }] })); }
  throw new Error(`unexpected action ${request.action}`);
};

function response(dataValue) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: dataValue }) };
}

function remoteJob(job) {
  const status = remoteStatus;
  const items = (job.items || []).map((item) => ({ ...item, status, attempts: 0, error: '', draftId: 'draft-1', scheduledAt: job.scheduledAt }));
  return {
    id: job.id, onlineJobId: job.id, schedulerMode: 'online', name: job.name,
    method: '예약 발송', senderEmail: job.senderEmail, scheduledAt: job.scheduledAt,
    status, total: items.length, completed: status === 'completed' ? items.length : 0, failed: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items
  };
}

require('../background.js');

function send(message) {
  return new Promise((resolve) => runtimeListener(message, {}, resolve));
}

(async () => {
  const config = { mode: 'online', url: 'https://script.google.com/macros/s/test/exec', secret: '12345678901234567890123456789012' };
  assert.equal((await send({ type: 'online-scheduler-config-save', config })).ok, true);
  const health = await send({ type: 'online-scheduler-test' });
  assert.equal(health.ok, true);
  assert.equal(health.data.triggerReady, true);

  const enqueued = await send({
    type: 'enqueue-mail-batch',
    payload: {
      name: '온라인 테스트', method: '예약 발송', senderEmail, scheduledAt: '2030-01-01T00:00:00.000Z',
      attachments: [], subjectTemplate: '제목', bodyTemplate: '본문', postscriptTemplate: '',
      items: [{ id: 'item-1', email: 'to@example.com', subject: '제목', body: '본문', variables: {} }]
    }
  });
  assert.equal(enqueued.ok, true);
  assert.equal(enqueued.data.schedulerMode, 'online');
  assert.equal(data.mailBatches[0].status, 'scheduled');
  assert.equal(alarmCreates, 0, 'online jobs must not be armed in the local alarm queue');
  assert.deepEqual(scriptRequests.map((request) => request.action), ['health', 'enqueue']);

  const synced = await send({ type: 'sync-online-mail-batches' });
  assert.equal(synced.ok, true);
  assert.equal(synced.data.synced, 1);

  const canceled = await send({ type: 'cancel-mail-batch', batchId: data.mailBatches[0].id });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.data.status, 'canceled');
  assert.equal(data.mailBatches[0].status, 'canceled');
  console.log('background online scheduler test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
