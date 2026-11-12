const GF_CONFIG = Object.freeze({
  sheetName: '_gmail_flow_online_queue',
  spreadsheetIdKey: 'GF_SPREADSHEET_ID',
  folderIdKey: 'GF_FOLDER_ID',
  secretKey: 'GF_SHARED_SECRET',
  triggerHandler: 'runScheduledJobs',
  maxAttempts: 3,
  terminalRetentionDays: 90,
  columns: ['jobId', 'status', 'senderEmail', 'scheduledAt', 'total', 'completed', 'failed', 'canceled', 'createdAt', 'updatedAt', 'fileId', 'lastError']
});

function setupOnlineScheduler() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    let spreadsheetId = props.getProperty(GF_CONFIG.spreadsheetIdKey);
    if (!spreadsheetId) {
      spreadsheetId = SpreadsheetApp.create('Gmail Flow 온라인 예약 발송 큐').getId();
      props.setProperty(GF_CONFIG.spreadsheetIdKey, spreadsheetId);
    }
    let folderId = props.getProperty(GF_CONFIG.folderIdKey);
    if (!folderId) {
      folderId = DriveApp.createFolder('Gmail Flow 온라인 예약 발송 데이터').getId();
      props.setProperty(GF_CONFIG.folderIdKey, folderId);
    }
    let secret = props.getProperty(GF_CONFIG.secretKey);
    if (!secret) {
      secret = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid()].join('');
      props.setProperty(GF_CONFIG.secretKey, secret);
    }
    ensureQueueSheet_();
    ensureTimeTrigger_();
    return {
      webAppUrl: ScriptApp.getService().getUrl() || '',
      secret: secret,
      senderEmail: effectiveEmail_(),
      spreadsheetUrl: SpreadsheetApp.openById(spreadsheetId).getUrl(),
      folderUrl: DriveApp.getFolderById(folderId).getUrl()
    };
  } finally {
    lock.releaseLock();
  }
}

function getOnlineSchedulerSetup() {
  const props = PropertiesService.getScriptProperties();
  return {
    webAppUrl: ScriptApp.getService().getUrl() || '',
    secret: props.getProperty(GF_CONFIG.secretKey) || '',
    senderEmail: effectiveEmail_(),
    configured: Boolean(props.getProperty(GF_CONFIG.spreadsheetIdKey) && props.getProperty(GF_CONFIG.folderIdKey) && props.getProperty(GF_CONFIG.secretKey))
  };
}

function rotateOnlineSchedulerSecret() {
  const secret = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid()].join('');
  PropertiesService.getScriptProperties().setProperty(GF_CONFIG.secretKey, secret);
  return { secret: secret };
}

function doGet() {
  return jsonOutput_({ ok: true, data: { service: 'Gmail Flow Online Scheduler', configured: isConfigured_() } });
}

function doPost(event) {
  try {
    if (!isConfigured_()) throw serviceError_('ONLINE_NOT_CONFIGURED', '먼저 Apps Script 편집기에서 setupOnlineScheduler를 실행해주세요.');
    const request = JSON.parse(event && event.postData && event.postData.contents || '{}');
    verifySecret_(request.secret);
    const action = String(request.action || '');
    let data;
    if (action === 'health') data = health_();
    else if (action === 'enqueue') data = enqueueJob_(request.job || {});
    else if (action === 'status') data = statusJobs_(request.jobIds || []);
    else if (action === 'cancel') data = cancelJob_(request.jobId);
    else throw serviceError_('UNKNOWN_ACTION', '지원하지 않는 온라인 예약 발송 요청입니다.');
    return jsonOutput_({ ok: true, data: data });
  } catch (error) {
    return jsonOutput_({ ok: false, code: error.code || 'ONLINE_SCHEDULER_ERROR', error: error.message || String(error) });
  }
}

function health_() {
  return {
    service: 'Gmail Flow Online Scheduler',
    senderEmail: effectiveEmail_(),
    timeZone: Session.getScriptTimeZone(),
    triggerReady: ScriptApp.getProjectTriggers().some(function(trigger) { return trigger.getHandlerFunction() === GF_CONFIG.triggerHandler; }),
    checkedAt: new Date().toISOString()
  };
}

