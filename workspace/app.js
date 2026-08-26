(() => {
  const Core = globalThis.WorkspaceCore;
  const Ops = globalThis.OperationsCore;
  const launchParams = new URLSearchParams(location.search);
  const standaloneProgram = launchParams.get('mode') === 'standalone' ? launchParams.get('app') : '';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const STATUS_LABELS = {
    notStarted: '시작 전',
    inProgress: '진행 중',
    needsReview: '확인 필요',
    complete: '완료',
    stale: '다시 확인 필요'
  };
  const PROJECT_STATUS_LABELS = {
    active: '진행 중',
    paused: '일시정지',
    completed: '완료',
    archived: '보관됨'
  };
  const WORKFLOW_ACTION_LABELS = {
    people: '명단 정리하기', forms: '설문 준비하기', schedule: '일정표 만들기',
    layout: '일정표 저장하기', zoom: 'Zoom 회의 만들기', gmailFlow: '안내 메일 준비하기'
  };

  let state = Core.createEmptyState();
  let currentPage = 'dashboard';
  let confirmResolver = null;
  let nameInputResolver = null;
  let saveTimer = null;
  let driveSyncTimer = null;
  let extensionManifests = [];
  let mailEditorDirty = false;
  let mailDraftTimer = null;
  let rosterSelection = null;
  let rosterSelecting = false;
  let arrangementSelection = null;
  let arrangementSelecting = false;
  let scheduleSelection = null;
  let scheduleSelecting = false;
  let scheduleHistory = [];
  let scheduleFuture = [];
  let schedulePersistTimer = null;
  let selectedSessionPersonId = null;
  let sheetChoiceResolver = null;
  let templateInsertionTarget = 'body';
  let activeWorkflowStepId = null;
  let workflowEditorDraft = [];
  let workflowEditorTemplateDraft = null;
  let gmailFlowSummary = { connected: false, email: '', rosters: 0, templates: 0, structures: 0 };

  const storage = {
    async load() {
      if (globalThis.workspaceDesktop) return globalThis.workspaceDesktop.loadState();
      try { return JSON.parse(localStorage.getItem('cmoeWorkspaceState') || 'null'); }
      catch (_) { return null; }
    },
    async save(nextState) {
      if (globalThis.workspaceDesktop) {
        nextState._baseRevision = Number(nextState._baseRevision ?? nextState._revision ?? 0);
        return globalThis.workspaceDesktop.saveState(nextState);
      }
      localStorage.setItem('cmoeWorkspaceState', JSON.stringify(nextState));
      return { ok: true };
    }
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatDate(date) {
    if (!date) return '';
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return date;
    return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }).format(parsed);
  }

  function formatUpdatedAt(value) {
    if (!value) return '아직 작업 없음';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function activeProject() {
    if (standaloneProgram) return state.quickWorkspaces?.[standaloneProgram] || null;
    return Core.getActiveProject(state);
  }

  function defaultConnectionId(project, type) {
    return project?.settings?.defaultConnectionIds?.[type] || (standaloneProgram ? state.connections.find((connection) => connection.type === type && connection.status === 'connected')?.id : null);
  }

  function showToast(message, tone = 'normal') {
    const toast = element('div', `toast ${tone}`, message);
    $('#toastRegion').append(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 180);
    }, 2600);
  }

  async function persist(message = '저장됨') {
    clearTimeout(saveTimer);
    $('#saveStatus').textContent = '저장 중…';
    try {
      state.updatedAt = new Date().toISOString();
      const result = await storage.save(state);
      if (result?.state) state = Core.normalizeState(result.state);
      if (result?.merged) showToast('다른 창의 변경사항과 안전하게 병합했습니다.');
      if (state.preferences.storageMode === 'drive') {
        clearTimeout(driveSyncTimer);
        driveSyncTimer = setTimeout(() => void pushStateToDrive(false), 1500);
      }
      $('#saveStatus').textContent = message;
      saveTimer = setTimeout(() => { $('#saveStatus').textContent = '저장됨'; }, 1600);
    } catch (error) {
      $('#saveStatus').textContent = '저장 실패';
      showToast(error.message || '저장하지 못했습니다.', 'error');
      throw error;
    }
  }

  function connectedDrive() {
    return state.connections.find((connection) => connection.type === 'drive' && connection.status === 'connected');
  }

  async function pushStateToDrive(notify = true) {
    const connection = connectedDrive();
    if (!connection) { if (notify) showToast('먼저 Google Drive 계정에 로그인하여 연결해주세요.', 'error'); return false; }
    try {
      const result = await globalThis.workspaceDesktop.pushDriveState(connection.id, state);
      state.preferences.lastDriveSyncAt = result.modifiedTime || new Date().toISOString();
      if ($('#driveSyncStatus')) $('#driveSyncStatus').textContent = `마지막 Drive 저장: ${formatUpdatedAt(state.preferences.lastDriveSyncAt)}`;
      if (notify) showToast('현재 Workspace 데이터를 Drive에 저장했습니다.', 'success');
      return true;
    } catch (error) { if (notify) showToast(`Drive 저장 실패: ${error.message}`, 'error'); return false; }
  }

  function openDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (dialog?.open) dialog.close();
  }

  function showConfirm(message, options = {}) {
    $('#confirmTitle').textContent = options.title || '확인';
    $('#confirmMessage').textContent = message;
    $('#confirmAction').textContent = options.action || '확인';
    $('#confirmAction').className = options.danger === false ? 'primary-button' : 'danger-button';
    openDialog('confirmDialog');
    return new Promise((resolve) => { confirmResolver = resolve; });
  }

  function resolveConfirm(value) {
    closeDialog('confirmDialog');
    const resolver = confirmResolver;
    confirmResolver = null;
    resolver?.(value);
  }

  function requestName(title, initialValue = '') {
    $('#nameInputTitle').textContent = title; $('#nameInputValue').value = initialValue; openDialog('nameInputDialog');
    setTimeout(() => { $('#nameInputValue').focus(); $('#nameInputValue').select(); });
    return new Promise((resolve) => { nameInputResolver = resolve; });
  }

  function resolveNameInput(value) {
    closeDialog('nameInputDialog'); const resolver = nameInputResolver; nameInputResolver = null; resolver?.(value);
  }

  function chooseWorkbookSheet(sheets) {
    const select = $('#sheetChoiceSelect'); select.replaceChildren();
    sheets.forEach((sheet, index) => { const option = element('option', '', `${sheet.name} · ${sheet.matrix?.length || 0}행`); option.value = String(index); select.append(option); });
    $('#sheetImportMode').value = 'replace'; openDialog('sheetChoiceDialog');
    return new Promise((resolve) => { sheetChoiceResolver = resolve; });
  }

  function resolveWorkbookSheet(value) {
    closeDialog('sheetChoiceDialog'); const resolver = sheetChoiceResolver; sheetChoiceResolver = null; resolver?.(value);
  }

  function navigate(page) {
    if (currentPage === 'gmailFlow' && page !== 'gmailFlow' && mailEditorDirty) void saveMailEditorDraft();
    currentPage = page;
    const module = Core.MODULE_CATALOG.find((item) => item.id === page);
    const visiblePage = module?.page === 'declarative' ? 'declarative' : page;
    $$('.page').forEach((panel) => panel.classList.toggle('active', panel.dataset.page === visiblePage));
    $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.nav === page));
    if (page === 'projects') renderProjectsPage();
    if (page === 'modules') renderModulesPage();
    if (page === 'connections') renderConnectionsPage();
    if (page === 'library') renderLibraryPage();
    if (page === 'people') renderPeoplePage();
    if (page === 'arrange') renderArrangementPage();
    if (page === 'schedule') renderSchedulePage();
    if (page === 'layout') renderLayoutPage();
    if (page === 'forms') renderFormsPage();
    if (page === 'zoom') renderZoomPage();
    if (page === 'gmailFlow') renderGmailPage();
    if (page === 'workflowTask') renderWorkflowTaskPage();
    if (visiblePage === 'declarative') renderDeclarativePage(page);
  }

  async function saveMailEditorDraft() {
    const project = activeProject(); if (!project || !mailEditorDirty) return;
    project.data.communication.subjectTemplate = $('#mailSubjectTemplate').value;
    project.data.communication.bodyHtmlTemplate = sanitizeRichHtml($('#mailBodyEditor').innerHTML);
    project.data.communication.bodyTemplate = $('#mailBodyEditor').innerText;
    project.updatedAt = new Date().toISOString(); mailEditorDirty = false;
    await persist('메일 편집 자동 저장됨');
  }

  function renderProjectSwitcher() {
    if (standaloneProgram) return;
    const select = $('#projectSwitcher');
    const showArchived = state.preferences.showArchivedProjects;
    const projects = state.projects.filter((project) => showArchived || project.status !== 'archived');
    select.replaceChildren();
    if (!projects.length) {
      const option = element('option', '', '프로젝트 없음');
      option.value = '';
      select.append(option);
      select.disabled = true;
    } else {
      projects.forEach((project) => {
        const option = element('option', '', `${project.name}${project.status === 'archived' ? ' · 보관됨' : ''}`);
        option.value = project.id;
        option.selected = project.id === state.activeProjectId;
        option.disabled = project.status === 'archived';
        select.append(option);
      });
      select.disabled = false;
    }
    $('#projectSettingsButton').disabled = !activeProject();
  }

  function renderSidebarProjects() {
    const container = $('#sidebarProjectList');
    const projects = state.projects
      .filter((project) => state.preferences.showArchivedProjects || project.status !== 'archived')
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 8);
    container.replaceChildren();
    if (!projects.length) {
      const empty = element('p', 'sidebar-empty', '프로젝트가 없습니다.');
      container.append(empty);
      return;
    }
    projects.forEach((project) => {
      const button = element('button', `sidebar-project ${project.id === state.activeProjectId ? 'active' : ''}`);
      button.type = 'button';
      button.dataset.projectId = project.id;
      const initial = element('span', 'project-initial', project.name.slice(0, 1).toUpperCase());
      const copy = element('span', 'project-copy');
      copy.append(element('strong', '', project.name), element('small', '', project.client || PROJECT_STATUS_LABELS[project.status]));
      button.append(initial, copy);
      if (project.status === 'archived') button.disabled = true;
      container.append(button);
    });
  }

  function renderDashboard() {
    const quickLaunch = $('#homeQuickLaunch'); quickLaunch.replaceChildren();
    Core.MODULE_CATALOG.filter((module) => state.installedExtensions.includes(module.id)).forEach((module) => {
      const button = element('button', 'quick-launch-button'); button.type = 'button'; button.dataset.programLaunch = module.id;
      button.append(element('span', `module-icon accent-${module.accent}`, module.icon || module.shortName.slice(0, 1)));
      const copy = element('span'); copy.append(element('strong', '', module.name), element('small', '', '프로젝트 없이 바로 사용')); button.append(copy); quickLaunch.append(button);
    });
    const project = activeProject();
    $('#dashboardEmpty').hidden = Boolean(project);
    $('#dashboardContent').hidden = !project;
    if (!project) return;

    $('#activeProjectName').textContent = project.name;
    $('#projectStatus').textContent = PROJECT_STATUS_LABELS[project.status] || '진행 중';
    const dateRange = project.startDate || project.endDate
      ? `${formatDate(project.startDate) || '시작일 미정'} – ${formatDate(project.endDate) || '종료일 미정'}`
      : '운영 기간 미설정';
    $('#activeProjectMeta').textContent = [project.client, dateRange].filter(Boolean).join(' · ');
    $('#activeWorkflowTemplate').textContent = project.workflowTemplate?.name
      ? `${project.workflowTemplate.name} · v${project.workflowTemplate.version}${project.workflowTemplate.modified ? ' · 프로젝트에서 수정됨' : ''}`
      : '직접 구성한 업무';
    $('#peopleCount').textContent = String(project.counts.people);
    $('#sessionCount').textContent = String(project.counts.sessions);
    $('#unresolvedCount').textContent = String(project.counts.unresolved);
    const progress = Core.getProjectProgress(project);
    $('#progressPercent').textContent = `${progress.percent}%`;
    $('#projectProgress').value = progress.percent;

    const workflow = $('#workflowGrid');
    workflow.replaceChildren();
    const workflowSteps = project.workflow || [];
    workflowSteps.forEach((workflowStep, index) => {
      const taskDefinition = Core.TASK_TYPE_CATALOG.find((item) => item.id === workflowStep.type);
      const module = workflowStep.moduleId ? Core.MODULE_CATALOG.find((item) => item.id === workflowStep.moduleId) : null;
      const status = workflowStep.status || 'notStarted';
      const card = element('article', `workflow-card accent-${module?.accent || ['blue', 'green', 'amber', 'violet'][index % 4]}`);
      card.dataset.workflowStepId = workflowStep.id;
      const top = element('div', 'workflow-card-top');
      const step = element('span', 'workflow-step', taskDefinition?.icon || module?.icon || String(index + 1));
      step.title = `${index + 1}단계`;
      const badge = element('span', `status-badge ${status}`, STATUS_LABELS[status]);
      top.append(step, badge);
      const title = element('h3', '', workflowStep.name);
      const description = element('p', '', workflowStep.description || taskDefinition?.description || module?.description || '');
      const footer = element('div', 'workflow-card-footer');
      const updated = element('small', '', workflowStep.notes || formatUpdatedAt(workflowStep.updatedAt));
      const button = element('button', 'module-open-button', status === 'notStarted' ? (workflowStep.moduleId ? WORKFLOW_ACTION_LABELS[workflowStep.moduleId] || '시작하기' : '이 단계 시작하기') : '계속 작업하기');
      button.type = 'button';
      button.dataset.workflowStepOpen = workflowStep.id;
      if (workflowStep.moduleId) button.dataset.workflowOpen = workflowStep.moduleId;
      footer.append(updated, button);
      card.append(top, title, description, footer);
      workflow.append(card);
    });
    if (!workflowSteps.length) workflow.append(element('div', 'notice', '업무 단계가 없습니다. “업무 구성 편집”에서 필요한 단계를 추가하세요.'));
  }

  function renderNewProjectTemplates(selectedId = $('#newProjectTemplateId')?.value || 'template-blank') {
    const picker = $('#newProjectTemplatePicker');
    if (!picker) return;
    const latestByFamily = new Map();
    state.library.workflowTemplates.forEach((template) => { const current = latestByFamily.get(template.familyId); if (!current || template.version > current.version) latestByFamily.set(template.familyId, template); });
    const explicitlySelected = state.library.workflowTemplates.find((template) => template.id === selectedId); if (explicitlySelected) latestByFamily.set(explicitlySelected.familyId, explicitlySelected);
    const templates = [...latestByFamily.values()].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.category.localeCompare(b.category, 'ko') || a.name.localeCompare(b.name, 'ko'));
    if (!templates.some((item) => item.id === selectedId)) selectedId = templates[0]?.id || 'template-blank';
    $('#newProjectTemplateId').value = selectedId;
    picker.replaceChildren(...templates.map((template) => {
      const label = element('label', `template-choice ${template.id === selectedId ? 'selected' : ''}`);
      const radio = element('input'); radio.type = 'radio'; radio.name = 'templateChoice'; radio.value = template.id; radio.checked = template.id === selectedId;
      const copy = element('span'); copy.append(element('strong', '', `${template.name}${template.version > 1 ? ` v${template.version}` : ''}`), element('small', '', template.description));
      label.append(radio, copy); return label;
    }));
    const selected = templates.find((item) => item.id === selectedId);
    $('#newProjectStepPreview').replaceChildren(...(selected?.steps || []).map((step) => element('span', '', step.name)));
  }

  function openWorkflowEditor() {
    const project = activeProject();
    if (!project) return;
    workflowEditorDraft = JSON.parse(JSON.stringify(project.workflow || []));
    workflowEditorTemplateDraft = { ...project.workflowTemplate, modified: true };
    const typeSelect = $('#workflowStepType');
    typeSelect.replaceChildren(...Core.TASK_TYPE_CATALOG.map((type) => { const option = element('option', '', type.name); option.value = type.id; return option; }));
    const templateSelect = $('#workflowTemplateApplySelect'); templateSelect.replaceChildren(element('option', '', '현재 구성 유지'));
    state.library.workflowTemplates.forEach((template) => { const option = element('option', '', `${template.name} · v${template.version}`); option.value = template.id; option.selected = project.workflowTemplate?.id === template.id && !project.workflowTemplate?.modified; templateSelect.append(option); });
    $('#workflowTemplateChangeSummary').textContent = '현재 프로젝트의 구성을 직접 편집하고 있습니다.';
    renderWorkflowEditor();
    openDialog('workflowEditorDialog');
  }

  function renderWorkflowEditor() {
    const list = $('#workflowEditorList'); list.replaceChildren();
    if (!workflowEditorDraft.length) { list.append(element('div', 'list-empty', '업무 단계가 없습니다. 아래에서 첫 단계를 추가하세요.')); return; }
    workflowEditorDraft.forEach((step, index) => {
      const row = element('div', 'workflow-editor-row'); row.dataset.workflowEditorStep = step.id;
      row.append(element('span', 'workflow-editor-order', String(index + 1)));
      const name = element('input'); name.value = step.name; name.dataset.workflowStepName = step.id; name.setAttribute('aria-label', `${index + 1}단계 이름`);
      const description = element('input'); description.value = step.description || ''; description.dataset.workflowStepDescription = step.id; description.placeholder = '사용자가 이해할 수 있는 짧은 설명'; description.setAttribute('aria-label', `${index + 1}단계 설명`);
      const actions = element('div', 'workflow-editor-actions');
      const up = element('button', 'secondary-button', '↑'); up.type = 'button'; up.dataset.workflowStepMove = step.id; up.dataset.direction = '-1'; up.disabled = index === 0; up.title = '위로 이동';
      const down = element('button', 'secondary-button', '↓'); down.type = 'button'; down.dataset.workflowStepMove = step.id; down.dataset.direction = '1'; down.disabled = index === workflowEditorDraft.length - 1; down.title = '아래로 이동';
      const remove = element('button', 'secondary-button danger-text', '삭제'); remove.type = 'button'; remove.dataset.workflowStepRemove = step.id;
      actions.append(up, down, remove); row.append(name, description, actions); list.append(row);
    });
  }

  function openWorkflowStep(stepId) {
    const project = activeProject(); const step = project?.workflow.find((item) => item.id === stepId);
    if (!project || !step) return;
    activeWorkflowStepId = step.id;
    if (step.status === 'notStarted') {
      state = Core.setWorkflowStepStatus(state, project.id, step.id, 'inProgress');
      void persist();
    }
    if (step.moduleId) openWorkflowModule(step.moduleId);
    else navigate('workflowTask');
  }

  function renderWorkflowTaskPage() {
    const project = activeProject(); const step = project?.workflow.find((item) => item.id === activeWorkflowStepId);
    if (!project || !step) { navigate('dashboard'); return; }
    const definition = Core.TASK_TYPE_CATALOG.find((item) => item.id === step.type);
    $('#workflowTaskType').textContent = definition?.name || '업무 단계';
    $('#workflowTaskName').textContent = step.name;
    $('#workflowTaskDescription').textContent = step.description || definition?.description || '';
    $('#workflowTaskInstructions').value = step.instructions || '';
    $('#workflowTaskNotes').value = step.notes || '';
    $('#workflowTaskStatus').value = step.status;
    $('#workflowTaskComplete').textContent = step.status === 'complete' ? '완료됨' : '완료로 표시';
    $('#workflowTaskComplete').disabled = step.status === 'complete';
    const checklist = $('#workflowChecklist'); checklist.replaceChildren();
    if (!step.checklist.length) checklist.append(element('div', 'list-empty', '체크 항목이 없습니다. 이 업무에서 반복 확인할 항목을 추가하세요.'));
    step.checklist.forEach((item) => {
      const row = element('label', `workflow-check-item ${item.done ? 'done' : ''}`);
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = item.done; checkbox.dataset.workflowCheck = item.id;
      const text = element('span', '', item.text);
      const remove = element('button', 'text-button danger-text', '삭제'); remove.type = 'button'; remove.dataset.workflowCheckRemove = item.id;
      row.append(checkbox, text, remove); checklist.append(row);
    });
  }

  async function saveWorkflowTask(statusOverride) {
    const project = activeProject(); const step = project?.workflow.find((item) => item.id === activeWorkflowStepId);
    if (!project || !step) return;
    step.instructions = $('#workflowTaskInstructions').value.trim();
    step.notes = $('#workflowTaskNotes').value.trim();
    const status = statusOverride || $('#workflowTaskStatus').value;
    state = Core.updateProject(state, project.id, { workflow: project.workflow });
    state = Core.setWorkflowStepStatus(state, project.id, step.id, status, step.notes);
    await persist('업무 단계 저장됨'); renderAll(); renderWorkflowTaskPage(); showToast('이 단계의 기준과 결과를 저장했습니다.', 'success');
  }

  function renderProjectsPage() {
    const query = $('#projectSearch').value.trim().toLowerCase();
    const filter = $('#projectStatusFilter').value;
    let projects = state.projects.slice();
    if (filter === 'open') projects = projects.filter((project) => project.status !== 'archived');
    if (filter === 'archived') projects = projects.filter((project) => project.status === 'archived');
    if (query) projects = projects.filter((project) => `${project.name} ${project.client}`.toLowerCase().includes(query));

    const container = $('#projectCards');
    container.replaceChildren();
    if (!projects.length) {
      const empty = element('div', 'list-empty');
      empty.append(element('strong', '', '표시할 프로젝트가 없습니다.'), element('p', '', '검색어나 상태 필터를 바꿔보세요.'));
      container.append(empty);
      return;
    }

    projects
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .forEach((project) => {
        const card = element('article', `project-card ${project.id === state.activeProjectId ? 'active' : ''}`);
        const header = element('div', 'project-card-header');
        const titleWrap = element('div');
        titleWrap.append(element('span', `status-badge project-${project.status}`, PROJECT_STATUS_LABELS[project.status]), element('h2', '', project.name));
        const menu = element('div', 'project-card-actions');
        if (project.status === 'archived') {
          const restore = element('button', 'secondary-button compact', '다시 사용');
          restore.type = 'button'; restore.dataset.projectRestore = project.id;
          menu.append(restore);
        } else {
          const open = element('button', 'primary-button compact', project.id === state.activeProjectId ? '현재 프로젝트' : '이 프로젝트 열기');
          open.type = 'button'; open.dataset.projectOpen = project.id; open.disabled = project.id === state.activeProjectId;
          const duplicate = element('button', 'secondary-button compact', '복사본 만들기');
          duplicate.type = 'button'; duplicate.dataset.projectDuplicate = project.id;
          menu.append(open, duplicate);
        }
        header.append(titleWrap, menu);
        const meta = element('p', 'project-card-meta', [project.client, project.startDate && project.endDate ? `${formatDate(project.startDate)} – ${formatDate(project.endDate)}` : '기간 미설정'].filter(Boolean).join(' · '));
        const progress = Core.getProjectProgress(project);
        const stats = element('div', 'project-stats');
        stats.append(
          statItem('참여자', project.counts.people),
          statItem('시간대', project.counts.sessions),
          statItem('확인 필요', project.counts.unresolved),
          statItem('진행률', `${progress.percent}%`)
        );
        card.append(header, meta, stats);
        container.append(card);
      });
  }

  function statItem(label, value) {
    const item = element('span');
    item.append(element('small', '', label), element('strong', '', String(value)));
    return item;
  }

  function renderModulesPage() {
    const container = $('#moduleCatalog');
    container.replaceChildren();
    const catalog = extensionManifests.length ? extensionManifests.map((manifest) => Core.MODULE_CATALOG.find((item) => item.id === manifest.id) || { ...manifest, page: manifest.contributes?.page, order: manifest.contributes?.order }) : Core.MODULE_CATALOG;
    catalog.forEach((module) => {
      const installed = state.installedExtensions.includes(module.id);
      const card = element('article', `module-card accent-${module.accent}`);
      const icon = element('div', 'module-icon', module.shortName.slice(0, 1));
      const copy = element('div', 'module-card-copy');
      const titleRow = element('div', 'module-title-row');
      titleRow.append(element('h2', '', module.name));
      if (module.core) titleRow.append(element('span', 'core-badge', '핵심'));
      const meta = element('small', 'field-help', `버전 ${module.version || '내장'} · ${module.source === 'local' ? '직접 추가한 프로그램' : '기본 제공'}`);
      copy.append(titleRow, element('p', '', module.description), meta);
      const contributesWorkflow = Boolean(module.page || module.contributes?.workflow);
      const actions = element('div', 'program-actions');
      if (installed && contributesWorkflow) {
        const launch = element('button', 'primary-button compact', '바로 열기'); launch.type = 'button'; launch.dataset.programLaunch = module.id; actions.append(launch);
        const menu = element('details', 'program-menu'); const summary = element('summary', 'secondary-button compact', '⋯'); menu.append(summary);
        const panel = element('div', 'program-menu-panel');
        const desktop = element('button', 'text-button', '바로가기 만들기'); desktop.type = 'button'; desktop.dataset.programShortcut = module.id;
        const removeShortcut = element('button', 'text-button', '바로가기 제거'); removeShortcut.type = 'button'; removeShortcut.dataset.programShortcutRemove = module.id; panel.append(desktop, removeShortcut);
        if (!module.core) { const uninstall = element('button', 'text-button danger-text', '이 프로그램 사용 중지'); uninstall.type = 'button'; uninstall.dataset.moduleToggle = module.id; panel.append(uninstall); }
        if (module.source === 'local') { const removeFile = element('button', 'text-button danger-text', '추가한 프로그램 파일 삭제'); removeFile.type = 'button'; removeFile.dataset.extensionFileRemove = module.id; panel.append(removeFile); }
        menu.append(panel); actions.append(menu);
      } else {
        const action = element('button', 'primary-button compact', contributesWorkflow ? '이 프로그램 사용하기' : '등록됨'); action.type = 'button'; action.dataset.moduleToggle = module.id; action.disabled = !contributesWorkflow; actions.append(action);
      }
      card.append(icon, copy, actions);
      container.append(card);
    });
  }

  function renderDeclarativePage(extensionId = standaloneProgram || currentPage) {
    const manifest = extensionManifests.find((item) => item.id === extensionId);
    const definition = manifest?.declarative;
    const project = activeProject();
    $('#declarativeTitle').textContent = manifest?.name || '확장 프로그램';
    $('#declarativeDescription').textContent = definition?.description || manifest?.description || '안전한 선언형 확장 프로그램입니다.';
    const container = $('#declarativeFields'); container.replaceChildren();
    if (!definition?.fields?.length) { container.append(element('div', 'list-empty', '이 확장 프로그램에 정의된 입력 항목이 없습니다.')); return; }
    const values = project?.data?.extensionData?.[extensionId] || {};
    definition.fields.forEach((field) => {
      const label = element('label', 'form-field'); label.append(document.createTextNode(field.label));
      let control;
      if (field.type === 'textarea') control = document.createElement('textarea');
      else if (field.type === 'select') { control = document.createElement('select'); field.options.forEach((value) => { const option = element('option', '', value); option.value = value; control.append(option); }); }
      else { control = document.createElement('input'); control.type = field.type; }
      control.dataset.declarativeField = field.id; control.required = field.required; control.placeholder = field.placeholder || '';
      if (field.type === 'checkbox') control.checked = Boolean(values[field.id]); else control.value = values[field.id] ?? '';
      label.append(control); container.append(label);
    });
  }

  function renderConnectionsPage() {
    const container = $('#connectionList');
    container.replaceChildren();
    if (!state.connections.length) {
      const empty = element('div', 'list-empty');
      empty.append(element('strong', '', '연결된 계정이 없습니다.'), element('p', '', 'Google 설문·Drive·Gmail·Zoom에 사용할 계정을 용도별로 추가하세요.'));
      container.append(empty);
      return;
    }
    state.connections.forEach((connection) => {
      const type = Core.CONNECTION_TYPES.find((item) => item.id === connection.type);
      const card = element('article', 'connection-card');
      const avatar = element('div', `connection-avatar type-${connection.type}`, type?.provider?.slice(0, 1) || 'A');
      const copy = element('div', 'connection-copy');
      copy.append(element('small', '', type?.name || connection.type), element('h2', '', connection.label), element('p', '', connection.account || '계정 ID 미입력'));
      const stateWrap = element('div', 'connection-state');
      stateWrap.append(element('span', `status-badge ${connection.status}`, connection.status === 'connected' ? '사용 가능' : '로그인 필요'));
      const authorize = element('button', 'secondary-button compact', connection.status === 'connected' ? '다시 로그인' : '로그인하여 연결');
      authorize.type = 'button'; authorize.dataset.connectionAuthorize = connection.id;
      stateWrap.append(authorize);
      if (connection.status === 'connected') {
        const disconnect = element('button', 'text-button', '연결 해제');
        disconnect.type = 'button'; disconnect.dataset.connectionDisconnect = connection.id;
        stateWrap.append(disconnect);
      }
      const remove = element('button', 'text-button danger-text', '삭제');
      remove.type = 'button'; remove.dataset.connectionRemove = connection.id;
      stateWrap.append(remove);
      card.append(avatar, copy, stateWrap);
      container.append(card);
    });
  }

  function renderLibraryPage() {
    const renderItems = (container, items, kind, emptyText) => {
      container.replaceChildren();
      if (!items.length) { container.append(element('div', 'list-empty', emptyText)); return; }
      items.forEach((item) => {
        const row = element('div', 'version-item'); const copy = element('span');
        copy.append(element('strong', '', item.name), element('small', '', `${kind === 'roster' ? `${item.people?.length || 0}명 · ` : ''}${formatUpdatedAt(item.savedAt)}`));
        const actions = element('div', 'button-row');
        const rename = element('button', 'secondary-button compact', '이름 변경'); rename.type = 'button'; rename.dataset.libraryRename = item.id; rename.dataset.libraryKind = kind;
        const duplicate = element('button', 'secondary-button compact', '복제'); duplicate.type = 'button'; duplicate.dataset.libraryDuplicate = item.id; duplicate.dataset.libraryKind = kind;
        const remove = element('button', 'text-button danger-text', '삭제'); remove.type = 'button'; remove.dataset.libraryRemove = item.id; remove.dataset.libraryKind = kind;
        actions.append(rename, duplicate, remove); row.append(copy, actions); container.append(row);
      });
    };
    renderItems($('#libraryMailTemplateList'), state.library.mailTemplates, 'mailTemplate', '저장한 메일 양식이 없습니다. 메일 작성 화면에서 현재 내용을 저장할 수 있습니다.');
    const workflowList = $('#libraryWorkflowTemplateList'); workflowList.replaceChildren();
    state.library.workflowTemplates.slice().sort((a, b) => a.category.localeCompare(b.category, 'ko') || a.name.localeCompare(b.name, 'ko') || b.version - a.version).forEach((template) => {
      const card = element('article', 'template-library-card');
      const meta = element('div', 'template-library-meta'); meta.append(element('span', '', template.category), element('span', '', `v${template.version}${template.builtin ? ' · 기본' : ''}`));
      const title = element('h3', '', template.name); const description = element('p', '', template.description);
      const actions = element('div', 'button-row');
      const use = element('button', 'secondary-button compact', '이 템플릿으로 시작'); use.type = 'button'; use.dataset.templateUse = template.id; actions.append(use);
      if (!template.builtin) { const remove = element('button', 'text-button danger-text', '삭제'); remove.type = 'button'; remove.dataset.workflowTemplateRemove = template.id; actions.append(remove); }
      card.append(meta, title, description, actions); workflowList.append(card);
    });
  }

  function renderQuickTasks() {
    if (!standaloneProgram) return;
    const select = $('#quickTaskSelect'); select.replaceChildren(element('option', '', '현재 빠른 작업'));
    (state.quickTasks?.[standaloneProgram] || []).slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).forEach((task) => { const option = element('option', '', `${task.name} · ${formatUpdatedAt(task.savedAt)}`); option.value = task.id; select.append(option); });
    const projectSelect = $('#standaloneProjectSelect'); projectSelect.replaceChildren(element('option', '', '프로젝트 자료 가져오기'));
    state.projects.filter((item) => item.status !== 'archived').forEach((item) => { const option = element('option', '', item.name); option.value = item.id; projectSelect.append(option); });
    const connected = state.connections.find((item) => item.status === 'connected');
    $('#standaloneConnectionStatus').textContent = standaloneProgram === 'gmailFlow'
      ? (gmailFlowSummary.email || connected?.account || 'Google 계정 연결이 필요합니다.')
      : '현재 작업은 자동 저장됩니다.';
  }

  function syncPersonDerivedFields(project) {
    const data = project.data;
    const nameColumn = data.columns.find((column) => column.type === 'name');
    const emailColumn = data.columns.find((column) => column.type === 'email');
    const phoneColumn = data.columns.find((column) => column.type === 'phone');
    const groupColumn = data.columns.find((column) => column.type === 'group');
    data.people.forEach((person, index) => {
      person.sourceOrder = index;
      person.name = nameColumn ? String(person.values[nameColumn.id] || '').trim() : person.name || '';
      person.email = emailColumn ? String(person.values[emailColumn.id] || '').trim() : '';
      person.phone = phoneColumn ? String(person.values[phoneColumn.id] || '').trim() : '';
      person.group = groupColumn ? String(person.values[groupColumn.id] || '').trim() : '';
    });
  }

  function rosterWarnings(project) {
    const warnings = [];
    const emailSeen = new Map();
    project.data.people.filter((person) => person.active !== false).forEach((person, index) => {
      if (!person.name) warnings.push(`${index + 1}행: 이름이 비어 있습니다.`);
      if (person.email) {
        const email = person.email.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) warnings.push(`${index + 1}행: 이메일 형식을 확인해주세요.`);
        if (emailSeen.has(email)) warnings.push(`${index + 1}행: 이메일이 ${emailSeen.get(email) + 1}행과 중복됩니다.`);
        else emailSeen.set(email, index);
      }
    });
    return warnings;
  }

  function spreadsheetColumnName(index) {
    let result = ''; let value = Number(index) + 1;
    while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
    return result;
  }

  function sheetCellValue(project, row, column) {
    if (row === 0) return project.data.columns[column]?.name || '';
    return project.data.people[row - 1]?.values?.[project.data.columns[column]?.id] ?? '';
  }

  function createBlankRosterPerson(project, rowIndex) {
    return {
      id: `person-${Date.now().toString(36)}-${rowIndex}-${Math.random().toString(36).slice(2, 7)}`,
      sourceOrder: rowIndex,
      values: Object.fromEntries(project.data.columns.map((column) => [column.id, ''])),
      name: '',
      email: '',
      phone: '',
      group: '',
      roleIds: [project.data.roles[0]?.id || 'participant'],
      active: true
    };
  }

  function ensureRosterPerson(project, sheetRow) {
    if (sheetRow <= 0) return null;
    const personIndex = sheetRow - 1;
    while (project.data.people.length <= personIndex) {
      project.data.people.push(createBlankRosterPerson(project, project.data.people.length));
    }
    return project.data.people[personIndex];
  }

  function addRosterColumn(project) {
    const id = `column-${Date.now().toString(36)}-${project.data.columns.length}`;
    project.data.columns.push({ id, name: `컬럼${project.data.columns.length + 1}`, type: 'text' });
    project.data.people.forEach((person) => { person.values[id] = ''; });
    renderPeoplePage();
  }

  function createProjectRole(project, name) {
    const role = { id: `role-${Date.now().toString(36)}-${project.data.roles.length}`, name, candidateFilter: 'all', minPerSession: 0, maxPerSession: 1, targetSessions: 0, active: true, color: '#66717e' };
    project.data.roles.push(role);
    if (project.data.scheduleSheetInitialized && !project.data.scheduleSheetColumns.some((column) => column.roleId === role.id)) {
      project.data.scheduleSheetColumns.push({ id: `schedule-role-${role.id}`, key: `role:${role.id}`, name: role.name, kind: 'role', roleId: role.id });
    }
    return role;
  }

  function setSheetCellValue(project, row, column, value) {
    const definition = project.data.columns[column]; if (!definition) return;
    if (row === 0) definition.name = String(value).trim() || definition.name;
    else {
      const existing = project.data.people[row - 1];
      if (existing || String(value ?? '').length) {
        const person = existing || ensureRosterPerson(project, row);
        person.values[definition.id] = String(value ?? '');
      }
    }
    syncPersonDerivedFields(project);
  }

  function updateRosterSelection(anchor, focus = anchor) {
    rosterSelection = { anchor, focus };
    const minRow = Math.min(anchor.row, focus.row); const maxRow = Math.max(anchor.row, focus.row);
    const minCol = Math.min(anchor.col, focus.col); const maxCol = Math.max(anchor.col, focus.col);
    $$('[data-sheet-row][data-sheet-col]', $('#rosterEditorTable')).forEach((cell) => {
      const row = Number(cell.dataset.sheetRow); const col = Number(cell.dataset.sheetCol);
      cell.classList.toggle('sheet-selected', row >= minRow && row <= maxRow && col >= minCol && col <= maxCol);
      cell.classList.toggle('sheet-anchor', row === anchor.row && col === anchor.col);
    });
    const from = `${spreadsheetColumnName(minCol)}${minRow + 1}`; const to = `${spreadsheetColumnName(maxCol)}${maxRow + 1}`;
    $('#rosterSelectionStatus').textContent = from === to ? from : `${from}:${to}`;
    $('#rosterCellAddress').textContent = `${spreadsheetColumnName(focus.col)}${focus.row + 1}`;
    const project = activeProject(); const formula = $('#rosterCellValue'); formula.disabled = !project; formula.value = project ? sheetCellValue(project, focus.row, focus.col) : '';
  }

  function selectedRosterMatrix(project) {
    if (!rosterSelection) return [];
    const minRow = Math.min(rosterSelection.anchor.row, rosterSelection.focus.row); const maxRow = Math.max(rosterSelection.anchor.row, rosterSelection.focus.row);
    const minCol = Math.min(rosterSelection.anchor.col, rosterSelection.focus.col); const maxCol = Math.max(rosterSelection.anchor.col, rosterSelection.focus.col);
    return Array.from({ length: maxRow - minRow + 1 }, (_, offset) => Array.from({ length: maxCol - minCol + 1 }, (_unused, columnOffset) => sheetCellValue(project, minRow + offset, minCol + columnOffset)));
  }

  function renderPeoplePage() {
    const project = activeProject();
    if (!project) { navigate('dashboard'); return; }
    syncPersonDerivedFields(project);
    const warnings = rosterWarnings(project);
    $('#rosterPeopleMetric').textContent = String(project.data.people.filter((person) => person.active !== false).length);
    $('#rosterColumnMetric').textContent = String(project.data.columns.length);
    $('#rosterWarningMetric').textContent = String(warnings.length);
    $('#rosterImportWarnings').hidden = warnings.length === 0;
    $('#rosterImportWarnings').textContent = warnings.slice(0, 20).join('\n');
    $('#rosterManagerSummary').textContent = project.data.people.length
      ? `${project.data.people.length}명이 연결되어 있습니다. 공용 명단 관리 창에서 수정하면 일정과 메일에도 함께 반영됩니다.`
      : '아직 입력된 사람이 없습니다. 공용 명단 관리 창을 열어 첫 명단을 입력하세요.';
    const summary = $('#rosterColumnSummary');
    summary.replaceChildren(...project.data.columns.map((column) => element('span', 'tag', `${column.name} · ${column.type || '텍스트'}`)));
    renderRosterViews(project);
    return;

    const rosterSelect = $('#sharedRosterSelect'); rosterSelect.replaceChildren(element('option', '', '저장한 명단 선택'));
    state.library.rosters.forEach((roster) => { const option = element('option', '', `${roster.name} · ${roster.people?.length || 0}명`); option.value = roster.id; rosterSelect.append(option); });
    const table = $('#rosterEditorTable');
    if (!project.data.columns.length) {
      const letterRow = element('tr', 'sheet-letter-row'); letterRow.append(element('th', 'sheet-corner', ''), element('th', 'sheet-letter', 'A'));
      const headRow = element('tr'); headRow.append(element('th', 'sheet-row-number', '1'));
      const first = element('th', 'empty-sheet-header'); first.dataset.sheetRow = '0'; first.dataset.sheetCol = '0';
      const add = element('button', 'add-empty-column', '＋ 첫 번째 열 만들기'); add.type = 'button'; add.dataset.emptySheetAddColumn = 'true'; first.append(add); headRow.append(first);
      table.tHead.replaceChildren(letterRow, headRow);
      const rows = Array.from({ length: 5 }, (_, index) => {
        const tr = element('tr'); tr.append(element('th', 'sheet-row-number', String(index + 2)));
        const cell = element('td', 'empty-sheet-cell'); cell.dataset.sheetRow = String(index + 1); cell.dataset.sheetCol = '0';
        const input = element('input'); input.type = 'text'; input.readOnly = true; input.tabIndex = 0; input.placeholder = index === 0 ? '클릭한 뒤 Ctrl+V' : ''; cell.append(input); tr.append(cell); return tr;
      });
      table.tBodies[0].replaceChildren(...rows); rosterSelection = rosterSelection || { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };
      updateRosterSelection(rosterSelection.anchor, rosterSelection.focus); return;
    }
    const letterRow = element('tr', 'sheet-letter-row'); letterRow.append(element('th', 'sheet-corner', ''));
    project.data.columns.forEach((_column, index) => letterRow.append(element('th', 'sheet-letter', spreadsheetColumnName(index))));
    letterRow.append(element('th', 'sheet-letter', spreadsheetColumnName(project.data.columns.length)));
    const headRow = element('tr'); headRow.append(element('th', 'sheet-row-number', '1'));
    project.data.columns.forEach((column, columnIndex) => {
      const th = element('th');
      th.dataset.sheetRow = '0'; th.dataset.sheetCol = String(columnIndex);
      const wrapper = element('div', 'column-head');
      const nameInput = element('input');
      nameInput.type = 'text'; nameInput.value = column.name; nameInput.dataset.columnName = column.id;
      const typeSelect = element('select');
      typeSelect.dataset.columnType = column.id;
      [
        ['name', '이름'], ['email', '수신 이메일'], ['id', '아이디'], ['phone', '전화번호'],
        ['group', '그룹·분류'], ['text', '일반 텍스트'], ['date', '날짜'], ['number', '숫자'], ['url', '링크']
      ].forEach(([value, label]) => {
        const option = element('option', '', label); option.value = value; option.selected = column.type === value; typeSelect.append(option);
      });
      wrapper.append(nameInput, typeSelect); th.append(wrapper); headRow.append(th);
    });
    const addColumnTh = element('th', 'roster-add-column-header');
    const addColumn = element('button', 'roster-add-column', '＋ 컬럼'); addColumn.type = 'button'; addColumn.dataset.rosterAddColumn = 'true';
    addColumnTh.append(addColumn);
    headRow.append(addColumnTh);
    table.tHead.replaceChildren(letterRow, headRow);

    const visibleRows = Math.max(project.data.people.length + 2, 5);
    const rows = Array.from({ length: visibleRows }, (_, rowIndex) => {
      const person = project.data.people[rowIndex] || null;
      const tr = element('tr'); tr.append(element('th', 'sheet-row-number', String(rowIndex + 2)));
      project.data.columns.forEach((column, columnIndex) => {
        const td = element('td');
        td.dataset.sheetRow = String(rowIndex + 1); td.dataset.sheetCol = String(columnIndex);
        const input = element('input');
        input.type = column.type === 'email' ? 'email' : 'text';
        input.value = person?.values?.[column.id] || '';
        input.dataset.personRow = String(rowIndex);
        if (person) input.dataset.personValue = person.id;
        input.dataset.columnId = column.id;
        td.append(input); tr.append(td);
      });
      tr.append(element('td', 'roster-add-column-spacer', ''));
      return tr;
    });
    table.tBodies[0].replaceChildren(...rows);
    if (rosterSelection && [rosterSelection.anchor, rosterSelection.focus].some((point) => point.row > project.data.people.length || point.col >= project.data.columns.length)) rosterSelection = null;
    if (rosterSelection) updateRosterSelection(rosterSelection.anchor, rosterSelection.focus);
    else { $('#rosterSelectionStatus').textContent = '선택 없음'; $('#rosterCellAddress').textContent = '—'; $('#rosterCellValue').value = ''; $('#rosterCellValue').disabled = true; }
  }

  function activeRosterView(project = activeProject()) {
    return project?.data.rosterViews?.find((view) => view.id === project.data.activeRosterViewId) || null;
  }

  function rosterViewIncludedIds(view, project) {
    const source = view ? view.personIds : project.data.people.map((person) => person.id);
    const excluded = new Set(view?.excludedPersonIds || []);
    return source.filter((id) => !excluded.has(id) && project.data.people.some((person) => person.id === id && person.active !== false));
  }

  function renderRosterViews(project) {
    const select = $('#rosterViewSelect'); if (!select) return;
    select.replaceChildren(element('option', '', '원본 명단'));
    project.data.rosterViews.forEach((view) => { const option = element('option', '', view.name); option.value = view.id; select.append(option); });
    select.value = project.data.activeRosterViewId || '';
    const view = activeRosterView(project); const sourceIds = view?.personIds || project.data.people.map((person) => person.id); const excluded = new Set(view?.excludedPersonIds || []);
    $('#saveRosterViewAs').disabled = !project.data.people.length;
    $('#renameRosterView').disabled = !view; $('#deleteRosterView').disabled = !view;
    $('#rosterViewSummary').textContent = view ? `이 명단에는 ${sourceIds.length - excluded.size}명이 포함되어 있고 ${excluded.size}명은 제외되어 있습니다. 원본 명단은 바뀌지 않습니다.` : `현재 원본 명단을 사용하고 있습니다. 인원을 나누려면 새 단계 명단을 만드세요.`;
    const rows = sourceIds.map((id) => project.data.people.find((person) => person.id === id)).filter(Boolean).map((person) => {
      const row = element('div', `roster-view-person${excluded.has(person.id) ? ' excluded' : ''}`);
      const toggle = element('button', 'roster-view-toggle', excluded.has(person.id) ? '↺' : '—'); toggle.type = 'button'; toggle.dataset.rosterViewToggle = person.id; toggle.disabled = !view; toggle.title = excluded.has(person.id) ? '다시 포함' : '이 단계 명단에서 제외';
      const info = element('span'); const group = person.group ? ` · ${person.group}` : ''; info.append(element('strong', '', person.name || '이름 없음'), element('small', '', `${person.email || person.phone || ''}${group}`));
      row.append(toggle, info); return row;
    });
    $('#rosterViewPeople').replaceChildren(...(rows.length ? rows : [element('div', 'list-empty', '원본 명단을 먼저 입력해주세요.')]));
  }

  async function createRosterViewFromCurrent(saveIncludedOnly = false) {
    const project = activeProject(); if (!project?.data.people.length) { showToast('원본 명단을 먼저 입력해주세요.', 'error'); return; }
    const current = activeRosterView(project); const sourceIds = saveIncludedOnly ? rosterViewIncludedIds(current, project) : project.data.people.map((person) => person.id);
    const defaultName = saveIncludedOnly && current ? `${current.name} 다음 단계` : '새 단계 명단';
    const name = await requestName(saveIncludedOnly ? '현재 포함 인원으로 새 단계 명단' : '원본에서 새 단계 명단', defaultName); if (!name) return;
    const now = new Date().toISOString(); const view = { id: `roster-view-${Date.now().toString(36)}`, name, parentId: current?.id || null, personIds: [...sourceIds], excludedPersonIds: [], createdAt: now, updatedAt: now };
    project.data.rosterViews.push(view); project.data.activeRosterViewId = view.id;
    state = Core.updateProject(state, project.id, { data: project.data }); await persist('단계 명단 저장됨'); renderPeoplePage(); showToast(`“${name}” 명단을 ${sourceIds.length}명으로 만들었습니다.`, 'success');
  }

  function activeWorkItem(project = activeProject()) {
    if (!project) return null;
    return project.data.workItems.find((item) => item.id === project.data.activeWorkItemId) || project.data.workItems.at(-1) || null;
  }

  function arrangementCellValue(item, row, column) {
    if (row === -1) return item.columns[column]?.name || '';
    return item.rows[row]?.values?.[item.columns[column]?.id] ?? '';
  }

  function ensureArrangementRow(item, rowIndex) {
    while (item.rows.length <= rowIndex) item.rows.push({ id: `work-row-${Date.now().toString(36)}-${item.rows.length}`, personId: null, values: Object.fromEntries(item.columns.map((column) => [column.id, ''])) });
    return item.rows[rowIndex];
  }

  function setArrangementCellValue(item, row, column, value) {
    const definition = item.columns[column]; if (!definition) return;
    if (row === -1) definition.name = String(value || '').trim() || definition.name;
    else {
      const existing = item.rows[row];
      if (existing || String(value ?? '').length) ensureArrangementRow(item, row).values[definition.id] = String(value ?? '');
    }
    item.updatedAt = new Date().toISOString();
  }

  function shuffled(items) {
    const next = items.slice();
    for (let index = next.length - 1; index > 0; index -= 1) { const random = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1); [next[index], next[random]] = [next[random], next[index]]; }
    return next;
  }

  function arrangeRosterPeople(project, method, sourceColumnId) {
    const people = project.data.people.filter((person) => person.active !== false);
    if (method === 'random') return shuffled(people);
    if (!sourceColumnId || !['same', 'mixed'].includes(method)) return people;
    const valueOf = (person) => String(person.values[sourceColumnId] || '').trim();
    if (method === 'same') return people.slice().sort((a, b) => valueOf(a).localeCompare(valueOf(b), 'ko'));
    const buckets = new Map(); people.forEach((person) => { const key = valueOf(person) || '(값 없음)'; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(person); });
    const mixed = []; const lists = [...buckets.values()];
    while (lists.some((list) => list.length)) lists.forEach((list) => { if (list.length) mixed.push(list.shift()); });
    return mixed;
  }

  function createArrangement(project, values) {
    const type = values.type; const size = type === 'matching' ? 2 : Math.max(1, Number(values.groupSize) || 4);
    const columns = [{ id: `work-group-${Date.now().toString(36)}`, name: type === 'matching' ? '짝' : '그룹' }, ...project.data.columns.map((column) => ({ id: `work-${column.id}-${Date.now().toString(36)}`, sourceColumnId: column.id, name: column.name }))];
    const ordered = arrangeRosterPeople(project, values.method, values.sourceColumnId);
    const rows = ordered.map((person, index) => ({
      id: `work-row-${Date.now().toString(36)}-${index}`,
      personId: person.id,
      values: Object.fromEntries(columns.map((column, columnIndex) => [column.id, columnIndex === 0 ? (values.method === 'manual' || type === 'free' ? '' : `${type === 'matching' ? '짝' : '그룹'} ${Math.floor(index / size) + 1}`) : String(person.values[column.sourceColumnId] ?? '')]))
    }));
    const item = { id: `work-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: values.name, type, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceRosterUpdatedAt: project.updatedAt, settings: { method: values.method, groupSize: size, sourceColumnId: values.sourceColumnId || '' }, columns, rows };
    project.data.workItems.push(item); project.data.activeWorkItemId = item.id; return item;
  }

  function updateArrangementSelection(anchor, focus = anchor) {
    const item = activeWorkItem(); if (!item) return;
    arrangementSelection = { anchor, focus };
    const minRow = Math.min(anchor.row, focus.row); const maxRow = Math.max(anchor.row, focus.row); const minCol = Math.min(anchor.col, focus.col); const maxCol = Math.max(anchor.col, focus.col);
    $$('[data-arrangement-row][data-arrangement-col]', $('#arrangementBoard')).forEach((cell) => {
      const row = Number(cell.dataset.arrangementRow); const col = Number(cell.dataset.arrangementCol);
      cell.classList.toggle('sheet-selected', row >= minRow && row <= maxRow && col >= minCol && col <= maxCol);
      cell.classList.toggle('sheet-anchor', row === anchor.row && col === anchor.col);
    });
    const from = `${spreadsheetColumnName(minCol)}${minRow + 2}`; const to = `${spreadsheetColumnName(maxCol)}${maxRow + 2}`;
    $('#arrangementSelectionStatus').textContent = from === to ? from : `${from}:${to}`;
    $('#arrangementCellAddress').textContent = `${spreadsheetColumnName(focus.col)}${focus.row + 2}`;
    $('#arrangementCellValue').disabled = false; $('#arrangementCellValue').value = arrangementCellValue(item, focus.row, focus.col);
  }

  function selectedArrangementMatrix(item) {
    if (!arrangementSelection) return [];
    const minRow = Math.min(arrangementSelection.anchor.row, arrangementSelection.focus.row); const maxRow = Math.max(arrangementSelection.anchor.row, arrangementSelection.focus.row); const minCol = Math.min(arrangementSelection.anchor.col, arrangementSelection.focus.col); const maxCol = Math.max(arrangementSelection.anchor.col, arrangementSelection.focus.col);
    return Array.from({ length: maxRow - minRow + 1 }, (_, rowOffset) => Array.from({ length: maxCol - minCol + 1 }, (_unused, colOffset) => arrangementCellValue(item, minRow + rowOffset, minCol + colOffset)));
  }

  function renderArrangementPage() {
    const project = activeProject(); const item = activeWorkItem(project);
    if (!project || !item) { navigate('people'); return; }
    project.data.activeWorkItemId = item.id;
    $('#arrangementTitle').textContent = item.name;
    $('#arrangementSummary').textContent = `이 작업표는 원본 명단과 별도로 저장됩니다.`;
    const select = $('#arrangementSelect'); select.replaceChildren(...project.data.workItems.map((work) => { const option = element('option', '', work.name); option.value = work.id; option.selected = work.id === item.id; return option; }));
    const table = $('#arrangementBoard'); const letterRow = element('tr', 'sheet-letter-row'); letterRow.append(element('th', 'sheet-corner', ''));
    item.columns.forEach((_column, index) => letterRow.append(element('th', 'sheet-letter', spreadsheetColumnName(index)))); letterRow.append(element('th', 'sheet-letter', spreadsheetColumnName(item.columns.length)));
    const headerRow = element('tr'); headerRow.append(element('th', 'sheet-row-number', '1'));
    item.columns.forEach((column, index) => { const th = element('th', 'arrangement-column-header'); th.dataset.arrangementRow = '-1'; th.dataset.arrangementCol = String(index); const name = element('button', 'arrangement-column-name', column.name); name.type = 'button'; name.dataset.arrangementRenameColumn = column.id; const remove = element('button', 'arrangement-column-remove', '×'); remove.type = 'button'; remove.dataset.arrangementRemoveColumn = column.id; th.append(name, remove); headerRow.append(th); });
    const addTh = element('th', 'arrangement-add-column'); const add = element('button', '', '＋ 컬럼'); add.type = 'button'; add.dataset.arrangementAddColumn = 'true'; addTh.append(add); headerRow.append(addTh); table.tHead.replaceChildren(letterRow, headerRow);
    const visibleRows = Math.max(item.rows.length + 2, 5); const rows = Array.from({ length: visibleRows }, (_, rowIndex) => { const tr = element('tr'); tr.append(element('th', 'sheet-row-number', String(rowIndex + 2))); item.columns.forEach((column, colIndex) => { const td = element('td'); td.dataset.arrangementRow = String(rowIndex); td.dataset.arrangementCol = String(colIndex); const input = element('input'); input.type = 'text'; input.value = item.rows[rowIndex]?.values?.[column.id] || ''; input.dataset.arrangementInput = 'true'; td.append(input); tr.append(td); }); tr.append(element('td', 'roster-add-column-spacer', '')); return tr; });
    table.tBodies[0].replaceChildren(...rows);
    if (arrangementSelection && arrangementSelection.focus.col < item.columns.length) updateArrangementSelection(arrangementSelection.anchor, arrangementSelection.focus); else { arrangementSelection = null; $('#arrangementSelectionStatus').textContent = '선택 없음'; $('#arrangementCellAddress').textContent = '—'; $('#arrangementCellValue').value = ''; $('#arrangementCellValue').disabled = true; }
  }

  function openArrangementSetup(type = 'grouping') {
    const project = activeProject(); if (!project?.data.people.length) { showToast('먼저 명단을 입력해주세요.', 'error'); return; }
    const labels = { grouping: '그룹 나누기', matching: '짝·1대1 연결', free: '빈 작업표 만들기' };
    $('#arrangementType').value = type; $('#arrangementSetupTitle').textContent = labels[type]; $('#arrangementName').value = `${labels[type]} ${project.data.workItems.length + 1}`; $('#arrangementGroupSize').value = type === 'matching' ? '2' : '4'; $('#arrangementGroupSize').disabled = type === 'matching'; $('#arrangementMethod').value = type === 'free' ? 'manual' : 'sequential';
    const source = $('#arrangementSourceColumn'); source.replaceChildren(element('option', '', '기준 없음'), ...project.data.columns.map((column) => { const option = element('option', '', column.name); option.value = column.id; return option; })); source.firstElementChild.value = ''; source.disabled = true;
    openDialog('arrangementSetupDialog');
  }

  function openRosterTaskChooser() {
    const project = activeProject(); if (!project?.data.people.length) { showToast('먼저 명단을 입력해주세요.', 'error'); return; }
    const section = $('#existingArrangementSection'); const list = $('#existingArrangementList'); section.hidden = !project.data.workItems.length;
    list.replaceChildren(...project.data.workItems.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((item) => { const button = element('button', '', `${item.name} · ${item.rows.length}행`); button.type = 'button'; button.dataset.openArrangement = item.id; return button; }));
    openDialog('rosterTaskChooserDialog');
  }

  function renderRoleEditor(project) {
    const container = $('#roleEditor');
    container.replaceChildren();
    project.data.roles.forEach((role) => {
      const row = element('div', 'role-row'); row.dataset.roleRow = role.id;
      const candidate = element('label', '', '이 역할에 넣을 사람'); const candidateSelect = element('select'); candidateSelect.dataset.roleField = 'candidateFilter'; candidateSelect.dataset.roleId = role.id;
      const choices = [{ value: 'all', label: '전체 명단' }, { value: 'manual', label: '기존 직접 지정' }];
      project.data.columns.forEach((column) => { const values = [...new Set(project.data.people.map((person) => String(person.values[column.id] || '').trim()).filter(Boolean))].slice(0, 80); values.forEach((value) => choices.push({ value: `column:${column.id}:${encodeURIComponent(value)}`, label: `${column.name} = ${value}` })); });
      choices.forEach((choice) => { const option = element('option', '', choice.label); option.value = choice.value; option.selected = role.candidateFilter === choice.value; candidateSelect.append(option); }); candidate.append(candidateSelect);
      const fields = [
        ['역할 이름', 'text', 'name', role.name],
        ['시간대별 최소', 'number', 'minPerSession', role.minPerSession],
        ['시간대별 최대', 'number', 'maxPerSession', role.maxPerSession],
        ['한 사람당 횟수', 'number', 'targetSessions', role.targetSessions]
      ];
      fields.forEach(([label, type, field, value]) => {
        const wrapper = element('label', '', label); const input = element('input'); input.type = type; input.value = String(value); input.dataset.roleField = field; input.dataset.roleId = role.id; if (type === 'number') input.min = '0'; wrapper.append(input); row.append(wrapper);
      });
      row.insertBefore(candidate, row.children[1] || null);
      const remove = element('button', 'role-delete', '×'); remove.type = 'button'; remove.title = '역할 삭제'; remove.dataset.roleRemove = role.id; remove.disabled = project.data.roles.length <= 1;
      row.append(remove); container.append(row);
    });
  }

  function roleCandidates(project, role) {
    const active = project.data.people.filter((person) => person.active !== false); const filter = role.candidateFilter || 'manual';
    if (filter === 'all') return active;
    if (filter.startsWith('column:')) { const [, columnId, encoded = ''] = filter.split(':'); const expected = decodeURIComponent(encoded); return active.filter((person) => String(person.values[columnId] || '').trim() === expected); }
    return active.filter((person) => (person.roleIds || []).includes(role.id));
  }

  function schedulePeopleWithRoleFilters(project) {
    const view = project.data.rosterViews.find((item) => item.id === project.data.scheduleRules.rosterViewId) || null; const included = new Set(rosterViewIncludedIds(view, project));
    return project.data.people.filter((person) => included.has(person.id)).map((person) => ({ ...person, roleIds: project.data.roles.filter((role) => roleCandidates(project, role).some((candidate) => candidate.id === person.id)).map((role) => role.id) }));
  }

  function renderAvailability(project) {
    const container = $('#availabilityMatrix');
    if (!project.data.people.length || !project.data.slots.length) {
      container.replaceChildren(element('div', 'list-empty', !project.data.people.length ? '명단을 먼저 등록해주세요.' : '시간대를 먼저 추가해주세요.'));
      return;
    }
    const table = element('table', 'availability-table');
    const head = element('thead'); const headRow = element('tr');
    headRow.append(element('th', '', '이름 / 전체'));
    project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).forEach((slot) => {
      const th = element('th', 'slot-heading'); th.textContent = `${slot.date}\n${slot.startTime}–${slot.endTime}`; headRow.append(th);
    });
    head.append(headRow); table.append(head);
    const body = element('tbody');
    const scheduleView = project.data.rosterViews.find((view) => view.id === project.data.scheduleRules.rosterViewId) || null; const scheduleIds = new Set(rosterViewIncludedIds(scheduleView, project));
    project.data.people.filter((person) => person.active !== false && scheduleIds.has(person.id)).forEach((person) => {
      const row = element('tr');
      const nameCell = element('td');
      const allLabel = element('label', 'check-row');
      const all = element('input'); all.type = 'checkbox'; all.dataset.availabilityAll = person.id;
      const selected = project.data.availability[person.id] || [];
      all.checked = project.data.slots.length > 0 && project.data.slots.every((slot) => selected.includes(slot.id));
      allLabel.append(all, document.createTextNode(person.name || '이름 없음')); nameCell.append(allLabel); row.append(nameCell);
      project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).forEach((slot) => {
        const cell = element('td'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.includes(slot.id); checkbox.dataset.availabilityPerson = person.id; checkbox.dataset.availabilitySlot = slot.id; cell.append(checkbox); row.append(cell);
      });
      body.append(row);
    });
    table.append(body); container.replaceChildren(table);
  }

  function scheduleSheetColumns(project) {
    if (!project.data.scheduleSheetInitialized) {
      project.data.scheduleSheetColumns = [
        { id: 'schedule-date', key: 'date', name: '날짜', kind: 'system', roleId: null },
        { id: 'schedule-start', key: 'startTime', name: '시작', kind: 'system', roleId: null },
        { id: 'schedule-end', key: 'endTime', name: '종료', kind: 'system', roleId: null },
        { id: 'schedule-label', key: 'label', name: '세션명', kind: 'system', roleId: null },
        ...project.data.roles.filter((role) => role.active).map((role) => ({ id: `schedule-role-${role.id}`, key: `role:${role.id}`, name: role.name, kind: 'role', roleId: role.id })),
        { id: 'schedule-status', key: 'status', name: '상태', kind: 'system', roleId: null },
        { id: 'schedule-locked', key: 'locked', name: '잠금', kind: 'system', roleId: null }
      ];
      project.data.scheduleCustomValues ||= {}; project.data.scheduleSheetInitialized = true;
    }
    project.data.scheduleSheetColumns ||= []; project.data.scheduleCustomValues ||= {};
    return project.data.scheduleSheetColumns.map((column) => ({ ...column, label: column.name, role: column.roleId ? project.data.roles.find((role) => role.id === column.roleId) : null }));
  }

  function scheduleCellValue(project, rowIndex, columnIndex) {
    const slot = project.data.slots[rowIndex];
    const column = scheduleSheetColumns(project)[columnIndex]; if (!slot || !column) return '';
    if (column.kind === 'role' && column.role) {
      return project.data.assignments.filter((item) => item.slotId === slot.id && item.roleId === column.role.id)
        .map((item) => project.data.people.find((person) => person.id === item.personId && person.active !== false)?.name || (!item.personId ? item.personName : '')).filter(Boolean).join(', ');
    }
    if (column.kind === 'custom') return project.data.scheduleCustomValues?.[slot.id]?.[column.id] || '';
    if (column.key === 'locked') return slot.locked ? '예' : '';
    if (column.key === 'status') return ({ draft: '편성 중', confirmed: '확정', changed: '변경됨', cancelled: '취소' })[slot.status] || slot.status || '편성 중';
    return slot[column.key] || '';
  }

  function ensureScheduleRow(project, rowIndex) {
    if (project.data.slots[rowIndex]) return project.data.slots[rowIndex];
    while (project.data.slots.length <= rowIndex) { const index = project.data.slots.length; project.data.slots.push({ id: `slot-${Date.now().toString(36)}-${index}`, date: '', startTime: '', endTime: '', label: '', status: 'draft', locked: false }); }
    return project.data.slots[rowIndex];
  }

  function peopleTokens(value) {
    return String(value || '').split(/[\n,;]+/).map((name) => name.trim()).filter(Boolean);
  }

  function scheduleSheetConflicts(project) {
    const messages = []; const keys = new Set(scheduleSheetColumns(project).map((column) => column.key));
    if (!keys.has('date') || !keys.has('startTime') || !keys.has('endTime')) messages.push({ type: 'sheet', message: 'Zoom·메일 일정 연결을 사용하려면 날짜·시작·종료 컬럼을 추가하거나 해당 헤더가 있는 표를 붙여넣어주세요.' });
    project.data.slots.forEach((slot, index) => {
      if (keys.has('date') && !/^\d{4}-\d{2}-\d{2}$/.test(slot.date || '')) messages.push({ type: 'sheet', message: `${index + 2}행: 날짜를 YYYY-MM-DD 형식으로 입력해주세요.` });
      if ((keys.has('startTime') && !/^\d{2}:\d{2}$/.test(slot.startTime || '')) || (keys.has('endTime') && !/^\d{2}:\d{2}$/.test(slot.endTime || ''))) messages.push({ type: 'sheet', message: `${index + 2}행: 시작·종료 시간을 HH:MM 형식으로 입력해주세요.` });
    });
    project.data.assignments.forEach((assignment) => {
      if (!assignment.personId) messages.push({ type: 'sheet', message: `명단에 없는 사람 “${assignment.personName || '이름 없음'}”이 일정표에 있습니다.` });
    });
    return messages;
  }

  function refreshScheduleConflicts(project) {
    project.data.conflicts = [
      ...scheduleSheetConflicts(project),
      ...Ops.validateAssignments({ assignments: project.data.assignments, people: project.data.people, roles: project.data.roles, slots: project.data.slots }).map((message) => ({ type: 'validation', message }))
    ];
  }

  function setScheduleCellValue(project, rowIndex, columnIndex, value) {
    const slot = ensureScheduleRow(project, rowIndex); const column = scheduleSheetColumns(project)[columnIndex]; if (!column) return;
    const text = String(value ?? '').trim();
    if (column.kind === 'role' && column.role) {
      project.data.assignments = project.data.assignments.filter((item) => !(item.slotId === slot.id && item.roleId === column.role.id));
      peopleTokens(text).forEach((name, position) => {
        const lowered = name.toLowerCase();
        const person = project.data.people.find((item) => [item.name, item.email, item.phone].some((candidate) => String(candidate || '').toLowerCase() === lowered));
        project.data.assignments.push({ id: `assignment-${Date.now().toString(36)}-${rowIndex}-${position}`, slotId: slot.id, personId: person?.id || '', personName: person?.name || name, roleId: column.role.id, roleName: column.role.name, locked: Boolean(slot.locked), source: 'manual-sheet' });
      });
    } else if (column.kind === 'custom') {
      project.data.scheduleCustomValues[slot.id] ||= {}; project.data.scheduleCustomValues[slot.id][column.id] = String(value ?? '');
    } else if (column.key === 'status') {
      const statusMap = { '편성 중': 'draft', '초안': 'draft', draft: 'draft', '확정': 'confirmed', confirmed: 'confirmed', '변경됨': 'changed', changed: 'changed', '취소': 'cancelled', cancelled: 'cancelled' };
      slot.status = statusMap[text] || text || 'draft';
    } else if (column.key === 'locked') {
      slot.locked = /^(예|y|yes|true|1|잠금)$/i.test(text); project.data.assignments.filter((item) => item.slotId === slot.id).forEach((item) => { item.locked = slot.locked; });
    } else slot[column.key] = text;
    refreshScheduleConflicts(project);
  }

  function scheduleSnapshot(project) {
    return JSON.stringify({ slots: project.data.slots, assignments: project.data.assignments, conflicts: project.data.conflicts, scheduleSheetInitialized: project.data.scheduleSheetInitialized, scheduleSheetColumns: project.data.scheduleSheetColumns, scheduleCustomValues: project.data.scheduleCustomValues });
  }

  function restoreScheduleSnapshot(project, snapshot) {
    const data = JSON.parse(snapshot); project.data.slots = data.slots; project.data.assignments = data.assignments; project.data.conflicts = data.conflicts; project.data.scheduleSheetInitialized = data.scheduleSheetInitialized; project.data.scheduleSheetColumns = data.scheduleSheetColumns; project.data.scheduleCustomValues = data.scheduleCustomValues;
  }

  function pushScheduleHistory(project) {
    scheduleHistory.push(scheduleSnapshot(project)); if (scheduleHistory.length > 80) scheduleHistory.shift(); scheduleFuture = [];
  }

  function queueSchedulePersist(project, message = '일정 셀 편집 저장됨') {
    clearTimeout(schedulePersistTimer); schedulePersistTimer = setTimeout(async () => {
      state = Core.updateProject(state, project.id, { data: project.data });
      state = Core.setModuleStatus(state, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'inProgress', `직접 편집 · 문제 ${project.data.conflicts.length}건`);
      await persist(message); renderDashboard();
    }, 450);
  }

  function updateScheduleSelection(anchor, focus = anchor, mode = scheduleSelection?.mode || 'cells') {
    scheduleSelection = { anchor, focus, mode }; const project = activeProject(); if (!project) return;
    const minRow = Math.min(anchor.row, focus.row); const maxRow = Math.max(anchor.row, focus.row); const minCol = Math.min(anchor.col, focus.col); const maxCol = Math.max(anchor.col, focus.col);
    $$('[data-schedule-row][data-schedule-col]', $('#scheduleBoard')).forEach((cell) => {
      const row = Number(cell.dataset.scheduleRow); const col = Number(cell.dataset.scheduleCol);
      cell.classList.toggle('sheet-selected', row >= minRow && row <= maxRow && col >= minCol && col <= maxCol); cell.classList.toggle('sheet-anchor', row === anchor.row && col === anchor.col);
    });
    $$('[data-select-schedule-row]', $('#scheduleBoard')).forEach((cell) => { const row = Number(cell.dataset.selectScheduleRow); cell.classList.toggle('sheet-row-selected', mode === 'row' && row >= minRow && row <= maxRow); });
    $$('[data-select-schedule-column]', $('#scheduleBoard')).forEach((cell) => { const col = Number(cell.dataset.selectScheduleColumn); cell.classList.toggle('sheet-row-selected', mode === 'column' && col >= minCol && col <= maxCol); });
    $('#scheduleBoard [data-select-schedule-all]')?.classList.toggle('sheet-row-selected', mode === 'all');
    const address = (row, col) => `${spreadsheetColumnName(col)}${row + 2}`; const from = address(minRow, minCol); const to = address(maxRow, maxCol);
    $('#scheduleSelectionStatus').textContent = from === to ? from : `${from}:${to}`; $('#scheduleCellAddress').textContent = address(focus.row, focus.col);
    const column = scheduleSheetColumns(project)[focus.col]; $('#scheduleCellValue').disabled = !column; $('#scheduleCellValue').value = focus.row === -1 ? column?.name || '' : scheduleCellValue(project, focus.row, focus.col);
  }

  function selectedScheduleMatrix(project) {
    if (!scheduleSelection) return [];
    const minRow = Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row); const maxRow = Math.max(scheduleSelection.anchor.row, scheduleSelection.focus.row); const minCol = Math.min(scheduleSelection.anchor.col, scheduleSelection.focus.col); const maxCol = Math.max(scheduleSelection.anchor.col, scheduleSelection.focus.col); const columns = scheduleSheetColumns(project);
    return Array.from({ length: maxRow - minRow + 1 }, (_, row) => Array.from({ length: maxCol - minCol + 1 }, (_unused, col) => minRow + row === -1 ? columns[minCol + col]?.name || '' : scheduleCellValue(project, minRow + row, minCol + col)));
  }

  function focusScheduleCell(row, col, extend = false) {
    const project = activeProject(); if (!project) return; const visibleRows = Math.max(project.data.slots.length + 2, 5);
    const point = { row: Math.max(0, Math.min(visibleRows - 1, row)), col: Math.max(0, Math.min(scheduleSheetColumns(project).length - 1, col)) };
    updateScheduleSelection(extend && scheduleSelection ? scheduleSelection.anchor : point, point);
    const input = $(`[data-schedule-row="${point.row}"][data-schedule-col="${point.col}"] input`, $('#scheduleBoard')); input?.focus(); input?.select();
  }

  function renderScheduleBoard(project) {
    const table = $('#scheduleBoard'); const columns = scheduleSheetColumns(project); const sortedSlots = project.data.slots;
    const letters = element('tr', 'sheet-letter-row'); const corner = element('th', 'sheet-corner', ''); corner.dataset.selectScheduleAll = 'true'; letters.append(corner);
    columns.forEach((_column, index) => { const th = element('th', 'sheet-letter', spreadsheetColumnName(index)); th.dataset.selectScheduleColumn = String(index); letters.append(th); });
    letters.append(element('th', 'sheet-letter schedule-add-column-letter', spreadsheetColumnName(columns.length)));
    const headers = element('tr'); headers.append(element('th', 'sheet-row-number', '1'));
    columns.forEach((column, columnIndex) => { const th = element('th', 'schedule-column-header'); th.dataset.scheduleRow = '-1'; th.dataset.scheduleCol = String(columnIndex); th.dataset.scheduleHeader = column.key; const name = element('button', 'schedule-column-name', column.name); name.type = 'button'; name.dataset.scheduleRenameColumn = column.id; name.title = '드래그하여 선택 · 더블클릭하여 컬럼 이름 변경'; const remove = element('button', 'schedule-column-remove', '×'); remove.type = 'button'; remove.dataset.scheduleRemoveColumn = column.id; remove.title = '컬럼 삭제'; th.append(name, remove); headers.append(th); });
    const plusHeader = element('th', 'schedule-inline-add'); const plusColumn = element('button', 'add-empty-column', '＋ 컬럼'); plusColumn.type = 'button'; plusColumn.dataset.scheduleAddColumnInline = 'true'; plusHeader.append(plusColumn); headers.append(plusHeader); table.tHead.replaceChildren(letters, headers);
    const visibleRows = Math.max(sortedSlots.length + 2, 5); const rows = Array.from({ length: visibleRows }, (_, rowIndex) => {
      const slot = sortedSlots[rowIndex]; const tr = element('tr'); if (slot) tr.dataset.scheduleSlot = slot.id; const number = element('th', 'sheet-row-number', String(rowIndex + 2)); number.dataset.selectScheduleRow = String(rowIndex); tr.append(number);
      columns.forEach((column, columnIndex) => {
        const td = element('td', column.role ? 'schedule-role-cell' : ''); td.dataset.scheduleRow = String(rowIndex); td.dataset.scheduleCol = String(columnIndex);
        const input = element('input'); input.type = 'text'; input.value = scheduleCellValue(project, rowIndex, columnIndex); input.dataset.scheduleInput = 'true'; input.autocomplete = 'off';
        if (column.role) { input.setAttribute('list', `schedule-role-${column.role.id}`); const unknown = peopleTokens(input.value).some((name) => !project.data.people.some((person) => [person.name, person.email, person.phone].includes(name))); td.classList.toggle('schedule-invalid', unknown); }
        td.append(input); tr.append(td);
      });
      if (!columns.length) { const td = element('td', 'empty-sheet-cell'); td.dataset.scheduleRow = String(rowIndex); td.dataset.scheduleCol = '0'; const input = element('input'); input.type = 'text'; input.dataset.scheduleInput = 'true'; input.dataset.schedulePasteAnchor = 'true'; input.placeholder = rowIndex === 0 ? '첫 셀에 표를 붙여넣으세요' : ''; td.append(input); tr.append(td); }
      const trailing = element('td', 'schedule-trailing-cell'); tr.append(trailing); return tr;
    });
    table.tBodies[0].replaceChildren(...rows);
    project.data.roles.filter((role) => role.active).forEach((role) => {
      let list = document.getElementById(`schedule-role-${role.id}`); if (!list) { list = element('datalist'); list.id = `schedule-role-${role.id}`; document.body.append(list); }
      list.replaceChildren(...roleCandidates(project, role).map((person) => { const option = element('option'); option.value = person.name; return option; }));
    });
    const conflicts = project.data.conflicts || []; $('#scheduleConflicts').hidden = conflicts.length === 0; $('#scheduleConflicts').textContent = conflicts.slice(0, 30).map((conflict) => `• ${conflict.message}`).join('\n');
    $('#scheduleBoardSummary').textContent = conflicts.length ? `현재 일정표에서 확인할 문제가 ${conflicts.length}건 있습니다.` : '현재 일정표에서 확인할 문제가 없습니다.';
    if (scheduleSelection && columns.length) updateScheduleSelection({ row: Math.min(scheduleSelection.anchor.row, visibleRows - 1), col: Math.min(scheduleSelection.anchor.col, columns.length - 1) }, { row: Math.min(scheduleSelection.focus.row, visibleRows - 1), col: Math.min(scheduleSelection.focus.col, columns.length - 1) }, scheduleSelection.mode);
    else { scheduleSelection = null; $('#scheduleSelectionStatus').textContent = '선택 없음'; $('#scheduleCellAddress').textContent = '—'; $('#scheduleCellValue').value = ''; $('#scheduleCellValue').disabled = true; }
    $('#scheduleUndo').disabled = !scheduleHistory.length; $('#scheduleRedo').disabled = !scheduleFuture.length;
    renderSessionPlanner(project);
  }

  function sessionRosterPeople(project) {
    const viewId = $('#sessionRosterView')?.value || project.data.scheduleRules.rosterViewId || '';
    const view = project.data.rosterViews.find((item) => item.id === viewId) || null;
    const ids = new Set(rosterViewIncludedIds(view, project));
    const group = $('#sessionGroupFilter')?.value || '';
    return project.data.people.filter((person) => person.active !== false && ids.has(person.id) && (!group || person.group === group));
  }

  function renderSessionPlanner(project) {
    const viewSelect = $('#sessionRosterView'); const previousView = viewSelect.value || project.data.scheduleRules.rosterViewId || '';
    viewSelect.replaceChildren(element('option', '', '원본 명단'));
    project.data.rosterViews.forEach((view) => { const option = element('option', '', view.name); option.value = view.id; viewSelect.append(option); });
    viewSelect.value = project.data.rosterViews.some((view) => view.id === previousView) ? previousView : '';
    const roleSelect = $('#sessionRoleSelect'); const previousRole = roleSelect.value; roleSelect.replaceChildren(...project.data.roles.filter((role) => role.active).map((role) => { const option = element('option', '', role.name); option.value = role.id; return option; })); if ([...roleSelect.options].some((option) => option.value === previousRole)) roleSelect.value = previousRole;
    const groupSelect = $('#sessionGroupFilter'); const previousGroup = groupSelect.value; groupSelect.replaceChildren(element('option', '', '전체'));
    [...new Set(project.data.people.map((person) => person.group).filter(Boolean))].sort().forEach((group) => { const option = element('option', '', group); option.value = group; groupSelect.append(option); }); groupSelect.value = [...groupSelect.options].some((option) => option.value === previousGroup) ? previousGroup : '';
    const dateSelect = $('#sessionDateFilter'); const previousDate = dateSelect.value; dateSelect.replaceChildren(element('option', '', '전체 날짜'));
    [...new Set(project.data.slots.map((slot) => slot.date).filter(Boolean))].sort().forEach((date) => { const option = element('option', '', formatDate(date)); option.value = date; dateSelect.append(option); }); dateSelect.value = [...dateSelect.options].some((option) => option.value === previousDate) ? previousDate : '';
    const people = sessionRosterPeople(project); const pool = $('#sessionPersonPool');
    pool.replaceChildren(...(people.length ? people.map((person) => { const chip = element('button', `session-person-chip${selectedSessionPersonId === person.id ? ' selected' : ''}`); chip.type = 'button'; chip.draggable = true; chip.dataset.sessionPerson = person.id; chip.title = '끌어서 세션에 배정'; chip.append(element('strong', '', person.name || '이름 없음'), element('small', '', person.group || person.email || '')); return chip; }) : [element('div', 'list-empty', '선택한 단계 명단에 포함된 사람이 없습니다.')]));
    const visibleDate = dateSelect.value; const slots = project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).filter((slot) => !visibleDate || slot.date === visibleDate);
    const byDate = new Map(); slots.forEach((slot) => { if (!byDate.has(slot.date || '날짜 미정')) byDate.set(slot.date || '날짜 미정', []); byDate.get(slot.date || '날짜 미정').push(slot); });
    const board = $('#sessionCalendarBoard'); const columns = [...byDate.entries()].map(([date, dateSlots]) => {
      const column = element('section', 'session-date-column'); column.append(element('h3', '', date === '날짜 미정' ? date : formatDate(date)));
      dateSlots.forEach((slot) => {
        const card = element('article', `session-slot-card status-${slot.status || 'draft'}`); card.dataset.sessionSlot = slot.id; card.tabIndex = 0;
        const heading = element('div', 'session-slot-heading'); const title = element('span'); title.append(element('strong', '', `${slot.startTime || '--:--'}–${slot.endTime || '--:--'}`), element('small', '', slot.label || '이름 없는 세션'));
        const actions = element('span', 'session-slot-actions'); const edit = element('button', '', '시간 변경'); edit.type = 'button'; edit.dataset.sessionEdit = slot.id; const remove = element('button', '', '×'); remove.type = 'button'; remove.dataset.sessionRemove = slot.id; remove.title = '세션 삭제'; actions.append(edit, remove); heading.append(title, actions); card.append(heading);
        const assignments = element('div', 'session-assignments');
        project.data.assignments.filter((assignment) => assignment.slotId === slot.id).forEach((assignment) => { const person = project.data.people.find((item) => item.id === assignment.personId); if (!person || person.active === false) return; const chip = element('div', 'session-assignment-chip'); chip.draggable = true; chip.dataset.sessionAssignment = assignment.id; chip.dataset.sessionPerson = person.id; chip.append(element('span', '', `${person.name || '이름 없음'} · ${project.data.roles.find((role) => role.id === assignment.roleId)?.name || assignment.roleName || '참여'}`)); const eject = element('button', '', '×'); eject.type = 'button'; eject.dataset.sessionUnassign = assignment.id; eject.title = '이 세션에서 빼기'; chip.append(eject); assignments.append(chip); });
        if (!assignments.children.length) assignments.append(element('div', 'session-drop-hint', '인원을 여기에 놓으세요'));
        card.append(assignments); column.append(card);
      }); return column;
    });
    const emptyDrop = element('button', 'session-empty-drop', '＋ 빈 시간에 놓기'); emptyDrop.type = 'button'; emptyDrop.dataset.sessionEmptyDrop = 'true'; emptyDrop.title = '인원을 놓으면 날짜와 시간을 입력합니다.';
    board.replaceChildren(...columns, emptyDrop);
    $('#sessionBoardStatus').textContent = people.length ? `선택한 명단의 ${people[0].name || '첫 번째 사람'}${people.length > 1 ? ` 외 ${people.length - 1}명` : ''}을 배정할 수 있습니다.` : '선택한 명단에 배정할 사람이 없습니다.';
  }

  async function assignPersonToSession(personId, slotId, assignmentId = '') {
    const project = activeProject(); const person = project?.data.people.find((item) => item.id === personId); const slot = project?.data.slots.find((item) => item.id === slotId); if (!project || !person || !slot) return;
    pushScheduleHistory(project);
    const existing = assignmentId ? project.data.assignments.find((item) => item.id === assignmentId) : null;
    if (project.data.assignments.some((item) => item.slotId === slotId && item.personId === personId && item.id !== assignmentId)) { showToast('이미 이 세션에 배정된 사람입니다.'); return; }
    if (existing) existing.slotId = slotId;
    else { const selectedRole = $('#sessionRoleSelect')?.value; const role = project.data.roles.find((item) => item.id === selectedRole && item.active) || project.data.roles.find((item) => item.active && roleCandidates(project, item).some((candidate) => candidate.id === personId)) || project.data.roles.find((item) => item.active); project.data.assignments.push({ id: `assignment-${Date.now().toString(36)}`, slotId, personId, roleId: role?.id || '', roleName: role?.name || '참여', locked: false, source: 'session-board' }); }
    if (slot.status === 'confirmed') slot.status = 'changed'; refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); await persist('세션 인원 배정 변경됨'); renderSchedulePage();
  }

  async function addSessionFromText(defaultValue = '') {
    const project = activeProject(); if (!project) return null; const value = await requestName('새 세션 날짜·시간', defaultValue || `${new Date().toISOString().slice(0, 10)} 09:00-10:00 새 세션`); if (!value) return null;
    const parsed = Ops.parseSlots(value); if (!parsed.slots.length) { showToast(parsed.errors[0] || '예: 2026-08-20 09:00-10:00 필기 교육', 'error'); return null; }
    pushScheduleHistory(project); const slot = parsed.slots[0]; project.data.slots.push(slot); refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); await persist('새 세션 추가됨'); renderSchedulePage(); return slot;
  }

  function renderSchedulePage() {
    const project = activeProject();
    if (!project) { navigate('dashboard'); return; }
    renderRoleEditor(project);
    $('#ruleAvoidRepeat').checked = project.data.scheduleRules.avoidRepeatPairing;
    $('#ruleAvoidPast').checked = project.data.scheduleRules.avoidPastPairing;
    $('#ruleGroupPreference').value = project.data.scheduleRules.groupPreference;
    $('#ruleUnmarkedAvailable').checked = project.data.scheduleRules.unmarkedMeansAvailable;
    renderAvailability(project);
    renderScheduleBoard(project);
    const schedulePeople = project.data.people.filter((person) => person.active !== false);
    $('#scheduleProjectRosterStatus').textContent = schedulePeople.length ? `${schedulePeople[0].name || '첫 번째 사람'}${schedulePeople.length > 1 ? ` 외 ${schedulePeople.length - 1}명` : ''}이 배정 후보로 연결되어 있습니다.` : '명단 가져오기를 눌러 배정할 사람을 준비해주세요.';
  }

  function scheduleHeaderKey(value, project) {
    const text = String(value || '').trim(); const normalized = text.toLowerCase().replace(/[\s_.·-]/g, '');
    const aliases = {
      날짜: 'date', date: 'date', 일자: 'date', 시작: 'startTime', 시작시간: 'startTime', start: 'startTime', starttime: 'startTime',
      종료: 'endTime', 종료시간: 'endTime', end: 'endTime', endtime: 'endTime', 세션: 'label', 세션명: 'label', 일정: 'label', 일정명: 'label', title: 'label',
      상태: 'status', status: 'status', 잠금: 'locked', lock: 'locked', locked: 'locked'
    };
    if (aliases[normalized]) return aliases[normalized];
    const role = project.data.roles.find((item) => item.name.toLowerCase().replace(/[\s_.·-]/g, '') === normalized); return role ? `role:${role.id}` : '';
  }

  function looksLikeScheduleHeader(matrix) {
    if (!matrix?.length) return false; const first = matrix[0].map((value) => String(value || '').trim()); const width = Math.max(...matrix.map((row) => row.length));
    const dataLike = (value) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}:\d{2}$|^https?:\/\//i.test(value);
    return first.filter(Boolean).length >= Math.ceil(width * 0.6) && new Set(first.filter(Boolean).map((value) => value.toLowerCase())).size === first.filter(Boolean).length && !first.some(dataLike);
  }

  function inferredScheduleColumns(matrix, project, hasHeader) {
    const width = Math.max(...matrix.map((row) => row.length)); const headers = hasHeader ? matrix[0] : Array.from({ length: width }, (_, index) => `컬럼${index + 1}`); const rows = hasHeader ? matrix.slice(1) : matrix;
    const usedKeys = new Set(); let timeCount = 0;
    return Array.from({ length: width }, (_, index) => {
      const header = String(headers[index] || `컬럼${index + 1}`).trim() || `컬럼${index + 1}`; let key = scheduleHeaderKey(header, project);
      if (!key && !hasHeader) {
        const values = rows.map((row) => String(row[index] || '').trim()).filter(Boolean); const dateMatches = values.filter((value) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value)).length; const timeMatches = values.filter((value) => /^\d{1,2}:\d{2}$/.test(value)).length;
        if (values.length && dateMatches >= Math.ceil(values.length * .7) && !usedKeys.has('date')) key = 'date';
        else if (values.length && timeMatches >= Math.ceil(values.length * .7)) { timeCount += 1; key = timeCount === 1 ? 'startTime' : timeCount === 2 ? 'endTime' : ''; }
      }
      if (key && usedKeys.has(key)) key = ''; if (key) usedKeys.add(key);
      const roleId = key?.startsWith('role:') ? key.slice(5) : null;
      return { id: `schedule-column-${Date.now().toString(36)}-${index}`, key: key || `custom:import-${Date.now().toString(36)}-${index}`, name: hasHeader ? header : ({ date: '날짜', startTime: '시작', endTime: '종료' })[key] || header, kind: roleId ? 'role' : key ? 'system' : 'custom', roleId };
    });
  }

  async function importScheduleMatrix(matrix, mode = 'replace') {
    const project = activeProject(); if (!project || !matrix?.length) return;
    const hasHeader = looksLikeScheduleHeader(matrix); const importedColumns = inferredScheduleColumns(matrix, project, hasHeader);
    if (mode === 'replace' && project.data.slots.length && !await showConfirm('현재 일정표를 Excel 시트 내용으로 교체할까요? 기존 상태는 실행 취소로 되돌릴 수 있습니다.', { title: '일정표 교체', action: '교체' })) return;
    pushScheduleHistory(project);
    if (mode === 'replace') { project.data.slots = []; project.data.assignments = []; project.data.conflicts = []; project.data.scheduleCustomValues = {}; project.data.scheduleSheetColumns = importedColumns; project.data.scheduleSheetInitialized = true; }
    else {
      const current = scheduleSheetColumns(project); importedColumns.forEach((column) => { if (!current.some((item) => item.key === column.key || item.name.toLowerCase() === column.name.toLowerCase())) project.data.scheduleSheetColumns.push(column); });
    }
    const rows = (hasHeader ? matrix.slice(1) : matrix).filter((row) => row.some((value) => String(value || '').trim())); const targetColumns = scheduleSheetColumns(project); const mappedIndexes = importedColumns.map((column) => targetColumns.findIndex((item) => item.key === column.key || item.name.toLowerCase() === column.name.toLowerCase()));
    const startRow = project.data.slots.length;
    rows.forEach((row, rowOffset) => {
      row.forEach((value, columnIndex) => {
        const actualColumn = mappedIndexes[columnIndex]; if (actualColumn >= 0) setScheduleCellValue(project, startRow + rowOffset, actualColumn, value);
      });
    });
    refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); await persist('Excel 일정 가져옴'); renderAll(); navigate('schedule');
    showToast(`${importedColumns.length}열 × ${rows.length}행을 자동 감지해 일정표에 가져왔습니다.`, project.data.conflicts.length ? 'normal' : 'success');
  }

  async function addScheduleColumn() {
    const project = activeProject(); if (!project) return; const name = await requestName('추가할 일정표 컬럼 이름', `새 컬럼 ${scheduleSheetColumns(project).length + 1}`); if (!name?.trim()) return;
    pushScheduleHistory(project); const id = `schedule-column-${Date.now().toString(36)}`; const cleanName = name.trim().replace(/[{}]/g, ''); let key = scheduleHeaderKey(cleanName, project); if (project.data.scheduleSheetColumns.some((column) => column.key === key)) key = ''; const roleId = key.startsWith('role:') ? key.slice(5) : null; project.data.scheduleSheetColumns.push({ id, key: key || `custom:${id}`, name: cleanName, kind: roleId ? 'role' : key ? 'system' : 'custom', roleId }); refreshScheduleConflicts(project);
    state = Core.updateProject(state, project.id, { data: project.data }); await persist('일정 컬럼 추가됨'); renderSchedulePage();
  }

  async function renameScheduleColumn(columnId) {
    const project = activeProject(); const column = project?.data.scheduleSheetColumns.find((item) => item.id === columnId); if (!column) return; const name = await requestName('일정표 컬럼 이름 변경', column.name); if (!name?.trim()) return;
    pushScheduleHistory(project); column.name = name.trim().replace(/[{}]/g, ''); if (column.kind === 'custom') { let key = scheduleHeaderKey(column.name, project); if (project.data.scheduleSheetColumns.some((item) => item.id !== column.id && item.key === key)) key = ''; if (key) { column.key = key; column.roleId = key.startsWith('role:') ? key.slice(5) : null; column.kind = column.roleId ? 'role' : 'system'; } } refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); await persist('일정 컬럼 이름 변경됨'); renderSchedulePage();
  }

  async function removeScheduleColumn(columnId) {
    const project = activeProject(); const column = project?.data.scheduleSheetColumns.find((item) => item.id === columnId); if (!column) return;
    if (!await showConfirm(`“${column.name}” 컬럼을 표에서 삭제할까요?${column.kind === 'custom' ? ' 이 컬럼의 셀 값도 삭제됩니다.' : ' 연결된 원본 일정 데이터는 유지됩니다.'}`, { title: '일정표 컬럼 삭제', action: '삭제' })) return;
    pushScheduleHistory(project); project.data.scheduleSheetColumns = project.data.scheduleSheetColumns.filter((item) => item.id !== columnId);
    if (column.kind === 'custom') Object.values(project.data.scheduleCustomValues || {}).forEach((values) => { delete values[column.id]; });
    refreshScheduleConflicts(project); scheduleSelection = null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('일정 컬럼 삭제됨'); renderSchedulePage();
  }

  async function insertScheduleRow(afterIndex = null) {
    const project = activeProject(); if (!project) return; pushScheduleHistory(project); const index = afterIndex == null ? project.data.slots.length : Math.min(project.data.slots.length, Number(afterIndex) + 1);
    const slot = { id: `slot-${Date.now().toString(36)}-${index}`, date: '', startTime: '', endTime: '', label: '', status: 'draft', locked: false }; project.data.slots.splice(index, 0, slot); refreshScheduleConflicts(project);
    state = Core.updateProject(state, project.id, { data: project.data }); await persist('일정 행 추가됨'); renderSchedulePage(); focusScheduleCell(index, 0);
  }

  async function mergeScheduleRoster(rosterId) {
    const project = activeProject(); const roster = state.library.rosters.find((item) => item.id === rosterId); if (!project || !roster) { showToast('추가할 전역 저장 명단을 선택해주세요.', 'error'); return; }
    const columnMap = new Map(); (roster.columns || []).forEach((sourceColumn) => { let target = project.data.columns.find((column) => column.name.trim().toLowerCase() === sourceColumn.name.trim().toLowerCase()); if (!target) { target = { ...JSON.parse(JSON.stringify(sourceColumn)), id: `column-${Date.now().toString(36)}-${project.data.columns.length}` }; project.data.columns.push(target); project.data.people.forEach((person) => { person.values[target.id] = ''; }); } columnMap.set(sourceColumn.id, target.id); });
    const existing = new Set(project.data.people.map((person) => String(person.email || person.phone || person.name || '').trim().toLowerCase()).filter(Boolean)); let added = 0;
    (roster.people || []).forEach((source) => { const key = String(source.email || source.phone || source.name || '').trim().toLowerCase(); if (key && existing.has(key)) return; const person = JSON.parse(JSON.stringify(source)); person.id = `person-${Date.now().toString(36)}-${added}`; person.sourceOrder = project.data.people.length; person.values = Object.fromEntries(project.data.columns.map((column) => [column.id, ''])); Object.entries(source.values || {}).forEach(([sourceId, value]) => { const targetId = columnMap.get(sourceId); if (targetId) person.values[targetId] = value; }); if (!person.roleIds?.length || !person.roleIds.some((id) => project.data.roles.some((role) => role.id === id))) person.roleIds = [project.data.roles[0]?.id || 'participant']; project.data.people.push(person); if (key) existing.add(key); added += 1; }); syncPersonDerivedFields(project);
    state = Core.updateProject(state, project.id, { data: project.data }); await persist('전역 명단 배정 후보 추가됨'); renderAll(); navigate('schedule'); showToast(`${roster.name}에서 중복을 제외한 ${added}명을 배정 후보에 추가했습니다.`, 'success');
  }

  async function deleteSelectedScheduleRows() {
    const project = activeProject(); if (!project || !scheduleSelection) return;
    if (['column', 'all'].includes(scheduleSelection.mode)) { showToast('행 번호를 선택한 뒤 행 삭제를 눌러주세요. 컬럼은 제목 오른쪽 ×로 삭제합니다.', 'error'); return; }
    const min = Math.max(0, Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row)); const max = Math.max(scheduleSelection.anchor.row, scheduleSelection.focus.row);
    const targets = project.data.slots.slice(min, max + 1);
    if (!targets.length) return; if (targets.some((slot) => slot.locked)) { showToast('잠긴 행이 포함되어 있습니다. 잠금 셀을 지운 뒤 삭제해주세요.', 'error'); return; }
    pushScheduleHistory(project); const ids = new Set(targets.map((slot) => slot.id)); project.data.slots = project.data.slots.filter((slot) => !ids.has(slot.id)); project.data.assignments = project.data.assignments.filter((item) => !ids.has(item.slotId));
    Object.keys(project.data.availability).forEach((personId) => { project.data.availability[personId] = project.data.availability[personId].filter((id) => !ids.has(id)); });
    refreshScheduleConflicts(project); scheduleSelection = null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('일정 행 삭제됨'); renderSchedulePage();
  }

  function scheduleClipboardHtml(matrix) {
    const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</table>`;
  }

  function renderLayoutPage() {
    const project = activeProject();
    if (!project) { navigate('dashboard'); return; }
    $('#layoutType').value = project.data.layout.type;
    const versions = $('#scheduleVersionList');
    versions.replaceChildren();
    if (!project.data.versions.length) versions.append(element('div', 'list-empty', '저장된 일정 버전이 없습니다.'));
    project.data.versions.slice().reverse().forEach((version, reverseIndex) => {
      const item = element('div', 'version-item'); const copy = element('span');
      copy.append(element('strong', '', version.name), element('small', '', formatUpdatedAt(version.createdAt)));
      const restore = element('button', 'secondary-button compact', '이 일정으로 되돌리기'); restore.type = 'button'; restore.dataset.versionRestore = String(project.data.versions.length - 1 - reverseIndex); item.append(copy, restore); versions.append(item);
    });
    const table = $('#outputPreviewTable');
    const headers = ['날짜', '시작', '종료', '세션명', '역할', '이름', '상태'];
    const head = element('tr'); headers.forEach((label) => head.append(element('th', '', label))); table.tHead.replaceChildren(head);
    const personMap = new Map(project.data.people.map((person) => [person.id, person]));
    const roleMap = new Map(project.data.roles.map((role) => [role.id, role]));
    const rows = [];
    project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).forEach((slot) => {
      const assignments = project.data.assignments.filter((assignment) => assignment.slotId === slot.id);
      (assignments.length ? assignments : [null]).forEach((assignment) => {
        const row = element('tr');
        [slot.date, slot.startTime, slot.endTime, slot.label || '', assignment ? roleMap.get(assignment.roleId)?.name || '' : '', assignment ? personMap.get(assignment.personId)?.name || '' : '', slot.status].forEach((value) => row.append(element('td', '', value)));
        rows.push(row);
      });
    });
    table.tBodies[0].replaceChildren(...rows);
  }

  function renderFormsPage() {
    const project = activeProject(); if (!project) { navigate('dashboard'); return; }
    const definition = project.data.forms.definitions.at(-1);
    const preview = $('#formDefinitionPreview'); preview.replaceChildren();
    if (!definition) { preview.append(element('div', 'list-empty', '아직 미리 만든 설문이 없습니다. 위에서 받을 정보를 선택하고 “설문 내용 미리 만들기”를 누르세요.')); return; }
    const heading = element('div', 'form-preview-heading');
    heading.append(element('span', 'status-badge inProgress', definition.type === 'availability' ? '가능 시간 조사' : '신청자 정보'), element('h2', '', definition.title), element('p', '', definition.description));
    preview.append(heading);
    definition.questions.forEach((question, index) => {
      const card = element('div', 'form-question');
      card.append(element('small', '', `질문 ${index + 1}${question.required ? ' · 필수' : ''}`), element('strong', '', question.title));
      if (question.options?.length) {
        const options = element('div', 'form-options');
        question.options.forEach((option) => options.append(element('span', '', `□ ${option.value}`)));
        card.append(options);
      } else card.append(element('span', 'fake-input', '', ''));
      preview.append(card);
    });
  }

  function renderZoomPage() {
    const project = activeProject(); if (!project) { navigate('dashboard'); return; }
    const zoomConnections = state.connections.filter((connection) => connection.type === 'zoom');
    const defaultId = defaultConnectionId(project, 'zoom');
    const defaultConnection = zoomConnections.find((connection) => connection.id === defaultId);
    $('#zoomReadiness').textContent = !zoomConnections.length
      ? '사용할 Zoom 계정이 없습니다. “사용할 Zoom 계정 확인”에서 먼저 계정을 연결하세요.'
      : !defaultConnection
        ? `연결해 둔 Zoom 계정은 ${zoomConnections.length}개지만 이 프로젝트의 기본 계정이 없습니다. 아래 일정마다 계정을 선택하거나 프로젝트 설정에서 기본값을 지정하세요.`
        : defaultConnection.status !== 'connected'
          ? `기본 계정 “${defaultConnection.label}”에 다시 로그인해야 합니다. 어떤 회의를 만들지는 확인할 수 있지만 실제 생성은 되지 않습니다.`
          : `Zoom 회의는 기본 계정 “${defaultConnection.label}”으로 생성됩니다.`;
    const table = $('#zoomPlanTable'); const head = element('tr');
    ['날짜', '시간', '세션명', '생성 계정', '회의 상태', '참가 링크'].forEach((label) => head.append(element('th', '', label))); table.tHead.replaceChildren(head);
    const rows = project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).map((slot) => {
      const row = element('tr'); row.append(element('td', '', slot.date), element('td', '', `${slot.startTime}–${slot.endTime}`), element('td', '', slot.label || ''));
      const accountCell = element('td'); const select = element('select'); select.dataset.zoomSlotConnection = slot.id;
      const inherit = element('option', '', defaultConnection ? `기본값 · ${defaultConnection.label}` : '계정 선택 필요'); inherit.value = ''; select.append(inherit);
      zoomConnections.forEach((connection) => { const option = element('option', '', `${connection.label}${connection.status !== 'connected' ? ' · 로그인 필요' : ''}`); option.value = connection.id; option.selected = slot.zoomConnectionId === connection.id; select.append(option); }); accountCell.append(select); row.append(accountCell);
      const artifact = project.data.externalArtifacts.find((item) => item.kind === 'zoom' && item.slotId === slot.id);
      row.append(element('td', '', artifact?.status === 'created' ? '만들기 완료' : artifact?.status === 'stale' ? '일정 변경 확인 필요' : '아직 만들지 않음'), element('td', '', artifact?.joinUrl || ''));
      return row;
    }); table.tBodies[0].replaceChildren(...rows);
  }

  const RICH_TAGS = new Set(['A', 'B', 'BLOCKQUOTE', 'BR', 'COL', 'COLGROUP', 'DIV', 'EM', 'FONT', 'H1', 'H2', 'H3', 'H4', 'HR', 'I', 'LI', 'OL', 'P', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL']);
  const RICH_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'LINK', 'META', 'SVG', 'MATH']);
  const RICH_STYLES = new Set(['background', 'background-color', 'border', 'border-bottom', 'border-bottom-color', 'border-bottom-style', 'border-bottom-width', 'border-collapse', 'border-color', 'border-left', 'border-left-color', 'border-left-style', 'border-left-width', 'border-right', 'border-right-color', 'border-right-style', 'border-right-width', 'border-style', 'border-top', 'border-top-color', 'border-top-style', 'border-top-width', 'border-width', 'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'height', 'line-height', 'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top', 'text-align', 'text-decoration', 'vertical-align', 'white-space', 'width']);

  function applyClipboardClassStyles(doc) {
    const rules = new Map();
    doc.querySelectorAll('style').forEach((style) => {
      String(style.textContent || '').matchAll(/\.([\w-]+)\s*\{([^}]+)\}/g).forEach((match) => rules.set(match[1], `${rules.get(match[1]) || ''};${match[2]}`));
    });
    doc.querySelectorAll('[class]').forEach((node) => {
      const combined = [...node.classList].map((name) => rules.get(name) || '').join(';');
      if (combined) node.setAttribute('style', `${combined};${node.getAttribute('style') || ''}`);
    });
  }

  function safeStyle(value) {
    return String(value || '').split(';').map((declaration) => {
      const split = declaration.indexOf(':'); if (split < 1) return '';
      const property = declaration.slice(0, split).trim().toLowerCase(); const content = declaration.slice(split + 1).trim();
      if (!RICH_STYLES.has(property) || /url\s*\(|expression\s*\(|javascript\s*:/i.test(content)) return '';
      return `${property}:${content}`;
    }).filter(Boolean).join(';');
  }

  function sanitizeRichHtml(value) {
    const raw = String(value || '');
    const styles = [...raw.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((match) => match[0]).join('');
    const marked = raw.match(/<!--\s*StartFragment\s*-->([\s\S]*?)<!--\s*EndFragment\s*-->/i)?.[1];
    const body = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    const content = marked || body || raw;
    const doc = new DOMParser().parseFromString(`${styles}<div id="cmoe-rich-root">${content}</div>`, 'text/html');
    applyClipboardClassStyles(doc);
    const root = doc.querySelector('#cmoe-rich-root');
    [...root.querySelectorAll('*')].reverse().forEach((node) => {
      if (RICH_DROP_TAGS.has(node.tagName)) { node.remove(); return; }
      if (!RICH_TAGS.has(node.tagName)) { node.replaceWith(...node.childNodes); return; }
      [...node.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        if (name === 'style') { const cleaned = safeStyle(attribute.value); if (cleaned) node.setAttribute('style', cleaned); else node.removeAttribute(attribute.name); return; }
        if (['colspan', 'rowspan', 'width', 'height'].includes(name)) return;
        if (name === 'href' && node.tagName === 'A' && /^(https?:|mailto:)/i.test(attribute.value)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); return; }
        node.removeAttribute(attribute.name);
      });
    });
    return root.innerHTML;
  }

  function richText(value) {
    const doc = new DOMParser().parseFromString(`<div>${String(value || '')}</div>`, 'text/html');
    doc.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
    doc.querySelectorAll('p,div,tr,li').forEach((node) => node.append('\n'));
    return String(doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function plainToHtml(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  async function openRelatedProgram(targetId) {
    if (!state.installedExtensions.includes(targetId)) { showToast('해당 프로그램을 먼저 설치해주세요.', 'error'); if (!standaloneProgram) navigate('modules'); else await globalThis.workspaceDesktop.openWorkspace(); return; }
    if (targetId === 'people') { await openRosterManager(); return; }
    if (!standaloneProgram) { navigate(targetId); return; }
    const source = activeProject(); const target = state.quickWorkspaces[targetId];
    if (source && target && source.id !== target.id) {
      const targetHasData = target.data.people.length || target.data.slots.length || target.data.assignments.length;
      if (targetHasData && !await showConfirm(`${Core.MODULE_CATALOG.find((item) => item.id === targetId)?.name || '다음 프로그램'}에서 작업 중이던 내용을 현재 자료로 바꿀까요? 별도로 저장한 자료는 그대로 유지됩니다.`, { title: '현재 자료로 계속 작업', action: '자료 가져오기', danger: false })) return;
      const sourceData = source.data; const nextData = JSON.parse(JSON.stringify(target.data));
      nextData.columns = JSON.parse(JSON.stringify(sourceData.columns)); nextData.people = JSON.parse(JSON.stringify(sourceData.people));
      if (['schedule', 'layout', 'zoom', 'gmailFlow'].includes(targetId)) { nextData.roles = JSON.parse(JSON.stringify(sourceData.roles)); nextData.slots = JSON.parse(JSON.stringify(sourceData.slots)); nextData.availability = JSON.parse(JSON.stringify(sourceData.availability)); nextData.assignments = JSON.parse(JSON.stringify(sourceData.assignments)); nextData.conflicts = JSON.parse(JSON.stringify(sourceData.conflicts)); }
      if (['layout', 'zoom', 'gmailFlow'].includes(targetId)) nextData.externalArtifacts = JSON.parse(JSON.stringify(sourceData.externalArtifacts));
      state = Core.updateProject(state, target.id, { data: nextData }); await persist('작업 전달됨');
    }
    await globalThis.workspaceDesktop.openProgram(targetId);
  }

  function bindRichEditor(editor) {
    editor.addEventListener('paste', (event) => {
      const html = event.clipboardData?.getData('text/html'); if (!html) return;
      event.preventDefault(); document.execCommand('insertHTML', false, sanitizeRichHtml(html));
    });
    editor.addEventListener('drop', (event) => event.preventDefault());
  }

  function templateVariableNames(project) {
    return [...new Set(['프로젝트', '이름', '이메일', '개인일정', ...project.data.columns.map((column) => column.name).filter(Boolean)])];
  }

  function renderTemplateVariables(project, { paletteId = 'templateVariablePalette', statusId = 'templateTokenStatus', subjectId = 'mailSubjectTemplate', bodyId = 'mailBodyEditor' } = {}) {
    const validNames = templateVariableNames(project); const valid = new Set(validNames);
    const palette = $(`#${paletteId}`); const status = $(`#${statusId}`); if (!palette || !status) return;
    palette.replaceChildren(...validNames.map((name) => { const button = element('button', 'variable-chip valid', `{${name}}`); button.type = 'button'; button.dataset.templateToken = name; button.dataset.templateTargetGroup = paletteId.startsWith('mailEdit') ? 'edit' : 'main'; return button; }));
    const subject = $(`#${subjectId}`)?.value || ''; const body = $(`#${bodyId}`)?.innerText || '';
    const used = [...new Set([...`${subject}\n${body}`.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1].trim()).filter(Boolean))];
    status.replaceChildren();
    if (!used.length) { status.append(element('span', 'variable-empty', '아직 입력된 {변수}가 없습니다.')); return; }
    used.forEach((name) => { const chip = element('span', `variable-chip ${valid.has(name) ? 'valid' : 'invalid'}`, `{${name}}`); chip.title = valid.has(name) ? '명단에 있는 열 또는 기본 항목' : '현재 명단에 없는 항목'; status.append(chip); });
  }

  function insertTemplateToken(name, group) {
    const fallback = group === 'edit' ? 'mailEditBody' : 'mailBodyEditor';
    const allowed = group === 'edit' ? ['mailEditSubject', 'mailEditBody'] : ['mailSubjectTemplate', 'mailBodyEditor'];
    const targetId = allowed.includes(templateInsertionTarget) ? templateInsertionTarget : fallback;
    const target = $(`#${targetId}`); const token = `{${name}}`; if (!target) return;
    target.focus();
    if (target.matches('input, textarea')) {
      const start = target.selectionStart ?? target.value.length; const end = target.selectionEnd ?? start;
      target.setRangeText(token, start, end, 'end'); target.dispatchEvent(new Event('input', { bubbles: true }));
    } else { document.execCommand('insertText', false, token); target.dispatchEvent(new Event('input', { bubbles: true })); }
    const project = activeProject(); if (project) renderTemplateVariables(project, group === 'edit' ? { paletteId: 'mailEditVariablePalette', statusId: 'mailEditTokenStatus', subjectId: 'mailEditSubject', bodyId: 'mailEditBody' } : {});
  }

  function renderGmailPage() {
    const project = activeProject(); if (!project) { navigate('dashboard'); return; }
    const workspaceGmail = state.connections.find((connection) => connection.type === 'gmail' && connection.status === 'connected');
    const connectedEmail = gmailFlowSummary.email || workspaceGmail?.account || '';
    const accountButton = $('#gmailFlowAccountButton');
    accountButton.classList.toggle('connected', Boolean(connectedEmail));
    accountButton.classList.toggle('needs-auth', !connectedEmail);
    $('#gmailFlowAccountAvatar').textContent = connectedEmail ? connectedEmail.slice(0, 1).toUpperCase() : 'G';
    $('#gmailFlowAccountText').textContent = connectedEmail || 'Google 계정 연결 필요';
    $('#gmailFlowAccountStatus').textContent = gmailFlowSummary.connected
      ? '메일을 보낼 계정으로 연결되어 있습니다.'
      : workspaceGmail ? 'Workspace Gmail 연결됨 · Gmail Flow에서 계정을 확인하세요' : 'Gmail Flow를 열어 Google 계정에 로그인하세요';
    renderMailRosterResource(project);
    if (!mailEditorDirty) {
      $('#mailSubjectTemplate').value = project.data.communication.subjectTemplate;
      $('#mailBodyTemplate').value = project.data.communication.bodyTemplate;
      $('#mailBodyEditor').innerHTML = sanitizeRichHtml(project.data.communication.bodyHtmlTemplate || plainToHtml(project.data.communication.bodyTemplate));
    }
    const templateSelect = $('#sharedMailTemplateSelect'); templateSelect.replaceChildren(element('option', '', '저장한 메일 양식 선택'));
    state.library.mailTemplates.forEach((template) => { const option = element('option', '', template.name); option.value = template.id; templateSelect.append(option); });
    renderTemplateVariables(project);
    const pkg = Ops.buildMailPackage(project);
    const empty = pkg.entries.filter((entry) => !entry.assignments.length).length;
    const missingZoom = pkg.entries.filter((entry) => entry.assignments.some((assignment) => !assignment.zoomJoinUrl)).length;
    $('#mailReadinessText').textContent = !pkg.entries.length
      ? '받는 사람 명단을 먼저 가져와주세요.'
      : empty || missingZoom
        ? `${pkg.entries[0]?.name || '받는 사람'}${pkg.entries.length > 1 ? ` 외 ${pkg.entries.length - 1}명` : ''}에게 보낼 예정입니다.${empty ? ` 일정이 없는 사람 ${empty}명을 확인해주세요.` : ''}${missingZoom ? ` Zoom 링크가 없는 사람 ${missingZoom}명을 확인해주세요.` : ''}`
        : `${pkg.entries[0]?.name || '받는 사람'}${pkg.entries.length > 1 ? ` 외 ${pkg.entries.length - 1}명` : ''}의 명단과 일정 연결을 확인했습니다.`;
    $('#mailPackageStatus').textContent = project.data.communication.lastPreparedAt ? `마지막 준비: ${formatUpdatedAt(project.data.communication.lastPreparedAt)}` : '메일 데이터를 준비하기 전입니다.';
    const table = $('#mailPreviewTable'); const head = element('tr'); ['이름', '이메일', '제목', '일정 수', '본문 미리보기', '상태', '수정'].forEach((label) => head.append(element('th', '', label))); table.tHead.replaceChildren(head);
    const rows = pkg.entries.map((entry) => {
      const row = element('tr'); [entry.name, entry.email, entry.subject, String(entry.assignments.length), entry.body.slice(0, 180)].forEach((value) => row.append(element('td', '', value)));
      const artifact = project.data.externalArtifacts.find((item) => item.kind === 'gmailDraft' && item.personId === entry.personId);
      row.append(element('td', '', artifact?.status === 'created' ? (entry.edited ? '개별 수정 반영됨' : 'Gmail 임시보관함에 저장됨') : artifact?.status === 'stale' ? 'Gmail 내용 다시 저장 필요' : entry.edited ? '이 사람만 수정됨' : '확인 가능'));
      const actionCell = element('td'); const edit = element('button', 'secondary-button compact', '이 사람 메일 수정'); edit.type = 'button'; edit.dataset.mailEdit = entry.personId; actionCell.append(edit); row.append(actionCell); return row;
    });
    table.tBodies[0].replaceChildren(...rows);
  }

  function renderMailRosterResource(project) {
    const people = (project?.data.people || []).filter((person) => person.active !== false);
    const summary = $('#mailRosterSummary'); const preview = $('#mailRosterPeople');
    if (!summary || !preview) return;
    if (!people.length) {
      summary.textContent = '받는 사람 명단이 없습니다.';
      preview.replaceChildren(element('span', 'resource-empty', '명단 가져오기를 눌러 준비해주세요.'));
      return;
    }
    const named = people.filter((person) => person.name || person.email);
    summary.textContent = project?.data.rosterName || (named.length ? `${named[0].name || named[0].email}${named.length > 1 ? ` 외 ${named.length - 1}명` : ''}` : '적용된 명단');
    const chips = named.slice(0, 6).map((person) => element('span', 'resource-chip', person.name || person.email));
    if (named.length > 6) chips.push(element('span', 'resource-chip more', `＋${named.length - 6}`));
    preview.replaceChildren(...chips);
  }

  function formAnswerValues(response, questionId) {
    const answer = response.answers?.[questionId];
    return answer?.textAnswers?.answers?.map((item) => String(item.value || '').trim()).filter(Boolean) || [];
  }

  function formQuestionIndex(form) {
    const byTitle = new Map();
    (form.items || []).forEach((item) => {
      const id = item.questionItem?.question?.questionId;
      if (id) byTitle.set(String(item.title || '').trim(), id);
    });
    return byTitle;
  }

  function applyFormResponses(project, linked, payload) {
    const questions = formQuestionIndex(payload.form);
    if (linked.type === 'registration') {
      const headers = ['성함', '휴대폰 번호', '이메일 주소', '소속·분류'];
      const matrix = [headers, ...payload.responses.map((response) => headers.map((title) => formAnswerValues(response, questions.get(title))[0] || (title === '이메일 주소' ? response.respondentEmail || '' : '')))];
      const imported = Ops.matrixToRoster(matrix);
      const existingByEmail = new Map(project.data.people.filter((person) => person.email).map((person) => [person.email.toLowerCase(), person]));
      const existingByName = new Map(project.data.people.filter((person) => person.name).map((person) => [person.name, person]));
      if (!project.data.columns.length) project.data.columns = imported.columns;
      const columnByType = new Map(project.data.columns.map((column) => [column.type, column]));
      imported.people.forEach((incoming) => {
        const target = existingByEmail.get(incoming.email.toLowerCase()) || existingByName.get(incoming.name);
        if (target) {
          ['name', 'phone', 'email', 'group'].forEach((type) => { const column = columnByType.get(type); if (column && incoming[type]) target.values[column.id] = incoming[type]; target[type] = incoming[type] || target[type]; });
        } else {
          const values = {};
          project.data.columns.forEach((column) => { values[column.id] = incoming[column.type] || ''; });
          project.data.people.push({ ...incoming, id: `person-${crypto.randomUUID()}`, sourceOrder: project.data.people.length, values });
        }
      });
      return { changed: imported.people.length, message: `${imported.people.length}명의 신청자 정보를 병합했습니다.` };
    }
    const nameId = linked.questionIds?.name || questions.get('성함');
    const participantId = linked.questionIds?.participantId || questions.get('참여자 고유번호');
    const slotsId = linked.questionIds?.slots || questions.get('참여 가능한 시간');
    let changed = 0; let unmatched = 0;
    payload.responses.forEach((response) => {
      const rawId = formAnswerValues(response, participantId)[0];
      const name = formAnswerValues(response, nameId)[0];
      const email = String(response.respondentEmail || '').toLowerCase();
      const person = project.data.people.find((item) => item.id === rawId) || project.data.people.find((item) => email && item.email.toLowerCase() === email) || project.data.people.find((item) => item.name === name);
      if (!person) { unmatched += 1; return; }
      project.data.availability[person.id] = formAnswerValues(response, slotsId).map((value) => value.match(/^\[([^\]]+)\]/)?.[1]).filter((slotId) => project.data.slots.some((slot) => slot.id === slotId));
      changed += 1;
    });
    return { changed, message: `${changed}명의 가능 시간을 반영했습니다.${unmatched ? ` 일치하지 않은 응답 ${unmatched}건은 확인이 필요합니다.` : ''}` };
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = element('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderSettings() {
    $('#storageMode').value = state.preferences.storageMode || 'local';
    $('#driveSyncStatus').textContent = state.preferences.lastDriveSyncAt ? `마지막 Drive 저장: ${formatUpdatedAt(state.preferences.lastDriveSyncAt)}` : 'Google Drive에 연결한 계정이 있어야 사용할 수 있습니다.';
    $('#showArchivedSetting').checked = Boolean(state.preferences.showArchivedProjects);
    $('#toggleArchived').textContent = state.preferences.showArchivedProjects ? '진행만' : '보관함';
  }

  function renderAll() {
    state = Core.normalizeState(state);
    if (!standaloneProgram) { renderProjectSwitcher(); renderSidebarProjects(); renderDashboard(); }
    renderSettings();
    renderQuickTasks();
    if (currentPage === 'projects') renderProjectsPage();
    if (currentPage === 'modules') renderModulesPage();
    if (currentPage === 'connections') renderConnectionsPage();
    if (currentPage === 'library') renderLibraryPage();
    if (currentPage === 'people') renderPeoplePage();
    if (currentPage === 'arrange') renderArrangementPage();
    if (currentPage === 'schedule') renderSchedulePage();
    if (currentPage === 'layout') renderLayoutPage();
    if (currentPage === 'forms') renderFormsPage();
    if (currentPage === 'zoom') renderZoomPage();
    if (currentPage === 'gmailFlow') renderGmailPage();
    if (currentPage === 'workflowTask') renderWorkflowTaskPage();
    if (Core.MODULE_CATALOG.find((item) => item.id === currentPage)?.page === 'declarative') renderDeclarativePage(currentPage);
  }

  function resetNewProjectForm() {
    $('#newProjectForm').reset();
    $('#newProjectTemplateId').value = 'template-blank';
    renderNewProjectTemplates('template-blank');
  }

  function openProjectSettings() {
    const project = activeProject();
    if (!project) return;
    $('#settingsProjectName').value = project.name;
    $('#settingsProjectClient').value = project.client;
    $('#settingsStartDate').value = project.startDate;
    $('#settingsEndDate').value = project.endDate;
    $('#settingsDuration').value = project.settings.sessionDurationMinutes;
    $('#settingsParticipantMin').value = project.settings.participantMin;
    $('#settingsParticipantMax').value = project.settings.participantMax;
    $('#settingsCoachRequired').checked = project.settings.coachRequired;
    $('#settingsChangeApproval').checked = project.settings.changeApprovalRequired;

    const container = $('#defaultConnectionSelectors');
    container.replaceChildren();
    Core.CONNECTION_TYPES.forEach((type) => {
      const label = element('label', 'form-field', `기본 ${type.name} 연결`);
      const select = element('select');
      select.dataset.defaultConnectionType = type.id;
      const none = element('option', '', '지정하지 않음');
      none.value = '';
      select.append(none);
      state.connections.filter((connection) => connection.type === type.id).forEach((connection) => {
        const option = element('option', '', `${connection.label}${connection.account ? ` · ${connection.account}` : ''}`);
        option.value = connection.id;
        option.selected = project.settings.defaultConnectionIds[type.id] === connection.id;
        select.append(option);
      });
      label.append(select);
      container.append(label);
    });
    openDialog('projectSettingsDialog');
  }

  async function switchProject(projectId) {
    try {
      state = Core.setActiveProject(state, projectId);
      scheduleSelection = null; scheduleHistory = []; scheduleFuture = [];
      await persist('프로젝트 전환됨');
      renderAll();
      navigate('dashboard');
    } catch (error) { showToast(error.message, 'error'); }
  }

  function openWorkflowModule(moduleId) {
    let project = activeProject();
    if (!project) return;
    if (!project.workflow.some((step) => step.moduleId === moduleId)) {
      const definition = Core.TASK_TYPE_CATALOG.find((item) => item.moduleId === moduleId);
      if (definition) {
        state = Core.updateProjectWorkflow(state, project.id, [...project.workflow, { type: definition.id, moduleId, name: definition.name, description: definition.description }]);
        project = activeProject();
      }
    }
    if (project.moduleState[moduleId].status === 'notStarted') {
      state = Core.setModuleStatus(state, project.id, moduleId, 'inProgress', '초기 설정을 시작했습니다.');
      void persist();
      renderAll();
    }
    const module = Core.MODULE_CATALOG.find((item) => item.id === moduleId);
    if (Core.MODULE_CATALOG.some((item) => item.id === moduleId && item.page)) {
      navigate(moduleId);
    }
  }

  function openRosterManager() {
    const project = activeProject();
    if (globalThis.workspaceDesktop?.openRosterPicker) return globalThis.workspaceDesktop.openRosterPicker(project?.id || '');
    return globalThis.workspaceDesktop.openProgram('people', { projectId: project?.id || '' });
  }

  async function createProjectFromForm(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = Core.createProject(state, {
        name: form.get('name'),
        client: form.get('client'),
        startDate: form.get('startDate'),
        endDate: form.get('endDate'),
        templateId: form.get('templateId')
      });
      state = result.state;
      await persist('프로젝트 생성됨');
      closeDialog('newProjectDialog');
      resetNewProjectForm();
      renderAll();
      navigate('dashboard');
      showToast(`“${result.project.name}” 프로젝트를 만들었습니다.`, 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function saveProjectSettings(event) {
    event.preventDefault();
    const project = activeProject();
    if (!project) return;
    const participantMin = Number($('#settingsParticipantMin').value);
    const participantMax = Number($('#settingsParticipantMax').value);
    if (participantMin > participantMax) {
      showToast('최소 참여자는 최대 참여자보다 클 수 없습니다.', 'error');
      return;
    }
    const defaultConnectionIds = {};
    $$('[data-default-connection-type]').forEach((select) => { defaultConnectionIds[select.dataset.defaultConnectionType] = select.value || null; });
    try {
      const participantRole = project.data.roles.find((role) => role.id === 'participant');
      if (participantRole) { participantRole.minPerSession = participantMin; participantRole.maxPerSession = participantMax; }
      const coachRole = project.data.roles.find((role) => role.id === 'coach');
      if (coachRole) coachRole.minPerSession = $('#settingsCoachRequired').checked ? 1 : 0;
      state = Core.updateProject(state, project.id, {
        name: $('#settingsProjectName').value,
        client: $('#settingsProjectClient').value,
        startDate: $('#settingsStartDate').value,
        endDate: $('#settingsEndDate').value,
        data: { roles: project.data.roles },
        settings: {
          sessionDurationMinutes: Number($('#settingsDuration').value),
          participantMin,
          participantMax,
          coachRequired: $('#settingsCoachRequired').checked,
          changeApprovalRequired: $('#settingsChangeApproval').checked,
          defaultConnectionIds
        }
      });
      await persist();
      closeDialog('projectSettingsDialog');
      renderAll();
      showToast('프로젝트 설정을 저장했습니다.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function addConnectionFromForm(event) {
    event.preventDefault();
    try {
      const result = Core.addConnection(state, {
        type: $('#connectionType').value,
        label: $('#connectionLabel').value,
        account: $('#connectionAccount').value,
        status: 'needsAuth'
      });
      state = result.state;
      const type = $('#connectionType').value;
      await globalThis.workspaceDesktop.configureConnection(result.connection.id, {
        provider: type === 'zoom' ? 'zoom' : 'google',
        type,
        clientId: $('#connectionClientId').value,
        clientSecret: $('#connectionClientSecret').value,
        redirectUri: $('#connectionRedirectUri').value
      });
      await persist();
      closeDialog('connectionDialog');
      event.currentTarget.reset();
      renderAll();
      renderConnectionsPage();
      showToast('계정 설정을 저장했습니다. “로그인하여 연결”을 눌러 마무리하세요.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function applyRosterMatrix(matrix) {
    const project = activeProject();
    if (!project) return;
    if (project.data.people.length && !await showConfirm('현재 명단을 새 데이터로 교체할까요? 기존 일정 배정에서 연결이 끊길 수 있습니다.', { title: '명단 교체', action: '교체' })) return;
    const result = Ops.matrixToRoster(matrix);
    state = Core.updateProject(state, project.id, {
      data: {
        columns: result.columns,
        people: result.people,
        availability: {},
        assignments: [],
        conflicts: []
      }
    });
    state = Core.setModuleStatus(state, project.id, 'people', result.warnings.length ? 'needsReview' : 'inProgress', `${result.people.length}명 가져옴`);
    await persist();
    renderAll();
    $('#rosterImportWarnings').hidden = result.warnings.length === 0;
    $('#rosterImportWarnings').textContent = result.warnings.join('\n');
    showToast(`${result.people.length}명을 명단으로 가져왔습니다.`, 'success');
  }

  async function saveRoster() {
    const project = activeProject(); if (!project) return;
    syncPersonDerivedFields(project);
    const warnings = rosterWarnings(project);
    state = Core.updateProject(state, project.id, { data: { columns: project.data.columns, people: project.data.people } });
    state = Core.setModuleStatus(state, project.id, 'people', warnings.length ? 'needsReview' : 'complete', `${project.data.people.filter((person) => person.active !== false).length}명`);
    if (project.data.slots.length) state = Core.setModuleStatus(state, project.id, 'schedule', 'stale', '명단 변경 후 일정 재검토 필요');
    await persist(); renderAll();
    showToast(warnings.length ? `명단을 저장했습니다. 확인할 항목이 ${warnings.length}건 있습니다.` : '명단을 저장했습니다.', warnings.length ? 'normal' : 'success');
  }

  function syncRoleInputs(project) {
    $$('[data-role-row]').forEach((row) => {
      const role = project.data.roles.find((item) => item.id === row.dataset.roleRow); if (!role) return;
      $$('[data-role-field]', row).forEach((input) => { role[input.dataset.roleField] = input.type === 'number' ? Math.max(0, Number(input.value) || 0) : input.value.trim(); });
      role.maxPerSession = Math.max(1, role.maxPerSession, role.minPerSession);
    });
  }

  async function persistScheduleData(message = '일정 설정을 저장했습니다.') {
    const project = activeProject(); if (!project) return;
    syncRoleInputs(project);
    project.data.scheduleRules = {
      avoidRepeatPairing: $('#ruleAvoidRepeat').checked,
      avoidPastPairing: $('#ruleAvoidPast').checked,
      groupPreference: $('#ruleGroupPreference').value,
      unmarkedMeansAvailable: $('#ruleUnmarkedAvailable').checked
    };
    state = Core.updateProject(state, project.id, { data: project.data });
    await persist(); renderAll(); showToast(message, 'success');
  }

  async function generateSchedule() {
    const project = activeProject(); if (!project) return;
    syncRoleInputs(project);
    project.data.scheduleRules = {
      avoidRepeatPairing: $('#ruleAvoidRepeat').checked,
      avoidPastPairing: $('#ruleAvoidPast').checked,
      groupPreference: $('#ruleGroupPreference').value,
      unmarkedMeansAvailable: $('#ruleUnmarkedAvailable').checked
    };
    if (!project.data.people.length) { showToast('명단을 먼저 등록해주세요.', 'error'); return; }
    if (!project.data.slots.length) { showToast('시간대를 먼저 추가해주세요.', 'error'); return; }
    const result = Ops.generateSchedule({
      people: schedulePeopleWithRoleFilters(project),
      roles: project.data.roles,
      slots: project.data.slots,
      availability: project.data.availability,
      existingAssignments: project.data.assignments,
      rules: project.data.scheduleRules
    });
    project.data.assignments = result.assignments;
    project.data.conflicts = [...result.conflicts, ...Ops.validateAssignments({ assignments: result.assignments, people: project.data.people, roles: project.data.roles, slots: project.data.slots }).map((message) => ({ type: 'validation', message }))];
    state = Core.updateProject(state, project.id, { data: project.data });
    state = Core.setModuleStatus(state, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'inProgress', `시간대 ${project.data.slots.length}개 · 확인할 문제 ${project.data.conflicts.length}건`);
    if (project.installedModules.includes('zoom')) state = Core.setModuleStatus(state, project.id, 'zoom', 'stale', '일정이 바뀌어 Zoom 링크 확인 필요');
    if (project.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', '일정이 바뀌어 안내 메일 확인 필요');
    await persist(); renderAll();
    showToast(project.data.conflicts.length ? `일정표를 만들었습니다. 확인할 문제가 ${project.data.conflicts.length}건 있습니다.` : '조건에 맞춰 일정표를 만들었습니다.', project.data.conflicts.length ? 'normal' : 'success');
  }

  async function saveScheduleSnapshot() {
    const project = activeProject(); if (!project) return;
    const version = {
      id: `version-${Date.now().toString(36)}`,
      name: `일정 ${project.data.versions.length + 1}차`,
      createdAt: new Date().toISOString(),
      slots: JSON.parse(JSON.stringify(project.data.slots)),
      assignments: JSON.parse(JSON.stringify(project.data.assignments)),
      conflicts: JSON.parse(JSON.stringify(project.data.conflicts))
    };
    project.data.versions.push(version);
    state = Core.updateProject(state, project.id, { data: project.data });
    state = Core.setModuleStatus(state, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'complete', `${version.name} 저장`);
    await persist(); renderAll(); showToast(`${version.name}를 저장했습니다.`, 'success');
  }

  function openPersonalMailEditor(personId) {
    const project = activeProject(); if (!project) return;
    const entry = Ops.buildMailPackage(project).entries.find((item) => item.personId === personId); if (!entry) return;
    const artifact = project.data.externalArtifacts.find((item) => item.kind === 'gmailDraft' && item.personId === personId);
    $('#mailEditPersonId').value = personId; $('#mailEditRecipient').value = entry.email; $('#mailEditSubject').value = entry.subject;
    $('#mailEditBody').innerHTML = sanitizeRichHtml(entry.bodyHtml || plainToHtml(entry.body));
    $('#mailEditStatus').textContent = artifact ? `Gmail 임시보관함의 메일과 연결되어 있습니다. 저장하면 Gmail 내용도 함께 바뀝니다.` : '아직 Gmail 임시보관함에 만들지 않았습니다. 수정 내용은 현재 프로젝트에 저장됩니다.';
    renderTemplateVariables(project, { paletteId: 'mailEditVariablePalette', statusId: 'mailEditTokenStatus', subjectId: 'mailEditSubject', bodyId: 'mailEditBody' });
    openDialog('mailEditDialog');
  }

  function bindEvents() {
    bindRichEditor($('#mailBodyEditor')); bindRichEditor($('#mailEditBody'));
    const markMailEditorDirty = () => { mailEditorDirty = true; $('#mailPackageStatus').textContent = '메일 편집 내용을 자동 저장하는 중입니다.'; const project = activeProject(); if (project) renderTemplateVariables(project); clearTimeout(mailDraftTimer); mailDraftTimer = setTimeout(() => void saveMailEditorDraft(), 700); };
    $('#mailSubjectTemplate').addEventListener('input', markMailEditorDirty);
    $('#mailBodyEditor').addEventListener('input', markMailEditorDirty);
    ['mailSubjectTemplate', 'mailBodyEditor', 'mailEditSubject', 'mailEditBody'].forEach((id) => $(`#${id}`).addEventListener('focus', () => { templateInsertionTarget = id; }));
    $('#mailEditSubject').addEventListener('input', () => { const project = activeProject(); if (project) renderTemplateVariables(project, { paletteId: 'mailEditVariablePalette', statusId: 'mailEditTokenStatus', subjectId: 'mailEditSubject', bodyId: 'mailEditBody' }); });
    $('#mailEditBody').addEventListener('input', () => { const project = activeProject(); if (project) renderTemplateVariables(project, { paletteId: 'mailEditVariablePalette', statusId: 'mailEditTokenStatus', subjectId: 'mailEditSubject', bodyId: 'mailEditBody' }); });
    $$('.template-variable-palette').forEach((palette) => palette.addEventListener('click', (event) => { const token = event.target.closest('[data-template-token]'); if (token) insertTemplateToken(token.dataset.templateToken, token.dataset.templateTargetGroup); }));

    const rosterTable = $('#rosterEditorTable');
    if (rosterTable) {
    rosterTable.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return; const cell = event.target.closest('[data-sheet-row][data-sheet-col]'); if (!cell) return;
      const point = { row: Number(cell.dataset.sheetRow), col: Number(cell.dataset.sheetCol) };
      rosterSelecting = true; updateRosterSelection(event.shiftKey && rosterSelection ? rosterSelection.anchor : point, point);
    });
    rosterTable.addEventListener('pointerover', (event) => {
      if (!rosterSelecting || !rosterSelection) return; const cell = event.target.closest('[data-sheet-row][data-sheet-col]'); if (!cell) return;
      updateRosterSelection(rosterSelection.anchor, { row: Number(cell.dataset.sheetRow), col: Number(cell.dataset.sheetCol) });
    });
    document.addEventListener('pointerup', () => { rosterSelecting = false; });
    document.addEventListener('copy', (event) => {
      if (currentPage !== 'people' || !rosterSelection) return; const project = activeProject(); if (!project) return;
      const matrix = selectedRosterMatrix(project); if (!matrix.length) return;
      const text = matrix.map((row) => row.join('\t')).join('\r\n');
      const html = `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`).join('')}</tr>`).join('')}</table>`;
      event.clipboardData.setData('text/plain', text); event.clipboardData.setData('text/html', html); event.preventDefault(); showToast(`${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
    });
    document.addEventListener('copy', (event) => {
      if (currentPage !== 'arrange' || !arrangementSelection) return; const item = activeWorkItem(); if (!item) return;
      const matrix = selectedArrangementMatrix(item); if (!matrix.length) return; const text = matrix.map((row) => row.join('\t')).join('\r\n'); const html = `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`).join('')}</tr>`).join('')}</table>`;
      event.clipboardData.setData('text/plain', text); event.clipboardData.setData('text/html', html); event.preventDefault(); showToast(`${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
    });
    rosterTable.addEventListener('paste', async (event) => {
      if (!rosterSelection) return; const text = event.clipboardData?.getData('text/plain') || ''; if (!text.trim()) return;
      const project = activeProject(); if (!project) return; const matrix = Ops.parseDelimited(text); if (!matrix.length) return;
      if (!project.data.columns.length) { event.preventDefault(); await applyRosterMatrix(matrix); rosterSelection = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }; return; }
      if (!/[\t\r\n]/.test(text)) return; event.preventDefault();
      const start = rosterSelection.focus;
      matrix.forEach((row, rowOffset) => row.forEach((value, colOffset) => { if (start.col + colOffset < project.data.columns.length) setSheetCellValue(project, start.row + rowOffset, start.col + colOffset, value); }));
      updateRosterSelection(start, { row: start.row + matrix.length - 1, col: Math.min(project.data.columns.length - 1, start.col + Math.max(...matrix.map((row) => row.length)) - 1) });
      state = Core.updateProject(state, project.id, { data: project.data }); await persist('셀 붙여넣기 저장됨'); renderPeoplePage();
    });
    $('#rosterCellValue').addEventListener('input', (event) => {
      const project = activeProject(); if (!project || !rosterSelection) return; const point = rosterSelection.focus;
      setSheetCellValue(project, point.row, point.col, event.target.value);
      const cellInput = $(`[data-sheet-row="${point.row}"][data-sheet-col="${point.col}"] input`, rosterTable); if (cellInput) cellInput.value = event.target.value;
    });
    $('#rosterCellValue').addEventListener('change', async () => {
      const project = activeProject(); if (!project || !rosterSelection) return;
      state = Core.updateProject(state, project.id, { data: project.data }); await persist('셀 편집 저장됨'); renderPeoplePage();
    });
    rosterTable.addEventListener('click', (event) => {
      const project = activeProject(); if (!project) return;
      if (event.target.closest('[data-empty-sheet-add-column], [data-roster-add-column]')) addRosterColumn(project);
    });
    }

    const arrangementBoard = $('#arrangementBoard');
    arrangementBoard.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-arrangement-add-column], [data-arrangement-remove-column], [data-arrangement-rename-column]')) return;
      const cell = event.target.closest('[data-arrangement-row][data-arrangement-col]'); if (!cell) return; const point = { row: Number(cell.dataset.arrangementRow), col: Number(cell.dataset.arrangementCol) }; arrangementSelecting = true; updateArrangementSelection(event.shiftKey && arrangementSelection ? arrangementSelection.anchor : point, point);
    });
    arrangementBoard.addEventListener('mousemove', (event) => {
      if (!arrangementSelecting || !arrangementSelection || !(event.buttons & 1)) return; const cell = event.target.closest('[data-arrangement-row][data-arrangement-col]'); if (!cell) return; updateArrangementSelection(arrangementSelection.anchor, { row: Number(cell.dataset.arrangementRow), col: Number(cell.dataset.arrangementCol) });
    });
    globalThis.addEventListener('mouseup', () => { arrangementSelecting = false; });
    arrangementBoard.addEventListener('input', (event) => { if (!event.target.matches('[data-arrangement-input]')) return; const item = activeWorkItem(); const cell = event.target.closest('[data-arrangement-row][data-arrangement-col]'); if (!item || !cell) return; setArrangementCellValue(item, Number(cell.dataset.arrangementRow), Number(cell.dataset.arrangementCol), event.target.value); $('#arrangementCellValue').value = event.target.value; });
    arrangementBoard.addEventListener('change', async (event) => { if (!event.target.matches('[data-arrangement-input]')) return; const project = activeProject(); if (!project) return; state = Core.updateProject(state, project.id, { data: project.data }); await persist('명단 작업표 편집됨'); renderArrangementPage(); });
    arrangementBoard.addEventListener('paste', async (event) => {
      if (!arrangementSelection) return; const text = event.clipboardData?.getData('text/plain') || ''; if (!/[\t\r\n]/.test(text)) return; const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return; const matrix = Ops.parseDelimited(text); if (!matrix.length) return; event.preventDefault(); const start = arrangementSelection.focus; const width = Math.max(...matrix.map((row) => row.length));
      while (item.columns.length < start.col + width) { const id = `work-column-${Date.now().toString(36)}-${item.columns.length}`; item.columns.push({ id, name: `컬럼${item.columns.length + 1}` }); item.rows.forEach((row) => { row.values[id] = ''; }); }
      matrix.forEach((row, rowOffset) => row.forEach((value, colOffset) => setArrangementCellValue(item, start.row + rowOffset, start.col + colOffset, value))); state = Core.updateProject(state, project.id, { data: project.data }); await persist('명단 작업표 붙여넣기됨'); renderArrangementPage(); updateArrangementSelection(start, { row: start.row + matrix.length - 1, col: start.col + width - 1 });
    });
    arrangementBoard.addEventListener('click', async (event) => {
      const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return;
      if (event.target.closest('[data-arrangement-add-column]')) { const id = `work-column-${Date.now().toString(36)}-${item.columns.length}`; item.columns.push({ id, name: `컬럼${item.columns.length + 1}` }); item.rows.forEach((row) => { row.values[id] = ''; }); state = Core.updateProject(state, project.id, { data: project.data }); await persist('작업표 컬럼 추가됨'); renderArrangementPage(); return; }
      const rename = event.target.closest('[data-arrangement-rename-column]'); if (rename) { const column = item.columns.find((candidate) => candidate.id === rename.dataset.arrangementRenameColumn); const name = await requestName('컬럼 이름', column?.name || '컬럼'); if (!column || !name?.trim()) return; column.name = name.trim(); state = Core.updateProject(state, project.id, { data: project.data }); await persist('작업표 컬럼 이름 변경됨'); renderArrangementPage(); return; }
      const remove = event.target.closest('[data-arrangement-remove-column]'); if (remove) { if (item.columns.length <= 1) { showToast('작업표에는 컬럼이 하나 이상 있어야 합니다.', 'error'); return; } const column = item.columns.find((candidate) => candidate.id === remove.dataset.arrangementRemoveColumn); if (!await showConfirm(`“${column?.name || '컬럼'}”을 삭제할까요?`, { title: '작업표 컬럼 삭제', action: '삭제' })) return; item.columns = item.columns.filter((candidate) => candidate.id !== column.id); item.rows.forEach((row) => { delete row.values[column.id]; }); arrangementSelection = null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('작업표 컬럼 삭제됨'); renderArrangementPage(); }
    });
    $('#arrangementCellValue').addEventListener('input', (event) => { const item = activeWorkItem(); if (!item || !arrangementSelection) return; setArrangementCellValue(item, arrangementSelection.focus.row, arrangementSelection.focus.col, event.target.value); const input = $(`[data-arrangement-row="${arrangementSelection.focus.row}"][data-arrangement-col="${arrangementSelection.focus.col}"] input`, arrangementBoard); if (input) input.value = event.target.value; });
    $('#arrangementCellValue').addEventListener('change', async () => { const project = activeProject(); if (!project) return; state = Core.updateProject(state, project.id, { data: project.data }); await persist('명단 작업표 편집됨'); renderArrangementPage(); });

    const scheduleTable = $('#scheduleBoard');
    scheduleTable.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-schedule-remove-column], [data-schedule-insert-row], [data-schedule-append-row], [data-schedule-add-column-inline]')) return;
      const project = activeProject(); if (!project) return; const cell = event.target.closest('[data-schedule-row][data-schedule-col]'); const columnSelector = event.target.closest('[data-select-schedule-column]'); const rowSelector = event.target.closest('[data-select-schedule-row]'); const allSelector = event.target.closest('[data-select-schedule-all]');
      if (!cell && !columnSelector && !rowSelector && !allSelector) return; const columns = scheduleSheetColumns(project); const visibleRows = Math.max(project.data.slots.length + 2, 5); let anchor; let focus; let mode = 'cells';
      if (columnSelector) { const col = Number(columnSelector.dataset.selectScheduleColumn); anchor = { row: -1, col }; focus = { row: visibleRows - 1, col }; mode = 'column'; }
      else if (rowSelector) { const row = Number(rowSelector.dataset.selectScheduleRow); anchor = { row, col: 0 }; focus = { row, col: Math.max(0, columns.length - 1) }; mode = 'row'; }
      else if (allSelector) { anchor = { row: -1, col: 0 }; focus = { row: visibleRows - 1, col: Math.max(0, columns.length - 1) }; mode = 'all'; }
      else { const point = { row: Number(cell.dataset.scheduleRow), col: Number(cell.dataset.scheduleCol) }; anchor = event.shiftKey && scheduleSelection ? scheduleSelection.anchor : point; focus = point; }
      scheduleSelecting = true; updateScheduleSelection(anchor, focus, mode);
      const input = event.target.closest('[data-schedule-input]') || cell?.querySelector('[data-schedule-input]'); const target = input || event.target.closest('button, [tabindex]') || cell; if (target && document.activeElement !== target) { event.preventDefault(); target.focus({ preventScroll: true }); }
    });
    scheduleTable.addEventListener('mousemove', (event) => {
      if (!scheduleSelecting || !scheduleSelection || !(event.buttons & 1)) return; const cell = event.target.closest('[data-schedule-row][data-schedule-col]'); const columnSelector = event.target.closest('[data-select-schedule-column]'); const rowSelector = event.target.closest('[data-select-schedule-row]'); let focus = scheduleSelection.focus;
      if (scheduleSelection.mode === 'column' && columnSelector) focus = { row: scheduleSelection.focus.row, col: Number(columnSelector.dataset.selectScheduleColumn) };
      else if (scheduleSelection.mode === 'row' && rowSelector) focus = { row: Number(rowSelector.dataset.selectScheduleRow), col: scheduleSelection.focus.col };
      else if (scheduleSelection.mode === 'cells' && cell) focus = { row: Number(cell.dataset.scheduleRow), col: Number(cell.dataset.scheduleCol) };
      else return; updateScheduleSelection(scheduleSelection.anchor, focus, scheduleSelection.mode);
    });
    globalThis.addEventListener('mouseup', () => { scheduleSelecting = false; });
    scheduleTable.addEventListener('focusin', (event) => { if (event.target.matches('[data-schedule-input]')) event.target.dataset.scheduleBefore = scheduleSnapshot(activeProject()); });
    scheduleTable.addEventListener('input', (event) => {
      if (!event.target.matches('[data-schedule-input]')) return; const project = activeProject(); const cell = event.target.closest('[data-schedule-row][data-schedule-col]'); if (!project || !cell) return;
      if (event.target.dataset.scheduleBefore) { scheduleHistory.push(event.target.dataset.scheduleBefore); if (scheduleHistory.length > 80) scheduleHistory.shift(); scheduleFuture = []; delete event.target.dataset.scheduleBefore; }
      setScheduleCellValue(project, Number(cell.dataset.scheduleRow), Number(cell.dataset.scheduleCol), event.target.value); updateScheduleSelection(scheduleSelection?.anchor || { row: Number(cell.dataset.scheduleRow), col: Number(cell.dataset.scheduleCol) }, { row: Number(cell.dataset.scheduleRow), col: Number(cell.dataset.scheduleCol) });
      const conflicts = project.data.conflicts || []; $('#scheduleConflicts').hidden = !conflicts.length; $('#scheduleConflicts').textContent = conflicts.slice(0, 30).map((item) => `• ${item.message}`).join('\n'); $('#scheduleBoardSummary').textContent = conflicts.length ? `현재 일정표에서 확인할 문제가 ${conflicts.length}건 있습니다.` : '현재 일정표에서 확인할 문제가 없습니다.';
      queueSchedulePersist(project);
    });
    scheduleTable.addEventListener('paste', async (event) => {
      if (!scheduleSelection) return; const text = event.clipboardData?.getData('text/plain') || ''; if (!text) return; event.preventDefault();
      const project = activeProject(); if (!project) return; const matrix = Ops.parseDelimited(text); if (!matrix.length) return; const start = scheduleSelection.focus; const structured = matrix.length > 1 || matrix.some((row) => row.length > 1);
      if (structured && start.row <= 0 && start.col === 0 && (looksLikeScheduleHeader(matrix) || !project.data.slots.length)) { await importScheduleMatrix(matrix, 'replace'); return; }
      pushScheduleHistory(project); const width = Math.max(...matrix.map((row) => row.length));
      while (scheduleSheetColumns(project).length < start.col + width) { const index = project.data.scheduleSheetColumns.length; const id = `schedule-column-${Date.now().toString(36)}-${index}`; project.data.scheduleSheetColumns.push({ id, key: `custom:${id}`, name: `컬럼${index + 1}`, kind: 'custom', roleId: null }); }
      matrix.forEach((row, rowOffset) => row.forEach((value, colOffset) => { const targetRow = start.row + rowOffset; if (targetRow === -1) project.data.scheduleSheetColumns[start.col + colOffset].name = String(value || '').trim() || project.data.scheduleSheetColumns[start.col + colOffset].name; else setScheduleCellValue(project, targetRow, start.col + colOffset, value); }));
      state = Core.updateProject(state, project.id, { data: project.data }); await persist('일정 셀 붙여넣기 저장됨'); renderSchedulePage();
      updateScheduleSelection(start, { row: start.row + matrix.length - 1, col: Math.min(scheduleSheetColumns(project).length - 1, start.col + width - 1) });
      showToast(`${matrix.length}행 × ${Math.max(...matrix.map((row) => row.length))}열을 붙여넣었습니다.`, 'success');
    });
    scheduleTable.addEventListener('keydown', async (event) => {
      if (!scheduleSelection) return; const project = activeProject(); if (!project) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); updateScheduleSelection({ row: -1, col: 0 }, { row: Math.max(project.data.slots.length + 1, 4), col: scheduleSheetColumns(project).length - 1 }, 'all'); return; }
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); const undo = event.key.toLowerCase() === 'z' && !event.shiftKey;
        const from = undo ? scheduleHistory : scheduleFuture; const to = undo ? scheduleFuture : scheduleHistory; if (!from.length) return;
        to.push(scheduleSnapshot(project)); restoreScheduleSnapshot(project, from.pop()); state = Core.updateProject(state, project.id, { data: project.data }); await persist(undo ? '실행 취소됨' : '다시 실행됨'); renderSchedulePage(); return;
      }
      const movement = { Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
      if (movement && (!event.target.matches('input') || event.key === 'Enter' || event.key === 'Tab' || event.altKey)) {
        event.preventDefault(); focusScheduleCell(scheduleSelection.focus.row + movement[0], scheduleSelection.focus.col + movement[1], event.shiftKey && event.key !== 'Tab'); return;
      }
      const rangeSelected = scheduleSelection.anchor.row !== scheduleSelection.focus.row || scheduleSelection.anchor.col !== scheduleSelection.focus.col || scheduleSelection.mode !== 'cells';
      if ((event.key === 'Delete' || event.key === 'Backspace') && (!event.target.matches('input:focus') || rangeSelected)) {
        event.preventDefault(); pushScheduleHistory(project); const matrix = selectedScheduleMatrix(project); const minRow = Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row); const minCol = Math.min(scheduleSelection.anchor.col, scheduleSelection.focus.col);
        matrix.forEach((row, r) => row.forEach((_value, c) => { if (minRow + r >= 0) setScheduleCellValue(project, minRow + r, minCol + c, ''); })); state = Core.updateProject(state, project.id, { data: project.data }); await persist('선택 셀 지움'); renderSchedulePage();
      }
    });
    document.addEventListener('copy', (event) => {
      if (currentPage !== 'schedule' || !scheduleSelection) return; const project = activeProject(); if (!project) return; const matrix = selectedScheduleMatrix(project); if (!matrix.length) return;
      event.clipboardData.setData('text/plain', matrix.map((row) => row.join('\t')).join('\r\n')); event.clipboardData.setData('text/html', scheduleClipboardHtml(matrix)); event.preventDefault(); showToast(`${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
    });
    document.addEventListener('cut', (event) => {
      if (currentPage !== 'schedule' || !scheduleSelection) return; const project = activeProject(); if (!project) return; const matrix = selectedScheduleMatrix(project); if (!matrix.length) return;
      event.clipboardData.setData('text/plain', matrix.map((row) => row.join('\t')).join('\r\n')); event.clipboardData.setData('text/html', scheduleClipboardHtml(matrix)); event.preventDefault(); pushScheduleHistory(project);
      const minRow = Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row); const minCol = Math.min(scheduleSelection.anchor.col, scheduleSelection.focus.col); matrix.forEach((row, r) => row.forEach((_value, c) => { if (minRow + r >= 0) setScheduleCellValue(project, minRow + r, minCol + c, ''); })); queueSchedulePersist(project, '잘라내기 저장됨'); renderSchedulePage();
    });
    $('#scheduleCellValue').addEventListener('input', (event) => {
      const project = activeProject(); if (!project || !scheduleSelection) return; if (!event.target.dataset.scheduleEditing) { pushScheduleHistory(project); event.target.dataset.scheduleEditing = 'true'; }
      if (scheduleSelection.focus.row === -1) { const column = project.data.scheduleSheetColumns[scheduleSelection.focus.col]; if (column) column.name = event.target.value.trim() || column.name; }
      else setScheduleCellValue(project, scheduleSelection.focus.row, scheduleSelection.focus.col, event.target.value); const input = $(`[data-schedule-row="${scheduleSelection.focus.row}"][data-schedule-col="${scheduleSelection.focus.col}"] input`, scheduleTable); if (input) input.value = event.target.value; queueSchedulePersist(project);
    });
    $('#scheduleCellValue').addEventListener('change', () => { delete $('#scheduleCellValue').dataset.scheduleEditing; });
    $('#openScheduleRosterManager').addEventListener('click', () => void openRosterManager());
    $('#sessionRosterView').addEventListener('change', async (event) => { const project = activeProject(); if (!project) return; project.data.scheduleRules.rosterViewId = event.target.value || null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('일정 단계 명단 변경됨'); renderAvailability(project); renderSessionPlanner(project); });
    ['sessionRoleSelect', 'sessionGroupFilter', 'sessionDateFilter'].forEach((id) => $(`#${id}`).addEventListener('change', () => { const project = activeProject(); if (project) renderSessionPlanner(project); }));
    $('#sessionShowAllDates').addEventListener('click', () => { $('#sessionDateFilter').value = ''; const project = activeProject(); if (project) renderSessionPlanner(project); });
    $('#sessionAddEmptyTime').addEventListener('click', () => void addSessionFromText());
    $('#sessionPersonPool').addEventListener('click', (event) => { const chip = event.target.closest('[data-session-person]'); if (!chip) return; selectedSessionPersonId = selectedSessionPersonId === chip.dataset.sessionPerson ? null : chip.dataset.sessionPerson; const project = activeProject(); if (project) renderSessionPlanner(project); });
    $('#sessionPersonPool').addEventListener('dragstart', (event) => { const chip = event.target.closest('[data-session-person]'); if (!chip) return; event.dataTransfer.setData('application/x-cmoe-person', chip.dataset.sessionPerson); event.dataTransfer.effectAllowed = 'copy'; });
    $('#sessionCalendarBoard').addEventListener('dragstart', (event) => { const chip = event.target.closest('[data-session-assignment]'); if (!chip) return; event.dataTransfer.setData('application/x-cmoe-assignment', chip.dataset.sessionAssignment); event.dataTransfer.setData('application/x-cmoe-person', chip.dataset.sessionPerson); event.dataTransfer.effectAllowed = 'move'; });
    $('#sessionCalendarBoard').addEventListener('dragover', (event) => { const target = event.target.closest('[data-session-slot], [data-session-empty-drop]'); if (!target) return; event.preventDefault(); target.classList.add('drag-over'); });
    $('#sessionCalendarBoard').addEventListener('dragleave', (event) => { event.target.closest('[data-session-slot]')?.classList.remove('drag-over'); });
    $('#sessionCalendarBoard').addEventListener('drop', async (event) => { const target = event.target.closest('[data-session-slot], [data-session-empty-drop]'); if (!target) return; event.preventDefault(); target.classList.remove('drag-over'); const personId = event.dataTransfer.getData('application/x-cmoe-person'); const assignmentId = event.dataTransfer.getData('application/x-cmoe-assignment'); if (!personId) return; if (target.dataset.sessionEmptyDrop) { const slot = await addSessionFromText(); if (slot) await assignPersonToSession(personId, slot.id, assignmentId); } else await assignPersonToSession(personId, target.dataset.sessionSlot, assignmentId); });
    $('#sessionCalendarBoard').addEventListener('click', async (event) => {
      const project = activeProject(); if (!project) return;
      if (event.target.closest('[data-session-empty-drop]')) { await addSessionFromText(); return; }
      const unassign = event.target.closest('[data-session-unassign]'); if (unassign) { pushScheduleHistory(project); project.data.assignments = project.data.assignments.filter((item) => item.id !== unassign.dataset.sessionUnassign); refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); await persist('세션 인원 제외됨'); renderSchedulePage(); return; }
      const edit = event.target.closest('[data-session-edit]'); if (edit) { const slot = project.data.slots.find((item) => item.id === edit.dataset.sessionEdit); const value = await requestName('세션 시간 변경', `${slot.date} ${slot.startTime}-${slot.endTime} ${slot.label || ''}`); if (!value) return; const parsed = Ops.parseSlots(value); if (!parsed.slots.length) { showToast(parsed.errors[0] || '날짜와 시간을 확인해주세요.', 'error'); return; } pushScheduleHistory(project); const next = parsed.slots[0]; Object.assign(slot, { date: next.date, startTime: next.startTime, endTime: next.endTime, label: next.label, status: 'changed' }); refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); await persist('세션 시간 변경됨'); renderSchedulePage(); return; }
      const remove = event.target.closest('[data-session-remove]'); if (remove) { const slot = project.data.slots.find((item) => item.id === remove.dataset.sessionRemove); const count = project.data.assignments.filter((item) => item.slotId === slot?.id).length; if (!slot || !await showConfirm(`${slot.date} ${slot.startTime} 세션을 삭제할까요? 배정 인원 ${count}명은 원본·단계 명단에서 삭제되지 않습니다.`, { title: '세션 삭제', action: '삭제' })) return; pushScheduleHistory(project); project.data.slots = project.data.slots.filter((item) => item.id !== slot.id); project.data.assignments = project.data.assignments.filter((item) => item.slotId !== slot.id); refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); await persist('세션 삭제됨'); renderSchedulePage(); return; }
      const card = event.target.closest('[data-session-slot]'); if (card && selectedSessionPersonId) { const personId = selectedSessionPersonId; selectedSessionPersonId = null; await assignPersonToSession(personId, card.dataset.sessionSlot); }
    });
    scheduleTable.addEventListener('click', (event) => {
      if (event.target.closest('[data-schedule-add-column-inline]')) { void addScheduleColumn(); return; }
      const remove = event.target.closest('[data-schedule-remove-column]'); if (remove) void removeScheduleColumn(remove.dataset.scheduleRemoveColumn);
    });
    scheduleTable.addEventListener('dblclick', (event) => { const rename = event.target.closest('[data-schedule-rename-column]'); if (rename) void renameScheduleColumn(rename.dataset.scheduleRenameColumn); });
    $('#scheduleUndo').addEventListener('click', () => scheduleTable.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    $('#scheduleRedo').addEventListener('click', () => scheduleTable.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })));
    $('#scheduleImportExcel').addEventListener('click', async () => {
      if (!globalThis.workspaceDesktop?.chooseSpreadsheet) { showToast('Excel 가져오기는 데스크톱 앱에서 사용할 수 있습니다.', 'error'); return; }
      try { const result = await globalThis.workspaceDesktop.chooseSpreadsheet(); if (result.canceled) return; const sheets = result.sheets?.length ? result.sheets : [{ name: result.sheetName, matrix: result.matrix }]; const choice = await chooseWorkbookSheet(sheets); if (choice) await importScheduleMatrix(sheets[choice.index].matrix, choice.mode); }
      catch (error) { showToast(`Excel을 읽지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#scheduleExportExcel').addEventListener('click', () => $('#exportExcelButton').click());
    $$('[data-sheet-choice]').forEach((button) => button.addEventListener('click', () => resolveWorkbookSheet(null)));
    $('#sheetChoiceForm').addEventListener('submit', (event) => { event.preventDefault(); resolveWorkbookSheet({ index: Number($('#sheetChoiceSelect').value), mode: $('#sheetImportMode').value }); });
    $$('[data-editor-toolbar]').forEach((toolbar) => {
      toolbar.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
      toolbar.addEventListener('click', (event) => {
        const button = event.target.closest('[data-rich-command]'); if (!button) return;
        const editor = document.getElementById(toolbar.dataset.editorToolbar); editor.focus(); document.execCommand(button.dataset.richCommand, false, null);
      });
      toolbar.addEventListener('input', (event) => {
        const color = event.target.closest('[data-rich-color]'); if (!color) return;
        const editor = document.getElementById(toolbar.dataset.editorToolbar); editor.focus(); document.execCommand(color.dataset.richColor, false, color.value);
      });
    });
    $$('.nav-button').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
    const openNewProjectDialog = (templateId = 'template-blank') => { resetNewProjectForm(); renderNewProjectTemplates(templateId); openDialog('newProjectDialog'); };
    $$('[data-open-new-project]').forEach((button) => button.addEventListener('click', () => openNewProjectDialog()));
    $('#newProjectButton').addEventListener('click', () => openNewProjectDialog());
    $('#newProjectTemplatePicker').addEventListener('change', (event) => { if (event.target.name === 'templateChoice') renderNewProjectTemplates(event.target.value); });
    $('#newProjectForm').addEventListener('submit', createProjectFromForm);
    $('#editWorkflowButton').addEventListener('click', openWorkflowEditor);
    $('#editWorkflowInlineButton').addEventListener('click', openWorkflowEditor);
    $('#workflowEditorList').addEventListener('input', (event) => {
      const step = workflowEditorDraft.find((item) => item.id === (event.target.dataset.workflowStepName || event.target.dataset.workflowStepDescription)); if (!step) return;
      if (event.target.dataset.workflowStepName) step.name = event.target.value;
      if (event.target.dataset.workflowStepDescription) step.description = event.target.value;
      if (workflowEditorTemplateDraft) workflowEditorTemplateDraft.modified = true;
    });
    $('#workflowEditorList').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-workflow-step-remove]');
      if (remove) { workflowEditorDraft = workflowEditorDraft.filter((item) => item.id !== remove.dataset.workflowStepRemove); if (workflowEditorTemplateDraft) workflowEditorTemplateDraft.modified = true; renderWorkflowEditor(); return; }
      const move = event.target.closest('[data-workflow-step-move]');
      if (move) { const index = workflowEditorDraft.findIndex((item) => item.id === move.dataset.workflowStepMove); const target = index + Number(move.dataset.direction); if (index >= 0 && target >= 0 && target < workflowEditorDraft.length) { [workflowEditorDraft[index], workflowEditorDraft[target]] = [workflowEditorDraft[target], workflowEditorDraft[index]]; if (workflowEditorTemplateDraft) workflowEditorTemplateDraft.modified = true; renderWorkflowEditor(); } }
    });
    $('#addWorkflowStep').addEventListener('click', () => {
      const definition = Core.TASK_TYPE_CATALOG.find((item) => item.id === $('#workflowStepType').value); if (!definition) return;
      workflowEditorDraft.push({ id: `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: definition.id, moduleId: definition.moduleId || null, name: definition.name, description: definition.description, status: 'notStarted', instructions: '', notes: '', checklist: [], order: workflowEditorDraft.length, updatedAt: null });
      if (workflowEditorTemplateDraft) workflowEditorTemplateDraft.modified = true;
      renderWorkflowEditor();
    });
    $('#applyWorkflowTemplate').addEventListener('click', async () => {
      const template = state.library.workflowTemplates.find((item) => item.id === $('#workflowTemplateApplySelect').value); if (!template) { showToast('불러올 업무 템플릿을 선택해주세요.', 'error'); return; }
      const remaining = [...workflowEditorDraft]; let preserved = 0;
      const next = template.steps.map((templateStep) => {
        let matchIndex = remaining.findIndex((step) => step.type === templateStep.type && step.name === templateStep.name);
        if (matchIndex < 0) matchIndex = remaining.findIndex((step) => step.type === templateStep.type);
        const existing = matchIndex >= 0 ? remaining.splice(matchIndex, 1)[0] : null;
        if (existing) preserved += 1;
        return existing ? { ...existing, type: templateStep.type, moduleId: templateStep.moduleId, name: templateStep.name, description: templateStep.description } : JSON.parse(JSON.stringify(templateStep));
      });
      const summary = `현재 ${workflowEditorDraft.length}단계 → ${next.length}단계\n기록 유지 ${preserved}단계 · 새로 추가 ${next.length - preserved}단계 · 제외 ${remaining.length}단계`;
      $('#workflowTemplateChangeSummary').textContent = summary.replace(/\n/g, ' · ');
      if (remaining.length && !await showConfirm(`${summary}\n\n제외되는 단계의 메모와 체크 항목은 프로젝트에 적용할 때 빠집니다. 계속할까요?`, { title: '업무 템플릿 적용 미리보기', action: '구성 불러오기', danger: false })) return;
      workflowEditorDraft = next; workflowEditorTemplateDraft = { id: template.id, familyId: template.familyId, version: template.version, name: template.name, modified: false }; renderWorkflowEditor();
    });
    $('#workflowEditorForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const project = activeProject(); if (!project) return;
      workflowEditorDraft.forEach((step) => { step.name = String(step.name || '').trim(); step.description = String(step.description || '').trim(); });
      if (!workflowEditorDraft.length || workflowEditorDraft.some((step) => !step.name)) { showToast('모든 업무 단계에 이름을 입력해주세요.', 'error'); return; }
      try { state = Core.updateProjectWorkflow(state, project.id, workflowEditorDraft); state = Core.updateProject(state, project.id, { workflowTemplate: workflowEditorTemplateDraft || { ...project.workflowTemplate, modified: true } }); await persist('업무 구성 저장됨'); closeDialog('workflowEditorDialog'); renderAll(); showToast('이 프로젝트의 업무 단계와 순서를 저장했습니다.', 'success'); }
      catch (error) { showToast(error.message, 'error'); }
    });
    $('#saveWorkflowAsTemplate').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      if (workflowEditorDraft.length) state = Core.updateProjectWorkflow(state, project.id, workflowEditorDraft);
      const name = await requestName('저장할 업무 템플릿 이름', project.workflowTemplate?.name || `${project.name} 업무 구성`); if (!name) return;
      const result = Core.saveWorkflowTemplate(state, project.id, { name }); state = result.state; await persist('업무 템플릿 저장됨'); renderAll(); showToast(`“${result.template.name} v${result.template.version}”으로 저장했습니다.`, 'success');
    });
    $('#workflowChecklistAdd').addEventListener('click', async () => {
      const project = activeProject(); const step = project?.workflow.find((item) => item.id === activeWorkflowStepId); const text = $('#workflowChecklistInput').value.trim(); if (!step || !text) return;
      step.checklist.push({ id: `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text, done: false }); $('#workflowChecklistInput').value = '';
      state = Core.updateProject(state, project.id, { workflow: project.workflow }); await persist(); renderWorkflowTaskPage();
    });
    $('#workflowChecklistInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#workflowChecklistAdd').click(); } });
    $('#saveWorkflowTask').addEventListener('click', () => void saveWorkflowTask());
    $('#workflowTaskComplete').addEventListener('click', () => void saveWorkflowTask('complete'));
    $('#projectSettingsForm').addEventListener('submit', saveProjectSettings);
    $('#connectionForm').addEventListener('submit', addConnectionFromForm);
    $('#mailEditForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const project = activeProject(); if (!project) return;
      const personId = $('#mailEditPersonId').value; const html = sanitizeRichHtml($('#mailEditBody').innerHTML); const subject = $('#mailEditSubject').value.trim();
      project.data.communication.mailEdits[personId] = { subject, bodyHtml: html, body: richText(html), updatedAt: new Date().toISOString() };
      let message = '개인 메일 수정 내용을 프로젝트에 저장했습니다.';
      const entry = Ops.buildMailPackage(project).entries.find((item) => item.personId === personId);
      const artifact = project.data.externalArtifacts.find((item) => item.kind === 'gmailDraft' && item.personId === personId);
      if (artifact && entry) {
        const connection = state.connections.find((item) => item.id === artifact.connectionId && item.status === 'connected');
        if (connection) {
          try { const updated = await globalThis.workspaceDesktop.updateGmailDraft(connection.id, artifact.externalId, entry); artifact.messageId = updated.message?.id || artifact.messageId; artifact.status = 'created'; artifact.updatedAt = new Date().toISOString(); message = '수정 내용을 저장하고 Gmail 임시보관함의 메일도 변경했습니다.'; }
          catch (error) { artifact.status = 'stale'; message = `수정 내용은 프로젝트에 저장했지만 Gmail 메일은 변경하지 못했습니다: ${error.message}`; }
        } else { artifact.status = 'stale'; message = '수정 내용은 저장했습니다. Gmail 계정에 다시 로그인하면 임시보관함의 메일도 변경할 수 있습니다.'; }
      }
      state = Core.updateProject(state, project.id, { data: project.data }); await persist(); closeDialog('mailEditDialog'); renderAll(); showToast(message, artifact?.status === 'stale' ? 'error' : 'success');
    });
    $('#resetPersonalMail').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return; const personId = $('#mailEditPersonId').value;
      delete project.data.communication.mailEdits[personId];
      const artifact = project.data.externalArtifacts.find((item) => item.kind === 'gmailDraft' && item.personId === personId); if (artifact) artifact.status = 'stale';
      state = Core.updateProject(state, project.id, { data: project.data }); await persist(); closeDialog('mailEditDialog'); renderAll(); showToast('이 사람만 수정한 내용을 지우고 공통 메일 내용으로 되돌렸습니다.');
    });
    $('#connectionType').addEventListener('change', (event) => {
      const zoom = event.target.value === 'zoom';
      $('#connectionRedirectField').hidden = !zoom;
      $('#connectionRedirectUri').required = zoom;
    });
    $('#projectSettingsButton').addEventListener('click', openProjectSettings);
    $('#addConnectionButton').addEventListener('click', () => openDialog('connectionDialog'));
    $('#saveSharedRoster')?.addEventListener('click', async () => {
      const project = activeProject(); if (!project?.data.people.length) { showToast('저장할 명단이 없습니다.', 'error'); return; }
      const name = await requestName('저장할 명단 이름', `${project.name} 명단`); if (!name) return;
      state.library.rosters.push({ id: `roster-${Date.now().toString(36)}`, name, columns: JSON.parse(JSON.stringify(project.data.columns)), people: JSON.parse(JSON.stringify(project.data.people)), savedAt: new Date().toISOString() });
      await persist(); renderPeoplePage(); showToast('나중에 다시 사용할 수 있도록 명단을 저장했습니다.', 'success');
    });
    $('#loadSharedRoster')?.addEventListener('click', async () => {
      const project = activeProject(); const roster = state.library.rosters.find((item) => item.id === $('#sharedRosterSelect').value); if (!project || !roster) { showToast('불러올 명단을 먼저 선택해주세요.', 'error'); return; }
      project.data.columns = JSON.parse(JSON.stringify(roster.columns)); project.data.people = JSON.parse(JSON.stringify(roster.people));
      state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); showToast('저장한 명단을 현재 작업으로 불러왔습니다.', 'success');
    });
    $('#saveSharedMailTemplate').addEventListener('click', async () => {
      const name = await requestName('저장할 메일 양식 이름', '안내 메일 양식'); if (!name) return;
      state.library.mailTemplates.push({ id: `mail-template-${Date.now().toString(36)}`, name, subject: $('#mailSubjectTemplate').value, bodyHtml: sanitizeRichHtml($('#mailBodyEditor').innerHTML), savedAt: new Date().toISOString() });
      await persist(); renderGmailPage(); showToast('나중에 다시 사용할 수 있도록 메일 양식을 저장했습니다.', 'success');
    });
    $('#loadSharedMailTemplate').addEventListener('click', () => {
      const template = state.library.mailTemplates.find((item) => item.id === $('#sharedMailTemplateSelect').value); if (!template) { showToast('불러올 메일 양식을 먼저 선택해주세요.', 'error'); return; }
      $('#mailSubjectTemplate').value = template.subject; $('#mailBodyEditor').innerHTML = sanitizeRichHtml(template.bodyHtml); showToast('저장한 메일 양식을 불러왔습니다.', 'success');
    });
    $('#loadGmailSharedRoster')?.addEventListener('click', async () => {
      const project = activeProject(); const roster = state.library.rosters.find((item) => item.id === $('#gmailSharedRosterSelect').value); if (!project || !roster) { showToast('메일을 보낼 사람의 명단을 선택해주세요.', 'error'); return; }
      project.data.columns = JSON.parse(JSON.stringify(roster.columns)); project.data.people = JSON.parse(JSON.stringify(roster.people));
      state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); showToast(`${roster.people.length}명을 메일 작업에 불러왔습니다.`, 'success');
    });
    $('#applyGmailRosterPaste')?.addEventListener('click', async () => {
      const text = $('#gmailRosterPaste').value.trim(); if (!text) { showToast('붙여넣은 명단 데이터가 없습니다.', 'error'); return; }
      const matrix = Ops.parseDelimited(text); if (!matrix.length) { showToast('명단 구조를 인식하지 못했습니다.', 'error'); return; }
      await applyRosterMatrix(matrix); $('#gmailRosterPaste').value = ''; navigate('gmailFlow');
    });
    $('#installExtensionFile').addEventListener('click', async () => {
      try {
        const result = await globalThis.workspaceDesktop.installExtensionFile();
        if (result.canceled) return;
        const manifests = await globalThis.workspaceDesktop.listExtensions(); extensionManifests = manifests; Core.configureExtensionCatalog(manifests);
        state = Core.normalizeState(state); await persist(); renderAll(); renderModulesPage();
        showToast(`“${result.extension.name}” 확장 manifest를 설치했습니다.`, 'success');
      } catch (error) { showToast(`확장 설치 실패: ${error.message}`, 'error'); }
    });
    $('#openProgramLocation').addEventListener('click', () => void globalThis.workspaceDesktop.openProgramLocation());
    const openOriginalGmailFlow = () => void globalThis.workspaceDesktop?.openProgram?.('gmailFlow');
    $('#openOriginalGmailFlow').addEventListener('click', openOriginalGmailFlow);
    $('#gmailFlowAccountButton').addEventListener('click', openOriginalGmailFlow);
    $('#newQuickTask').addEventListener('click', async () => {
      if (!standaloneProgram) return;
      const current = activeProject(); const hasData = current.data.people.length || current.data.slots.length || current.data.communication.mailEdits && Object.keys(current.data.communication.mailEdits).length;
      if (hasData && !await showConfirm('현재 빠른 작업을 비우고 새 작업을 시작할까요? 필요한 내용은 먼저 작업 저장을 눌러 보관하세요.', { title: '새 빠른 작업', action: '새 작업' })) return;
      const fresh = Core.normalizeState({ ...Core.createEmptyState(), installedExtensions: state.installedExtensions }).quickWorkspaces[standaloneProgram];
      state.quickWorkspaces[standaloneProgram] = { ...fresh, id: `quick-${standaloneProgram}`, scope: 'quick', updatedAt: new Date().toISOString() };
      mailEditorDirty = false; await persist(); renderAll(); navigate(standaloneProgram); showToast('새 빠른 작업을 시작했습니다.', 'success');
    });
    $('#saveQuickTask').addEventListener('click', async () => {
      if (!standaloneProgram) return; const name = await requestName('빠른 작업 저장 이름', `${Core.MODULE_CATALOG.find((item) => item.id === standaloneProgram)?.name || '작업'} ${new Date().toLocaleDateString('ko-KR')}`); if (!name) return;
      const snapshot = JSON.parse(JSON.stringify(activeProject())); snapshot.id = `task-${Date.now().toString(36)}`; snapshot.name = name; snapshot.savedAt = new Date().toISOString(); snapshot.updatedAt = snapshot.savedAt;
      if (!state.quickTasks[standaloneProgram]) state.quickTasks[standaloneProgram] = []; state.quickTasks[standaloneProgram].push(snapshot);
      await persist(); renderQuickTasks(); $('#quickTaskSelect').value = snapshot.id; showToast('빠른 작업을 저장했습니다.', 'success');
    });
    $('#quickTaskSelect').addEventListener('change', async (event) => {
      if (!event.target.value || !standaloneProgram) return; const task = state.quickTasks[standaloneProgram].find((item) => item.id === event.target.value); if (!task) return;
      if (!await showConfirm(`“${task.name}” 작업을 불러올까요? 현재 빠른 작업은 교체됩니다.`, { title: '저장된 작업 불러오기', action: '불러오기', danger: false })) { event.target.value = ''; return; }
      state.quickWorkspaces[standaloneProgram] = { ...JSON.parse(JSON.stringify(task)), id: `quick-${standaloneProgram}`, scope: 'quick', updatedAt: new Date().toISOString() };
      mailEditorDirty = false; await persist(); renderAll(); navigate(standaloneProgram); showToast('저장된 작업을 불러왔습니다.', 'success');
    });
    $('#standaloneProjectSelect').addEventListener('change', async (event) => {
      const project = state.projects.find((item) => item.id === event.target.value); if (!project || !standaloneProgram) return;
      if (!await showConfirm(`“${project.name}”의 자료를 현재 빠른 작업으로 복사할까요? 원본 프로젝트는 바뀌지 않습니다.`, { title: '프로젝트 자료 가져오기', action: '가져오기', danger: false })) { event.target.value = ''; return; }
      const copy = JSON.parse(JSON.stringify(project)); copy.id = `quick-${standaloneProgram}`; copy.scope = 'quick'; copy.name = `${project.name} · 빠른 작업`; copy.updatedAt = new Date().toISOString();
      state.quickWorkspaces[standaloneProgram] = copy; mailEditorDirty = false; await persist(); renderAll(); navigate(standaloneProgram); showToast('프로젝트 자료를 가져왔습니다.', 'success');
    });
    $('#declarativeForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const extensionId = standaloneProgram || currentPage;
      const project = activeProject(); if (!project) return;
      if (!project.data.extensionData) project.data.extensionData = {};
      const values = {};
      $$('[data-declarative-field]', event.currentTarget).forEach((control) => { values[control.dataset.declarativeField] = control.type === 'checkbox' ? control.checked : control.value; });
      project.data.extensionData[extensionId] = values; project.updatedAt = new Date().toISOString();
      await persist(); showToast('확장 프로그램 데이터를 저장했습니다.', 'success');
    });
    $$('[data-quick-program]').forEach((button) => button.addEventListener('click', () => void globalThis.workspaceDesktop.openProgram(button.dataset.quickProgram)));
    $$('[data-open-workspace]').forEach((button) => button.addEventListener('click', () => void globalThis.workspaceDesktop.openWorkspace()));
    $$('[data-related-program]').forEach((button) => button.addEventListener('click', () => void openRelatedProgram(button.dataset.relatedProgram)));

    $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.closeDialog)));
    $$('[data-confirm-result]').forEach((button) => button.addEventListener('click', () => resolveConfirm(button.dataset.confirmResult === 'true')));
    $('#confirmForm').addEventListener('submit', (event) => { event.preventDefault(); resolveConfirm(true); });
    $$('[data-name-result]').forEach((button) => button.addEventListener('click', () => resolveNameInput(null)));
    $('#nameInputForm').addEventListener('submit', (event) => { event.preventDefault(); const value = $('#nameInputValue').value.trim(); if (value) resolveNameInput(value); });
    $('#shortcutForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const desktop = $('#shortcutDesktop').checked; const startMenu = $('#shortcutStartMenu').checked;
      if (!desktop && !startMenu) { showToast('바로가기를 만들 위치를 하나 이상 선택해주세요.', 'error'); return; }
      try { await globalThis.workspaceDesktop.createProgramShortcuts($('#shortcutProgramId').value, { desktop, startMenu }); closeDialog('shortcutDialog'); showToast('선택한 위치에 바로가기를 만들었습니다.', 'success'); }
      catch (error) { showToast(`바로가기 생성 실패: ${error.message}`, 'error'); }
    });

    $$('.preset-card input').forEach((input) => input.addEventListener('change', () => {
      $$('.preset-card').forEach((card) => card.classList.toggle('selected', $('input', card).checked));
    }));

    $('#projectSwitcher').addEventListener('change', (event) => { if (event.target.value) void switchProject(event.target.value); });
    $('#projectSearch').addEventListener('input', renderProjectsPage);
    $('#projectStatusFilter').addEventListener('change', renderProjectsPage);
    $('#storageMode').addEventListener('change', async (event) => {
      if (event.target.value === 'drive') {
        if (!connectedDrive()) { event.target.value = 'local'; showToast('먼저 Google Drive 계정에 로그인하여 연결해주세요.', 'error'); navigate('connections'); return; }
      }
      state.preferences.storageMode = event.target.value;
      await persist();
      if (event.target.value === 'drive') await pushStateToDrive(true);
    });
    $('#pushDriveState').addEventListener('click', () => void pushStateToDrive(true));
    $('#pullDriveState').addEventListener('click', async () => {
      const connection = connectedDrive();
      if (!connection) { showToast('Google Drive에서 자료를 가져올 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      try {
        const result = await globalThis.workspaceDesktop.pullDriveState(connection.id);
        if (!result.exists) { showToast('Drive에 저장된 Workspace 데이터가 없습니다.'); return; }
        if (!await showConfirm(`Drive에 ${formatUpdatedAt(result.modifiedTime)} 저장된 데이터로 이 PC의 Workspace를 바꿀까요? 현재 로컬 상태는 덮어씁니다.`, { title: 'Drive 데이터 불러오기', action: '불러오기' })) return;
        state = Core.normalizeState(result.state); state.preferences.storageMode = 'drive'; state.preferences.lastDriveSyncAt = result.modifiedTime;
        await storage.save(state); renderAll(); showToast('Drive 데이터를 불러왔습니다.', 'success');
      } catch (error) { showToast(`Drive 불러오기 실패: ${error.message}`, 'error'); }
    });
    $('#showArchivedSetting').addEventListener('change', async (event) => {
      state.preferences.showArchivedProjects = event.target.checked;
      await persist(); renderAll();
    });
    $('#toggleArchived').addEventListener('click', async () => {
      state.preferences.showArchivedProjects = !state.preferences.showArchivedProjects;
      await persist(); renderAll();
    });

    $('#applyRosterPaste')?.addEventListener('click', () => {
      const matrix = Ops.parseDelimited($('#rosterPasteInput').value);
      if (!matrix.length) { showToast('붙여넣은 데이터가 없습니다.', 'error'); return; }
      void applyRosterMatrix(matrix);
    });
    $('#rosterFileInput')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (_) { text = new TextDecoder('euc-kr').decode(bytes); }
      await applyRosterMatrix(Ops.parseDelimited(text));
      event.target.value = '';
    });
    $('#chooseExcelRoster')?.addEventListener('click', async () => {
      if (!globalThis.workspaceDesktop?.chooseSpreadsheet) { showToast('Excel 직접 가져오기는 데스크톱 앱에서 사용할 수 있습니다.', 'error'); return; }
      try {
        const result = await globalThis.workspaceDesktop.chooseSpreadsheet();
        if (!result.canceled) await applyRosterMatrix(result.matrix);
      } catch (error) { showToast(`Excel을 읽지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#saveRosterData')?.addEventListener('click', () => void saveRoster());
    $('#openRosterManager').addEventListener('click', () => void openRosterManager());
    $('#openMailRosterManager').addEventListener('click', () => void openRosterManager());
    $('#openLibraryRosterManager').addEventListener('click', () => void openRosterManager());
    $('#createRosterView').addEventListener('click', () => void createRosterViewFromCurrent(false));
    $('#saveRosterViewAs').addEventListener('click', () => void createRosterViewFromCurrent(true));
    $('#renameRosterView').addEventListener('click', async () => { const project = activeProject(); const view = activeRosterView(project); if (!project || !view) return; const name = await requestName('단계 명단 이름 변경', view.name); if (!name) return; view.name = name; view.updatedAt = new Date().toISOString(); state = Core.updateProject(state, project.id, { data: project.data }); await persist('단계 명단 이름 변경됨'); renderPeoplePage(); });
    $('#deleteRosterView').addEventListener('click', async () => { const project = activeProject(); const view = activeRosterView(project); if (!project || !view || !await showConfirm(`“${view.name}” 단계 명단을 삭제할까요? 원본 명단과 일정 배정은 삭제되지 않습니다.`, { title: '단계 명단 삭제', action: '삭제' })) return; project.data.rosterViews = project.data.rosterViews.filter((item) => item.id !== view.id); project.data.activeRosterViewId = null; if (project.data.scheduleRules.rosterViewId === view.id) project.data.scheduleRules.rosterViewId = null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('단계 명단 삭제됨'); renderPeoplePage(); });
    $('#rosterViewSelect').addEventListener('change', async (event) => { const project = activeProject(); if (!project) return; project.data.activeRosterViewId = event.target.value || null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('단계 명단 전환됨'); renderPeoplePage(); });
    $('#rosterViewPeople').addEventListener('click', async (event) => { const button = event.target.closest('[data-roster-view-toggle]'); const project = activeProject(); const view = activeRosterView(project); if (!button || !project || !view) return; const ids = new Set(view.excludedPersonIds || []); if (ids.has(button.dataset.rosterViewToggle)) ids.delete(button.dataset.rosterViewToggle); else ids.add(button.dataset.rosterViewToggle); view.excludedPersonIds = [...ids]; view.updatedAt = new Date().toISOString(); state = Core.updateProject(state, project.id, { data: project.data }); await persist('단계 명단 인원 변경됨'); renderPeoplePage(); });
    $('#rosterStartTask').addEventListener('click', openRosterTaskChooser);
    $('#arrangementNewTask').addEventListener('click', openRosterTaskChooser);
    $('#existingArrangementList').addEventListener('click', async (event) => { const button = event.target.closest('[data-open-arrangement]'); const project = activeProject(); if (!button || !project) return; project.data.activeWorkItemId = button.dataset.openArrangement; arrangementSelection = null; state = Core.updateProject(state, project.id, { data: project.data }); closeDialog('rosterTaskChooserDialog'); navigate('arrange'); await persist(); });
    $$('[data-roster-task]').forEach((button) => button.addEventListener('click', () => {
      const task = button.dataset.rosterTask; closeDialog('rosterTaskChooserDialog');
      if (['grouping', 'matching', 'free'].includes(task)) { openArrangementSetup(task); return; }
      openWorkflowModule(task);
    }));
    $('#arrangementMethod').addEventListener('change', (event) => { $('#arrangementSourceColumn').disabled = !['same', 'mixed'].includes(event.target.value); });
    $('#arrangementSetupForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const project = activeProject(); if (!project) return; const values = { type: $('#arrangementType').value, name: $('#arrangementName').value.trim(), method: $('#arrangementMethod').value, groupSize: $('#arrangementGroupSize').value, sourceColumnId: $('#arrangementSourceColumn').value };
      if (!values.name) return; createArrangement(project, values); state = Core.updateProject(state, project.id, { data: project.data }); closeDialog('arrangementSetupDialog'); arrangementSelection = null; renderAll(); navigate('arrange'); await persist('새 명단 작업 생성됨');
    });
    $('#arrangementSelect').addEventListener('change', async (event) => { const project = activeProject(); if (!project) return; project.data.activeWorkItemId = event.target.value; arrangementSelection = null; state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderArrangementPage(); });
    $('#arrangementDelete').addEventListener('click', async () => { const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return; if (!await showConfirm(`“${item.name}” 작업표를 삭제할까요? 원본 명단은 삭제되지 않습니다.`, { title: '명단 작업 삭제', action: '삭제' })) return; project.data.workItems = project.data.workItems.filter((candidate) => candidate.id !== item.id); project.data.activeWorkItemId = project.data.workItems.at(-1)?.id || null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('명단 작업 삭제됨'); if (project.data.activeWorkItemId) renderArrangementPage(); else navigate('people'); });
    $('#arrangementImportExcel').addEventListener('click', async () => { const project = activeProject(); const item = activeWorkItem(project); if (!project || !item || !globalThis.workspaceDesktop?.chooseSpreadsheet) return; try { const result = await globalThis.workspaceDesktop.chooseSpreadsheet(); if (result.canceled || !result.matrix?.length) return; if (!await showConfirm('Excel의 첫 행을 컬럼 이름으로 사용하여 현재 작업표를 교체할까요? 원본 명단은 바뀌지 않습니다.', { title: '작업표 Excel 불러오기', action: '교체', danger: false })) return; const width = Math.max(...result.matrix.map((row) => row.length)); item.columns = Array.from({ length: width }, (_, index) => ({ id: `work-column-${Date.now().toString(36)}-${index}`, name: String(result.matrix[0]?.[index] || `컬럼${index + 1}`) })); item.rows = result.matrix.slice(1).filter((row) => row.some((value) => String(value || '').trim())).map((row, rowIndex) => ({ id: `work-row-${Date.now().toString(36)}-${rowIndex}`, personId: null, values: Object.fromEntries(item.columns.map((column, index) => [column.id, String(row[index] ?? '')])) })); item.updatedAt = new Date().toISOString(); arrangementSelection = null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('Excel 작업표 불러옴'); renderArrangementPage(); } catch (error) { showToast(`Excel을 불러오지 못했습니다: ${error.message}`, 'error'); } });
    $('#arrangementDownloadCsv').addEventListener('click', async () => { const item = activeWorkItem(); if (!item) return; if (globalThis.workspaceDesktop?.exportWorkItem) { try { const result = await globalThis.workspaceDesktop.exportWorkItem(item); if (!result.canceled) showToast('작업표를 Excel로 저장했습니다.', 'success'); } catch (error) { showToast(`Excel을 저장하지 못했습니다: ${error.message}`, 'error'); } return; } const rows = [item.columns.map((column) => column.name), ...item.rows.map((row) => item.columns.map((column) => row.values[column.id] || ''))]; const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n'); downloadText(`${item.name}.csv`, `\ufeff${csv}`, 'text/csv;charset=utf-8'); });
    $('#addRoleButton').addEventListener('click', () => {
      const project = activeProject(); if (!project) return;
      createProjectRole(project, `새 역할 ${project.data.roles.length + 1}`);
      renderSchedulePage();
    });
    $('#addSlotsButton').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const parsed = Ops.parseSlots($('#slotBulkInput').value);
      $('#slotParseErrors').hidden = parsed.errors.length === 0;
      $('#slotParseErrors').textContent = parsed.errors.join('\n');
      if (!parsed.slots.length) { if (!parsed.errors.length) showToast('추가할 시간대를 입력해주세요.', 'error'); return; }
      const keys = new Set(project.data.slots.map(Ops.slotKey));
      const additions = parsed.slots.filter((slot) => !keys.has(Ops.slotKey(slot)));
      project.data.slots.push(...additions);
      state = Core.updateProject(state, project.id, { data: project.data });
      await persist(); renderAll(); $('#slotBulkInput').value = '';
      showToast(`${additions.length}개 시간대를 추가했습니다.`, 'success');
    });
    $('#clearSlotsButton').addEventListener('click', async () => {
      const project = activeProject(); if (!project || !project.data.slots.length) return;
      if (!await showConfirm('모든 시간대와 현재 배정을 지울까요?', { title: '시간대 전체 삭제', action: '삭제' })) return;
      project.data.slots = []; project.data.availability = {}; project.data.assignments = []; project.data.conflicts = [];
      state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll();
    });
    $('#generateScheduleButton').addEventListener('click', () => void generateSchedule());
    $('#saveScheduleVersion').addEventListener('click', () => void saveScheduleSnapshot());
    $('#layoutType').addEventListener('change', async (event) => {
      const project = activeProject(); if (!project) return;
      project.data.layout.type = event.target.value; state = Core.updateProject(state, project.id, { data: project.data }); await persist();
    });
    $('#exportCsvButton').addEventListener('click', () => {
      const project = activeProject(); if (!project) return;
      downloadText(`${project.name}-일정.csv`, Ops.scheduleToCsv(project), 'text/csv;charset=utf-8');
    });
    $('#exportExcelButton').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      if (globalThis.workspaceDesktop?.exportSpreadsheet) {
        try {
          const result = await globalThis.workspaceDesktop.exportSpreadsheet(project);
          if (!result.canceled) showToast('Excel 통합 문서를 저장했습니다.', 'success');
        } catch (error) { showToast(`Excel을 저장하지 못했습니다: ${error.message}`, 'error'); }
      } else downloadText(`${project.name}-일정.xml`, Ops.scheduleToExcelXml(project), 'application/vnd.ms-excel;charset=utf-8');
    });
    $('#buildFormDefinition').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      if ($('#formDefinitionType').value === 'availability' && !project.data.slots.length) { showToast('가능 시간을 조사하려면 일정 편성 화면에서 선택할 시간대를 먼저 추가해주세요.', 'error'); return; }
      const definition = Ops.buildGoogleFormDefinition(project, $('#formDefinitionType').value);
      project.data.forms.definitions.push(definition);
      state = Core.updateProject(state, project.id, { data: project.data });
      state = Core.setModuleStatus(state, project.id, 'forms', 'inProgress', `${definition.title} 준비됨`);
      await persist(); renderAll(); showToast('Google 설문에 들어갈 질문과 선택지를 준비했습니다.', 'success');
    });
    $('#createGoogleForm').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const definition = project.data.forms.definitions.at(-1);
      const connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'forms') && item.status === 'connected');
      if (!definition) { showToast('먼저 “설문 내용 미리 만들기”를 눌러 질문을 확인해주세요.', 'error'); return; }
      if (!connection) { showToast('설문을 만들 Google 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      if (!await showConfirm(`“${definition.title}” 설문을 ${connection.account || connection.label} 계정에 만들까요?`, { title: 'Google 설문 만들기', action: '설문 만들기' })) return;
      try {
        const created = await globalThis.workspaceDesktop.createGoogleForm(connection.id, definition, Ops.googleFormsApiRequests(definition));
        project.data.forms.linkedForms.push({ ...created, definitionId: definition.id, type: definition.type, title: definition.title, source: 'created', connectedAt: new Date().toISOString() });
        state = Core.updateProject(state, project.id, { data: project.data });
        state = Core.setModuleStatus(state, project.id, 'forms', 'inProgress', `${definition.title} 생성됨`);
        await persist(); renderAll(); showToast('Google 설문을 만들고 이 프로젝트에 연결했습니다.', 'success');
      } catch (error) { showToast(`Google 설문을 만들지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#downloadFormDefinition').addEventListener('click', () => {
      const project = activeProject(); if (!project) return; const definition = project.data.forms.definitions.at(-1);
      if (!definition) { showToast('먼저 설문 내용을 미리 만들어주세요.', 'error'); return; }
      const payload = { form: { info: { title: definition.title, documentTitle: definition.title } }, batchUpdate: { requests: Ops.googleFormsApiRequests(definition) } };
      downloadText(`${definition.title}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    });
    $('#saveLinkedForm').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return; const raw = $('#linkedFormId').value.trim(); if (!raw) { showToast('Google Form ID 또는 URL을 입력해주세요.', 'error'); return; }
      const match = raw.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/); const formId = match?.[1] || raw;
      if (!/^[a-zA-Z0-9_-]{10,}$/.test(formId)) { showToast('Google Form ID 형식을 확인해주세요.', 'error'); return; }
      if (!project.data.forms.linkedForms.some((item) => item.formId === formId)) project.data.forms.linkedForms.push({ formId, type: $('#formDefinitionType').value, source: 'manual', connectedAt: new Date().toISOString() });
      state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); showToast('기존 Google Form을 프로젝트에 연결했습니다.', 'success');
    });
    $('#syncFormResponses').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'forms'));
      if (!connection || connection.status !== 'connected') { showToast('응답을 가져올 Google 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      const linked = project.data.forms.linkedForms.at(-1);
      if (!linked) { showToast('응답을 가져올 Google 설문을 먼저 이 프로젝트에 연결해주세요.', 'error'); return; }
      try {
        const payload = await globalThis.workspaceDesktop.fetchGoogleFormResponses(connection.id, linked.formId);
        const result = applyFormResponses(project, linked, payload);
        project.data.forms.lastResponseSyncAt = new Date().toISOString(); linked.lastSyncedAt = project.data.forms.lastResponseSyncAt; linked.responseCount = payload.responses.length;
        state = Core.updateProject(state, project.id, { data: project.data });
        state = Core.setModuleStatus(state, project.id, 'forms', 'inProgress', `${payload.responses.length}건 동기화`);
        await persist(); renderAll(); showToast(result.message, 'success');
      } catch (error) { showToast(`최신 설문 응답을 가져오지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#prepareZoomMeetings').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const problems = [];
      project.data.slots.forEach((slot) => {
        const connectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
        const connection = state.connections.find((item) => item.id === connectionId && item.type === 'zoom');
        if (!connection) problems.push(`${Ops.slotKey(slot)} · Zoom 계정 미지정`);
        else if (connection.status !== 'connected') problems.push(`${Ops.slotKey(slot)} · ${connection.label} 로그인 필요`);
        if (!project.data.assignments.some((assignment) => assignment.slotId === slot.id)) problems.push(`${Ops.slotKey(slot)} · 배정 인원 없음`);
      });
      const message = problems.length ? problems.slice(0, 20).join('\n') : `${project.data.slots.length}개 회의를 생성할 준비가 되었습니다.`;
      $('#zoomReadiness').textContent = message;
      state = Core.setModuleStatus(state, project.id, 'zoom', problems.length ? 'needsReview' : 'inProgress', problems.length ? `${problems.length}건 확인 필요` : '회의를 만들 준비 완료');
      await persist(); renderDashboard();
      showToast(problems.length ? `Zoom 회의를 만들기 전에 확인할 항목이 ${problems.length}건 있습니다.` : '모든 일정에 Zoom 회의를 만들 준비가 되었습니다.', problems.length ? 'normal' : 'success');
    });
    $('#createZoomMeetings').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const pending = project.data.slots.filter((slot) => project.data.assignments.some((assignment) => assignment.slotId === slot.id) && !project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status === 'created'));
      const invalid = pending.filter((slot) => !state.connections.some((item) => item.id === (slot.zoomConnectionId || defaultConnectionId(project, 'zoom')) && item.type === 'zoom' && item.status === 'connected'));
      if (!pending.length) { showToast('새로 생성할 Zoom 회의가 없습니다.'); return; }
      if (invalid.length) { showToast(`로그인이 필요한 Zoom 계정이 사용된 일정 ${invalid.length}건을 먼저 확인해주세요.`, 'error'); return; }
      if (!await showConfirm(`${pending.length}개의 Zoom 회의를 만들까요? 이미 참가 링크가 있는 일정은 건너뜁니다.`, { title: 'Zoom 회의 만들기', action: '회의 만들기' })) return;
      let createdCount = 0; const failures = [];
      for (const slot of pending) {
        const connectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
        const start = new Date(`${slot.date}T${slot.startTime}:00`); const end = new Date(`${slot.date}T${slot.endTime}:00`);
        try {
          const meeting = await globalThis.workspaceDesktop.createZoomMeeting(connectionId, { topic: `${project.name}${slot.label ? ` · ${slot.label}` : ''}`, date: slot.date, startTime: slot.startTime, duration: Math.max(1, Math.round((end - start) / 60000)), timezone: 'Asia/Seoul', agenda: `${project.name} 일정` });
          project.data.externalArtifacts.push({ kind: 'zoom', slotId: slot.id, connectionId, status: 'created', externalId: String(meeting.id), joinUrl: meeting.join_url || '', startUrl: meeting.start_url || '', password: meeting.password || '', createdAt: new Date().toISOString() });
          createdCount += 1; $('#zoomReadiness').textContent = `${createdCount}/${pending.length} 생성 완료`;
        } catch (error) { failures.push(`${Ops.slotKey(slot)}: ${error.message}`); }
      }
      state = Core.updateProject(state, project.id, { data: project.data });
      state = Core.setModuleStatus(state, project.id, 'zoom', failures.length ? 'needsReview' : 'complete', failures.length ? `${createdCount}개 생성, ${failures.length}개 실패` : `${createdCount}개 생성 완료`);
      await persist(); renderAll(); showToast(failures.length ? `Zoom ${createdCount}개 생성, ${failures.length}개 실패` : `Zoom 회의 ${createdCount}개를 생성했습니다.`, failures.length ? 'error' : 'success');
    });
    $('#prepareMailPackage').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const previousSubject = project.data.communication.subjectTemplate; const previousHtml = project.data.communication.bodyHtmlTemplate;
      project.data.communication.subjectTemplate = $('#mailSubjectTemplate').value;
      project.data.communication.bodyHtmlTemplate = sanitizeRichHtml($('#mailBodyEditor').innerHTML);
      project.data.communication.bodyTemplate = richText(project.data.communication.bodyHtmlTemplate);
      if (previousSubject !== project.data.communication.subjectTemplate || previousHtml !== project.data.communication.bodyHtmlTemplate) project.data.externalArtifacts.filter((item) => item.kind === 'gmailDraft').forEach((item) => { item.status = 'stale'; });
      project.data.communication.lastPreparedAt = new Date().toISOString();
      mailEditorDirty = false;
      const pkg = Ops.buildMailPackage(project);
      state = Core.updateProject(state, project.id, { data: project.data });
      state = Core.setModuleStatus(state, project.id, 'gmailFlow', pkg.entries.length ? 'inProgress' : 'needsReview', `${pkg.entries.length}명 메일 준비`);
      await persist(); renderAll(); showToast(`${pkg.entries.length}명의 메일 데이터를 준비했습니다.`, 'success');
    });
    $('#createGmailDrafts').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const previousSubject = project.data.communication.subjectTemplate; const previousHtml = project.data.communication.bodyHtmlTemplate;
      project.data.communication.subjectTemplate = $('#mailSubjectTemplate').value;
      project.data.communication.bodyHtmlTemplate = sanitizeRichHtml($('#mailBodyEditor').innerHTML); project.data.communication.bodyTemplate = richText(project.data.communication.bodyHtmlTemplate);
      if (previousSubject !== project.data.communication.subjectTemplate || previousHtml !== project.data.communication.bodyHtmlTemplate) project.data.externalArtifacts.filter((item) => item.kind === 'gmailDraft').forEach((item) => { item.status = 'stale'; });
      mailEditorDirty = false;
      const connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'gmail') && item.status === 'connected');
      const pending = Ops.buildMailPackage(project).entries.filter((entry) => !project.data.externalArtifacts.some((item) => item.kind === 'gmailDraft' && item.personId === entry.personId && item.status === 'created'));
      if (!pending.length) { showToast('새로 Gmail 임시보관함에 만들 메일이 없습니다.'); return; }
      const needsNewDraft = pending.some((entry) => !project.data.externalArtifacts.some((item) => item.kind === 'gmailDraft' && item.personId === entry.personId));
      if (needsNewDraft && !connection) { showToast('메일을 만들 Gmail 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      if (!await showConfirm(`${pending.length}명의 메일을 Gmail 임시보관함에 만들거나 기존 내용을 수정할까요? 아직 실제 발송은 하지 않습니다.`, { title: 'Gmail 임시보관함에 저장', action: '저장하기' })) return;
      let createdCount = 0; let updatedCount = 0; const failures = [];
      for (const entry of pending) {
        try {
          const artifact = project.data.externalArtifacts.find((item) => item.kind === 'gmailDraft' && item.personId === entry.personId);
          if (artifact) {
            const artifactConnection = state.connections.find((item) => item.id === artifact.connectionId && item.status === 'connected');
            if (!artifactConnection) throw new Error('기존 메일을 만든 Gmail 계정에 다시 로그인해야 합니다.');
            const draft = await globalThis.workspaceDesktop.updateGmailDraft(artifactConnection.id, artifact.externalId, entry);
            artifact.messageId = draft.message?.id || artifact.messageId; artifact.status = 'created'; artifact.updatedAt = new Date().toISOString(); updatedCount += 1;
          } else {
            const draft = await globalThis.workspaceDesktop.createGmailDraft(connection.id, entry);
            project.data.externalArtifacts.push({ kind: 'gmailDraft', personId: entry.personId, connectionId: connection.id, status: 'created', externalId: draft.id, messageId: draft.message?.id || '', createdAt: new Date().toISOString() }); createdCount += 1;
          }
          $('#mailPackageStatus').textContent = `${createdCount + updatedCount}/${pending.length} Gmail 저장 완료`;
        } catch (error) { failures.push(`${entry.email}: ${error.message}`); }
      }
      project.data.communication.lastPreparedAt = new Date().toISOString();
      state = Core.updateProject(state, project.id, { data: project.data });
      state = Core.setModuleStatus(state, project.id, 'gmailFlow', failures.length ? 'needsReview' : 'complete', failures.length ? `${createdCount}개 생성, ${updatedCount}개 수정, ${failures.length}개 실패` : `${createdCount}개 생성, ${updatedCount}개 수정`);
      await persist(); renderAll(); showToast(failures.length ? `Gmail 임시보관함: 새 메일 ${createdCount}개, 수정 ${updatedCount}개, 실패 ${failures.length}개` : `Gmail 임시보관함에 새 메일 ${createdCount}개를 만들고 기존 메일 ${updatedCount}개를 수정했습니다.`, failures.length ? 'error' : 'success');
    });
    $('#downloadMailPackage').addEventListener('click', () => {
      const project = activeProject(); if (!project) return; const pkg = Ops.buildMailPackage(project);
      if (!pkg.entries.length) { showToast('이메일이 있는 명단과 일정을 먼저 준비해주세요.', 'error'); return; }
      downloadText(`${project.name}-Gmail-Flow.csv`, Ops.mailPackageToCsv(pkg), 'text/csv;charset=utf-8');
    });

    document.addEventListener('change', async (event) => {
      const project = activeProject(); if (!project) return;
      if (event.target.matches('[data-column-name]')) {
        const column = project.data.columns.find((item) => item.id === event.target.dataset.columnName); if (column) column.name = event.target.value.trim() || column.name;
        if (rosterSelection) updateRosterSelection(rosterSelection.anchor, rosterSelection.focus);
      }
      if (event.target.matches('[data-column-type]')) {
        const column = project.data.columns.find((item) => item.id === event.target.dataset.columnType); if (column) column.type = event.target.value;
        syncPersonDerivedFields(project);
      }
      if (event.target.matches('[data-person-row]')) {
        const rowIndex = Number(event.target.dataset.personRow);
        const person = project.data.people[rowIndex] || (event.target.value.length ? ensureRosterPerson(project, rowIndex + 1) : null);
        if (person) person.values[event.target.dataset.columnId] = event.target.value;
        syncPersonDerivedFields(project);
        if (rosterSelection) updateRosterSelection(rosterSelection.anchor, rosterSelection.focus);
        state = Core.updateProject(state, project.id, { data: project.data }); await persist('명단 셀 편집됨'); renderPeoplePage();
        return;
      }
      if (event.target.matches('[data-person-role-check]')) {
        const person = project.data.people.find((item) => item.id === event.target.dataset.personRoleCheck);
        if (person) {
          const roles = new Set(person.roleIds || []); if (event.target.checked) roles.add(event.target.dataset.roleId); else roles.delete(event.target.dataset.roleId); person.roleIds = [...roles];
          if (!person.roleIds.length) { person.roleIds = [project.data.roles[0]?.id || 'participant']; showToast('사람은 최소 한 개 역할을 가져야 합니다.'); renderPeoplePage(); }
        }
      }
      if (event.target.matches('[data-person-active]')) {
        const person = project.data.people.find((item) => item.id === event.target.dataset.personActive); if (person) person.active = event.target.checked;
      }
      if (event.target.matches('[data-availability-all]')) {
        project.data.availability[event.target.dataset.availabilityAll] = event.target.checked ? project.data.slots.map((slot) => slot.id) : [];
        state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderSchedulePage();
      }
      if (event.target.matches('[data-availability-person]')) {
        const personId = event.target.dataset.availabilityPerson; const slotId = event.target.dataset.availabilitySlot;
        const selected = new Set(project.data.availability[personId] || []); if (event.target.checked) selected.add(slotId); else selected.delete(slotId); project.data.availability[personId] = [...selected];
        state = Core.updateProject(state, project.id, { data: project.data }); await persist();
      }
      if (event.target.matches('[data-assignment-slot]')) {
        const slotId = event.target.dataset.assignmentSlot; const roleId = event.target.dataset.assignmentRole; const position = Number(event.target.dataset.assignmentPosition);
        const matches = project.data.assignments.filter((assignment) => assignment.slotId === slotId && assignment.roleId === roleId);
        const existing = matches[position]; if (existing) project.data.assignments = project.data.assignments.filter((assignment) => assignment.id !== existing.id);
        if (event.target.value) project.data.assignments.push({ id: `assignment-${Date.now().toString(36)}-${position}`, slotId, roleId, personId: event.target.value, locked: false, source: 'manual' });
        project.data.conflicts = Ops.validateAssignments({ assignments: project.data.assignments, people: project.data.people, roles: project.data.roles, slots: project.data.slots }).map((message) => ({ type: 'validation', message }));
        state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderScheduleBoard(Core.getActiveProject(state));
      }
      if (event.target.matches('[data-slot-lock]')) {
        const slot = project.data.slots.find((item) => item.id === event.target.dataset.slotLock); if (slot) slot.locked = event.target.checked; project.data.assignments.filter((assignment) => assignment.slotId === slot?.id).forEach((assignment) => { assignment.locked = event.target.checked; }); state = Core.updateProject(state, project.id, { data: project.data }); await persist();
      }
      if (event.target.matches('[data-slot-status]')) {
        const slot = project.data.slots.find((item) => item.id === event.target.dataset.slotStatus); if (slot) slot.status = event.target.value; state = Core.updateProject(state, project.id, { data: project.data }); await persist();
      }
      if (event.target.matches('[data-slot-label]')) {
        const slot = project.data.slots.find((item) => item.id === event.target.dataset.slotLabel); if (slot) slot.label = event.target.value; state = Core.updateProject(state, project.id, { data: project.data }); await persist();
      }
      if (event.target.matches('[data-zoom-slot-connection]')) {
        const slot = project.data.slots.find((item) => item.id === event.target.dataset.zoomSlotConnection); if (slot) slot.zoomConnectionId = event.target.value || null;
        state = Core.updateProject(state, project.id, { data: project.data }); await persist();
      }
      if (event.target.matches('[data-role-field], #ruleAvoidRepeat, #ruleAvoidPast, #ruleGroupPreference, #ruleUnmarkedAvailable')) {
        await persistScheduleData();
      }
    });

    document.addEventListener('click', async (event) => {
      const personRemove = event.target.closest('[data-person-remove]');
      if (personRemove) {
        const project = activeProject(); if (!project) return;
        const person = project.data.people.find((item) => item.id === personRemove.dataset.personRemove);
        if (await showConfirm(`“${person?.name || '이름 없는 사람'}”을 명단에서 삭제할까요? 연결된 가능 시간과 일정 배정도 삭제됩니다.`, { title: '명단 삭제', action: '삭제' })) {
          project.data.people = project.data.people.filter((item) => item.id !== personRemove.dataset.personRemove);
          delete project.data.availability[personRemove.dataset.personRemove];
          project.data.assignments = project.data.assignments.filter((assignment) => assignment.personId !== personRemove.dataset.personRemove);
          state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll();
        }
        return;
      }
      const roleRemove = event.target.closest('[data-role-remove]');
      if (roleRemove) {
        const project = activeProject(); if (!project) return;
        const used = project.data.people.some((person) => person.roleIds.includes(roleRemove.dataset.roleRemove)) || project.data.assignments.some((assignment) => assignment.roleId === roleRemove.dataset.roleRemove);
        if (used) { showToast('명단이나 일정에서 사용 중인 역할은 삭제할 수 없습니다.', 'error'); return; }
        project.data.roles = project.data.roles.filter((role) => role.id !== roleRemove.dataset.roleRemove);
        state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); return;
      }
      const slotRemove = event.target.closest('[data-slot-remove]');
      if (slotRemove) {
        const project = activeProject(); if (!project) return;
        const slot = project.data.slots.find((item) => item.id === slotRemove.dataset.slotRemove);
        if (slot?.locked) { showToast('잠긴 세션은 잠금을 해제한 뒤 삭제해주세요.', 'error'); return; }
        project.data.slots = project.data.slots.filter((item) => item.id !== slotRemove.dataset.slotRemove);
        project.data.assignments = project.data.assignments.filter((assignment) => assignment.slotId !== slotRemove.dataset.slotRemove);
        Object.keys(project.data.availability).forEach((personId) => { project.data.availability[personId] = project.data.availability[personId].filter((id) => id !== slotRemove.dataset.slotRemove); });
        state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); return;
      }
      const versionRestore = event.target.closest('[data-version-restore]');
      if (versionRestore) {
        const project = activeProject(); if (!project) return;
        const version = project.data.versions[Number(versionRestore.dataset.versionRestore)]; if (!version) return;
        if (!await showConfirm(`“${version.name}” 상태로 일정을 복원할까요? 현재 상태는 먼저 별도 버전으로 저장하는 것을 권장합니다.`, { title: '일정 버전 복원', action: '복원', danger: false })) return;
        project.data.slots = JSON.parse(JSON.stringify(version.slots)); project.data.assignments = JSON.parse(JSON.stringify(version.assignments)); project.data.conflicts = JSON.parse(JSON.stringify(version.conflicts));
        state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); showToast('일정 버전을 복원했습니다.', 'success'); return;
      }
      const navLink = event.target.closest('[data-nav-link]');
      if (navLink) { navigate(navLink.dataset.navLink); return; }
      const workflowCheck = event.target.closest('[data-workflow-check]');
      if (workflowCheck) {
        const project = activeProject(); const step = project?.workflow.find((item) => item.id === activeWorkflowStepId); const item = step?.checklist.find((candidate) => candidate.id === workflowCheck.dataset.workflowCheck); if (!project || !step || !item) return;
        item.done = workflowCheck.checked; step.updatedAt = new Date().toISOString(); state = Core.updateProject(state, project.id, { workflow: project.workflow }); await persist(); renderWorkflowTaskPage(); return;
      }
      const workflowCheckRemove = event.target.closest('[data-workflow-check-remove]');
      if (workflowCheckRemove) {
        event.preventDefault(); const project = activeProject(); const step = project?.workflow.find((item) => item.id === activeWorkflowStepId); if (!project || !step) return;
        step.checklist = step.checklist.filter((item) => item.id !== workflowCheckRemove.dataset.workflowCheckRemove); state = Core.updateProject(state, project.id, { workflow: project.workflow }); await persist(); renderWorkflowTaskPage(); return;
      }
      const sidebarProject = event.target.closest('[data-project-id]');
      if (sidebarProject) { await switchProject(sidebarProject.dataset.projectId); return; }
      const workflowStepOpen = event.target.closest('[data-workflow-step-open]');
      if (workflowStepOpen) { openWorkflowStep(workflowStepOpen.dataset.workflowStepOpen); return; }
      const workflowOpen = event.target.closest('[data-workflow-open]');
      if (workflowOpen) { openWorkflowModule(workflowOpen.dataset.workflowOpen); return; }
      const mailEdit = event.target.closest('[data-mail-edit]');
      if (mailEdit) { openPersonalMailEditor(mailEdit.dataset.mailEdit); return; }
      const moduleToggle = event.target.closest('[data-module-toggle]');
      if (moduleToggle) {
        const moduleId = moduleToggle.dataset.moduleToggle;
        const installed = state.installedExtensions.includes(moduleId);
        try {
          if (installed) await globalThis.workspaceDesktop.removeProgramShortcuts(moduleId);
          state = Core.setExtensionInstalled(state, moduleId, !installed);
          await persist(); renderAll(); renderModulesPage();
          showToast(installed ? '프로그램을 Workspace에서 제거했습니다.' : '프로그램을 Workspace에 설치했습니다.', 'success');
        } catch (error) { showToast(error.message, 'error'); }
        return;
      }
      const programLaunch = event.target.closest('[data-program-launch]');
      if (programLaunch) { await globalThis.workspaceDesktop.openProgram(programLaunch.dataset.programLaunch); return; }
      const programShortcut = event.target.closest('[data-program-shortcut]');
      if (programShortcut) {
        $('#shortcutProgramId').value = programShortcut.dataset.programShortcut; openDialog('shortcutDialog');
        return;
      }
      const programShortcutRemove = event.target.closest('[data-program-shortcut-remove]');
      if (programShortcutRemove) { await globalThis.workspaceDesktop.removeProgramShortcuts(programShortcutRemove.dataset.programShortcutRemove); showToast('바탕화면과 시작 메뉴 바로가기를 제거했습니다.'); return; }
      const templateUse = event.target.closest('[data-template-use]');
      if (templateUse) { openNewProjectDialog(templateUse.dataset.templateUse); return; }
      const workflowTemplateRemove = event.target.closest('[data-workflow-template-remove]');
      if (workflowTemplateRemove) {
        const template = state.library.workflowTemplates.find((item) => item.id === workflowTemplateRemove.dataset.workflowTemplateRemove); if (!template) return;
        if (!await showConfirm(`“${template.name} v${template.version}” 템플릿을 삭제할까요? 이미 만든 프로젝트의 업무 구성은 그대로 유지됩니다.`, { title: '업무 템플릿 삭제', action: '삭제' })) return;
        try { state = Core.removeWorkflowTemplate(state, template.id); await persist(); renderLibraryPage(); showToast('업무 템플릿을 삭제했습니다.'); } catch (error) { showToast(error.message, 'error'); } return;
      }
      const libraryAction = event.target.closest('[data-library-rename], [data-library-duplicate], [data-library-remove]');
      if (libraryAction) {
        const kind = libraryAction.dataset.libraryKind; const list = kind === 'roster' ? state.library.rosters : state.library.mailTemplates;
        const id = libraryAction.dataset.libraryRename || libraryAction.dataset.libraryDuplicate || libraryAction.dataset.libraryRemove; const item = list.find((candidate) => candidate.id === id); if (!item) return;
        if (libraryAction.dataset.libraryRename) { const name = await requestName('저장 자료 이름 변경', item.name); if (!name) return; item.name = name; item.savedAt = new Date().toISOString(); }
        if (libraryAction.dataset.libraryDuplicate) { const copy = JSON.parse(JSON.stringify(item)); copy.id = `${kind}-${Date.now().toString(36)}`; copy.name = `${item.name} 복사본`; copy.savedAt = new Date().toISOString(); list.push(copy); }
        if (libraryAction.dataset.libraryRemove) { if (!await showConfirm(`저장한 “${item.name}”을 삭제할까요? 이미 프로젝트에서 사용 중인 내용은 그대로 유지됩니다.`, { title: '저장 자료 삭제', action: '삭제' })) return; state.deletedLibraryIds.push(item.id); list.splice(list.indexOf(item), 1); }
        await persist(); renderLibraryPage(); showToast('저장 자료를 업데이트했습니다.', 'success'); return;
      }
      const extensionFileRemove = event.target.closest('[data-extension-file-remove]');
      if (extensionFileRemove) {
        const module = Core.MODULE_CATALOG.find((item) => item.id === extensionFileRemove.dataset.extensionFileRemove);
        if (!await showConfirm(`“${module?.name || '확장'}” 로컬 확장 파일을 삭제할까요? 프로젝트의 활성화 기록도 정리됩니다.`, { title: '확장 파일 삭제', action: '삭제' })) return;
        await globalThis.workspaceDesktop.removeExtensionFile(extensionFileRemove.dataset.extensionFileRemove);
        const manifests = await globalThis.workspaceDesktop.listExtensions(); extensionManifests = manifests; Core.configureExtensionCatalog(manifests); state = Core.normalizeState(state);
        await persist(); renderAll(); renderModulesPage(); showToast('로컬 확장 파일을 삭제했습니다.'); return;
      }
      const openProject = event.target.closest('[data-project-open]');
      if (openProject) { await switchProject(openProject.dataset.projectOpen); return; }
      const duplicate = event.target.closest('[data-project-duplicate]');
      if (duplicate) {
        const result = Core.duplicateProject(state, duplicate.dataset.projectDuplicate);
        state = result.state; await persist(); renderAll(); renderProjectsPage();
        showToast('프로젝트를 새 복사본으로 만들었습니다.', 'success'); return;
      }
      const restore = event.target.closest('[data-project-restore]');
      if (restore) {
        state = Core.restoreProject(state, restore.dataset.projectRestore);
        await persist(); renderAll(); renderProjectsPage(); showToast('프로젝트를 복원했습니다.', 'success'); return;
      }
      const authorizeConnection = event.target.closest('[data-connection-authorize]');
      if (authorizeConnection) {
        const connection = state.connections.find((item) => item.id === authorizeConnection.dataset.connectionAuthorize); if (!connection) return;
        authorizeConnection.disabled = true; authorizeConnection.textContent = '브라우저 로그인 기다리는 중';
        try {
          const status = await globalThis.workspaceDesktop.authorizeConnection(connection.id, { loginHint: connection.account || '', selectAccount: true });
          connection.status = status.connected ? 'connected' : 'needsAuth'; connection.account = status.account || connection.account; connection.updatedAt = new Date().toISOString();
          await persist(); renderAll(); renderConnectionsPage(); showToast(`${connection.account || connection.label} 계정을 연결했습니다.`, 'success');
        } catch (error) { connection.status = 'error'; await persist(); renderConnectionsPage(); showToast(`계정에 로그인하지 못했습니다: ${error.message}`, 'error'); }
        return;
      }
      const disconnectConnection = event.target.closest('[data-connection-disconnect]');
      if (disconnectConnection) {
        const connection = state.connections.find((item) => item.id === disconnectConnection.dataset.connectionDisconnect); if (!connection) return;
        if (!await showConfirm(`“${connection.label}” 계정의 로그인을 해제할까요? 다시 연결할 수 있도록 계정 설정은 남겨둡니다.`, { title: '계정 연결 해제', action: '연결 해제' })) return;
        await globalThis.workspaceDesktop.disconnectConnection(connection.id); connection.status = 'needsAuth'; connection.account = '';
        await persist(); renderAll(); renderConnectionsPage(); showToast('계정 연결을 해제했습니다.'); return;
      }
      const removeConnection = event.target.closest('[data-connection-remove]');
      if (removeConnection) {
        const connection = state.connections.find((item) => item.id === removeConnection.dataset.connectionRemove);
        if (await showConfirm(`“${connection?.label || '계정'}” 설정을 완전히 삭제할까요? 이 계정을 기본으로 사용하던 프로젝트에서도 선택이 해제됩니다.`, { title: '계정 설정 삭제', action: '삭제' })) {
          await globalThis.workspaceDesktop.removeConnection(removeConnection.dataset.connectionRemove);
          state = Core.removeConnection(state, removeConnection.dataset.connectionRemove);
          await persist(); renderAll(); renderConnectionsPage(); showToast('계정 설정을 삭제했습니다.');
        }
      }
    });

    $('#duplicateProjectButton').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const result = Core.duplicateProject(state, project.id);
      state = result.state; await persist(); renderAll(); showToast('프로젝트 복사본을 만들었습니다.', 'success');
    });
    $('#archiveProjectButton').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      if (!await showConfirm(`“${project.name}” 프로젝트를 보관할까요? 데이터는 삭제되지 않으며 언제든 복원할 수 있습니다.`, { title: '프로젝트 보관', action: '보관' })) return;
      state = Core.archiveProject(state, project.id);
      await persist(); renderAll(); showToast('프로젝트를 보관했습니다.');
    });
  }

  async function initialize() {
    const [savedState, manifests, gmailSummary] = await Promise.all([
      storage.load(),
      globalThis.workspaceDesktop?.listExtensions?.() || Promise.resolve([]),
      globalThis.workspaceDesktop?.gmailFlowSummary?.() || Promise.resolve(null)
    ]);
    if (gmailSummary) gmailFlowSummary = gmailSummary;
    extensionManifests = manifests;
    if (manifests.length) Core.configureExtensionCatalog(manifests);
    state = Core.normalizeState(savedState);
    if (standaloneProgram) {
      document.body.classList.add('standalone'); $('#standaloneBar').hidden = false;
      const module = Core.MODULE_CATALOG.find((item) => item.id === standaloneProgram); $('#standaloneTitle').textContent = module?.name || 'CMOE 프로그램'; document.title = `${module?.name || 'CMOE'} · CMOE Workspace`;
      const related = { gmailFlow: ['people', 'schedule'], schedule: ['people', 'layout', 'zoom', 'gmailFlow'], people: ['schedule', 'gmailFlow'], layout: ['schedule', 'gmailFlow'], zoom: ['schedule', 'gmailFlow'], forms: ['people', 'schedule'] }[standaloneProgram] || [];
      $$('[data-quick-program]').forEach((button) => { button.hidden = !related.includes(button.dataset.quickProgram); });
      if (!state.installedExtensions.includes(standaloneProgram)) { await globalThis.workspaceDesktop.openWorkspace(); window.close(); return; }
      currentPage = standaloneProgram;
    }
    Core.CONNECTION_TYPES.forEach((type) => {
      const option = element('option', '', type.name);
      option.value = type.id;
      $('#connectionType').append(option);
    });
    $('#connectionType').dispatchEvent(new Event('change'));
    bindEvents();
    renderAll();
    if (standaloneProgram) navigate(standaloneProgram);
    if (globalThis.workspaceDesktop) {
      const info = await globalThis.workspaceDesktop.getAppInfo();
      $('#appVersion').textContent = `CMOE Workspace ${info.version}`;
      globalThis.workspaceDesktop.onStateChanged((nextState) => {
        const normalized = Core.normalizeState(nextState);
        if (normalized.updatedAt !== state.updatedAt) {
          state = normalized;
          if (mailEditorDirty && currentPage === 'gmailFlow') {
            showToast('다른 창의 변경사항을 받았습니다. 작성 중인 메일은 그대로 보호됩니다.');
            renderGmailPage();
            renderConnectionsPage();
          } else renderAll();
        }
      });
      window.addEventListener('focus', async () => {
        try {
          gmailFlowSummary = await globalThis.workspaceDesktop.gmailFlowSummary();
          if (currentPage === 'gmailFlow') renderGmailPage();
        } catch (_) {}
      });
    }
  }

  void initialize();
})();
