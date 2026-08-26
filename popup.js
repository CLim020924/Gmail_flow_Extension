const storage = {
  async get(key, fallback) {
    if (globalThis.chrome?.storage?.local) {
      const result = await chrome.storage.local.get(key);
      return result[key] ?? fallback;
    }
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  },
  async set(key, value) {
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [key]: value });
    else localStorage.setItem(key, JSON.stringify(value));
    if (CLOUD_SYNC_KEYS.includes(key)) scheduleCloudSync();
  }
};

const state = {
  page: 'compose',
  backStack: [],
  columns: [],
  rows: [],
  activeRosterName: '',
  savedRosters: [],
  templates: [],
  structureTemplates: [],
  selectedRosterId: '',
  selectedTemplateId: '',
  selectedStructureTemplateId: '',
  activeTemplateId: '',
  activeStructureTemplateId: '',
  mailBatches: [],
  selectedHistoryBatchId: '',
  selectedHistoryItemId: '',
  emptyDraftEnabled: false,
  connectedEmail: '',
  rememberedEmail: '',
  dataStorageMode: 'local',
  cloudSyncMeta: null,
  attachments: [],
  draftEditAttachments: [],
  draftEditBatchId: ''
};

const sendReviewState = { items: [], approved: new Set(), index: 0, senderEmail: '', method: '', scheduledAt: '', resolve: null };
const WORKSPACE_DRAFT_KEY = 'workspaceDraft';
const DATA_STORAGE_MODE_KEY = 'dataStorageMode';
const CLOUD_SYNC_META_KEY = 'cloudSyncMeta';
const CLOUD_SYNC_KEYS = ['savedRosters', 'templates', 'structureTemplates', WORKSPACE_DRAFT_KEY];
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const launchParams = new URLSearchParams(globalThis.location?.search || '');
const isWindowMode = launchParams.get('mode') === 'window';
const rosterManagerMode = launchParams.get('rosterManager') === '1';
const workspaceProjectId = launchParams.get('projectId') || '';
let workspaceSaveTimer = null;
let restoringWorkspace = false;
let cellSelection = null;
let rosterHistory = [];
let rosterFuture = [];
let cloudSyncTimer = null;
let cloudSyncBusy = false;
let composeInsertionTarget = 'body';
let cloudSyncApplying = false;
let cloudSyncDirty = false;
if (isWindowMode) document.body.classList.add('window-mode');
if (rosterManagerMode) document.body.classList.add('roster-manager-mode');

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const makeId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const columnLetter = (index) => {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
};

let inputDialogResolve = null;
let messageDialogResolve = null;

function closeInputDialog(value = null) {
  const dialog = $('#inputDialog');
  if (dialog.open) dialog.close();
  const resolve = inputDialogResolve;
  inputDialogResolve = null;
  if (resolve) resolve(value);
}

function requestInput({ title, label = '이름', message = '', defaultValue = '', maxLength = 100, options = null }) {
  const dialog = $('#inputDialog');
  const input = $('#inputDialogValue');
  const select = $('#inputDialogSelect');
  const messageElement = $('#inputDialogMessage');
  const errorElement = $('#inputDialogError');

  if (inputDialogResolve) closeInputDialog(null);
  $('#inputDialogTitle').textContent = title;
  $('#inputDialogLabel').textContent = label;
  messageElement.textContent = message;
  messageElement.hidden = !message;
  errorElement.hidden = true;
  errorElement.textContent = '';

  if (Array.isArray(options)) {
    input.hidden = true;
    select.hidden = false;
    select.replaceChildren(...options.map(({ value, text }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      return option;
    }));
    select.value = defaultValue;
  } else {
    select.hidden = true;
    input.hidden = false;
    input.value = defaultValue;
    input.maxLength = maxLength;
  }

  dialog.showModal();
  queueMicrotask(() => {
    const control = Array.isArray(options) ? select : input;
    control.focus();
    if (!Array.isArray(options)) control.select();
  });
  return new Promise((resolve) => { inputDialogResolve = resolve; });
}

function requestTextInput(config) {
  return requestInput(config);
}

function requestColumnRole(defaultValue) {
  return requestInput({
    title: '컬럼 역할 선택',
    label: '역할',
    defaultValue,
    options: [
      { value: 'variable', text: '일반 변수' },
      { value: 'email', text: '수신 이메일' },
      { value: 'excluded', text: '제외' }
    ]
  });
}

function closeMessageDialog(value = false) {
  const dialog = $('#messageDialog');
  if (dialog.open) dialog.close();
  const resolve = messageDialogResolve;
  messageDialogResolve = null;
  if (resolve) resolve(value);
}

function requestMessage({ title = '알림', message = '', confirmText = '확인', cancelText = '' }) {
  if (messageDialogResolve) closeMessageDialog(false);
  $('#messageDialogTitle').textContent = title;
  $('#messageDialogText').textContent = message;
  $('#confirmMessageDialog').textContent = confirmText;
  $('#cancelMessageDialog').textContent = cancelText || '취소';
  $('#cancelMessageDialog').hidden = !cancelText;
  $('#closeMessageDialog').hidden = !cancelText;
  $('#messageDialog').showModal();
  queueMicrotask(() => $('#confirmMessageDialog').focus());
  return new Promise((resolve) => { messageDialogResolve = resolve; });
}

const showAlert = (message, title = '알림') => requestMessage({ title, message });
const showConfirm = (message, title = '확인', confirmText = '확인') => requestMessage({ title, message, confirmText, cancelText: '취소' });

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderAttachments() {
  $('#attachmentList').replaceChildren(...state.attachments.map((file, index) => {
    const row = document.createElement('div');
    row.className = 'attachment-item';
    row.innerHTML = `<span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(formatFileSize(file.size))}</small></span><button class="ghost compact-action" type="button" data-remove-attachment="${index}" aria-label="첨부파일 삭제">×</button>`;
    return row;
  }));
  $('#attachmentHint').textContent = state.attachments.length
    ? `${state.attachments.length}개 · 전체 ${formatFileSize(state.attachments.reduce((sum, file) => sum + file.size, 0))}`
    : '여러 파일을 선택할 수 있습니다. 전체 18MB까지 첨부할 수 있습니다.';
}

async function addAttachments(files) {
  const additions = await readAttachmentFiles(files);
  const total = [...state.attachments, ...additions].reduce((sum, file) => sum + file.size, 0);
  if (total > 18 * 1024 * 1024) {
    await showAlert('첨부파일 전체 크기는 18MB 이하여야 합니다.', '첨부파일 용량 초과');
    return;
  }
  state.attachments.push(...additions);
  renderAttachments();
}

async function readAttachmentFiles(files) {
  const additions = [];
  for (const file of files) {
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    additions.push({ id: makeId(), name: file.name, type: file.type || 'application/octet-stream', size: file.size, data });
  }
  return additions;
}

function renderDraftEditAttachments() {
  $('#draftEditAttachmentList').replaceChildren(...state.draftEditAttachments.map((file, index) => {
    const row = document.createElement('div');
    row.className = 'attachment-item';
    row.innerHTML = `<span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(formatFileSize(file.size || 0))}</small></span><button class="ghost compact-action" type="button" data-remove-draft-edit-attachment="${index}" aria-label="첨부파일 삭제">×</button>`;
    return row;
  }));
  const total = state.draftEditAttachments.reduce((sum, file) => sum + Number(file.size || 0), 0);
  $('#draftEditAttachmentHint').textContent = state.draftEditAttachments.length
    ? `${state.draftEditAttachments.length}개 · 전체 ${formatFileSize(total)}`
    : '첨부파일 없음 · 전체 18MB까지 선택할 수 있습니다.';
}

async function addDraftEditAttachments(files) {
  const additions = await readAttachmentFiles(files);
  const total = [...state.draftEditAttachments, ...additions].reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (total > 18 * 1024 * 1024) {
    await showAlert('첨부파일 전체 크기는 18MB 이하여야 합니다.', '첨부파일 용량 초과');
    return;
  }
  state.draftEditAttachments.push(...additions);
  renderDraftEditAttachments();
}

function showPage(page) {
  closeMenus();
  state.page = page;
  $$('.page').forEach((panel) => panel.classList.toggle('active', panel.dataset.pagePanel === page));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  state.backStack = [];
  $('#backButton').hidden = true;
  resetSubViews();
  if (page === 'history' || page === 'queue') refreshMailActivity();
  scheduleWorkspaceSave();
}

function pushSubView(view) {
  state.backStack.push(view);
  $('#backButton').hidden = false;
}

function resetSubViews() {
  $('#rosterEditor').hidden = false;
  $('#savedRosterList').hidden = true;
  $('#savedRosterDetail').hidden = true;
  $('#templateListView').hidden = false;
  $('#templateDetailView').hidden = true;
  $('#structureTemplateList').hidden = true;
  $('#structureTemplateDetail').hidden = true;
  $('#historyListView').hidden = false;
  $('#historyRecipientsView').hidden = true;
  $('#historyMessageView').hidden = true;
}

function goBack() {
  const current = state.backStack.pop();
  if (current === 'saved-roster-detail') {
    $('#savedRosterDetail').hidden = true;
    $('#savedRosterList').hidden = false;
  } else if (current === 'saved-rosters') {
    $('#savedRosterList').hidden = true;
    $('#rosterEditor').hidden = false;
  } else if (current === 'template-detail') {
    $('#templateDetailView').hidden = true;
    $('#templateListView').hidden = false;
  } else if (current === 'structure-template-detail') {
    $('#structureTemplateDetail').hidden = true;
    $('#structureTemplateList').hidden = false;
  } else if (current === 'structure-templates') {
    $('#structureTemplateList').hidden = true;
    $('#rosterEditor').hidden = false;
  } else if (current === 'history-message') {
    $('#historyMessageView').hidden = true;
    $('#historyRecipientsView').hidden = false;
  } else if (current === 'history-recipients') {
    $('#historyRecipientsView').hidden = true;
    $('#historyListView').hidden = false;
  }
  $('#backButton').hidden = state.backStack.length === 0;
}

function getComposeInput() {
  return {
    columns: state.columns,
    rows: state.rows,
    method: $('#sendMethod').value,
    label: $('#gmailLabel').value,
    scheduleDate: $('#scheduleDate').value,
    scheduleTime: $('#scheduleTime').value,
    subject: $('#subject').value,
    body: $('#body').value,
    postscript: $('#postscript').value,
    emptyDraftEnabled: state.emptyDraftEnabled,
    emptyDraftCount: $('#emptyDraftCount').value
  };
}

function getCurrentWork() {
  return GmailFlowCore.createWorkItems(getComposeInput());
}

function captureWorkspace() {
  return {
    version: 1,
    page: state.page,
    columns: structuredClone(state.columns),
    rows: structuredClone(state.rows),
    activeRosterName: state.activeRosterName,
    activeTemplateId: state.activeTemplateId,
    activeStructureTemplateId: state.activeStructureTemplateId,
    emptyDraftEnabled: state.emptyDraftEnabled,
    compose: {
      sendMethod: $('#sendMethod').value,
      label: $('#gmailLabel').value,
      scheduleDate: $('#scheduleDate').value,
      scheduleTime: $('#scheduleTime').value,
      subject: $('#subject').value,
      body: $('#body').value,
      postscript: $('#postscript').value,
      emptyDraftCount: $('#emptyDraftCount').value
    },
    updatedAt: new Date().toISOString()
  };
}

function scheduleWorkspaceSave() {
  if (restoringWorkspace || rosterManagerMode) return;
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(flushWorkspaceSave, 120);
}

function flushWorkspaceSave() {
  if (restoringWorkspace || rosterManagerMode) return Promise.resolve();
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = null;
  return storage.set(WORKSPACE_DRAFT_KEY, captureWorkspace());
}

async function restoreWorkspace() {
  const saved = await storage.get(WORKSPACE_DRAFT_KEY, null);
  if (!saved?.compose) return;
  restoringWorkspace = true;
  state.page = ['compose', 'roster', 'templates', 'history', 'queue'].includes(saved.page) ? saved.page : 'compose';
  state.columns = Array.isArray(saved.columns) ? saved.columns : [];
  state.rows = Array.isArray(saved.rows) ? saved.rows : [];
  state.activeRosterName = saved.activeRosterName || '';
  state.activeTemplateId = saved.activeTemplateId || '';
  state.activeStructureTemplateId = saved.activeStructureTemplateId || '';
  state.emptyDraftEnabled = Boolean(saved.emptyDraftEnabled);
  $('#sendMethod').value = saved.compose.sendMethod || '임시 저장';
  $('#gmailLabel').value = saved.compose.label || '';
  $('#scheduleDate').value = saved.compose.scheduleDate || '';
  $('#scheduleTime').value = saved.compose.scheduleTime || '09:00';
  $('#subject').value = saved.compose.subject || '';
  $('#body').value = saved.compose.body || '';
  $('#postscript').value = saved.compose.postscript || '';
  $('#emptyDraftCount').value = saved.compose.emptyDraftCount || '1';
  $('#emptyDraftToggle').textContent = state.emptyDraftEnabled ? '－' : '＋';
  $('#emptyDraftToggle').setAttribute('aria-expanded', String(state.emptyDraftEnabled));
  restoringWorkspace = false;
}

async function restoreWorkspaceRoster() {
  if (!rosterManagerMode || !globalThis.gmailFlowDesktop?.loadWorkspaceRoster) return;
  const roster = await globalThis.gmailFlowDesktop.loadWorkspaceRoster(workspaceProjectId);
  state.columns = Array.isArray(roster.columns) ? roster.columns : [];
  state.rows = Array.isArray(roster.rows) ? roster.rows : [];
  state.activeRosterName = roster.projectName ? `${roster.projectName} 명단` : '프로젝트 명단';
  state.page = 'roster';
  $('#useRoster').textContent = '프로젝트에 적용하고 닫기';
  $('#rosterContext').textContent = `${roster.projectName || '현재 프로젝트'}와 연결된 공용 명단`;
}