function enqueueJob_(job) {
  validateJob_(job);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const existing = findRow_(job.id);
    if (existing) return publicJob_(readJobFile_(existing.record.fileId), existing.record);
    const ownerEmail = effectiveEmail_().toLowerCase();
    if (ownerEmail && String(job.senderEmail || '').trim().toLowerCase() !== ownerEmail) {
      throw serviceError_('ACCOUNT_MISMATCH', 'Apps Script를 배포한 Google 계정과 Gmail Flow에서 선택한 발신 계정이 다릅니다.');
    }
    const createdDraftIds = [];
    const attachments = decodeAttachments_(job.attachments || []);
    const stored = {
      id: String(job.id), name: String(job.name || '예약 발송'), method: '예약 발송',
      senderEmail: String(job.senderEmail || ownerEmail), scheduledAt: new Date(job.scheduledAt).toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'scheduled',
      items: []
    };
    try {
      (job.items || []).forEach(function(item, index) {
        const draft = GmailApp.createDraft(String(item.email || '').trim(), String(item.subject || ''), String(item.body || ''), { attachments: attachments });
        createdDraftIds.push(draft.getId());
        stored.items.push({
          id: String(item.id || (job.id + '-' + (index + 1))), email: String(item.email || ''),
          subject: String(item.subject || ''), body: String(item.body || ''), variables: item.variables || {},
          status: 'scheduled', attempts: 0, error: '', draftId: draft.getId(), messageId: '', threadId: '',
          scheduledAt: stored.scheduledAt, createdAt: stored.createdAt, updatedAt: stored.createdAt
        });
      });
    } catch (error) {
      createdDraftIds.forEach(function(id) { try { const draft = GmailApp.getDraft(id); if (draft) draft.deleteDraft(); } catch (_) {} });
      throw error;
    }
    const file = writeNewJobFile_(stored);
    appendRecord_(stored, file.getId());
    return publicJob_(stored, readRecord_(findRow_(stored.id).row));
  } finally {
    lock.releaseLock();
  }
}

function statusJobs_(jobIds) {
  const requested = new Set((jobIds || []).map(String));
  const records = readAllRecords_().filter(function(record) { return !requested.size || requested.has(record.jobId); });
  return { jobs: records.map(function(record) { return publicJob_(readJobFile_(record.fileId), record); }), checkedAt: new Date().toISOString() };
}

function cancelJob_(jobId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const found = findRow_(String(jobId || ''));
    if (!found) throw serviceError_('JOB_NOT_FOUND', '온라인 예약 작업을 찾지 못했습니다.');
    const job = readJobFile_(found.record.fileId);
    if (isTerminal_(job.status)) return publicJob_(job, found.record);
    job.items.forEach(function(item) {
      if (isTerminal_(item.status)) return;
      if (item.draftId) {
        try { const draft = GmailApp.getDraft(item.draftId); if (draft) draft.deleteDraft(); } catch (_) {}
      }
      item.status = 'canceled'; item.error = ''; item.updatedAt = new Date().toISOString();
    });
    job.status = 'canceled'; job.updatedAt = new Date().toISOString();
    writeJobFile_(found.record.fileId, job);
    updateRecord_(found.row, job, found.record.fileId, '');
    return publicJob_(job, readRecord_(found.row));
  } finally {
    lock.releaseLock();
  }
}

function runScheduledJobs() {
  if (!isConfigured_()) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const now = Date.now();
    readAllRecords_().filter(function(record) {
      return record.status === 'scheduled' && new Date(record.scheduledAt).getTime() <= now;
    }).slice(0, 40).forEach(function(record) {
      processDueJob_(record);
    });
    cleanupOldJobs_();
  } finally {
    lock.releaseLock();
  }
}

