const assert = require('node:assert/strict');

const data = {};
let runtimeListener;
let sentRaw = '';
const authRequests = [];
let profileEmail = 'chrome-default@example.com';
let tokenProfileEmail = 'sender@example.com';
let driveTokenProfileEmail = 'sender@example.com';
let alarmListener;
let blockNextMailBatchRead = false;
let releaseBlockedMailBatchRead;
let failNextCancelRequestWrite = false;
const isGmailProfileRequest = (url) => String(url).endsWith('/gmail/v1/users/me/profile');
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const gmailProfileResponse = (options = {}) => {
  const authorization = options?.headers?.Authorization || options?.headers?.authorization || '';
  const emailAddress = authorization === 'Bearer drive-token' ? driveTokenProfileEmail : tokenProfileEmail;
  return { ok: true, status: 200, text: async () => JSON.stringify({ emailAddress }) };
};

global.chrome = {
  storage: { local: {
    get: async (key) => {
      if (key === 'mailBatches' && blockNextMailBatchRead) {
        blockNextMailBatchRead = false;
        await new Promise((resolve) => { releaseBlockedMailBatchRead = resolve; });
      }
      return { [key]: data[key] };
    },
    set: async (values) => {
      if (failNextCancelRequestWrite && Object.hasOwn(values, 'mailBatchCancelRequests')) {
        failNextCancelRequestWrite = false;
        throw new Error('simulated cancel persistence failure');
      }
      Object.assign(data, values);
    }
  } },
  identity: {
    getAuthToken: async (request) => {
      authRequests.push(request);
      return { token: request?.scopes?.includes(DRIVE_APPDATA_SCOPE) ? 'drive-token' : 'test-token' };
    },
    removeCachedAuthToken: async () => {},
    getProfileUserInfo: async () => ({ email: profileEmail })
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
    onAlarm: { addListener: (listener) => { alarmListener = listener; } }
  }
};