function renderCloudSyncStatus(message = '') {
  $('#dataStorageMode').value = state.dataStorageMode;
  $('#cloudSyncActions').hidden = state.dataStorageMode !== 'drive';
  $('#cloudSyncStatus').textContent = message || (state.dataStorageMode === 'drive'
    ? `Google Drive 동기화 사용 중${state.cloudSyncMeta?.syncedAt ? ` · ${formatDateTime(state.cloudSyncMeta.syncedAt)}` : ''}`
    : '명단과 템플릿은 이 PC에만 저장됩니다.');
}

function hasLocalSyncData(data) {
  if (data.savedRosters?.length || data.templates?.length || data.structureTemplates?.length) return true;
  const draft = data.workspaceDraft;
  return Boolean(draft?.columns?.length || draft?.rows?.length || draft?.compose?.subject || draft?.compose?.body || draft?.compose?.postscript);
}

function validateCloudSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== 'gmail-flow-cloud-sync' || snapshot.schemaVersion !== 1 || !snapshot.data) {
    throw new Error('Google Drive의 동기화 데이터 형식이 올바르지 않습니다.');
  }
  for (const key of ['savedRosters', 'templates', 'structureTemplates']) {
    if (!Array.isArray(snapshot.data[key])) throw new Error(`동기화 데이터의 ${key} 항목이 손상되었습니다.`);
  }
  return snapshot;
}

async function collectSyncData() {
  return {
    savedRosters: await storage.get('savedRosters', []),
    templates: await storage.get('templates', []),
    structureTemplates: await storage.get('structureTemplates', []),
    workspaceDraft: await storage.get(WORKSPACE_DRAFT_KEY, null)
  };
}

async function createCloudSnapshot() {
  await flushWorkspaceSave();
  return {
    format: 'gmail-flow-cloud-sync',
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    accountEmail: state.connectedEmail,
    data: await collectSyncData()
  };
}

async function saveCloudSyncMeta(file) {
  state.cloudSyncMeta = {
    fileId: file?.id || '',
    modifiedTime: file?.modifiedTime || '',
    syncedAt: new Date().toISOString(),
    accountEmail: state.connectedEmail
  };
  const wasApplying = cloudSyncApplying;
  cloudSyncApplying = true;
  try { await storage.set(CLOUD_SYNC_META_KEY, state.cloudSyncMeta); }
  finally { cloudSyncApplying = wasApplying; }
  cloudSyncDirty = false;
}

async function uploadCloudData({ silent = false } = {}) {
  if (state.dataStorageMode !== 'drive' || !state.connectedEmail || cloudSyncBusy) return null;
  cloudSyncBusy = true;
  if (!silent) renderCloudSyncStatus('Google Drive에 저장하고 있습니다…');
  try {
    const result = await sendRuntimeMessage({ type: 'cloud-sync-upload', snapshot: await createCloudSnapshot() });
    await saveCloudSyncMeta(result.file);
    renderCloudSyncStatus('Google Drive 동기화 완료 · 이 계정으로 다른 PC에서 불러올 수 있습니다.');
    return result;
  } catch (error) {
    renderCloudSyncStatus(`동기화 실패 · ${error.message}`);
    if (!silent) await showAlert(error.message, 'Google Drive 동기화 실패');
    return null;
  } finally {
    cloudSyncBusy = false;
  }
}

function scheduleCloudSync() {
  if (cloudSyncApplying) return;
  cloudSyncDirty = true;
  if (cloudSyncBusy || state.dataStorageMode !== 'drive' || !state.connectedEmail) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => { void uploadCloudData({ silent: true }); }, 1500);
}

async function applyCloudSnapshot(snapshot, file) {
  validateCloudSnapshot(snapshot);
  clearTimeout(cloudSyncTimer);
  restoringWorkspace = true;
  cloudSyncApplying = true;
  try {
    await storage.set('savedRosters', snapshot.data.savedRosters);
    await storage.set('templates', snapshot.data.templates);
    await storage.set('structureTemplates', snapshot.data.structureTemplates);
    await storage.set(WORKSPACE_DRAFT_KEY, snapshot.data.workspaceDraft || null);
    await saveCloudSyncMeta(file);
  } finally {
    cloudSyncApplying = false;
  }
  globalThis.location.reload();
}

async function initializeCloudSync({ interactive = false, firstActivation = false } = {}) {
  if (cloudSyncBusy || state.dataStorageMode !== 'drive') return;
  cloudSyncBusy = true;
  renderCloudSyncStatus(interactive ? 'Google Drive 권한을 확인하고 있습니다…' : 'Google Drive 데이터를 확인하고 있습니다…');
  try {
    if (interactive) await sendRuntimeMessage({ type: 'authorize-drive-sync' });
    if (cloudSyncDirty && !firstActivation) {
      cloudSyncBusy = false;
      await uploadCloudData();
      return;
    }
    const remote = await sendRuntimeMessage({ type: 'cloud-sync-download' });
    const localData = await collectSyncData();
    if (!remote.snapshot) {
      cloudSyncBusy = false;
      await uploadCloudData();
      return;
    }
    validateCloudSnapshot(remote.snapshot);
    const alreadySynced = state.cloudSyncMeta?.accountEmail === state.connectedEmail
      && state.cloudSyncMeta?.fileId === remote.file?.id
      && state.cloudSyncMeta?.modifiedTime === remote.file?.modifiedTime;
    if (alreadySynced) {
      renderCloudSyncStatus();
      return;
    }
    if (firstActivation && hasLocalSyncData(localData)) {
      const choice = await requestInput({
        title: '동기화 데이터 선택',
        label: '처음 사용할 데이터',
        message: '이 PC와 Google Drive에 모두 데이터가 있습니다.',
        defaultValue: 'cloud',
        options: [
          { value: 'cloud', text: 'Google Drive 데이터 사용' },
          { value: 'local', text: '이 PC 데이터를 Drive에 저장' }
        ]
      });
      if (!choice) throw new Error('동기화 설정이 취소되었습니다.');
      if (choice === 'local') {
        cloudSyncBusy = false;
        await uploadCloudData();
        return;
      }
    }
    await applyCloudSnapshot(remote.snapshot, remote.file);
  } catch (error) {
    renderCloudSyncStatus(`동기화 대기 · ${error.message}`);
    if (interactive) await showAlert(error.message, 'Google Drive 동기화');
  } finally {
    cloudSyncBusy = false;
  }
}

function updateComposeState() {
  updateActiveRosterText();
  const method = $('#sendMethod').value;
  const work = getCurrentWork();
  const rosterItems = work.items.filter((item) => item.type === 'roster');
  const recipientCount = rosterItems.filter((item) => item.email).length;
  const blankRowCount = rosterItems.length - recipientCount;
  const emptyCount = work.items.filter((item) => item.type === 'blank').length;

  $('#recipientBadge').textContent = `대상 ${recipientCount}명`;
  $('#labelField').hidden = method === '즉시 발송';
  $('#scheduleField').hidden = method !== '예약 발송';
  $('#emptyDraftControl').hidden = method !== '임시 저장';
  $('#emptyDraftCount').hidden = method !== '임시 저장' || !state.emptyDraftEnabled;

  if (method === '임시 저장') {
    const total = work.items.length;
    $('#composeAction').textContent = total ? `초안 ${total}개 저장` : '임시 저장';
    $('#composeHint').textContent = work.validation.errors[0] || (rosterItems.length
      ? `명단 ${rosterItems.length}행${blankRowCount ? ` 중 이메일 없는 ${blankRowCount}행 포함` : ''}${emptyCount ? ` + 빈 초안 ${emptyCount}개` : ''}`
      : (emptyCount ? `받는 사람 없는 빈 초안 ${emptyCount}개를 만듭니다.` : '명단을 선택하거나 빈 초안 기능을 켜주세요.'));
  } else if (method === '예약 발송') {
    $('#composeAction').textContent = '예약 발송 등록';
    $('#composeHint').textContent = work.validation.errors[0] || `${recipientCount}명에게 예약 발송합니다.`;
  } else {
    $('#composeAction').textContent = '즉시 발송';
    $('#composeHint').textContent = work.validation.errors[0] || `${recipientCount}명에게 지금 바로 발송합니다.`;
  }
  $('#composeHint').classList.toggle('error-text', work.validation.errors.length > 0);
  $('#composeAction').disabled = !work.validation.valid;
  renderComposeVariableStatus();
  scheduleWorkspaceSave();
}

function renderComposeVariableStatus() {
  const available = GmailFlowCore.getVariableNames(state.columns);
  const availableSet = new Set(available);
  const requested = GmailFlowCore.extractVariables($('#subject').value, $('#body').value, $('#postscript').value);
  const palette = $('#composeVariablePalette'); const status = $('#composeVariableStatus');
  palette.replaceChildren(...available.map((name) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'compose-variable-chip valid'; button.dataset.insertVariable = name; button.textContent = `{${name}}`; return button;
  }));
  if (!available.length) palette.innerHTML = '<span class="variable-empty">명단에 컬럼을 만들면 여기에 표시됩니다.</span>';
  status.replaceChildren(...requested.map((name) => {
    const chip = document.createElement('span'); chip.className = `compose-variable-chip ${availableSet.has(name) ? 'valid' : 'invalid'}`; chip.title = availableSet.has(name) ? '존재하는 명단 컬럼' : '명단에 없는 컬럼'; chip.textContent = `{${name}}`; return chip;
  }));
  if (!requested.length) status.innerHTML = '<span class="variable-empty">작성 내용에 사용된 {컬럼}이 없습니다.</span>';
}

function insertComposeVariable(name) {
  const target = $(`#${composeInsertionTarget}`) || $('#body'); const token = `{${name}}`;
  target.focus(); const start = target.selectionStart ?? target.value.length; const end = target.selectionEnd ?? start;
  target.setRangeText(token, start, end, 'end'); target.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderPreviewItem(index) {
  const work = getCurrentWork();
  const item = work.items[index];
  if (!item) return;
  $('#previewMeta').textContent = item.type === 'blank'
    ? `추가 빈 초안 ${index - work.items.filter((entry) => entry.type === 'roster').length + 1}`
    : `명단 ${item.rowNumber}행 · ${item.email || '받는 사람 없음'}`;
  if (state.attachments.length) $('#previewMeta').textContent += ` · 첨부 ${state.attachments.length}개`;
  $('#previewTo').textContent = `받는 사람: ${item.email || '없음'}`;
  $('#previewSubject').textContent = item.subject || '(제목 없음)';
  $('#previewBody').textContent = item.body || '(본문 없음)';
}

async function openPersonalizedPreview() {
  const work = getCurrentWork();
  if (!work.items.length) {
    await showAlert(work.validation.errors[0] || '미리 볼 대상이 없습니다.');
    return;
  }
  const selector = $('#previewRecipient');
  selector.replaceChildren(...work.items.map((item, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = item.type === 'blank'
      ? `빈 초안 ${index - work.items.filter((entry) => entry.type === 'roster').length + 1}`
      : `${item.rowNumber}행 · ${item.email || '받는 사람 없음'}`;
    return option;
  }));
  $('#previewRecipientField').hidden = work.items.length === 1;
  renderPreviewItem(0);
  $('#previewDialog').showModal();
}

function renderRoster() {
  const head = $('#rosterHead');
  const body = $('#rosterBody');
  const letterRow = document.createElement('tr');
  const headerRow = document.createElement('tr');
  const stateLetter = document.createElement('th');
  stateLetter.className = 'row-state-heading';
  stateLetter.title = '행 임시 제외 상태';
  letterRow.append(stateLetter);
  const selectAllCorner = document.createElement('th');
  selectAllCorner.className = 'row-number sheet-selector';
  selectAllCorner.dataset.selectAll = 'true';
  selectAllCorner.tabIndex = 0;
  selectAllCorner.title = '전체 표 선택';
  letterRow.append(selectAllCorner);
  const stateHeader = document.createElement('th');
  stateHeader.className = 'row-state-heading';
  stateHeader.textContent = '상태';
  headerRow.append(stateHeader);
  const headerCorner = document.createElement('th');
  headerCorner.className = 'row-number';
  headerRow.append(headerCorner);

  state.columns.forEach((column, index) => {
    const letter = document.createElement('th');
    letter.textContent = columnLetter(index);
    letter.className = 'sheet-selector column-letter';
    letter.dataset.selectColumn = String(index);
    letter.tabIndex = 0;
    letter.title = `${columnLetter(index)}열 전체 선택`;
    letterRow.append(letter);

    const th = document.createElement('th');
    th.className = 'sheet-grid-cell header-data-cell';
    th.dataset.sheetRow = '-1';
    th.dataset.sheetColumn = String(index);
    th.tabIndex = 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'column-header';
    button.dataset.columnId = column.id;
    button.title = '드래그하여 선택 · 더블클릭하여 컬럼 수정';
    button.textContent = `${column.name}${column.role === 'email' ? ' · 수신 이메일' : ''}`;
    th.append(button);
    headerRow.append(th);
  });

  const plusLetter = document.createElement('th');
  plusLetter.textContent = columnLetter(state.columns.length);
  letterRow.append(plusLetter);
  const plusHeader = document.createElement('th');
  plusHeader.innerHTML = '<button id="addColumn" class="add-column" type="button">＋ 컬럼</button>';
  headerRow.append(plusHeader);
  head.replaceChildren(letterRow, headerRow);

  const visibleRows = Math.max(state.rows.length + 2, 5);
  const fragment = document.createDocumentFragment();
  for (let rowIndex = 0; rowIndex < visibleRows; rowIndex += 1) {
    const tr = document.createElement('tr');
    const row = state.rows[rowIndex];
    const excluded = row?.__workspaceActive === false;
    if (excluded) tr.classList.add('roster-row-excluded');
    const rowState = document.createElement('td');
    rowState.className = 'row-state-cell';
    if (row) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'row-state-toggle';
      toggle.dataset.toggleRosterRow = String(rowIndex);
      toggle.textContent = excluded ? '↺' : '—';
      toggle.title = excluded ? '이 사람을 다시 포함' : '이 사람을 임시 제외';
      toggle.setAttribute('aria-label', toggle.title);
      rowState.append(toggle);
    }
    tr.append(rowState);
    const rowNumber = document.createElement('td');
    rowNumber.className = 'row-number sheet-selector';
    rowNumber.textContent = String(rowIndex + 1);
    rowNumber.dataset.selectRow = String(rowIndex);
    rowNumber.tabIndex = 0;
    rowNumber.title = `${rowIndex + 1}행 전체 선택`;
    tr.append(rowNumber);
    state.columns.forEach((column, columnIndex) => {
      const td = document.createElement('td');
      td.className = 'data-cell';
      td.dataset.rowIndex = String(rowIndex);
      td.dataset.columnIndex = String(columnIndex);
      td.dataset.sheetRow = String(rowIndex);
      td.dataset.sheetColumn = String(columnIndex);
      const input = document.createElement('input');
      input.className = 'cell-input';
      input.dataset.rowIndex = String(rowIndex);
      input.dataset.columnId = column.id;
      input.dataset.columnIndex = String(columnIndex);
      input.setAttribute('aria-label', `${rowIndex + 1}행 ${columnLetter(columnIndex)}열 ${column.name}`);
      input.value = state.rows[rowIndex]?.[column.id] || '';
      td.append(input);
      tr.append(td);
    });
    const trailingCell = document.createElement('td');
    trailingCell.className = 'data-cell';
    if (state.columns.length === 0) {
      const pasteAnchor = document.createElement('input');
      pasteAnchor.className = 'cell-input';
      pasteAnchor.dataset.rowIndex = String(rowIndex);
      pasteAnchor.dataset.columnIndex = '0';
      pasteAnchor.dataset.pasteAnchor = 'true';
      pasteAnchor.setAttribute('aria-label', `${rowIndex + 1}행 A열 붙여넣기`);
      trailingCell.append(pasteAnchor);
    }
    tr.append(trailingCell);
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  updateCellSelection();
  updateRosterStatus();
}

function updateCellSelection() {
  $$('#rosterTable .selected-cell, #rosterTable .selection-anchor, #rosterTable .selected-selector').forEach((cell) => cell.classList.remove('selected-cell', 'selection-anchor', 'selected-selector'));
  if (!cellSelection) return;
  const minRow = Math.min(cellSelection.startRow, cellSelection.endRow);
  const maxRow = Math.max(cellSelection.startRow, cellSelection.endRow);
  const minColumn = Math.min(cellSelection.startColumn, cellSelection.endColumn);
  const maxColumn = Math.max(cellSelection.startColumn, cellSelection.endColumn);
  const singleDataCell = cellSelection.mode === 'cells' && minRow === maxRow && minColumn === maxColumn && minRow >= 0;
  $$('#rosterTable [data-sheet-row][data-sheet-column]').forEach((cell) => {
    const row = Number(cell.dataset.sheetRow);
    const column = Number(cell.dataset.sheetColumn);
    if (!singleDataCell && row >= minRow && row <= maxRow && column >= minColumn && column <= maxColumn) cell.classList.add('selected-cell');
    if (row === cellSelection.startRow && column === cellSelection.startColumn) cell.classList.add('selection-anchor');
  });
  $$('#rosterHead [data-select-column]').forEach((cell) => {
    const column = Number(cell.dataset.selectColumn);
    if (cellSelection.mode === 'column' && column >= minColumn && column <= maxColumn) cell.classList.add('selected-selector');
  });
  $$('#rosterBody [data-select-row]').forEach((cell) => {
    const row = Number(cell.dataset.selectRow);
    if (cellSelection.mode === 'row' && row >= minRow && row <= maxRow) cell.classList.add('selected-selector');
  });
  if (cellSelection.mode === 'all') $('#rosterHead [data-select-all]')?.classList.add('selected-selector');
}

function selectionBounds() {
  if (!cellSelection || !state.columns.length) return null;
  return {
    minRow: Math.max(-1, Math.min(cellSelection.startRow, cellSelection.endRow)),
    maxRow: Math.max(cellSelection.startRow, cellSelection.endRow),
    minColumn: Math.max(0, Math.min(cellSelection.startColumn, cellSelection.endColumn)),
    maxColumn: Math.min(state.columns.length - 1, Math.max(cellSelection.startColumn, cellSelection.endColumn))
  };
}

function isMultiCellSelection() {
  const bounds = selectionBounds();
  return Boolean(bounds && (cellSelection?.mode !== 'cells' || bounds.minRow !== bounds.maxRow || bounds.minColumn !== bounds.maxColumn));
}

function selectedMatrix() {
  const bounds = selectionBounds();
  if (!bounds) return [];
  const matrix = [];
  for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
    matrix.push(Array.from({ length: bounds.maxColumn - bounds.minColumn + 1 }, (_, offset) => {
      const column = state.columns[bounds.minColumn + offset];
      return row === -1 ? column.name : String(state.rows[row]?.[column.id] || '');
    }));
  }
  return matrix;
}

