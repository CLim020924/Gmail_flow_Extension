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
  selectedRosterId: '',
  selectedTemplateId: '',
  emptyDraftEnabled: false
};

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
  } else if (current === 'history-message') {
    $('#historyMessageView').hidden = true;
    $('#historyRecipientsView').hidden = false;
  } else if (current === 'history-recipients') {
    $('#historyRecipientsView').hidden = true;
    $('#historyListView').hidden = false;
  }
  $('#backButton').hidden = state.backStack.length === 0;
}

function updateComposeState() {
  const method = $('#sendMethod').value;
  const recipientCount = state.rows.filter((row) => {
    const emailColumn = state.columns.find((column) => column.role === 'email');
    return emailColumn && String(row[emailColumn.id] || '').trim();
  }).length;
  const blankRowCount = state.rows.length - recipientCount;
  const emptyCount = state.emptyDraftEnabled ? Math.max(Number($('#emptyDraftCount').value) || 1, 1) : 0;

  $('#recipientBadge').textContent = `대상 ${recipientCount}명`;
  $('#labelField').hidden = method === '즉시 발송';
  $('#scheduleField').hidden = method !== '예약 발송';
  $('#emptyDraftControl').hidden = method !== '임시 저장';
  $('#emptyDraftCount').hidden = method !== '임시 저장' || !state.emptyDraftEnabled;

  if (method === '임시 저장') {
    const total = state.rows.length + emptyCount;
    $('#composeAction').textContent = total ? `초안 ${total}개 저장` : '임시 저장';
    $('#composeAction').disabled = total === 0;
    $('#composeHint').textContent = state.rows.length
      ? `명단 ${state.rows.length}행${blankRowCount ? ` 중 이메일 없는 ${blankRowCount}행 포함` : ''}${emptyCount ? ` + 빈 초안 ${emptyCount}개` : ''}`
      : (emptyCount ? `받는 사람 없는 빈 초안 ${emptyCount}개를 만듭니다.` : '명단을 선택하거나 빈 초안 기능을 켜주세요.');
  } else if (method === '예약 발송') {
    $('#composeAction').textContent = '예약 발송 등록';
    $('#composeAction').disabled = recipientCount === 0;
    $('#composeHint').textContent = recipientCount ? '예약 날짜와 시간을 확인한 뒤 등록합니다.' : '예약 발송에는 수신 이메일이 있는 명단이 필요합니다.';
  } else {
    $('#composeAction').textContent = '즉시 발송';
    $('#composeAction').disabled = recipientCount === 0;
    $('#composeHint').textContent = recipientCount ? `${recipientCount}명에게 지금 바로 발송합니다.` : '즉시 발송에는 수신 이메일이 있는 명단이 필요합니다.';
  }
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
    state.columns.forEach((column) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'cell-input';
      input.dataset.rowIndex = String(rowIndex);
      input.dataset.columnId = column.id;
      input.value = state.rows[rowIndex]?.[column.id] || '';
      td.append(input);
      tr.append(td);
    });
    tr.append(document.createElement('td'));
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
  renderRoster();
}

function parseDelimited(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trimEnd();
  if (!normalized) return [];
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
  const looksLikeHeader = first.filter(Boolean).length === width && new Set(first.map((value) => value.toLowerCase())).size === width;
  const headers = looksLikeHeader ? first : Array.from({ length: width }, (_, index) => `컬럼${index + 1}`);
  const dataRows = looksLikeHeader ? matrix.slice(1) : matrix;
  state.columns = headers.map((name, index) => ({
    id: makeId(),
    name: name || `컬럼${index + 1}`,
    role: /^(이메일|메일|email|e-mail|email address)$/i.test(name) ? 'email' : 'variable'
  }));
  state.rows = dataRows.filter((row) => row.some((value) => String(value || '').trim())).map((row) => {
    const record = {};
    state.columns.forEach((column, index) => { record[column.id] = row[index] || ''; });
    return record;
  });
  renderRoster();
  updateRosterStatus(`${width}열 × ${state.rows.length}행 구조를 자동 생성했습니다.`);
  updateComposeState();
}

async function saveCurrentRoster() {
  const name = prompt('저장할 명단 이름을 입력하세요.', state.activeRosterName || '새 명단');
  if (!name?.trim()) return;
  const now = new Date().toISOString();
  const item = { id: makeId(), name: name.trim(), columns: structuredClone(state.columns), rows: structuredClone(state.rows), createdAt: now, updatedAt: now };
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

function updateActiveRosterText() {
  const variables = state.columns.length;
  $('#activeRosterText').textContent = state.activeRosterName
    ? `현재 명단: ${state.activeRosterName} · ${state.rows.length}행 · 변수 ${variables}개`
    : `현재 명단 없음 · 사용 가능한 변수 ${variables}개`;
}

function renderTemplates() {
  const container = $('#templateItems');
  if (!state.templates.length) {
    container.innerHTML = '<div class="empty-state">저장된 템플릿이 없습니다.</div>';
    return;
  }
  container.replaceChildren(...state.templates.map((template) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-row';
    button.dataset.templateId = template.id;
    button.innerHTML = `<span>${escapeHtml(template.name)}</span><span class="muted">상세 보기</span>`;
    return button;
  }));
}

async function saveTemplate() {
  const name = prompt('저장할 메일 템플릿 이름을 입력하세요.', '새 템플릿');
  if (!name?.trim()) return;
  const template = { id: makeId(), name: name.trim(), subject: $('#subject').value, body: $('#body').value, label: $('#gmailLabel').value, sendMethod: $('#sendMethod').value };
  state.templates.unshift(template);
  await storage.set('templates', state.templates);
  renderTemplates();
}

