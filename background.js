const BATCHES_KEY = 'mailBatches';
const QUEUE_ALARM = 'gmail-flow-queue';
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 40;
const RETRY_DELAY_MS = 60 * 1000;
const OAUTH_PLACEHOLDER = 'replace-with-google-oauth-client';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const CLOUD_SYNC_FILE = 'gmail-flow-sync-v1.json';
let queueRunning = false;
const cancelRequestedBatches = new Set();

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

async function getToken(interactive = false, scopes = [GMAIL_SCOPE]) {
  assertOAuthConfigured();
  try {
    const result = await chrome.identity.getAuthToken({ interactive, scopes });
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
  const token = await getToken(false, [GMAIL_SCOPE]);
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

async function driveFetch(path, options = {}, retry = true) {
  const token = await getToken(false, [GMAIL_SCOPE, DRIVE_APPDATA_SCOPE]);
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (response.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token });
    return driveFetch(path, options, false);
  }
  const contentType = response.headers?.get?.('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = data?.error?.message || `Google Drive API 오류 (${response.status})`;
    const error = new Error(response.status === 403 && /accessNotConfigured|has not been used|disabled/i.test(JSON.stringify(data))
      ? 'Google Cloud 프로젝트에서 Google Drive API를 활성화해야 합니다.'
      : message);
    error.status = response.status;
    error.code = response.status === 401 || response.status === 403 && /insufficient/i.test(JSON.stringify(data)) ? 'DRIVE_AUTH_REQUIRED' : 'DRIVE_API_ERROR';
    throw error;
  }
  return data;
}

async function findCloudSyncFile() {
  const query = encodeURIComponent(`name='${CLOUD_SYNC_FILE}' and trashed=false`);
  const fields = encodeURIComponent('files(id,name,modifiedTime,size)');
  const result = await driveFetch(`/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime%20desc&pageSize=10&fields=${fields}`);
  return result.files?.[0] || null;
}

async function downloadCloudSnapshot() {
  const file = await findCloudSyncFile();
  if (!file) return { file: null, snapshot: null };
  const snapshot = await driveFetch(`/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
  return { file, snapshot: typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot };
}

async function uploadCloudSnapshot(snapshot) {
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).length > 10 * 1024 * 1024) throw new Error('동기화 데이터가 10MB를 초과했습니다. 명단 크기를 줄여주세요.');
  const existing = await findCloudSyncFile();
  if (existing) {
    const file = await driveFetch(`/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=id%2CmodifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: serialized
    });
    return { file };
  }
  const boundary = `gmail-flow-${crypto.randomUUID()}`;
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: CLOUD_SYNC_FILE, parents: ['appDataFolder'] })}`,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${serialized}`,
    `--${boundary}--`
  ].join('\r\n');
  const file = await driveFetch('/upload/drive/v3/files?uploadType=multipart&fields=id%2CmodifiedTime', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
  });
  return { file };
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

function foldBase64(value) {
  return String(value || '').match(/.{1,76}/g)?.join('\r\n') || '';
}

function createRawMessage(item, attachments = []) {
  const headers = [];
  if (item.email) headers.push(`To: ${safeHeader(item.email)}`);
  headers.push(`Subject: ${encodeSubject(item.subject)}`);
  headers.push('MIME-Version: 1.0');
  if (!attachments.length) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64');
    return base64Url(`${headers.join('\r\n')}\r\n\r\n${foldBase64(utf8Base64(item.body || ''))}`);
  }
  const boundary = `gmail-flow-${crypto.randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(utf8Base64(item.body || ''))}`
  ];
  attachments.forEach((attachment) => {
    const encodedName = encodeURIComponent(safeHeader(attachment.name));
    parts.push(`--${boundary}\r\nContent-Type: ${safeHeader(attachment.type) || 'application/octet-stream'}; name*=UTF-8''${encodedName}\r\nContent-Disposition: attachment; filename*=UTF-8''${encodedName}\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(attachment.data)}`);
  });
  parts.push(`--${boundary}--`);
  return base64Url(`${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`);
}

function renderTemplate(template, variables = {}) {
  return String(template || '').replace(/{{\s*([^{}]+?)\s*}}/g, (_match, name) => String(variables[String(name).trim()] ?? ''));
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

async function createDraft(item, labelNames, labelCache, attachments) {
  const draft = await gmailFetch('/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw: createRawMessage(item, attachments) } })
  });
  for (const labelName of labelNames.filter(Boolean)) await applyLabel(draft.message?.id, labelName, labelCache);
  return {
    draftId: draft.id,
    messageId: draft.message?.id || '',
    threadId: draft.message?.threadId || '',
    externalDraftState: 'synced',
    externalDraftCheckedAt: nowIso()
  };
}