function quoteClipboardCell(value) {
  const text = String(value ?? '');
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function selectedTsv(matrix = selectedMatrix()) {
  return matrix.map((row) => row.map(quoteClipboardCell).join('\t')).join('\r\n');
}

function selectedHtml(matrix = selectedMatrix()) {
  return `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</table>`;
}

function clearSelectedData() {
  const bounds = selectionBounds();
  if (!bounds) return false;
  pushRosterHistory();
  for (let row = Math.max(0, bounds.minRow); row <= bounds.maxRow; row += 1) {
    state.columns.slice(bounds.minColumn, bounds.maxColumn + 1).forEach((column) => {
      if (state.rows[row]) state.rows[row][column.id] = '';
    });
  }
  while (state.rows.length && Object.values(state.rows.at(-1)).every((value) => !String(value || '').trim())) state.rows.pop();
  renderRoster();
  updateComposeState();
  updateRosterStatus('선택한 데이터 셀을 비웠습니다. 컬럼 이름은 유지됩니다.');
  return true;
}

function updateRosterStatus(message = '') {
  const includedCount = state.rows.filter((row) => row.__workspaceActive !== false).length;
  const excludedCount = state.rows.length - includedCount;
  $('#rosterStats').textContent = `컬럼 ${state.columns.length}개 · 포함 ${includedCount}명${excludedCount ? ` · 임시 제외 ${excludedCount}명` : ''}`;
  $('#rosterMessage').textContent = message || (state.columns.length ? '셀·컬럼 헤더·행 번호를 드래그하고 Ctrl+C로 복사할 수 있습니다. 컬럼 수정은 헤더를 더블클릭하세요.' : '첫 컬럼을 추가하거나 표를 붙여넣으세요.');
  const saveRosterButton = $('#saveRoster');
  if (saveRosterButton) saveRosterButton.disabled = state.rows.length === 0;
  const saveStructureButton = $('[data-structure-action="save"]');
  if (saveStructureButton) saveStructureButton.disabled = state.columns.length === 0;
  const saveFilteredButton = $('#saveFilteredRoster');
  if (saveFilteredButton) saveFilteredButton.disabled = includedCount === 0;
  $('#useRoster').disabled = state.rows.length === 0;
  $('#rosterUndo').disabled = rosterHistory.length === 0;
  $('#rosterRedo').disabled = rosterFuture.length === 0;
}

function rosterSnapshot() { return JSON.stringify({ columns: state.columns, rows: state.rows, activeRosterName: state.activeRosterName, activeStructureTemplateId: state.activeStructureTemplateId }); }
function pushRosterHistory() { rosterHistory.push(rosterSnapshot()); if (rosterHistory.length > 80) rosterHistory.shift(); rosterFuture = []; }
function restoreRosterSnapshot(snapshot) { const value = JSON.parse(snapshot); state.columns = value.columns || []; state.rows = value.rows || []; state.activeRosterName = value.activeRosterName || ''; state.activeStructureTemplateId = value.activeStructureTemplateId || ''; cellSelection = null; renderRoster(); updateComposeState(); }
function undoRoster() { if (!rosterHistory.length) return; rosterFuture.push(rosterSnapshot()); restoreRosterSnapshot(rosterHistory.pop()); updateRosterStatus('명단 편집을 실행 취소했습니다.'); }
function redoRoster() { if (!rosterFuture.length) return; rosterHistory.push(rosterSnapshot()); restoreRosterSnapshot(rosterFuture.pop()); updateRosterStatus('명단 편집을 다시 실행했습니다.'); }

function editRosterSelection(action, columnName = '새 컬럼') {
  const bounds = selectionBounds(); if (!bounds && action !== 'insert-row') return false; pushRosterHistory();
  if (action === 'fill-down') {
    for (let col = bounds.minColumn; col <= bounds.maxColumn; col += 1) { const value = state.rows[Math.max(0, bounds.minRow)]?.[state.columns[col].id] || ''; for (let row = Math.max(0, bounds.minRow + 1); row <= bounds.maxRow; row += 1) { while (state.rows.length <= row) state.rows.push({}); state.rows[row][state.columns[col].id] = value; } }
  } else if (action === 'insert-row') state.rows.splice(Math.max(0, bounds?.minRow || 0), 0, {});
  else if (action === 'delete-rows') state.rows.splice(Math.max(0, bounds.minRow), bounds.maxRow - Math.max(0, bounds.minRow) + 1);
  else if (action === 'insert-column') { const index = bounds.minColumn; const column = { id: makeId(), name: columnName, role: 'variable' }; state.columns.splice(index, 0, column); state.rows.forEach((row) => { row[column.id] = ''; }); }
  else if (action === 'delete-columns') { const removed = state.columns.splice(bounds.minColumn, bounds.maxColumn - bounds.minColumn + 1); state.rows.forEach((row) => removed.forEach((column) => delete row[column.id])); }
  cellSelection = null; renderRoster(); updateComposeState(); updateRosterStatus('명단 시트 작업을 적용했습니다.'); return true;
}

function addColumn(name, role = 'variable') {
  const clean = String(name || '').trim().replace(/[{}]/g, '');
  if (!clean) return;
  pushRosterHistory();
  state.columns.push({ id: makeId(), name: clean, role });
  state.activeStructureTemplateId = '';
  renderRoster();
  updateComposeState();
  setTimeout(() => $('#rosterBody .cell-input')?.focus(), 0);
}

function classifyPastedValue(value) {
  const text = String(value || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'email';
  if (/^\+?[\d\s()-]{7,}$/.test(text)) return 'phone';
  if (/^https?:\/\//i.test(text)) return 'url';
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(text)) return 'date';
  if (/^-?[\d,.]+$/.test(text)) return 'number';
  return 'text';
}

function inferVerticalRecords(rows) {
  if (rows.length < 4 || !rows.every((row) => row.length === 1 && String(row[0] || '').trim())) return rows;
  const values = rows.map((row) => String(row[0] || '').trim());
  let best = null;
  for (let width = 2; width <= Math.min(12, Math.floor(values.length / 2)); width += 1) {
    if (values.length % width !== 0) continue;
    const recordCount = values.length / width;
    if (recordCount < 2) continue;
    let matches = 0;
    for (let column = 0; column < width; column += 1) {
      const kinds = Array.from({ length: recordCount }, (_, row) => classifyPastedValue(values[row * width + column]));
      const majority = Math.max(...[...new Set(kinds)].map((kind) => kinds.filter((value) => value === kind).length));
      matches += majority;
    }
    const consistency = matches / values.length;
    const score = consistency + Math.min(recordCount, 5) * 0.01 - width * 0.0001;
    if (consistency >= 0.82 && (!best || score > best.score)) best = { width, recordCount, score };
  }
  if (!best) return rows;

  const records = Array.from({ length: best.recordCount }, (_, rowIndex) =>
    values.slice(rowIndex * best.width, (rowIndex + 1) * best.width));
  let textIndex = 0;
  let emailIndex = 0;
  const headers = Array.from({ length: best.width }, (_, columnIndex) => {
    const columnValues = records.map((record) => record[columnIndex]);
    const kind = classifyPastedValue(columnValues[0]);
    if (kind === 'email') {
      emailIndex += 1;
      const duplicatesEarlierEmail = Array.from({ length: columnIndex }, (_, earlierIndex) => earlierIndex)
        .some((earlierIndex) => records.every((record) => record[earlierIndex] === record[columnIndex] && classifyPastedValue(record[earlierIndex]) === 'email'));
      return duplicatesEarlierEmail ? '아이디' : (emailIndex === 1 ? '이메일' : `이메일${emailIndex}`);
    }
    if (kind === 'phone') return '전화번호';
    if (kind === 'date') return '날짜';
    if (kind === 'url') return '링크';
    if (kind === 'number') return '숫자';
    textIndex += 1;
    return textIndex === 1 ? '이름' : `텍스트${textIndex}`;
  });
  return [headers, ...records];
}

function parseDelimited(text) {
  let normalized = String(text || '').replace(/\r\n?/g, '\n').trimEnd();
  if (!normalized) return [];
  if (!normalized.includes('\t') && !normalized.includes(',') && /\S[ ]{2,}\S/.test(normalized)) {
    normalized = normalized
      .split('\n')
      .map((line) => line.trim().split(/[ ]{2,}/).join('\t'))
      .join('\n');
  }
  const delimiter = normalized.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '"') {
      if (quoted && normalized[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  row.push(cell);
  rows.push(row);
  return inferVerticalRecords(rows);
}

async function readDelimitedFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

function applyTable(matrix, trackHistory = true) {
  if (!matrix.length) return;
  if (trackHistory) pushRosterHistory();
  const width = Math.max(...matrix.map((row) => row.length));
  const first = matrix[0].map((value) => String(value || '').trim());
  const dataLike = (value) => /@|https?:\/\/|^\+?[\d\s()-]{7,}$|^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value);
  const looksLikeHeader = first.filter(Boolean).length === width
    && new Set(first.map((value) => value.toLowerCase())).size === width
    && !first.some(dataLike);
  const headers = looksLikeHeader ? first : Array.from({ length: width }, (_, index) => `컬럼${index + 1}`);
  const dataRows = looksLikeHeader ? matrix.slice(1) : matrix;
  const inferredEmailIndex = dataRows.length
    ? Array.from({ length: width }, (_, index) => dataRows.filter((row) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row[index] || '').trim())).length)
      .findIndex((matches) => matches > 0 && matches >= Math.ceil(dataRows.length / 2))
    : -1;
  state.columns = headers.map((name, index) => ({
    id: makeId(),
    name: inferredEmailIndex === index && !looksLikeHeader ? '이메일' : (name || `컬럼${index + 1}`),
    role: /^(이메일|메일|email|e-mail|email address)$/i.test(name) || inferredEmailIndex === index ? 'email' : 'variable'
  }));
  state.activeRosterName = '';
  state.activeStructureTemplateId = '';
  $('#rosterContext').textContent = '새 명단 · 연결된 명단 템플릿 없음';
  state.rows = dataRows.filter((row) => row.some((value) => String(value || '').trim())).map((row) => {
    const record = {};
    state.columns.forEach((column, index) => { record[column.id] = row[index] || ''; });
    return record;
  });
  renderRoster();
  updateRosterStatus(`${width}열 × ${state.rows.length}행 구조를 자동 생성했습니다.`);
  updateComposeState();
}

function applyMatrixAt(matrix, startRow, startColumn, trackHistory = true) {
  if (!matrix.length) return;
  if (trackHistory) pushRosterHistory();
  const width = Math.max(...matrix.map((row) => row.length));
  while (state.columns.length < startColumn + width) {
    const index = state.columns.length;
    state.columns.push({ id: makeId(), name: `컬럼${index + 1}`, role: 'variable' });
  }
  matrix.forEach((values, rowOffset) => {
    const rowIndex = startRow + rowOffset;
    while (state.rows.length <= rowIndex) state.rows.push({});
    values.forEach((value, columnOffset) => {
      const column = state.columns[startColumn + columnOffset];
      state.rows[rowIndex][column.id] = value;
    });
  });
  if (!state.columns.some((column) => column.role === 'email')) {
    const emailOffset = Array.from({ length: width }, (_, index) => matrix.filter((row) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row[index] || '').trim())).length)
      .findIndex((matches) => matches > 0 && matches >= Math.ceil(matrix.length / 2));
    if (emailOffset >= 0) {
      const emailColumn = state.columns[startColumn + emailOffset];
      emailColumn.role = 'email';
      if (/^컬럼\d+$/.test(emailColumn.name)) emailColumn.name = '이메일';
    }
  }
  while (state.rows.length && Object.values(state.rows.at(-1)).every((value) => !String(value || '').trim())) state.rows.pop();
  renderRoster();
  updateRosterStatus(`${matrix.length}행 × ${width}열을 셀에 붙여넣었습니다.`);
  updateComposeState();
}

