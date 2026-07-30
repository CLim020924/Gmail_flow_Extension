const BATCHES_KEY = 'mailBatches';
const QUEUE_ALARM = 'gmail-flow-queue';
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 40;
const RETRY_DELAY_MS = 60 * 1000;
const OAUTH_PLACEHOLDER = 'replace-with-google-oauth-client';
let queueRunning = false;

const nowIso = () => new Date().toISOString();
const isTerminal = (status) => ['completed', 'failed', 'canceled'].includes(status);

async function getBatches() {
  const result = await chrome.storage.local.get(BATCHES_KEY);
  return Array.isArray(result[BATCHES_KEY]) ? result[BATCHES_KEY] : [];
}

async function saveBatches(batches) {
  await chrome.storage.local.set({ [BATCHES_KEY]: batches });
}

function getOAuthClientId() {
  return chrome.runtime.getManifest().oauth2?.client_id || '';
}

function assertOAuthConfigured() {
  const clientId = getOAuthClientId();
  if (!clientId || clientId.includes(OAUTH_PLACEHOLDER)) {
    const error = new Error('Google OAuth 클라이언트 ID가 설정되지 않았습니다.');
    error.code = 'OAUTH_NOT_CONFIGURED';
    throw error;
  }
}

async function getToken(interactive = false) {
  assertOAuthConfigured();
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new Error('Gmail 인증 토큰을 받지 못했습니다.');
    return token;
  } catch (cause) {
    const error = new Error(cause?.message || 'Gmail 계정 연결이 필요합니다.');
    error.code = cause?.code || 'AUTH_REQUIRED';
    throw error;
  }
}

async function gmailFetch(path, options = {}, retry = true) {
  const token = await getToken(false);
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token });
    return gmailFetch(path, options, false);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Gmail API 오류 (${response.status})`);
    error.status = response.status;
    error.code = response.status === 401 ? 'AUTH_REQUIRED' : 'GMAIL_API_ERROR';
    throw error;
  }
  return data;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function utf8Base64(value) {
  return bytesToBase64(new TextEncoder().encode(String(value ?? '')));
}

function base64Url(value) {
  return utf8Base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeSubject(value) {
  const subject = safeHeader(value);
  return subject ? `=?UTF-8?B?${utf8Base64(subject)}?=` : '';
}

function createRawMessage(item) {
  const headers = [];
  if (item.email) headers.push(`To: ${safeHeader(item.email)}`);
  headers.push(`Subject: ${encodeSubject(item.subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');
  return base64Url(`${headers.join('\r\n')}\r\n\r\n${utf8Base64(item.body || '')}`);
}

async function getOrCreateLabelId(name, cache) {
  const normalized = String(name || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (cache.has(normalized)) return cache.get(normalized);
  const list = await gmailFetch('/labels');
  const existing = (list.labels || []).find((label) => label.name === normalized);
  if (existing) {
    cache.set(normalized, existing.id);
    return existing.id;
  }
  const created = await gmailFetch('/labels', {
    method: 'POST',
    body: JSON.stringify({ name: normalized, labelListVisibility: 'labelShow', messageListVisibility: 'show' })
  });
  cache.set(normalized, created.id);
  return created.id;
}

async function applyLabel(messageId, labelName, cache) {
  if (!messageId || !labelName) return;
  const labelId = await getOrCreateLabelId(labelName, cache);
  if (!labelId) return;
  await gmailFetch(`/messages/${encodeURIComponent(messageId)}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: [] })
  });
}

async function removeLabel(messageId, labelName, cache) {
  if (!messageId || !labelName) return;
  const labelId = await getOrCreateLabelId(labelName, cache);
  if (!labelId) return;
  await gmailFetch(`/messages/${encodeURIComponent(messageId)}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: [], removeLabelIds: [labelId] })
  });
}

async function createDraft(item, labelNames, labelCache) {
  const draft = await gmailFetch('/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw: createRawMessage(item) } })
  });
  for (const labelName of labelNames.filter(Boolean)) await applyLabel(draft.message?.id, labelName, labelCache);
  return { draftId: draft.id, messageId: draft.message?.id || '', threadId: draft.message?.threadId || '' };
}

