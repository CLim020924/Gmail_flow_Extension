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
    if (globalThis.chrome?.storage?.local) return chrome.storage.local.set({ [key]: value });
    localStorage.setItem(key, JSON.stringify(value));
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
  connectedEmail: ''
};

const sendReviewState = { items: [], approved: new Set(), index: 0, senderEmail: '', method: '', scheduledAt: '', resolve: null };
const WORKSPACE_DRAFT_KEY = 'workspaceDraft';
const isWindowMode = new URLSearchParams(globalThis.location?.search || '').get('mode') === 'window';
let workspaceSaveTimer = null;
let restoringWorkspace = false;
if (isWindowMode) document.body.classList.add('window-mode');

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
  if (restoringWorkspace) return;
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(flushWorkspaceSave, 120);
}

function flushWorkspaceSave() {
  if (restoringWorkspace) return Promise.resolve();
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
  scheduleWorkspaceSave();
}

function renderPreviewItem(index) {
  const work = getCurrentWork();
  const item = work.items[index];
  if (!item) return;
  $('#previewMeta').textContent = item.type === 'blank'
    ? `추가 빈 초안 ${index - work.items.filter((entry) => entry.type === 'roster').length + 1}`
    : `명단 ${item.rowNumber}행 · ${item.email || '받는 사람 없음'}`;
  $('#previewTo').textContent = `받는 사람: ${item.email || '없음'}`;
  $('#previewSubject').textContent = item.subject || '(제목 없음)';
  $('#previewBody').textContent = item.body || '(본문 없음)';
}

function openPersonalizedPreview() {
  const work = getCurrentWork();
  if (!work.items.length) {
    alert(work.validation.errors[0] || '미리 볼 대상이 없습니다.');
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
  letterRow.innerHTML = '<th class="row-number"></th>';
  headerRow.innerHTML = '<th class="row-number"></th>';

  state.columns.forEach((column, index) => {
    const letter = document.createElement('th');
    letter.textContent = columnLetter(index);
    letterRow.append(letter);

    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'column-header';
    button.dataset.columnId = column.id;
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
    const rowNumber = document.createElement('td');
    rowNumber.className = 'row-number';
    rowNumber.textContent = String(rowIndex + 1);
    tr.append(rowNumber);
    state.columns.forEach((column, columnIndex) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'cell-input';
      input.dataset.rowIndex = String(rowIndex);
      input.dataset.columnId = column.id;
      input.dataset.columnIndex = String(columnIndex);
      input.value = state.rows[rowIndex]?.[column.id] || '';
      td.append(input);
      tr.append(td);
    });
    const trailingCell = document.createElement('td');
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
  updateRosterStatus();
}

function updateRosterStatus(message = '') {
  $('#rosterStats').textContent = `컬럼 ${state.columns.length}개 · 데이터 ${state.rows.length}행`;
  $('#rosterMessage').textContent = message || (state.columns.length ? '컬럼 헤더를 눌러 이름·역할을 수정할 수 있습니다.' : '첫 컬럼을 추가하거나 표를 붙여넣으세요.');
  $('#saveRoster').disabled = state.rows.length === 0;
  $('#useRoster').disabled = state.rows.length === 0;
}

function addColumn(name, role = 'variable') {
  const clean = String(name || '').trim().replace(/[{}]/g, '');
  if (!clean) return;
  state.columns.push({ id: makeId(), name: clean, role });
  state.activeStructureTemplateId = '';
  renderRoster();
  updateComposeState();
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
  return rows;
}

function applyTable(matrix) {
  if (!matrix.length) return;
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

function applyMatrixAt(matrix, startRow, startColumn) {
  if (!matrix.length) return;
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
  const name = prompt('저장할 명단 이름을 입력하세요.', state.activeRosterName || '새 명단');
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
    alert('저장할 컬럼 구조가 없습니다.');
    return;
  }
  const name = prompt('저장할 명단 템플릿 이름을 입력하세요.', '새 명단 템플릿');
  if (!name?.trim()) return;
  const now = new Date().toISOString();
  const item = { id: makeId(), name: name.trim(), columns: structuredClone(state.columns), createdAt: now, updatedAt: now };
  state.structureTemplates.unshift(item);
  state.activeStructureTemplateId = item.id;
  await storage.set('structureTemplates', state.structureTemplates);
  $('#rosterContext').textContent = `새 명단 · 명단 템플릿: ${item.name}`;
  renderStructureTemplates();
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
  const name = prompt('저장할 메일 템플릿 이름을 입력하세요.', '새 템플릿');
  if (!name?.trim()) return;
  if (name.trim().length > 50) { alert('템플릿 이름은 50자 이하여야 합니다.'); return; }
  if (!$('#subject').value.trim() && !$('#body').value.trim() && !$('#postscript').value.trim()) { alert('제목, 본문, 추신 중 하나는 입력해야 합니다.'); return; }
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

const STATUS_TEXT = { queued: '대기', processing: '처리 중', scheduled: '예약 대기', 'waiting-auth': 'Gmail 연결 필요', completed: '완료', failed: '실패', canceled: '취소' };

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
    button.title = '더블클릭하여 대상별 기록 보기';
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
    row.innerHTML = `<span>${escapeHtml(batch.name)}<br><small class="muted">${escapeHtml(statusText(batch.status))}${batch.scheduledAt ? ` · ${escapeHtml(formatDateTime(batch.scheduledAt))}` : ''}</small></span><button class="button danger compact-action" type="button" data-cancel-batch-id="${escapeHtml(batch.id)}">취소</button>`;
    return row;
  }));
}