function processDueJob_(record) {
  const found = findRow_(record.jobId);
  if (!found) return;
  const job = readJobFile_(record.fileId);
  job.status = 'processing'; job.updatedAt = new Date().toISOString();
  updateRecord_(found.row, job, record.fileId, '');
  job.items.forEach(function(item) {
    if (item.status !== 'scheduled') return;
    item.attempts = Number(item.attempts || 0) + 1;
    item.updatedAt = new Date().toISOString();
    try {
      const draft = GmailApp.getDraft(item.draftId);
      if (!draft) {
        item.status = 'failed';
        item.error = 'Gmail 초안을 찾을 수 없어 중복 발송 방지를 위해 다시 보내지 않았습니다.';
      } else {
        const sent = draft.send();
        item.status = 'completed'; item.error = '';
        item.messageId = sent && sent.getId ? sent.getId() : '';
        item.threadId = sent && sent.getThread && sent.getThread() ? sent.getThread().getId() : '';
      }
    } catch (error) {
      item.error = error.message || String(error);
      item.status = item.attempts >= GF_CONFIG.maxAttempts ? 'failed' : 'scheduled';
    }
    job.updatedAt = new Date().toISOString();
    summarizeJob_(job);
    writeJobFile_(record.fileId, job);
    updateRecord_(found.row, job, record.fileId, item.error || '');
  });
  summarizeJob_(job);
  writeJobFile_(record.fileId, job);
  updateRecord_(found.row, job, record.fileId, job.items.find(function(item) { return item.error; })?.error || '');
}

function validateJob_(job) {
  if (!job || !String(job.id || '').trim()) throw serviceError_('INVALID_JOB', '예약 작업 ID가 없습니다.');
  const scheduledAt = new Date(job.scheduledAt).getTime();
  if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) throw serviceError_('INVALID_SCHEDULE', '예약 시간은 현재보다 미래여야 합니다.');
  if (!Array.isArray(job.items) || !job.items.length) throw serviceError_('INVALID_JOB', '예약할 메일 대상이 없습니다.');
  if (job.items.length > 100) throw serviceError_('TOO_MANY_RECIPIENTS', '한 온라인 예약 작업은 최대 100명까지 등록할 수 있습니다. 작업을 나누어 예약해주세요.');
  job.items.forEach(function(item) { if (!String(item.email || '').includes('@')) throw serviceError_('INVALID_RECIPIENT', '올바르지 않은 받는 사람 주소가 있습니다.'); });
}

function decodeAttachments_(attachments) {
  let total = 0;
  return (attachments || []).map(function(item) {
    const data = String(item.data || '').replace(/\s/g, '');
    total += Math.floor(data.length * 3 / 4);
    if (total > 18 * 1024 * 1024) throw serviceError_('ATTACHMENTS_TOO_LARGE', '온라인 예약 첨부파일 합계는 18MB 이하여야 합니다.');
    return Utilities.newBlob(Utilities.base64Decode(data), String(item.type || 'application/octet-stream'), String(item.name || 'attachment'));
  });
}

function summarizeJob_(job) {
  const completed = job.items.filter(function(item) { return item.status === 'completed'; }).length;
  const failed = job.items.filter(function(item) { return item.status === 'failed'; }).length;
  const canceled = job.items.filter(function(item) { return item.status === 'canceled'; }).length;
  if (completed === job.items.length) job.status = 'completed';
  else if (failed + canceled === job.items.length) job.status = failed ? 'failed' : 'canceled';
  else if (job.items.some(function(item) { return item.status === 'scheduled'; })) job.status = 'scheduled';
  else job.status = 'processing';
  return { completed: completed, failed: failed, canceled: canceled };
}

function publicJob_(job, record) {
  const counts = summarizeJob_(job);
  return {
    id: job.id, name: job.name, method: '예약 발송', senderEmail: job.senderEmail,
    schedulerMode: 'online', onlineJobId: job.id, scheduledAt: job.scheduledAt, status: job.status,
    total: job.items.length, completed: counts.completed, failed: counts.failed,
    createdAt: job.createdAt, updatedAt: job.updatedAt, lastError: record && record.lastError || '',
    items: job.items
  };
}