async function updateDraftBatch(batchId, payload = {}) {
  const batches = await getBatches();
  const batch = batches.find((entry) => entry.id === batchId);
  if (!batch) throw new Error('수정할 작업 기록을 찾을 수 없습니다.');
  if (batch.method !== '임시 저장') throw new Error('임시 저장으로 만든 메일만 일괄 수정할 수 있습니다.');
  if (batch.currentItemId) throw new Error('현재 처리 중인 작업은 완료된 후 수정해주세요.');

  const subjectTemplate = String(payload.subjectTemplate || '');
  const bodyTemplate = String(payload.bodyTemplate || '');
  const postscriptTemplate = String(payload.postscriptTemplate || '');
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const oldAttachments = Array.isArray(batch.attachments) ? batch.attachments : [];
  const candidates = batch.items.filter((item) => item.draftId);
  if (!candidates.length) throw new Error('수정할 수 있는 Gmail 초안이 없습니다.');

  batch.draftEdit = {
    status: 'processing', total: candidates.length, processed: 0,
    updated: 0, skipped: 0, failed: 0, startedAt: nowIso(), completedAt: ''
  };
  await saveBatches(batches);
  const labelCache = new Map();

  for (const item of candidates) {
    const nextItem = {
      ...item,
      subject: renderTemplate(subjectTemplate, item.variables),
      body: [renderTemplate(bodyTemplate, item.variables).trim(), renderTemplate(postscriptTemplate, item.variables).trim()].filter(Boolean).join('\n\n')
    };
    try {
      const draft = await gmailFetch(`/drafts/${encodeURIComponent(item.draftId)}`, {
        method: 'PUT',
        body: JSON.stringify({ message: { raw: createRawMessage(nextItem, attachments) } })
      });
      item.subject = nextItem.subject;
      item.body = nextItem.body;
      item.messageId = draft.message?.id || item.messageId || '';
      item.threadId = draft.message?.threadId || item.threadId || '';
      item.externalDraftState = 'synced';
      item.externalDraftCheckedAt = nowIso();
      item.attachments = attachments;
      item.error = '';
      item.draftEditError = '';
      item.updatedAt = nowIso();
      if (batch.label && item.messageId) {
        try { await applyLabel(item.messageId, batch.label, labelCache); } catch (_) {}
      }
      batch.draftEdit.updated += 1;
    } catch (error) {
      item.attachments = oldAttachments;
      item.draftEditError = error?.status === 404
        ? 'Gmail에서 이미 전송되었거나 삭제된 초안입니다.'
        : (error?.message || '초안을 수정하지 못했습니다.');
      if (error?.status === 404) batch.draftEdit.skipped += 1;
      else batch.draftEdit.failed += 1;
      if (error?.code === 'AUTH_REQUIRED') {
        batch.draftEdit.status = 'waiting-auth';
        batch.draftEdit.processed += 1;
        await saveBatches(batches);
        throw error;
      }
    }
    batch.draftEdit.processed += 1;
    await saveBatches(batches);
  }

  batch.subjectTemplate = subjectTemplate;
  batch.bodyTemplate = bodyTemplate;
  batch.postscriptTemplate = postscriptTemplate;
  batch.attachments = attachments;
  batch.updatedAt = nowIso();
  batch.draftEdit.status = 'completed';
  batch.draftEdit.completedAt = batch.updatedAt;
  await saveBatches(batches);
  return { batchId, ...batch.draftEdit };
}