async function saveCurrentRoster() {
  const name = await requestTextInput({ title: '명단 저장', label: '명단 이름', defaultValue: state.activeRosterName || '새 명단', maxLength: 100 });
  if (!name?.trim()) return;
  const now = new Date().toISOString();
  const item = {
    id: makeId(),
    name: name.trim(),
    columns: structuredClone(state.columns),
    rows: structuredClone(state.rows),
    linkedTemplateId: state.activeTemplateId,
    linkedStructureTemplateId: state.activeStructureTemplateId,
    createdAt: now,
    updatedAt: now
  };
  state.savedRosters.unshift(item);
  state.activeRosterName = item.name;
  await storage.set('savedRosters', state.savedRosters);
  $('#rosterContext').textContent = `저장된 명단: ${item.name}`;
  updateActiveRosterText();
  renderRosterQuickMenu();
}

async function saveFilteredRoster() {
  const includedRows = state.rows.filter((row) => row.__workspaceActive !== false);
  if (!includedRows.length) return;
  const defaultName = state.activeRosterName ? `${state.activeRosterName} 선별` : '선별 명단';
  const name = await requestTextInput({ title: '선별 명단 저장', label: '새 명단 이름', defaultValue: defaultName, maxLength: 100 });
  if (!name?.trim()) return;
  const now = new Date().toISOString();
  const rows = structuredClone(includedRows).map((row) => ({ ...row, __workspaceActive: true }));
  const item = {
    id: makeId(),
    name: name.trim(),
    columns: structuredClone(state.columns),
    rows,
    linkedTemplateId: state.activeTemplateId,
    linkedStructureTemplateId: state.activeStructureTemplateId,
    createdAt: now,
    updatedAt: now
  };
  state.savedRosters.unshift(item);
  await storage.set('savedRosters', state.savedRosters);
  renderRosterQuickMenu();
  renderSavedRosters();
  updateRosterStatus(`임시 제외 ${state.rows.length - rows.length}명을 뺀 “${item.name}” 명단을 새로 저장했습니다.`);
}

async function syncWorkspaceRoster(message = '') {
  if (!rosterManagerMode || !globalThis.gmailFlowDesktop?.saveWorkspaceRoster) return;
  await globalThis.gmailFlowDesktop.saveWorkspaceRoster(workspaceProjectId, { columns: state.columns, rows: state.rows, name: state.activeRosterName || '현재 명단' });
  if (message) updateRosterStatus(message);
}

function renderSavedRosters() {
  const container = $('#savedRosterItems');
  if (!state.savedRosters.length) {
    container.innerHTML = '<div class="empty-state">저장된 명단이 없습니다.</div>';
    return;
  }
  container.replaceChildren(...state.savedRosters.map((roster) => {
    const button = document.createElement('button');
    button.className = 'list-row';
    button.type = 'button';
    button.dataset.rosterId = roster.id;
    button.innerHTML = `<span>${escapeHtml(roster.name)}</span><span class="muted">${roster.rows.length}명</span>`;
    return button;
  }));
}

function renderRosterQuickMenu() {
  const container = $('#rosterQuickMenu');
  const items = state.savedRosters.slice(0, 5).map((roster) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.quickRosterId = roster.id;
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `<span>${escapeHtml(roster.name)}</span><small>${roster.rows.length}명 · 컬럼 ${roster.columns.length}개</small>`;
    return button;
  });
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'load-submenu-empty';
    empty.textContent = '저장된 명단 없음';
    items.push(empty);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.dataset.rosterAction = 'more';
  more.className = 'load-submenu-command';
  more.textContent = '명단 더보기';
  const save = document.createElement('button');
  save.id = 'saveRoster';
  save.type = 'button';
  save.dataset.rosterAction = 'save';
  save.className = 'load-submenu-command';
  save.textContent = '명단 저장하기';
  save.disabled = state.rows.length === 0;
  container.replaceChildren(...items, more, save);
}

function showRosterDetail(id) {
  const roster = state.savedRosters.find((item) => item.id === id);
  if (!roster) return;
  state.selectedRosterId = id;
  $('#savedRosterList').hidden = true;
  $('#savedRosterDetail').hidden = false;
  $('#savedRosterName').textContent = roster.name;
  $('#savedRosterMeta').textContent = `${roster.rows.length}명 · 컬럼 ${roster.columns.length}개`;
  const linkedTemplate = state.templates.find((template) => template.id === roster.linkedTemplateId);
  $('#savedRosterTemplate').textContent = linkedTemplate ? `연결된 메일 템플릿: ${linkedTemplate.name}` : '연결된 메일 템플릿 없음';
  renderReadOnlyTable($('#savedRosterPreview'), roster.columns, roster.rows.slice(0, 6));
  pushSubView('saved-roster-detail');
}

function loadRosterIntoEditor(roster) {
  if (!roster) return;
  state.columns = structuredClone(roster.columns);
  state.rows = structuredClone(roster.rows);
  state.activeRosterName = roster.name;
  state.activeStructureTemplateId = roster.linkedStructureTemplateId || '';
  const linkedTemplate = state.templates.find((template) => template.id === roster.linkedTemplateId);
  if (linkedTemplate) applyMailTemplate(linkedTemplate); else state.activeTemplateId = '';
  renderRoster();
  renderRosterQuickMenu();
  renderStructureQuickMenu();
  updateActiveRosterText();
  updateComposeState();
  resetSubViews();
  state.backStack = [];
  $('#backButton').hidden = true;
}

function renderReadOnlyTable(table, columns, rows) {
  const head = document.createElement('thead');
  const letters = document.createElement('tr');
  letters.innerHTML = '<th class="row-number"></th>';
  const headers = document.createElement('tr');
  headers.innerHTML = '<th class="row-number"></th>';
  columns.forEach((column, index) => {
    const letter = document.createElement('th'); letter.textContent = columnLetter(index); letters.append(letter);
    const header = document.createElement('th'); header.textContent = column.name; headers.append(header);
  });
  head.append(letters, headers);
  const body = document.createElement('tbody');
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    const number = document.createElement('td'); number.className = 'row-number'; number.textContent = String(index + 1); tr.append(number);
    columns.forEach((column) => { const td = document.createElement('td'); td.textContent = row[column.id] || ''; tr.append(td); });
    body.append(tr);
  });
  table.replaceChildren(head, body);
}

async function saveStructureTemplate() {
  if (!state.columns.length) {
    await showAlert('저장할 컬럼 구조가 없습니다.');
    return;
  }
  const name = await requestTextInput({ title: '명단 템플릿 저장', label: '템플릿 이름', defaultValue: '새 명단 템플릿', maxLength: 100 });
  if (!name?.trim()) return;
  const now = new Date().toISOString();
  const item = { id: makeId(), name: name.trim(), columns: structuredClone(state.columns), createdAt: now, updatedAt: now };
  state.structureTemplates.unshift(item);
  state.activeStructureTemplateId = item.id;
  await storage.set('structureTemplates', state.structureTemplates);
  $('#rosterContext').textContent = `새 명단 · 명단 템플릿: ${item.name}`;
  renderStructureTemplates();
  renderStructureQuickMenu();
}

function renderStructureTemplates() {
  const container = $('#structureTemplateItems');
  if (!state.structureTemplates.length) {
    container.innerHTML = '<div class="empty-state">저장된 명단 템플릿이 없습니다.</div>';
    return;
  }
  container.replaceChildren(...state.structureTemplates.map((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-row';
    button.dataset.structureTemplateId = template.id;
    button.innerHTML = `<span>${escapeHtml(template.name)}</span><span class="muted">컬럼 ${template.columns.length}개</span>`;
    return button;
  }));
}

function renderStructureQuickMenu() {
  const container = $('#structureQuickMenu');
  const items = state.structureTemplates.slice(0, 5).map((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.quickStructureId = template.id;
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `<span>${escapeHtml(template.name)}</span><small>컬럼 ${template.columns.length}개</small>`;
    return button;
  });
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'load-submenu-empty';
    empty.textContent = '저장된 구조 없음';
    items.push(empty);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.dataset.structureAction = 'more';
  more.className = 'load-submenu-command';
  more.textContent = '구조 더보기';
  const save = document.createElement('button');
  save.type = 'button';
  save.dataset.structureAction = 'save';
  save.className = 'load-submenu-command';
  save.textContent = '구조 저장하기';
  save.disabled = state.columns.length === 0;
  container.replaceChildren(...items, more, save);
}

function showStructureTemplateDetail(id) {
  const template = state.structureTemplates.find((item) => item.id === id);
  if (!template) return;
  state.selectedStructureTemplateId = id;
  $('#structureTemplateList').hidden = true;
  $('#structureTemplateDetail').hidden = false;
  $('#structureTemplateName').textContent = template.name;
  $('#structureTemplateMeta').textContent = `컬럼 ${template.columns.length}개`;
  renderReadOnlyTable($('#structureTemplatePreview'), template.columns, []);
  pushSubView('structure-template-detail');
}

function applyStructureToEditor(template) {
  if (!template) return;
  state.columns = structuredClone(template.columns);
  state.rows = [];
  state.activeRosterName = '';
  state.activeStructureTemplateId = template.id;
  $('#rosterContext').textContent = `새 명단 · 명단 템플릿: ${template.name}`;
  renderRoster();
  renderRosterQuickMenu();
  renderStructureQuickMenu();
  updateComposeState();
  resetSubViews();
  state.backStack = [];
  $('#backButton').hidden = true;
}

function applyMailTemplate(template) {
  if (!template) return;
  state.activeTemplateId = template.id;
  $('#subject').value = template.subject || '';
  $('#body').value = template.body || '';
  $('#postscript').value = template.postscript || '';
  $('#gmailLabel').value = template.label || '';
  $('#sendMethod').value = template.sendMethod || '임시 저장';
  updateComposeState();
}

function updateActiveRosterText() {
  const variables = state.columns
    .filter((column) => column.role !== 'excluded' && column.name)
    .map((column) => column.name.trim());
  const variableText = variables.map((name) => `{${name}}`).join(', ');
  const primary = state.activeRosterName || (state.columns.length ? '편집 중인 명단' : '명단 미선택');
  const secondary = state.columns.length
    ? `${state.rows.length}명${variableText ? ` · ${variableText}` : ''}`
    : '명단을 선택하면 변수가 표시됩니다';
  const primaryText = document.createElement('strong');
  const secondaryText = document.createElement('small');
  primaryText.textContent = primary;
  secondaryText.textContent = secondary;
  $('#activeRosterText').replaceChildren(primaryText, secondaryText);
  $('#subject').placeholder = variableText
    ? `사용 가능: ${variableText}`
    : '명단 컬럼을 만든 뒤 변수를 사용할 수 있습니다';
  $('#body').placeholder = variableText
    ? `본문에 ${variableText} 형식으로 입력하세요`
    : '현재 사용할 수 있는 변수가 없습니다';
  $('#postscript').placeholder = variableText
    ? `추신에도 ${variableText} 형식으로 사용할 수 있습니다`
    : '본문 뒤에 빈 줄을 두고 추가됩니다';
}

function renderTemplates() {
  const container = $('#templateItems');
  if (!state.templates.length) {
    container.innerHTML = '<div class="empty-state">저장된 템플릿이 없습니다.</div>';
    return;
  }
  container.replaceChildren(...getTemplatesNewestFirst().map((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-row';
    button.dataset.templateId = template.id;
    button.innerHTML = `<span>${escapeHtml(template.name)}</span><span class="muted">상세 보기</span>`;
    return button;
  }));
}

function getTemplatesNewestFirst() {
  return [...state.templates].sort((a, b) => {
    const bTime = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    const aTime = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    return bTime - aTime;
  });
}

function renderQuickTemplateMenu() {
  const container = $('#quickTemplateList');
  const templates = getTemplatesNewestFirst();
  if (!templates.length) {
    container.innerHTML = '<div class="template-quick-empty">저장된 템플릿이 없습니다.</div>';
    return;
  }
  container.replaceChildren(...templates.map((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.quickTemplateId = template.id;
    button.setAttribute('role', 'menuitem');
    const savedAt = formatDateTime(template.updatedAt || template.createdAt);
    button.innerHTML = `<span>${escapeHtml(template.name)}</span><small>${escapeHtml(savedAt || '저장됨')}</small>`;
    return button;
  }));
}