function showHistoryBatch(id) {
  const batch = state.mailBatches.find((item) => item.id === id);
  if (!batch) return;
  state.selectedHistoryBatchId = id;
  $('#historyListView').hidden = true;
  $('#historyRecipientsView').hidden = false;
  $('#historyBatchName').textContent = batch.name;
  $('#historyBatchMeta').textContent = `${formatDateTime(batch.createdAt)} · ${batch.method} · ${statusText(batch.status)} ${batch.completed || 0}/${batch.total || batch.items.length}`;
  $('#historyRecipients').replaceChildren(...batch.items.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-row';
    button.dataset.historyItemId = item.id;
    const recipient = getHistoryRecipient(item);
    const displayName = item.variables?.이름 || recipient || (item.type === 'blank' ? `빈 초안 ${index + 1}` : `데이터 ${index + 1}`);
    button.innerHTML = `<span>${escapeHtml(displayName)}<br><small class="muted">${escapeHtml(recipient || '받는 사람 없음')}</small></span><span class="badge">${escapeHtml(statusText(item.status))}</span>`;
    return button;
  }));
  pushSubView('history-recipients');
}

function getHistoryRecipient(item) {
  if (item.email) return item.email;
  return Object.entries(item.variables || {}).find(([name, value]) => /^(이메일|메일|email|e-mail|email address)$/i.test(name.trim()) && GmailFlowCore.isValidEmail(value))?.[1] || '';
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
  $('#historyMessageStatus').textContent = statusText(item.status);
  $('#historyMessageSubject').textContent = item.subject || '(제목 없음)';
  $('#historyMessageSender').textContent = batch.senderEmail ? `나 <${batch.senderEmail}>` : '나';
  $('#historyMessageRecipient').textContent = `받는 사람: ${recipient || '없음'}`;
  $('#historyMessageBody').textContent = item.body || '(본문 없음)';
  const isDraft = batch.method === '임시 저장' || item.status === 'scheduled';
  const gmailId = isDraft ? (item.threadId || item.draftId) : (item.threadId || item.messageId);
  const gmailLink = $('#historyMessageGmailLink');
  gmailLink.hidden = !gmailId;
  gmailLink.textContent = isDraft ? 'Gmail에서 임시메일 열기' : 'Gmail에서 메일 열기';
  gmailLink.href = gmailId
    ? `https://mail.google.com/mail/${batch.senderEmail ? `?authuser=${encodeURIComponent(batch.senderEmail)}` : ''}#${isDraft ? 'drafts' : 'sent'}/${encodeURIComponent(gmailId)}`
    : '';
  $('#historyMessageErrorBlock').hidden = !item.error;
  $('#historyMessageError').textContent = item.error || '';
  pushSubView('history-message');
}