async function sendMessage(item) {
  const message = await gmailFetch('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: createRawMessage(item) })
  });
  return { messageId: message.id || '', threadId: message.threadId || '' };
}

async function sendDraft(item) {
  const message = await gmailFetch('/drafts/send', {
    method: 'POST',
    body: JSON.stringify({ id: item.draftId })
  });
  return { messageId: message.id || '', threadId: message.threadId || '' };
}

function canProcess(item, now) {
  if (isTerminal(item.status) || item.status === 'waiting-auth') return false;
  if (item.nextAttemptAt && new Date(item.nextAttemptAt).getTime() > now) return false;
  if (item.status === 'scheduled') return new Date(item.scheduledAt).getTime() <= now;
  return item.status === 'queued';
}

async function processItem(batch, item, labelCache) {
  const previousStatus = item.status;
  try {
    if (batch.method === '임시 저장') {
      Object.assign(item, await createDraft(item, [batch.label], labelCache));
      item.status = 'completed';
    } else if (batch.method === '즉시 발송') {
      Object.assign(item, await sendMessage(item));
      item.status = 'completed';
    } else if (previousStatus === 'queued') {
      Object.assign(item, await createDraft(item, [batch.label, batch.scheduleLabel], labelCache));
      item.status = 'scheduled';
    } else if (previousStatus === 'scheduled') {
      Object.assign(item, await sendDraft(item));
      await removeLabel(item.messageId, batch.scheduleLabel, labelCache);
      item.status = 'completed';
    }
    item.error = '';
    item.nextAttemptAt = '';
    item.updatedAt = nowIso();
  } catch (error) {
    item.error = error?.message || '알 수 없는 오류';
    item.updatedAt = nowIso();
    if (error?.code === 'AUTH_REQUIRED' || error?.code === 'OAUTH_NOT_CONFIGURED') {
      item.status = 'waiting-auth';
      return;
    }
    item.attempts = Number(item.attempts || 0) + 1;
    if (item.attempts >= MAX_ATTEMPTS) {
      item.status = 'failed';
      if (batch.method === '예약 발송' && item.messageId) {
        try {
          await removeLabel(item.messageId, batch.scheduleLabel, labelCache);
          await applyLabel(item.messageId, '예약발송 실패', labelCache);
        } catch (_) {}
      }
    }
    else {
      item.status = previousStatus;
      item.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
    }
  }
}

function updateBatchSummary(batch) {
  const completed = batch.items.filter((item) => item.status === 'completed').length;
  const failed = batch.items.filter((item) => item.status === 'failed').length;
  const canceled = batch.items.filter((item) => item.status === 'canceled').length;
  const waitingAuth = batch.items.some((item) => item.status === 'waiting-auth');
  batch.completed = completed;
  batch.failed = failed;
  batch.updatedAt = nowIso();
  if (completed === batch.items.length) batch.status = 'completed';
  else if (failed + canceled === batch.items.length) batch.status = failed ? 'failed' : 'canceled';
  else if (waitingAuth) batch.status = 'waiting-auth';
  else if (batch.items.some((item) => item.status === 'scheduled')) batch.status = 'scheduled';
  else batch.status = 'processing';
}

async function scheduleNextRun(batches) {
  await chrome.alarms.clear(QUEUE_ALARM);
  const times = [];
  batches.forEach((batch) => batch.items.forEach((item) => {
    if (item.status === 'queued') times.push(item.nextAttemptAt ? new Date(item.nextAttemptAt).getTime() : Date.now() + 1000);
    if (item.status === 'scheduled') times.push(Math.max(new Date(item.scheduledAt).getTime(), item.nextAttemptAt ? new Date(item.nextAttemptAt).getTime() : 0));
  }));
  const next = times.filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (next) await chrome.alarms.create(QUEUE_ALARM, { when: Math.max(next, Date.now() + 1000) });
}