async function saveTemplate() {
  const name = await requestTextInput({ title: '메일 템플릿 저장', label: '템플릿 이름', defaultValue: '새 템플릿', maxLength: 50 });
  if (!name?.trim()) return;
  if (name.trim().length > 50) { await showAlert('템플릿 이름은 50자 이하여야 합니다.'); return; }
  if (!$('#subject').value.trim() && !$('#body').value.trim() && !$('#postscript').value.trim()) { await showAlert('제목, 본문, 추신 중 하나는 입력해야 합니다.'); return; }
  const template = { id: makeId(), name: name.trim(), subject: $('#subject').value, body: $('#body').value, postscript: $('#postscript').value, label: $('#gmailLabel').value, sendMethod: $('#sendMethod').value, createdAt: new Date().toISOString() };
  state.templates.unshift(template);
  state.activeTemplateId = template.id;
  await storage.set('templates', state.templates);
  renderTemplates();
  renderQuickTemplateMenu();
}

function showTemplateDetail(id) {
  const template = state.templates.find((item) => item.id === id);
  if (!template) return;
  state.selectedTemplateId = id;
  $('#templateListView').hidden = true;
  $('#templateDetailView').hidden = false;
  $('#templateDetailName').textContent = template.name;
  $('#templateDetailMeta').textContent = `${template.sendMethod || '임시 저장'} · ${template.label ? `라벨 ${template.label}` : '라벨 없음'}`;
  $('#templateDetailSubject').textContent = template.subject || '(제목 없음)';
  $('#templateDetailBody').textContent = [template.body, template.postscript].filter((value) => String(value || '').trim()).join('\n\n') || '(본문 없음)';
  pushSubView('template-detail');
}

const STATUS_TEXT = { queued: '대기', processing: '처리 중', canceling: '취소 중', scheduled: '예약 대기', 'waiting-auth': 'Gmail 연결 필요', completed: '완료', failed: '실패', canceled: '취소' };

function statusText(status) { return STATUS_TEXT[status] || status || '대기'; }

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

async function sendRuntimeMessage(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('확장 프로그램을 새로고침한 뒤 다시 시도해주세요.');
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '백그라운드 작업에 실패했습니다.');
  return response.data;
}

async function refreshMailActivity() {
  state.mailBatches = await storage.get('mailBatches', []);
  renderHistory();
  renderQueue();
  renderOperationStatus();
}

function batchProgress(batch) {
  return batch.items.filter((item) => ['completed', 'failed', 'canceled', 'scheduled'].includes(item.status)).length;
}

function renderOperationStatus() {
  const panel = $('#operationStatus');
  const batch = state.mailBatches.find((item) => !['completed', 'failed', 'canceled'].includes(item.status));
  if (!batch) { panel.hidden = true; return; }
  const processed = batchProgress(batch);
  const total = batch.total || batch.items.length || 1;
  const current = batch.items.find((item) => item.id === batch.currentItemId);
  const recipient = current ? (current.variables?.이름 || current.email || '받는 사람 없음') : '';
  $('#operationStatusTitle').textContent = `${batch.method} · ${statusText(batch.status)}`;
  $('#operationStatusText').textContent = `${processed}/${total}${recipient ? ` · ${recipient} 처리 중` : ''}`;
  $('#operationProgress').max = total;
  $('#operationProgress').value = processed;
  panel.hidden = false;
}

function renderHistory() {
  const container = $('#historyItems');
  if (!state.mailBatches.length) {
    container.innerHTML = '<div class="empty-state">아직 저장된 작업 기록이 없습니다.</div>';
    return;
  }
  container.replaceChildren(...state.mailBatches.map((batch) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-row';
    button.dataset.historyBatchId = batch.id;
    button.title = '클릭하여 대상별 기록 보기';
    button.innerHTML = `<span>${escapeHtml(batch.name)}<br><small class="muted">${escapeHtml(formatDateTime(batch.createdAt))} · ${escapeHtml(batch.method)}</small></span><span class="badge">${escapeHtml(statusText(batch.status))} ${batch.completed || 0}/${batch.total || batch.items.length}</span>`;
    return button;
  }));
}

function renderQueue() {
  const container = $('#queueItems');
  const active = state.mailBatches.filter((batch) => !['completed', 'failed', 'canceled'].includes(batch.status));
  if (!active.length) {
    container.innerHTML = '<div class="empty-state">대기 중인 작업이 없습니다.</div>';
    return;
  }
  container.replaceChildren(...active.map((batch) => {
    const row = document.createElement('div');
    row.className = 'list-row queue-entry';
    const processed = batchProgress(batch);
    const total = batch.total || batch.items.length;
    const current = batch.items.find((item) => item.id === batch.currentItemId);
    const currentText = current ? ` · ${current.variables?.이름 || current.email || '대상'} 처리 중` : '';
    row.innerHTML = `<span class="queue-summary"><strong>${escapeHtml(batch.name)}</strong><small class="muted">${escapeHtml(statusText(batch.status))} · ${processed}/${total}${escapeHtml(currentText)}${batch.scheduledAt ? ` · ${escapeHtml(formatDateTime(batch.scheduledAt))}` : ''}</small><progress max="${total || 1}" value="${processed}"></progress></span><button class="button danger compact-action" type="button" data-cancel-batch-id="${escapeHtml(batch.id)}">취소</button>`;
    return row;
  }));
}

function inferLegacyTemplate(value, variables = {}) {
  let template = String(value || '');
  Object.entries(variables)
    .filter(([, replacement]) => String(replacement || ''))
    .sort((a, b) => String(b[1]).length - String(a[1]).length)
    .forEach(([name, replacement]) => {
      template = template.split(String(replacement)).join(`{{${name}}}`);
    });
  return template;
}

function renderDraftEditProgress() {
  const historyBatch = state.mailBatches.find((entry) => entry.id === state.selectedHistoryBatchId);
  const edit = historyBatch?.draftEdit;
  const text = edit
    ? `${edit.status === 'processing' ? '수정 중' : edit.status === 'waiting-auth' ? 'Google 재연결 필요' : '수정 완료'} · ${edit.processed || 0}/${edit.total || 0} · 성공 ${edit.updated || 0} · 제외 ${edit.skipped || 0} · 실패 ${edit.failed || 0}`
    : '';
  const historyStatus = $('#historyDraftEditStatus');
  historyStatus.hidden = !edit;
  if (edit) {
    historyStatus.querySelector('span').textContent = text;
    historyStatus.querySelector('progress').max = edit.total || 1;
    historyStatus.querySelector('progress').value = edit.processed || 0;
  }
  const dialogStatus = $('#draftEditProgress');
  const dialogOpen = $('#draftEditDialog').open;
  const dialogBatch = state.mailBatches.find((entry) => entry.id === state.draftEditBatchId);
  const dialogEdit = dialogBatch?.draftEdit;
  dialogStatus.hidden = !dialogEdit || !dialogOpen;
  if (dialogEdit && dialogOpen) {
    dialogStatus.querySelector('span').textContent = `${dialogEdit.status === 'processing' ? '수정 중' : dialogEdit.status === 'waiting-auth' ? 'Google 재연결 필요' : '수정 완료'} · ${dialogEdit.processed || 0}/${dialogEdit.total || 0} · 성공 ${dialogEdit.updated || 0} · 제외 ${dialogEdit.skipped || 0} · 실패 ${dialogEdit.failed || 0}`;
    dialogStatus.querySelector('progress').max = dialogEdit.total || 1;
    dialogStatus.querySelector('progress').value = dialogEdit.processed || 0;
  }
}

function externalDraftStateText(item) {
  if (item.externalDraftState === 'modified') return 'Gmail에서 수정됨';
  if (item.externalDraftState === 'missing') return '삭제됨/발송됨';
  return statusText(item.status);
}

async function refreshDraftBatchStatus(batchId, { showErrors = false } = {}) {
  const button = $('#refreshDraftStatus');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '확인 중';
  try {
    await sendRuntimeMessage({ type: 'check-draft-batch-status', batchId });
    await refreshMailActivity();
    if (state.selectedHistoryBatchId === batchId && !$('#historyRecipientsView').hidden) {
      showHistoryBatch(batchId, { push: false, checkStatus: false });
    }
  } catch (error) {
    if (showErrors) await showAlert(error.message, 'Gmail 상태 확인 실패');
  } finally {
    button.disabled = false;
    button.textContent = 'Gmail 상태 확인';
  }
}

function openDraftBatchEditor() {
  const batch = state.mailBatches.find((entry) => entry.id === state.selectedHistoryBatchId);
  if (!batch || batch.method !== '임시 저장') return;
  const first = batch.items.find((item) => item.draftId) || batch.items[0];
  if (!first) return;
  state.draftEditBatchId = batch.id;
  state.draftEditAttachments = [...(batch.attachments || [])];
  $('#draftEditSubject').value = batch.subjectTemplate ?? inferLegacyTemplate(first.subject, first.variables);
  $('#draftEditBody').value = batch.bodyTemplate ?? inferLegacyTemplate(first.body, first.variables);
  $('#draftEditPostscript').value = batch.postscriptTemplate || '';
  const variables = [...new Set(batch.items.flatMap((item) => Object.keys(item.variables || {})))];
  $('#draftEditSummary').textContent = `${batch.items.filter((item) => item.draftId).length}개 초안 · 사용 가능 변수 ${variables.length ? variables.map((name) => `{{${name}}}`).join(', ') : '없음'}`;
  renderDraftEditAttachments();
  renderDraftEditProgress();
  $('#confirmDraftEdit').disabled = false;
  $('#confirmDraftEdit').textContent = '모든 초안 수정';
  $('#draftEditDialog').showModal();
  renderDraftEditProgress();
  queueMicrotask(() => $('#draftEditSubject').focus());
}

function showHistoryBatch(id, { push = true, checkStatus = true } = {}) {
  const batch = state.mailBatches.find((item) => item.id === id);
  if (!batch) return;
  state.selectedHistoryBatchId = id;
  $('#historyListView').hidden = true;
  $('#historyRecipientsView').hidden = false;
  $('#historyBatchName').textContent = batch.name;
  const draftSummary = batch.draftStatusSummary;
  const draftStatusText = draftSummary
    ? ` · Gmail 확인 ${formatDateTime(draftSummary.checkedAt)}${draftSummary.modified ? ` · 수정됨 ${draftSummary.modified}` : ''}${draftSummary.missing ? ` · 삭제/발송 ${draftSummary.missing}` : ''}`
    : '';
  $('#historyBatchMeta').textContent = `${formatDateTime(batch.createdAt)} · ${batch.method} · ${statusText(batch.status)} ${batch.completed || 0}/${batch.total || batch.items.length}${batch.attachments?.length ? ` · 첨부 ${batch.attachments.length}개` : ''}${draftStatusText}`;
  $('#editDraftBatch').hidden = batch.method !== '임시 저장' || !batch.items.some((item) => item.draftId);
  $('#refreshDraftStatus').hidden = batch.method !== '임시 저장' || !batch.items.some((item) => item.draftId);
  renderDraftEditProgress();
  $('#historyRecipients').replaceChildren(...batch.items.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-row';
    button.dataset.historyItemId = item.id;
    const recipient = getHistoryRecipient(item);
    const displayName = item.variables?.이름 || recipient || (item.type === 'blank' ? `빈 초안 ${index + 1}` : `데이터 ${index + 1}`);
    const externalClass = item.externalDraftState === 'modified' ? ' external-modified' : item.externalDraftState === 'missing' ? ' external-missing' : '';
    button.innerHTML = `<span>${escapeHtml(displayName)}<br><small class="muted">${escapeHtml(recipient || '받는 사람 없음')}</small></span><span class="badge${externalClass}">${escapeHtml(externalDraftStateText(item))}</span>`;
    return button;
  }));
  if (push) pushSubView('history-recipients');
  const checkedAt = new Date(batch.draftStatusCheckedAt || '').getTime();
  const stale = !Number.isFinite(checkedAt) || Date.now() - checkedAt > 2 * 60 * 1000;
  if (checkStatus && batch.method === '임시 저장' && stale) queueMicrotask(() => refreshDraftBatchStatus(batch.id));
}

function getHistoryRecipient(item) {
  if (item.email) return item.email;
  return Object.entries(item.variables || {}).find(([name, value]) => /^(이메일|메일|email|e-mail|email address)$/i.test(name.trim()) && GmailFlowCore.isValidEmail(value))?.[1] || '';
}

function buildGmailAccountUrl(senderEmail, mailbox, gmailId) {
  const email = String(senderEmail || '').trim();
  const gmailUrl = `https://mail.google.com/mail/u/${email ? `?authuser=${encodeURIComponent(email)}` : ''}#${mailbox}/${encodeURIComponent(gmailId)}`;
  if (!email) return gmailUrl;
  return `https://accounts.google.com/AccountChooser?service=mail&Email=${encodeURIComponent(email)}&continue=${encodeURIComponent(gmailUrl)}`;
}

async function openGoogleUrl(url) {
  if (globalThis.gmailFlowDesktop?.openGoogleUrl) return globalThis.gmailFlowDesktop.openGoogleUrl(url);
  const opened = globalThis.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) throw new Error('브라우저 창을 열 수 없습니다. 팝업 허용 상태를 확인해주세요.');
  return { browser: 'default' };
}