function renderSendReviewItem() {
  const item = sendReviewState.items[sendReviewState.index];
  if (!item) return;
  $('#sendReviewRecipient').value = String(sendReviewState.index);
  $('#sendReviewProgress').textContent = `${sendReviewState.approved.size}/${sendReviewState.items.length}명 확인 · ${sendReviewState.index + 1}/${sendReviewState.items.length}`;
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
  return status;
}

async function requestGmailConnection() {
  const buttons = [$('#connectGmail'), $('#switchGmail')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await chrome.identity.clearAllCachedAuthTokens();
    const result = await chrome.identity.getAuthToken({ interactive: true });
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new Error('Gmail 인증 토큰을 받지 못했습니다.');
    await sendRuntimeMessage({ type: 'resume-after-auth' });
    await updateConnectionStatus();
    await refreshMailActivity();
  } catch (error) {
    alert(error.message);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function closeMenus() {
  $$('details[open]').forEach((details) => { details.open = false; });
}

function bindEvents() {
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flushWorkspaceSave(); });
  globalThis.addEventListener('pagehide', () => { void flushWorkspaceSave(); });
  document.addEventListener('click', (event) => {
    const clickedMenu = event.target.closest('details.menu');
    $$('details.menu[open]').forEach((menu) => {
      if (menu !== clickedMenu) menu.open = false;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });
  $('#drawerToggle').addEventListener('click', () => {
    $('#app').classList.toggle('drawer-open');
    const open = $('#app').classList.contains('drawer-open');
    $('#drawerToggle').textContent = open ? '≪' : '≫';
  });
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
      alert(`창을 열지 못했습니다. ${error.message}`);
      $('#openWindowButton').disabled = false;
    }
  });
  $('#backButton').addEventListener('click', goBack);
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => showPage(item.dataset.page)));
  $('#sendMethod').addEventListener('change', updateComposeState);
  ['gmailLabel', 'scheduleDate', 'scheduleTime', 'subject', 'body', 'postscript'].forEach((id) => {
    $(`#${id}`).addEventListener('input', updateComposeState);
  });
  $('#emptyDraftToggle').addEventListener('click', () => {
    state.emptyDraftEnabled = !state.emptyDraftEnabled;
    $('#emptyDraftToggle').textContent = state.emptyDraftEnabled ? '－' : '＋';
    $('#emptyDraftToggle').setAttribute('aria-expanded', String(state.emptyDraftEnabled));
    updateComposeState();
  });
  $('#emptyDraftCount').addEventListener('input', updateComposeState);
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
    if (!work.validation.valid) { alert(work.validation.errors.join('\n')); return; }
    const method = $('#sendMethod').value;
    const count = work.items.length;
    const connection = await sendRuntimeMessage({ type: 'connection-status' });
    if (!connection.configured || !connection.connected) {
      alert(connection.configured ? '먼저 설정에서 Gmail 계정을 연결해주세요.' : '먼저 manifest.json에 Google OAuth 클라이언트 ID를 설정해주세요.');
      $('#settingsDialog').showModal();
      await updateConnectionStatus();
      return;
    }
    const rechecked = getCurrentWork();
    if (!rechecked.validation.valid || rechecked.items.length !== count || $('#sendMethod').value !== method) {
      alert('확인 중 명단이나 발송 설정이 변경되었습니다. 다시 확인해주세요.');
      updateComposeState();
      return;
    }
    const scheduledAt = method === '예약 발송' ? new Date(`${$('#scheduleDate').value}T${$('#scheduleTime').value}`).toISOString() : '';
    if (method === '임시 저장') {
      if (!confirm(`${count}개의 Gmail 초안을 생성할까요?`)) return;
    } else {
      const firstWarning = method === '예약 발송'
        ? `예약 발송 형식입니다.\n${count}명에게 ${formatDateTime(scheduledAt)}에 발송하시겠습니까?`
        : `즉시 발송 형식입니다.\n${count}명에게 지금 바로 발송하시겠습니까?`;
      if (!confirm(firstWarning)) return;
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
          scheduledAt,
          senderEmail: connection.email || '',
          items: rechecked.items
        }
      });
      await refreshMailActivity();
      alert(`${batch.name} 작업이 등록되었습니다.\n현재 상태: ${statusText(batch.status)}`);
      showPage(method === '예약 발송' ? 'queue' : 'history');
    } catch (error) {
      alert(error.message);
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
  $('#saveRoster').addEventListener('click', saveCurrentRoster);
  $('#openSavedRosters').addEventListener('click', () => {
    closeMenus(); renderSavedRosters(); $('#rosterEditor').hidden = true; $('#savedRosterList').hidden = false; pushSubView('saved-rosters');
  });
  $('#pasteTable').addEventListener('click', () => { closeMenus(); $('#pasteBox').hidden = false; $('#pasteInput').focus(); });
  $('#cancelPaste').addEventListener('click', () => { $('#pasteBox').hidden = true; $('#pasteInput').value = ''; });
  $('#applyPaste').addEventListener('click', () => { applyTable(parseDelimited($('#pasteInput').value)); $('#pasteBox').hidden = true; });
  $('#fileInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    applyTable(parseDelimited(await file.text())); closeMenus(); event.target.value = '';
  });
  $('#loadStructure').addEventListener('click', () => {
    closeMenus(); renderStructureTemplates(); $('#rosterEditor').hidden = true; $('#structureTemplateList').hidden = false; pushSubView('structure-templates');
  });
  $('#saveStructure').addEventListener('click', async () => { closeMenus(); await saveStructureTemplate(); });
  $('#resetRoster').addEventListener('click', () => { closeMenus(); if (!confirm('현재 명단 편집 내용을 초기화할까요?')) return; state.columns = []; state.rows = []; state.activeRosterName = ''; state.activeStructureTemplateId = ''; $('#rosterContext').textContent = '새 명단 · 연결된 명단 템플릿 없음'; renderRoster(); updateActiveRosterText(); updateComposeState(); });
  $('#useRoster').addEventListener('click', () => { state.activeRosterName ||= '현재 명단'; updateActiveRosterText(); updateComposeState(); showPage('compose'); });
  $('#rosterHead').addEventListener('click', (event) => {
    if (event.target.id === 'addColumn') { const name = prompt('새 컬럼 이름을 입력하세요.', '이름'); if (name?.trim()) addColumn(name); return; }
    const button = event.target.closest('.column-header');
    if (!button) return;
    const column = state.columns.find((item) => item.id === button.dataset.columnId);
    if (!column) return;
    const name = prompt('컬럼 이름을 수정하세요.', column.name);
    if (!name?.trim()) return;
    const role = prompt('컬럼 역할을 입력하세요.\n수신 이메일 / 일반 변수 / 제외', column.role === 'email' ? '수신 이메일' : '일반 변수');
    column.name = name.trim().replace(/[{}]/g, '');
    column.role = role?.includes('수신') ? 'email' : role?.includes('제외') ? 'excluded' : 'variable';
    state.activeStructureTemplateId = '';
    renderRoster(); updateComposeState();
  });
  $('#rosterBody').addEventListener('input', (event) => {
    const input = event.target.closest('.cell-input');
    if (!input) return;
    const rowIndex = Number(input.dataset.rowIndex);
    while (state.rows.length <= rowIndex) state.rows.push({});
    state.rows[rowIndex][input.dataset.columnId] = input.value;
    while (state.rows.length && Object.values(state.rows.at(-1)).every((value) => !String(value || '').trim())) state.rows.pop();
    updateRosterStatus(); updateComposeState();
  });
  $('#rosterBody').addEventListener('paste', (event) => {
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
    if (!roster) return;
    state.columns = structuredClone(roster.columns); state.rows = structuredClone(roster.rows); state.activeRosterName = roster.name;
    state.activeStructureTemplateId = roster.linkedStructureTemplateId || '';
    const linkedTemplate = state.templates.find((template) => template.id === roster.linkedTemplateId);
    if (linkedTemplate) applyMailTemplate(linkedTemplate); else state.activeTemplateId = '';
    renderRoster(); updateActiveRosterText(); updateComposeState(); resetSubViews(); state.backStack = []; $('#backButton').hidden = true;
  });
  $('#renameRoster').addEventListener('click', async () => {
    const roster = state.savedRosters.find((item) => item.id === state.selectedRosterId); if (!roster) return;
    const name = prompt('새 명단 이름을 입력하세요.', roster.name); if (!name?.trim()) return;
    roster.name = name.trim(); roster.updatedAt = new Date().toISOString(); await storage.set('savedRosters', state.savedRosters); showRosterDetail(roster.id); state.backStack.pop();
  });
  $('#deleteRoster').addEventListener('click', async () => {
    const roster = state.savedRosters.find((item) => item.id === state.selectedRosterId); if (!roster || !confirm(`“${roster.name}” 명단을 삭제할까요?`)) return;
    state.savedRosters = state.savedRosters.filter((item) => item.id !== roster.id); await storage.set('savedRosters', state.savedRosters); renderSavedRosters(); $('#savedRosterDetail').hidden = true; $('#savedRosterList').hidden = false; state.backStack.pop();
  });
  $('#templateItems').addEventListener('click', (event) => { const button = event.target.closest('[data-template-id]'); if (button) showTemplateDetail(button.dataset.templateId); });
  $('#applyTemplate').addEventListener('click', () => {
    const template = state.templates.find((item) => item.id === state.selectedTemplateId); if (!template) return;
    applyMailTemplate(template); showPage('compose');
  });
  $('#renameTemplate').addEventListener('click', async () => {
    const template = state.templates.find((item) => item.id === state.selectedTemplateId); if (!template) return;
    const name = prompt('새 템플릿 이름을 입력하세요.', template.name); if (!name?.trim() || name.trim().length > 50) return;
    template.name = name.trim(); template.updatedAt = new Date().toISOString(); await storage.set('templates', state.templates); renderTemplates(); renderQuickTemplateMenu(); showTemplateDetail(template.id); state.backStack.pop();
  });
  $('#deleteTemplate').addEventListener('click', async () => {
    const template = state.templates.find((item) => item.id === state.selectedTemplateId); if (!template || !confirm(`“${template.name}” 템플릿을 삭제할까요?`)) return;
    state.templates = state.templates.filter((item) => item.id !== template.id);
    if (state.activeTemplateId === template.id) state.activeTemplateId = '';
    await storage.set('templates', state.templates); renderTemplates(); renderQuickTemplateMenu(); $('#templateDetailView').hidden = true; $('#templateListView').hidden = false; state.backStack.pop();
  });
  $('#structureTemplateItems').addEventListener('click', (event) => {
    const button = event.target.closest('[data-structure-template-id]'); if (button) showStructureTemplateDetail(button.dataset.structureTemplateId);
  });
  $('#applyStructureTemplate').addEventListener('click', () => {
    const template = state.structureTemplates.find((item) => item.id === state.selectedStructureTemplateId); if (!template) return;
    state.columns = structuredClone(template.columns); state.rows = []; state.activeRosterName = ''; state.activeStructureTemplateId = template.id;
    $('#rosterContext').textContent = `새 명단 · 명단 템플릿: ${template.name}`;
    renderRoster(); updateComposeState(); resetSubViews(); state.backStack = []; $('#backButton').hidden = true;
  });
  $('#renameStructureTemplate').addEventListener('click', async () => {
    const template = state.structureTemplates.find((item) => item.id === state.selectedStructureTemplateId); if (!template) return;
    const name = prompt('새 명단 템플릿 이름을 입력하세요.', template.name); if (!name?.trim()) return;
    template.name = name.trim(); template.updatedAt = new Date().toISOString(); await storage.set('structureTemplates', state.structureTemplates); renderStructureTemplates(); showStructureTemplateDetail(template.id); state.backStack.pop();
  });
  $('#deleteStructureTemplate').addEventListener('click', async () => {
    const template = state.structureTemplates.find((item) => item.id === state.selectedStructureTemplateId); if (!template || !confirm(`“${template.name}” 명단 템플릿을 삭제할까요?`)) return;
    state.structureTemplates = state.structureTemplates.filter((item) => item.id !== template.id);
    if (state.activeStructureTemplateId === template.id) state.activeStructureTemplateId = '';
    await storage.set('structureTemplates', state.structureTemplates); renderStructureTemplates(); $('#structureTemplateDetail').hidden = true; $('#structureTemplateList').hidden = false; state.backStack.pop();
  });
  $('#accountButton').addEventListener('click', async () => {
    $('#settingsDialog').showModal();
    try { await updateConnectionStatus(); } catch (error) { $('#gmailConnectionStatus').textContent = error.message; }
  });
  $('#connectGmail').addEventListener('click', requestGmailConnection);
  $('#switchGmail').addEventListener('click', requestGmailConnection);
  $('#disconnectGmail').addEventListener('click', async () => {
    if (!confirm('Google 계정에서 로그아웃할까요? 예약 작업은 다시 연결할 때까지 대기합니다.')) return;
    await chrome.identity.clearAllCachedAuthTokens();
    await updateConnectionStatus();
  });
  $('#historyItems').addEventListener('dblclick', (event) => {
    const button = event.target.closest('[data-history-batch-id]'); if (button) showHistoryBatch(button.dataset.historyBatchId);
  });
  $('#historyRecipients').addEventListener('click', (event) => {
    const button = event.target.closest('[data-history-item-id]'); if (button) showHistoryMessage(button.dataset.historyItemId);
  });
  $('#deleteHistoryBatch').addEventListener('click', async () => {
    const batch = state.mailBatches.find((item) => item.id === state.selectedHistoryBatchId); if (!batch || !confirm(`“${batch.name}” 기록을 삭제할까요?`)) return;
    try {
      await sendRuntimeMessage({ type: 'delete-mail-batch', batchId: batch.id });
      await refreshMailActivity(); $('#historyRecipientsView').hidden = true; $('#historyListView').hidden = false; state.backStack.pop(); $('#backButton').hidden = state.backStack.length === 0;
    } catch (error) { alert(error.message); }
  });
  $('#queueItems').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-cancel-batch-id]'); if (!button) return;
    const batch = state.mailBatches.find((item) => item.id === button.dataset.cancelBatchId); if (!batch || !confirm(`“${batch.name}” 작업을 취소할까요?`)) return;
    try { await sendRuntimeMessage({ type: 'cancel-mail-batch', batchId: batch.id }); await refreshMailActivity(); }
    catch (error) { alert(error.message); }
  });
  if (globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.mailBatches) refreshMailActivity(); });
}

async function init() {
  state.savedRosters = await storage.get('savedRosters', []);
  state.templates = await storage.get('templates', []);
  state.structureTemplates = await storage.get('structureTemplates', []);
  state.mailBatches = await storage.get('mailBatches', []);
  await restoreWorkspace();
  bindEvents();
  renderRoster();
  renderSavedRosters();
  renderTemplates();
  renderQuickTemplateMenu();
  renderStructureTemplates();
  renderHistory();
  renderQueue();
  updateComposeState();
  showPage(state.page);
  try { await updateConnectionStatus(); } catch (_) {}
}

init();