async function processQueue() {
  if (queueRunning) return { busy: true };
  queueRunning = true;
  try {
    const batches = await getBatches();
    const labelCache = new Map();
    let processed = 0;
    const now = Date.now();
    for (const batch of batches) {
      for (const item of batch.items) {
        if (processed >= BATCH_SIZE) break;
        if (!canProcess(item, now)) continue;
        await processItem(batch, item, labelCache);
        processed += 1;
      }
      updateBatchSummary(batch);
      if (processed >= BATCH_SIZE) break;
    }
    await saveBatches(batches);
    await scheduleNextRun(batches);
    return { processed };
  } finally {
    queueRunning = false;
  }
}

async function enqueueBatch(payload) {
  const batches = await getBatches();
  const createdAt = nowIso();
  const batch = {
    id: crypto.randomUUID(),
    name: String(payload.name || payload.label || payload.subject || payload.method || '메일 작업').trim(),
    method: payload.method,
    label: payload.method === '즉시 발송' ? '' : String(payload.label || '').trim(),
    scheduleLabel: payload.method === '예약 발송' && payload.scheduledAt
      ? `예약_${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(payload.scheduledAt)).replace(' ', '_').replace(':', '시')}분`
      : '',
    scheduledAt: payload.scheduledAt || '',
    status: 'queued',
    total: payload.items.length,
    completed: 0,
    failed: 0,
    createdAt,
    updatedAt: createdAt,
    items: payload.items.map((item, index) => ({
      ...item,
      id: `${crypto.randomUUID()}-${index + 1}`,
      status: 'queued',
      attempts: 0,
      error: '',
      draftId: '',
      messageId: '',
      threadId: '',
      scheduledAt: payload.scheduledAt || '',
      createdAt,
      updatedAt: createdAt
    }))
  };
  batches.unshift(batch);
  await saveBatches(batches);
  await processQueue();
  const updated = (await getBatches()).find((item) => item.id === batch.id) || batch;
  return updated;
}

async function resumeWaitingAuth() {
  const batches = await getBatches();
  batches.forEach((batch) => batch.items.forEach((item) => {
    if (item.status === 'waiting-auth') {
      item.status = item.draftId && batch.method === '예약 발송' ? 'scheduled' : 'queued';
      item.error = '';
    }
  }));
  await saveBatches(batches);
  return processQueue();
}

async function cancelBatch(batchId) {
  const batches = await getBatches();
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) throw new Error('작업을 찾을 수 없습니다.');
  for (const item of batch.items) {
    if (isTerminal(item.status)) continue;
    if (item.draftId) {
      try { await gmailFetch(`/drafts/${encodeURIComponent(item.draftId)}`, { method: 'DELETE' }); } catch (_) {}
    }
    item.status = 'canceled';
    item.updatedAt = nowIso();
  }
  updateBatchSummary(batch);
  await saveBatches(batches);
  await scheduleNextRun(batches);
  return batch;
}

async function deleteBatch(batchId) {
  const batches = await getBatches();
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) return;
  if (!batch.items.every((item) => isTerminal(item.status))) throw new Error('진행 중인 작업은 먼저 취소해야 합니다.');
  await saveBatches(batches.filter((item) => item.id !== batchId));
}

async function connectionStatus() {
  const configured = !getOAuthClientId().includes(OAUTH_PLACEHOLDER);
  if (!configured) return { configured: false, connected: false, email: '' };
  try {
    await getToken(false);
    const profile = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return { configured: true, connected: true, email: profile?.email || '' };
  } catch (error) {
    return { configured: true, connected: false, email: '', error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'connection-status') return connectionStatus();
    if (message.type === 'process-queue') return processQueue();
    if (message.type === 'resume-after-auth') return resumeWaitingAuth();
    if (message.type === 'enqueue-mail-batch') return enqueueBatch(message.payload);
    if (message.type === 'cancel-mail-batch') return cancelBatch(message.batchId);
    if (message.type === 'delete-mail-batch') return deleteBatch(message.batchId);
    throw new Error('지원하지 않는 요청입니다.');
  })().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message, code: error.code || '' }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) processQueue();
});

chrome.runtime.onStartup.addListener(async () => scheduleNextRun(await getBatches()));
chrome.runtime.onInstalled.addListener(async () => scheduleNextRun(await getBatches()));
