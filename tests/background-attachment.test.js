const assert = require('node:assert/strict');

const data = {};
let runtimeListener;
let sentRaw = '';
const authRequests = [];

global.chrome = {
  storage: { local: {
    get: async (key) => ({ [key]: data[key] }),
    set: async (values) => Object.assign(data, values)
  } },
  identity: {
    getAuthToken: async (request) => {
      authRequests.push(request);
      return { token: 'test-token' };
    },
    removeCachedAuthToken: async () => {},
    getProfileUserInfo: async () => ({ email: 'sender@example.com' })
  },
  runtime: {
    getManifest: () => ({ oauth2: { client_id: 'configured-client' } }),
    onMessage: { addListener: (listener) => { runtimeListener = listener; } },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} }
  },
  alarms: {
    clear: async () => true,
    create: async () => {},
    onAlarm: { addListener: () => {} }
  }
};

global.fetch = async (_url, options) => {
  sentRaw = JSON.parse(options.body).message.raw;
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'draft-1', message: { id: 'message-1', threadId: 'thread-1' } }) };
};

require('../background.js');

function send(message) {
  return new Promise((resolve) => runtimeListener(message, {}, resolve));
}

(async () => {
  const response = await send({
    type: 'enqueue-mail-batch',
    payload: {
      name: 'attachment test', method: '임시 저장', senderEmail: 'sender@example.com', label: '', scheduledAt: '',
      attachments: [{ name: '테스트 문서.txt', type: 'text/plain', size: 5, data: Buffer.from('hello').toString('base64') }],
      subjectTemplate: '첨부 테스트', bodyTemplate: '본문', postscriptTemplate: '',
      items: [{ email: 'to@example.com', subject: '첨부 테스트', body: '본문', variables: { 이름: '홍길동' } }]
    }
  });
  assert.equal(response.ok, true);
  const mime = Buffer.from(sentRaw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /filename\*=UTF-8''%ED%85%8C%EC%8A%A4%ED%8A%B8%20%EB%AC%B8%EC%84%9C.txt/);
  assert.match(mime, /aGVsbG8=/);
  assert.equal(data.mailBatches[0].completed, 1);
  assert.equal(data.mailBatches[0].bodyTemplate, '본문');

  data.mailBatches[0].items.push({
    id: 'missing-item', status: 'completed', draftId: 'missing-draft', messageId: 'missing-message', threadId: '',
    email: 'missing@example.com', subject: '기존 제목', body: '기존 본문', variables: { 이름: '삭제됨' }
  });
  data.mailBatches[0].total = 2;
  data.mailBatches[0].completed = 2;
  let updatedRaw = '';
  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/drafts/missing-draft')) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'Requested entity was not found.' } }) };
    }
    assert.match(url, /\/drafts\/draft-1$/);
    assert.equal(options.method, 'PUT');
    updatedRaw = JSON.parse(options.body).message.raw;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'draft-1', message: { id: 'message-2', threadId: 'thread-2' } }) };
  };
  const updateResponse = await send({
    type: 'update-draft-batch',
    batchId: data.mailBatches[0].id,
    payload: { subjectTemplate: '안내 {{이름}}', bodyTemplate: '{{이름}}님 수정 본문', postscriptTemplate: '추신', attachments: [] }
  });
  assert.equal(updateResponse.ok, true);
  assert.equal(updateResponse.data.updated, 1);
  assert.equal(updateResponse.data.skipped, 1);
  const updatedMime = Buffer.from(updatedRaw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(updatedMime, /Subject: =\?UTF-8\?B\?/);
  const updatedBody = Buffer.from(updatedMime.split('\r\n\r\n').at(-1).replace(/\s/g, ''), 'base64').toString('utf8');
  assert.equal(updatedBody, '홍길동님 수정 본문\n\n추신');
  assert.equal(data.mailBatches[0].items[0].subject, '안내 홍길동');
  assert.equal(data.mailBatches[0].items[0].messageId, 'message-2');
  assert.match(data.mailBatches[0].items[1].draftEditError, /전송되었거나 삭제된/);

  global.fetch = async (url, options = {}) => {
    assert.match(url, /\/drafts\?maxResults=500$/);
    assert.equal(options.method, undefined);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ drafts: [{ id: 'draft-1', message: { id: 'message-edited-in-gmail', threadId: 'thread-2' } }] })
    };
  };
  const statusResponse = await send({ type: 'check-draft-batch-status', batchId: data.mailBatches[0].id });
  assert.equal(statusResponse.ok, true);
  assert.equal(statusResponse.data.modified, 1);
  assert.equal(statusResponse.data.missing, 1);
  assert.equal(data.mailBatches[0].items[0].externalDraftState, 'modified');
  assert.equal(data.mailBatches[0].items[1].externalDraftState, 'missing');

  let releaseSend;
  global.fetch = async () => new Promise((resolve) => {
    releaseSend = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'sent-1', threadId: 'sent-thread-1' }) });
  });
  const enqueuePromise = send({
    type: 'enqueue-mail-batch',
    payload: {
      name: 'cancel test', method: '즉시 발송', senderEmail: 'sender@example.com', label: '', scheduledAt: '', attachments: [],
      items: [
        { email: 'one@example.com', subject: 'one', body: 'one', variables: {} },
        { email: 'two@example.com', subject: 'two', body: 'two', variables: {} }
      ]
    }
  });
  while (!data.mailBatches?.[0]?.currentItemId || !releaseSend) await new Promise((resolve) => setTimeout(resolve, 1));
  const cancelResponse = await send({ type: 'cancel-mail-batch', batchId: data.mailBatches[0].id });
  assert.equal(cancelResponse.ok, true);
  releaseSend();
  const canceledEnqueue = await enqueuePromise;
  assert.equal(canceledEnqueue.ok, true);
  assert.deepEqual(data.mailBatches[0].items.map((item) => item.status), ['completed', 'canceled']);

  const driveScope = 'https://www.googleapis.com/auth/drive.appdata';
  const authorizeDrive = await send({ type: 'authorize-drive-sync' });
  assert.equal(authorizeDrive.ok, true);
  assert.equal(authRequests.at(-1).interactive, true);
  assert.ok(authRequests.at(-1).scopes.includes(driveScope));

  let uploadedBody = '';
  global.fetch = async (url, options = {}) => {
    if (url.includes('/drive/v3/files?spaces=appDataFolder')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ files: [] })
      };
    }
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      uploadedBody = options.body;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ id: 'cloud-file-1', modifiedTime: '2026-08-03T00:00:00.000Z' })
      };
    }
    throw new Error(`Unexpected Drive request: ${url}`);
  };
  const cloudSnapshot = {
    format: 'gmail-flow-cloud-sync',
    schemaVersion: 1,
    data: { savedRosters: [], templates: [], structureTemplates: [], workspaceDraft: null }
  };
  const cloudUpload = await send({ type: 'cloud-sync-upload', snapshot: cloudSnapshot });
  assert.equal(cloudUpload.ok, true);
  assert.equal(cloudUpload.data.file.id, 'cloud-file-1');
  assert.match(uploadedBody, /gmail-flow-sync-v1\.json/);
  assert.match(uploadedBody, /gmail-flow-cloud-sync/);
  assert.ok(authRequests.at(-1).scopes.includes(driveScope));

  const cloudDownload = await send({ type: 'cloud-sync-download' });
  assert.equal(cloudDownload.ok, true);
  assert.equal(cloudDownload.data.snapshot, null);
  console.log('background attachment test passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