async function checkDraftBatchStatus(batchId) {
  const batches = await getBatches();
  const batch = batches.find((entry) => entry.id === batchId);
  if (!batch) throw new Error('확인할 작업 기록을 찾을 수 없습니다.');
  if (batch.method !== '임시 저장') throw new Error('임시메일 작업만 Gmail 상태를 확인할 수 있습니다.');

  const draftIndex = new Map();
  let pageToken = '';
  do {
    const query = new URLSearchParams({ maxResults: '500' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await gmailFetch(`/drafts?${query.toString()}`);
    (page.drafts || []).forEach((draft) => draftIndex.set(draft.id, draft));
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  const checkedAt = nowIso();
  const result = { synced: 0, modified: 0, missing: 0, total: 0, checkedAt };
  batch.items.forEach((item) => {
    if (!item.draftId) return;
    result.total += 1;
    const current = draftIndex.get(item.draftId);
    if (!current) item.externalDraftState = 'missing';
    else if (item.messageId && current.message?.id && current.message.id !== item.messageId) item.externalDraftState = 'modified';
    else item.externalDraftState = 'synced';
    item.externalDraftCheckedAt = checkedAt;
    result[item.externalDraftState] += 1;
  });
  batch.draftStatusCheckedAt = checkedAt;
  batch.draftStatusSummary = result;
  await saveBatches(batches);
  return { batchId, ...result };
}

async function sendMessage(item, attachments) {
  const message = await gmailFetch('/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: createRawMessage(item, attachments) })
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
      Object.assign(item, await createDraft(item, [batch.label], labelCache, batch.attachments));
      item.status = 'completed';
    } else if (batch.method === '즉시 발송') {
      Object.assign(item, await sendMessage(item, batch.attachments));
      item.status = 'completed';
    } else if (previousStatus === 'queued') {
      Object.assign(item, await createDraft(item, [batch.label, batch.scheduleLabel], labelCache, batch.attachments));
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
        const statusBeforeProcessing = item.status;
        batch.currentItemId = item.id;
        batch.status = 'processing';
        batch.updatedAt = nowIso();
        await saveBatches(batches);
        await processItem(batch, item, labelCache);
        processed += 1;
        if (cancelRequestedBatches.has(batch.id)) {
          const createdUnsentDraft = item.draftId && (batch.method === '임시 저장' || (batch.method === '예약 발송' && statusBeforeProcessing === 'queued'));
          if (createdUnsentDraft) {
            try { await gmailFetch(`/drafts/${encodeURIComponent(item.draftId)}`, { method: 'DELETE' }); } catch (_) {}
            item.status = 'canceled';
            item.error = '';
          }
          batch.items.forEach((pendingItem) => {
            if (!isTerminal(pendingItem.status) && pendingItem.id !== item.id) pendingItem.status = 'canceled';
          });
          cancelRequestedBatches.delete(batch.id);
        }
        batch.currentItemId = '';
        updateBatchSummary(batch);
        await saveBatches(batches);
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
    senderEmail: String(payload.senderEmail || '').trim(),
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    subjectTemplate: String(payload.subjectTemplate ?? payload.subject ?? ''),
    bodyTemplate: String(payload.bodyTemplate ?? ''),
    postscriptTemplate: String(payload.postscriptTemplate ?? ''),
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
  if (batch.currentItemId) cancelRequestedBatches.add(batchId);
  for (const item of batch.items) {
    if (isTerminal(item.status)) continue;
    if (item.id === batch.currentItemId) continue;
    if (item.draftId) {
      try { await gmailFetch(`/drafts/${encodeURIComponent(item.draftId)}`, { method: 'DELETE' }); } catch (_) {}
    }
    item.status = 'canceled';
    item.updatedAt = nowIso();
  }
  updateBatchSummary(batch);
  if (batch.currentItemId) batch.status = 'canceling';
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
  if (!configured) return { configured: false, connected: false, email: '', rememberedEmail: '' };
  try {
    await getToken(false, [GMAIL_SCOPE]);
    const profile = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return { configured: true, connected: true, email: profile?.email || '', rememberedEmail: profile?.email || '' };
  } catch (error) {
    let rememberedEmail = '';
    try {
      const profile = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
      rememberedEmail = profile?.email || '';
    } catch (_) {}
    return { configured: true, connected: false, email: '', rememberedEmail, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'connection-status') return connectionStatus();
    if (message.type === 'authorize-drive-sync') {
      await getToken(true, [GMAIL_SCOPE, DRIVE_APPDATA_SCOPE]);
      return { authorized: true };
    }
    if (message.type === 'cloud-sync-download') return downloadCloudSnapshot();
    if (message.type === 'cloud-sync-upload') return uploadCloudSnapshot(message.snapshot);
    if (message.type === 'process-queue') return processQueue();
    if (message.type === 'resume-after-auth') return resumeWaitingAuth();
    if (message.type === 'enqueue-mail-batch') return enqueueBatch(message.payload);
    if (message.type === 'update-draft-batch') return updateDraftBatch(message.batchId, message.payload);
    if (message.type === 'check-draft-batch-status') return checkDraftBatchStatus(message.batchId);
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