function ensureQueueSheet_() {
  const spreadsheet = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(GF_CONFIG.spreadsheetIdKey));
  let sheet = spreadsheet.getSheetByName(GF_CONFIG.sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(GF_CONFIG.sheetName);
  if (!sheet.getLastRow()) sheet.getRange(1, 1, 1, GF_CONFIG.columns.length).setValues([GF_CONFIG.columns]);
  sheet.hideSheet();
  return sheet;
}

function ensureTimeTrigger_() {
  const triggers = ScriptApp.getProjectTriggers().filter(function(trigger) { return trigger.getHandlerFunction() === GF_CONFIG.triggerHandler; });
  if (!triggers.length) ScriptApp.newTrigger(GF_CONFIG.triggerHandler).timeBased().everyMinutes(1).create();
  triggers.slice(1).forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
}

function appendRecord_(job, fileId) {
  const counts = summarizeJob_(job);
  ensureQueueSheet_().appendRow([job.id, job.status, job.senderEmail, job.scheduledAt, job.items.length, counts.completed, counts.failed, counts.canceled, job.createdAt, job.updatedAt, fileId, '']);
}

function updateRecord_(row, job, fileId, lastError) {
  const counts = summarizeJob_(job);
  ensureQueueSheet_().getRange(row, 1, 1, GF_CONFIG.columns.length).setValues([[
    job.id, job.status, job.senderEmail, job.scheduledAt, job.items.length, counts.completed, counts.failed, counts.canceled,
    job.createdAt, job.updatedAt, fileId, String(lastError || '')
  ]]);
}

function readRecord_(row) {
  const values = ensureQueueSheet_().getRange(row, 1, 1, GF_CONFIG.columns.length).getValues()[0];
  return Object.fromEntries(GF_CONFIG.columns.map(function(name, index) { return [name, values[index] instanceof Date ? values[index].toISOString() : values[index]]; }));
}

function readAllRecords_() {
  const sheet = ensureQueueSheet_();
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, GF_CONFIG.columns.length).getValues().map(function(values) {
    return Object.fromEntries(GF_CONFIG.columns.map(function(name, index) { return [name, values[index] instanceof Date ? values[index].toISOString() : values[index]]; }));
  });
}

function findRow_(jobId) {
  const records = readAllRecords_();
  const index = records.findIndex(function(record) { return String(record.jobId) === String(jobId); });
  return index < 0 ? null : { row: index + 2, record: records[index] };
}

function writeNewJobFile_(job) {
  return DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty(GF_CONFIG.folderIdKey)).createFile('gmail-flow-' + job.id + '.json', JSON.stringify(job), MimeType.PLAIN_TEXT);
}

function writeJobFile_(fileId, job) { DriveApp.getFileById(fileId).setContent(JSON.stringify(job)); }
function readJobFile_(fileId) { return JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8')); }

function cleanupOldJobs_() {
  const cutoff = Date.now() - GF_CONFIG.terminalRetentionDays * 24 * 60 * 60 * 1000;
  const sheet = ensureQueueSheet_();
  for (let row = sheet.getLastRow(); row >= 2; row -= 1) {
    const record = readRecord_(row);
    if (isTerminal_(String(record.status)) && new Date(record.updatedAt).getTime() < cutoff) {
      try { DriveApp.getFileById(record.fileId).setTrashed(true); } catch (_) {}
      sheet.deleteRow(row);
    }
  }
}

function verifySecret_(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty(GF_CONFIG.secretKey) || '';
  if (!expected || String(secret || '') !== expected) throw serviceError_('UNAUTHORIZED', '온라인 예약 발송 연결 키가 올바르지 않습니다.');
}

function effectiveEmail_() { return String(Session.getEffectiveUser().getEmail() || '').trim(); }
function isConfigured_() { const p = PropertiesService.getScriptProperties(); return Boolean(p.getProperty(GF_CONFIG.spreadsheetIdKey) && p.getProperty(GF_CONFIG.folderIdKey) && p.getProperty(GF_CONFIG.secretKey)); }
function isTerminal_(status) { return ['completed', 'failed', 'canceled'].includes(String(status)); }
function serviceError_(code, message) { const error = new Error(message); error.code = code; return error; }
function jsonOutput_(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