function showTemplateDetail(id) {
  const template = state.templates.find((item) => item.id === id);
  if (!template) return;
  state.selectedTemplateId = id;
  $('#templateListView').hidden = true;
  $('#templateDetailView').hidden = false;
  $('#templateDetailName').textContent = template.name;
  $('#templateDetailSubject').textContent = template.subject || '(제목 없음)';
  $('#templateDetailBody').textContent = template.body || '(본문 없음)';
  pushSubView('template-detail');
}

function renderHistoryRecipients() {
  const people = [
    { name: '김민아', email: 'mina@example.com', company: '코덱스랩' },
    { name: '박지수', email: 'jisu@example.com', company: '오픈스튜디오' },
    { name: '이준호', email: 'jun@example.com', company: '메일웍스' }
  ];
  $('#historyRecipients').replaceChildren(...people.map((person) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-row';
    button.dataset.person = JSON.stringify(person);
    button.innerHTML = `<span>${person.name}<br><small class="muted">${person.email}</small></span><span class="badge">성공</span>`;
    return button;
  }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function closeMenus() {
  $$('details[open]').forEach((details) => { details.open = false; });
}

function bindEvents() {
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
  $('#backButton').addEventListener('click', goBack);
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => showPage(item.dataset.page)));
  $('#sendMethod').addEventListener('change', updateComposeState);
  $('#emptyDraftToggle').addEventListener('click', () => {
    state.emptyDraftEnabled = !state.emptyDraftEnabled;
    $('#emptyDraftToggle').textContent = state.emptyDraftEnabled ? '－' : '＋';
    $('#emptyDraftToggle').setAttribute('aria-expanded', String(state.emptyDraftEnabled));
    updateComposeState();
  });
  $('#emptyDraftCount').addEventListener('input', updateComposeState);
  $('#previewButton').addEventListener('click', () => {
    $('#previewSubject').textContent = $('#subject').value || '(제목 없음)';
    $('#previewBody').textContent = $('#body').value || '(본문 없음)';
    $('#previewDialog').showModal();
  });
  $('#saveMailTemplate').addEventListener('click', async () => { closeMenus(); await saveTemplate(); });
  $('#loadMailTemplate').addEventListener('click', () => { closeMenus(); showPage('templates'); });
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
    closeMenus(); state.columns = []; state.rows = []; addColumn('이메일', 'email'); addColumn('이름'); addColumn('회사명'); $('#rosterContext').textContent = '새 명단 · 구조 템플릿: 채용 기본 구조';
  });
  $('#saveStructure').addEventListener('click', () => { closeMenus(); const name = prompt('저장할 구조 템플릿 이름을 입력하세요.', '새 구조'); if (name?.trim()) $('#rosterContext').textContent = `새 명단 · 구조 템플릿: ${name.trim()}`; });
  $('#resetRoster').addEventListener('click', () => { closeMenus(); if (!confirm('현재 명단 편집 내용을 초기화할까요?')) return; state.columns = []; state.rows = []; state.activeRosterName = ''; renderRoster(); updateActiveRosterText(); updateComposeState(); });
  $('#validateRoster').addEventListener('click', () => { closeMenus(); const email = state.columns.find((column) => column.role === 'email'); updateRosterStatus(email ? '수신 이메일 컬럼을 확인했습니다.' : '수신 이메일 역할을 지정해야 실제 발송할 수 있습니다.'); });
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
  $('#savedRosterItems').addEventListener('click', (event) => { const button = event.target.closest('[data-roster-id]'); if (button) showRosterDetail(button.dataset.rosterId); });
  $('#loadSelectedRoster').addEventListener('click', () => {
    const roster = state.savedRosters.find((item) => item.id === state.selectedRosterId);
    if (!roster) return;
    state.columns = structuredClone(roster.columns); state.rows = structuredClone(roster.rows); state.activeRosterName = roster.name;
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
    $('#subject').value = template.subject; $('#body').value = template.body; $('#gmailLabel').value = template.label; $('#sendMethod').value = template.sendMethod; updateComposeState(); showPage('compose');
  });
  $('#demoHistory').addEventListener('click', () => { $('#historyListView').hidden = true; $('#historyRecipientsView').hidden = false; pushSubView('history-recipients'); });
  $('#historyRecipients').addEventListener('click', (event) => {
    const button = event.target.closest('[data-person]'); if (!button) return;
    const person = JSON.parse(button.dataset.person); $('#historyRecipientsView').hidden = true; $('#historyMessageView').hidden = false;
    $('#historyMessageName').textContent = `${person.name}님에게 보낸 메시지`; $('#historyMessageMeta').textContent = `${person.email} · 2026-07-30 14:20`;
    $('#historyMessageSubject').textContent = `${person.name}님, 1차 인터뷰 안내입니다`;
    $('#historyMessageBody').textContent = `안녕하세요 ${person.name}님.\n${person.company}의 1차 인터뷰 일정을 안내드립니다.`;
    pushSubView('history-message');
  });
}

async function init() {
  state.savedRosters = await storage.get('savedRosters', []);
  state.templates = await storage.get('templates', []);
  bindEvents();
  renderRoster();
  renderSavedRosters();
  renderTemplates();
  renderHistoryRecipients();
  updateComposeState();
}

init();