function showHistoryMessage(itemId) {
  const batch = state.mailBatches.find((entry) => entry.id === state.selectedHistoryBatchId);
  const item = batch?.items.find((entry) => entry.id === itemId);
  if (!batch || !item) return;
  state.selectedHistoryItemId = itemId;
  $('#historyRecipientsView').hidden = true;
  $('#historyMessageView').hidden = false;
  const recipient = getHistoryRecipient(item);
  $('#historyMessageMeta').textContent = formatDateTime(item.updatedAt);
  $('#historyMessageStatus').textContent = externalDraftStateText(item);
  $('#historyMessageSubject').textContent = item.subject || '(제목 없음)';
  $('#historyMessageSender').textContent = batch.senderEmail ? `나 <${batch.senderEmail}>` : '나';
  $('#historyMessageRecipient').textContent = `받는 사람: ${recipient || '없음'}`;
  $('#historyMessageBody').textContent = item.body || '(본문 없음)';
  const attachmentBlock = $('#historyMessageAttachmentsBlock');
  const attachments = item.attachments || batch.attachments || [];
  attachmentBlock.hidden = attachments.length === 0;
  $('#historyMessageAttachments').replaceChildren(...attachments.map((attachment) => {
    const chip = document.createElement('span');
    chip.textContent = `${attachment.name} · ${formatFileSize(attachment.size || 0)}`;
    return chip;
  }));
  const isDraft = batch.method === '임시 저장' || item.status === 'scheduled';
  const gmailId = isDraft ? (item.threadId || item.draftId) : (item.threadId || item.messageId);
  const gmailLink = $('#historyMessageGmailLink');
  gmailLink.hidden = !gmailId || item.externalDraftState === 'missing';
  gmailLink.textContent = `${isDraft ? 'Gmail에서 임시메일 열기' : 'Gmail에서 메일 열기'}${batch.senderEmail ? ` · ${batch.senderEmail}` : ''}`;
  gmailLink.href = gmailId ? buildGmailAccountUrl(batch.senderEmail, isDraft ? 'drafts' : 'sent', gmailId) : '';
  gmailLink.dataset.accountEmail = batch.senderEmail || '';
  const historyError = item.draftEditError || item.error || '';
  $('#historyMessageErrorBlock').hidden = !historyError;
  $('#historyMessageError').textContent = historyError;
  pushSubView('history-message');
}

function renderSendReviewItem() {
  const item = sendReviewState.items[sendReviewState.index];
  if (!item) return;
  $('#sendReviewRecipient').value = String(sendReviewState.index);
  $('#sendReviewProgress').textContent = `${sendReviewState.approved.size}/${sendReviewState.items.length}명 확인 · ${sendReviewState.index + 1}/${sendReviewState.items.length}${state.attachments.length ? ` · 첨부 ${state.attachments.length}개` : ''}`;
  $('#sendReviewSubject').textContent = item.subject || '(제목 없음)';
  $('#sendReviewSender').textContent = sendReviewState.senderEmail ? `나 <${sendReviewState.senderEmail}>` : '나';
  $('#sendReviewTo').textContent = `받는 사람: ${item.email || '없음'}`;
  $('#sendReviewBody').textContent = item.body || '(본문 없음)';
  $('#sendReviewApproved').checked = sendReviewState.approved.has(sendReviewState.index);
  $('#previousSendReview').disabled = sendReviewState.index === 0;
  $('#nextSendReview').disabled = sendReviewState.index >= sendReviewState.items.length - 1;
  $('#confirmSendReview').disabled = sendReviewState.approved.size !== sendReviewState.items.length;
}

function finishSendReview(approved) {
  const resolve = sendReviewState.resolve;
  sendReviewState.resolve = null;
  if ($('#sendReviewDialog').open) $('#sendReviewDialog').close();
  resolve?.(approved);
}