global.fetch = async (url, options) => {
  if (isGmailProfileRequest(url)) return gmailProfileResponse(options);
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
  assert.equal(data.mailBatches[0].senderEmail, tokenProfileEmail, 'batch identity must come from the fixed Gmail token profile, not Chrome default profile metadata');
  assert.notEqual(profileEmail, tokenProfileEmail, 'test precondition: Chrome default profile differs from the OAuth token account');

  data.mailBatches[0].items.push({
    id: 'missing-item', status: 'completed', draftId: 'missing-draft', messageId: 'missing-message', threadId: '',
    email: 'missing@example.com', subject: '기존 제목', body: '기존 본문', variables: { 이름: '삭제됨' }
  });
  data.mailBatches[0].total = 2;
  data.mailBatches[0].completed = 2;
  let updatedRaw = '';
  global.fetch = async (url, options = {}) => {
    if (isGmailProfileRequest(url)) return gmailProfileResponse(options);
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
    if (isGmailProfileRequest(url)) return gmailProfileResponse(options);
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
  global.fetch = async (url, options = {}) => {
    if (isGmailProfileRequest(url)) return gmailProfileResponse(options);
    return new Promise((resolve) => {
    releaseSend = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'sent-1', threadId: 'sent-thread-1' }) });
    });
  };
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

  let releaseFirstConcurrentSend;
  let concurrentSendCount = 0;
  global.fetch = async (url, options = {}) => {
    if (isGmailProfileRequest(url)) return gmailProfileResponse(options);
    concurrentSendCount += 1;
    if (concurrentSendCount === 1) {
      return new Promise((resolve) => {
        releaseFirstConcurrentSend = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'concurrent-1', threadId: 'thread-concurrent-1' }) });
      });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: `concurrent-${concurrentSendCount}`, threadId: `thread-concurrent-${concurrentSendCount}` }) };
  };
  const firstConcurrentEnqueue = send({
    type: 'enqueue-mail-batch',
    payload: { name: 'concurrent first', method: '즉시 발송', senderEmail: 'sender@example.com', label: '', scheduledAt: '', attachments: [], items: [{ email: 'first@example.com', subject: 'first', body: 'first', variables: {} }] }
  });
  while (!releaseFirstConcurrentSend || !data.mailBatches?.find((batch) => batch.name === 'concurrent first')?.currentItemId) await new Promise((resolve) => setTimeout(resolve, 1));
  const secondConcurrentEnqueue = send({
    type: 'enqueue-mail-batch',
    payload: { name: 'concurrent second', method: '즉시 발송', senderEmail: 'sender@example.com', label: '', scheduledAt: '', attachments: [], items: [{ email: 'second@example.com', subject: 'second', body: 'second', variables: {} }] }
  });
  let quitFlushSettled = false;
  const quitFlush = send({ type: 'flush-mail-queue' }).then((response) => { quitFlushSettled = true; return response; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(quitFlushSettled, false, 'quit flush must wait until an API result is saved to the mail batch');
  releaseFirstConcurrentSend();
  const [firstConcurrentResponse, secondConcurrentResponse, quitFlushResponse] = await Promise.all([firstConcurrentEnqueue, secondConcurrentEnqueue, quitFlush]);
  assert.equal(firstConcurrentResponse.ok, true);
  assert.equal(secondConcurrentResponse.ok, true);
  assert.equal(quitFlushResponse.ok, true);
  assert.equal(quitFlushResponse.data.idle, true);
  assert.deepEqual(new Set(data.mailBatches.filter((batch) => batch.name.startsWith('concurrent ')).map((batch) => batch.name)), new Set(['concurrent first', 'concurrent second']), 'a batch enqueued during processing must survive later queue saves');

  tokenProfileEmail = 'other@example.com';
  const mismatchedEnqueue = await send({
    type: 'enqueue-mail-batch',
    payload: { name: 'wrong account', method: '즉시 발송', senderEmail: 'sender@example.com', label: '', scheduledAt: '', attachments: [], items: [{ email: 'wrong@example.com', subject: 'wrong', body: 'wrong', variables: {} }] }
  });
  assert.equal(mismatchedEnqueue.ok, false);
  assert.equal(mismatchedEnqueue.code, 'ACCOUNT_MISMATCH');
  assert.equal(data.mailBatches.some((batch) => batch.name === 'wrong account'), false, 'a batch must not be accepted under a different OAuth profile');
  const waitingBatch = {
    id: 'waiting-old-account', name: 'old account queue', method: '즉시 발송', senderEmail: 'sender@example.com', attachments: [], status: 'waiting-auth', total: 1, completed: 0, failed: 0,
    items: [{ id: 'waiting-old-item', status: 'waiting-auth', attempts: 0, error: 'auth', draftId: '', messageId: '', threadId: '', email: 'recipient@example.com', subject: 'old', body: 'old' }]
  };
  data.mailBatches.unshift(waitingBatch);
  const mismatchedResume = await send({ type: 'resume-after-auth' });
  assert.equal(mismatchedResume.ok, true);
  assert.equal(data.mailBatches.find((batch) => batch.id === waitingBatch.id).items[0].status, 'waiting-auth', 'reconnect with another account must not resume an old account batch');
  data.mailBatches = data.mailBatches.filter((batch) => batch.id !== waitingBatch.id);
  tokenProfileEmail = 'sender@example.com';

  const durableCancelBatch = {
    id: 'durable-cancel', name: 'durable cancel', method: '즉시 발송', senderEmail: 'sender@example.com', attachments: [], status: 'queued', total: 1, completed: 0, failed: 0,
    items: [{ id: 'durable-cancel-item', status: 'queued', attempts: 0, error: '', draftId: '', messageId: '', threadId: '', email: 'cancel@example.com', subject: 'cancel', body: 'cancel' }]
  };
  data.mailBatches.unshift(durableCancelBatch);
  blockNextMailBatchRead = true;
  const durableCancel = send({ type: 'cancel-mail-batch', batchId: durableCancelBatch.id });
  while (!releaseBlockedMailBatchRead) await new Promise((resolve) => setTimeout(resolve, 0));
  let quitPrepareSettled = false;
  const quitPrepare = send({ type: 'prepare-mail-queue-for-quit' }).then((response) => { quitPrepareSettled = true; return response; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(quitPrepareSettled, false, 'quit preparation must wait for a cancellation request that has started but is not durable yet');
  releaseBlockedMailBatchRead();
  assert.equal((await durableCancel).ok, true);
  const quitPrepareResponse = await quitPrepare;
  assert.equal(quitPrepareResponse.ok, true);
  assert.equal(quitPrepareResponse.data.paused, true);
  assert.ok(data.mailBatchCancelRequests.includes(durableCancelBatch.id), 'cancel intent must be durable before quit preparation completes');
  let fetchStartedWhilePaused = false;
  global.fetch = async () => { fetchStartedWhilePaused = true; throw new Error('paused queue must not call Gmail'); };
  alarmListener({ name: 'gmail-flow-queue' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fetchStartedWhilePaused, false, 'an alarm fired after quit preparation must not start a new Gmail API operation');
  const rejectedWhilePaused = await send({
    type: 'enqueue-mail-batch',
    payload: { name: 'quit race', method: '즉시 발송', senderEmail: 'sender@example.com', label: '', scheduledAt: '', attachments: [], items: [{ email: 'race@example.com', subject: 'race', body: 'race', variables: {} }] }
  });
  assert.equal(rejectedWhilePaused.ok, false);
  assert.equal(rejectedWhilePaused.code, 'APP_SHUTTING_DOWN');
  assert.equal(data.mailBatches.some((batch) => batch.name === 'quit race'), false, 'mail mutations arriving after the quit drain must not enter storage');
  const resumedQueue = await send({ type: 'resume-mail-queue-after-quit-canceled' });
  assert.equal(resumedQueue.ok, true);
  assert.equal(data.mailBatches.find((batch) => batch.id === durableCancelBatch.id).status, 'canceled');
  data.mailBatches = data.mailBatches.filter((batch) => batch.id !== durableCancelBatch.id);

  const failedCancelBatch = {
    id: 'failed-cancel', name: 'failed cancel', method: '즉시 발송', senderEmail: 'sender@example.com', attachments: [], status: 'queued', total: 1, completed: 0, failed: 0,
    items: [{ id: 'failed-cancel-item', status: 'queued', attempts: 0, error: '', draftId: '', messageId: '', threadId: '', email: 'cancel-failure@example.com', subject: 'cancel', body: 'cancel' }]
  };
  data.mailBatches.unshift(failedCancelBatch);
  blockNextMailBatchRead = true;
  failNextCancelRequestWrite = true;
  releaseBlockedMailBatchRead = null;
  const failedCancel = send({ type: 'cancel-mail-batch', batchId: failedCancelBatch.id });
  while (!releaseBlockedMailBatchRead) await new Promise((resolve) => setTimeout(resolve, 0));
  const failedCancelQuit = send({ type: 'prepare-mail-queue-for-quit' });
  releaseBlockedMailBatchRead();
  assert.equal((await failedCancel).ok, false);
  assert.equal((await failedCancelQuit).ok, false, 'quit preparation must fail when an in-flight cancellation cannot be persisted');
  assert.equal((await send({ type: 'resume-mail-queue-after-quit-canceled' })).ok, true);
  assert.equal(data.mailBatches.find((batch) => batch.id === failedCancelBatch.id).status, 'canceled');
  data.mailBatches = data.mailBatches.filter((batch) => batch.id !== failedCancelBatch.id);

  let uploadedBody = '';
  let remoteFile = null;
  let remoteSnapshot = null;
  let patchCount = 0;
  let driveApiRequestCount = 0;
  let changeDuringDownload = false;
  let rejectNextPatchPrecondition = false;
  let duplicateRemoteFile = false;
  const driveResponse = (payload, etag = '') => ({
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : String(name).toLowerCase() === 'etag' ? etag : '' },
    json: async () => structuredClone(payload)
  });
  global.fetch = async (url, options = {}) => {
    if (isGmailProfileRequest(url)) return gmailProfileResponse(options);
    driveApiRequestCount += 1;
    assert.equal(options.headers?.Authorization, 'Bearer drive-token', 'each Drive request must keep using the broad token whose account was verified');
    if (url.includes('/drive/v3/files?spaces=appDataFolder')) {
      const files = remoteFile ? [{ ...remoteFile, etag: undefined }] : [];
      if (duplicateRemoteFile) files.push({ ...remoteFile, id: 'cloud-file-duplicate', etag: undefined });
      return driveResponse({ files });
    }
    if (url.includes('/drive/v3/files/cloud-file-1?fields=')) {
      return driveResponse(remoteFile, remoteFile?.etag || '');
    }
    if (url.includes('/drive/v3/files/cloud-file-1?alt=media')) {
      const downloaded = structuredClone(remoteSnapshot);
      if (changeDuringDownload) {
        changeDuringDownload = false;
        remoteFile = { ...remoteFile, modifiedTime: '2026-08-03T00:02:00.000Z', version: '4', etag: 'etag-4' };
        remoteSnapshot = { ...remoteSnapshot, updatedAt: 'remote-changed-during-download' };
      }
      return driveResponse(downloaded, remoteFile?.etag || '');
    }
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      uploadedBody = options.body;
      remoteFile = { id: 'cloud-file-1', modifiedTime: '2026-08-03T00:00:00.000Z', version: '1', etag: 'etag-1' };
      remoteSnapshot = structuredClone(cloudSnapshot);
      return driveResponse(remoteFile, remoteFile.etag);
    }
    if (url.includes('/upload/drive/v3/files/cloud-file-1?uploadType=media')) {
      patchCount += 1;
      assert.equal(options.headers['If-Match'], remoteFile.etag, 'Drive PATCH must use the exact ETag observed before upload');
      if (rejectNextPatchPrecondition) {
        rejectNextPatchPrecondition = false;
        remoteFile = { ...remoteFile, modifiedTime: '2026-08-03T00:01:30.000Z', version: '3', etag: 'etag-3' };
        remoteSnapshot = { ...remoteSnapshot, updatedAt: 'other-pc-between-check-and-patch' };
        return {
          ok: false,
          status: 412,
          headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : '' },
          json: async () => ({ error: { message: 'Precondition Failed' } })
        };
      }
      remoteSnapshot = JSON.parse(options.body);
      remoteFile = { ...remoteFile, modifiedTime: '2026-08-03T00:01:00.000Z', version: '2', etag: 'etag-2' };
      return driveResponse(remoteFile, remoteFile.etag);
    }
    throw new Error(`Unexpected Drive request: ${url}`);
  };
  const cloudSnapshot = {
    format: 'gmail-flow-cloud-sync',
    schemaVersion: 1,
    accountEmail: tokenProfileEmail,
    data: { savedRosters: [], templates: [], structureTemplates: [], workspaceDraft: null }
  };
  driveTokenProfileEmail = 'other@example.com';
  const mismatchedDriveDownload = await send({ type: 'cloud-sync-download', expectedAccount: tokenProfileEmail });
  assert.equal(mismatchedDriveDownload.ok, false);
  assert.equal(mismatchedDriveDownload.code, 'ACCOUNT_MISMATCH');
  const mismatchedDriveUpload = await send({
    type: 'cloud-sync-upload', snapshot: cloudSnapshot, expectedFile: { exists: false }, expectedAccount: tokenProfileEmail
  });
  assert.equal(mismatchedDriveUpload.ok, false);
  assert.equal(mismatchedDriveUpload.code, 'ACCOUNT_MISMATCH');
  assert.equal(driveApiRequestCount, 0, 'a broad Drive token for another account must be rejected before any Drive API call');
  driveTokenProfileEmail = tokenProfileEmail;

  const authorizeDrive = await send({ type: 'authorize-drive-sync', expectedAccount: tokenProfileEmail });
  assert.equal(authorizeDrive.ok, true);
  assert.equal(authRequests.at(-1).interactive, true);
  assert.ok(authRequests.at(-1).scopes.includes(DRIVE_APPDATA_SCOPE));

  const driveRequestsBeforeMislabeledUpload = driveApiRequestCount;
  const mislabeledUpload = await send({
    type: 'cloud-sync-upload',
    snapshot: { ...cloudSnapshot, accountEmail: 'different-label@example.com' },
    expectedFile: { exists: false },
    expectedAccount: tokenProfileEmail
  });
  assert.equal(mislabeledUpload.ok, false);
  assert.equal(mislabeledUpload.code, 'ACCOUNT_MISMATCH');
  assert.equal(driveApiRequestCount, driveRequestsBeforeMislabeledUpload, 'a snapshot labeled for another account must be rejected before any Drive API call');

  const cloudUpload = await send({
    type: 'cloud-sync-upload', snapshot: cloudSnapshot, expectedFile: { exists: false }, expectedAccount: tokenProfileEmail
  });
  assert.equal(cloudUpload.ok, true);
  assert.equal(cloudUpload.data.file.id, 'cloud-file-1');
  assert.equal(cloudUpload.data.file.version, '1');
  assert.match(uploadedBody, /gmail-flow-sync-v1\.json/);
  assert.match(uploadedBody, /gmail-flow-cloud-sync/);
  assert.ok(authRequests.at(-1).scopes.includes(DRIVE_APPDATA_SCOPE));

  remoteFile = { ...remoteFile, modifiedTime: '2026-08-03T00:00:30.000Z', version: '2', etag: 'etag-other-pc' };
  remoteSnapshot = { ...cloudSnapshot, updatedAt: 'other-pc' };
  const staleUpload = await send({
    type: 'cloud-sync-upload', snapshot: { ...cloudSnapshot, updatedAt: 'stale-local' }, expectedFile: cloudUpload.data.file, expectedAccount: tokenProfileEmail
  });
  assert.equal(staleUpload.ok, false);
  assert.equal(staleUpload.code, 'CLOUD_SYNC_CONFLICT');
  assert.equal(patchCount, 0, 'a stale expected identity must fail before Drive PATCH');
  assert.equal(remoteSnapshot.updatedAt, 'other-pc');

  const currentIdentity = structuredClone(remoteFile);
  const conditionalUpload = await send({
    type: 'cloud-sync-upload', snapshot: { ...cloudSnapshot, updatedAt: 'merged' }, expectedFile: currentIdentity, expectedAccount: tokenProfileEmail
  });
  assert.equal(conditionalUpload.ok, true);
  assert.equal(patchCount, 1);
  assert.equal(remoteSnapshot.updatedAt, 'merged');

  rejectNextPatchPrecondition = true;
  const racedUpload = await send({
    type: 'cloud-sync-upload', snapshot: { ...cloudSnapshot, updatedAt: 'must-not-win' }, expectedFile: conditionalUpload.data.file, expectedAccount: tokenProfileEmail
  });
  assert.equal(racedUpload.ok, false);
  assert.equal(racedUpload.code, 'CLOUD_SYNC_CONFLICT', 'a 412 after metadata verification must become an explicit sync conflict');
  assert.equal(remoteSnapshot.updatedAt, 'other-pc-between-check-and-patch');

  changeDuringDownload = true;
  const racedDownload = await send({ type: 'cloud-sync-download', expectedAccount: tokenProfileEmail });
  assert.equal(racedDownload.ok, false);
  assert.equal(racedDownload.code, 'CLOUD_SYNC_CONFLICT', 'metadata changes during download must not return a mixed snapshot');
  const cloudDownload = await send({ type: 'cloud-sync-download', expectedAccount: tokenProfileEmail });
  assert.equal(cloudDownload.ok, true);
  assert.equal(cloudDownload.data.snapshot.updatedAt, 'remote-changed-during-download');
  assert.equal(cloudDownload.data.file.version, '4');
  const staleVerify = await send({ type: 'cloud-sync-verify', expectedFile: conditionalUpload.data.file, expectedAccount: tokenProfileEmail });
  assert.equal(staleVerify.ok, false);
  assert.equal(staleVerify.code, 'CLOUD_SYNC_CONFLICT', 'remote changes after download must fail revalidation before local apply');
  duplicateRemoteFile = true;
  const duplicateVerify = await send({ type: 'cloud-sync-verify', expectedFile: cloudDownload.data.file, expectedAccount: tokenProfileEmail });
  assert.equal(duplicateVerify.ok, false);
  assert.equal(duplicateVerify.code, 'CLOUD_SYNC_CONFLICT', 'duplicate appData files must never be resolved by arbitrary modified-time ordering');
  console.log('background attachment test passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