function openSendReview(items, method, scheduledAt, senderEmail) {
  sendReviewState.items = items;
  sendReviewState.approved = new Set();
  sendReviewState.index = 0;
  sendReviewState.senderEmail = senderEmail;
  sendReviewState.method = method;
  sendReviewState.scheduledAt = scheduledAt;
  $('#sendReviewTitle').textContent = method === '예약 발송' ? '예약 발송 최종 확인' : '즉시 발송 최종 확인';
  $('#sendReviewRecipient').replaceChildren(...items.map((item, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${index + 1}. ${item.variables?.이름 || item.email} · ${item.email}`;
    return option;
  }));
  renderSendReviewItem();
  $('#sendReviewDialog').showModal();
  return new Promise((resolve) => { sendReviewState.resolve = resolve; });
}

function accountInitial(email) {
  return email ? email.trim().charAt(0).toUpperCase() : 'G';
}

async function updateConnectionStatus() {
  const status = await sendRuntimeMessage({ type: 'connection-status' });
  state.connectedEmail = status.connected ? status.email || '' : '';
  state.rememberedEmail = status.rememberedEmail || status.email || state.rememberedEmail || '';
  $('#oauthSetupHelp').hidden = status.configured;
  $('#connectGmail').hidden = status.connected || !status.configured;
  $('#switchGmail').hidden = !status.connected;
  $('#disconnectGmail').hidden = !status.connected;
  $('#accountAvatar').textContent = accountInitial(state.connectedEmail);
  $('#accountSummaryAvatar').textContent = accountInitial(state.connectedEmail);
  $('#accountAvatar').classList.toggle('disconnected', !status.connected);
  $('#accountSummaryAvatar').classList.toggle('disconnected', !status.connected);
  $('#accountButtonText').textContent = status.connected ? (status.email || '연결됨') : 'Google 계정';
  $('#accountSummaryEmail').textContent = status.connected ? (status.email || 'Google 계정') : '연결된 계정 없음';
  $('#gmailConnectionStatus').textContent = !status.configured
    ? 'OAuth 클라이언트 ID 설정이 필요합니다.'
    : (status.connected ? 'Gmail 발송 권한이 연결되어 있습니다.' : 'Google 계정을 연결해 주세요.');
  if (state.dataStorageMode === 'drive' && !status.connected) renderCloudSyncStatus('Google Drive 동기화를 계속하려면 Google 계정을 연결해주세요.');
  return status;
}

async function requestGmailConnection({ switchAccount = false } = {}) {
  const buttons = [$('#connectGmail'), $('#switchGmail')];
  let connected = false;
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (switchAccount) await chrome.identity.clearAllCachedAuthTokens();
    const scopes = state.dataStorageMode === 'drive' ? [GMAIL_SCOPE, DRIVE_APPDATA_SCOPE] : [GMAIL_SCOPE];
    const result = await chrome.identity.getAuthToken({
      interactive: true,
      scopes,
      loginHint: switchAccount ? '' : state.rememberedEmail,
      selectAccount: switchAccount
    });
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new Error('Gmail 인증 토큰을 받지 못했습니다.');
    await sendRuntimeMessage({ type: 'resume-after-auth' });
    await updateConnectionStatus();
    await refreshMailActivity();
    connected = true;
  } catch (error) {
    await showAlert(error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
  return connected;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function closeMenus() {
  $$('details[open]').forEach((details) => { details.open = false; });
}

function bindEvents() {
  $('#inputDialogForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const control = $('#inputDialogSelect').hidden ? $('#inputDialogValue') : $('#inputDialogSelect');
    const value = control.value;
    if (!String(value || '').trim()) {
      $('#inputDialogError').textContent = '값을 입력해주세요.';
      $('#inputDialogError').hidden = false;
      control.focus();
      return;
    }
    closeInputDialog(value);
  });
  $('#cancelInputDialog').addEventListener('click', () => closeInputDialog(null));
  $('#cancelInputDialogTop').addEventListener('click', () => closeInputDialog(null));
  $('#inputDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeInputDialog(null); });
  $('#messageDialogForm').addEventListener('submit', (event) => { event.preventDefault(); closeMessageDialog(true); });
  $('#cancelMessageDialog').addEventListener('click', () => closeMessageDialog(false));
  $('#closeMessageDialog').addEventListener('click', () => closeMessageDialog(false));
  $('#messageDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeMessageDialog(false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flushWorkspaceSave(); });
  globalThis.addEventListener('pagehide', () => { void flushWorkspaceSave(); });
  document.addEventListener('click', (event) => {
    const clickedMenu = event.target.closest('details.menu');
    $$('details.menu[open]').forEach((menu) => {
      if (menu !== clickedMenu) menu.open = false;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenus();
      if (cellSelection) { cellSelection = null; updateCellSelection(); }
      return;
    }
    const activeInSheet = $('#rosterTable').contains(document.activeElement);
    if (state.page !== 'roster' || !activeInSheet) return;
    const editingCell = document.activeElement.matches('.cell-input');
    if ((event.key === 'Delete' || event.key === 'Backspace') && cellSelection && (!editingCell || isMultiCellSelection())) {
      event.preventDefault();
      clearSelectedData();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && (!editingCell || isMultiCellSelection())) {
      event.preventDefault(); event.shiftKey ? redoRoster() : undoRoster();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y' && (!editingCell || isMultiCellSelection())) {
      event.preventDefault(); redoRoster();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !document.activeElement.matches('.cell-input')) {
      event.preventDefault();
      cellSelection = {
        startRow: -1, endRow: Math.max(-1, state.rows.length - 1),
        startColumn: 0, endColumn: Math.max(0, state.columns.length - 1), dragging: false, mode: 'all'
      };
      updateCellSelection();
    }
  });
  document.addEventListener('copy', (event) => {
    if (state.page !== 'roster' || !cellSelection || !$('#rosterTable').contains(document.activeElement)) return;
    const active = document.activeElement;
    const bounds = selectionBounds();
    const singleDataCell = bounds && bounds.minRow === bounds.maxRow && bounds.minColumn === bounds.maxColumn && bounds.minRow >= 0;
    if (singleDataCell && active.matches('.cell-input') && active.selectionStart !== active.selectionEnd) return;
    const matrix = selectedMatrix();
    if (!matrix.length) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', selectedTsv(matrix));
    event.clipboardData.setData('text/html', selectedHtml(matrix));
    updateRosterStatus(`선택 영역 ${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
  });
  document.addEventListener('cut', (event) => {
    if (state.page !== 'roster' || !cellSelection || !$('#rosterTable').contains(document.activeElement)) return;
    const active = document.activeElement;
    if (active.matches('.cell-input') && !isMultiCellSelection() && active.selectionStart !== active.selectionEnd) return;
    const matrix = selectedMatrix();
    if (!matrix.length) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', selectedTsv(matrix));
    event.clipboardData.setData('text/html', selectedHtml(matrix));
    clearSelectedData();
  });
  document.addEventListener('paste', (event) => {
    if (state.page !== 'roster' || !cellSelection || !$('#rosterTable').contains(document.activeElement)) return;
    const bounds = selectionBounds(); const text = event.clipboardData?.getData('text/plain') || '';
    if (!bounds || !text) return;
    const matrix = parseDelimited(text); if (!matrix.length) return;
    if (document.activeElement.matches('.cell-input') && !isMultiCellSelection() && matrix.length === 1 && matrix[0].length === 1) return;
    event.preventDefault(); event.stopPropagation();
    const singleValue = matrix.length === 1 && matrix[0].length === 1;
    if (singleValue && (bounds.maxRow > bounds.minRow || bounds.maxColumn > bounds.minColumn)) {
      pushRosterHistory();
      for (let row = Math.max(0, bounds.minRow); row <= bounds.maxRow; row += 1) for (let col = bounds.minColumn; col <= bounds.maxColumn; col += 1) {
        while (state.rows.length <= row) state.rows.push({}); state.rows[row][state.columns[col].id] = matrix[0][0];
      }
      renderRoster(); updateComposeState(); updateRosterStatus('선택한 모든 셀에 값을 붙여넣었습니다.');
    } else if (!state.columns.length && bounds.minRow <= 0) applyTable(matrix);
    else applyMatrixAt(matrix, Math.max(0, bounds.minRow), bounds.minColumn);
  }, true);
  $('#drawerToggle').addEventListener('click', () => {
    $('#app').classList.toggle('drawer-open');
    const open = $('#app').classList.contains('drawer-open');
    $('#drawerToggle').textContent = open ? '≪' : '≫';
  });
  if (globalThis.gmailFlowDesktop) {
    $('#openWindowButton').hidden = true;
    if (new URLSearchParams(globalThis.location.search).get('workspace') === '1') {
      $('#openWorkspaceButton').hidden = false;
      $('#openWorkspaceButton').addEventListener('click', () => globalThis.gmailFlowDesktop.openWorkspace());
    }
  } else {
    $('#openWindowButton').addEventListener('click', async () => {
      $('#openWindowButton').disabled = true;
      try {
        await storage.set(WORKSPACE_DRAFT_KEY, captureWorkspace());
        await chrome.windows.create({
          url: chrome.runtime.getURL('popup.html?mode=window'),
          type: 'popup',
          width: 920,
          height: 760,
          focused: true
        });
        globalThis.close();
      } catch (error) {
        await showAlert(`창을 열지 못했습니다. ${error.message}`);
        $('#openWindowButton').disabled = false;
      }
    });
  }
  $('#backButton').addEventListener('click', goBack);
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => showPage(item.dataset.page)));
  $('#sendMethod').addEventListener('change', updateComposeState);
  ['gmailLabel', 'scheduleDate', 'scheduleTime', 'subject', 'body', 'postscript'].forEach((id) => {
    $(`#${id}`).addEventListener('input', updateComposeState);
  });
  ['subject', 'body', 'postscript'].forEach((id) => $(`#${id}`).addEventListener('focus', () => { composeInsertionTarget = id; }));
  $('#composeVariablePalette').addEventListener('click', (event) => { const button = event.target.closest('[data-insert-variable]'); if (button) insertComposeVariable(button.dataset.insertVariable); });
  $('#emptyDraftToggle').addEventListener('click', () => {
    state.emptyDraftEnabled = !state.emptyDraftEnabled;
    $('#emptyDraftToggle').textContent = state.emptyDraftEnabled ? '－' : '＋';
    $('#emptyDraftToggle').setAttribute('aria-expanded', String(state.emptyDraftEnabled));
    updateComposeState();
  });
  $('#emptyDraftCount').addEventListener('input', updateComposeState);
  $('#attachmentInput').addEventListener('change', async (event) => {
    await addAttachments([...(event.target.files || [])]);
    event.target.value = '';
  });
  $('#attachmentList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-attachment]');
    if (!button) return;
    state.attachments.splice(Number(button.dataset.removeAttachment), 1);
    renderAttachments();
  });
  $('#draftEditAttachmentInput').addEventListener('change', async (event) => {
    await addDraftEditAttachments([...(event.target.files || [])]);
    event.target.value = '';
  });
  $('#draftEditAttachmentList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-draft-edit-attachment]');
    if (!button) return;
    state.draftEditAttachments.splice(Number(button.dataset.removeDraftEditAttachment), 1);
    renderDraftEditAttachments();
  });
  $('#previewButton').addEventListener('click', openPersonalizedPreview);
  $('#previewRecipient').addEventListener('change', (event) => renderPreviewItem(Number(event.target.value)));
  $('#sendReviewRecipient').addEventListener('change', (event) => { sendReviewState.index = Number(event.target.value); renderSendReviewItem(); });
  $('#sendReviewApproved').addEventListener('change', (event) => {
    if (event.target.checked) sendReviewState.approved.add(sendReviewState.index);
    else sendReviewState.approved.delete(sendReviewState.index);
    renderSendReviewItem();
  });
  $('#previousSendReview').addEventListener('click', () => { if (sendReviewState.index > 0) { sendReviewState.index -= 1; renderSendReviewItem(); } });
  $('#nextSendReview').addEventListener('click', () => { if (sendReviewState.index < sendReviewState.items.length - 1) { sendReviewState.index += 1; renderSendReviewItem(); } });
  $('#confirmSendReview').addEventListener('click', () => { if (sendReviewState.approved.size === sendReviewState.items.length) finishSendReview(true); });
  $('#cancelSendReview').addEventListener('click', () => finishSendReview(false));
  $('#cancelSendReviewTop').addEventListener('click', () => finishSendReview(false));
  $('#sendReviewDialog').addEventListener('cancel', (event) => { event.preventDefault(); finishSendReview(false); });
  $('#composeAction').addEventListener('click', async () => {
    const work = getCurrentWork();
    if (!work.validation.valid) { await showAlert(work.validation.errors.join('\n')); return; }
    const method = $('#sendMethod').value;
    const count = work.items.length;
    const connection = await sendRuntimeMessage({ type: 'connection-status' });
    if (!connection.configured || !connection.connected) {
      await showAlert(connection.configured ? '먼저 설정에서 Gmail 계정을 연결해주세요.' : '먼저 manifest.json에 Google OAuth 클라이언트 ID를 설정해주세요.');
      $('#settingsDialog').showModal();
      await updateConnectionStatus();
      return;
    }
    const rechecked = getCurrentWork();
    if (!rechecked.validation.valid || rechecked.items.length !== count || $('#sendMethod').value !== method) {
      await showAlert('확인 중 명단이나 발송 설정이 변경되었습니다. 다시 확인해주세요.');
      updateComposeState();
      return;
    }
    const scheduledAt = method === '예약 발송' ? new Date(`${$('#scheduleDate').value}T${$('#scheduleTime').value}`).toISOString() : '';
    if (method === '임시 저장') {
      if (!await showConfirm(`${count}개의 Gmail 초안을 생성할까요?`, '초안 생성 확인', '생성')) return;
    } else {
      const firstWarning = method === '예약 발송'
        ? `예약 발송 형식입니다.\n${count}명에게 ${formatDateTime(scheduledAt)}에 발송하시겠습니까?`
        : `즉시 발송 형식입니다.\n${count}명에게 지금 바로 발송하시겠습니까?`;
      if (!await showConfirm(firstWarning, '발송 확인', method === '예약 발송' ? '예약' : '계속')) return;
      const individuallyApproved = await openSendReview(rechecked.items, method, scheduledAt, connection.email || '');
      if (!individuallyApproved) return;
    }
    $('#composeAction').disabled = true;
    try {
      const batch = await sendRuntimeMessage({
        type: 'enqueue-mail-batch',
        payload: {
          name: $('#gmailLabel').value.trim() || $('#subject').value.trim() || method,
          method,
          label: $('#gmailLabel').value,
          subject: $('#subject').value,
          subjectTemplate: $('#subject').value,
          bodyTemplate: $('#body').value,
          postscriptTemplate: $('#postscript').value,
          scheduledAt,
          senderEmail: connection.email || '',
          attachments: state.attachments,
          items: rechecked.items
        }
      });
      await refreshMailActivity();
      state.attachments = [];
      renderAttachments();
      await showAlert(`${batch.name} 작업이 등록되었습니다.\n현재 상태: ${statusText(batch.status)}`);
      showPage(method === '예약 발송' ? 'queue' : 'history');
    } catch (error) {
      await showAlert(error.message);
    } finally {
      updateComposeState();
    }
  });
  $('#saveMailTemplate').addEventListener('click', async () => { closeMenus(); await saveTemplate(); });
  $('#loadMailTemplate').addEventListener('click', () => { closeMenus(); showPage('templates'); });
  $('#quickTemplateList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-quick-template-id]');
    if (!button) return;
    const template = state.templates.find((item) => item.id === button.dataset.quickTemplateId);
    if (!template) return;
    applyMailTemplate(template);
    closeMenus();
  });
  $('#rosterQuickMenu').addEventListener('click', async (event) => {
    const rosterButton = event.target.closest('[data-quick-roster-id]');
    if (rosterButton) {
      loadRosterIntoEditor(state.savedRosters.find((item) => item.id === rosterButton.dataset.quickRosterId));
      closeMenus();
      return;
    }
    const action = event.target.closest('[data-roster-action]')?.dataset.rosterAction;
    if (action === 'more') {
      closeMenus(); renderSavedRosters(); $('#rosterEditor').hidden = true; $('#savedRosterList').hidden = false; pushSubView('saved-rosters');
    } else if (action === 'save') {
      closeMenus(); await saveCurrentRoster();
    }
  });
  $('#structureQuickMenu').addEventListener('click', async (event) => {
    const structureButton = event.target.closest('[data-quick-structure-id]');
    if (structureButton) {
      applyStructureToEditor(state.structureTemplates.find((item) => item.id === structureButton.dataset.quickStructureId));
      closeMenus();
      return;
    }
    const action = event.target.closest('[data-structure-action]')?.dataset.structureAction;
    if (action === 'more') {
      closeMenus(); renderStructureTemplates(); $('#rosterEditor').hidden = true; $('#structureTemplateList').hidden = false; pushSubView('structure-templates');
    } else if (action === 'save') {
      closeMenus(); await saveStructureTemplate();
    }
  });
  $('#pasteTable').addEventListener('click', () => { closeMenus(); $('#pasteBox').hidden = false; $('#pasteInput').focus(); });
  $('#cancelPaste').addEventListener('click', () => { $('#pasteBox').hidden = true; $('#pasteInput').value = ''; });
  $('#applyPaste').addEventListener('click', () => { applyTable(parseDelimited($('#pasteInput').value)); $('#pasteBox').hidden = true; });
  $('#fileInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      applyTable(parseDelimited(await readDelimitedFile(file)));
    } catch (error) {
      await showAlert(`파일을 읽지 못했습니다. ${error.message}`, 'CSV 불러오기 실패');
    }
    closeMenus(); event.target.value = '';
  });
  $('#resetRoster').addEventListener('click', async () => { closeMenus(); if (!await showConfirm('현재 명단 편집 내용을 초기화할까요?', '명단 초기화', '초기화')) return; pushRosterHistory(); state.columns = []; state.rows = []; cellSelection = null; state.activeRosterName = ''; state.activeStructureTemplateId = ''; $('#rosterContext').textContent = '새 명단 · 연결된 명단 템플릿 없음'; renderRoster(); updateActiveRosterText(); updateComposeState(); queueMicrotask(() => $('#addColumn')?.focus()); });
  $('#rosterUndo').addEventListener('click', undoRoster);
  $('#rosterRedo').addEventListener('click', redoRoster);
  $('#rosterClearSelection').addEventListener('click', () => { closeMenus(); clearSelectedData(); });
  $('#rosterFillDown').addEventListener('click', () => { closeMenus(); editRosterSelection('fill-down'); });
  $('#rosterInsertRow').addEventListener('click', () => { closeMenus(); editRosterSelection('insert-row'); });
  $('#rosterDeleteRows').addEventListener('click', () => { closeMenus(); editRosterSelection('delete-rows'); });
  $('#rosterInsertColumn').addEventListener('click', async () => { closeMenus(); const name = await requestTextInput({ title: '컬럼 삽입', label: '컬럼 이름', defaultValue: '새 컬럼', maxLength: 100 }); if (name?.trim()) editRosterSelection('insert-column', name.trim()); });
  $('#rosterDeleteColumns').addEventListener('click', () => { closeMenus(); editRosterSelection('delete-columns'); });
  $('#saveFilteredRoster').addEventListener('click', saveFilteredRoster);
  $('#useRoster').addEventListener('click', async () => {
    state.activeRosterName ||= '현재 명단'; updateActiveRosterText(); updateComposeState();
    if (!rosterManagerMode) { showPage('compose'); return; }
    try {
      $('#useRoster').disabled = true; $('#useRoster').textContent = '프로젝트에 적용 중…';
      await globalThis.gmailFlowDesktop.saveWorkspaceRoster(workspaceProjectId, { columns: state.columns, rows: state.rows, name: state.activeRosterName });
      await globalThis.gmailFlowDesktop.openWorkspace();
      await globalThis.gmailFlowDesktop.closeWindow();
    } catch (error) {
      $('#useRoster').disabled = false; $('#useRoster').textContent = '프로젝트에 적용하고 닫기';
      await showAlert(error.message, '명단을 저장하지 못했습니다');
    }
  });
  $('#rosterHead').addEventListener('click', async (event) => {
    if (event.target.id === 'addColumn') {
      const name = await requestTextInput({ title: '컬럼 추가', label: '컬럼 이름', defaultValue: '이름', maxLength: 100 });
      if (name?.trim()) addColumn(name);
    }
  });
  $('#rosterHead').addEventListener('dblclick', async (event) => {
    const button = event.target.closest('.column-header');
    if (!button) return;
    const column = state.columns.find((item) => item.id === button.dataset.columnId);
    if (!column) return;
    const name = await requestTextInput({ title: '컬럼 수정', label: '컬럼 이름', defaultValue: column.name, maxLength: 100 });
    if (!name?.trim()) return;
    const role = await requestColumnRole(column.role);
    if (!role) return;
    pushRosterHistory();
    column.name = name.trim().replace(/[{}]/g, '');
    if (role === 'email') {
      state.columns.forEach((item) => { if (item.id !== column.id && item.role === 'email') item.role = 'variable'; });
    }
    column.role = role;
    state.activeStructureTemplateId = '';
    renderRoster(); updateComposeState();
  });
  $('#rosterTable').addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('#addColumn')) return;
    const gridCell = event.target.closest('[data-sheet-row][data-sheet-column]');
    const columnSelector = event.target.closest('[data-select-column]');
    const rowSelector = event.target.closest('[data-select-row]');
    const allSelector = event.target.closest('[data-select-all]');
    if (!gridCell && !columnSelector && !rowSelector && !allSelector) return;

    let startRow;
    let endRow;
    let startColumn;
    let endColumn;
    let mode = 'cells';
    if (columnSelector) {
      startRow = -1;
      endRow = Math.max(-1, state.rows.length - 1);
      startColumn = endColumn = Number(columnSelector.dataset.selectColumn);
      mode = 'column';
    } else if (rowSelector) {
      startRow = endRow = Number(rowSelector.dataset.selectRow);
      startColumn = 0;
      endColumn = Math.max(0, state.columns.length - 1);
      mode = 'row';
    } else if (allSelector) {
      startRow = -1;
      endRow = Math.max(-1, state.rows.length - 1);
      startColumn = 0;
      endColumn = Math.max(0, state.columns.length - 1);
      mode = 'all';
    } else {
      startRow = endRow = Number(gridCell.dataset.sheetRow);
      startColumn = endColumn = Number(gridCell.dataset.sheetColumn);
    }
    if (event.shiftKey && cellSelection && mode === 'cells') {
      cellSelection.endRow = endRow;
      cellSelection.endColumn = endColumn;
      cellSelection.dragging = true;
    } else {
      cellSelection = { startRow, endRow, startColumn, endColumn, dragging: true, mode };
    }
    updateCellSelection();

    const input = event.target.closest('.cell-input') || gridCell?.querySelector('.cell-input');
    const focusTarget = input || event.target.closest('[tabindex]') || gridCell;
    if (input) {
      // Let Chromium place the text caret at the exact clicked character.
    } else if (focusTarget && document.activeElement !== focusTarget) {
      event.preventDefault();
      focusTarget.focus({ preventScroll: true });
    } else {
      event.preventDefault();
    }
  });
  $('#rosterTable').addEventListener('mousemove', (event) => {
    if (!cellSelection?.dragging || !(event.buttons & 1)) return;
    const gridCell = event.target.closest('[data-sheet-row][data-sheet-column]');
    const columnSelector = event.target.closest('[data-select-column]');
    const rowSelector = event.target.closest('[data-select-row]');
    if (cellSelection.mode === 'column' && columnSelector) {
      cellSelection.endColumn = Number(columnSelector.dataset.selectColumn);
    } else if (cellSelection.mode === 'row' && rowSelector) {
      cellSelection.endRow = Number(rowSelector.dataset.selectRow);
    } else if (cellSelection.mode === 'cells' && gridCell) {
      cellSelection.endRow = Number(gridCell.dataset.sheetRow);
      cellSelection.endColumn = Number(gridCell.dataset.sheetColumn);
    } else return;
    event.preventDefault();
    updateCellSelection();
  });
  globalThis.addEventListener('mouseup', () => { if (cellSelection) cellSelection.dragging = false; });
  $('#rosterBody').addEventListener('input', (event) => {
    const input = event.target.closest('.cell-input');
    if (!input) return;
    const rowIndex = Number(input.dataset.rowIndex);
    while (state.rows.length <= rowIndex) state.rows.push({});
    state.rows[rowIndex][input.dataset.columnId] = input.value;
    while (state.rows.length && Object.values(state.rows.at(-1)).every((value) => !String(value || '').trim())) state.rows.pop();
    updateRosterStatus(); updateComposeState();
  });
  $('#rosterBody').addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-toggle-roster-row]');
    if (!toggle) return;
    const rowIndex = Number(toggle.dataset.toggleRosterRow);
    const row = state.rows[rowIndex];
    if (!row) return;
    const snapshot = rosterSnapshot();
    pushRosterHistory();
    row.__workspaceActive = row.__workspaceActive === false;
    const excluded = row.__workspaceActive === false;
    renderRoster(); updateComposeState();
    try {
      await syncWorkspaceRoster(excluded ? `${rowIndex + 1}행을 임시 제외해 프로젝트에 반영했습니다.` : `${rowIndex + 1}행을 복원해 프로젝트에 반영했습니다.`);
      if (!rosterManagerMode) updateRosterStatus(excluded ? `${rowIndex + 1}행을 임시 제외했습니다.` : `${rowIndex + 1}행을 다시 포함했습니다.`);
    } catch (error) {
      restoreRosterSnapshot(snapshot);
      await showAlert(error.message, '명단 상태를 반영하지 못했습니다');
    }
  });
  $('#rosterBody').addEventListener('focusin', (event) => { const input = event.target.closest('.cell-input'); if (input) input.dataset.beforeRosterEdit = rosterSnapshot(); });
  $('#rosterBody').addEventListener('change', (event) => { const input = event.target.closest('.cell-input'); if (!input?.dataset.beforeRosterEdit) return; rosterHistory.push(input.dataset.beforeRosterEdit); if (rosterHistory.length > 80) rosterHistory.shift(); rosterFuture = []; delete input.dataset.beforeRosterEdit; updateRosterStatus(); });
  $('#rosterBody').addEventListener('paste', (event) => {
    if (event.defaultPrevented) return;
    const input = event.target.closest('.cell-input');
    if (!input) return;
    const text = event.clipboardData?.getData('text/plain') || '';
    const matrix = parseDelimited(text);
    const isStructured = matrix.length > 1 || matrix.some((row) => row.length > 1);
    if (!isStructured) return;
    event.preventDefault();
    const rowIndex = Number(input.dataset.rowIndex) || 0;
    const columnIndex = Number(input.dataset.columnIndex) || 0;
    if (input.dataset.pasteAnchor === 'true' && state.columns.length === 0 && rowIndex === 0) applyTable(matrix);
    else applyMatrixAt(matrix, rowIndex, columnIndex);
  });
  $('#savedRosterItems').addEventListener('click', (event) => { const button = event.target.closest('[data-roster-id]'); if (button) showRosterDetail(button.dataset.rosterId); });
  $('#loadSelectedRoster').addEventListener('click', () => {
    const roster = state.savedRosters.find((item) => item.id === state.selectedRosterId);
    loadRosterIntoEditor(roster);
  });
  $('#renameRoster').addEventListener('click', async () => {
    const roster = state.savedRosters.find((item) => item.id === state.selectedRosterId); if (!roster) return;
    const name = await requestTextInput({ title: '명단 이름 변경', label: '명단 이름', defaultValue: roster.name, maxLength: 100 }); if (!name?.trim()) return;
    roster.name = name.trim(); roster.updatedAt = new Date().toISOString(); await storage.set('savedRosters', state.savedRosters); renderRosterQuickMenu(); showRosterDetail(roster.id); state.backStack.pop();
  });
  $('#deleteRoster').addEventListener('click', async () => {
    const roster = state.savedRosters.find((item) => item.id === state.selectedRosterId); if (!roster || !await showConfirm(`“${roster.name}” 명단을 삭제할까요?`, '명단 삭제', '삭제')) return;
    state.savedRosters = state.savedRosters.filter((item) => item.id !== roster.id); await storage.set('savedRosters', state.savedRosters); renderSavedRosters(); renderRosterQuickMenu(); $('#savedRosterDetail').hidden = true; $('#savedRosterList').hidden = false; state.backStack.pop();
  });
  $('#templateItems').addEventListener('click', (event) => { const button = event.target.closest('[data-template-id]'); if (button) showTemplateDetail(button.dataset.templateId); });
  $('#applyTemplate').addEventListener('click', () => {
    const template = state.templates.find((item) => item.id === state.selectedTemplateId); if (!template) return;
    applyMailTemplate(template); showPage('compose');
  });
  $('#renameTemplate').addEventListener('click', async () => {
    const template = state.templates.find((item) => item.id === state.selectedTemplateId); if (!template) return;
    const name = await requestTextInput({ title: '메일 템플릿 이름 변경', label: '템플릿 이름', defaultValue: template.name, maxLength: 50 }); if (!name?.trim() || name.trim().length > 50) return;
    template.name = name.trim(); template.updatedAt = new Date().toISOString(); await storage.set('templates', state.templates); renderTemplates(); renderQuickTemplateMenu(); showTemplateDetail(template.id); state.backStack.pop();
  });
  $('#deleteTemplate').addEventListener('click', async () => {
    const template = state.templates.find((item) => item.id === state.selectedTemplateId); if (!template || !await showConfirm(`“${template.name}” 템플릿을 삭제할까요?`, '템플릿 삭제', '삭제')) return;
    state.templates = state.templates.filter((item) => item.id !== template.id);
    if (state.activeTemplateId === template.id) state.activeTemplateId = '';
    await storage.set('templates', state.templates); renderTemplates(); renderQuickTemplateMenu(); $('#templateDetailView').hidden = true; $('#templateListView').hidden = false; state.backStack.pop();
  });
  $('#structureTemplateItems').addEventListener('click', (event) => {
    const button = event.target.closest('[data-structure-template-id]'); if (button) showStructureTemplateDetail(button.dataset.structureTemplateId);
  });
  $('#applyStructureTemplate').addEventListener('click', () => {
    const template = state.structureTemplates.find((item) => item.id === state.selectedStructureTemplateId); if (!template) return;
    applyStructureToEditor(template);
  });
  $('#renameStructureTemplate').addEventListener('click', async () => {
    const template = state.structureTemplates.find((item) => item.id === state.selectedStructureTemplateId); if (!template) return;
    const name = await requestTextInput({ title: '명단 템플릿 이름 변경', label: '템플릿 이름', defaultValue: template.name, maxLength: 100 }); if (!name?.trim()) return;
    template.name = name.trim(); template.updatedAt = new Date().toISOString(); await storage.set('structureTemplates', state.structureTemplates); renderStructureTemplates(); renderStructureQuickMenu(); showStructureTemplateDetail(template.id); state.backStack.pop();
  });
  $('#deleteStructureTemplate').addEventListener('click', async () => {
    const template = state.structureTemplates.find((item) => item.id === state.selectedStructureTemplateId); if (!template || !await showConfirm(`“${template.name}” 명단 템플릿을 삭제할까요?`, '명단 템플릿 삭제', '삭제')) return;
    state.structureTemplates = state.structureTemplates.filter((item) => item.id !== template.id);
    if (state.activeStructureTemplateId === template.id) state.activeStructureTemplateId = '';
    await storage.set('structureTemplates', state.structureTemplates); renderStructureTemplates(); renderStructureQuickMenu(); $('#structureTemplateDetail').hidden = true; $('#structureTemplateList').hidden = false; state.backStack.pop();
  });
  $('#accountButton').addEventListener('click', async () => {
    $('#settingsDialog').showModal();
    renderCloudSyncStatus();
    try { await updateConnectionStatus(); } catch (error) { $('#gmailConnectionStatus').textContent = error.message; }
  });
  $('#dataStorageMode').addEventListener('change', async (event) => {
    const requestedMode = event.target.value;
    if (requestedMode === 'local') {
      clearTimeout(cloudSyncTimer);
      state.dataStorageMode = 'local';
      await storage.set(DATA_STORAGE_MODE_KEY, 'local');
      renderCloudSyncStatus('이 PC에만 저장하도록 변경했습니다. 내려받은 데이터는 이 PC에 유지됩니다.');
      return;
    }
    state.dataStorageMode = 'drive';
    await storage.set(DATA_STORAGE_MODE_KEY, 'drive');
    renderCloudSyncStatus('Google Drive 동기화를 준비하고 있습니다…');
    if (!state.connectedEmail) {
      const connected = await requestGmailConnection();
      if (!connected) {
        state.dataStorageMode = 'local';
        await storage.set(DATA_STORAGE_MODE_KEY, 'local');
        renderCloudSyncStatus();
        return;
      }
    }
    await initializeCloudSync({ interactive: true, firstActivation: true });
  });
  $('#syncCloudNow').addEventListener('click', async () => {
    if (!state.connectedEmail) {
      const connected = await requestGmailConnection();
      if (!connected) return;
    }
    await initializeCloudSync({ interactive: true });
  });
  $('#connectGmail').addEventListener('click', () => requestGmailConnection());
  $('#switchGmail').addEventListener('click', () => requestGmailConnection({ switchAccount: true }));
  $('#disconnectGmail').addEventListener('click', async () => {
    if (!await showConfirm('Google 계정에서 로그아웃할까요? 예약 작업은 다시 연결할 때까지 대기합니다.', 'Google 계정 로그아웃', '로그아웃')) return;
    await chrome.identity.clearAllCachedAuthTokens();
    await updateConnectionStatus();
  });
  $('#historyItems').addEventListener('click', (event) => {
    const button = event.target.closest('[data-history-batch-id]'); if (button) showHistoryBatch(button.dataset.historyBatchId);
  });
  $('#historyRecipients').addEventListener('click', (event) => {
    const button = event.target.closest('[data-history-item-id]'); if (button) showHistoryMessage(button.dataset.historyItemId);
  });
  $('#historyMessageGmailLink').addEventListener('click', async (event) => {
    event.preventDefault();
    const link = event.currentTarget;
    if (!link.href) return;
    link.setAttribute('aria-busy', 'true');
    try {
      await openGoogleUrl(link.href);
      link.title = link.dataset.accountEmail
        ? `${link.dataset.accountEmail} 계정 선택 화면을 거쳐 Chrome에서 엽니다.`
        : 'Chrome에서 Gmail을 엽니다.';
    } catch (error) {
      await showAlert(error.message, 'Gmail 열기 실패');
    } finally {
      link.removeAttribute('aria-busy');
    }
  });
  $('#editDraftBatch').addEventListener('click', openDraftBatchEditor);
  $('#refreshDraftStatus').addEventListener('click', () => {
    if (state.selectedHistoryBatchId) refreshDraftBatchStatus(state.selectedHistoryBatchId, { showErrors: true });
  });
  const closeDraftEditor = () => { if ($('#draftEditDialog').open) $('#draftEditDialog').close(); };
  $('#closeDraftEdit').addEventListener('click', closeDraftEditor);
  $('#cancelDraftEdit').addEventListener('click', closeDraftEditor);
  $('#draftEditDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDraftEditor(); });
  $('#draftEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const batch = state.mailBatches.find((entry) => entry.id === state.draftEditBatchId);
    if (!batch) { await showAlert('수정할 작업 기록을 찾을 수 없습니다.'); return; }
    const count = batch.items.filter((item) => item.draftId).length;
    if (!await showConfirm(`${count}개의 Gmail 초안을 현재 내용으로 일괄 수정할까요?\nGmail에서 직접 고친 내용도 덮어씁니다.`, '임시메일 일괄 수정', '수정')) return;
    const button = $('#confirmDraftEdit');
    button.disabled = true;
    button.textContent = '수정 준비 중';
    try {
      const connection = await sendRuntimeMessage({ type: 'connection-status' });
      if (!connection.connected) throw new Error('먼저 Google 계정을 다시 연결해주세요.');
      const result = await sendRuntimeMessage({
        type: 'update-draft-batch',
        batchId: batch.id,
        payload: {
          subjectTemplate: $('#draftEditSubject').value,
          bodyTemplate: $('#draftEditBody').value,
          postscriptTemplate: $('#draftEditPostscript').value,
          attachments: state.draftEditAttachments
        }
      });
      await refreshMailActivity();
      renderDraftEditProgress();
      closeDraftEditor();
      showHistoryBatch(batch.id, { push: false });
      await showAlert(`초안 수정을 마쳤습니다.\n성공 ${result.updated}개 · 제외 ${result.skipped}개 · 실패 ${result.failed}개`, '일괄 수정 완료');
    } catch (error) {
      await refreshMailActivity();
      renderDraftEditProgress();
      await showAlert(error.message, '일괄 수정 실패');
    } finally {
      button.disabled = false;
      button.textContent = '모든 초안 수정';
    }
  });
  $('#deleteHistoryBatch').addEventListener('click', async () => {
    const batch = state.mailBatches.find((item) => item.id === state.selectedHistoryBatchId); if (!batch || !await showConfirm(`“${batch.name}” 기록을 삭제할까요?`, '기록 삭제', '삭제')) return;
    try {
      await sendRuntimeMessage({ type: 'delete-mail-batch', batchId: batch.id });
      await refreshMailActivity(); $('#historyRecipientsView').hidden = true; $('#historyListView').hidden = false; state.backStack.pop(); $('#backButton').hidden = state.backStack.length === 0;
    } catch (error) { await showAlert(error.message); }
  });
  $('#queueItems').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-cancel-batch-id]'); if (!button) return;
    const batch = state.mailBatches.find((item) => item.id === button.dataset.cancelBatchId); if (!batch || !await showConfirm(`“${batch.name}” 작업을 취소할까요?`, '작업 취소', '취소하기')) return;
    try { await sendRuntimeMessage({ type: 'cancel-mail-batch', batchId: batch.id }); await refreshMailActivity(); }
    catch (error) { await showAlert(error.message); }
  });
  if (globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.mailBatches) refreshMailActivity().then(renderDraftEditProgress);
  });
}

async function init() {
  state.savedRosters = await storage.get('savedRosters', []);
  state.templates = await storage.get('templates', []);
  state.structureTemplates = await storage.get('structureTemplates', []);
  state.mailBatches = await storage.get('mailBatches', []);
  state.dataStorageMode = await storage.get(DATA_STORAGE_MODE_KEY, 'local') === 'drive' ? 'drive' : 'local';
  state.cloudSyncMeta = await storage.get(CLOUD_SYNC_META_KEY, null);
  await restoreWorkspace();
  await restoreWorkspaceRoster();
  restoringWorkspace = true;
  bindEvents();
  renderRoster();
  renderSavedRosters();
  renderRosterQuickMenu();
  renderTemplates();
  renderQuickTemplateMenu();
  renderStructureTemplates();
  renderStructureQuickMenu();
  renderHistory();
  renderQueue();
  renderOperationStatus();
  renderAttachments();
  renderCloudSyncStatus();
  updateComposeState();
  showPage(rosterManagerMode ? 'roster' : state.page);
  restoringWorkspace = false;
  try {
    const connection = await updateConnectionStatus();
    if (connection.connected && state.dataStorageMode === 'drive') await initializeCloudSync();
  } catch (_) {}
}

init();
