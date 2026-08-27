(() => {
  const Core = globalThis.WorkspaceCore;
  const Ops = globalThis.OperationsCore;
  const launchParams = new URLSearchParams(location.search);
  const smokeDiagnostics = launchParams.get('smoke') === '1';
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
  let persistedStateBaseline = Core.createEmptyState();
  let currentPage = 'dashboard';
  let navigationGeneration = 0;
  let confirmResolver = null;
  let nameInputResolver = null;
  let saveTimer = null;
  let driveSyncTimer = null;
  let driveSyncDirty = false;
  let driveSyncPromise = null;
  let lastDriveSyncError = null;
  let extensionManifests = [];
  let mailEditorDirty = false;
  let mailEditorProjectId = null;
  let mailDraftTimer = null;
  let rosterFormulaPersistTimer = null;
  let rosterFormulaDraft = null;
  let arrangementPersistTimer = null;
  const arrangementDrafts = new Map();
  let rosterSelection = null;
  let rosterSelecting = false;
  let rosterHistory = [];
  let rosterFuture = [];
  let arrangementSelection = null;
  let arrangementSelecting = false;
  let arrangementHistory = [];
  let arrangementFuture = [];
  let scheduleSelection = null;
  let scheduleSelecting = false;
  let scheduleHistory = [];
  let scheduleFuture = [];
  let schedulePersistTimer = null;
  let schedulePersistBaseline = null;
  let schedulePersistProjectId = null;
  let schedulePersistMessage = '일정 셀 편집 저장됨';
  let scheduleAssignmentSequence = 0;
  let scheduleEditGeneration = 0;
  let persistSaving = 0;
  let persistSequence = 0;
  let persistReconcileTimer = null;
  let persistReconcileNeeded = false;
  let persistReconcileBlocked = false;
  let persistIdleResolvers = [];
  let persistDirty = false;
  let externalOperationCount = 0;
  let externalOperationIdleResolvers = [];
  const pendingScheduleMergeHints = new Map();
  let deferredWorkspaceState = null;
  let pendingMergedSurfaceRender = false;
  let selectedSessionPersonId = null;
  let selectedSessionAssignmentId = null;
  let pendingSessionChange = null;
  let sheetChoiceResolver = null;
  let templateInsertionTarget = 'body';
  let templateAutocompleteState = null;
  let activeWorkflowStepId = null;
  let workflowEditorDraft = [];
  let workflowEditorTemplateDraft = null;
  let gmailFlowSummary = { connected: false, email: '', rosters: 0, templates: 0, structures: 0 };
  const navigationTrace = [];
  if (smokeDiagnostics) globalThis.__workspaceNavigationTrace = navigationTrace;

  const storage = {
    async load() {
      if (globalThis.workspaceDesktop) return globalThis.workspaceDesktop.loadState();
      try { return JSON.parse(localStorage.getItem('cmoeWorkspaceState') || 'null'); }
      catch (_) { return null; }
    },
    async save(nextState, { scheduleProjects = [], baseState = null, externalCommit = null } = {}) {
      if (globalThis.workspaceDesktop) {
        nextState._baseRevision = Number(nextState._baseRevision ?? nextState._revision ?? 0);
        const payload = { ...nextState, _mergeHints: { baseState, scheduleProjects }, ...(externalCommit ? { _externalCommit: externalCommit } : {}) };
        return globalThis.workspaceDesktop.saveState(payload);
      }
      localStorage.setItem('cmoeWorkspaceState', JSON.stringify(nextState));
      return { ok: true, state: nextState };
    }
  };

  const cloneState = (value) => JSON.parse(JSON.stringify(value));

  function acceptPersistedBaseline(nextState) {
    const nextRevision = Number(nextState?._revision || 0);
    if (nextRevision >= Number(persistedStateBaseline?._revision || 0)) persistedStateBaseline = cloneState(nextState);
  }

  function mergePersistedWorkspaceState(nextState) {
    const returnedState = Core.normalizeState(nextState);
    const mergeBase = cloneState(persistedStateBaseline);
    const returnedIsNewer = Number(returnedState._revision || 0) > Number(mergeBase._revision || 0)
      || (Number(returnedState._revision || 0) === Number(mergeBase._revision || 0) && String(returnedState.updatedAt || '') >= String(mergeBase.updatedAt || ''));
    const authoritativeState = returnedIsNewer ? returnedState : mergeBase;
    const localState = cloneState(state);
    acceptPersistedBaseline(authoritativeState);
    state = Core.normalizeState(Core.threeWayMerge(mergeBase, authoritativeState, localState));
    if (JSON.stringify(state) !== JSON.stringify(authoritativeState)) persistDirty = true;
    return state;
  }

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

  function projectById(projectId) {
    return state.projects.find((item) => item.id === projectId) || Object.values(state.quickWorkspaces || {}).find((item) => item.id === projectId) || null;
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

  async function persist(message = '저장됨', { scheduleProjectId = null, externalCommit = null, reconciliation = false } = {}) {
    clearTimeout(persistReconcileTimer); persistReconcileTimer = null;
    persistReconcileNeeded = false;
    if (externalCommit) persistReconcileBlocked = true;
    persistDirty = true;
    const scheduleOnlyProjectIds = new Set([...pendingScheduleMergeHints.entries()].filter(([, impact]) => impact.scheduleOnly !== false).map(([projectId]) => projectId)); if (scheduleProjectId) scheduleOnlyProjectIds.add(scheduleProjectId);
    const autoCommitted = commitSchedulePersistState();
    const scheduleProjects = [...pendingScheduleMergeHints.entries()].map(([projectId, impact]) => ({ projectId, ...impact, scheduleOnly: scheduleOnlyProjectIds.has(projectId) }));
    pendingScheduleMergeHints.clear();
    [scheduleProjectId, autoCommitted?.projectId].filter(Boolean).forEach((projectId) => { if (!scheduleProjects.some((item) => item.projectId === projectId)) scheduleProjects.push({ projectId, changedSlotIds: [], zoomReviewSlotIds: [], affectedPersonIds: [], scheduleOnly: scheduleOnlyProjectIds.has(projectId) }); });
    const requestSequence = ++persistSequence;
    persistSaving += 1;
    let requestHadLocalAdvance = false;
    clearTimeout(saveTimer);
    $('#saveStatus').textContent = '저장 중…';
    try {
      const currentStamp = Number.isNaN(Date.parse(state.updatedAt)) ? 0 : Date.parse(state.updatedAt);
      const requestUpdatedAt = new Date(Math.max(Date.now(), currentStamp + 1)).toISOString(); state.updatedAt = requestUpdatedAt;
      const requestState = cloneState(state);
      const requestBaseState = cloneState(persistedStateBaseline);
      const result = await storage.save(requestState, { scheduleProjects, baseState: requestBaseState, externalCommit });
      let mergedRosterChanged = Boolean(result?.merged);
      let mergedArrangementChanged = Boolean(result?.merged);
      let mergedScheduleChanged = Boolean(result?.merged);
      if (result?.state) {
        const normalized = Core.normalizeState(result.state);
        if (result.merged) {
          const activeProjectChanged = normalized.activeProjectId !== requestState.activeProjectId;
          const requestedProject = requestState.projects.find((project) => project.id === requestState.activeProjectId) || Object.values(requestState.quickWorkspaces || {}).find((project) => project.id === requestState.activeProjectId);
          const mergedProject = normalized.projects.find((project) => project.id === requestState.activeProjectId) || Object.values(normalized.quickWorkspaces || {}).find((project) => project.id === requestState.activeProjectId);
          mergedRosterChanged = activeProjectChanged || !requestedProject || !mergedProject || rosterSnapshot(requestedProject) !== rosterSnapshot(mergedProject);
          mergedScheduleChanged = activeProjectChanged || !requestedProject || !mergedProject || scheduleSnapshot(requestedProject) !== scheduleSnapshot(mergedProject);
          const requestedItem = requestedProject?.data.workItems.find((item) => item.id === requestedProject.data.activeWorkItemId);
          const mergedItem = mergedProject?.data.workItems.find((item) => item.id === requestedProject?.data.activeWorkItemId);
          const arrangementContent = (item) => item ? JSON.stringify({ columns: item.columns, rows: item.rows }) : '';
          mergedArrangementChanged = activeProjectChanged || requestedProject?.data.activeWorkItemId !== mergedProject?.data.activeWorkItemId || (Boolean(requestedItem || mergedItem) && (!requestedItem || !mergedItem || arrangementContent(requestedItem) !== arrangementContent(mergedItem)));
        }
        const localAdvanced = requestSequence !== persistSequence || JSON.stringify(state) !== JSON.stringify(requestState); requestHadLocalAdvance = localAdvanced;
        acceptPersistedBaseline(normalized);
        state = localAdvanced ? Core.normalizeState(Core.threeWayMerge(requestState, normalized, state)) : normalized;
        if (result.merged && (mergedRosterChanged || mergedArrangementChanged || mergedScheduleChanged)) pendingMergedSurfaceRender = true;
      }
      if (result?.merged) {
        // The save response may contain another window's edits without going
        // through applyIncomingWorkspaceState(). Whole-sheet Undo snapshots
        // taken before that merge are no longer safe, but drafts typed while
        // this async save was in flight must remain queued.
        if (mergedRosterChanged) {
          clearRosterHistory({ preserveEditingState: true });
          const input = document.activeElement;
          const project = activeProject();
          if (project && input?.matches?.('[data-person-row], [data-column-name], #rosterCellValue')) input.dataset.beforeRosterEdit = rosterSnapshot(project);
        }
        if (mergedArrangementChanged) {
          clearArrangementHistory({ preserveEditingState: true });
          const input = document.activeElement; const item = activeWorkItem();
          if (item && input?.matches?.('[data-arrangement-input], #arrangementCellValue')) input.dataset.beforeArrangementEdit = arrangementSnapshot(item);
        }
        if (mergedScheduleChanged) {
          clearScheduleHistory();
          const input = document.activeElement; const project = activeProject();
          if (project && input?.matches?.('[data-schedule-input]')) {
            const snapshot = scheduleSnapshot(project);
            input.dataset.scheduleBefore = snapshot; input.dataset.scheduleImpactBefore = snapshot;
          }
        }
        rosterSelecting = false; arrangementSelecting = false; scheduleSelecting = false;
        $('#rosterEditorTable')?.classList.remove('range-selecting');
        $('#arrangementBoard')?.classList.remove('range-selecting');
        $('#scheduleBoard')?.classList.remove('range-selecting');
        showToast('다른 창의 변경사항과 안전하게 병합했습니다.');
      }
      if (requestSequence === persistSequence && !schedulePersistBaseline && !requestHadLocalAdvance) {
        persistDirty = false;
        persistReconcileNeeded = false;
      } else if (!externalCommit && !reconciliation) persistReconcileNeeded = true;
      if (state.preferences.storageMode === 'drive') {
        scheduleDriveStateSync();
      }
      $('#saveStatus').textContent = message;
      saveTimer = setTimeout(() => { $('#saveStatus').textContent = '저장됨'; }, 1600);
      return result;
    } catch (error) {
      persistReconcileBlocked = true;
      scheduleProjects.forEach(({ projectId, scheduleOnly, ...impact }) => recordScheduleMergeImpact(projectId, impact, { scheduleOnly }));
      $('#saveStatus').textContent = '저장 실패';
      showToast(error.message || '저장하지 못했습니다.', 'error');
      throw error;
    } finally {
      persistSaving = Math.max(0, persistSaving - 1);
      if (!persistSaving) {
        const resolvers = persistIdleResolvers; persistIdleResolvers = [];
        resolvers.forEach((resolve) => resolve());
        const reconciliationBlocked = persistReconcileBlocked;
        persistReconcileBlocked = false;
        if (reconciliationBlocked) persistReconcileNeeded = false;
        else if (persistReconcileNeeded) schedulePersistReconciliation();
        if (!schedulePersistBaseline) applyDeferredWorkspaceState();
      }
    }
  }

  function waitForPersistIdle() {
    if (!persistSaving) return Promise.resolve();
    return new Promise((resolve) => persistIdleResolvers.push(resolve));
  }

  function schedulePersistReconciliation() {
    if (persistReconcileTimer || persistSaving || !persistDirty || !persistReconcileNeeded || schedulePersistBaseline || rosterFormulaDraft || arrangementDrafts.size || externalOperationCount) return;
    persistReconcileTimer = setTimeout(() => {
      persistReconcileTimer = null;
      if (persistSaving || !persistDirty || !persistReconcileNeeded || schedulePersistBaseline || rosterFormulaDraft || arrangementDrafts.size || externalOperationCount) return;
      persistReconcileNeeded = false;
      void persist('겹친 변경사항 저장됨', { reconciliation: true }).catch(() => {});
    }, 0);
  }

  function beginExternalOperation() { externalOperationCount += 1; }
  function endExternalOperation() {
    externalOperationCount = Math.max(0, externalOperationCount - 1);
    if (!externalOperationCount) { const resolvers = externalOperationIdleResolvers; externalOperationIdleResolvers = []; resolvers.forEach((resolve) => resolve()); applyDeferredWorkspaceState(); }
  }
  function waitForExternalOperations() {
    if (!externalOperationCount) return Promise.resolve();
    return new Promise((resolve) => externalOperationIdleResolvers.push(resolve));
  }

  async function reserveExternalArtifacts(projectId, kind, keys) {
    const reservationKeys = [...new Set((keys || []).map((key) => String(key || '').trim()).filter(Boolean))];
    if (!globalThis.workspaceDesktop?.reserveExternalArtifacts) return { ok: true, token: null, keys: reservationKeys };
    const reservation = await globalThis.workspaceDesktop.reserveExternalArtifacts(projectId, kind, reservationKeys);
    return { ...reservation, keys: reservationKeys };
  }

  async function releaseExternalArtifacts(token) {
    if (token && globalThis.workspaceDesktop?.releaseExternalArtifacts) {
      try { await globalThis.workspaceDesktop.releaseExternalArtifacts(token); } catch (_) {}
    }
  }

  function connectedDrive() {
    return Core.workspaceDriveConnection(state);
  }

  function scheduleDriveStateSync() {
    driveSyncDirty = true;
    clearTimeout(driveSyncTimer);
    driveSyncTimer = setTimeout(() => {
      driveSyncTimer = null;
      void flushDriveStateSync(false);
    }, 1500);
  }

  async function flushDriveStateSync(notify = false, { force = false } = {}) {
    clearTimeout(driveSyncTimer);
    driveSyncTimer = null;
    if (state.preferences.storageMode !== 'drive') { driveSyncDirty = false; return true; }
    if (force) driveSyncDirty = true;
    if (driveSyncPromise) return driveSyncPromise;
    driveSyncPromise = (async () => {
      while (driveSyncDirty) {
        driveSyncDirty = false;
        if (!await pushStateToDrive(notify)) { driveSyncDirty = true; return false; }
        notify = false;
      }
      return true;
    })();
    try { return await driveSyncPromise; }
    finally { driveSyncPromise = null; }
  }

  async function pushStateToDrive(notify = true) {
    const connection = connectedDrive();
    if (!connection) {
      const connectedCount = state.connections.filter((item) => item.type === 'drive' && item.status === 'connected').length; const selectedUnavailable = Boolean(state.preferences.workspaceDriveConnectionId);
      lastDriveSyncError = new Error(selectedUnavailable ? '선택한 Workspace Drive 계정에 다시 로그인하거나 다른 계정을 선택해주세요.' : connectedCount > 1 ? 'Workspace 전체를 동기화할 Drive 계정을 선택해주세요.' : 'Google Drive 저장 모드이지만 연결된 Drive 계정이 없습니다.');
      if (notify) showToast(selectedUnavailable ? '선택한 Workspace Drive 계정에 다시 로그인하거나 다른 계정을 선택해주세요.' : connectedCount > 1 ? '환경 설정에서 Workspace 전체 동기화 계정을 선택해주세요.' : '먼저 Google Drive 계정에 로그인하여 연결해주세요.', 'error');
      return false;
    }
    try {
      const result = await globalThis.workspaceDesktop.pushDriveState(connection.id, state, Core.connectionIdentity(connection));
      lastDriveSyncError = null;
      state.preferences.lastDriveSyncAt = result.modifiedTime || new Date().toISOString();
      if ($('#driveSyncStatus')) $('#driveSyncStatus').textContent = `마지막 Drive 저장: ${formatUpdatedAt(state.preferences.lastDriveSyncAt)}`;
      if (notify) showToast('현재 Workspace 데이터를 Drive에 저장했습니다.', 'success');
      return true;
    } catch (error) { lastDriveSyncError = error; if (notify) showToast(`Drive 저장 실패: ${error.message}`, 'error'); return false; }
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

  function approveExternalChange(project, message, options = {}) {
    return Ops.externalChangeApprovalRequired(project) ? showConfirm(message, options) : Promise.resolve(true);
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
    if (currentPage === 'gmailFlow' && page !== 'gmailFlow' && mailEditorDirty) void saveMailEditorDraft(mailEditorProjectId);
    if (smokeDiagnostics) { navigationTrace.push({ from: currentPage, to: page, stack: new Error().stack?.split('\n').slice(1, 5) }); if (navigationTrace.length > 30) navigationTrace.shift(); }
    navigationGeneration += 1;
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

  function captureMailEditorDraft(projectId = mailEditorProjectId) {
    const project = projectById(projectId) || activeProject(); if (!project || !mailEditorDirty) return null;
    const previousSubject = project.data.communication.subjectTemplate;
    const previousHtml = project.data.communication.bodyHtmlTemplate;
    project.data.communication.subjectTemplate = $('#mailSubjectTemplate').value;
    project.data.communication.bodyHtmlTemplate = sanitizeRichHtml($('#mailBodyEditor').innerHTML);
    project.data.communication.bodyTemplate = $('#mailBodyEditor').innerText;
    const templateChanged = previousSubject !== project.data.communication.subjectTemplate || previousHtml !== project.data.communication.bodyHtmlTemplate;
    if (templateChanged) {
      let affected = false;
      project.data.externalArtifacts.forEach((artifact) => { if (artifact.kind === 'gmailDraft' && artifact.status !== 'superseded') { artifact.status = 'stale'; affected = true; } });
      state = Core.updateProject(state, project.id, { data: project.data });
      if (affected && project.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', '공통 메일 내용 변경 후 Gmail 확인 필요');
    }
    const savedProject = projectById(project.id) || project;
    savedProject.updatedAt = new Date().toISOString(); mailEditorDirty = false;
    mailEditorProjectId = savedProject.id;
    return savedProject;
  }

  async function saveMailEditorDraft(projectId = mailEditorProjectId) {
    const project = captureMailEditorDraft(projectId); if (!project) return;
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
    renderItems($('#libraryRosterList'), state.library.rosters, 'roster', '저장한 명단이 없습니다. 명단 화면에서 현재 명단을 이름 붙여 저장할 수 있습니다.');
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

  function spreadsheetPointerTarget(event, table) {
    const hasViewportPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0);
    if (!hasViewportPoint || typeof document.elementFromPoint !== 'function') return event.target;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    return hit && table?.contains(hit) ? hit : null;
  }

  function beginSpreadsheetRangeDrag(table) {
    if (table.classList.contains('range-selecting')) return;
    table.classList.add('range-selecting');
    const input = document.activeElement;
    if (input?.matches?.('input') && typeof input.selectionStart === 'number') input.setSelectionRange(input.selectionStart, input.selectionStart);
    globalThis.getSelection?.()?.removeAllRanges();
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
    return id;
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
    const definition = project.data.columns[column]; if (!definition) return false;
    if (row === 0) definition.name = String(value).trim() || definition.name;
    else {
      const existing = project.data.people[row - 1];
      if (existing?.active === false) return false;
      if (existing || String(value ?? '').length) {
        const person = existing || ensureRosterPerson(project, row);
        person.values[definition.id] = String(value ?? '');
      }
    }
    syncPersonDerivedFields(project);
    return true;
  }

  function rosterFormulaPoint(project, draft = rosterFormulaDraft) {
    if (!project || !draft) return null;
    const column = project.data.columns.find((item) => item.id === draft.columnId);
    if (!column) return null;
    const columnIndex = project.data.columns.indexOf(column);
    if (draft.row === 0) return { row: 0, col: columnIndex };
    if (draft.personId) {
      const personIndex = project.data.people.findIndex((person) => person.id === draft.personId);
      if (personIndex >= 0) return { row: personIndex + 1, col: columnIndex };
    }
    return { row: draft.row, col: columnIndex };
  }

  function queueRosterFormulaPersist(project, point, value) {
    const person = point.row > 0 ? project.data.people[point.row - 1] : null;
    rosterFormulaDraft = {
      projectId: project.id,
      row: point.row,
      columnId: project.data.columns[point.col]?.id || '',
      personId: person?.id || null,
      value: String(value ?? '')
    };
    persistDirty = true;
    clearTimeout(rosterFormulaPersistTimer);
    rosterFormulaPersistTimer = setTimeout(() => void flushRosterFormulaPersist().catch(() => {}), 450);
  }

  async function flushRosterFormulaPersist({ render = false } = {}) {
    clearTimeout(rosterFormulaPersistTimer); rosterFormulaPersistTimer = null;
    const draft = rosterFormulaDraft; rosterFormulaDraft = null;
    if (!draft) return false;
    const project = projectById(draft.projectId); const point = rosterFormulaPoint(project, draft);
    if (!project || !point || !setSheetCellValue(project, point.row, point.col, draft.value)) return false;
    markRosterDependenciesStale(project);
    await persist('셀 편집 저장됨');
    if (render && currentPage === 'people' && activeProject()?.id === project.id) renderPeoplePage();
    return true;
  }

  function rosterSnapshot(project) {
    return JSON.stringify({
      columns: project.data.columns,
      people: project.data.people,
      availability: project.data.availability,
      assignments: project.data.assignments,
      rosterViewMemberships: (project.data.rosterViews || []).map((view) => ({ id: view.id, personIds: view.personIds || [], excludedPersonIds: view.excludedPersonIds || [] })),
      roleCandidateFilters: project.data.roles.map((role) => ({ id: role.id, candidateFilter: role.candidateFilter }))
    });
  }

  function restoreRosterSnapshot(project, snapshot) {
    const value = JSON.parse(snapshot);
    const nextColumns = Array.isArray(value.columns) ? value.columns : [];
    const snapshotPeople = Array.isArray(value.people) ? value.people : [];
    const currentPersonIds = new Set(project.data.people.map((person) => person.id));
    const currentPeople = new Map(project.data.people.map((person) => [person.id, person]));
    const nextPeople = snapshotPeople.map((person) => {
      const current = currentPeople.get(person.id); if (!current) return person;
      return { ...person, active: current.active, roleIds: JSON.parse(JSON.stringify(current.roleIds || [])) };
    });
    const nextPersonIds = new Set(nextPeople.map((person) => person.id));
    const restoredPersonIds = new Set([...nextPersonIds].filter((id) => !currentPersonIds.has(id)));
    const removedPersonIds = new Set([...currentPersonIds].filter((id) => !nextPersonIds.has(id)));
    const currentColumnIds = project.data.columns.map((column) => column.id);
    const nextColumnIds = nextColumns.map((column) => column.id);
    const restoredColumnIds = new Set(nextColumnIds.filter((id) => !currentColumnIds.includes(id)));
    project.data.columns = nextColumns;
    project.data.people = nextPeople;
    project.data.availability ||= {};
    removedPersonIds.forEach((id) => { delete project.data.availability[id]; });
    const snapshotAvailability = value.availability && typeof value.availability === 'object' ? value.availability : {};
    const validSlotIds = new Set(project.data.slots.map((slot) => slot.id));
    restoredPersonIds.forEach((id) => { project.data.availability[id] = (snapshotAvailability[id] || []).filter((slotId) => validSlotIds.has(slotId)); });
    const validRoleIds = new Set(project.data.roles.map((role) => role.id));
    project.data.assignments = (Array.isArray(project.data.assignments) ? project.data.assignments : [])
      .filter((assignment) => !removedPersonIds.has(assignment.personId) && !restoredPersonIds.has(assignment.personId));
    project.data.assignments.push(...JSON.parse(JSON.stringify((Array.isArray(value.assignments) ? value.assignments : []).filter((assignment) => restoredPersonIds.has(assignment.personId) && validSlotIds.has(assignment.slotId) && (!assignment.roleId || validRoleIds.has(assignment.roleId))))));
    const snapshotViews = new Map((value.rosterViewMemberships || []).map((view) => [view.id, view]));
    project.data.rosterViews.forEach((view) => {
      const snapshotView = snapshotViews.get(view.id);
      view.personIds = (view.personIds || []).filter((id) => !removedPersonIds.has(id));
      view.excludedPersonIds = (view.excludedPersonIds || []).filter((id) => !removedPersonIds.has(id));
      if (snapshotView) {
        restoredPersonIds.forEach((id) => {
          if (snapshotView.personIds?.includes(id) && !view.personIds.includes(id)) view.personIds.push(id);
          if (snapshotView.excludedPersonIds?.includes(id) && !view.excludedPersonIds.includes(id)) view.excludedPersonIds.push(id);
        });
      }
    });
    pruneRosterViewMembershipsForSheetStructure(project);
    const validColumnIds = new Set(nextColumnIds);
    const snapshotFilters = new Map((value.roleCandidateFilters || []).map((item) => [item.id, item.candidateFilter]));
    project.data.roles.forEach((role) => {
      const match = String(role.candidateFilter || '').match(/^column:([^:]+):/);
      if (match && !validColumnIds.has(match[1])) role.candidateFilter = 'all';
      const snapshotFilter = snapshotFilters.get(role.id); const snapshotMatch = String(snapshotFilter || '').match(/^column:([^:]+):/);
      if (role.candidateFilter === 'all' && snapshotMatch && restoredColumnIds.has(snapshotMatch[1])) role.candidateFilter = snapshotFilter;
    });
    syncPersonDerivedFields(project);
    refreshScheduleConflicts(project);
    return {
      peopleChanged: [...currentPersonIds].some((id) => !nextPersonIds.has(id)) || [...nextPersonIds].some((id) => !currentPersonIds.has(id)),
      columnsChanged: JSON.stringify(currentColumnIds) !== JSON.stringify(nextColumnIds)
    };
  }

  function syncRosterHistoryControls() {
    if ($('#rosterUndo')) $('#rosterUndo').disabled = !rosterHistory.length;
    if ($('#rosterRedo')) $('#rosterRedo').disabled = !rosterFuture.length;
  }

  function pushRosterHistorySnapshot(snapshot) {
    if (!snapshot || rosterHistory.at(-1) === snapshot) return;
    rosterHistory.push(snapshot); if (rosterHistory.length > 80) rosterHistory.shift(); rosterFuture = []; syncRosterHistoryControls();
  }

  function pushRosterHistory(project) { if (project) pushRosterHistorySnapshot(rosterSnapshot(project)); }

  function clearRosterHistory({ preserveEditingState = false } = {}) {
    rosterHistory = []; rosterFuture = [];
    if (!preserveEditingState) {
      rosterSelection = null;
      clearTimeout(rosterFormulaPersistTimer); rosterFormulaPersistTimer = null; rosterFormulaDraft = null;
    }
    syncRosterHistoryControls();
  }

  async function moveRosterHistory(project, undo = true) {
    const from = undo ? rosterHistory : rosterFuture; const to = undo ? rosterFuture : rosterHistory;
    if (!project || !from.length) return;
    clearTimeout(rosterFormulaPersistTimer); rosterFormulaPersistTimer = null; rosterFormulaDraft = null;
    const beforeScheduleSnapshot = scheduleSnapshot(project);
    to.push(rosterSnapshot(project)); const restored = restoreRosterSnapshot(project, from.pop()); rosterSelection = null;
    if (restored.peopleChanged || restored.columnsChanged) clearScheduleHistory();
    if (restored.peopleChanged) {
      const impact = applyScheduleMutationImpact(project, beforeScheduleSnapshot);
      syncScheduleProjectState(project, undo ? '명단 행 편집 실행 취소 후 일정 재검토 필요' : '명단 행 편집 다시 실행 후 일정 재검토 필요', impact);
      recordScheduleMergeImpact(project.id, impact, { scheduleOnly: false });
    }
    if (!restored.peopleChanged || restored.columnsChanged) markRosterDependenciesStale(project, undo ? '명단 편집 실행 취소 후 일정 재검토 필요' : '명단 편집 다시 실행 후 일정 재검토 필요');
    syncRosterHistoryControls(); await persist(undo ? '명단 편집 실행 취소됨' : '명단 편집 다시 실행됨'); renderPeoplePage();
  }

  function rosterSelectionBounds() {
    if (!rosterSelection) return null;
    return {
      minRow: Math.min(rosterSelection.anchor.row, rosterSelection.focus.row),
      maxRow: Math.max(rosterSelection.anchor.row, rosterSelection.focus.row),
      minCol: Math.min(rosterSelection.anchor.col, rosterSelection.focus.col),
      maxCol: Math.max(rosterSelection.anchor.col, rosterSelection.focus.col)
    };
  }

  function rosterSelectionIsRange() {
    const bounds = rosterSelectionBounds();
    return Boolean(bounds && (rosterSelection.mode !== 'cells' || bounds.minRow !== bounds.maxRow || bounds.minCol !== bounds.maxCol));
  }

  function updateRosterSelection(anchor, focus = anchor, mode = rosterSelection?.mode || 'cells') {
    rosterSelection = { anchor, focus, mode };
    const minRow = Math.min(anchor.row, focus.row); const maxRow = Math.max(anchor.row, focus.row);
    const minCol = Math.min(anchor.col, focus.col); const maxCol = Math.max(anchor.col, focus.col);
    $$('[data-sheet-row][data-sheet-col]', $('#rosterEditorTable')).forEach((cell) => {
      const row = Number(cell.dataset.sheetRow); const col = Number(cell.dataset.sheetCol);
      cell.classList.toggle('sheet-selected', row >= minRow && row <= maxRow && col >= minCol && col <= maxCol);
      cell.classList.toggle('sheet-anchor', row === anchor.row && col === anchor.col);
    });
    $$('[data-select-roster-row]', $('#rosterEditorTable')).forEach((cell) => { const row = Number(cell.dataset.selectRosterRow); cell.classList.toggle('sheet-selector-selected', mode === 'row' && row >= minRow && row <= maxRow); });
    $$('[data-select-roster-column]', $('#rosterEditorTable')).forEach((cell) => { const col = Number(cell.dataset.selectRosterColumn); cell.classList.toggle('sheet-selector-selected', mode === 'column' && col >= minCol && col <= maxCol); });
    $('#rosterEditorTable [data-select-roster-all]')?.classList.toggle('sheet-selector-selected', mode === 'all');
    const from = `${spreadsheetColumnName(minCol)}${minRow + 1}`; const to = `${spreadsheetColumnName(maxCol)}${maxRow + 1}`;
    $('#rosterSelectionStatus').textContent = from === to ? from : `${from}:${to}`;
    $('#rosterCellAddress').textContent = `${spreadsheetColumnName(focus.col)}${focus.row + 1}`;
    const project = activeProject(); const formula = $('#rosterCellValue'); const column = project?.data.columns?.[focus.col]; const locked = Boolean(project && focus.row > 0 && project.data.people[focus.row - 1]?.active === false);
    formula.disabled = !project || !column || locked; formula.value = project && column ? sheetCellValue(project, focus.row, focus.col) : '';
    formula.placeholder = !column ? '먼저 컬럼을 추가하세요' : (locked ? '제외 행은 공용 명단 관리자에서 다시 포함한 뒤 수정하세요' : '셀을 선택하세요');
    formula.title = locked ? '제외된 행은 인라인 표에서 수정할 수 없습니다.' : '';
  }

  function selectedRosterMatrix(project) {
    if (!rosterSelection) return [];
    const minRow = Math.min(rosterSelection.anchor.row, rosterSelection.focus.row); const maxRow = Math.max(rosterSelection.anchor.row, rosterSelection.focus.row);
    const minCol = Math.min(rosterSelection.anchor.col, rosterSelection.focus.col); const maxCol = Math.max(rosterSelection.anchor.col, rosterSelection.focus.col);
    return Array.from({ length: maxRow - minRow + 1 }, (_, offset) => Array.from({ length: maxCol - minCol + 1 }, (_unused, columnOffset) => sheetCellValue(project, minRow + offset, minCol + columnOffset)));
  }

  function focusRosterCell(row, col, extend = false) {
    const project = activeProject(); if (!project?.data.columns.length) return;
    const visibleRows = Math.max(project.data.people.length + 2, 5);
    const point = { row: Math.max(0, Math.min(visibleRows, row)), col: Math.max(0, Math.min(project.data.columns.length - 1, col)) };
    updateRosterSelection(extend && rosterSelection ? rosterSelection.anchor : point, point);
    const cell = $(`[data-sheet-row="${point.row}"][data-sheet-col="${point.col}"]`, $('#rosterEditorTable'));
    const input = cell?.querySelector('input');
    if (input && !input.readOnly) { input.focus({ preventScroll: true }); if (point.row > 0) input.select(); }
    else if (cell) { cell.tabIndex = -1; cell.focus({ preventScroll: true }); }
  }

  function shouldUseNativeRosterClipboard(event) {
    if (event.target.closest?.('[contenteditable="true"]')) return true;
    const input = event.target.closest?.('input, textarea'); if (!input) return false;
    if (!input.matches('#rosterCellValue, #rosterEditorTable input')) return true;
    if (rosterSelectionIsRange()) return false;
    return typeof input.selectionStart === 'number' && input.selectionStart !== input.selectionEnd;
  }

  async function finishRosterSheetMutation(project, message, { locked = 0 } = {}) {
    syncPersonDerivedFields(project); markRosterDependenciesStale(project); await persist(message); renderPeoplePage();
    if (locked) showToast(`잠긴 행의 ${locked}개 셀은 그대로 유지했습니다.`);
  }

  async function clearSelectedRosterCells(project, { recordHistory = true, message = '선택 명단 셀 지움' } = {}) {
    const bounds = rosterSelectionBounds(); if (!project || !bounds) return false;
    if (recordHistory) pushRosterHistory(project);
    let changed = 0; let locked = 0;
    for (let row = Math.max(1, bounds.minRow); row <= bounds.maxRow; row += 1) {
      const person = project.data.people[row - 1];
      if (person?.active === false) { locked += bounds.maxCol - bounds.minCol + 1; continue; }
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) if (setSheetCellValue(project, row, col, '')) changed += 1;
    }
    if (!changed) { if (recordHistory) rosterHistory.pop(); syncRosterHistoryControls(); if (locked) showToast('제외된 행은 공용 명단 관리자에서 다시 포함한 뒤 수정해주세요.'); return false; }
    await finishRosterSheetMutation(project, message, { locked }); return true;
  }

  function removeRosterPeopleWithDependencies(project, personIds, beforeScheduleSnapshot) {
    const ids = personIds instanceof Set ? personIds : new Set(personIds);
    project.data.people = project.data.people.filter((person) => !ids.has(person.id));
    project.data.assignments = project.data.assignments.filter((assignment) => !ids.has(assignment.personId));
    ids.forEach((id) => { delete project.data.availability[id]; });
    syncPersonDerivedFields(project);
    pruneRosterViewMembershipsForSheetStructure(project);
    refreshScheduleConflicts(project);
    const impact = applyScheduleMutationImpact(project, beforeScheduleSnapshot);
    project.data.externalArtifacts.forEach((artifact) => {
      if (artifact.kind === 'gmailDraft' && ids.has(artifact.personId)) { artifact.status = 'superseded'; artifact.replacedAt = new Date().toISOString(); }
    });
    syncScheduleProjectState(project, `명단 삭제 후 일정 확인 · 문제 ${project.data.conflicts.length}건`, impact);
    recordScheduleMergeImpact(project.id, impact, { scheduleOnly: false });
  }

  async function applyRosterSheetAction(action, columnName = '새 컬럼') {
    const project = activeProject(); const bounds = rosterSelectionBounds(); if (!project || (!bounds && action !== 'insert-row')) return;
    if (action === 'clear') { await clearSelectedRosterCells(project); return; }
    pushRosterHistory(project); let locked = 0;
    if (action === 'fill-down') {
      const sourceRow = Math.max(1, bounds.minRow);
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) {
        const value = sheetCellValue(project, sourceRow, col);
        for (let row = sourceRow + 1; row <= bounds.maxRow; row += 1) {
          if (project.data.people[row - 1]?.active === false) { locked += 1; continue; }
          setSheetCellValue(project, row, col, value);
        }
      }
    } else if (action === 'insert-row') {
      const index = Math.max(0, (bounds?.minRow || 1) - 1); project.data.people.splice(index, 0, createBlankRosterPerson(project, index));
      rosterSelection = { anchor: { row: index + 1, col: Math.max(0, bounds?.minCol || 0) }, focus: { row: index + 1, col: Math.max(0, bounds?.minCol || 0) }, mode: 'cells' };
    } else if (action === 'delete-rows') {
      const minIndex = Math.max(0, bounds.minRow - 1); const maxIndex = Math.min(project.data.people.length - 1, bounds.maxRow - 1);
      const targets = project.data.people.slice(minIndex, maxIndex + 1).filter((person) => person.active !== false); const ids = new Set(targets.map((person) => person.id));
      const lockedAssignment = project.data.assignments.some((assignment) => ids.has(assignment.personId) && (assignment.locked || scheduleRowLocked(project, assignment.slotId)));
      if (lockedAssignment) { rosterHistory.pop(); syncRosterHistoryControls(); showToast('잠긴 일정에 배정된 사람이 포함되어 있습니다. 일정 잠금을 해제한 뒤 행을 삭제해주세요.', 'error'); return; }
      if (!ids.size) { rosterHistory.pop(); syncRosterHistoryControls(); return; }
      const beforeScheduleSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); clearScheduleHistory();
      removeRosterPeopleWithDependencies(project, ids, beforeScheduleSnapshot); rosterSelection = null;
      await persist('명단 행 삭제됨'); renderPeoplePage(); return;
    } else if (action === 'insert-column') {
      const index = Math.max(0, bounds.minCol); const id = `column-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      project.data.columns.splice(index, 0, { id, name: String(columnName || '새 컬럼').trim() || '새 컬럼', type: 'text' }); project.data.people.forEach((person) => { person.values[id] = ''; });
      rosterSelection = { anchor: { row: 0, col: index }, focus: { row: 0, col: index }, mode: 'cells' };
    } else if (action === 'delete-columns') {
      const removed = project.data.columns.slice(bounds.minCol, bounds.maxCol + 1); const ids = new Set(removed.map((column) => column.id));
      project.data.columns = project.data.columns.filter((column) => !ids.has(column.id)); project.data.people.forEach((person) => ids.forEach((id) => delete person.values[id]));
      project.data.roles.forEach((role) => { if ([...ids].some((id) => String(role.candidateFilter || '').startsWith(`column:${id}:`))) role.candidateFilter = 'all'; }); rosterSelection = null;
    }
    if (['insert-row', 'delete-rows', 'insert-column', 'delete-columns'].includes(action)) clearScheduleHistory();
    await finishRosterSheetMutation(project, ({ 'fill-down': '명단 아래로 채우기', 'insert-row': '명단 행 삽입', 'delete-rows': '명단 행 삭제', 'insert-column': '명단 컬럼 삽입', 'delete-columns': '명단 컬럼 삭제' })[action] || '명단 시트 편집', { locked });
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

    const rosterSelect = $('#sharedRosterSelect'); rosterSelect.replaceChildren(element('option', '', '저장한 명단 선택'));
    state.library.rosters.forEach((roster) => { const option = element('option', '', `${roster.name} · ${roster.people?.length || 0}명`); option.value = roster.id; rosterSelect.append(option); });
    const table = $('#rosterEditorTable');
    if (!project.data.columns.length) {
      const letterRow = element('tr', 'sheet-letter-row'); const corner = element('th', 'sheet-corner', ''); letterRow.append(corner, element('th', 'sheet-letter', 'A'));
      const headRow = element('tr'); headRow.append(element('th', 'sheet-row-number', '1'));
      const first = element('th', 'empty-sheet-header');
      const add = element('button', 'add-empty-column', '＋ 첫 번째 열 만들기'); add.type = 'button'; add.dataset.emptySheetAddColumn = 'true'; first.append(add); headRow.append(first);
      table.tHead.replaceChildren(letterRow, headRow);
      const rows = Array.from({ length: 5 }, (_, index) => {
        const tr = element('tr'); tr.append(element('th', 'sheet-row-number', String(index + 2)));
        const cell = element('td', 'empty-sheet-cell');
        if (index === 0) { cell.tabIndex = 0; cell.dataset.emptyRosterPasteAnchor = 'true'; cell.setAttribute('role', 'note'); cell.setAttribute('aria-label', '컬럼을 먼저 추가하세요. 표는 이 영역을 선택한 뒤 Ctrl+V로 붙여넣을 수 있습니다.'); cell.textContent = '컬럼을 먼저 추가하세요 · 표 붙여넣기는 Ctrl+V'; }
        tr.append(cell); return tr;
      });
      table.tBodies[0].replaceChildren(...rows); rosterSelection = null;
      $('#rosterSelectionStatus').textContent = '선택 없음'; $('#rosterCellAddress').textContent = '—'; $('#rosterCellValue').value = ''; $('#rosterCellValue').disabled = true; $('#rosterCellValue').placeholder = '먼저 컬럼을 추가하세요';
      syncRosterHistoryControls(); return;
    }
    const letterRow = element('tr', 'sheet-letter-row'); const corner = element('th', 'sheet-corner', ''); corner.dataset.selectRosterAll = 'true'; corner.title = '전체 표 선택'; letterRow.append(corner);
    project.data.columns.forEach((_column, index) => { const letter = element('th', 'sheet-letter', spreadsheetColumnName(index)); letter.dataset.selectRosterColumn = String(index); letter.title = `${spreadsheetColumnName(index)}열 전체 선택`; letterRow.append(letter); });
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
      const inactive = person?.active === false;
      const tr = element('tr', inactive ? 'roster-inactive-row' : '');
      if (inactive) { tr.dataset.rosterInactive = person.id; tr.title = '공용 명단 관리자에서 제외된 행입니다. 다시 포함한 뒤 수정할 수 있습니다.'; tr.setAttribute('aria-label', `${person.name || `${rowIndex + 2}행`} · 제외됨 · 읽기 전용`); }
      const rowNumber = element('th', 'sheet-row-number', String(rowIndex + 2)); rowNumber.dataset.selectRosterRow = String(rowIndex + 1); rowNumber.title = `${rowIndex + 2}행 전체 선택`; tr.append(rowNumber);
      project.data.columns.forEach((column, columnIndex) => {
        const td = element('td');
        td.dataset.sheetRow = String(rowIndex + 1); td.dataset.sheetCol = String(columnIndex);
        const input = element('input');
        input.type = column.type === 'email' ? 'email' : 'text';
        input.value = person?.values?.[column.id] || '';
        input.readOnly = inactive; input.setAttribute('aria-readonly', String(inactive));
        if (inactive) input.setAttribute('aria-describedby', 'rosterEditorAccessibilityHelp');
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
    if (rosterSelection) updateRosterSelection(rosterSelection.anchor, rosterSelection.focus, rosterSelection.mode);
    else { $('#rosterSelectionStatus').textContent = '선택 없음'; $('#rosterCellAddress').textContent = '—'; $('#rosterCellValue').value = ''; $('#rosterCellValue').disabled = true; }
    syncRosterHistoryControls();
  }

  function activeRosterView(project = activeProject()) {
    return project?.data.rosterViews?.find((view) => view.id === project.data.activeRosterViewId) || null;
  }

  function rosterViewMutationSignature(project) {
    return JSON.stringify({
      activeRosterViewId: project?.data.activeRosterViewId || null,
      scheduleRosterViewId: project?.data.scheduleRules?.rosterViewId || null,
      people: (project?.data.people || []).map((person) => [person.id, person.active]),
      rosterViews: project?.data.rosterViews || []
    });
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
    const projectId = project.id; const currentViewId = current?.id || null; const before = rosterViewMutationSignature(project);
    const defaultName = saveIncludedOnly && current ? `${current.name} 다음 단계` : '새 단계 명단';
    const name = await requestName(saveIncludedOnly ? '현재 포함 인원으로 새 단계 명단' : '원본에서 새 단계 명단', defaultName); if (!name) return;
    const currentProject = projectById(projectId); if (activeProject()?.id !== projectId || !currentProject || rosterViewMutationSignature(currentProject) !== before || (activeRosterView(currentProject)?.id || null) !== currentViewId) { showToast('명단 또는 단계 명단이 바뀌었습니다. 다시 저장해주세요.'); renderPeoplePage(); return; }
    const now = new Date().toISOString(); const view = { id: `roster-view-${Date.now().toString(36)}`, name, parentId: current?.id || null, personIds: [...sourceIds], excludedPersonIds: [], createdAt: now, updatedAt: now };
    currentProject.data.rosterViews.push(view); currentProject.data.activeRosterViewId = view.id;
    state = Core.updateProject(state, currentProject.id, { data: currentProject.data }); await persist('단계 명단 저장됨'); renderPeoplePage(); showToast(`“${name}” 명단을 ${sourceIds.length}명으로 만들었습니다.`, 'success');
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

  function queueArrangementPersist(project, item, row, column, value) {
    const definition = item.columns[column]; if (!project || !definition) return;
    const rowId = row >= 0 ? item.rows[row]?.id || null : null;
    const key = [project.id, item.id, rowId || `row:${row}`, definition.id].join('|');
    arrangementDrafts.set(key, { projectId: project.id, itemId: item.id, row, rowId, columnId: definition.id, value: String(value ?? '') });
    persistDirty = true;
    clearTimeout(arrangementPersistTimer);
    arrangementPersistTimer = setTimeout(() => void flushArrangementPersist().catch(() => {}), 450);
  }

  async function flushArrangementPersist({ render = false } = {}) {
    clearTimeout(arrangementPersistTimer); arrangementPersistTimer = null;
    if (!arrangementDrafts.size) return false;
    const drafts = [...arrangementDrafts.values()]; arrangementDrafts.clear();
    const changedProjects = new Set();
    drafts.forEach((draft) => {
      const project = projectById(draft.projectId); const item = project?.data.workItems.find((candidate) => candidate.id === draft.itemId); if (!project || !item) return;
      const columnIndex = item.columns.findIndex((column) => column.id === draft.columnId); if (columnIndex < 0) return;
      let rowIndex = draft.row;
      if (draft.rowId) { const resolved = item.rows.findIndex((row) => row.id === draft.rowId); if (resolved >= 0) rowIndex = resolved; }
      setArrangementCellValue(item, rowIndex, columnIndex, draft.value); changedProjects.add(project.id);
    });
    if (!changedProjects.size) return false;
    changedProjects.forEach((projectId) => { const project = projectById(projectId); if (project) state = Core.updateProject(state, projectId, { data: project.data }); });
    await persist('명단 작업표 편집됨');
    if (render && currentPage === 'arrange') renderArrangementPage();
    return true;
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

  function arrangementSnapshot(item) {
    return JSON.stringify({ columns: item.columns, rows: item.rows, updatedAt: item.updatedAt });
  }

  function restoreArrangementSnapshot(item, snapshot) {
    const value = JSON.parse(snapshot); item.columns = Array.isArray(value.columns) ? value.columns : []; item.rows = Array.isArray(value.rows) ? value.rows : []; item.updatedAt = value.updatedAt || new Date().toISOString();
  }

  function syncArrangementHistoryControls() {
    if ($('#arrangementUndo')) $('#arrangementUndo').disabled = !arrangementHistory.length;
    if ($('#arrangementRedo')) $('#arrangementRedo').disabled = !arrangementFuture.length;
  }

  function pushArrangementHistorySnapshot(snapshot) {
    if (!snapshot || arrangementHistory.at(-1) === snapshot) return;
    arrangementHistory.push(snapshot); if (arrangementHistory.length > 80) arrangementHistory.shift(); arrangementFuture = []; syncArrangementHistoryControls();
  }

  function pushArrangementHistory(item) { if (item) pushArrangementHistorySnapshot(arrangementSnapshot(item)); }

  function clearArrangementHistory({ preserveEditingState = false } = {}) {
    arrangementHistory = []; arrangementFuture = [];
    if (!preserveEditingState) { arrangementSelection = null; clearTimeout(arrangementPersistTimer); arrangementPersistTimer = null; arrangementDrafts.clear(); }
    syncArrangementHistoryControls();
  }

  async function moveArrangementHistory(project, item, undo = true) {
    const from = undo ? arrangementHistory : arrangementFuture; const to = undo ? arrangementFuture : arrangementHistory;
    if (!project || !item || !from.length) return;
    // Core.getActiveProject normalizes (and therefore clones) state.  Button
    // callbacks can consequently hand us a project and item from two different
    // clones; always resolve the work item inside the project that will be saved.
    const projectItem = project.data.workItems.find((candidate) => candidate.id === item.id);
    if (!projectItem) return;
    clearTimeout(arrangementPersistTimer); arrangementPersistTimer = null; arrangementDrafts.clear();
    to.push(arrangementSnapshot(projectItem)); restoreArrangementSnapshot(projectItem, from.pop()); arrangementSelection = null;
    projectItem.updatedAt = new Date().toISOString(); state = Core.updateProject(state, project.id, { data: project.data }); syncArrangementHistoryControls();
    await persist(undo ? '작업표 편집 실행 취소됨' : '작업표 편집 다시 실행됨'); renderArrangementPage();
  }

  function arrangementSelectionBounds() {
    if (!arrangementSelection) return null;
    return {
      minRow: Math.min(arrangementSelection.anchor.row, arrangementSelection.focus.row),
      maxRow: Math.max(arrangementSelection.anchor.row, arrangementSelection.focus.row),
      minCol: Math.min(arrangementSelection.anchor.col, arrangementSelection.focus.col),
      maxCol: Math.max(arrangementSelection.anchor.col, arrangementSelection.focus.col)
    };
  }

  function arrangementSelectionIsRange() {
    const bounds = arrangementSelectionBounds();
    return Boolean(bounds && (arrangementSelection.mode !== 'cells' || bounds.minRow !== bounds.maxRow || bounds.minCol !== bounds.maxCol));
  }

  function updateArrangementSelection(anchor, focus = anchor, mode = arrangementSelection?.mode || 'cells') {
    const item = activeWorkItem(); if (!item) return;
    arrangementSelection = { anchor, focus, mode };
    const minRow = Math.min(anchor.row, focus.row); const maxRow = Math.max(anchor.row, focus.row); const minCol = Math.min(anchor.col, focus.col); const maxCol = Math.max(anchor.col, focus.col);
    $$('[data-arrangement-row][data-arrangement-col]', $('#arrangementBoard')).forEach((cell) => {
      const row = Number(cell.dataset.arrangementRow); const col = Number(cell.dataset.arrangementCol);
      cell.classList.toggle('sheet-selected', row >= minRow && row <= maxRow && col >= minCol && col <= maxCol);
      cell.classList.toggle('sheet-anchor', row === anchor.row && col === anchor.col);
    });
    $$('[data-select-arrangement-row]', $('#arrangementBoard')).forEach((cell) => { const row = Number(cell.dataset.selectArrangementRow); cell.classList.toggle('sheet-selector-selected', mode === 'row' && row >= minRow && row <= maxRow); });
    $$('[data-select-arrangement-column]', $('#arrangementBoard')).forEach((cell) => { const col = Number(cell.dataset.selectArrangementColumn); cell.classList.toggle('sheet-selector-selected', mode === 'column' && col >= minCol && col <= maxCol); });
    $('#arrangementBoard [data-select-arrangement-all]')?.classList.toggle('sheet-selector-selected', mode === 'all');
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

  function focusArrangementCell(row, col, extend = false) {
    const item = activeWorkItem(); if (!item?.columns.length) return; const visibleRows = Math.max(item.rows.length + 2, 5);
    const point = { row: Math.max(0, Math.min(visibleRows - 1, row)), col: Math.max(0, Math.min(item.columns.length - 1, col)) };
    updateArrangementSelection(extend && arrangementSelection ? arrangementSelection.anchor : point, point);
    const cell = $(`[data-arrangement-row="${point.row}"][data-arrangement-col="${point.col}"]`, $('#arrangementBoard')); const input = cell?.querySelector('input');
    if (input) { input.focus({ preventScroll: true }); input.select(); } else if (cell) { cell.tabIndex = -1; cell.focus({ preventScroll: true }); }
  }

  function shouldUseNativeArrangementClipboard(event) {
    if (event.target.closest?.('[contenteditable="true"]')) return true;
    const input = event.target.closest?.('input, textarea'); if (!input) return false;
    if (!input.matches('#arrangementCellValue, #arrangementBoard input')) return true;
    if (arrangementSelectionIsRange()) return false;
    return typeof input.selectionStart === 'number' && input.selectionStart !== input.selectionEnd;
  }

  async function finishArrangementSheetMutation(project, item, message) {
    item.updatedAt = new Date().toISOString(); state = Core.updateProject(state, project.id, { data: project.data }); await persist(message); renderArrangementPage();
  }

  async function clearSelectedArrangementCells(project, item, { recordHistory = true, message = '선택 작업표 셀 지움' } = {}) {
    const bounds = arrangementSelectionBounds(); if (!project || !item || !bounds) return false; if (recordHistory) pushArrangementHistory(item); let changed = 0;
    for (let row = Math.max(0, bounds.minRow); row <= bounds.maxRow; row += 1) for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) { setArrangementCellValue(item, row, col, ''); changed += 1; }
    if (!changed) { if (recordHistory) arrangementHistory.pop(); syncArrangementHistoryControls(); return false; }
    await finishArrangementSheetMutation(project, item, message); return true;
  }

  async function applyArrangementSheetAction(action, columnName = '새 컬럼') {
    const project = activeProject(); const item = activeWorkItem(project); const bounds = arrangementSelectionBounds(); if (!project || !item || (!bounds && action !== 'insert-row')) return;
    if (action === 'clear') { await clearSelectedArrangementCells(project, item); return; }
    pushArrangementHistory(item);
    if (action === 'fill-down') {
      const sourceRow = Math.max(0, bounds.minRow);
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) { const value = arrangementCellValue(item, sourceRow, col); for (let row = sourceRow + 1; row <= bounds.maxRow; row += 1) setArrangementCellValue(item, row, col, value); }
    } else if (action === 'insert-row') {
      const index = Math.max(0, bounds?.minRow || 0); item.rows.splice(index, 0, { id: `work-row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, personId: null, values: Object.fromEntries(item.columns.map((column) => [column.id, ''])) });
      arrangementSelection = { anchor: { row: index, col: Math.max(0, bounds?.minCol || 0) }, focus: { row: index, col: Math.max(0, bounds?.minCol || 0) }, mode: 'cells' };
    } else if (action === 'delete-rows') {
      const start = Math.max(0, bounds.minRow); const count = Math.max(0, Math.min(item.rows.length - 1, bounds.maxRow) - start + 1); if (count) item.rows.splice(start, count); arrangementSelection = null;
    } else if (action === 'insert-column') {
      const index = Math.max(0, bounds.minCol); const id = `work-column-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; item.columns.splice(index, 0, { id, name: String(columnName || '새 컬럼').trim() || '새 컬럼' }); item.rows.forEach((row) => { row.values[id] = ''; });
      arrangementSelection = { anchor: { row: -1, col: index }, focus: { row: -1, col: index }, mode: 'cells' };
    } else if (action === 'delete-columns') {
      const count = bounds.maxCol - bounds.minCol + 1; if (item.columns.length - count < 1) { arrangementHistory.pop(); syncArrangementHistoryControls(); showToast('작업표에는 컬럼이 하나 이상 있어야 합니다.', 'error'); return; }
      const removed = item.columns.splice(bounds.minCol, count); item.rows.forEach((row) => removed.forEach((column) => delete row.values[column.id])); arrangementSelection = null;
    }
    await finishArrangementSheetMutation(project, item, ({ 'fill-down': '작업표 아래로 채우기', 'insert-row': '작업표 행 삽입', 'delete-rows': '작업표 행 삭제', 'insert-column': '작업표 컬럼 삽입', 'delete-columns': '작업표 컬럼 삭제' })[action] || '작업표 편집');
  }

  function renderArrangementPage() {
    const project = activeProject(); const item = activeWorkItem(project);
    if (!project || !item) { navigate('people'); return; }
    project.data.activeWorkItemId = item.id;
    $('#arrangementTitle').textContent = item.name;
    $('#arrangementSummary').textContent = `이 작업표는 원본 명단과 별도로 저장됩니다.`;
    const select = $('#arrangementSelect'); select.replaceChildren(...project.data.workItems.map((work) => { const option = element('option', '', work.name); option.value = work.id; option.selected = work.id === item.id; return option; }));
    const table = $('#arrangementBoard'); const letterRow = element('tr', 'sheet-letter-row'); const corner = element('th', 'sheet-corner', ''); corner.dataset.selectArrangementAll = 'true'; corner.title = '전체 표 선택'; letterRow.append(corner);
    item.columns.forEach((_column, index) => { const letter = element('th', 'sheet-letter', spreadsheetColumnName(index)); letter.dataset.selectArrangementColumn = String(index); letter.title = `${spreadsheetColumnName(index)}열 전체 선택`; letterRow.append(letter); }); letterRow.append(element('th', 'sheet-letter', spreadsheetColumnName(item.columns.length)));
    const headerRow = element('tr'); headerRow.append(element('th', 'sheet-row-number', '1'));
    item.columns.forEach((column, index) => { const th = element('th', 'arrangement-column-header'); th.dataset.arrangementRow = '-1'; th.dataset.arrangementCol = String(index); const name = element('button', 'arrangement-column-name', column.name); name.type = 'button'; name.dataset.arrangementRenameColumn = column.id; name.title = '드래그하여 선택 · 더블클릭하여 컬럼 이름 변경'; const remove = element('button', 'arrangement-column-remove', '×'); remove.type = 'button'; remove.dataset.arrangementRemoveColumn = column.id; th.append(name, remove); headerRow.append(th); });
    const addTh = element('th', 'arrangement-add-column'); const add = element('button', '', '＋ 컬럼'); add.type = 'button'; add.dataset.arrangementAddColumn = 'true'; addTh.append(add); headerRow.append(addTh); table.tHead.replaceChildren(letterRow, headerRow);
    const visibleRows = Math.max(item.rows.length + 2, 5); const rows = Array.from({ length: visibleRows }, (_, rowIndex) => { const tr = element('tr'); const rowNumber = element('th', 'sheet-row-number', String(rowIndex + 2)); rowNumber.dataset.selectArrangementRow = String(rowIndex); rowNumber.title = `${rowIndex + 2}행 전체 선택`; tr.append(rowNumber); item.columns.forEach((column, colIndex) => { const td = element('td'); td.dataset.arrangementRow = String(rowIndex); td.dataset.arrangementCol = String(colIndex); const input = element('input'); input.type = 'text'; input.value = item.rows[rowIndex]?.values?.[column.id] || ''; input.dataset.arrangementInput = 'true'; td.append(input); tr.append(td); }); tr.append(element('td', 'roster-add-column-spacer', '')); return tr; });
    table.tBodies[0].replaceChildren(...rows);
    if (arrangementSelection && arrangementSelection.focus.col < item.columns.length) updateArrangementSelection(arrangementSelection.anchor, arrangementSelection.focus, arrangementSelection.mode); else { arrangementSelection = null; $('#arrangementSelectionStatus').textContent = '선택 없음'; $('#arrangementCellAddress').textContent = '—'; $('#arrangementCellValue').value = ''; $('#arrangementCellValue').disabled = true; }
    syncArrangementHistoryControls();
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
    if (filter.startsWith('column:')) { const [, columnId, encoded = ''] = filter.split(':'); let expected = encoded; try { expected = decodeURIComponent(encoded); } catch (_) {} return active.filter((person) => String(person.values[columnId] || '').trim() === expected); }
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

  function defaultScheduleSheetColumns(project) {
    return [
      { id: 'schedule-date', key: 'date', name: '날짜', kind: 'system', roleId: null },
      { id: 'schedule-start', key: 'startTime', name: '시작', kind: 'system', roleId: null },
      { id: 'schedule-end', key: 'endTime', name: '종료', kind: 'system', roleId: null },
      { id: 'schedule-label', key: 'label', name: '세션명', kind: 'system', roleId: null },
      ...project.data.roles.filter((role) => role.active).map((role) => ({ id: `schedule-role-${role.id}`, key: `role:${role.id}`, name: role.name, kind: 'role', roleId: role.id })),
      { id: 'schedule-status', key: 'status', name: '상태', kind: 'system', roleId: null },
      { id: 'schedule-locked', key: 'locked', name: '잠금', kind: 'system', roleId: null }
    ];
  }

  function ensureScheduleSheetInitialized(project) {
    if (!project || project.data.scheduleSheetInitialized) {
      if (project) { project.data.scheduleSheetColumns ||= []; project.data.scheduleCustomValues ||= {}; }
      return false;
    }
    project.data.scheduleSheetColumns = defaultScheduleSheetColumns(project);
    project.data.scheduleCustomValues ||= {};
    project.data.scheduleSheetInitialized = true;
    return true;
  }

  async function persistScheduleSheetInitialization(project, message = '일정표 기본 컬럼 준비됨') {
    if (!project || !ensureScheduleSheetInitialized(project)) return project;
    const projectId = project.id;
    refreshScheduleConflicts(project);
    state = Core.updateProject(state, projectId, { data: project.data });
    recordScheduleMergeImpact(projectId);
    await persist(message, { scheduleProjectId: projectId });
    return projectById(projectId);
  }

  function scheduleSheetColumns(project) {
    const columns = project.data.scheduleSheetInitialized && Array.isArray(project.data.scheduleSheetColumns)
      ? project.data.scheduleSheetColumns
      : defaultScheduleSheetColumns(project);
    return columns.map((column) => ({ ...column, label: column.name, role: column.roleId ? project.data.roles.find((role) => role.id === column.roleId) : null }));
  }

  function scheduleCellValue(project, rowIndex, columnIndex) {
    const slot = project.data.slots[rowIndex];
    const column = scheduleSheetColumns(project)[columnIndex]; if (!slot || !column) return '';
    if (column.kind === 'role' && column.role) {
      return project.data.assignments.filter((item) => item.slotId === slot.id && item.roleId === column.role.id)
        .map((item) => project.data.people.find((person) => person.id === item.personId && person.active !== false)?.name || (!item.personId ? item.personName : '')).filter(Boolean).join(', ');
    }
    if (column.kind === 'custom') return project.data.scheduleCustomValues?.[slot.id]?.[column.id] || '';
    if (column.key === 'locked') return scheduleRowLocked(project, slot.id) ? '예' : '';
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
    project.data.conflicts = Ops.collectScheduleConflicts(project);
  }

  function setScheduleCellValue(project, rowIndex, columnIndex, value, { lockedSlotIds = null } = {}) {
    ensureScheduleSheetInitialized(project);
    const column = scheduleSheetColumns(project)[columnIndex]; if (!column) return false;
    const text = String(value ?? '').trim();
    let slot = project.data.slots[rowIndex]; if (!slot && !text) return true; if (!slot) slot = ensureScheduleRow(project, rowIndex);
    if ((lockedSlotIds?.has(slot.id) || scheduleRowLocked(project, slot.id)) && column.key !== 'locked') return false;
    if (column.kind === 'role' && column.role) {
      project.data.assignments = project.data.assignments.filter((item) => !(item.slotId === slot.id && item.roleId === column.role.id));
      peopleTokens(text).forEach((name, position) => {
        const lowered = name.toLowerCase();
        const person = project.data.people.find((item) => [item.name, item.email, item.phone].some((candidate) => String(candidate || '').toLowerCase() === lowered));
        project.data.assignments.push({ id: `assignment-${Date.now().toString(36)}-${rowIndex}-${scheduleAssignmentSequence++}-${position}`, slotId: slot.id, personId: person?.id || '', personName: person?.name || name, roleId: column.role.id, roleName: column.role.name, locked: Boolean(slot.locked), source: 'manual-sheet' });
      });
    } else if (column.kind === 'custom') {
      project.data.scheduleCustomValues[slot.id] ||= {}; project.data.scheduleCustomValues[slot.id][column.id] = String(value ?? '');
    } else if (column.key === 'status') {
      const statusMap = { '편성 중': 'draft', '초안': 'draft', draft: 'draft', '확정': 'confirmed', confirmed: 'confirmed', '변경됨': 'changed', changed: 'changed', '취소': 'cancelled', cancelled: 'cancelled' };
      slot.status = statusMap[text] || text || 'draft';
    } else if (column.key === 'locked') {
      slot.locked = /^(예|y|yes|true|1|잠금)$/i.test(text); project.data.assignments.filter((item) => item.slotId === slot.id).forEach((item) => { item.locked = slot.locked; });
    } else {
      slot[column.key] = text;
      if (column.key === 'startTime' && text && !slot.endTime) slot.endTime = Ops.addMinutesToTime(text, project.settings?.sessionDurationMinutes);
    }
    scheduleEditGeneration += 1;
    refreshScheduleConflicts(project);
    return true;
  }

  function scheduleSnapshot(project) {
    return JSON.stringify({ slots: project.data.slots, assignments: project.data.assignments, availability: project.data.availability, scheduleSheetInitialized: project.data.scheduleSheetInitialized, scheduleSheetColumns: project.data.scheduleSheetColumns, scheduleCustomValues: project.data.scheduleCustomValues });
  }

  function restoreScheduleSnapshot(project, snapshot) {
    const data = JSON.parse(snapshot);
    project.data.slots = Array.isArray(data.slots) ? data.slots : [];
    project.data.assignments = Array.isArray(data.assignments) ? data.assignments : [];
    project.data.availability = data.availability && typeof data.availability === 'object' ? data.availability : project.data.availability;
    project.data.scheduleSheetInitialized = data.scheduleSheetInitialized;
    project.data.scheduleSheetColumns = data.scheduleSheetColumns;
    project.data.scheduleCustomValues = data.scheduleCustomValues || {};
    refreshScheduleConflicts(project);
  }

  function scheduleArtifactKey(item, index = 0) {
    if (item?.externalId) return `${item.kind || 'artifact'}:external:${item.externalId}`;
    return `${item?.kind || 'artifact'}:${item?.slotId || item?.personId || ''}:${item?.createdAt || index}`;
  }

  function mergeScheduleArtifacts(remoteArtifacts = [], localArtifacts = [], impact = null) {
    const merged = new Map(remoteArtifacts.map((item, index) => [scheduleArtifactKey(item, index), item]));
    const zoomSlots = new Set([...(impact?.changedSlotIds || []), ...(impact?.zoomReviewSlotIds || [])]);
    const mailPeople = new Set(impact?.affectedPersonIds || []);
    localArtifacts.forEach((item, index) => {
      const key = scheduleArtifactKey(item, index);
      const remote = merged.get(key) || {};
      const affected = (item.kind === 'zoom' && zoomSlots.has(item.slotId)) || (item.kind === 'gmailDraft' && mailPeople.has(item.personId));
      const next = affected ? { ...remote, ...item } : { ...item, ...remote };
      if (remote.status === 'superseded' || item.status === 'superseded') {
        next.status = 'superseded';
        next.replacedAt = remote.replacedAt || item.replacedAt;
      }
      merged.set(key, next);
    });
    return [...merged.values()].map((item) => {
      if (item.status === 'superseded') return item;
      if ((item.kind === 'zoom' && zoomSlots.has(item.slotId)) || (item.kind === 'gmailDraft' && mailPeople.has(item.personId))) return { ...item, status: 'stale' };
      return item;
    });
  }

  function mergeExternalArtifactUpdates(currentArtifacts = [], updates = []) {
    const merged = new Map(currentArtifacts.map((item, index) => [scheduleArtifactKey(item, index), item]));
    updates.forEach((item, index) => {
      const key = scheduleArtifactKey(item, index); const current = merged.get(key) || {}; const next = { ...current, ...item };
      if (current.status === 'superseded') { next.status = 'superseded'; next.replacedAt = current.replacedAt || item.replacedAt; }
      merged.set(key, next);
    });
    return [...merged.values()];
  }

  function overlayLocalScheduleState(baseState, projectId, localProject, impact = null) {
    const scheduleKeys = ['roles', 'slots', 'availability', 'assignments', 'conflicts', 'scheduleRules', 'scheduleSheetInitialized', 'scheduleSheetColumns', 'scheduleCustomValues', 'versions'];
    const baseProject = baseState.projects.find((item) => item.id === projectId) || Object.values(baseState.quickWorkspaces || {}).find((item) => item.id === projectId);
    if (!baseProject || !localProject) return baseState;
    const data = Object.fromEntries(scheduleKeys.map((key) => [key, localProject.data[key]]));
    data.externalArtifacts = mergeScheduleArtifacts(baseProject.data.externalArtifacts, localProject.data.externalArtifacts, impact);
    const moduleState = { ...baseProject.moduleState, schedule: localProject.moduleState.schedule };
    ['zoom', 'gmailFlow'].forEach((moduleId) => { if (localProject.moduleState[moduleId]?.status === 'stale') moduleState[moduleId] = localProject.moduleState[moduleId]; });
    const workflow = baseProject.workflow.map((step) => {
      const localStep = localProject.workflow.find((item) => item.id === step.id);
      if (!localStep) return step;
      return step.moduleId === 'schedule' || (['zoom', 'gmailFlow'].includes(step.moduleId) && localStep.status === 'stale') ? localStep : step;
    });
    return Core.updateProject(baseState, projectId, { data, moduleState, workflow });
  }

  function resetScheduleHistoryForIncomingState(nextState) {
    const project = activeProject();
    if (!project) return;
    const incomingProject = nextState.projects.find((item) => item.id === project.id) || Object.values(nextState.quickWorkspaces || {}).find((item) => item.id === project.id);
    if (!incomingProject || scheduleSnapshot(project) === scheduleSnapshot(incomingProject)) return;
    clearScheduleHistory();
  }

  function hasFocusedWorkspaceDraft() {
    const target = document.activeElement;
    if (!target?.matches?.('[data-person-row], [data-column-name], #rosterCellValue, [data-arrangement-input], #arrangementCellValue, [data-schedule-input], #scheduleCellValue, #mailSubjectTemplate, #mailBodyEditor, #mailEditSubject, #mailEditBody')) return false;
    const dialog = target.closest('dialog');
    if (dialog && !dialog.open) return false;
    const page = target.closest('.page');
    if (page && !page.classList.contains('active')) return false;
    return target.isConnected && !target.closest('[hidden]');
  }

  function applyIncomingWorkspaceState(nextState) {
    resetScheduleHistoryForIncomingState(nextState);
    // Undo snapshots are scoped to the exact in-memory revision they were taken
    // from.  Once another window wins with a newer workspace revision, keeping
    // either sheet stack would let Undo overwrite that newer state with stale
    // roster/work-item data.  Draft queues are cleared by these helpers too.
    clearRosterHistory();
    clearArrangementHistory();
    rosterSelecting = false;
    arrangementSelecting = false;
    scheduleSelecting = false;
    $('#rosterEditorTable')?.classList.remove('range-selecting');
    $('#arrangementBoard')?.classList.remove('range-selecting');
    $('#scheduleBoard')?.classList.remove('range-selecting');
    acceptPersistedBaseline(nextState);
    state = nextState;
    pendingMergedSurfaceRender = false;
    if (state.preferences.storageMode === 'drive') scheduleDriveStateSync();
    if (mailEditorDirty && currentPage === 'gmailFlow') {
      showToast('다른 창의 변경사항을 받았습니다. 작성 중인 메일은 그대로 보호됩니다.');
      renderGmailPage();
      renderConnectionsPage();
    } else renderAll();
  }

  function applyDeferredWorkspaceState() {
    if (deferredWorkspaceState && persistReconcileNeeded) schedulePersistReconciliation();
    if ((!deferredWorkspaceState && !pendingMergedSurfaceRender) || persistSaving || persistDirty || externalOperationCount || schedulePersistBaseline || mailEditorDirty || hasFocusedWorkspaceDraft()) return;
    if (deferredWorkspaceState) {
      const nextState = deferredWorkspaceState;
      deferredWorkspaceState = null;
      const nextRevision = Number(nextState._revision || 0);
      const currentRevision = Number(state._revision || 0);
      const newer = nextRevision > currentRevision || (nextRevision === currentRevision && String(nextState.updatedAt || '') > String(state.updatedAt || ''));
      if (newer) { applyIncomingWorkspaceState(nextState); return; }
    }
    if (pendingMergedSurfaceRender) {
      pendingMergedSurfaceRender = false;
      renderAll();
    }
  }

  if (smokeDiagnostics) {
    globalThis.__workspaceStateDeferral = () => ({
      stateRevision: Number(state._revision || 0),
      deferredRevision: Number(deferredWorkspaceState?._revision || 0),
      persistSaving,
      persistDirty,
      persistReconcileNeeded,
      persistReconcileBlocked,
      pendingMergedSurfaceRender,
      externalOperationCount,
      schedulePersistPending: Boolean(schedulePersistBaseline),
      mailEditorDirty,
      focusedDraft: hasFocusedWorkspaceDraft(),
      activeElement: document.activeElement ? {
        id: document.activeElement.id || '',
        tag: document.activeElement.tagName || '',
        dialogOpen: document.activeElement.closest('dialog')?.open ?? null,
        page: document.activeElement.closest('.page')?.dataset.page || ''
      } : null
    });
    globalThis.__workspaceSheetDiagnostics = () => {
      const summarizeArrangement = (snapshot) => {
        const value = JSON.parse(snapshot);
        return {
          columns: value.columns?.map((column) => column.name),
          rows: value.rows?.slice(0, 3).map((row) => value.columns?.map((column) => row.values?.[column.id]))
        };
      };
      const item = activeWorkItem();
      return {
        rosterHistoryLength: rosterHistory.length,
        rosterFutureLength: rosterFuture.length,
        arrangementHistory: arrangementHistory.map(summarizeArrangement),
        arrangementFuture: arrangementFuture.map(summarizeArrangement),
        arrangementCurrent: item ? summarizeArrangement(arrangementSnapshot(item)) : null,
        arrangementDrafts: [...arrangementDrafts.values()]
      };
    };
  }

  function scheduleMutationImpact(before = {}, after = {}) {
    return Ops.diffScheduleDependencies({
      beforeSlots: Array.isArray(before.slots) ? before.slots : [],
      beforeAssignments: Array.isArray(before.assignments) ? before.assignments : [],
      afterSlots: Array.isArray(after.slots) ? after.slots : [],
      afterAssignments: Array.isArray(after.assignments) ? after.assignments : []
    });
  }

  function recordScheduleMergeImpact(projectId, impact = null, { scheduleOnly = true } = {}) {
    if (!projectId) return;
    const current = pendingScheduleMergeHints.get(projectId) || { changedSlotIds: [], zoomReviewSlotIds: [], affectedPersonIds: [] };
    pendingScheduleMergeHints.set(projectId, {
      changedSlotIds: [...new Set([...current.changedSlotIds, ...(impact?.changedSlotIds || [])])],
      zoomReviewSlotIds: [...new Set([...current.zoomReviewSlotIds, ...(impact?.zoomReviewSlotIds || [])])],
      affectedPersonIds: [...new Set([...current.affectedPersonIds, ...(impact?.affectedPersonIds || [])])],
      scheduleOnly: current.scheduleOnly === false || scheduleOnly === false ? false : true
    });
  }

  function applyScheduleMutationImpact(project, beforeSnapshot) {
    if (!beforeSnapshot) return null;
    const before = typeof beforeSnapshot === 'string' ? JSON.parse(beforeSnapshot) : beforeSnapshot;
    const impact = scheduleMutationImpact(before, { slots: project.data.slots, assignments: project.data.assignments });
    markScheduleChangeStale(project, impact, { markConfirmedSlots: false });
    const beforeSlots = new Map((before.slots || []).map((slot) => [slot.id, slot]));
    const assignmentSignature = (items, slotId) => (items || []).filter((assignment) => assignment.slotId === slotId).map((assignment) => [assignment.personId || assignment.personName || '', assignment.roleId || assignment.roleName || ''].join('|')).sort().join(',');
    project.data.slots.filter((slot) => slot.status === 'confirmed' && impact.changedSlotIds.includes(slot.id)).forEach((slot) => {
      const previous = beforeSlots.get(slot.id); const dependencyChanged = !previous || [slot.date, slot.startTime, slot.endTime, slot.label].join('|') !== [previous.date, previous.startTime, previous.endTime, previous.label].join('|') || assignmentSignature(project.data.assignments, slot.id) !== assignmentSignature(before.assignments, slot.id);
      if (dependencyChanged) slot.status = 'changed';
    });
    return impact;
  }

  function syncScheduleProjectState(project, summary, impact = null) {
    state = Core.updateProject(state, project.id, { data: project.data });
    state = Core.setModuleStatus(state, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'inProgress', summary || `일정 ${project.data.slots.length}개 · 확인할 문제 ${project.data.conflicts.length}건`);
    if (impact && project.installedModules.includes('zoom') && impact.zoomReviewSlotIds?.length) state = Core.setModuleStatus(state, project.id, 'zoom', 'stale', '일정 변경 후 Zoom 확인 필요');
    if (impact && project.installedModules.includes('gmailFlow') && impact.affectedPersonIds?.length) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', '일정 변경 후 안내 메일 확인 필요');
    recordScheduleMergeImpact(project.id, impact);
  }

  function pushScheduleHistory(project) {
    pushScheduleHistorySnapshot(scheduleSnapshot(project));
  }

  function syncScheduleHistoryControls() {
    ['scheduleUndo', 'sessionUndo'].forEach((id) => { if ($(`#${id}`)) $(`#${id}`).disabled = !scheduleHistory.length; });
    ['scheduleRedo', 'sessionRedo'].forEach((id) => { if ($(`#${id}`)) $(`#${id}`).disabled = !scheduleFuture.length; });
  }

  function pushScheduleHistorySnapshot(snapshot) {
    scheduleHistory.push(snapshot); if (scheduleHistory.length > 80) scheduleHistory.shift(); scheduleFuture = []; syncScheduleHistoryControls();
  }

  function clearScheduleHistory() {
    scheduleHistory = [];
    scheduleFuture = [];
    pendingSessionChange = null;
    const formula = $('#scheduleCellValue');
    if (formula) ['scheduleEditing', 'scheduleImpactBefore', 'scheduleEditRow', 'scheduleEditCol', 'scheduleEditValue'].forEach((key) => delete formula.dataset[key]);
    syncScheduleHistoryControls();
  }

  function takeSchedulePersistBaseline(project, fallback = null) {
    if (!schedulePersistBaseline || schedulePersistProjectId !== project?.id) return fallback;
    const baseline = schedulePersistBaseline;
    clearTimeout(schedulePersistTimer); schedulePersistTimer = null; schedulePersistBaseline = null; schedulePersistProjectId = null;
    return baseline;
  }

  function commitSchedulePersistState() {
    if (!schedulePersistBaseline || !schedulePersistProjectId) return null;
    const projectId = schedulePersistProjectId; const baseline = schedulePersistBaseline; const message = schedulePersistMessage;
    clearTimeout(schedulePersistTimer); schedulePersistTimer = null; schedulePersistBaseline = null; schedulePersistProjectId = null;
    const project = state.projects.find((item) => item.id === projectId) || Object.values(state.quickWorkspaces || {}).find((item) => item.id === projectId);
    if (!project) return null;
    const impact = applyScheduleMutationImpact(project, baseline);
    refreshScheduleConflicts(project);
    syncScheduleProjectState(project, `직접 편집 · 문제 ${project.data.conflicts.length}건`, impact);
    return { message, projectId, generation: scheduleEditGeneration };
  }

  async function flushSchedulePersist() {
    const committed = commitSchedulePersistState(); if (!committed) return;
    await persist(committed.message, { scheduleProjectId: committed.projectId, scheduleGeneration: committed.generation });
    if (currentPage === 'schedule' && activeProject()?.id === committed.projectId) { const project = activeProject(); renderAvailability(project); renderSessionPlanner(project); syncScheduleHistoryControls(); renderDashboard(); } else renderDashboard();
  }

  async function moveScheduleHistory(project, undo = true) {
    const from = undo ? scheduleHistory : scheduleFuture; const to = undo ? scheduleFuture : scheduleHistory;
    if (!project || !from.length) return;
    const dependencyBaseline = takeSchedulePersistBaseline(project, null);
    const before = JSON.parse(scheduleSnapshot(project));
    to.push(scheduleSnapshot(project)); restoreScheduleSnapshot(project, from.pop());
    const impact = applyScheduleMutationImpact(project, dependencyBaseline || before);
    pendingSessionChange = null;
    syncScheduleProjectState(project, undo ? '일정 변경 실행 취소' : '일정 변경 다시 실행', impact);
    syncScheduleHistoryControls(); await persist(undo ? '실행 취소됨' : '다시 실행됨'); renderSchedulePage();
  }

  function queueSchedulePersist(project, message = '일정 셀 편집 저장됨', beforeSnapshot = null) {
    if (schedulePersistProjectId && schedulePersistProjectId !== project.id) void flushSchedulePersist();
    ensureScheduleSheetInitialized(project);
    if (!schedulePersistBaseline) schedulePersistBaseline = beforeSnapshot || scheduleSnapshot(project);
    persistDirty = true;
    schedulePersistProjectId = project.id; schedulePersistMessage = message;
    state = Core.updateProject(state, project.id, { data: project.data });
    clearTimeout(schedulePersistTimer); schedulePersistTimer = setTimeout(() => void flushSchedulePersist(), 450);
  }

  function syncScheduleRowLockControls(project, rowIndex) {
    const locked = scheduleRowLocked(project, project.data.slots[rowIndex]?.id);
    $$(`[data-schedule-row="${rowIndex}"][data-schedule-col]`, $('#scheduleBoard')).forEach((cell) => {
      const column = scheduleSheetColumns(project)[Number(cell.dataset.scheduleCol)]; const input = cell.querySelector('[data-schedule-input]');
      if (input) input.disabled = Boolean(locked && column?.key !== 'locked');
    });
    if (scheduleSelection?.focus.row === rowIndex) updateScheduleSelection(scheduleSelection.anchor, scheduleSelection.focus, scheduleSelection.mode);
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
    const column = scheduleSheetColumns(project)[focus.col]; const locked = focus.row >= 0 && scheduleRowLocked(project, project.data.slots[focus.row]?.id) && column?.key !== 'locked'; $('#scheduleCellValue').disabled = !column || locked; $('#scheduleCellValue').title = locked ? '잠금 셀을 먼저 해제하면 편집할 수 있습니다.' : ''; $('#scheduleCellValue').value = focus.row === -1 ? column?.name || '' : scheduleCellValue(project, focus.row, focus.col);
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
    const cell = $(`[data-schedule-row="${point.row}"][data-schedule-col="${point.col}"]`, $('#scheduleBoard')); const input = cell?.querySelector('input');
    if (input && !input.disabled) { input.focus(); input.select(); }
    else if (cell) { document.activeElement?.blur(); cell.tabIndex = -1; cell.focus({ preventScroll: true }); }
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
        const input = element('input'); input.type = 'text'; input.value = scheduleCellValue(project, rowIndex, columnIndex); input.dataset.scheduleInput = 'true'; input.autocomplete = 'off'; input.disabled = Boolean(slot && scheduleRowLocked(project, slot.id) && column.key !== 'locked');
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
    syncScheduleHistoryControls();
    renderSessionPlanner(project);
  }

  function sessionRosterPeople(project) {
    const viewId = $('#sessionRosterView')?.value || project.data.scheduleRules.rosterViewId || '';
    const view = project.data.rosterViews.find((item) => item.id === viewId) || null;
    const ids = new Set(rosterViewIncludedIds(view, project));
    const group = $('#sessionGroupFilter')?.value || '';
    const search = ($('#sessionPersonSearch')?.value || '').trim().toLowerCase();
    return project.data.people.filter((person) => {
      if (person.active === false || !ids.has(person.id) || (group && person.group !== group)) return false;
      if (!search) return true;
      return [person.name, person.email, person.phone, person.group].some((value) => String(value || '').toLowerCase().includes(search));
    });
  }

  function sessionSlotLabel(slot) {
    if (!slot) return '일정 없음';
    return `${slot.date || '날짜 미정'} ${slot.startTime || '--:--'}–${slot.endTime || '--:--'}${slot.label ? ` · ${slot.label}` : ''}`;
  }

  function sessionChangeRole(project, personId, assignmentId = '') {
    const assignment = assignmentId && assignmentId !== 'new' ? project.data.assignments.find((item) => item.id === assignmentId) : null;
    if (assignment) return assignment.roleId;
    const selectedRole = $('#sessionRoleSelect')?.value;
    return project.data.roles.find((item) => item.id === selectedRole && item.active)?.id
      || project.data.roles.find((item) => item.active && roleCandidates(project, item).some((candidate) => candidate.id === personId))?.id
      || project.data.roles.find((item) => item.active)?.id
      || '';
  }

  function makeSessionChangePlan(project, change, extraSlots = []) {
    const viewId = $('#sessionRosterView')?.value || project.data.scheduleRules.rosterViewId || '';
    const scheduleView = project.data.rosterViews.find((item) => item.id === viewId) || null;
    return Ops.planScheduleChange({
      people: project.data.people,
      roles: project.data.roles,
      slots: [...project.data.slots, ...extraSlots],
      assignments: project.data.assignments,
      availability: project.data.availability,
      rules: project.data.scheduleRules,
      targetPersonIds: rosterViewIncludedIds(scheduleView, project),
      change
    });
  }

  function scheduleChangeSignature(project) {
    return JSON.stringify({
      slots: project.data.slots.map((slot) => [slot.id, slot.date, slot.startTime, slot.endTime, slot.label, slot.status, Boolean(slot.locked)]),
      assignments: project.data.assignments.map((assignment) => [assignment.id, assignment.slotId, assignment.personId, assignment.roleId, Boolean(assignment.locked)]),
      people: project.data.people.map((person) => [person.id, person.name, person.active !== false, [...(person.roleIds || [])].sort(), Object.entries(person.values || {}).sort(([a], [b]) => a.localeCompare(b))]),
      roles: project.data.roles.map((role) => [role.id, role.name, role.active !== false, role.candidateFilter || 'manual', Number(role.minPerSession) || 0, Number(role.maxPerSession) || 0, Number(role.targetSessions) || 0]),
      availability: Object.entries(project.data.availability || {}).sort(([a], [b]) => a.localeCompare(b)).map(([personId, slotIds]) => [personId, Array.isArray(slotIds) ? [...slotIds].sort() : slotIds]),
      unmarkedMeansAvailable: Boolean(project.data.scheduleRules.unmarkedMeansAvailable)
    });
  }

  function rosterReplacementSignature(project) {
    return JSON.stringify({
      schedule: scheduleChangeSignature(project),
      rosterName: project.data.rosterName || '',
      columns: project.data.columns,
      people: project.data.people,
      rosterViews: project.data.rosterViews,
      activeRosterViewId: project.data.activeRosterViewId || null,
      scheduleRosterViewId: project.data.scheduleRules.rosterViewId || null
    });
  }

  function sharedRosterSignature(roster) {
    return JSON.stringify(roster ? {
      id: roster.id,
      name: roster.name,
      columns: roster.columns,
      people: roster.people,
      savedAt: roster.savedAt || null,
      updatedAt: roster.updatedAt || null
    } : null);
  }

  function scheduleRowLocked(project, slotId) {
    const slot = project?.data.slots.find((item) => item.id === slotId);
    return Boolean(slot?.locked || project?.data.assignments.some((assignment) => assignment.slotId === slotId && assignment.locked));
  }

  function hasLockedSchedule(project) {
    return Boolean(project?.data.slots.some((slot) => slot.locked) || project?.data.assignments.some((assignment) => assignment.locked));
  }

  function lockedScheduleWouldChange(project, version) {
    const nextSlots = Array.isArray(version?.slots) ? version.slots : [];
    const nextAssignments = Array.isArray(version?.assignments) ? version.assignments : [];
    const slotSignature = (slot) => JSON.stringify(slot ? [slot.id, slot.date, slot.startTime, slot.endTime, slot.label, slot.status, Boolean(slot.locked)] : null);
    const assignmentSignature = (assignment) => JSON.stringify(assignment ? [assignment.id, assignment.slotId, assignment.personId, assignment.roleId, Boolean(assignment.locked)] : null);
    const protectedSlotIds = new Set(project.data.slots.filter((slot) => slot.locked).map((slot) => slot.id));
    project.data.assignments.filter((assignment) => assignment.locked).forEach((assignment) => protectedSlotIds.add(assignment.slotId));
    for (const slotId of protectedSlotIds) {
      const currentSlot = project.data.slots.find((slot) => slot.id === slotId);
      const nextSlot = nextSlots.find((slot) => slot.id === slotId);
      if (slotSignature(currentSlot) !== slotSignature(nextSlot)) return true;
      const currentRow = project.data.assignments.filter((assignment) => assignment.slotId === slotId).map(assignmentSignature).sort();
      const nextRow = nextAssignments.filter((assignment) => assignment.slotId === slotId).map(assignmentSignature).sort();
      if (JSON.stringify(currentRow) !== JSON.stringify(nextRow)) return true;
    }
    return false;
  }

  function scheduleHistoryPairs(project) {
    const pairs = new Map();
    (project.data.versions || []).forEach((version) => {
      const bySlot = new Map();
      (version.assignments || []).forEach((assignment) => {
        if (!assignment.personId) return;
        if (!bySlot.has(assignment.slotId)) bySlot.set(assignment.slotId, new Set());
        bySlot.get(assignment.slotId).add(assignment.personId);
      });
      bySlot.forEach((ids) => {
        const people = [...ids].sort();
        for (let left = 0; left < people.length; left += 1) for (let right = left + 1; right < people.length; right += 1) pairs.set(`${people[left]}|${people[right]}`, [people[left], people[right]]);
      });
    });
    return [...pairs.values()];
  }

  function externalOperationSignature(project, kind) {
    return Ops.externalOperationFingerprint(project, kind, state.connections);
  }

  function externalCommitGuard({ reservation, project, kind, expectedConnections = [], conflictState }) {
    const latestConnections = latestKnownWorkspaceState().connections || [];
    return {
      token: reservation?.token || '',
      projectId: project?.id || '',
      kind,
      reservationKeys: reservation?.keys || [],
      expectedFingerprint: Ops.externalOperationFingerprint(project, kind, latestConnections),
      expectedConnections: [...new Map(expectedConnections.filter(Boolean).map((identity) => [identity.id, identity])).values()],
      conflictState
    };
  }

  function markExternalArtifactsForCommitConflict(stateInput, projectId, kind, updates, reason) {
    let next = cloneState(stateInput);
    const project = next.projects.find((item) => item.id === projectId) || Object.values(next.quickWorkspaces || {}).find((item) => item?.id === projectId);
    if (!project) return next;
    const updateKeys = new Set((updates || []).map((item, index) => scheduleArtifactKey(item, index)));
    project.data.externalArtifacts = project.data.externalArtifacts.map((artifact, index) => {
      if (artifact.kind !== kind || !updateKeys.has(scheduleArtifactKey(artifact, index)) || artifact.status === 'superseded') return artifact;
      return { ...artifact, status: 'stale', reviewReason: reason, updatedAt: artifact.updatedAt || new Date().toISOString() };
    });
    next = Core.updateProject(next, projectId, { data: { externalArtifacts: project.data.externalArtifacts } });
    const moduleId = kind === 'gmailDraft' ? 'gmailFlow' : kind;
    if (project.installedModules.includes(moduleId)) next = Core.setModuleStatus(next, projectId, moduleId, 'needsReview', reason);
    return next;
  }

  function externalOperationStateChanged(projectId, kind, baseSignature) {
    const currentProject = projectById(projectId);
    if (!currentProject || externalOperationSignature(currentProject, kind) !== baseSignature) return true;
    const deferredProject = deferredWorkspaceState?.projects?.find((item) => item.id === projectId) || Object.values(deferredWorkspaceState?.quickWorkspaces || {}).find((item) => item?.id === projectId);
    return Boolean(deferredProject && Ops.externalOperationFingerprint(deferredProject, kind, deferredWorkspaceState.connections) !== baseSignature);
  }

  function latestKnownProject(projectId) {
    const latestState = latestKnownWorkspaceState();
    return latestState.projects?.find((item) => item.id === projectId)
      || Object.values(latestState.quickWorkspaces || {}).find((item) => item?.id === projectId)
      || projectById(projectId);
  }

  function latestKnownWorkspaceState() {
    const deferredIsNewer = deferredWorkspaceState && (Number(deferredWorkspaceState._revision || 0) > Number(state._revision || 0)
      || (Number(deferredWorkspaceState._revision || 0) === Number(state._revision || 0) && String(deferredWorkspaceState.updatedAt || '') > String(state.updatedAt || '')));
    return deferredIsNewer ? deferredWorkspaceState : state;
  }

  function workspaceStateIdentity(workspaceState) {
    return { _revision: Number(workspaceState?._revision || 0), updatedAt: String(workspaceState?.updatedAt || '') };
  }

  function workspaceStateIdentityMatches(workspaceState, expectedIdentity) {
    const actual = workspaceStateIdentity(workspaceState);
    return actual._revision === Number(expectedIdentity?._revision || 0) && actual.updatedAt === String(expectedIdentity?.updatedAt || '');
  }

  function latestKnownConnection(connectionId) {
    return latestKnownWorkspaceState().connections?.find((item) => item.id === connectionId) || null;
  }

  function latestActiveExternalArtifact(project, kind, predicate = () => true) {
    return (project?.data.externalArtifacts || [])
      .filter((artifact) => artifact.kind === kind && artifact.status !== 'superseded' && predicate(artifact))
      .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0] || null;
  }

  function supersedeArtifactsForRoute(project, kind, nextConnectionId, predicate = () => true, reason = '사용 계정 변경 후 새로 생성 필요') {
    let changed = 0;
    const targetConnectionId = nextConnectionId || null;
    project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
      if (artifact.kind !== kind || artifact.status === 'superseded' || !predicate(artifact) || artifact.connectionId === targetConnectionId) return artifact;
      changed += 1;
      return {
        ...artifact,
        status: 'superseded',
        replacedAt: new Date().toISOString(),
        replacementReason: reason,
        replacementConnectionId: targetConnectionId
      };
    });
    return changed;
  }

  function retireArtifactsForConnection(connection, reason = '계정 변경 후 외부 항목 재확인 필요') {
    if (!connection) return 0;
    const artifactKind = connection.type === 'gmail' ? 'gmailDraft' : connection.type === 'zoom' ? 'zoom' : '';
    let retired = 0;
    const projectIds = [...state.projects.map((project) => project.id), ...Object.values(state.quickWorkspaces || {}).map((project) => project?.id).filter(Boolean)];
    projectIds.forEach((projectId) => {
      const project = projectById(projectId); if (!project) return;
      let projectRetired = 0;
      let linkedFormsChanged = false;
      const externalArtifacts = project.data.externalArtifacts.map((artifact) => {
        if (!artifactKind || artifact.kind !== artifactKind || artifact.connectionId !== connection.id || artifact.status === 'superseded') return artifact;
        projectRetired += 1;
        return { ...artifact, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: reason };
      });
      let forms = project.data.forms;
      if (connection.type === 'forms') {
        const linkedForms = (project.data.forms.linkedForms || []).map((linked) => {
          if (linked.connectionId !== connection.id) return linked;
          linkedFormsChanged = true;
          return { ...linked, needsReview: true, reviewReason: reason };
        });
        if (linkedFormsChanged) forms = { ...project.data.forms, linkedForms };
      }
      if (!projectRetired && !linkedFormsChanged) return;
      retired += projectRetired;
      state = Core.updateProject(state, projectId, { data: { externalArtifacts, forms } });
      const moduleId = connection.type === 'gmail' ? 'gmailFlow' : connection.type;
      if (project.installedModules.includes(moduleId)) state = Core.setModuleStatus(state, projectId, moduleId, 'needsReview', reason);
      recordScheduleMergeImpact(projectId, null, { scheduleOnly: false });
    });
    return retired;
  }

  function pendingZoomSlots(project) {
    return project.data.slots.filter((slot) => {
      const connectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
      return slot.status !== 'cancelled'
        && project.data.assignments.some((assignment) => assignment.slotId === slot.id)
        && !project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.connectionId === connectionId && item.status === 'created');
    });
  }

  function pendingGmailEntries(project) {
    const connectionId = defaultConnectionId(project, 'gmail');
    return Ops.buildMailPackage(project).entries.filter((entry) => latestActiveExternalArtifact(project, 'gmailDraft', (artifact) => artifact.personId === entry.personId && artifact.connectionId === connectionId)?.status !== 'created');
  }

  function renderSessionChangePreview(project) {
    const panel = $('#sessionChangePreview');
    if (!pendingSessionChange) { panel.hidden = true; return; }
    const { plan } = pendingSessionChange;
    const person = project.data.people.find((item) => item.id === plan.impact.personId);
    const role = project.data.roles.find((item) => item.id === plan.impact.roleId);
    const fromSlot = project.data.slots.find((item) => item.id === plan.impact.fromSlotId);
    const toSlot = project.data.slots.find((item) => item.id === plan.impact.toSlotId) || pendingSessionChange.newSlot;
    const actionLabel = plan.action === 'remove' ? '일정에서 제외' : plan.action === 'add' ? '새 일정에 추가' : '일정 이동';
    $('#sessionChangeTitle').textContent = `${person?.name || '선택한 고객'} · ${role?.name || '역할 미정'} · ${actionLabel}`;
    $('#sessionChangeSummary').textContent = plan.action === 'remove'
      ? sessionSlotLabel(fromSlot)
      : plan.action === 'add'
        ? sessionSlotLabel(toSlot)
        : `${sessionSlotLabel(fromSlot)} → ${sessionSlotLabel(toSlot)}`;
    const warningList = $('#sessionChangeWarnings'); warningList.replaceChildren();
    const affectedPeers = Math.max(0, plan.impact.affectedPersonIds.length - 1);
    const impact = element('span', 'session-impact-chip', affectedPeers ? `함께 확인할 고객 ${affectedPeers}명` : '다른 고객 영향 없음'); warningList.append(impact);
    const zoomCount = project.installedModules.includes('zoom') ? plan.impact.zoomReviewSlotIds.length : 0;
    const mailCount = project.installedModules.includes('gmailFlow') ? plan.impact.affectedPersonIds.length : 0;
    if (zoomCount || mailCount) {
      const followUps = [];
      if (zoomCount) followUps.push(`Zoom ${zoomCount}건`);
      if (mailCount) followUps.push(`안내 메일 ${mailCount}명`);
      warningList.append(element('span', 'session-impact-chip warning', `후속 확인 · ${followUps.join(' · ')}`));
    }
    [...plan.blockers.map((item) => ({ ...item, blocking: true })), ...plan.warnings].forEach((item) => warningList.append(element('span', `session-impact-chip ${item.blocking ? 'blocking' : 'warning'}`, item.message)));
    if (!plan.blockers.length && !plan.warnings.length) warningList.append(element('span', 'session-impact-chip ready', '새 충돌 없음'));
    $('#sessionApplyChange').disabled = !plan.canApply;
    $('#sessionApplyChange').textContent = plan.action === 'remove' ? '일정에서 제외' : plan.action === 'add' ? '일정 추가' : '변경 적용';
    panel.hidden = false;
  }

  function previewSessionChange(project, { personId, assignmentId = '', toSlotId = '', action = '', newSlot = null }) {
    const actualAction = action || (assignmentId && assignmentId !== 'new' ? 'move' : 'add');
    const nextAssignmentId = actualAction === 'add' ? `assignment-${Date.now().toString(36)}` : '';
    const change = { action: actualAction, assignmentId: assignmentId === 'new' ? '' : assignmentId, personId, toSlotId, roleId: sessionChangeRole(project, personId, assignmentId), nextAssignmentId };
    pendingSessionChange = { change, newSlot, baseSignature: scheduleChangeSignature(project), plan: makeSessionChangePlan(project, change, newSlot ? [newSlot] : []) };
    renderSessionPlanner(project);
  }

  function markScheduleChangeStale(project, impact, { markConfirmedSlots = true } = {}) {
    if (markConfirmedSlots) project.data.slots.filter((slot) => impact.changedSlotIds.includes(slot.id) && slot.status === 'confirmed').forEach((slot) => { slot.status = 'changed'; });
    const zoomSlots = impact.zoomReviewSlotIds || impact.changedSlotIds;
    project.data.externalArtifacts.forEach((artifact) => {
      if (artifact.kind === 'zoom' && artifact.status !== 'superseded' && zoomSlots.includes(artifact.slotId)) artifact.status = 'stale';
      if (artifact.kind === 'gmailDraft' && artifact.status !== 'superseded' && impact.affectedPersonIds.includes(artifact.personId)) artifact.status = 'stale';
    });
  }

  function markRosterDependenciesStale(project, summary = '명단 변경 후 일정 재검토 필요') {
    refreshScheduleConflicts(project);
    let gmailAffected = false;
    project.data.externalArtifacts.forEach((artifact) => {
      if (artifact.kind === 'gmailDraft' && artifact.status !== 'superseded') { artifact.status = 'stale'; gmailAffected = true; }
    });
    state = Core.updateProject(state, project.id, { data: project.data });
    if (project.data.slots.length) state = Core.setModuleStatus(state, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'stale', project.data.conflicts.length ? `명단 변경 후 문제 ${project.data.conflicts.length}건` : summary);
    if (gmailAffected && project.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', '명단 변경 후 안내 메일 확인 필요');
    recordScheduleMergeImpact(project.id, null, { scheduleOnly: false });
  }

  async function applyPendingSessionChange() {
    await flushSchedulePersist();
    const project = activeProject(); const pending = pendingSessionChange;
    if (!project || !pending) return;
    const currentSignature = scheduleChangeSignature(project);
    const refreshedPlan = makeSessionChangePlan(project, pending.change, pending.newSlot ? [pending.newSlot] : []);
    if (currentSignature !== pending.baseSignature) {
      pending.plan = refreshedPlan; pending.baseSignature = currentSignature;
      renderSessionPlanner(project); showToast('다른 변경사항을 반영해 미리보기를 새로 계산했습니다. 다시 확인해주세요.'); return;
    }
    pending.plan = refreshedPlan;
    if (!pending.plan.canApply) return;
    pushScheduleHistory(project);
    if (pending.newSlot && !project.data.slots.some((slot) => slot.id === pending.newSlot.id)) project.data.slots.push(pending.newSlot);
    project.data.assignments = pending.plan.nextAssignments;
    markScheduleChangeStale(project, pending.plan.impact);
    refreshScheduleConflicts(project);
    syncScheduleProjectState(project, `${project.data.slots.length}개 일정 · 변경 내용 확인`, pending.plan.impact);
    const action = pending.plan.action;
    selectedSessionPersonId = pending.plan.impact.personId;
    selectedSessionAssignmentId = action === 'remove' ? null : pending.change.nextAssignmentId || pending.plan.impact.assignmentId;
    pendingSessionChange = null;
    await persist(action === 'remove' ? '고객 일정 제외됨' : action === 'add' ? '고객 일정 추가됨' : '고객 일정 변경됨');
    renderSchedulePage();
    showToast(action === 'remove' ? '고객을 일정에서 제외했습니다.' : action === 'add' ? '고객 일정을 추가했습니다.' : '고객 일정을 변경했습니다.', 'success');
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
    const selectedPerson = project.data.people.find((person) => person.id === selectedSessionPersonId && person.active !== false) || null;
    const selectedAssignments = selectedPerson ? project.data.assignments.filter((assignment) => assignment.personId === selectedPerson.id).sort((a, b) => Ops.slotKey(project.data.slots.find((slot) => slot.id === a.slotId) || {}).localeCompare(Ops.slotKey(project.data.slots.find((slot) => slot.id === b.slotId) || {}))) : [];
    if (!selectedPerson) { selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null; }
    else if (selectedSessionAssignmentId !== 'new' && !selectedAssignments.some((assignment) => assignment.id === selectedSessionAssignmentId)) selectedSessionAssignmentId = selectedAssignments.length === 0 ? 'new' : selectedAssignments.length === 1 ? selectedAssignments[0].id : null;
    pool.replaceChildren(...(people.length ? people.map((person) => {
      const count = project.data.assignments.filter((assignment) => assignment.personId === person.id).length;
      const chip = element('button', `session-person-chip${selectedSessionPersonId === person.id ? ' selected' : ''}`); chip.type = 'button'; chip.draggable = true; chip.dataset.sessionPerson = person.id; chip.title = count ? '고객을 선택해 현재 일정을 변경' : '고객을 선택해 새 일정에 배정';
      chip.append(element('strong', '', person.name || '이름 없음'), element('small', '', `${person.group || person.email || '분류 없음'} · ${count ? `일정 ${count}개` : '미배정'}`)); return chip;
    }) : [element('div', 'list-empty', '검색 조건에 맞는 고객이 없습니다.')]));

    const selectedPanel = $('#sessionSelectedPersonPanel'); selectedPanel.replaceChildren();
    if (selectedPerson) {
      const heading = element('div', 'session-selected-heading'); const copy = element('span'); copy.append(element('small', '', '선택한 고객'), element('strong', '', selectedPerson.name || '이름 없음'));
      const clear = element('button', 'text-button', '선택 해제'); clear.type = 'button'; clear.dataset.sessionClearPerson = 'true'; heading.append(copy, clear); selectedPanel.append(heading);
      const current = element('div', 'session-current-options');
      selectedAssignments.forEach((assignment) => { const slot = project.data.slots.find((item) => item.id === assignment.slotId); const role = project.data.roles.find((item) => item.id === assignment.roleId); const label = `${sessionSlotLabel(slot)} · ${role?.name || assignment.roleName || '역할 미정'}`; const button = element('button', selectedSessionAssignmentId === assignment.id ? 'selected' : '', label); button.type = 'button'; button.dataset.sessionOriginAssignment = assignment.id; button.title = label; current.append(button); });
      const add = element('button', selectedSessionAssignmentId === 'new' ? 'selected add' : 'add', '＋ 새 일정 추가'); add.type = 'button'; add.dataset.sessionOriginNew = 'true'; current.append(add); selectedPanel.append(current);
      selectedPanel.append(element('p', 'session-selection-help', selectedSessionAssignmentId === 'new' ? '추가할 일정을 캘린더에서 선택하세요.' : selectedSessionAssignmentId ? '옮길 일정을 캘린더에서 선택하세요.' : '변경할 현재 일정을 먼저 선택하세요.'));
      selectedPanel.hidden = false; $('#sessionTargetLegend').hidden = false;
    } else { selectedPanel.hidden = true; $('#sessionTargetLegend').hidden = true; }
    const visibleDate = dateSelect.value; const slots = project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).filter((slot) => !visibleDate || slot.date === visibleDate);
    const byDate = new Map(); slots.forEach((slot) => { if (!byDate.has(slot.date || '날짜 미정')) byDate.set(slot.date || '날짜 미정', []); byDate.get(slot.date || '날짜 미정').push(slot); });
    const board = $('#sessionCalendarBoard'); const columns = [...byDate.entries()].map(([date, dateSlots]) => {
      const column = element('section', 'session-date-column'); column.append(element('h3', '', date === '날짜 미정' ? date : formatDate(date)));
      dateSlots.forEach((slot) => {
        const card = element('article', `session-slot-card status-${slot.status || 'draft'}`); card.dataset.sessionSlot = slot.id; card.tabIndex = 0; card.title = sessionSlotLabel(slot);
        if (pendingSessionChange?.plan.impact.toSlotId === slot.id) card.classList.add('is-pending-target');
        if (selectedPerson && selectedSessionAssignmentId) {
          const currentAssignment = selectedAssignments.find((assignment) => assignment.id === selectedSessionAssignmentId);
          if (currentAssignment?.slotId === slot.id) card.classList.add('is-current');
          else {
            const change = { action: selectedSessionAssignmentId === 'new' ? 'add' : 'move', assignmentId: selectedSessionAssignmentId === 'new' ? '' : selectedSessionAssignmentId, personId: selectedPerson.id, toSlotId: slot.id, roleId: sessionChangeRole(project, selectedPerson.id, selectedSessionAssignmentId) };
            const candidate = makeSessionChangePlan(project, change);
            card.classList.add(!candidate.canApply ? 'is-blocked-target' : candidate.warnings.length ? 'is-warning-target' : 'is-ready-target');
          }
        }
        const heading = element('div', 'session-slot-heading'); const title = element('span'); title.append(element('strong', '', `${slot.startTime || '--:--'}–${slot.endTime || '--:--'}`), element('small', '', slot.label || '이름 없는 세션'));
        const rowLocked = scheduleRowLocked(project, slot.id); const actions = element('span', 'session-slot-actions'); const edit = element('button', '', '시간 변경'); edit.type = 'button'; edit.dataset.sessionEdit = slot.id; edit.disabled = rowLocked; edit.title = rowLocked ? '잠금을 해제한 뒤 변경할 수 있습니다.' : '세션 시간 변경'; const remove = element('button', '', '×'); remove.type = 'button'; remove.dataset.sessionRemove = slot.id; remove.disabled = rowLocked; remove.title = rowLocked ? '잠금을 해제한 뒤 삭제할 수 있습니다.' : '세션 삭제'; actions.append(edit, remove); heading.append(title, actions); card.append(heading);
        const assignments = element('div', 'session-assignments');
        project.data.assignments.filter((assignment) => assignment.slotId === slot.id).forEach((assignment) => { const person = project.data.people.find((item) => item.id === assignment.personId); if (!person || person.active === false) return; const chip = element('div', `session-assignment-chip${selectedSessionPersonId === person.id ? ' selected-person' : ''}${selectedSessionAssignmentId === assignment.id ? ' selected-assignment' : ''}`); chip.draggable = !(assignment.locked || slot.locked); chip.tabIndex = 0; chip.setAttribute('role', 'button'); chip.dataset.sessionAssignment = assignment.id; chip.dataset.sessionPerson = person.id; chip.append(element('span', '', `${person.name || '이름 없음'} · ${project.data.roles.find((role) => role.id === assignment.roleId)?.name || assignment.roleName || '참여'}`)); const eject = element('button', '', '×'); eject.type = 'button'; eject.dataset.sessionUnassign = assignment.id; eject.disabled = Boolean(assignment.locked || slot.locked); eject.title = eject.disabled ? '잠금을 해제한 뒤 일정에서 뺄 수 있습니다.' : '이 세션에서 빼기'; chip.append(eject); assignments.append(chip); });
        if (!assignments.children.length) assignments.append(element('div', 'session-drop-hint', '인원을 여기에 놓으세요'));
        card.append(assignments); column.append(card);
      }); return column;
    });
    const emptyDrop = element('button', 'session-empty-drop'); emptyDrop.type = 'button'; emptyDrop.dataset.sessionEmptyDrop = 'true'; emptyDrop.title = '고객을 끌어 놓거나 클릭하면 새 날짜와 시간을 입력합니다.'; emptyDrop.append(element('strong', '', '＋ 새 시간 만들기'), element('small', '', '끌어 놓기 또는 클릭'));
    board.replaceChildren(...columns, emptyDrop);
    $('#sessionBoardStatus').textContent = selectedPerson ? `${selectedPerson.name || '선택한 고객'} · 현재 일정 ${selectedAssignments.length}개 · ${visibleDate ? `${formatDate(visibleDate)} 보기` : '전체 날짜 보기'}` : `${people.length}명 · 고객을 선택하면 현재 일정과 이동 후보가 표시됩니다.`;
    renderSessionChangePreview(project);
  }

  async function requestSessionSlot(defaultValue = '') {
    const project = activeProject(); const startTime = '09:00'; const endTime = Ops.addMinutesToTime(startTime, project?.settings?.sessionDurationMinutes);
    const value = await requestName('새 세션 날짜·시간', defaultValue || `${new Date().toISOString().slice(0, 10)} ${startTime}-${endTime} 새 세션`); if (!value) return null;
    const parsed = Ops.parseSlots(value); if (!parsed.slots.length) { showToast(parsed.errors[0] || '예: 2026-08-20 09:00-10:00 필기 교육', 'error'); return null; }
    return parsed.slots[0];
  }

  async function addSessionFromText(defaultValue = '') {
    await flushSchedulePersist(); let project = activeProject(); if (!project) return null; const projectId = project.id; const slot = await requestSessionSlot(defaultValue); if (!slot) return null;
    project = projectById(projectId); if (!project) { showToast('일정을 반영할 프로젝트를 찾지 못했습니다.', 'error'); return null; }
    pushScheduleHistory(project); project.data.slots.push(slot); refreshScheduleConflicts(project); syncScheduleProjectState(project, `새 세션 추가 · 문제 ${project.data.conflicts.length}건`); await persist('새 세션 추가됨'); renderSchedulePage(); return slot;
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
    const setup = $('#scheduleSetupDetails'); const hasAssignments = project.data.assignments.length > 0; const setupState = hasAssignments ? 'ready' : 'empty';
    if (setup.dataset.projectId !== project.id) setup.open = !hasAssignments;
    else if (setup.dataset.scheduleState === 'empty' && hasAssignments) setup.open = false;
    else if (!hasAssignments) setup.open = true;
    setup.dataset.projectId = project.id; setup.dataset.scheduleState = setupState;
    const generateButton = $('#generateScheduleButton'); generateButton.textContent = hasAssignments ? '전체 일정 다시 만들기' : '조건에 맞춰 일정표 만들기'; generateButton.className = hasAssignments ? 'secondary-button' : 'primary-button';
    const schedulePeople = project.data.people.filter((person) => person.active !== false);
    $('#scheduleProjectRosterStatus').textContent = schedulePeople.length ? `${schedulePeople[0].name || '첫 번째 사람'}${schedulePeople.length > 1 ? ` 외 ${schedulePeople.length - 1}명` : ''}이 배정 후보로 연결되어 있습니다.` : '명단 가져오기를 눌러 배정할 사람을 준비해주세요.';
    const rosterSelect = $('#scheduleRosterSelect'); const selectedRosterId = rosterSelect.value;
    rosterSelect.replaceChildren(element('option', '', state.library.rosters.length ? '저장한 명단 선택' : '저장한 명단 없음'));
    state.library.rosters.forEach((roster) => { const option = element('option', '', `${roster.name} · ${(roster.people || []).filter((person) => person.active !== false).length}명`); option.value = roster.id; rosterSelect.append(option); });
    if (state.library.rosters.some((roster) => roster.id === selectedRosterId)) rosterSelect.value = selectedRosterId;
    rosterSelect.disabled = state.library.rosters.length === 0; $('#scheduleMergeRoster').disabled = state.library.rosters.length === 0;
  }

  function scheduleHeaderKey(value, project) {
    const text = String(value || '').trim(); const normalized = text.toLowerCase().replace(/[\s_.·-]/g, '');
    const aliases = {
      날짜: 'date', date: 'date', 일자: 'date', 시작: 'startTime', 시작시간: 'startTime', start: 'startTime', starttime: 'startTime',
      종료: 'endTime', 종료시간: 'endTime', end: 'endTime', endtime: 'endTime', 세션: 'label', 세션명: 'label', 일정: 'label', 일정명: 'label', title: 'label',
      상태: 'status', status: 'status', 잠금: 'locked', lock: 'locked', locked: 'locked'
    };
    if (aliases[normalized]) return aliases[normalized];
    const role = project.data.roles.find((item) => item.name.toLowerCase().replace(/[\s_.·-]/g, '') === normalized);
    if (role) return `role:${role.id}`;
    const activeRoles = project.data.roles.filter((item) => item.active !== false);
    const genericAssignmentHeaders = new Set(['참여자', '참가자', '배정자', '배정인원', '배정대상', '고객', '고객명', '대상자', '수강생', '이름', 'participant', 'participants', 'attendee', 'attendees', 'member', 'members']);
    return activeRoles.length === 1 && genericAssignmentHeaders.has(normalized) ? `role:${activeRoles[0].id}` : '';
  }

  function applyScheduleColumnName(project, column, value) {
    const cleanName = String(value || '').trim().replace(/[{}]/g, '');
    if (!project || !column || !cleanName) return false;
    ensureScheduleSheetInitialized(project);
    column = project.data.scheduleSheetColumns.find((item) => item.id === column.id) || column;
    const before = `${column.name}|${column.key}|${column.kind}|${column.roleId || ''}`;
    column.name = cleanName;
    if (column.kind === 'custom') {
      let key = scheduleHeaderKey(cleanName, project);
      if (project.data.scheduleSheetColumns.some((item) => item.id !== column.id && item.key === key)) key = '';
      if (key) {
        column.key = key;
        column.roleId = key.startsWith('role:') ? key.slice(5) : null;
        column.kind = column.roleId ? 'role' : 'system';
      }
    }
    if (`${column.name}|${column.key}|${column.kind}|${column.roleId || ''}` !== before) scheduleEditGeneration += 1;
    return true;
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
    let project = activeProject(); if (!project || !matrix?.length) return; const projectId = project.id; const confirmationSnapshot = scheduleSnapshot(project);
    const hasHeader = looksLikeScheduleHeader(matrix); const importedColumns = inferredScheduleColumns(matrix, project, hasHeader);
    if (mode === 'replace' && hasLockedSchedule(project)) { showToast('잠긴 세션 또는 배정이 있습니다. 잠금을 해제한 뒤 일정표를 교체해주세요.', 'error'); return; }
    if (mode === 'replace' && project.data.slots.length) {
      if (!await showConfirm('현재 일정표를 Excel 시트 내용으로 교체할까요? 기존 상태는 실행 취소로 되돌릴 수 있습니다.', { title: '일정표 교체', action: '교체' })) return;
      const currentProject = activeProject();
      if (!currentProject || currentProject.id !== projectId || scheduleSnapshot(currentProject) !== confirmationSnapshot) { showToast('확인하는 동안 일정이 바뀌었습니다. 최신 일정을 확인한 뒤 다시 가져와주세요.', 'error'); renderSchedulePage(); return; }
      project = currentProject;
      if (hasLockedSchedule(project)) { showToast('새로 잠긴 세션 또는 배정이 있어 일정표 교체를 중단했습니다.', 'error'); return; }
    }
    const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project));
    pushScheduleHistory(project);
    if (mode === 'replace') { project.data.slots = []; project.data.assignments = []; project.data.conflicts = []; project.data.scheduleCustomValues = {}; project.data.scheduleSheetColumns = importedColumns; project.data.scheduleSheetInitialized = true; }
    else {
      ensureScheduleSheetInitialized(project);
      const current = scheduleSheetColumns(project); importedColumns.forEach((column) => { if (!current.some((item) => item.key === column.key || item.name.toLowerCase() === column.name.toLowerCase())) project.data.scheduleSheetColumns.push(column); });
    }
    const rows = (hasHeader ? matrix.slice(1) : matrix).filter((row) => row.some((value) => String(value || '').trim())); const targetColumns = scheduleSheetColumns(project); const mappedIndexes = importedColumns.map((column) => targetColumns.findIndex((item) => item.key === column.key || item.name.toLowerCase() === column.name.toLowerCase()));
    const startRow = project.data.slots.length;
    rows.forEach((row, rowOffset) => {
      row.map((value, columnIndex) => ({ value, columnIndex, actualColumn: mappedIndexes[columnIndex] })).sort((left, right) => Number(targetColumns[left.actualColumn]?.key === 'locked') - Number(targetColumns[right.actualColumn]?.key === 'locked')).forEach(({ value, actualColumn }) => {
        if (actualColumn >= 0) setScheduleCellValue(project, startRow + rowOffset, actualColumn, value);
      });
    });
    refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `Excel 일정 가져오기 · 문제 ${project.data.conflicts.length}건`, impact); renderAll(); navigate('schedule'); await persist('Excel 일정 가져옴');
    showToast(`${importedColumns.length}열 × ${rows.length}행을 자동 감지해 일정표에 가져왔습니다.`, project.data.conflicts.length ? 'normal' : 'success');
  }

  async function addScheduleColumn() {
    let project = activeProject(); if (!project) return; project = await persistScheduleSheetInitialization(project); if (!project) return; const projectId = project.id; const confirmationSnapshot = scheduleSnapshot(project); const name = await requestName('추가할 일정표 컬럼 이름', `새 컬럼 ${scheduleSheetColumns(project).length + 1}`); if (!name?.trim()) return;
    project = projectById(projectId); if (!project || scheduleSnapshot(project) !== confirmationSnapshot) { showToast('다른 창의 일정표 변경을 반영했습니다. 컬럼 추가를 다시 시도해주세요.'); renderSchedulePage(); return; }
    pushScheduleHistory(project); const id = `schedule-column-${Date.now().toString(36)}`; const cleanName = name.trim().replace(/[{}]/g, ''); let key = scheduleHeaderKey(cleanName, project); if (project.data.scheduleSheetColumns.some((column) => column.key === key)) key = ''; const roleId = key.startsWith('role:') ? key.slice(5) : null; project.data.scheduleSheetColumns.push({ id, key: key || `custom:${id}`, name: cleanName, kind: roleId ? 'role' : key ? 'system' : 'custom', roleId }); refreshScheduleConflicts(project);
    syncScheduleProjectState(project, `일정 컬럼 추가 · 문제 ${project.data.conflicts.length}건`); await persist('일정 컬럼 추가됨'); renderSchedulePage();
  }

  async function renameScheduleColumn(columnId) {
    let project = activeProject(); if (!project) return; project = await persistScheduleSheetInitialization(project); let column = project?.data.scheduleSheetColumns.find((item) => item.id === columnId); if (!column) return; const projectId = project.id; const confirmationSnapshot = scheduleSnapshot(project); const name = await requestName('일정표 컬럼 이름 변경', column.name); if (!name?.trim()) return;
    project = projectById(projectId); column = project?.data.scheduleSheetColumns.find((item) => item.id === columnId); if (!column || scheduleSnapshot(project) !== confirmationSnapshot) { showToast('다른 창의 일정표 변경을 반영했습니다. 컬럼 이름 변경을 다시 시도해주세요.'); renderSchedulePage(); return; }
    pushScheduleHistory(project); applyScheduleColumnName(project, column, name); refreshScheduleConflicts(project); syncScheduleProjectState(project, `일정 컬럼 이름 변경 · 문제 ${project.data.conflicts.length}건`); await persist('일정 컬럼 이름 변경됨'); renderSchedulePage();
  }

  async function removeScheduleColumn(columnId) {
    let project = activeProject(); if (!project) return; project = await persistScheduleSheetInitialization(project); let column = project?.data.scheduleSheetColumns.find((item) => item.id === columnId); if (!column) return; const projectId = project.id; const confirmationSnapshot = scheduleSnapshot(project);
    if (!await showConfirm(`“${column.name}” 컬럼을 표에서 삭제할까요?${column.kind === 'custom' ? ' 이 컬럼의 셀 값도 삭제됩니다.' : ' 연결된 원본 일정 데이터는 유지됩니다.'}`, { title: '일정표 컬럼 삭제', action: '삭제' })) return;
    project = projectById(projectId); column = project?.data.scheduleSheetColumns.find((item) => item.id === columnId); if (!column || scheduleSnapshot(project) !== confirmationSnapshot) { showToast('다른 창의 일정표 변경을 반영했습니다. 컬럼 삭제를 다시 시도해주세요.'); renderSchedulePage(); return; }
    pushScheduleHistory(project); project.data.scheduleSheetColumns = project.data.scheduleSheetColumns.filter((item) => item.id !== columnId);
    if (column.kind === 'custom') Object.values(project.data.scheduleCustomValues || {}).forEach((values) => { delete values[column.id]; });
    refreshScheduleConflicts(project); scheduleSelection = null; syncScheduleProjectState(project, `일정 컬럼 삭제 · 문제 ${project.data.conflicts.length}건`); await persist('일정 컬럼 삭제됨'); renderSchedulePage();
  }

  async function insertScheduleRow(afterIndex = null) {
    const project = activeProject(); if (!project) return; pushScheduleHistory(project); const index = afterIndex == null ? project.data.slots.length : Math.min(project.data.slots.length, Number(afterIndex) + 1);
    const slot = { id: `slot-${Date.now().toString(36)}-${index}`, date: '', startTime: '', endTime: '', label: '', status: 'draft', locked: false }; project.data.slots.splice(index, 0, slot); refreshScheduleConflicts(project);
    syncScheduleProjectState(project, `일정 행 추가 · 문제 ${project.data.conflicts.length}건`); await persist('일정 행 추가됨'); renderSchedulePage(); focusScheduleCell(index, 0);
  }

  async function mergeScheduleRoster(rosterId) {
    await flushSchedulePersist();
    const project = activeProject(); const roster = state.library.rosters.find((item) => item.id === rosterId); if (!project || !roster) { showToast('추가할 전역 저장 명단을 선택해주세요.', 'error'); return; }
    let rosterColumnsChanged = false;
    const columnMap = new Map(); (roster.columns || []).forEach((sourceColumn) => {
      const sourceName = String(sourceColumn.name || '').trim().toLowerCase();
      const sourceType = sourceColumn.type || sourceColumn.workspaceType || (sourceColumn.role === 'email' ? 'email' : 'text');
      let target = project.data.columns.find((column) => String(column.name || '').trim().toLowerCase() === sourceName && (column.type || 'text') === sourceType);
      if (!target && sourceType !== 'text') target = project.data.columns.find((column) => column.type === sourceType);
      if (!target) {
        target = { ...JSON.parse(JSON.stringify(sourceColumn)), id: `column-${Date.now().toString(36)}-${project.data.columns.length}`, type: sourceType };
        project.data.columns.push(target); project.data.people.forEach((person) => { person.values ||= {}; person.values[target.id] = ''; });
        rosterColumnsChanged = true;
      }
      columnMap.set(sourceColumn.id, target.id);
    });
    const emails = new Map(); const phones = new Map(); const names = new Map();
    const identity = (person) => ({
      email: String(person?.email || '').trim().toLowerCase(),
      phone: String(person?.phone || '').replace(/\D/g, ''),
      name: String(person?.name || '').trim().toLowerCase().replace(/\s+/g, ' ')
    });
    const remember = (person) => {
      const value = identity(person);
      if (value.email && !emails.has(value.email)) emails.set(value.email, person);
      if (value.phone && !phones.has(value.phone)) phones.set(value.phone, person);
      if (value.name && !names.has(value.name)) names.set(value.name, person);
    };
    project.data.people.filter((person) => person.active !== false).forEach(remember);
    const scheduleView = project.data.rosterViews.find((view) => view.id === project.data.scheduleRules.rosterViewId) || null;
    const scheduleViewIds = new Set(scheduleView?.personIds || []); let scheduleViewChanged = false; let linkedExisting = 0;
    const includeInScheduleView = (person, existing = false) => {
      if (!scheduleView || !person || person.active === false) return;
      const wasIncluded = scheduleViewIds.has(person.id) && !(scheduleView.excludedPersonIds || []).includes(person.id);
      if (!scheduleViewIds.has(person.id)) { scheduleView.personIds.push(person.id); scheduleViewIds.add(person.id); scheduleViewChanged = true; }
      const nextExcluded = (scheduleView.excludedPersonIds || []).filter((id) => id !== person.id);
      if (nextExcluded.length !== (scheduleView.excludedPersonIds || []).length) { scheduleView.excludedPersonIds = nextExcluded; scheduleViewChanged = true; }
      if (existing && !wasIncluded) linkedExisting += 1;
    };
    let added = 0;
    (roster.people || []).filter((source) => source.active !== false).forEach((source) => {
      const value = identity(source);
      const duplicate = (value.email && emails.get(value.email)) || (value.phone && phones.get(value.phone)) || (!value.email && !value.phone && value.name && names.get(value.name)) || null;
      if (duplicate) { includeInScheduleView(duplicate, true); return; }
      const person = JSON.parse(JSON.stringify(source)); person.id = `person-${Date.now().toString(36)}-${added}`; person.sourceOrder = project.data.people.length; person.active = true; person.values = Object.fromEntries(project.data.columns.map((column) => [column.id, '']));
      Object.entries(source.values || {}).forEach(([sourceId, cellValue]) => { const targetId = columnMap.get(sourceId); if (targetId) person.values[targetId] = cellValue; });
      if (!person.roleIds?.length || !person.roleIds.some((id) => project.data.roles.some((role) => role.id === id))) person.roleIds = [project.data.roles[0]?.id || 'participant'];
      project.data.people.push(person); remember(person); includeInScheduleView(person); added += 1;
    });
    if (scheduleViewChanged) scheduleView.updatedAt = new Date().toISOString();
    syncPersonDerivedFields(project);
    if (added || scheduleViewChanged || rosterColumnsChanged) clearRosterHistory();
    markRosterDependenciesStale(project, '저장 명단 추가 후 일정 재검토 필요'); await persist('전역 명단 배정 후보 추가됨'); renderAll(); navigate('schedule');
    const linkedMessage = linkedExisting ? ` 기존 ${linkedExisting}명도 선택한 단계 명단에 포함했습니다.` : '';
    showToast(`${roster.name}에서 중복을 제외한 ${added}명을 배정 후보에 추가했습니다.${linkedMessage}`, 'success');
  }

  async function deleteSelectedScheduleRows() {
    const project = activeProject(); if (!project || !scheduleSelection) return;
    if (['column', 'all'].includes(scheduleSelection.mode)) { showToast('행 번호를 선택한 뒤 행 삭제를 눌러주세요. 컬럼은 제목 오른쪽 ×로 삭제합니다.', 'error'); return; }
    const min = Math.max(0, Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row)); const max = Math.max(scheduleSelection.anchor.row, scheduleSelection.focus.row);
    const targets = project.data.slots.slice(min, max + 1);
    if (!targets.length) return; if (targets.some((slot) => scheduleRowLocked(project, slot.id))) { showToast('잠긴 행 또는 배정이 포함되어 있습니다. 잠금을 해제한 뒤 삭제해주세요.', 'error'); return; }
    const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); pushScheduleHistory(project); const ids = new Set(targets.map((slot) => slot.id)); project.data.slots = project.data.slots.filter((slot) => !ids.has(slot.id)); project.data.assignments = project.data.assignments.filter((item) => !ids.has(item.slotId));
    Object.keys(project.data.availability).forEach((personId) => { project.data.availability[personId] = project.data.availability[personId].filter((id) => !ids.has(id)); });
    refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, beforeSnapshot); scheduleSelection = null; syncScheduleProjectState(project, `일정 행 삭제 · 문제 ${project.data.conflicts.length}건`, impact); renderSchedulePage(); await persist('일정 행 삭제됨');
  }

  function scheduleClipboardHtml(matrix) {
    const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</table>`;
  }

  function shouldUseNativeScheduleClipboard(event) {
    if (event.target.closest?.('[contenteditable="true"]')) return true;
    const input = event.target.closest?.('input, textarea'); if (!input) return false;
    if (!input.matches('[data-schedule-input]')) return true;
    const rangeSelected = scheduleSelection && (scheduleSelection.mode !== 'cells' || scheduleSelection.anchor.row !== scheduleSelection.focus.row || scheduleSelection.anchor.col !== scheduleSelection.focus.col);
    if (rangeSelected) return false;
    return typeof input.selectionStart === 'number' && input.selectionStart !== input.selectionEnd;
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
    const table = $('#outputPreviewTable'); const output = Ops.scheduleOutputTable(project);
    const head = element('tr'); output.headers.forEach((label) => head.append(element('th', '', label))); table.tHead.replaceChildren(head);
    table.tBodies[0].replaceChildren(...output.rows.map((values) => { const row = element('tr'); values.forEach((value) => row.append(element('td', '', value))); return row; }));
  }

  function selectedLinkedForm(project) {
    const linkedForms = project?.data.forms?.linkedForms || [];
    return linkedForms.find((item) => item.formId === project.data.forms.selectedFormId) || linkedForms.at(-1) || null;
  }

  function renderFormsPage() {
    const project = activeProject(); if (!project) { navigate('dashboard'); return; }
    const linkedForms = project.data.forms.linkedForms || [];
    const selectedLinked = selectedLinkedForm(project);
    const linkedSelect = $('#linkedFormSelect');
    linkedSelect.replaceChildren();
    if (!linkedForms.length) linkedSelect.append(element('option', '', '연결된 설문 없음'));
    linkedForms.forEach((linked, index) => {
      const option = element('option', '', linked.title || `${linked.type === 'availability' ? '가능 시간 조사' : '신청자 정보'} ${index + 1} · ${linked.formId}`);
      option.value = linked.formId; option.selected = linked.formId === selectedLinked?.formId; linkedSelect.append(option);
    });
    linkedSelect.disabled = !linkedForms.length;
    $('#syncFormResponses').disabled = !selectedLinked;
    $('#removeLinkedForm').disabled = !selectedLinked;
    if (!selectedLinked) $('#linkedFormStatus').textContent = '연결한 설문의 응답을 가져오면 명단이나 사람별 가능 시간에 반영됩니다.';
    else {
      const connection = state.connections.find((item) => item.id === selectedLinked.connectionId);
      const details = [selectedLinked.type === 'availability' ? '가능 시간 조사' : '신청자 정보'];
      if (connection) details.push(`${connection.label}${connection.account ? ` · ${connection.account}` : ''}`);
      if (Number.isFinite(Number(selectedLinked.responseCount))) details.push(`마지막 응답 ${Number(selectedLinked.responseCount)}건`);
      if (selectedLinked.lastSyncedAt) details.push(`동기화 ${formatUpdatedAt(selectedLinked.lastSyncedAt)}`);
      if (selectedLinked.needsReview) details.push('확인 필요');
      $('#linkedFormStatus').textContent = details.join(' · ');
    }
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
      const slotConnectionId = slot.zoomConnectionId || defaultId;
      const artifact = latestActiveExternalArtifact(project, 'zoom', (item) => item.slotId === slot.id && item.connectionId === slotConnectionId);
      const replacedArtifact = project.data.externalArtifacts.slice().reverse().find((item) => item.kind === 'zoom' && item.slotId === slot.id && (item.status === 'superseded' || item.connectionId !== slotConnectionId));
      const needsCleanup = Boolean(artifact && artifact.status !== 'superseded' && (artifact.status === 'stale' || slot.status === 'cancelled')); const status = element('td', '', needsCleanup ? '기존 회의 정리 필요' : artifact?.status === 'created' ? '만들기 완료' : '아직 만들지 않음');
      if (!artifact && replacedArtifact) status.textContent = '선택한 계정으로 다시 만들기 필요';
      if (needsCleanup && artifact.externalId) { const resolved = element('button', 'text-button', '정리 완료 표시'); resolved.type = 'button'; resolved.dataset.zoomArtifactResolved = artifact.externalId; status.append(document.createTextNode(' '), resolved); }
      row.append(status, element('td', '', artifact?.joinUrl || ''));
      return row;
    });
    const liveSlotIds = new Set(project.data.slots.map((slot) => slot.id));
    project.data.externalArtifacts.filter((artifact) => artifact.kind === 'zoom' && artifact.status === 'stale' && !liveSlotIds.has(artifact.slotId)).forEach((artifact) => {
      const row = element('tr', 'zoom-orphan-row'); row.append(element('td', '', '삭제된 일정'), element('td', '', '—'), element('td', '', '이전 Zoom 회의'), element('td', '', '—'));
      const status = element('td', '', '기존 회의 정리 필요'); if (artifact.externalId) { const resolved = element('button', 'text-button', '정리 완료 표시'); resolved.type = 'button'; resolved.dataset.zoomArtifactResolved = artifact.externalId; status.append(document.createTextNode(' '), resolved); } row.append(status, element('td', '', artifact.joinUrl || '')); rows.push(row);
    });
    table.tBodies[0].replaceChildren(...rows);
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
    if (targetId === 'people') { if (standaloneProgram) await openRosterManager(); else navigate('people'); return; }
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

  function hideTemplateAutocomplete() {
    templateAutocompleteState = null;
    const menu = $('#templateVariableAutocomplete');
    if (!menu) return;
    menu.hidden = true; menu.replaceChildren();
  }

  function inputCaretPosition(target, caret) {
    const rect = target.getBoundingClientRect(); const style = getComputedStyle(target); const mirror = document.createElement('div');
    ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'wordSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'].forEach((property) => { mirror.style[property] = style[property]; });
    Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'pre', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
    mirror.textContent = target.value.slice(0, caret); const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker); document.body.append(mirror);
    const markerRect = marker.getBoundingClientRect(); const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.35;
    const point = { left: markerRect.left - target.scrollLeft, top: markerRect.top + lineHeight + 3 }; mirror.remove(); return point;
  }

  function templateAutocompleteContext(target) {
    if (target.matches('input, textarea')) {
      const caret = target.selectionStart ?? target.value.length; if ((target.selectionEnd ?? caret) !== caret) return null;
      const match = target.value.slice(0, caret).match(/\{([^{}\r\n]*)$/); if (!match) return null;
      return { query: match[1], matchLength: match[0].length, caret, point: inputCaretPosition(target, caret) };
    }
    const selection = getSelection(); if (!selection?.rangeCount || !target.contains(selection.anchorNode) || !selection.isCollapsed) return null;
    const caretRange = selection.getRangeAt(0).cloneRange(); const before = caretRange.cloneRange(); before.selectNodeContents(target); before.setEnd(caretRange.endContainer, caretRange.endOffset);
    const match = before.toString().match(/\{([^{}\r\n]*)$/); if (!match) return null;
    const rect = caretRange.getBoundingClientRect(); const editorRect = target.getBoundingClientRect(); const lineHeight = Number.parseFloat(getComputedStyle(target).lineHeight) || 20;
    return { query: match[1], matchLength: match[0].length, range: caretRange, point: { left: rect.left || editorRect.left + 8, top: (rect.bottom || editorRect.top + lineHeight) + 3 } };
  }

  function renderTemplateAutocomplete(target) {
    const menu = $('#templateVariableAutocomplete'); const project = activeProject(); if (!menu || !project) return;
    const context = templateAutocompleteContext(target); if (!context) { hideTemplateAutocomplete(); return; }
    const query = context.query.trim().toLocaleLowerCase('ko-KR'); const available = templateVariableNames(project);
    const starts = available.filter((name) => name.toLocaleLowerCase('ko-KR').startsWith(query));
    const items = [...starts, ...available.filter((name) => !starts.includes(name) && name.toLocaleLowerCase('ko-KR').includes(query))];
    templateAutocompleteState = { ...context, target, items, index: 0 };
    if (items.length) menu.replaceChildren(...items.map((name, index) => {
      const button = element('button'); button.type = 'button'; button.dataset.templateAutocomplete = name; button.role = 'option'; button.classList.toggle('active', index === 0); button.setAttribute('aria-selected', String(index === 0));
      button.append(element('span', '', `{${name}}`), element('small', '', index === 0 ? 'Enter' : '선택')); return button;
    }));
    else menu.replaceChildren(element('div', 'variable-autocomplete-empty', '일치하는 명단 컬럼이 없습니다.'));
    menu.hidden = false; const width = Math.min(360, Math.max(190, menu.offsetWidth));
    menu.style.left = `${Math.max(8, Math.min(context.point.left, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(context.point.top, innerHeight - Math.min(menu.scrollHeight, 220) - 8))}px`;
  }

  function applyTemplateAutocomplete(name) {
    const current = templateAutocompleteState; if (!current) return; const target = current.target;
    target.focus();
    if (target.matches('input, textarea')) {
      const end = target.selectionEnd ?? current.caret; target.setRangeText(`{${name}}`, end - current.matchLength, end, 'end');
    } else {
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(current.range); selection.modify('extend', 'backward', 'character');
      for (let index = 1; index < current.matchLength; index += 1) selection.modify('extend', 'backward', 'character');
      document.execCommand('insertText', false, `{${name}}`);
    }
    hideTemplateAutocomplete(); target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function moveTemplateAutocomplete(step) {
    const current = templateAutocompleteState; if (!current?.items.length) return;
    current.index = (current.index + step + current.items.length) % current.items.length;
    $$('#templateVariableAutocomplete [data-template-autocomplete]').forEach((button, index) => { button.classList.toggle('active', index === current.index); button.setAttribute('aria-selected', String(index === current.index)); if (index === current.index) button.scrollIntoView({ block: 'nearest' }); });
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
    const workspaceGmailId = defaultConnectionId(project, 'gmail');
    const workspaceGmail = state.connections.find((connection) => connection.id === workspaceGmailId && connection.type === 'gmail');
    const workspaceGmailReady = workspaceGmail?.status === 'connected';
    const connectedEmail = workspaceGmail?.account || workspaceGmail?.label || '';
    const accountButton = $('#gmailFlowAccountButton');
    accountButton.classList.toggle('connected', workspaceGmailReady);
    accountButton.classList.toggle('needs-auth', !workspaceGmailReady);
    $('#gmailFlowAccountAvatar').textContent = connectedEmail ? connectedEmail.slice(0, 1).toUpperCase() : 'G';
    $('#gmailFlowAccountText').textContent = connectedEmail || '프로젝트 기본 Gmail 계정 필요';
    $('#gmailFlowAccountStatus').textContent = !workspaceGmailId
      ? '이 프로젝트에서 임시보관함을 만들 계정을 선택하세요.'
      : !workspaceGmail
        ? '선택한 Workspace Gmail 연결을 찾을 수 없습니다.'
        : workspaceGmailReady
          ? `Workspace 기본 계정 · ${workspaceGmail.label}`
          : `Workspace 기본 계정 · ${workspaceGmail.label} 로그인 필요`;
    $('#legacyGmailFlowStatus').textContent = gmailFlowSummary.connected
      ? `기존 Gmail Flow · ${gmailFlowSummary.email || '연결됨'}`
      : '기존 Gmail Flow 계정은 별도로 관리됩니다.';
    renderMailRosterResource(project);
    if (!mailEditorDirty) {
      mailEditorProjectId = project.id;
      $('#mailSubjectTemplate').value = project.data.communication.subjectTemplate;
      $('#mailBodyTemplate').value = project.data.communication.bodyTemplate;
      $('#mailBodyEditor').innerHTML = sanitizeRichHtml(project.data.communication.bodyHtmlTemplate || plainToHtml(project.data.communication.bodyTemplate));
    }
    const rosterSelect = $('#gmailSharedRosterSelect'); const selectedRosterId = rosterSelect.value;
    rosterSelect.replaceChildren(element('option', '', state.library.rosters.length ? '저장한 명단 선택' : '저장한 명단 없음'));
    state.library.rosters.forEach((roster) => { const option = element('option', '', `${roster.name} · ${(roster.people || []).filter((person) => person.active !== false).length}명`); option.value = roster.id; rosterSelect.append(option); });
    if (state.library.rosters.some((roster) => roster.id === selectedRosterId)) rosterSelect.value = selectedRosterId;
    rosterSelect.disabled = state.library.rosters.length === 0; $('#loadGmailSharedRoster').disabled = state.library.rosters.length === 0;
    const templateSelect = $('#sharedMailTemplateSelect'); templateSelect.replaceChildren(element('option', '', '저장한 메일 양식 선택'));
    state.library.mailTemplates.forEach((template) => { const option = element('option', '', template.name); option.value = template.id; templateSelect.append(option); });
    renderTemplateVariables(project);
    const pkg = Ops.buildMailPackage(project);
    const empty = pkg.entries.filter((entry) => !entry.assignments.length).length;
    const missingZoom = pkg.entries.filter((entry) => entry.assignments.some((assignment) => !assignment.zoomJoinUrl)).length;
    const packageReadiness = !pkg.entries.length
      ? '받는 사람 명단을 먼저 가져와주세요.'
      : empty || missingZoom
        ? `${pkg.entries[0]?.name || '받는 사람'}${pkg.entries.length > 1 ? ` 외 ${pkg.entries.length - 1}명` : ''}에게 보낼 예정입니다.${empty ? ` 일정이 없는 사람 ${empty}명을 확인해주세요.` : ''}${missingZoom ? ` Zoom 링크가 없는 사람 ${missingZoom}명을 확인해주세요.` : ''}`
        : `${pkg.entries[0]?.name || '받는 사람'}${pkg.entries.length > 1 ? ` 외 ${pkg.entries.length - 1}명` : ''}의 명단과 일정 연결을 확인했습니다.`;
    const accountReadiness = workspaceGmailReady
      ? `Gmail 임시보관함은 ${connectedEmail} 계정에 저장됩니다.`
      : 'Gmail 임시보관함을 만들려면 이 프로젝트의 Workspace Gmail 기본 계정을 연결해주세요.';
    $('#mailReadinessText').textContent = `${accountReadiness} ${packageReadiness}`;
    $('#mailPackageStatus').textContent = project.data.communication.lastPreparedAt ? `마지막 준비: ${formatUpdatedAt(project.data.communication.lastPreparedAt)}` : '메일 데이터를 준비하기 전입니다.';
    const table = $('#mailPreviewTable'); const head = element('tr'); ['이름', '이메일', '제목', '일정 수', '본문 미리보기', '상태', '수정'].forEach((label) => head.append(element('th', '', label))); table.tHead.replaceChildren(head);
    const rows = pkg.entries.map((entry) => {
      const row = element('tr'); [entry.name, entry.email, entry.subject, String(entry.assignments.length), entry.body.slice(0, 180)].forEach((value) => row.append(element('td', '', value)));
      const artifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === entry.personId && item.connectionId === workspaceGmailId);
      const otherAccountArtifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === entry.personId && item.connectionId !== workspaceGmailId);
      row.append(element('td', '', artifact?.status === 'created' ? (entry.edited ? '개별 수정 반영됨' : 'Gmail 임시보관함에 저장됨') : artifact?.status === 'stale' ? 'Gmail 내용 다시 저장 필요' : otherAccountArtifact ? '선택한 Gmail 계정으로 다시 저장 필요' : entry.edited ? '이 사람만 수정됨' : '확인 가능'));
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

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = element('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderSettings() {
    $('#storageMode').value = state.preferences.storageMode || 'local';
    const driveSelect = $('#workspaceDriveConnection'); const connectedDrives = state.connections.filter((connection) => connection.type === 'drive' && connection.status === 'connected'); const selectedDrive = connectedDrive(); const configuredDrive = state.connections.find((connection) => connection.id === state.preferences.workspaceDriveConnectionId && connection.type === 'drive'); const selectedDriveUnavailable = Boolean(state.preferences.workspaceDriveConnectionId && (!configuredDrive || configuredDrive.status !== 'connected'));
    driveSelect.replaceChildren(); const placeholder = element('option', '', selectedDriveUnavailable ? '선택한 계정 다시 연결 필요' : connectedDrives.length > 1 ? '동기화할 Drive 계정 선택' : connectedDrives.length ? '연결된 Drive 계정' : '연결된 Drive 계정 없음'); placeholder.value = ''; driveSelect.append(placeholder);
    connectedDrives.forEach((connection) => { const option = element('option', '', `${connection.label}${connection.account ? ` · ${connection.account}` : ''}`); option.value = connection.id; driveSelect.append(option); });
    driveSelect.value = selectedDrive?.id || ''; driveSelect.disabled = connectedDrives.length === 0;
    const hasNoDrive = connectedDrives.length === 0;
    const needsDriveChoice = connectedDrives.length > 1 && !selectedDrive;
    $('#pushDriveState').disabled = state.preferences.storageMode !== 'drive' || !selectedDrive;
    $('#pushDriveState').title = selectedDriveUnavailable ? '선택한 Drive 계정에 다시 로그인하거나 다른 계정을 선택해주세요.' : hasNoDrive ? '계정 연결에서 Google Drive 계정을 먼저 연결해주세요.' : state.preferences.storageMode !== 'drive' ? '저장 위치를 Google Drive 동기화로 바꾸면 사용할 수 있습니다.' : needsDriveChoice ? 'Workspace 전체 동기화 계정을 먼저 선택해주세요.' : '';
    $('#pullDriveState').disabled = !selectedDrive;
    $('#driveSyncStatus').textContent = selectedDriveUnavailable
      ? `선택한 “${configuredDrive?.label || 'Drive'}” 계정에 다시 로그인하거나 위에서 다른 Drive 계정을 선택해주세요.`
      : hasNoDrive
      ? '왼쪽의 “계정 연결”에서 Google Drive 계정을 연결하면 Workspace 전체 동기화를 사용할 수 있습니다.'
      : needsDriveChoice
      ? '연결된 Drive 계정이 여러 개입니다. Workspace 전체를 저장할 계정을 선택해주세요.'
      : state.preferences.storageMode !== 'drive'
        ? '현재는 이 PC에만 저장합니다. Drive 저장 버튼은 Google Drive 동기화 모드에서만 활성화됩니다.'
        : state.preferences.lastDriveSyncAt
          ? `${selectedDrive?.label || '선택한 계정'} · 마지막 저장 ${formatUpdatedAt(state.preferences.lastDriveSyncAt)}`
          : selectedDrive ? `${selectedDrive.label} 계정에 Workspace 전체를 저장합니다.` : 'Google Drive에 연결한 계정이 있어야 사용할 수 있습니다.';
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
    Core.CONNECTION_TYPES.filter((type) => type.id !== 'drive').forEach((type) => {
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
      if (schedulePersistTimer) await flushSchedulePersist();
      if (mailEditorDirty) await saveMailEditorDraft(mailEditorProjectId);
      const navigationAtStart = navigationGeneration;
      state = Core.setActiveProject(state, projectId);
      rosterSelection = null; rosterHistory = []; rosterFuture = []; arrangementSelection = null; arrangementHistory = []; arrangementFuture = [];
      scheduleSelection = null; scheduleHistory = []; scheduleFuture = []; selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null;
      await persist('프로젝트 전환됨');
      renderAll();
      if (navigationGeneration === navigationAtStart) navigate('dashboard');
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
      const navigationAtStart = navigationGeneration;
      state = result.state;
      await persist('프로젝트 생성됨');
      closeDialog('newProjectDialog');
      resetNewProjectForm();
      renderAll();
      if (navigationGeneration === navigationAtStart) navigate('dashboard');
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
      const previousName = project.name;
      const previousDefaultConnectionIds = { ...project.settings.defaultConnectionIds };
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
      const updatedProject = projectById(project.id);
      refreshScheduleConflicts(updatedProject);
      const projectNameChanged = previousName !== updatedProject.name;
      let gmailStale = false; let zoomStale = false;
      if (projectNameChanged) {
        updatedProject.data.externalArtifacts.forEach((artifact) => {
          if (artifact.status === 'superseded') return;
          if (artifact.kind === 'gmailDraft') { artifact.status = 'stale'; gmailStale = true; }
          if (artifact.kind === 'zoom') { artifact.status = 'stale'; zoomStale = true; }
        });
      }
      if (previousDefaultConnectionIds.gmail !== defaultConnectionIds.gmail) {
        gmailStale = supersedeArtifactsForRoute(
          updatedProject,
          'gmailDraft',
          defaultConnectionIds.gmail,
          () => true,
          '프로젝트 기본 Gmail 계정 변경 후 새 계정으로 다시 생성 필요'
        ) > 0 || gmailStale;
      }
      if (previousDefaultConnectionIds.zoom !== defaultConnectionIds.zoom) {
        const inheritedSlotIds = new Set(updatedProject.data.slots.filter((slot) => !slot.zoomConnectionId).map((slot) => slot.id));
        zoomStale = supersedeArtifactsForRoute(
          updatedProject,
          'zoom',
          defaultConnectionIds.zoom,
          (artifact) => inheritedSlotIds.has(artifact.slotId),
          '프로젝트 기본 Zoom 계정 변경 후 새 계정으로 다시 생성 필요'
        ) > 0 || zoomStale;
      }
      state = Core.updateProject(state, updatedProject.id, { data: updatedProject.data });
      if (updatedProject.data.slots.length) state = Core.setModuleStatus(state, updatedProject.id, 'schedule', updatedProject.data.conflicts.length ? 'needsReview' : 'stale', updatedProject.data.conflicts.length ? `설정 변경 후 일정 문제 ${updatedProject.data.conflicts.length}건` : '프로젝트 설정 변경 후 일정 재검토 필요');
      if (gmailStale && updatedProject.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, updatedProject.id, 'gmailFlow', 'stale', previousDefaultConnectionIds.gmail !== defaultConnectionIds.gmail ? '기본 Gmail 계정 변경 후 새 계정으로 다시 생성 필요' : '프로젝트 이름 변경 후 Gmail 확인 필요');
      if (zoomStale && updatedProject.installedModules.includes('zoom')) state = Core.setModuleStatus(state, updatedProject.id, 'zoom', 'stale', previousDefaultConnectionIds.zoom !== defaultConnectionIds.zoom ? '기본 Zoom 계정 변경 후 새 계정으로 다시 생성 필요' : '프로젝트 이름 변경 후 Zoom 확인 필요');
      recordScheduleMergeImpact(updatedProject.id, null, { scheduleOnly: false });
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
      const config = { provider: type === 'zoom' ? 'zoom' : 'google', type, clientId: $('#connectionClientId').value, clientSecret: $('#connectionClientSecret').value, redirectUri: $('#connectionRedirectUri').value };
      await persist('계정 설정 저장됨');
      let reservation = null; let externalStarted = false;
      try {
        reservation = await reserveExternalArtifacts('workspace-connections', 'connection', [result.connection.id]);
        if (!reservation.ok) throw new Error('다른 창에서 같은 계정 설정을 처리하고 있습니다.');
        if (!state.connections.some((item) => item.id === result.connection.id)) throw new Error('다른 창에서 계정 설정이 삭제되었습니다.');
        beginExternalOperation(); externalStarted = true;
        await globalThis.workspaceDesktop.configureConnection(result.connection.id, config);
      } finally { if (reservation?.ok) await releaseExternalArtifacts(reservation.token); if (externalStarted) endExternalOperation(); }
      closeDialog('connectionDialog');
      event.currentTarget.reset();
      renderAll();
      renderConnectionsPage();
      showToast('계정 설정을 저장했습니다. “로그인하여 연결”을 눌러 마무리하세요.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }

  function reconcileRosterViewsAfterReplacement(project) {
    const personIds = new Set(project.data.people.map((person) => person.id));
    project.data.rosterViews = (project.data.rosterViews || []).map((view) => ({
      ...view,
      personIds: (view.personIds || []).filter((id) => personIds.has(id)),
      excludedPersonIds: (view.excludedPersonIds || []).filter((id) => personIds.has(id))
    })).filter((view) => view.personIds.length);
    const viewIds = new Set(project.data.rosterViews.map((view) => view.id));
    if (!viewIds.has(project.data.activeRosterViewId)) project.data.activeRosterViewId = null;
    if (!viewIds.has(project.data.scheduleRules.rosterViewId)) project.data.scheduleRules.rosterViewId = null;
  }

  function pruneRosterViewMembershipsForSheetStructure(project) {
    const personIds = new Set(project.data.people.map((person) => person.id));
    project.data.rosterViews = (project.data.rosterViews || []).map((view) => ({
      ...view,
      personIds: (view.personIds || []).filter((id) => personIds.has(id)),
      excludedPersonIds: (view.excludedPersonIds || []).filter((id) => personIds.has(id))
    }));
    const viewIds = new Set(project.data.rosterViews.map((view) => view.id));
    if (!viewIds.has(project.data.activeRosterViewId)) project.data.activeRosterViewId = null;
    if (!viewIds.has(project.data.scheduleRules.rosterViewId)) project.data.scheduleRules.rosterViewId = null;
  }

  async function applyRosterMatrix(matrix) {
    let project = activeProject();
    if (!project) return false;
    const projectId = project.id; const confirmationSignature = rosterReplacementSignature(project);
    if (hasLockedSchedule(project)) { showToast('잠긴 일정 또는 배정이 있어 명단 전체 교체를 중단했습니다. 잠금을 해제한 뒤 다시 시도해주세요.', 'error'); return false; }
    if (project.data.people.length && !await showConfirm('현재 프로젝트의 원본 명단을 새 데이터로 전체 교체할까요? 기존 일정 배정은 해제되고 새 명단에 없는 사람의 단계·반별 명단은 정리됩니다.', { title: '명단 전체 교체', action: '전체 교체' })) return false;
    project = projectById(projectId);
    if (!project || rosterReplacementSignature(project) !== confirmationSignature || hasLockedSchedule(project)) { showToast('확인하는 동안 다른 창의 명단 또는 일정이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return false; }
    const beforeSnapshot = scheduleSnapshot(project);
    const result = Ops.matrixToRoster(matrix);
    clearRosterHistory();
    clearScheduleHistory();
    project.data.columns = result.columns; project.data.people = result.people; reconcileRosterViewsAfterReplacement(project); project.data.availability = {}; project.data.assignments = [];
    project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => artifact.kind === 'gmailDraft' ? { ...artifact, status: 'superseded', replacedAt: new Date().toISOString() } : artifact);
    refreshScheduleConflicts(project);
    const impact = applyScheduleMutationImpact(project, beforeSnapshot);
    syncScheduleProjectState(project, `명단 교체 후 일정 확인 · 문제 ${project.data.conflicts.length}건`, impact);
    recordScheduleMergeImpact(project.id, impact, { scheduleOnly: false });
    state = Core.setModuleStatus(state, project.id, 'people', result.warnings.length ? 'needsReview' : 'inProgress', `${result.people.length}명 가져옴`);
    await persist();
    renderAll();
    $('#rosterImportWarnings').hidden = result.warnings.length === 0;
    $('#rosterImportWarnings').textContent = result.warnings.join('\n');
    showToast(`${result.people.length}명을 명단으로 가져왔습니다.`, 'success');
    return true;
  }

  async function applySavedRoster(roster, returnPage = 'people') {
    await flushSchedulePersist(); let project = activeProject();
    if (!project || !roster) return false;
    const projectId = project.id; const rosterId = roster.id; const confirmationSignature = rosterReplacementSignature(project); const confirmationRosterSignature = sharedRosterSignature(roster);
    if (hasLockedSchedule(project)) { showToast('잠긴 일정 또는 배정이 있어 명단 전체 교체를 중단했습니다. 잠금을 해제한 뒤 다시 시도해주세요.', 'error'); return false; }
    const incomingCount = (roster.people || []).filter((person) => person.active !== false).length;
    if (project.data.people.length && !await showConfirm(`저장한 “${roster.name}” ${incomingCount}명으로 현재 프로젝트의 원본 명단을 전체 교체할까요? 기존 일정 배정은 해제되고 새 명단에 없는 사람의 단계·반별 명단은 정리됩니다.`, { title: '저장 명단으로 전체 교체', action: '전체 교체' })) return false;
    project = projectById(projectId); const currentRoster = state.library.rosters.find((item) => item.id === rosterId);
    if (!project || rosterReplacementSignature(project) !== confirmationSignature || hasLockedSchedule(project) || !currentRoster || sharedRosterSignature(currentRoster) !== confirmationRosterSignature) { showToast('확인하는 동안 다른 창의 명단·일정 또는 저장 명단이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return false; }
    roster = currentRoster;
    const beforeSnapshot = scheduleSnapshot(project);
    clearRosterHistory();
    clearScheduleHistory();
    project.data.rosterName = roster.name;
    project.data.columns = JSON.parse(JSON.stringify(roster.columns || []));
    project.data.people = JSON.parse(JSON.stringify(roster.people || []));
    project.data.people.forEach((person, index) => {
      person.sourceOrder = index;
      if (!person.roleIds?.some((roleId) => project.data.roles.some((role) => role.id === roleId))) person.roleIds = [project.data.roles[0]?.id || 'participant'];
    });
    syncPersonDerivedFields(project); reconcileRosterViewsAfterReplacement(project); project.data.availability = {}; project.data.assignments = [];
    project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => artifact.kind === 'gmailDraft' ? { ...artifact, status: 'superseded', replacedAt: new Date().toISOString() } : artifact);
    refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, beforeSnapshot);
    syncScheduleProjectState(project, `명단 전체 교체 후 일정 확인 · 문제 ${project.data.conflicts.length}건`, impact); recordScheduleMergeImpact(project.id, impact, { scheduleOnly: false });
    const warnings = rosterWarnings(project); state = Core.setModuleStatus(state, project.id, 'people', warnings.length ? 'needsReview' : 'inProgress', `${incomingCount}명 가져옴`);
    await persist('저장 명단으로 전체 교체됨'); renderAll(); navigate(returnPage); showToast(`“${roster.name}” ${incomingCount}명으로 원본 명단을 교체했습니다.`, 'success'); return true;
  }

  async function saveRoster() {
    const project = activeProject(); if (!project) return;
    syncPersonDerivedFields(project);
    const warnings = rosterWarnings(project);
    markRosterDependenciesStale(project);
    state = Core.setModuleStatus(state, project.id, 'people', warnings.length ? 'needsReview' : 'complete', `${project.data.people.filter((person) => person.active !== false).length}명`);
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
    await flushSchedulePersist(); const project = activeProject(); if (!project) return;
    syncRoleInputs(project);
    if (project.data.scheduleSheetInitialized) {
      project.data.scheduleSheetColumns.forEach((column) => {
        if (!column.roleId) return;
        const role = project.data.roles.find((item) => item.id === column.roleId);
        if (role) column.name = role.name;
      });
    }
    project.data.assignments.forEach((assignment) => {
      const role = project.data.roles.find((item) => item.id === assignment.roleId);
      if (role) assignment.roleName = role.name;
    });
    project.data.scheduleRules = {
      ...project.data.scheduleRules,
      avoidRepeatPairing: $('#ruleAvoidRepeat').checked,
      avoidPastPairing: $('#ruleAvoidPast').checked,
      groupPreference: $('#ruleGroupPreference').value,
      unmarkedMeansAvailable: $('#ruleUnmarkedAvailable').checked
    };
    refreshScheduleConflicts(project);
    syncScheduleProjectState(project, `일정 조건 변경 · 문제 ${project.data.conflicts.length}건`);
    await persist(); renderAll(); showToast(message, 'success');
  }

  async function generateSchedule() {
    await flushSchedulePersist(); let project = activeProject(); if (!project) return; const projectId = project.id;
    if (!project.data.people.length) { showToast('명단을 먼저 등록해주세요.', 'error'); return; }
    if (!project.data.slots.length) { showToast('시간대를 먼저 추가해주세요.', 'error'); return; }
    const replacing = project.data.assignments.length > 0;
    const confirmSignature = scheduleChangeSignature(project);
    if (replacing && !await showConfirm('현재 수동 조정 내용을 자동 백업한 뒤, 잠그지 않은 배정을 조건에 맞춰 다시 만듭니다. 전체 일정을 다시 만들까요?', { title: '전체 일정 다시 만들기', action: '백업 후 다시 만들기', danger: false })) return;
    project = projectById(projectId); if (!project) { showToast('일정을 반영할 프로젝트를 찾지 못했습니다.', 'error'); return; }
    if (replacing && scheduleChangeSignature(project) !== confirmSignature) { showToast('다른 창의 일정 변경을 반영했습니다. 다시 만들기를 한 번 더 눌러주세요.'); renderSchedulePage(); return; }
    syncRoleInputs(project);
    project.data.scheduleRules = {
      ...project.data.scheduleRules,
      avoidRepeatPairing: $('#ruleAvoidRepeat').checked,
      avoidPastPairing: $('#ruleAvoidPast').checked,
      groupPreference: $('#ruleGroupPreference').value,
      unmarkedMeansAvailable: $('#ruleUnmarkedAvailable').checked
    };
    pushScheduleHistory(project);
    if (replacing) project.data.versions.push(createScheduleVersion(project, `재편성 전 자동 백업 ${project.data.versions.length + 1}`));
    const beforeAssignments = project.data.assignments.map((assignment) => ({ ...assignment }));
    const result = Ops.generateSchedule({
      people: schedulePeopleWithRoleFilters(project),
      roles: project.data.roles,
      slots: project.data.slots,
      availability: project.data.availability,
      existingAssignments: project.data.assignments,
      historyPairs: scheduleHistoryPairs(project),
      rules: project.data.scheduleRules
    });
    project.data.assignments = result.assignments;
    refreshScheduleConflicts(project);
    const assignmentSignature = (items, slotId) => items.filter((item) => item.slotId === slotId).map((item) => `${item.personId}|${item.roleId}`).sort().join(',');
    const changedSlotIds = project.data.slots.filter((slot) => assignmentSignature(beforeAssignments, slot.id) !== assignmentSignature(result.assignments, slot.id)).map((slot) => slot.id);
    const zoomReviewSlotIds = changedSlotIds.filter((slotId) => (beforeAssignments.some((item) => item.slotId === slotId)) !== (result.assignments.some((item) => item.slotId === slotId)));
    const affectedPersonIds = [...new Set([...beforeAssignments, ...result.assignments].filter((item) => changedSlotIds.includes(item.slotId)).map((item) => item.personId).filter(Boolean))];
    markScheduleChangeStale(project, { changedSlotIds, zoomReviewSlotIds, affectedPersonIds });
    syncScheduleProjectState(project, `시간대 ${project.data.slots.length}개 · 확인할 문제 ${project.data.conflicts.length}건`, { changedSlotIds, zoomReviewSlotIds, affectedPersonIds });
    await persist(); renderAll();
    showToast(project.data.conflicts.length ? `일정표를 만들었습니다. 확인할 문제가 ${project.data.conflicts.length}건 있습니다.${replacing ? ' 이전 일정은 자동 백업했습니다.' : ''}` : `조건에 맞춰 일정표를 만들었습니다.${replacing ? ' 이전 일정은 자동 백업했습니다.' : ''}`, project.data.conflicts.length ? 'normal' : 'success');
  }

  function createScheduleVersion(project, name = `일정 ${project.data.versions.length + 1}차`) {
    return {
      id: `version-${Date.now().toString(36)}`,
      name,
      createdAt: new Date().toISOString(),
      slots: JSON.parse(JSON.stringify(project.data.slots)),
      assignments: JSON.parse(JSON.stringify(project.data.assignments)),
      availability: JSON.parse(JSON.stringify(project.data.availability)),
      conflicts: JSON.parse(JSON.stringify(project.data.conflicts))
    };
  }

  async function saveScheduleSnapshot() {
    await flushSchedulePersist(); const project = activeProject(); if (!project) return;
    const version = createScheduleVersion(project);
    project.data.versions.push(version);
    state = Core.updateProject(state, project.id, { data: project.data });
    state = Core.setModuleStatus(state, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'complete', `${version.name} 저장`);
    await persist(); renderAll(); showToast(`${version.name}를 저장했습니다.`, 'success');
  }

  function openPersonalMailEditor(personId) {
    const project = activeProject(); if (!project) return;
    const entry = Ops.buildMailPackage(project).entries.find((item) => item.personId === personId); if (!entry) return;
    const artifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === personId);
    $('#mailEditPersonId').value = personId; $('#mailEditRecipient').value = entry.email; $('#mailEditSubject').value = entry.subject;
    $('#mailEditBody').innerHTML = sanitizeRichHtml(entry.bodyHtml || plainToHtml(entry.body));
    $('#mailEditStatus').textContent = artifact ? `Gmail 임시보관함의 메일과 연결되어 있습니다. 저장하면 Gmail 내용도 함께 바뀝니다.` : '아직 Gmail 임시보관함에 만들지 않았습니다. 수정 내용은 현재 프로젝트에 저장됩니다.';
    $('#mailEditDialog').dataset.projectId = project.id;
    renderTemplateVariables(project, { paletteId: 'mailEditVariablePalette', statusId: 'mailEditTokenStatus', subjectId: 'mailEditSubject', bodyId: 'mailEditBody' });
    openDialog('mailEditDialog');
  }

  function captureOpenPersonalMailDraft({ markArtifactStale = true } = {}) {
    const dialog = $('#mailEditDialog');
    const project = projectById(dialog.dataset.projectId || '');
    const personId = $('#mailEditPersonId').value;
    if (!dialog.open || !project || !project.data.people.some((person) => person.id === personId)) return null;
    const html = sanitizeRichHtml($('#mailEditBody').innerHTML);
    project.data.communication.mailEdits[personId] = { subject: $('#mailEditSubject').value.trim(), bodyHtml: html, body: richText(html), updatedAt: new Date().toISOString() };
    const artifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === personId);
    if (artifact && markArtifactStale) artifact.status = 'stale';
    state = Core.updateProject(state, project.id, { data: project.data });
    persistDirty = true;
    return { projectId: project.id, personId };
  }

  function bindEvents() {
    bindRichEditor($('#mailBodyEditor')); bindRichEditor($('#mailEditBody'));
    document.addEventListener('input', (event) => {
      if (!event.target.matches('[data-person-row]')) return;
      const project = activeProject(); if (!project) return;
      const rowIndex = Number(event.target.dataset.personRow);
      const person = project.data.people[rowIndex] || (event.target.value.length ? ensureRosterPerson(project, rowIndex + 1) : null);
      if (person?.active === false) { event.target.value = person.values[event.target.dataset.columnId] || ''; return; }
      if (person) person.values[event.target.dataset.columnId] = event.target.value;
      syncPersonDerivedFields(project);
      if (person) state = Core.updateProject(state, project.id, { data: project.data });
    });
    document.addEventListener('focusout', () => setTimeout(() => applyDeferredWorkspaceState(), 0));
    const markMailEditorDirty = () => { mailEditorDirty = true; $('#mailPackageStatus').textContent = '메일 편집 내용을 자동 저장하는 중입니다.'; const project = activeProject(); if (project) renderTemplateVariables(project); clearTimeout(mailDraftTimer); mailDraftTimer = setTimeout(() => void saveMailEditorDraft(), 700); };
    $('#mailSubjectTemplate').addEventListener('input', (event) => { markMailEditorDirty(); renderTemplateAutocomplete(event.currentTarget); });
    $('#mailBodyEditor').addEventListener('input', (event) => { markMailEditorDirty(); renderTemplateAutocomplete(event.currentTarget); });
    ['mailSubjectTemplate', 'mailBodyEditor', 'mailEditSubject', 'mailEditBody'].forEach((id) => $(`#${id}`).addEventListener('focus', () => { templateInsertionTarget = id; }));
    $('#mailEditSubject').addEventListener('input', (event) => { const project = activeProject(); if (project) renderTemplateVariables(project, { paletteId: 'mailEditVariablePalette', statusId: 'mailEditTokenStatus', subjectId: 'mailEditSubject', bodyId: 'mailEditBody' }); renderTemplateAutocomplete(event.currentTarget); });
    $('#mailEditBody').addEventListener('input', (event) => { const project = activeProject(); if (project) renderTemplateVariables(project, { paletteId: 'mailEditVariablePalette', statusId: 'mailEditTokenStatus', subjectId: 'mailEditSubject', bodyId: 'mailEditBody' }); renderTemplateAutocomplete(event.currentTarget); });
    ['mailSubjectTemplate', 'mailBodyEditor', 'mailEditSubject', 'mailEditBody'].forEach((id) => {
      const target = $(`#${id}`);
      target.addEventListener('click', () => renderTemplateAutocomplete(target));
      target.addEventListener('keyup', (event) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) renderTemplateAutocomplete(target); });
      target.addEventListener('keydown', (event) => {
        if (!templateAutocompleteState || templateAutocompleteState.target !== target || $('#templateVariableAutocomplete').hidden) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveTemplateAutocomplete(event.key === 'ArrowDown' ? 1 : -1); }
        else if ((event.key === 'Enter' || event.key === 'Tab') && templateAutocompleteState.items.length) { event.preventDefault(); applyTemplateAutocomplete(templateAutocompleteState.items[templateAutocompleteState.index]); }
        else if (event.key === 'Escape') { event.preventDefault(); hideTemplateAutocomplete(); }
      });
      target.addEventListener('blur', () => setTimeout(() => { if (!$('#templateVariableAutocomplete').matches(':hover')) hideTemplateAutocomplete(); }, 100));
    });
    $('#templateVariableAutocomplete').addEventListener('mousedown', (event) => event.preventDefault());
    $('#templateVariableAutocomplete').addEventListener('click', (event) => { const option = event.target.closest('[data-template-autocomplete]'); if (option) applyTemplateAutocomplete(option.dataset.templateAutocomplete); });
    globalThis.addEventListener('resize', hideTemplateAutocomplete);
    document.addEventListener('scroll', hideTemplateAutocomplete, true);
    $$('.template-variable-palette').forEach((palette) => palette.addEventListener('click', (event) => { const token = event.target.closest('[data-template-token]'); if (token) insertTemplateToken(token.dataset.templateToken, token.dataset.templateTargetGroup); }));

    const rosterTable = $('#rosterEditorTable');
    if (rosterTable) {
    rosterTable.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-empty-sheet-add-column], [data-roster-add-column]')) return;
      rosterTable.classList.remove('range-selecting');
      const project = activeProject(); if (!project) return; const cell = event.target.closest('[data-sheet-row][data-sheet-col]'); const columnSelector = event.target.closest('[data-select-roster-column]'); const rowSelector = event.target.closest('[data-select-roster-row]'); const allSelector = event.target.closest('[data-select-roster-all]');
      if (!cell && !columnSelector && !rowSelector && !allSelector) return; const visibleRows = Math.max(project.data.people.length + 2, 5); let anchor; let focus; let mode = 'cells';
      if (columnSelector) { const col = Number(columnSelector.dataset.selectRosterColumn); anchor = { row: 0, col }; focus = { row: visibleRows, col }; mode = 'column'; }
      else if (rowSelector) { const row = Number(rowSelector.dataset.selectRosterRow); anchor = { row, col: 0 }; focus = { row, col: Math.max(0, project.data.columns.length - 1) }; mode = 'row'; }
      else if (allSelector) { anchor = { row: 0, col: 0 }; focus = { row: visibleRows, col: Math.max(0, project.data.columns.length - 1) }; mode = 'all'; }
      else { const point = { row: Number(cell.dataset.sheetRow), col: Number(cell.dataset.sheetCol) }; anchor = point; focus = point; }
      if (event.shiftKey && rosterSelection && rosterSelection.mode === mode && mode !== 'all') anchor = rosterSelection.anchor;
      rosterSelecting = true; updateRosterSelection(anchor, focus, mode);
      const input = event.target.closest('input') || cell?.querySelector('input'); const target = input?.readOnly ? cell : input || event.target.closest('[tabindex]') || columnSelector || rowSelector || allSelector || cell;
      if (!input && target) { event.preventDefault(); if (!target.hasAttribute('tabindex')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
    });
    globalThis.addEventListener('mousemove', (event) => {
      if (!rosterSelecting || !rosterSelection || !(event.buttons & 1)) return; const pointerTarget = spreadsheetPointerTarget(event, rosterTable); if (!pointerTarget) return; const cell = pointerTarget.closest('[data-sheet-row][data-sheet-col]'); const columnSelector = pointerTarget.closest('[data-select-roster-column]'); const rowSelector = pointerTarget.closest('[data-select-roster-row]'); let focus = rosterSelection.focus;
      if (rosterSelection.mode === 'column' && columnSelector) focus = { row: rosterSelection.focus.row, col: Number(columnSelector.dataset.selectRosterColumn) };
      else if (rosterSelection.mode === 'row' && rowSelector) focus = { row: Number(rowSelector.dataset.selectRosterRow), col: rosterSelection.focus.col };
      else if (rosterSelection.mode === 'cells' && cell) focus = { row: Number(cell.dataset.sheetRow), col: Number(cell.dataset.sheetCol) };
      else return; if (focus.row === rosterSelection.focus.row && focus.col === rosterSelection.focus.col) return; beginSpreadsheetRangeDrag(rosterTable); event.preventDefault(); updateRosterSelection(rosterSelection.anchor, focus, rosterSelection.mode);
    }, true);
    globalThis.addEventListener('mouseup', () => { rosterSelecting = false; rosterTable.classList.remove('range-selecting'); });
    rosterTable.addEventListener('dragstart', (event) => { if (rosterSelecting && event.target.closest('input')) event.preventDefault(); });
    rosterTable.addEventListener('focusin', (event) => { if (event.target.matches('[data-person-row], [data-column-name], [data-column-type]')) event.target.dataset.beforeRosterEdit = rosterSnapshot(activeProject()); });
    rosterTable.addEventListener('input', (event) => {
      if (!event.target.matches('[data-person-row], [data-column-name]')) return;
      if (event.target.dataset.beforeRosterEdit) { pushRosterHistorySnapshot(event.target.dataset.beforeRosterEdit); delete event.target.dataset.beforeRosterEdit; }
      if (event.target.matches('[data-column-name]')) { const project = activeProject(); const column = project?.data.columns.find((item) => item.id === event.target.dataset.columnName); if (project && column) { column.name = event.target.value; state = Core.updateProject(state, project.id, { data: project.data }); } }
    });
    rosterTable.addEventListener('change', (event) => { if (!event.target.dataset.beforeRosterEdit) return; pushRosterHistorySnapshot(event.target.dataset.beforeRosterEdit); delete event.target.dataset.beforeRosterEdit; });
    document.addEventListener('copy', (event) => {
      if (currentPage !== 'people' || !rosterSelection || shouldUseNativeRosterClipboard(event)) return; const project = activeProject(); if (!project) return;
      const matrix = selectedRosterMatrix(project); if (!matrix.length) return;
      const text = matrix.map((row) => row.join('\t')).join('\r\n');
      const html = `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`).join('')}</tr>`).join('')}</table>`;
      event.clipboardData.setData('text/plain', text); event.clipboardData.setData('text/html', html); event.preventDefault(); showToast(`${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
    });
    document.addEventListener('cut', (event) => {
      if (currentPage !== 'people' || !rosterSelection || shouldUseNativeRosterClipboard(event)) return; const project = activeProject(); if (!project) return; const matrix = selectedRosterMatrix(project); if (!matrix.length) return;
      event.clipboardData.setData('text/plain', matrix.map((row) => row.join('\t')).join('\r\n')); event.clipboardData.setData('text/html', `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`).join('')}</tr>`).join('')}</table>`); event.preventDefault(); void clearSelectedRosterCells(project, { message: '명단 셀 잘라내기 저장됨' });
    });
    rosterTable.addEventListener('paste', async (event) => {
      const text = event.clipboardData?.getData('text/plain') || ''; if (!text.trim()) return;
      const project = activeProject(); if (!project) return; const matrix = Ops.parseDelimited(text); if (!matrix.length) return;
      if (!project.data.columns.length) {
        if (!event.target.closest('[data-empty-roster-paste-anchor="true"]')) return;
        event.preventDefault();
        const structured = matrix.length > 1 || matrix.some((row) => row.length > 1);
        if (!structured) { showToast('한 셀 값만 입력하려면 먼저 컬럼을 추가하세요.'); return; }
        clearRosterHistory(); await applyRosterMatrix(matrix); return;
      }
      if (!rosterSelection) return;
      const singleValue = matrix.length === 1 && matrix[0].length === 1;
      if (singleValue && rosterSelectionIsRange()) {
        event.preventDefault(); pushRosterHistory(project); const bounds = rosterSelectionBounds(); let changed = 0; let locked = 0;
        for (let row = Math.max(1, bounds.minRow); row <= bounds.maxRow; row += 1) for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) { if (setSheetCellValue(project, row, col, matrix[0][0])) changed += 1; else locked += 1; }
        if (!changed) { rosterHistory.pop(); syncRosterHistoryControls(); showToast('선택한 범위는 수정할 수 없습니다.'); return; }
        await finishRosterSheetMutation(project, '선택 명단 범위 채우기 저장됨', { locked }); return;
      }
      if (singleValue) return; event.preventDefault(); pushRosterHistory(project);
      const pasteBounds = rosterSelectionBounds(); const start = { row: pasteBounds.minRow, col: pasteBounds.minCol };
      let changed = 0; let locked = 0;
      matrix.forEach((row, rowOffset) => row.forEach((value, colOffset) => {
        if (start.col + colOffset >= project.data.columns.length) return;
        if (setSheetCellValue(project, start.row + rowOffset, start.col + colOffset, value)) changed += 1; else locked += 1;
      }));
      updateRosterSelection(start, { row: start.row + matrix.length - 1, col: Math.min(project.data.columns.length - 1, start.col + Math.max(...matrix.map((row) => row.length)) - 1) });
      if (!changed) { rosterHistory.pop(); syncRosterHistoryControls(); showToast('제외된 행은 공용 명단 관리자에서 다시 포함한 뒤 수정해주세요.'); return; }
      await finishRosterSheetMutation(project, '셀 붙여넣기 저장됨');
      if (locked) showToast(`붙여넣기는 완료했지만 제외 행의 ${locked}개 셀은 잠금 상태로 유지했습니다.`);
    });
    rosterTable.addEventListener('keydown', (event) => {
      const project = activeProject(); if (!project) return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); void moveRosterHistory(project, event.key.toLowerCase() === 'z' && !event.shiftKey); return; }
      if (!rosterSelection) return;
      if (event.key === 'Escape') { event.preventDefault(); rosterSelection = null; renderPeoplePage(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.target.matches('input, textarea, select')) { event.preventDefault(); const visibleRows = Math.max(project.data.people.length + 2, 5); updateRosterSelection({ row: 0, col: 0 }, { row: visibleRows, col: project.data.columns.length - 1 }, 'all'); return; }
      const movement = { Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
      if (movement && (['Enter', 'Tab'].includes(event.key) || event.altKey || !event.target.matches('input, textarea, select'))) { event.preventDefault(); focusRosterCell(rosterSelection.focus.row + movement[0], rosterSelection.focus.col + movement[1], event.shiftKey && event.key !== 'Tab'); return; }
      if ((event.key === 'Delete' || event.key === 'Backspace') && (!event.target.matches('input:focus') || rosterSelectionIsRange())) { event.preventDefault(); void clearSelectedRosterCells(project); }
    });
    $('#rosterCellValue').addEventListener('focus', (event) => { const project = activeProject(); const point = rosterSelection?.focus; if (project && point && project.data.columns[point.col]) event.target.dataset.beforeRosterEdit = rosterSnapshot(project); });
    $('#rosterCellValue').addEventListener('input', (event) => {
      const project = activeProject(); if (!project || !rosterSelection) return; const point = rosterSelection.focus;
      if (!project.data.columns[point.col]) { event.target.value = ''; delete event.target.dataset.beforeRosterEdit; return; }
      if (event.target.dataset.beforeRosterEdit) { pushRosterHistorySnapshot(event.target.dataset.beforeRosterEdit); delete event.target.dataset.beforeRosterEdit; }
      if (!setSheetCellValue(project, point.row, point.col, event.target.value)) return;
      state = Core.updateProject(state, project.id, { data: project.data });
      queueRosterFormulaPersist(project, point, event.target.value);
      const cellInput = $(`[data-sheet-row="${point.row}"][data-sheet-col="${point.col}"] input`, rosterTable); if (cellInput) cellInput.value = event.target.value;
    });
    $('#rosterCellValue').addEventListener('change', async (event) => { if (event.target.dataset.beforeRosterEdit) { pushRosterHistorySnapshot(event.target.dataset.beforeRosterEdit); delete event.target.dataset.beforeRosterEdit; } await flushRosterFormulaPersist({ render: true }); });
    rosterTable.addEventListener('click', async (event) => {
      const project = activeProject(); if (!project) return;
      if (event.target.closest('[data-empty-sheet-add-column], [data-roster-add-column]')) {
        pushRosterHistory(project); addRosterColumn(project); clearScheduleHistory(); markRosterDependenciesStale(project, '명단 컬럼 추가 후 일정 재검토 필요'); await persist('명단 컬럼 추가됨'); renderPeoplePage();
      }
    });
    $('#rosterUndo').addEventListener('click', () => void moveRosterHistory(activeProject(), true));
    $('#rosterRedo').addEventListener('click', () => void moveRosterHistory(activeProject(), false));
    $('#rosterClearSelection').addEventListener('click', () => void applyRosterSheetAction('clear'));
    $('#rosterFillDown').addEventListener('click', () => void applyRosterSheetAction('fill-down'));
    $('#rosterInsertRow').addEventListener('click', () => void applyRosterSheetAction('insert-row'));
    $('#rosterDeleteRows').addEventListener('click', () => void applyRosterSheetAction('delete-rows'));
    $('#rosterInsertColumn').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return; const projectId = project.id; const before = rosterSnapshot(project); const selection = JSON.stringify(rosterSelection);
      const name = await requestName('삽입할 명단 컬럼 이름', '새 컬럼'); if (!name?.trim()) return;
      const current = activeProject(); if (!current || current.id !== projectId || rosterSnapshot(current) !== before || JSON.stringify(rosterSelection) !== selection) { showToast('명단 또는 선택 범위가 바뀌었습니다. 컬럼 삽입을 다시 시도해주세요.'); return; }
      await applyRosterSheetAction('insert-column', name);
    });
    $('#rosterDeleteColumns').addEventListener('click', () => void applyRosterSheetAction('delete-columns'));
    }

    document.addEventListener('copy', (event) => {
      if (currentPage !== 'arrange' || !arrangementSelection || shouldUseNativeArrangementClipboard(event)) return; const item = activeWorkItem(); if (!item) return;
      const matrix = selectedArrangementMatrix(item); if (!matrix.length) return; const text = matrix.map((row) => row.join('\t')).join('\r\n'); const html = `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`).join('')}</tr>`).join('')}</table>`;
      event.clipboardData.setData('text/plain', text); event.clipboardData.setData('text/html', html); event.preventDefault(); showToast(`${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
    });
    document.addEventListener('cut', (event) => {
      if (currentPage !== 'arrange' || !arrangementSelection || shouldUseNativeArrangementClipboard(event)) return; const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return; const matrix = selectedArrangementMatrix(item); if (!matrix.length) return;
      event.clipboardData.setData('text/plain', matrix.map((row) => row.join('\t')).join('\r\n')); event.clipboardData.setData('text/html', `<table>${matrix.map((row) => `<tr>${row.map((value) => `<td>${String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`).join('')}</tr>`).join('')}</table>`); event.preventDefault(); void clearSelectedArrangementCells(project, item, { message: '작업표 셀 잘라내기 저장됨' });
    });

    const arrangementBoard = $('#arrangementBoard');
    arrangementBoard.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-arrangement-add-column], [data-arrangement-remove-column]')) return;
      arrangementBoard.classList.remove('range-selecting');
      const item = activeWorkItem(); if (!item) return; const cell = event.target.closest('[data-arrangement-row][data-arrangement-col]'); const columnSelector = event.target.closest('[data-select-arrangement-column]'); const rowSelector = event.target.closest('[data-select-arrangement-row]'); const allSelector = event.target.closest('[data-select-arrangement-all]');
      if (!cell && !columnSelector && !rowSelector && !allSelector) return; const visibleRows = Math.max(item.rows.length + 2, 5); let anchor; let focus; let mode = 'cells';
      if (columnSelector) { const col = Number(columnSelector.dataset.selectArrangementColumn); anchor = { row: -1, col }; focus = { row: visibleRows - 1, col }; mode = 'column'; }
      else if (rowSelector) { const row = Number(rowSelector.dataset.selectArrangementRow); anchor = { row, col: 0 }; focus = { row, col: Math.max(0, item.columns.length - 1) }; mode = 'row'; }
      else if (allSelector) { anchor = { row: -1, col: 0 }; focus = { row: visibleRows - 1, col: Math.max(0, item.columns.length - 1) }; mode = 'all'; }
      else { const point = { row: Number(cell.dataset.arrangementRow), col: Number(cell.dataset.arrangementCol) }; anchor = point; focus = point; }
      if (event.shiftKey && arrangementSelection && arrangementSelection.mode === mode && mode !== 'all') anchor = arrangementSelection.anchor;
      arrangementSelecting = true; updateArrangementSelection(anchor, focus, mode);
      const input = event.target.closest('[data-arrangement-input]') || cell?.querySelector('[data-arrangement-input]'); const target = input || event.target.closest('button, [tabindex]') || columnSelector || rowSelector || allSelector || cell;
      if (!input && target) { event.preventDefault(); if (!target.hasAttribute('tabindex')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
    });
    globalThis.addEventListener('mousemove', (event) => {
      if (!arrangementSelecting || !arrangementSelection || !(event.buttons & 1)) return; const pointerTarget = spreadsheetPointerTarget(event, arrangementBoard); if (!pointerTarget) return; const cell = pointerTarget.closest('[data-arrangement-row][data-arrangement-col]'); const columnSelector = pointerTarget.closest('[data-select-arrangement-column]'); const rowSelector = pointerTarget.closest('[data-select-arrangement-row]'); let focus = arrangementSelection.focus;
      if (arrangementSelection.mode === 'column' && columnSelector) focus = { row: arrangementSelection.focus.row, col: Number(columnSelector.dataset.selectArrangementColumn) };
      else if (arrangementSelection.mode === 'row' && rowSelector) focus = { row: Number(rowSelector.dataset.selectArrangementRow), col: arrangementSelection.focus.col };
      else if (arrangementSelection.mode === 'cells' && cell) focus = { row: Number(cell.dataset.arrangementRow), col: Number(cell.dataset.arrangementCol) };
      else return; if (focus.row === arrangementSelection.focus.row && focus.col === arrangementSelection.focus.col) return; beginSpreadsheetRangeDrag(arrangementBoard); event.preventDefault(); updateArrangementSelection(arrangementSelection.anchor, focus, arrangementSelection.mode);
    }, true);
    globalThis.addEventListener('mouseup', () => { arrangementSelecting = false; arrangementBoard.classList.remove('range-selecting'); });
    arrangementBoard.addEventListener('dragstart', (event) => { if (arrangementSelecting && event.target.closest('input')) event.preventDefault(); });
    arrangementBoard.addEventListener('focusin', (event) => { if (event.target.matches('[data-arrangement-input]')) event.target.dataset.beforeArrangementEdit = arrangementSnapshot(activeWorkItem()); });
    arrangementBoard.addEventListener('input', (event) => { if (!event.target.matches('[data-arrangement-input]')) return; const project = activeProject(); const item = activeWorkItem(project); const cell = event.target.closest('[data-arrangement-row][data-arrangement-col]'); if (!project || !item || !cell) return; if (event.target.dataset.beforeArrangementEdit) { pushArrangementHistorySnapshot(event.target.dataset.beforeArrangementEdit); delete event.target.dataset.beforeArrangementEdit; } const row = Number(cell.dataset.arrangementRow); const col = Number(cell.dataset.arrangementCol); setArrangementCellValue(item, row, col, event.target.value); state = Core.updateProject(state, project.id, { data: project.data }); queueArrangementPersist(project, item, row, col, event.target.value); $('#arrangementCellValue').value = event.target.value; });
    arrangementBoard.addEventListener('change', async (event) => { if (!event.target.matches('[data-arrangement-input]')) return; if (event.target.dataset.beforeArrangementEdit) { pushArrangementHistorySnapshot(event.target.dataset.beforeArrangementEdit); delete event.target.dataset.beforeArrangementEdit; } await flushArrangementPersist({ render: true }); });
    arrangementBoard.addEventListener('paste', async (event) => {
      if (!arrangementSelection) return; const text = event.clipboardData?.getData('text/plain') || ''; if (!text) return; const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return; const matrix = Ops.parseDelimited(text); if (!matrix.length) return; const singleValue = matrix.length === 1 && matrix[0].length === 1;
      if (singleValue && arrangementSelectionIsRange()) { event.preventDefault(); pushArrangementHistory(item); const bounds = arrangementSelectionBounds(); for (let row = Math.max(0, bounds.minRow); row <= bounds.maxRow; row += 1) for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) setArrangementCellValue(item, row, col, matrix[0][0]); await finishArrangementSheetMutation(project, item, '선택 작업표 범위 채우기 저장됨'); return; }
      if (singleValue) return; event.preventDefault(); pushArrangementHistory(item); const pasteBounds = arrangementSelectionBounds(); const start = { row: pasteBounds.minRow, col: pasteBounds.minCol }; const width = Math.max(...matrix.map((row) => row.length));
      while (item.columns.length < start.col + width) { const id = `work-column-${Date.now().toString(36)}-${item.columns.length}`; item.columns.push({ id, name: `컬럼${item.columns.length + 1}` }); item.rows.forEach((row) => { row.values[id] = ''; }); }
      matrix.forEach((row, rowOffset) => row.forEach((value, colOffset) => setArrangementCellValue(item, start.row + rowOffset, start.col + colOffset, value))); arrangementSelection = { anchor: start, focus: { row: start.row + matrix.length - 1, col: start.col + width - 1 }, mode: 'cells' }; await finishArrangementSheetMutation(project, item, '명단 작업표 붙여넣기됨');
    });
    arrangementBoard.addEventListener('keydown', (event) => {
      const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); void moveArrangementHistory(project, item, event.key.toLowerCase() === 'z' && !event.shiftKey); return; }
      if (!arrangementSelection) return;
      if (event.key === 'Escape') { event.preventDefault(); arrangementSelection = null; renderArrangementPage(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.target.matches('input, textarea')) { event.preventDefault(); updateArrangementSelection({ row: -1, col: 0 }, { row: Math.max(item.rows.length + 1, 4), col: item.columns.length - 1 }, 'all'); return; }
      const movement = { Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
      if (movement && (['Enter', 'Tab'].includes(event.key) || event.altKey || !event.target.matches('input, textarea'))) { event.preventDefault(); focusArrangementCell(arrangementSelection.focus.row + movement[0], arrangementSelection.focus.col + movement[1], event.shiftKey && event.key !== 'Tab'); return; }
      if ((event.key === 'Delete' || event.key === 'Backspace') && (!event.target.matches('input:focus') || arrangementSelectionIsRange())) { event.preventDefault(); void clearSelectedArrangementCells(project, item); }
    });
    arrangementBoard.addEventListener('click', async (event) => {
      const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return;
      if (event.target.closest('[data-arrangement-add-column]')) { pushArrangementHistory(item); const id = `work-column-${Date.now().toString(36)}-${item.columns.length}`; item.columns.push({ id, name: `컬럼${item.columns.length + 1}` }); item.rows.forEach((row) => { row.values[id] = ''; }); await finishArrangementSheetMutation(project, item, '작업표 컬럼 추가됨'); return; }
      const remove = event.target.closest('[data-arrangement-remove-column]'); if (remove) { if (item.columns.length <= 1) { showToast('작업표에는 컬럼이 하나 이상 있어야 합니다.', 'error'); return; } const projectId = project.id; const itemId = item.id; const columnId = remove.dataset.arrangementRemoveColumn; const column = item.columns.find((candidate) => candidate.id === columnId); const before = arrangementSnapshot(item); if (!await showConfirm(`“${column?.name || '컬럼'}”을 삭제할까요?`, { title: '작업표 컬럼 삭제', action: '삭제' })) return; const currentProject = projectById(projectId); const currentItem = currentProject?.data.workItems.find((candidate) => candidate.id === itemId); const currentColumn = currentItem?.columns.find((candidate) => candidate.id === columnId); if (activeProject()?.id !== projectId || !currentItem || !currentColumn || arrangementSnapshot(currentItem) !== before) { showToast('작업표가 바뀌었습니다. 컬럼 삭제를 다시 시도해주세요.'); renderArrangementPage(); return; } pushArrangementHistory(currentItem); currentItem.columns = currentItem.columns.filter((candidate) => candidate.id !== columnId); currentItem.rows.forEach((row) => { delete row.values[columnId]; }); arrangementSelection = null; await finishArrangementSheetMutation(currentProject, currentItem, '작업표 컬럼 삭제됨'); }
    });
    arrangementBoard.addEventListener('dblclick', async (event) => { const rename = event.target.closest('[data-arrangement-rename-column]'); if (!rename) return; const project = activeProject(); const item = activeWorkItem(project); const columnId = rename.dataset.arrangementRenameColumn; const column = item?.columns.find((candidate) => candidate.id === columnId); if (!project || !item || !column) return; const projectId = project.id; const itemId = item.id; const before = arrangementSnapshot(item); const name = await requestName('컬럼 이름', column.name || '컬럼'); if (!name?.trim()) return; const currentProject = projectById(projectId); const currentItem = currentProject?.data.workItems.find((candidate) => candidate.id === itemId); const currentColumn = currentItem?.columns.find((candidate) => candidate.id === columnId); if (activeProject()?.id !== projectId || !currentItem || !currentColumn || arrangementSnapshot(currentItem) !== before) { showToast('작업표가 바뀌었습니다. 컬럼 이름 변경을 다시 시도해주세요.'); renderArrangementPage(); return; } pushArrangementHistory(currentItem); currentColumn.name = name.trim(); await finishArrangementSheetMutation(currentProject, currentItem, '작업표 컬럼 이름 변경됨'); });
    $('#arrangementCellValue').addEventListener('focus', (event) => { const item = activeWorkItem(); if (item) event.target.dataset.beforeArrangementEdit = arrangementSnapshot(item); });
    $('#arrangementCellValue').addEventListener('input', (event) => { const project = activeProject(); const item = activeWorkItem(project); if (!project || !item || !arrangementSelection) return; if (event.target.dataset.beforeArrangementEdit) { pushArrangementHistorySnapshot(event.target.dataset.beforeArrangementEdit); delete event.target.dataset.beforeArrangementEdit; } const row = arrangementSelection.focus.row; const col = arrangementSelection.focus.col; setArrangementCellValue(item, row, col, event.target.value); state = Core.updateProject(state, project.id, { data: project.data }); queueArrangementPersist(project, item, row, col, event.target.value); const input = $(`[data-arrangement-row="${row}"][data-arrangement-col="${col}"] input`, arrangementBoard); if (input) input.value = event.target.value; });
    $('#arrangementCellValue').addEventListener('change', async (event) => { if (event.target.dataset.beforeArrangementEdit) { pushArrangementHistorySnapshot(event.target.dataset.beforeArrangementEdit); delete event.target.dataset.beforeArrangementEdit; } await flushArrangementPersist({ render: true }); });
    $('#arrangementUndo').addEventListener('click', () => { const project = activeProject(); void moveArrangementHistory(project, activeWorkItem(project), true); });
    $('#arrangementRedo').addEventListener('click', () => { const project = activeProject(); void moveArrangementHistory(project, activeWorkItem(project), false); });
    $('#arrangementClearSelection').addEventListener('click', () => void applyArrangementSheetAction('clear'));
    $('#arrangementFillDown').addEventListener('click', () => void applyArrangementSheetAction('fill-down'));
    $('#arrangementInsertRow').addEventListener('click', () => void applyArrangementSheetAction('insert-row'));
    $('#arrangementDeleteRows').addEventListener('click', () => void applyArrangementSheetAction('delete-rows'));
    $('#arrangementInsertColumn').addEventListener('click', async () => {
      const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return; const projectId = project.id; const itemId = item.id; const before = arrangementSnapshot(item); const selection = JSON.stringify(arrangementSelection);
      const name = await requestName('삽입할 작업표 컬럼 이름', '새 컬럼'); if (!name?.trim()) return;
      const currentProject = activeProject(); const currentItem = activeWorkItem(currentProject); if (!currentProject || currentProject.id !== projectId || currentItem?.id !== itemId || arrangementSnapshot(currentItem) !== before || JSON.stringify(arrangementSelection) !== selection) { showToast('작업표 또는 선택 범위가 바뀌었습니다. 컬럼 삽입을 다시 시도해주세요.'); return; }
      await applyArrangementSheetAction('insert-column', name);
    });
    $('#arrangementDeleteColumns').addEventListener('click', () => void applyArrangementSheetAction('delete-columns'));
    ['rosterUndo', 'rosterRedo', 'rosterClearSelection', 'rosterFillDown', 'rosterInsertRow', 'rosterDeleteRows', 'rosterInsertColumn', 'rosterDeleteColumns', 'arrangementUndo', 'arrangementRedo', 'arrangementClearSelection', 'arrangementFillDown', 'arrangementInsertRow', 'arrangementDeleteRows', 'arrangementInsertColumn', 'arrangementDeleteColumns'].forEach((id) => {
      $(`#${id}`)?.addEventListener('click', (event) => event.currentTarget.closest('.schedule-sheet-toolbar, .roster-compact-toolbar')?.querySelectorAll('details.action-menu[open]').forEach((menu) => { menu.open = false; }));
    });

    const scheduleTable = $('#scheduleBoard');
    scheduleTable.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-schedule-remove-column], [data-schedule-insert-row], [data-schedule-append-row], [data-schedule-add-column-inline]')) return;
      scheduleTable.classList.remove('range-selecting');
      const project = activeProject(); if (!project) return; const cell = event.target.closest('[data-schedule-row][data-schedule-col]'); const columnSelector = event.target.closest('[data-select-schedule-column]'); const rowSelector = event.target.closest('[data-select-schedule-row]'); const allSelector = event.target.closest('[data-select-schedule-all]');
      if (!cell && !columnSelector && !rowSelector && !allSelector) return; const columns = scheduleSheetColumns(project); const visibleRows = Math.max(project.data.slots.length + 2, 5); let anchor; let focus; let mode = 'cells';
      if (columnSelector) { const col = Number(columnSelector.dataset.selectScheduleColumn); anchor = { row: -1, col }; focus = { row: visibleRows - 1, col }; mode = 'column'; }
      else if (rowSelector) { const row = Number(rowSelector.dataset.selectScheduleRow); anchor = { row, col: 0 }; focus = { row, col: Math.max(0, columns.length - 1) }; mode = 'row'; }
      else if (allSelector) { anchor = { row: -1, col: 0 }; focus = { row: visibleRows - 1, col: Math.max(0, columns.length - 1) }; mode = 'all'; }
      else { const point = { row: Number(cell.dataset.scheduleRow), col: Number(cell.dataset.scheduleCol) }; anchor = point; focus = point; }
      if (event.shiftKey && scheduleSelection && scheduleSelection.mode === mode && mode !== 'all') anchor = scheduleSelection.anchor;
      scheduleSelecting = true; updateScheduleSelection(anchor, focus, mode);
      const input = event.target.closest('[data-schedule-input]') || cell?.querySelector('[data-schedule-input]');
      if (input && !input.disabled) return;
      const target = input?.disabled ? cell : event.target.closest('button, [tabindex]') || columnSelector || rowSelector || allSelector || cell; if (target && document.activeElement !== target) { event.preventDefault(); if (!target.hasAttribute('tabindex')) target.tabIndex = -1; if (input?.disabled) { document.activeElement?.blur(); cell.tabIndex = -1; } target.focus({ preventScroll: true }); }
    });
    globalThis.addEventListener('mousemove', (event) => {
      if (!scheduleSelecting || !scheduleSelection || !(event.buttons & 1)) return; const pointerTarget = spreadsheetPointerTarget(event, scheduleTable); if (!pointerTarget) return; const cell = pointerTarget.closest('[data-schedule-row][data-schedule-col]'); const columnSelector = pointerTarget.closest('[data-select-schedule-column]'); const rowSelector = pointerTarget.closest('[data-select-schedule-row]'); let focus = scheduleSelection.focus;
      if (scheduleSelection.mode === 'column' && columnSelector) focus = { row: scheduleSelection.focus.row, col: Number(columnSelector.dataset.selectScheduleColumn) };
      else if (scheduleSelection.mode === 'row' && rowSelector) focus = { row: Number(rowSelector.dataset.selectScheduleRow), col: scheduleSelection.focus.col };
      else if (scheduleSelection.mode === 'cells' && cell) focus = { row: Number(cell.dataset.scheduleRow), col: Number(cell.dataset.scheduleCol) };
      else return; if (focus.row === scheduleSelection.focus.row && focus.col === scheduleSelection.focus.col) return; beginSpreadsheetRangeDrag(scheduleTable); event.preventDefault(); updateScheduleSelection(scheduleSelection.anchor, focus, scheduleSelection.mode);
    }, true);
    globalThis.addEventListener('mouseup', () => { scheduleSelecting = false; scheduleTable.classList.remove('range-selecting'); });
    scheduleTable.addEventListener('dragstart', (event) => { if (scheduleSelecting && event.target.closest('input')) event.preventDefault(); });
    scheduleTable.addEventListener('focusin', (event) => {
      if (!event.target.matches('[data-schedule-input]')) return;
      const snapshot = scheduleSnapshot(activeProject()); event.target.dataset.scheduleBefore = snapshot; event.target.dataset.scheduleImpactBefore = snapshot;
    });
    scheduleTable.addEventListener('input', (event) => {
      if (!event.target.matches('[data-schedule-input]')) return; const project = activeProject(); const cell = event.target.closest('[data-schedule-row][data-schedule-col]'); if (!project || !cell) return;
      const rowIndex = Number(cell.dataset.scheduleRow); const columnIndex = Number(cell.dataset.scheduleCol);
      if (!setScheduleCellValue(project, rowIndex, columnIndex, event.target.value)) { event.target.value = scheduleCellValue(project, rowIndex, columnIndex); showToast('잠긴 일정은 잠금 셀을 먼저 해제한 뒤 편집해주세요.', 'error'); return; }
      if (scheduleSheetColumns(project)[columnIndex]?.key === 'locked') syncScheduleRowLockControls(project, rowIndex);
      if (event.target.dataset.scheduleBefore) { pushScheduleHistorySnapshot(event.target.dataset.scheduleBefore); delete event.target.dataset.scheduleBefore; }
      updateScheduleSelection(scheduleSelection?.anchor || { row: rowIndex, col: columnIndex }, { row: rowIndex, col: columnIndex });
      const conflicts = project.data.conflicts || []; $('#scheduleConflicts').hidden = !conflicts.length; $('#scheduleConflicts').textContent = conflicts.slice(0, 30).map((item) => `• ${item.message}`).join('\n'); $('#scheduleBoardSummary').textContent = conflicts.length ? `현재 일정표에서 확인할 문제가 ${conflicts.length}건 있습니다.` : '현재 일정표에서 확인할 문제가 없습니다.';
      queueSchedulePersist(project, '일정 셀 편집 저장됨', event.target.dataset.scheduleImpactBefore);
    });
    scheduleTable.addEventListener('change', (event) => { if (event.target.matches('[data-schedule-input]')) delete event.target.dataset.scheduleImpactBefore; });
    scheduleTable.addEventListener('paste', async (event) => {
      if (!scheduleSelection) return; const text = event.clipboardData?.getData('text/plain') || ''; if (!text) return;
      const project = activeProject(); if (!project) return; const matrix = /[\t\r\n]/.test(text) ? Ops.parseDelimited(text) : [[text]]; if (!matrix.length) return; const start = { row: Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row), col: Math.min(scheduleSelection.anchor.col, scheduleSelection.focus.col) }; const structured = matrix.length > 1 || matrix.some((row) => row.length > 1); if (!structured && shouldUseNativeScheduleClipboard(event)) return; event.preventDefault();
      if (structured && start.row <= 0 && start.col === 0 && (looksLikeScheduleHeader(matrix) || !project.data.slots.length)) { await importScheduleMatrix(matrix, 'replace'); return; }
      const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); ensureScheduleSheetInitialized(project); pushScheduleHistory(project); const width = Math.max(...matrix.map((row) => row.length)); let lockedCells = 0; const lockedSlotIds = new Set(project.data.slots.filter((slot) => scheduleRowLocked(project, slot.id)).map((slot) => slot.id));
      while (scheduleSheetColumns(project).length < start.col + width) { const index = project.data.scheduleSheetColumns.length; const id = `schedule-column-${Date.now().toString(36)}-${index}`; project.data.scheduleSheetColumns.push({ id, key: `custom:${id}`, name: `컬럼${index + 1}`, kind: 'custom', roleId: null }); }
      matrix.forEach((row, rowOffset) => row.map((value, colOffset) => ({ value, targetColumn: start.col + colOffset })).sort((left, right) => Number(scheduleSheetColumns(project)[left.targetColumn]?.key === 'locked') - Number(scheduleSheetColumns(project)[right.targetColumn]?.key === 'locked')).forEach(({ value, targetColumn }) => { const targetRow = start.row + rowOffset; if (targetRow === -1) applyScheduleColumnName(project, project.data.scheduleSheetColumns[targetColumn], value); else if (!setScheduleCellValue(project, targetRow, targetColumn, value, { lockedSlotIds })) lockedCells += 1; }));
      const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `셀 붙여넣기 · 문제 ${project.data.conflicts.length}건`, impact); renderSchedulePage();
      updateScheduleSelection(start, { row: start.row + matrix.length - 1, col: Math.min(scheduleSheetColumns(project).length - 1, start.col + width - 1) });
      showToast(`${matrix.length}행 × ${Math.max(...matrix.map((row) => row.length))}열을 붙여넣었습니다.${lockedCells ? ` 잠긴 셀 ${lockedCells}개는 유지했습니다.` : ''}`, lockedCells ? 'normal' : 'success');
      await persist('일정 셀 붙여넣기 저장됨');
    });
    scheduleTable.addEventListener('keydown', async (event) => {
      const project = activeProject(); if (!project) return;
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); await moveScheduleHistory(project, event.key.toLowerCase() === 'z' && !event.shiftKey); return;
      }
      if (!scheduleSelection) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.target.matches('input, textarea')) { event.preventDefault(); updateScheduleSelection({ row: -1, col: 0 }, { row: Math.max(project.data.slots.length + 1, 4), col: scheduleSheetColumns(project).length - 1 }, 'all'); return; }
      const movement = { Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
      if (movement && (!event.target.matches('input, textarea') || event.key === 'Enter' || event.key === 'Tab' || event.altKey)) {
        event.preventDefault(); focusScheduleCell(scheduleSelection.focus.row + movement[0], scheduleSelection.focus.col + movement[1], event.shiftKey && event.key !== 'Tab'); return;
      }
      const rangeSelected = scheduleSelection.anchor.row !== scheduleSelection.focus.row || scheduleSelection.anchor.col !== scheduleSelection.focus.col || scheduleSelection.mode !== 'cells';
      if ((event.key === 'Delete' || event.key === 'Backspace') && (!event.target.matches('input:focus') || rangeSelected)) {
        event.preventDefault(); const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); pushScheduleHistory(project); const matrix = selectedScheduleMatrix(project); const minRow = Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row); const minCol = Math.min(scheduleSelection.anchor.col, scheduleSelection.focus.col); let lockedCells = 0; const lockedSlotIds = new Set(project.data.slots.filter((slot) => scheduleRowLocked(project, slot.id)).map((slot) => slot.id));
        matrix.forEach((row, r) => row.forEach((_value, c) => { if (minRow + r >= 0 && !setScheduleCellValue(project, minRow + r, minCol + c, '', { lockedSlotIds })) lockedCells += 1; })); const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `선택 셀 지움 · 문제 ${project.data.conflicts.length}건`, impact); renderSchedulePage(); if (lockedCells) showToast(`잠긴 셀 ${lockedCells}개는 유지했습니다.`, 'normal'); await persist('선택 셀 지움');
      }
    });
    document.addEventListener('copy', (event) => {
      if (currentPage !== 'schedule' || !scheduleSelection || shouldUseNativeScheduleClipboard(event)) return; const project = activeProject(); if (!project) return; const matrix = selectedScheduleMatrix(project); if (!matrix.length) return;
      event.clipboardData.setData('text/plain', matrix.map((row) => row.join('\t')).join('\r\n')); event.clipboardData.setData('text/html', scheduleClipboardHtml(matrix)); event.preventDefault(); showToast(`${matrix.length}행 × ${matrix[0].length}열을 복사했습니다.`);
    });
    document.addEventListener('cut', (event) => {
      if (currentPage !== 'schedule' || !scheduleSelection || shouldUseNativeScheduleClipboard(event)) return; const project = activeProject(); if (!project) return; const matrix = selectedScheduleMatrix(project); if (!matrix.length) return;
      event.clipboardData.setData('text/plain', matrix.map((row) => row.join('\t')).join('\r\n')); event.clipboardData.setData('text/html', scheduleClipboardHtml(matrix)); event.preventDefault(); const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); pushScheduleHistory(project);
      const minRow = Math.min(scheduleSelection.anchor.row, scheduleSelection.focus.row); const minCol = Math.min(scheduleSelection.anchor.col, scheduleSelection.focus.col); let lockedCells = 0; const lockedSlotIds = new Set(project.data.slots.filter((slot) => scheduleRowLocked(project, slot.id)).map((slot) => slot.id)); matrix.forEach((row, r) => row.forEach((_value, c) => { if (minRow + r >= 0 && !setScheduleCellValue(project, minRow + r, minCol + c, '', { lockedSlotIds })) lockedCells += 1; })); queueSchedulePersist(project, '잘라내기 저장됨', beforeSnapshot); renderSchedulePage(); if (lockedCells) showToast(`잠긴 셀 ${lockedCells}개는 복사만 하고 원본은 유지했습니다.`, 'normal');
    });
    $('#scheduleCellValue').addEventListener('focus', (event) => {
      const project = activeProject(); const point = scheduleSelection?.focus; if (!project || !point) return;
      event.target.dataset.scheduleImpactBefore = scheduleSnapshot(project); event.target.dataset.scheduleEditRow = String(point.row); event.target.dataset.scheduleEditCol = String(point.col); event.target.dataset.scheduleEditValue = event.target.value;
    });
    $('#scheduleCellValue').addEventListener('input', (event) => {
      const project = activeProject(); if (!project || !scheduleSelection) return;
      const rowIndex = Number(event.target.dataset.scheduleEditRow ?? scheduleSelection.focus.row); const columnIndex = Number(event.target.dataset.scheduleEditCol ?? scheduleSelection.focus.col); ensureScheduleSheetInitialized(project); const column = scheduleSheetColumns(project)[columnIndex]; const slot = rowIndex >= 0 ? project.data.slots[rowIndex] : null; event.target.dataset.scheduleEditValue = event.target.value;
      if (slot && scheduleRowLocked(project, slot.id) && column?.key !== 'locked') { event.target.value = scheduleCellValue(project, rowIndex, columnIndex); showToast('잠긴 일정은 잠금 셀을 먼저 해제한 뒤 편집해주세요.', 'error'); return; }
      const beforeSnapshot = event.target.dataset.scheduleImpactBefore || scheduleSnapshot(project); event.target.dataset.scheduleImpactBefore = beforeSnapshot;
      if (!event.target.dataset.scheduleEditing) { pushScheduleHistorySnapshot(beforeSnapshot); event.target.dataset.scheduleEditing = 'true'; }
      if (rowIndex === -1) { const editColumn = project.data.scheduleSheetColumns[columnIndex]; if (editColumn) { editColumn.name = event.target.value.trim() || editColumn.name; scheduleEditGeneration += 1; } }
      else if (!setScheduleCellValue(project, rowIndex, columnIndex, event.target.value)) { event.target.value = scheduleCellValue(project, rowIndex, columnIndex); showToast('잠긴 일정은 잠금 셀을 먼저 해제한 뒤 편집해주세요.', 'error'); return; }
      if (rowIndex >= 0 && column?.key === 'locked') syncScheduleRowLockControls(project, rowIndex);
      const input = $(`[data-schedule-row="${rowIndex}"][data-schedule-col="${columnIndex}"] input`, scheduleTable); if (input) input.value = event.target.value; queueSchedulePersist(project, '일정 셀 편집 저장됨', event.target.dataset.scheduleImpactBefore);
    });
    $('#scheduleCellValue').addEventListener('change', (event) => {
      const project = activeProject(); const rowIndex = Number(event.target.dataset.scheduleEditRow ?? scheduleSelection?.focus.row); const columnIndex = Number(event.target.dataset.scheduleEditCol ?? scheduleSelection?.focus.col); const editValue = event.target.dataset.scheduleEditValue ?? event.target.value;
      if (project && rowIndex === -1) {
        const column = project.data.scheduleSheetColumns[columnIndex];
        if (column) { applyScheduleColumnName(project, column, editValue); refreshScheduleConflicts(project); queueSchedulePersist(project, '일정 컬럼 이름 변경됨', event.target.dataset.scheduleImpactBefore); renderSchedulePage(); }
      }
      ['scheduleEditing', 'scheduleImpactBefore', 'scheduleEditRow', 'scheduleEditCol', 'scheduleEditValue'].forEach((key) => delete event.target.dataset[key]);
    });
    $('#scheduleMergeRoster').addEventListener('click', () => void mergeScheduleRoster($('#scheduleRosterSelect').value));
    $('#openScheduleRosterManager').addEventListener('click', () => void openRosterManager());
    $('#sessionRosterView').addEventListener('change', async (event) => { const project = activeProject(); if (!project) return; project.data.scheduleRules.rosterViewId = event.target.value || null; selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null; refreshScheduleConflicts(project); syncScheduleProjectState(project, `일정 대상 명단 변경 · 문제 ${project.data.conflicts.length}건`); await persist('일정 단계 명단 변경됨'); renderSchedulePage(); });
    ['sessionRoleSelect', 'sessionGroupFilter', 'sessionDateFilter'].forEach((id) => $(`#${id}`).addEventListener('change', () => { pendingSessionChange = null; const project = activeProject(); if (project) renderSessionPlanner(project); }));
    $('#sessionPersonSearch').addEventListener('input', () => { const project = activeProject(); if (project) renderSessionPlanner(project); });
    $('#sessionShowAllDates').addEventListener('click', () => { $('#sessionDateFilter').value = ''; pendingSessionChange = null; const project = activeProject(); if (project) renderSessionPlanner(project); });
    $('#sessionAddEmptyTime').addEventListener('click', () => void addSessionFromText());
    $('#sessionPersonPool').addEventListener('click', (event) => { const chip = event.target.closest('[data-session-person]'); if (!chip) return; const project = activeProject(); if (!project) return; if (selectedSessionPersonId === chip.dataset.sessionPerson) { selectedSessionPersonId = null; selectedSessionAssignmentId = null; } else { selectedSessionPersonId = chip.dataset.sessionPerson; const assignments = project.data.assignments.filter((item) => item.personId === selectedSessionPersonId); selectedSessionAssignmentId = assignments.length === 0 ? 'new' : assignments.length === 1 ? assignments[0].id : null; } pendingSessionChange = null; renderSessionPlanner(project); });
    $('#sessionPersonPool').addEventListener('dragstart', (event) => { const chip = event.target.closest('[data-session-person]'); if (!chip) return; const project = activeProject(); const assignments = project?.data.assignments.filter((item) => item.personId === chip.dataset.sessionPerson) || []; if (assignments.length > 1) { event.preventDefault(); selectedSessionPersonId = chip.dataset.sessionPerson; selectedSessionAssignmentId = null; pendingSessionChange = null; renderSessionPlanner(project); showToast('변경할 현재 일정을 먼저 선택해주세요.'); return; } event.dataTransfer.setData('application/x-cmoe-person', chip.dataset.sessionPerson); if (assignments.length === 1) event.dataTransfer.setData('application/x-cmoe-assignment', assignments[0].id); event.dataTransfer.effectAllowed = assignments.length ? 'move' : 'copy'; });
    $('#sessionCalendarBoard').addEventListener('dragstart', (event) => { const chip = event.target.closest('[data-session-assignment]'); if (!chip) return; event.dataTransfer.setData('application/x-cmoe-assignment', chip.dataset.sessionAssignment); event.dataTransfer.setData('application/x-cmoe-person', chip.dataset.sessionPerson); event.dataTransfer.effectAllowed = 'move'; });
    $('#sessionCalendarBoard').addEventListener('keydown', (event) => { const chip = event.target.closest('[data-session-assignment]'); if (!chip || !['Enter', ' '].includes(event.key) || event.target.closest('button')) return; event.preventDefault(); selectedSessionPersonId = chip.dataset.sessionPerson; selectedSessionAssignmentId = chip.dataset.sessionAssignment; pendingSessionChange = null; const project = activeProject(); if (project) renderSessionPlanner(project); });
    $('#sessionCalendarBoard').addEventListener('dragover', (event) => { const target = event.target.closest('[data-session-slot], [data-session-empty-drop]'); if (!target) return; event.preventDefault(); target.classList.add('drag-over'); });
    $('#sessionCalendarBoard').addEventListener('dragleave', (event) => { event.target.closest('[data-session-slot]')?.classList.remove('drag-over'); });
    $('#sessionCalendarBoard').addEventListener('drop', async (event) => { const target = event.target.closest('[data-session-slot], [data-session-empty-drop]'); if (!target) return; event.preventDefault(); target.classList.remove('drag-over'); let project = activeProject(); const personId = event.dataTransfer.getData('application/x-cmoe-person'); const assignmentId = event.dataTransfer.getData('application/x-cmoe-assignment'); if (!project || !personId) return; const projectId = project.id; selectedSessionPersonId = personId; selectedSessionAssignmentId = assignmentId || 'new'; if (target.dataset.sessionEmptyDrop) { const slot = await requestSessionSlot(); project = projectById(projectId); if (slot && project) previewSessionChange(project, { personId, assignmentId, toSlotId: slot.id, newSlot: slot }); } else previewSessionChange(project, { personId, assignmentId, toSlotId: target.dataset.sessionSlot }); });
    $('#sessionCalendarBoard').addEventListener('click', async (event) => {
      await flushSchedulePersist(); const project = activeProject(); if (!project) return;
      if (event.target.closest('[data-session-empty-drop]')) { await addSessionFromText(); return; }
      const unassign = event.target.closest('[data-session-unassign]'); if (unassign) { const assignment = project.data.assignments.find((item) => item.id === unassign.dataset.sessionUnassign); if (assignment) { selectedSessionPersonId = assignment.personId; selectedSessionAssignmentId = assignment.id; previewSessionChange(project, { personId: assignment.personId, assignmentId: assignment.id, action: 'remove' }); } return; }
      const assignmentChip = event.target.closest('[data-session-assignment]'); if (assignmentChip) { selectedSessionPersonId = assignmentChip.dataset.sessionPerson; selectedSessionAssignmentId = assignmentChip.dataset.sessionAssignment; pendingSessionChange = null; renderSessionPlanner(project); return; }
      const edit = event.target.closest('[data-session-edit]'); if (edit) { const projectId = project.id; const slotId = edit.dataset.sessionEdit; let currentProject = project; let slot = currentProject.data.slots.find((item) => item.id === slotId); if (!slot) return; if (scheduleRowLocked(currentProject, slot.id)) { showToast('잠긴 세션은 잠금을 해제한 뒤 시간을 변경해주세요.', 'error'); return; } const value = await requestName('세션 시간 변경', `${slot.date} ${slot.startTime}-${slot.endTime} ${slot.label || ''}`); if (!value) return; const parsed = Ops.parseSlots(value); if (!parsed.slots.length) { showToast(parsed.errors[0] || '날짜와 시간을 확인해주세요.', 'error'); return; } currentProject = projectById(projectId); slot = currentProject?.data.slots.find((item) => item.id === slotId); if (!currentProject || !slot) { showToast('다른 창에서 해당 세션이 삭제되었습니다.', 'error'); renderSchedulePage(); return; } if (scheduleRowLocked(currentProject, slot.id)) { showToast('다른 창에서 세션이 잠겼습니다.', 'error'); renderSchedulePage(); return; } const personIds = currentProject.data.assignments.filter((item) => item.slotId === slot.id).map((item) => item.personId); const confirmSignature = scheduleChangeSignature(currentProject); if (!await showConfirm(`${personIds.length}명의 일정과 연결된 Zoom·메일을 다시 확인해야 합니다. 시간을 변경할까요?`, { title: '세션 시간 변경', action: '변경', danger: false })) return; currentProject = projectById(projectId); slot = currentProject?.data.slots.find((item) => item.id === slotId); if (!currentProject || !slot || scheduleRowLocked(currentProject, slot.id) || scheduleChangeSignature(currentProject) !== confirmSignature) { showToast('다른 창의 일정 변경을 반영했습니다. 다시 시도해주세요.'); renderSchedulePage(); return; } pushScheduleHistory(currentProject); const next = parsed.slots[0]; Object.assign(slot, { date: next.date, startTime: next.startTime, endTime: next.endTime, label: next.label, status: 'changed' }); const impact = { changedSlotIds: [slot.id], zoomReviewSlotIds: [slot.id], affectedPersonIds: personIds }; markScheduleChangeStale(currentProject, impact); refreshScheduleConflicts(currentProject); syncScheduleProjectState(currentProject, `세션 시간 변경 · 문제 ${currentProject.data.conflicts.length}건`, impact); renderSchedulePage(); await persist('세션 시간 변경됨'); return; }
      const remove = event.target.closest('[data-session-remove]'); if (remove) { const projectId = project.id; const slotId = remove.dataset.sessionRemove; let currentProject = project; let slot = currentProject.data.slots.find((item) => item.id === slotId); let assignments = currentProject.data.assignments.filter((item) => item.slotId === slotId); if (slot && scheduleRowLocked(currentProject, slot.id)) { showToast('잠긴 세션은 잠금을 해제한 뒤 삭제해주세요.', 'error'); return; } if (!slot) return; const confirmSignature = scheduleChangeSignature(currentProject); if (!await showConfirm(`${slot.date} ${slot.startTime} 세션을 삭제할까요? 배정 인원 ${assignments.length}명의 Zoom·메일도 다시 확인해야 합니다.`, { title: '세션 삭제', action: '삭제' })) return; currentProject = projectById(projectId); slot = currentProject?.data.slots.find((item) => item.id === slotId); if (!currentProject || !slot || scheduleRowLocked(currentProject, slot.id) || scheduleChangeSignature(currentProject) !== confirmSignature) { showToast('다른 창의 일정 변경을 반영했습니다. 다시 시도해주세요.'); renderSchedulePage(); return; } assignments = currentProject.data.assignments.filter((item) => item.slotId === slot.id); pushScheduleHistory(currentProject); const impact = { changedSlotIds: [slot.id], zoomReviewSlotIds: [slot.id], affectedPersonIds: assignments.map((item) => item.personId) }; markScheduleChangeStale(currentProject, impact); currentProject.data.slots = currentProject.data.slots.filter((item) => item.id !== slot.id); currentProject.data.assignments = currentProject.data.assignments.filter((item) => item.slotId !== slot.id); Object.keys(currentProject.data.availability).forEach((personId) => { currentProject.data.availability[personId] = currentProject.data.availability[personId].filter((id) => id !== slot.id); }); refreshScheduleConflicts(currentProject); syncScheduleProjectState(currentProject, `세션 삭제 · 문제 ${currentProject.data.conflicts.length}건`, impact); renderSchedulePage(); await persist('세션 삭제됨'); return; }
      const card = event.target.closest('[data-session-slot]'); if (card && selectedSessionPersonId) { if (!selectedSessionAssignmentId) { showToast('변경할 현재 일정을 먼저 선택해주세요.'); return; } previewSessionChange(project, { personId: selectedSessionPersonId, assignmentId: selectedSessionAssignmentId, toSlotId: card.dataset.sessionSlot }); }
    });
    $('#sessionSelectedPersonPanel').addEventListener('click', (event) => { const project = activeProject(); if (!project) return; if (event.target.closest('[data-session-clear-person]')) { selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null; renderSessionPlanner(project); return; } const origin = event.target.closest('[data-session-origin-assignment]'); if (origin) { selectedSessionAssignmentId = origin.dataset.sessionOriginAssignment; pendingSessionChange = null; renderSessionPlanner(project); return; } if (event.target.closest('[data-session-origin-new]')) { selectedSessionAssignmentId = 'new'; pendingSessionChange = null; renderSessionPlanner(project); } });
    $('#sessionCancelChange').addEventListener('click', () => { pendingSessionChange = null; const project = activeProject(); if (project) renderSessionPlanner(project); });
    $('#sessionApplyChange').addEventListener('click', () => void applyPendingSessionChange());
    scheduleTable.addEventListener('click', (event) => {
      if (event.target.closest('[data-schedule-add-column-inline]')) { void addScheduleColumn(); return; }
      const remove = event.target.closest('[data-schedule-remove-column]'); if (remove) void removeScheduleColumn(remove.dataset.scheduleRemoveColumn);
    });
    scheduleTable.addEventListener('dblclick', (event) => { const rename = event.target.closest('[data-schedule-rename-column]'); if (rename) void renameScheduleColumn(rename.dataset.scheduleRenameColumn); });
    $('#scheduleUndo').addEventListener('click', () => void moveScheduleHistory(activeProject(), true));
    $('#scheduleRedo').addEventListener('click', () => void moveScheduleHistory(activeProject(), false));
    $('#sessionUndo').addEventListener('click', () => void moveScheduleHistory(activeProject(), true));
    $('#sessionRedo').addEventListener('click', () => void moveScheduleHistory(activeProject(), false));
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
      event.preventDefault();
      const submitButton = $('#mailEditForm button[type="submit"]');
      if (submitButton.disabled) return;
      const captured = captureOpenPersonalMailDraft();
      if (!captured) { showToast('수정 내용을 저장할 프로젝트 또는 받는 사람을 찾지 못했습니다.', 'error'); return; }
      const { projectId, personId } = captured;
      let reservation = null; let externalStarted = false; let message = '개인 메일 수정 내용을 프로젝트에 저장했습니다.'; let tone = 'success';
      submitButton.disabled = true;
      try {
        await persist('개인 메일 수정 저장됨');
        let project = projectById(projectId);
        let artifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === personId);
        let entry = project ? Ops.buildMailPackage(project).entries.find((item) => item.personId === personId) : null;
        if (artifact && entry) {
          let connection = state.connections.find((item) => item.id === artifact.connectionId && item.status === 'connected');
          if (!connection) { message = '수정 내용은 저장했습니다. Gmail 계정에 다시 로그인하면 임시보관함의 메일도 변경할 수 있습니다.'; tone = 'error'; }
          else {
            try { reservation = await reserveExternalArtifacts(projectId, 'gmailDraft', [personId]); }
            catch (error) { message = `수정 내용은 저장했지만 Gmail 변경 작업을 시작하지 못했습니다: ${error.message}`; tone = 'error'; }
            if (reservation && !reservation.ok) { message = '수정 내용은 저장했습니다. 다른 창에서 같은 Gmail 메일을 처리 중이므로 완료 후 다시 확인해주세요.'; tone = 'normal'; }
            if (reservation?.ok) {
              beginExternalOperation(); externalStarted = true;
              project = projectById(projectId); artifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === personId); entry = project ? Ops.buildMailPackage(project).entries.find((item) => item.personId === personId) : null;
              connection = artifact ? state.connections.find((item) => item.id === artifact.connectionId && item.status === 'connected') : null;
              if (!project || !artifact || !entry || !connection) { message = '수정 내용은 저장했지만 최신 Gmail 메일과 로그인 계정 연결을 찾지 못했습니다.'; tone = 'error'; }
              else {
                const baseSignature = externalOperationSignature(project, 'gmailDraft'); const expectedConnectionIdentity = Core.connectionIdentity(connection);
                let updated = null; let updateError = null;
                try {
                  if (externalOperationStateChanged(projectId, 'gmailDraft', baseSignature)) throw new Error('연결 준비 중 Gmail 계정 또는 메일 내용이 바뀌었습니다.');
                  updated = await globalThis.workspaceDesktop.updateGmailDraft(connection.id, artifact.externalId, entry, expectedConnectionIdentity);
                }
                catch (error) { updateError = error; }
                const latestProject = latestKnownProject(projectId);
                if (latestProject) {
                  const changedDuringUpdate = externalOperationStateChanged(projectId, 'gmailDraft', baseSignature);
                  const artifactUpdate = { ...artifact, messageId: updated?.message?.id || artifact.messageId, status: updateError || changedDuringUpdate ? 'stale' : 'created', updatedAt: new Date().toISOString() };
                  const artifacts = mergeExternalArtifactUpdates(latestProject.data.externalArtifacts, [artifactUpdate]);
                  state = Core.updateProject(state, projectId, { data: { externalArtifacts: artifacts } });
                  const commitReason = 'Gmail 수정 결과를 저장하는 동안 프로젝트 또는 계정이 바뀌어 메일 확인 필요';
                  const conflictState = markExternalArtifactsForCommitConflict(state, projectId, 'gmailDraft', [artifactUpdate], commitReason);
                  const commitResult = await persist(updateError || changedDuringUpdate ? 'Gmail 메일 재확인 필요' : 'Gmail 메일 수정됨', {
                    externalCommit: externalCommitGuard({ reservation, project: latestProject, kind: 'gmailDraft', expectedConnections: [expectedConnectionIdentity], conflictState })
                  });
                  if (commitResult?.externalConflict) { message = updated ? 'Gmail의 메일은 수정됐지만 그 사이 프로젝트 또는 계정이 바뀌어 프로젝트에는 확인 필요 상태로 남겼습니다.' : 'Gmail 수정은 완료되지 않았고 그 사이 프로젝트 또는 계정도 바뀌어 프로젝트에는 확인 필요 상태로 남겼습니다.'; tone = 'error'; }
                  else if (updateError) { message = `수정 내용은 프로젝트에 저장했지만 Gmail 메일은 변경하지 못했습니다: ${updateError.message}`; tone = 'error'; }
                  else if (changedDuringUpdate) { message = 'Gmail을 수정하는 동안 관련 내용이 바뀌어 확인 대상으로 표시했습니다.'; tone = 'normal'; }
                  else message = '수정 내용을 저장하고 Gmail 임시보관함의 메일도 변경했습니다.';
                } else if (latestProject) { message = updateError ? `수정 내용은 저장했지만 Gmail 메일은 변경하지 못했습니다: ${updateError.message}` : 'Gmail 계정이 바뀌어 이전 계정의 메일은 종료 상태로 유지했습니다.'; tone = updateError ? 'error' : 'normal'; }
              }
            }
          }
        }
        closeDialog('mailEditDialog'); renderAll(); showToast(message, tone);
      } catch (error) { showToast(`개인 메일 수정 내용을 저장하지 못했습니다: ${error.message}`, 'error'); }
      finally { if (reservation?.ok) await releaseExternalArtifacts(reservation.token); if (externalStarted) endExternalOperation(); submitButton.disabled = false; }
    });
    $('#resetPersonalMail').addEventListener('click', async () => {
      const project = projectById($('#mailEditDialog').dataset.projectId || ''); if (!project) return; const personId = $('#mailEditPersonId').value;
      delete project.data.communication.mailEdits[personId];
      const artifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === personId); if (artifact) artifact.status = 'stale';
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
      const project = activeProject();
      if (!(project?.data.people || []).some((person) => person.active !== false)) { showToast('저장할 활성 명단이 없습니다.', 'error'); return; }
      const projectId = project.id;
      const name = await requestName('저장할 명단 이름', `${project.name} 명단`); if (!name) return;
      const currentProject = projectById(projectId);
      const people = (currentProject?.data.people || []).filter((person) => person.active !== false).map((person, index) => ({ ...JSON.parse(JSON.stringify(person)), sourceOrder: index, active: true }));
      if (!currentProject || !people.length) { showToast('이름을 입력하는 동안 명단이 바뀌어 저장할 활성 인원이 없습니다.', 'error'); return; }
      state.library.rosters.push({ id: `roster-${Date.now().toString(36)}`, name, columns: JSON.parse(JSON.stringify(currentProject.data.columns)), people, savedAt: new Date().toISOString() });
      await persist(); renderPeoplePage(); showToast('나중에 다시 사용할 수 있도록 명단을 저장했습니다.', 'success');
    });
    $('#loadSharedRoster')?.addEventListener('click', async () => {
      const roster = state.library.rosters.find((item) => item.id === $('#sharedRosterSelect').value); if (!roster) { showToast('불러올 명단을 먼저 선택해주세요.', 'error'); return; }
      await applySavedRoster(roster, 'people');
    });
    $('#saveSharedMailTemplate').addEventListener('click', async () => {
      const name = await requestName('저장할 메일 양식 이름', '안내 메일 양식'); if (!name) return;
      state.library.mailTemplates.push({ id: `mail-template-${Date.now().toString(36)}`, name, subject: $('#mailSubjectTemplate').value, bodyHtml: sanitizeRichHtml($('#mailBodyEditor').innerHTML), savedAt: new Date().toISOString() });
      await persist(); renderGmailPage(); showToast('나중에 다시 사용할 수 있도록 메일 양식을 저장했습니다.', 'success');
    });
    $('#loadSharedMailTemplate').addEventListener('click', async () => {
      const template = state.library.mailTemplates.find((item) => item.id === $('#sharedMailTemplateSelect').value); if (!template) { showToast('불러올 메일 양식을 먼저 선택해주세요.', 'error'); return; }
      const project = activeProject(); if (!project) return;
      $('#mailSubjectTemplate').value = template.subject || ''; $('#mailBodyEditor').innerHTML = sanitizeRichHtml(template.bodyHtml || plainToHtml(template.body || ''));
      mailEditorProjectId = project.id; mailEditorDirty = true;
      await saveMailEditorDraft(project.id);
      renderGmailPage(); renderDashboard();
      showToast('저장한 메일 양식을 불러와 현재 프로젝트에 저장했습니다.', 'success');
    });
    $('#loadGmailSharedRoster')?.addEventListener('click', async () => {
      const roster = state.library.rosters.find((item) => item.id === $('#gmailSharedRosterSelect').value); if (!roster) { showToast('메일을 보낼 사람의 명단을 선택해주세요.', 'error'); return; }
      await applySavedRoster(roster, 'gmailFlow');
    });
    $('#applyGmailRosterPaste')?.addEventListener('click', async () => {
      const text = $('#gmailRosterPaste').value.trim(); if (!text) { showToast('붙여넣은 명단 데이터가 없습니다.', 'error'); return; }
      const matrix = Ops.parseDelimited(text); if (!matrix.length) { showToast('명단 구조를 인식하지 못했습니다.', 'error'); return; }
      if (await applyRosterMatrix(matrix)) { $('#gmailRosterPaste').value = ''; navigate('gmailFlow'); }
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
    $('#gmailFlowAccountButton').addEventListener('click', () => navigate('connections'));
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
        const connection = connectedDrive(); const connectedCount = state.connections.filter((item) => item.type === 'drive' && item.status === 'connected').length;
        if (!connection) { event.target.value = 'local'; showToast(state.preferences.workspaceDriveConnectionId ? '선택한 Workspace Drive 계정에 다시 로그인하거나 다른 계정을 선택해주세요.' : connectedCount > 1 ? 'Workspace 전체를 동기화할 Drive 계정을 먼저 선택해주세요.' : '먼저 Google Drive 계정에 로그인하여 연결해주세요.', 'error'); if (!connectedCount) navigate('connections'); else renderSettings(); return; }
        state.preferences.workspaceDriveConnectionId = connection.id;
      }
      state.preferences.storageMode = event.target.value;
      await persist();
      renderSettings(); if (event.target.value === 'drive') await flushDriveStateSync(true, { force: true });
    });
    $('#workspaceDriveConnection').addEventListener('change', async (event) => {
      const connection = state.connections.find((item) => item.id === event.target.value && item.type === 'drive' && item.status === 'connected');
      if (!connection) { state.preferences.workspaceDriveConnectionId = null; await persist('Drive 동기화 계정 선택 해제됨'); renderSettings(); return; }
      state.preferences.workspaceDriveConnectionId = connection.id; await persist('Drive 동기화 계정 선택됨'); renderSettings();
      if (state.preferences.storageMode === 'drive') await flushDriveStateSync(true, { force: true });
    });
    $('#pushDriveState').addEventListener('click', () => { if (state.preferences.storageMode !== 'drive') { showToast('저장 위치를 Google Drive 동기화로 바꾼 뒤 저장해주세요.'); return; } void flushDriveStateSync(true, { force: true }); });
    $('#pullDriveState').addEventListener('click', async () => {
      let connection = connectedDrive();
      if (!connection) { const connectedCount = state.connections.filter((item) => item.type === 'drive' && item.status === 'connected').length; showToast(state.preferences.workspaceDriveConnectionId ? '선택한 Workspace Drive 계정에 다시 로그인하거나 다른 계정을 선택해주세요.' : connectedCount > 1 ? '환경 설정에서 가져올 Workspace Drive 계정을 선택해주세요.' : 'Google Drive에서 자료를 가져올 계정에 먼저 로그인해주세요.', 'error'); if (!connectedCount) navigate('connections'); return; }
      const connectionId = connection.id;
      let reservation = null; let externalStarted = false;
      try {
        reservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connectionId]);
        if (!reservation.ok) { showToast('다른 창에서 같은 Drive 계정을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
        await waitForPersistIdle();
        applyDeferredWorkspaceState();
        connection = state.connections.find((item) => item.id === connectionId && item.type === 'drive' && item.status === 'connected');
        if (!connection) throw new Error('Drive 계정 연결 상태가 변경되었습니다.');
        const expectedConnectionIdentity = Core.connectionIdentity(connection);
        const expectedWorkspaceIdentity = workspaceStateIdentity(latestKnownWorkspaceState());
        beginExternalOperation(); externalStarted = true;
        const result = await globalThis.workspaceDesktop.pullDriveState(connection.id, expectedConnectionIdentity);
        if (!result.exists) { showToast('Drive에 저장된 Workspace 데이터가 없습니다.'); return; }
        if (!await showConfirm(`Drive에 ${formatUpdatedAt(result.modifiedTime)} 저장된 데이터로 이 PC의 Workspace를 바꿀까요? 현재 로컬 상태는 덮어씁니다.`, { title: 'Drive 데이터 불러오기', action: '불러오기' })) return;
        if (!Core.connectionIdentityMatches(latestKnownConnection(connection.id), expectedConnectionIdentity)
          || !workspaceStateIdentityMatches(latestKnownWorkspaceState(), expectedWorkspaceIdentity)) {
          throw new Error('확인하는 동안 계정 또는 이 PC의 Workspace가 변경되었습니다. 변경 내용을 보호하기 위해 불러오기를 중단했습니다.');
        }
        const saved = await globalThis.workspaceDesktop.applyPulledDriveState(connection.id, result.state, result.fileId, result.modifiedTime, expectedConnectionIdentity, expectedWorkspaceIdentity, result.etag, result.version);
        if (!saved?.state) throw new Error('Drive 데이터 적용 결과를 확인하지 못했습니다.');
        state = Core.normalizeState(saved.state); acceptPersistedBaseline(state); deferredWorkspaceState = null; driveSyncDirty = false;
        renderAll(); showToast('Drive 데이터를 불러왔습니다.', 'success');
      } catch (error) { showToast(`Drive 불러오기 실패: ${error.message}`, 'error'); }
      finally { if (reservation?.ok) await releaseExternalArtifacts(reservation.token); if (externalStarted) endExternalOperation(); }
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
    $('#renameRosterView').addEventListener('click', async () => { const project = activeProject(); const view = activeRosterView(project); if (!project || !view) return; const projectId = project.id; const viewId = view.id; const before = rosterViewMutationSignature(project); const name = await requestName('단계 명단 이름 변경', view.name); if (!name) return; const currentProject = projectById(projectId); const currentView = currentProject?.data.rosterViews.find((item) => item.id === viewId); if (activeProject()?.id !== projectId || !currentProject || !currentView || rosterViewMutationSignature(currentProject) !== before) { showToast('단계 명단이 바뀌었습니다. 이름 변경을 다시 시도해주세요.'); renderPeoplePage(); return; } currentView.name = name; currentView.updatedAt = new Date().toISOString(); state = Core.updateProject(state, currentProject.id, { data: currentProject.data }); await persist('단계 명단 이름 변경됨'); renderPeoplePage(); });
    $('#deleteRosterView').addEventListener('click', async () => { const project = activeProject(); const view = activeRosterView(project); if (!project || !view) return; const projectId = project.id; const viewId = view.id; const before = rosterViewMutationSignature(project); if (!await showConfirm(`“${view.name}” 단계 명단을 삭제할까요? 원본 명단과 일정 배정은 삭제되지 않습니다.`, { title: '단계 명단 삭제', action: '삭제' })) return; const currentProject = projectById(projectId); const currentView = currentProject?.data.rosterViews.find((item) => item.id === viewId); if (activeProject()?.id !== projectId || !currentProject || !currentView || rosterViewMutationSignature(currentProject) !== before) { showToast('단계 명단이 바뀌었습니다. 삭제를 다시 시도해주세요.'); renderPeoplePage(); return; } currentProject.data.rosterViews = currentProject.data.rosterViews.filter((item) => item.id !== viewId); currentProject.data.activeRosterViewId = null; if (currentProject.data.scheduleRules.rosterViewId === viewId) currentProject.data.scheduleRules.rosterViewId = null; state = Core.updateProject(state, currentProject.id, { data: currentProject.data }); await persist('단계 명단 삭제됨'); renderPeoplePage(); });
    $('#rosterViewSelect').addEventListener('change', async (event) => { const project = activeProject(); if (!project) return; project.data.activeRosterViewId = event.target.value || null; state = Core.updateProject(state, project.id, { data: project.data }); await persist('단계 명단 전환됨'); renderPeoplePage(); });
    $('#rosterViewPeople').addEventListener('click', async (event) => { const button = event.target.closest('[data-roster-view-toggle]'); const project = activeProject(); const view = activeRosterView(project); if (!button || !project || !view) return; const ids = new Set(view.excludedPersonIds || []); if (ids.has(button.dataset.rosterViewToggle)) ids.delete(button.dataset.rosterViewToggle); else ids.add(button.dataset.rosterViewToggle); view.excludedPersonIds = [...ids]; view.updatedAt = new Date().toISOString(); state = Core.updateProject(state, project.id, { data: project.data }); await persist('단계 명단 인원 변경됨'); renderPeoplePage(); });
    $('#rosterStartTask').addEventListener('click', openRosterTaskChooser);
    $('#arrangementNewTask').addEventListener('click', openRosterTaskChooser);
    $('#existingArrangementList').addEventListener('click', async (event) => { const button = event.target.closest('[data-open-arrangement]'); const project = activeProject(); if (!button || !project) return; project.data.activeWorkItemId = button.dataset.openArrangement; clearArrangementHistory(); state = Core.updateProject(state, project.id, { data: project.data }); closeDialog('rosterTaskChooserDialog'); navigate('arrange'); await persist(); });
    $$('[data-roster-task]').forEach((button) => button.addEventListener('click', () => {
      const task = button.dataset.rosterTask; closeDialog('rosterTaskChooserDialog');
      if (['grouping', 'matching', 'free'].includes(task)) { openArrangementSetup(task); return; }
      openWorkflowModule(task);
    }));
    $('#arrangementMethod').addEventListener('change', (event) => { $('#arrangementSourceColumn').disabled = !['same', 'mixed'].includes(event.target.value); });
    $('#arrangementSetupForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const project = activeProject(); if (!project) return; const values = { type: $('#arrangementType').value, name: $('#arrangementName').value.trim(), method: $('#arrangementMethod').value, groupSize: $('#arrangementGroupSize').value, sourceColumnId: $('#arrangementSourceColumn').value };
      if (!values.name) return; createArrangement(project, values); state = Core.updateProject(state, project.id, { data: project.data }); closeDialog('arrangementSetupDialog'); clearArrangementHistory(); renderAll(); navigate('arrange'); await persist('새 명단 작업 생성됨');
    });
    $('#arrangementSelect').addEventListener('change', async (event) => { const project = activeProject(); if (!project) return; project.data.activeWorkItemId = event.target.value; clearArrangementHistory(); state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderArrangementPage(); });
    $('#arrangementDelete').addEventListener('click', async () => {
      const project = activeProject(); const item = activeWorkItem(project); if (!project || !item) return; const projectId = project.id; const itemId = item.id; const before = arrangementSnapshot(item);
      if (!await showConfirm(`“${item.name}” 작업표를 삭제할까요? 원본 명단은 삭제되지 않습니다.`, { title: '명단 작업 삭제', action: '삭제' })) return;
      const currentProject = projectById(projectId); const currentItem = currentProject?.data.workItems.find((candidate) => candidate.id === itemId);
      if (activeProject()?.id !== projectId || !currentItem || arrangementSnapshot(currentItem) !== before) { showToast('작업표가 바뀌었습니다. 삭제를 다시 시도해주세요.'); renderArrangementPage(); return; }
      currentProject.data.workItems = currentProject.data.workItems.filter((candidate) => candidate.id !== itemId); currentProject.data.activeWorkItemId = currentProject.data.workItems.at(-1)?.id || null; clearArrangementHistory(); state = Core.updateProject(state, currentProject.id, { data: currentProject.data }); await persist('명단 작업 삭제됨'); if (currentProject.data.activeWorkItemId) renderArrangementPage(); else navigate('people');
    });
    $('#arrangementImportExcel').addEventListener('click', async () => {
      const project = activeProject(); const item = activeWorkItem(project); if (!project || !item || !globalThis.workspaceDesktop?.chooseSpreadsheet) return; const projectId = project.id; const itemId = item.id; const before = arrangementSnapshot(item);
      try {
        const result = await globalThis.workspaceDesktop.chooseSpreadsheet(); if (result.canceled || !result.matrix?.length) return;
        if (!await showConfirm('Excel의 첫 행을 컬럼 이름으로 사용하여 현재 작업표를 교체할까요? 원본 명단은 바뀌지 않습니다.', { title: '작업표 Excel 불러오기', action: '교체', danger: false })) return;
        const currentProject = projectById(projectId); const currentItem = currentProject?.data.workItems.find((candidate) => candidate.id === itemId);
        if (activeProject()?.id !== projectId || !currentItem || arrangementSnapshot(currentItem) !== before) { showToast('작업표가 바뀌었습니다. Excel 불러오기를 다시 시도해주세요.'); renderArrangementPage(); return; }
        const width = Math.max(...result.matrix.map((row) => row.length)); currentItem.columns = Array.from({ length: width }, (_, index) => ({ id: `work-column-${Date.now().toString(36)}-${index}`, name: String(result.matrix[0]?.[index] || `컬럼${index + 1}`) })); currentItem.rows = result.matrix.slice(1).filter((row) => row.some((value) => String(value || '').trim())).map((row, rowIndex) => ({ id: `work-row-${Date.now().toString(36)}-${rowIndex}`, personId: null, values: Object.fromEntries(currentItem.columns.map((column, index) => [column.id, String(row[index] ?? '')])) })); currentItem.updatedAt = new Date().toISOString(); clearArrangementHistory(); state = Core.updateProject(state, currentProject.id, { data: currentProject.data }); await persist('Excel 작업표 불러옴'); renderArrangementPage();
      } catch (error) { showToast(`Excel을 불러오지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#arrangementDownloadCsv').addEventListener('click', async () => { const item = activeWorkItem(); if (!item) return; if (globalThis.workspaceDesktop?.exportWorkItem) { try { const result = await globalThis.workspaceDesktop.exportWorkItem(item); if (!result.canceled) showToast('작업표를 Excel로 저장했습니다.', 'success'); } catch (error) { showToast(`Excel을 저장하지 못했습니다: ${error.message}`, 'error'); } return; } const rows = [item.columns.map((column) => column.name), ...item.rows.map((row) => item.columns.map((column) => row.values[column.id] || ''))]; const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n'); downloadText(`${item.name}.csv`, `\ufeff${csv}`, 'text/csv;charset=utf-8'); });
    $('#addRoleButton').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      createProjectRole(project, `새 역할 ${project.data.roles.length + 1}`);
      refreshScheduleConflicts(project); syncScheduleProjectState(project, `역할 추가 · 문제 ${project.data.conflicts.length}건`); await persist('일정 역할 추가됨'); renderSchedulePage();
    });
    $('#addSlotsButton').addEventListener('click', async () => {
      await flushSchedulePersist(); const project = activeProject(); if (!project) return;
      const parsed = Ops.parseSlots($('#slotBulkInput').value);
      $('#slotParseErrors').hidden = parsed.errors.length === 0;
      $('#slotParseErrors').textContent = parsed.errors.join('\n');
      if (!parsed.slots.length) { if (!parsed.errors.length) showToast('추가할 시간대를 입력해주세요.', 'error'); return; }
      const keys = new Set(project.data.slots.map(Ops.slotKey));
      const additions = parsed.slots.filter((slot) => !keys.has(Ops.slotKey(slot)));
      if (!additions.length) { showToast('이미 있는 시간대입니다.'); return; }
      pushScheduleHistory(project);
      project.data.slots.push(...additions);
      refreshScheduleConflicts(project); syncScheduleProjectState(project, `시간대 추가 · 문제 ${project.data.conflicts.length}건`);
      await persist(); renderAll(); $('#slotBulkInput').value = '';
      showToast(`${additions.length}개 시간대를 추가했습니다.`, 'success');
    });
    $('#clearSlotsButton').addEventListener('click', async () => {
      await flushSchedulePersist(); let project = activeProject(); if (!project || !project.data.slots.length) return; const projectId = project.id;
      if (hasLockedSchedule(project)) { showToast('잠긴 세션 또는 배정이 있습니다. 잠금을 해제한 뒤 전체 삭제해주세요.', 'error'); return; }
      const confirmSignature = scheduleChangeSignature(project);
      if (!await showConfirm('모든 시간대와 현재 배정을 지울까요?', { title: '시간대 전체 삭제', action: '삭제' })) return;
      project = projectById(projectId); if (!project || scheduleChangeSignature(project) !== confirmSignature) { showToast('다른 창의 일정 변경을 반영했습니다. 전체 삭제를 다시 눌러주세요.'); renderSchedulePage(); return; }
      const beforeSnapshot = scheduleSnapshot(project); pushScheduleHistory(project); project.data.slots = []; project.data.availability = {}; project.data.assignments = []; refreshScheduleConflicts(project);
      const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, '모든 시간대 삭제', impact); await persist(); renderAll();
    });
    $('#generateScheduleButton').addEventListener('click', () => void generateSchedule());
    $('#saveScheduleVersion').addEventListener('click', () => void saveScheduleSnapshot());
    $('#layoutType').addEventListener('change', async (event) => {
      const project = activeProject(); if (!project) return;
      project.data.layout.type = event.target.value; state = Core.updateProject(state, project.id, { data: project.data }); renderLayoutPage(); await persist('일정표 형태 저장됨');
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
      let project = activeProject(); if (!project) return;
      let definition = project.data.forms.definitions.at(-1);
      let connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'forms') && item.type === 'forms' && item.status === 'connected');
      if (!definition) { showToast('먼저 “설문 내용 미리 만들기”를 눌러 질문을 확인해주세요.', 'error'); return; }
      if (!connection) { showToast('설문을 만들 Google 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      const projectId = project.id; const definitionId = definition.id; const confirmationSignature = externalOperationSignature(project, 'googleForm');
      if (!await showConfirm(`“${definition.title}” 설문을 ${connection.account || connection.label} 계정에 만들까요?`, { title: 'Google 설문 만들기', action: '설문 만들기' })) return;
      project = projectById(projectId); definition = project?.data.forms.definitions.find((item) => item.id === definitionId); connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'forms') && item.type === 'forms' && item.status === 'connected');
      if (!project || !definition || !connection || externalOperationSignature(project, 'googleForm') !== confirmationSignature) { showToast('확인하는 동안 설문 내용이나 프로젝트 상태가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      let reservation; let connectionReservation;
      try { reservation = await reserveExternalArtifacts(projectId, 'googleForm', ['forms']); }
      catch (error) { showToast(`Google 설문 작업을 시작하지 못했습니다: ${error.message}`, 'error'); return; }
      if (!reservation.ok) { showToast('다른 창에서 이 프로젝트의 Google 설문을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
      try { connectionReservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connection.id]); }
      catch (error) { await releaseExternalArtifacts(reservation.token); showToast(`Google 계정을 사용할 수 없습니다: ${error.message}`, 'error'); return; }
      if (!connectionReservation.ok) { await releaseExternalArtifacts(reservation.token); showToast('다른 창에서 같은 Google 계정을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
      project = projectById(projectId); definition = project?.data.forms.definitions.find((item) => item.id === definitionId); connection = state.connections.find((item) => item.id === connection.id && item.type === 'forms' && item.status === 'connected');
      if (!project || !definition || !connection || externalOperationStateChanged(projectId, 'googleForm', confirmationSignature)) { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); showToast('설문 생성 준비 중 관련 내용이나 계정이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      beginExternalOperation(); let created = null;
      try {
        const baseSignature = externalOperationSignature(project, 'googleForm'); const expectedConnectionIdentity = Core.connectionIdentity(connection);
        created = await globalThis.workspaceDesktop.createGoogleForm(connection.id, definition, Ops.googleFormsApiRequests(definition), expectedConnectionIdentity);
        const connectionChanged = !Core.connectionIdentityMatches(latestKnownConnection(connection.id), expectedConnectionIdentity);
        const changedDuringCreate = externalOperationStateChanged(projectId, 'googleForm', baseSignature) || connectionChanged;
        const latestProject = latestKnownProject(projectId); if (!latestProject) throw new Error('생성한 설문을 연결할 프로젝트를 찾지 못했습니다.');
        const forms = cloneState(latestProject.data.forms);
        if (!forms.linkedForms.some((item) => item.formId === created.formId)) forms.linkedForms.push({ ...created, definitionId: definition.id, type: definition.type, title: definition.title, source: 'created', connectionId: connection.id, connectedAt: new Date().toISOString(), expectedConnectionIdentity, needsReview: changedDuringCreate });
        forms.selectedFormId = created.formId;
        state = Core.updateProject(state, projectId, { data: { forms } });
        state = Core.setModuleStatus(state, projectId, 'forms', changedDuringCreate ? 'needsReview' : 'inProgress', changedDuringCreate ? `${definition.title} 생성됨 · 도중 변경사항 확인 필요` : `${definition.title} 생성됨`);
        recordScheduleMergeImpact(projectId, null, { scheduleOnly: false });
        let conflictState = cloneState(state);
        const conflictProject = conflictState.projects.find((item) => item.id === projectId) || Object.values(conflictState.quickWorkspaces || {}).find((item) => item?.id === projectId);
        const conflictReason = 'Google 설문 생성 후 프로젝트 또는 계정이 바뀌어 연결 확인 필요';
        if (conflictProject) {
          conflictProject.data.forms.linkedForms = conflictProject.data.forms.linkedForms.map((item) => item.formId === created.formId ? { ...item, needsReview: true, reviewReason: conflictReason } : item);
          conflictState = Core.updateProject(conflictState, projectId, { data: { forms: conflictProject.data.forms } });
          conflictState = Core.setModuleStatus(conflictState, projectId, 'forms', 'needsReview', conflictReason);
        }
        const commitResult = await persist('Google 설문 연결 저장됨', {
          externalCommit: externalCommitGuard({ reservation, project: latestProject, kind: 'googleForm', expectedConnections: [expectedConnectionIdentity], conflictState })
        });
        renderAll();
        if (commitResult?.externalConflict) showToast('Google 설문은 생성됐지만 그 사이 프로젝트 또는 계정이 바뀌어 연결을 확인 필요 상태로 저장했습니다.', 'error');
        else showToast(changedDuringCreate ? '설문은 생성했지만 도중 프로젝트가 바뀌어 연결 내용을 확인 대상으로 표시했습니다.' : 'Google 설문을 만들고 이 프로젝트에 연결했습니다.', changedDuringCreate ? 'normal' : 'success');
      } catch (error) { showToast(created ? `Google 설문은 생성됐지만 프로젝트 연결을 저장하지 못했습니다: ${error.message}` : `Google 설문을 만들지 못했습니다: ${error.message}`, 'error'); }
      finally { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
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
      if (!project.data.forms.linkedForms.some((item) => item.formId === formId)) project.data.forms.linkedForms.push({ formId, type: $('#formDefinitionType').value, source: 'manual', connectionId: defaultConnectionId(project, 'forms') || '', connectedAt: new Date().toISOString() });
      project.data.forms.selectedFormId = formId;
      state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); showToast('기존 Google Form을 프로젝트에 연결했습니다.', 'success');
    });
    $('#linkedFormSelect').addEventListener('change', async (event) => {
      const project = activeProject(); if (!project) return;
      project.data.forms.selectedFormId = event.target.value || null;
      state = Core.updateProject(state, project.id, { data: project.data });
      await persist('사용할 Google 설문 선택됨'); renderFormsPage();
    });
    $('#removeLinkedForm').addEventListener('click', async () => {
      let project = activeProject(); const linked = selectedLinkedForm(project); if (!project || !linked) return;
      const projectId = project.id; const formId = linked.formId; const signature = externalOperationSignature(project, 'googleForm');
      if (!await showConfirm('선택한 Google 설문 연결을 이 프로젝트에서 해제할까요? Google 계정에 있는 실제 설문과 응답은 삭제하지 않습니다.', { title: 'Google 설문 연결 해제', action: '연결 해제' })) return;
      project = projectById(projectId);
      if (!project || externalOperationSignature(project, 'googleForm') !== signature || !project.data.forms.linkedForms.some((item) => item.formId === formId)) { showToast('확인하는 동안 설문 연결이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderFormsPage(); return; }
      project.data.forms.linkedForms = project.data.forms.linkedForms.filter((item) => item.formId !== formId);
      project.data.forms.selectedFormId = project.data.forms.linkedForms.at(-1)?.formId || null;
      state = Core.updateProject(state, project.id, { data: project.data });
      if (project.installedModules.includes('forms')) state = Core.setModuleStatus(state, project.id, 'forms', 'inProgress', project.data.forms.linkedForms.length ? `연결된 설문 ${project.data.forms.linkedForms.length}개` : '연결된 설문 없음');
      recordScheduleMergeImpact(project.id, null, { scheduleOnly: false });
      await persist('Google 설문 연결 해제됨'); renderAll(); showToast('프로젝트 연결만 해제했습니다. Google 설문은 그대로 남아 있습니다.', 'success');
    });
    $('#syncFormResponses').addEventListener('click', async () => {
      let project = activeProject(); if (!project) return;
      let linked = selectedLinkedForm(project);
      if (!linked) { showToast('응답을 가져올 Google 설문을 먼저 이 프로젝트에 연결해주세요.', 'error'); return; }
      let connection = state.connections.find((item) => item.id === (linked.connectionId || defaultConnectionId(project, 'forms')) && item.type === 'forms');
      if (!connection || connection.status !== 'connected') { showToast('선택한 설문의 응답을 가져올 Google 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      const connectionId = connection.id;
      const projectId = project.id; const formId = linked.formId; const baseSignature = externalOperationSignature(project, 'googleForm');
      let reservation; let connectionReservation;
      try { reservation = await reserveExternalArtifacts(projectId, 'googleForm', ['forms']); }
      catch (error) { showToast(`Google 설문 응답 작업을 시작하지 못했습니다: ${error.message}`, 'error'); return; }
      if (!reservation.ok) { showToast('다른 창에서 이 프로젝트의 Google 설문을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
      try { connectionReservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connectionId]); }
      catch (error) { await releaseExternalArtifacts(reservation.token); showToast(`Google 계정을 사용할 수 없습니다: ${error.message}`, 'error'); return; }
      if (!connectionReservation.ok) { await releaseExternalArtifacts(reservation.token); showToast('다른 창에서 같은 Google 계정을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
      project = projectById(projectId); linked = project?.data.forms.linkedForms.find((item) => item.formId === formId); connection = state.connections.find((item) => item.id === connectionId && item.type === 'forms' && item.status === 'connected');
      if (!project || !linked || !connection || externalOperationStateChanged(projectId, 'googleForm', baseSignature)) { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); showToast('응답을 가져오기 전에 설문·프로젝트 또는 계정 상태가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      beginExternalOperation();
      try {
        const expectedConnectionIdentity = Core.connectionIdentity(connection);
        const payload = await globalThis.workspaceDesktop.fetchGoogleFormResponses(connection.id, linked.formId, expectedConnectionIdentity);
        if (externalOperationStateChanged(projectId, 'googleForm', baseSignature) || !Core.connectionIdentityMatches(latestKnownConnection(connection.id), expectedConnectionIdentity)) { showToast('응답을 가져오는 동안 명단·일정·설문 연결 또는 Google 계정이 바뀌었습니다. 변경 내용을 보호하기 위해 응답을 적용하지 않았으니 다시 동기화해주세요.', 'error'); renderAll(); return; }
        const latestProject = latestKnownProject(projectId); if (!latestProject) throw new Error('응답을 반영할 프로젝트를 찾지 못했습니다.');
        let conflictState = cloneState(latestKnownWorkspaceState());
        conflictState = Core.setModuleStatus(conflictState, projectId, 'forms', 'needsReview', 'Google 설문 응답을 가져온 뒤 프로젝트 또는 계정이 바뀌어 응답을 적용하지 않음');
        const workingProject = cloneState(latestProject); const workingLinked = workingProject.data.forms.linkedForms.find((item) => item.formId === formId); if (!workingLinked) throw new Error('연결된 Google 설문을 찾지 못했습니다.');
        const result = Ops.applyGoogleFormResponses(workingProject, workingLinked, payload);
        workingProject.data.forms.selectedFormId = formId; workingLinked.connectionId ||= connectionId;
        workingProject.data.forms.lastResponseSyncAt = new Date().toISOString(); workingLinked.lastSyncedAt = workingProject.data.forms.lastResponseSyncAt; workingLinked.responseCount = payload.responses.length; workingLinked.needsReview = Boolean(result.unmatched);
        if (result.changed) { clearRosterHistory(); markRosterDependenciesStale(workingProject, result.type === 'availability' ? '가능 시간 응답 반영 후 일정 재검토 필요' : '설문 신청 명단 반영 후 일정 재검토 필요'); }
        else state = Core.updateProject(state, projectId, { data: workingProject.data });
        state = Core.setModuleStatus(state, projectId, 'forms', result.unmatched ? 'needsReview' : 'inProgress', result.unmatched ? `${payload.responses.length}건 동기화 · ${result.unmatched}건 확인 필요` : `${payload.responses.length}건 동기화`);
        recordScheduleMergeImpact(projectId, null, { scheduleOnly: false });
        const commitResult = await persist('설문 응답 동기화됨', {
          externalCommit: externalCommitGuard({ reservation, project: latestProject, kind: 'googleForm', expectedConnections: [expectedConnectionIdentity], conflictState })
        });
        renderAll();
        if (commitResult?.externalConflict) showToast('설문 응답은 가져왔지만 그 사이 프로젝트 또는 계정이 바뀌어 응답을 적용하지 않고 확인 필요 상태로 남겼습니다.', 'error');
        else showToast(result.message, result.unmatched ? 'normal' : 'success');
      } catch (error) { showToast(`최신 설문 응답을 가져오지 못했습니다: ${error.message}`, 'error'); }
      finally { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
    });
    $('#prepareZoomMeetings').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const problems = [];
      const activeSlots = project.data.slots.filter((slot) => slot.status !== 'cancelled');
      const cancelledWithMeeting = project.data.slots.filter((slot) => slot.status === 'cancelled' && project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status !== 'superseded')).length;
      activeSlots.forEach((slot) => {
        const connectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
        const connection = state.connections.find((item) => item.id === connectionId && item.type === 'zoom');
        if (!connection) problems.push(`${Ops.slotKey(slot)} · Zoom 계정 미지정`);
        else if (connection.status !== 'connected') problems.push(`${Ops.slotKey(slot)} · ${connection.label} 로그인 필요`);
        if (!project.data.assignments.some((assignment) => assignment.slotId === slot.id)) problems.push(`${Ops.slotKey(slot)} · 배정 인원 없음`);
      });
      const cancelledNotice = cancelledWithMeeting ? `\n취소 일정 ${cancelledWithMeeting}건의 기존 회의는 Zoom에서 직접 취소해주세요.` : '';
      const message = `${problems.length ? problems.slice(0, 20).join('\n') : `${activeSlots.length}개 회의를 생성할 준비가 되었습니다.`}${cancelledNotice}`;
      $('#zoomReadiness').textContent = message;
      const reviewCount = problems.length + cancelledWithMeeting;
      state = Core.setModuleStatus(state, project.id, 'zoom', reviewCount ? 'needsReview' : 'inProgress', reviewCount ? `${reviewCount}건 확인 필요` : '회의를 만들 준비 완료');
      await persist(); renderDashboard();
      showToast(reviewCount ? `Zoom 회의를 만들거나 정리하기 전에 확인할 항목이 ${reviewCount}건 있습니다.` : '모든 일정에 Zoom 회의를 만들 준비가 되었습니다.', reviewCount ? 'normal' : 'success');
    });
    $('#createZoomMeetings').addEventListener('click', async () => {
      let project = activeProject(); if (!project) return;
      let pending = pendingZoomSlots(project);
      let invalid = pending.filter((slot) => Ops.validateScheduleSlot(slot).length || !state.connections.some((item) => item.id === (slot.zoomConnectionId || defaultConnectionId(project, 'zoom')) && item.type === 'zoom' && item.status === 'connected'));
      if (!pending.length) { showToast('새로 생성할 Zoom 회의가 없습니다.'); return; }
      if (invalid.length) { showToast(`날짜·시간 또는 Zoom 로그인을 확인해야 하는 일정 ${invalid.length}건을 먼저 수정해주세요.`, 'error'); return; }
      const replacementCount = pending.filter((slot) => project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id)).length;
      const replacementNotice = replacementCount ? ` 이 중 ${replacementCount}건은 일정이 바뀌어 새 회의를 만들며, 이전 회의는 Zoom에서 직접 정리해야 합니다.` : ' 이미 정상 참가 링크가 있는 일정은 건너뜁니다.';
      const projectId = project.id; const confirmationSignature = externalOperationSignature(project, 'zoom');
      if (!await approveExternalChange(project, `${pending.length}개의 Zoom 회의를 만들까요?${replacementNotice}`, { title: 'Zoom 회의 만들기', action: '회의 만들기' })) return;
      project = projectById(projectId); pending = project ? pendingZoomSlots(project) : [];
      if (!project || externalOperationSignature(project, 'zoom') !== confirmationSignature) { showToast('확인하는 동안 다른 창의 일정 또는 회의 상태가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      invalid = pending.filter((slot) => Ops.validateScheduleSlot(slot).length || !state.connections.some((item) => item.id === (slot.zoomConnectionId || defaultConnectionId(project, 'zoom')) && item.type === 'zoom' && item.status === 'connected'));
      if (!pending.length || invalid.length) { showToast(invalid.length ? '최신 일정의 날짜·시간 또는 Zoom 로그인을 다시 확인해주세요.' : '다른 창에서 회의 생성이 완료되어 새로 만들 회의가 없습니다.', invalid.length ? 'error' : 'normal'); renderZoomPage(); return; }
      let reservation;
      try { reservation = await reserveExternalArtifacts(projectId, 'zoom', pending.map((slot) => slot.id)); }
      catch (error) { showToast(`회의 생성 작업을 시작하지 못했습니다: ${error.message}`, 'error'); return; }
      if (!reservation.ok) { showToast('다른 창에서 같은 Zoom 회의를 만들고 있습니다. 완료된 뒤 다시 확인해주세요.'); return; }
      project = projectById(projectId); pending = project ? pendingZoomSlots(project) : [];
      if (!project || externalOperationStateChanged(projectId, 'zoom', confirmationSignature)) { await releaseExternalArtifacts(reservation.token); showToast('회의 생성 준비 중 일정 또는 프로젝트 정보가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      beginExternalOperation();
      try {
        const baseSignature = externalOperationSignature(project, 'zoom'); const createdArtifacts = []; let createdCount = 0; const failures = [];
        for (const slot of pending) {
          const latestBeforeCreate = projectById(projectId);
          if (!latestBeforeCreate || externalOperationStateChanged(projectId, 'zoom', baseSignature)) break;
          const connectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
          const zoomConnection = state.connections.find((item) => item.id === connectionId && item.type === 'zoom' && item.status === 'connected');
          const duration = Ops.timeToMinutes(slot.endTime) - Ops.timeToMinutes(slot.startTime);
          try {
            if (!zoomConnection) throw new Error('Zoom 계정의 최신 로그인 상태를 확인해주세요.');
            const meeting = await globalThis.workspaceDesktop.createZoomMeeting(connectionId, { topic: `${project.name}${slot.label ? ` · ${slot.label}` : ''}`, date: slot.date, startTime: slot.startTime, duration, timezone: 'Asia/Seoul', agenda: `${project.name} 일정` }, Core.connectionIdentity(zoomConnection));
            createdArtifacts.push({ kind: 'zoom', slotId: slot.id, connectionId, status: 'created', externalId: String(meeting.id), joinUrl: meeting.join_url || '', startUrl: meeting.start_url || '', password: meeting.password || '', createdAt: new Date().toISOString(), expectedConnectionIdentity: Core.connectionIdentity(zoomConnection) });
            createdCount += 1; $('#zoomReadiness').textContent = `${createdCount}/${pending.length} 생성 완료`;
          } catch (error) { failures.push(`${Ops.slotKey(slot)}: ${error.message}`); }
        }
        const currentProject = latestKnownProject(projectId);
        if (!currentProject) throw new Error('회의 생성 결과를 반영할 프로젝트를 찾지 못했습니다.');
        const scheduleChanged = externalOperationStateChanged(projectId, 'zoom', baseSignature);
        const artifacts = currentProject.data.externalArtifacts.map((item) => ({ ...item }));
        createdArtifacts.forEach(({ expectedConnectionIdentity, ...artifact }) => {
          const connectionChanged = !Core.connectionIdentityMatches(latestKnownConnection(artifact.connectionId), expectedConnectionIdentity);
          if (!scheduleChanged && !connectionChanged) artifacts.filter((item) => item.kind === 'zoom' && item.slotId === artifact.slotId && item.status !== 'superseded').forEach((item) => {
            item.status = 'superseded'; item.replacedAt ||= new Date().toISOString(); item.replacementReason ||= '선택한 Zoom 계정으로 새 회의가 생성됨'; item.replacementConnectionId = artifact.connectionId;
          });
          artifacts.push(connectionChanged
            ? { ...artifact, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: 'Zoom 계정 변경 후 이전 계정에 생성된 회의' }
            : { ...artifact, status: scheduleChanged ? 'stale' : 'created' });
        });
        const unresolved = artifacts.some((item) => item.kind === 'zoom' && item.status === 'stale') || currentProject.data.slots.some((slot) => slot.status === 'cancelled' && artifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status !== 'superseded'));
        state = Core.updateProject(state, projectId, { data: { externalArtifacts: artifacts } });
        state = Core.setModuleStatus(state, projectId, 'zoom', failures.length || scheduleChanged || unresolved ? 'needsReview' : 'complete', scheduleChanged ? `${createdCount}개 생성 · 도중 일정 변경으로 재확인 필요` : failures.length ? `${createdCount}개 생성, ${failures.length}개 실패` : unresolved ? `${createdCount}개 생성 · 기존 회의 정리 필요` : `${createdCount}개 생성 완료`);
        const conflictReason = 'Zoom 생성 결과를 저장하는 동안 프로젝트 또는 계정이 바뀌어 회의 확인 필요';
        const conflictState = markExternalArtifactsForCommitConflict(state, projectId, 'zoom', createdArtifacts, conflictReason);
        const commitResult = await persist('Zoom 생성 결과 저장됨', {
          externalCommit: externalCommitGuard({ reservation, project: currentProject, kind: 'zoom', expectedConnections: createdArtifacts.map((item) => item.expectedConnectionIdentity), conflictState })
        });
        renderAll();
        if (commitResult?.externalConflict) showToast(createdCount ? 'Zoom 회의는 생성됐지만 그 사이 프로젝트 또는 계정이 바뀌어 프로젝트에는 확인 필요 상태로 남겼습니다.' : 'Zoom 생성 결과를 저장하는 사이 프로젝트 또는 계정이 바뀌어 프로젝트를 확인 필요 상태로 남겼습니다.', 'error');
        else showToast(scheduleChanged ? '회의 생성 중 일정이 바뀌어 새 회의를 확인 대상으로 표시했습니다.' : failures.length ? `Zoom ${createdCount}개 생성, ${failures.length}개 실패` : `Zoom 회의 ${createdCount}개를 생성했습니다.`, scheduleChanged || failures.length ? 'error' : unresolved ? 'normal' : 'success');
      } finally { await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
    });
    $('#prepareMailPackage').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const previousSubject = project.data.communication.subjectTemplate; const previousHtml = project.data.communication.bodyHtmlTemplate;
      project.data.communication.subjectTemplate = $('#mailSubjectTemplate').value;
      project.data.communication.bodyHtmlTemplate = sanitizeRichHtml($('#mailBodyEditor').innerHTML);
      project.data.communication.bodyTemplate = richText(project.data.communication.bodyHtmlTemplate);
      if (previousSubject !== project.data.communication.subjectTemplate || previousHtml !== project.data.communication.bodyHtmlTemplate) project.data.externalArtifacts.filter((item) => item.kind === 'gmailDraft' && item.status !== 'superseded').forEach((item) => { item.status = 'stale'; });
      project.data.communication.lastPreparedAt = new Date().toISOString();
      mailEditorDirty = false;
      const pkg = Ops.buildMailPackage(project);
      state = Core.updateProject(state, project.id, { data: project.data });
      state = Core.setModuleStatus(state, project.id, 'gmailFlow', pkg.entries.length ? 'inProgress' : 'needsReview', `${pkg.entries.length}명 메일 준비`);
      await persist(); renderAll(); showToast(`${pkg.entries.length}명의 메일 데이터를 준비했습니다.`, 'success');
    });
    $('#createGmailDrafts').addEventListener('click', async () => {
      let project = activeProject(); if (!project) return;
      const previousSubject = project.data.communication.subjectTemplate; const previousHtml = project.data.communication.bodyHtmlTemplate;
      project.data.communication.subjectTemplate = $('#mailSubjectTemplate').value;
      project.data.communication.bodyHtmlTemplate = sanitizeRichHtml($('#mailBodyEditor').innerHTML); project.data.communication.bodyTemplate = richText(project.data.communication.bodyHtmlTemplate);
      if (previousSubject !== project.data.communication.subjectTemplate || previousHtml !== project.data.communication.bodyHtmlTemplate) project.data.externalArtifacts.filter((item) => item.kind === 'gmailDraft' && item.status !== 'superseded').forEach((item) => { item.status = 'stale'; });
      mailEditorDirty = false; mailEditorProjectId = project.id;
      state = Core.updateProject(state, project.id, { data: project.data }); await persist('메일 편집 저장됨');
      project = projectById(project.id); if (!project) return;
      let connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'gmail') && item.type === 'gmail' && item.status === 'connected');
      let pending = pendingGmailEntries(project);
      if (!pending.length) { showToast('새로 Gmail 임시보관함에 만들 메일이 없습니다.'); return; }
      if (!connection) { showToast('이 프로젝트에서 사용할 기본 Gmail 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      const projectId = project.id; const confirmationSignature = externalOperationSignature(project, 'gmailDraft');
      if (!await approveExternalChange(project, `${pending.length}명의 메일을 Gmail 임시보관함에 만들거나 기존 내용을 수정할까요? 아직 실제 발송은 하지 않습니다.`, { title: 'Gmail 임시보관함에 저장', action: '저장하기' })) return;
      project = projectById(projectId); pending = project ? pendingGmailEntries(project) : [];
      if (!project || externalOperationSignature(project, 'gmailDraft') !== confirmationSignature) { showToast('확인하는 동안 다른 창의 명단·일정 또는 메일 상태가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'gmail') && item.type === 'gmail' && item.status === 'connected');
      if (!pending.length || !connection) { showToast(!connection ? '프로젝트 기본 Gmail 계정의 최신 로그인 상태를 다시 확인해주세요.' : '다른 창에서 메일 저장이 완료되어 새로 처리할 메일이 없습니다.', !connection ? 'error' : 'normal'); return; }
      let reservation;
      try { reservation = await reserveExternalArtifacts(projectId, 'gmailDraft', pending.map((entry) => entry.personId)); }
      catch (error) { showToast(`Gmail 저장 작업을 시작하지 못했습니다: ${error.message}`, 'error'); return; }
      if (!reservation.ok) { showToast('다른 창에서 같은 Gmail 임시보관함 메일을 저장하고 있습니다. 완료된 뒤 다시 확인해주세요.'); return; }
      project = projectById(projectId); pending = project ? pendingGmailEntries(project) : [];
      if (!project || externalOperationStateChanged(projectId, 'gmailDraft', confirmationSignature)) { await releaseExternalArtifacts(reservation.token); showToast('Gmail 저장 준비 중 명단·일정 또는 메일 내용이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      beginExternalOperation();
      try {
        const baseSignature = externalOperationSignature(project, 'gmailDraft'); const artifactUpdates = []; let createdCount = 0; let updatedCount = 0; const failures = [];
        for (const initialEntry of pending) {
          const latestBeforeSave = projectById(projectId);
          if (!latestBeforeSave || externalOperationStateChanged(projectId, 'gmailDraft', baseSignature)) break;
          const entry = Ops.buildMailPackage(latestBeforeSave).entries.find((item) => item.personId === initialEntry.personId);
          if (!entry) break;
          try {
            const artifact = latestActiveExternalArtifact(latestBeforeSave, 'gmailDraft', (item) => item.personId === entry.personId && item.connectionId === connection.id);
            if (artifact) {
              const artifactConnection = state.connections.find((item) => item.id === artifact.connectionId && item.type === 'gmail' && item.status === 'connected');
              if (!artifactConnection) throw new Error('기존 메일을 만든 Gmail 계정에 다시 로그인해야 합니다.');
              const draft = await globalThis.workspaceDesktop.updateGmailDraft(artifactConnection.id, artifact.externalId, entry, Core.connectionIdentity(artifactConnection));
              artifactUpdates.push({ ...artifact, messageId: draft.message?.id || artifact.messageId, status: 'created', updatedAt: new Date().toISOString(), expectedConnectionIdentity: Core.connectionIdentity(artifactConnection) }); updatedCount += 1;
            } else {
              const draft = await globalThis.workspaceDesktop.createGmailDraft(connection.id, entry, Core.connectionIdentity(connection));
              artifactUpdates.push({ kind: 'gmailDraft', personId: entry.personId, connectionId: connection.id, status: 'created', externalId: draft.id, messageId: draft.message?.id || '', createdAt: new Date().toISOString(), expectedConnectionIdentity: Core.connectionIdentity(connection) }); createdCount += 1;
            }
            $('#mailPackageStatus').textContent = `${createdCount + updatedCount}/${pending.length} Gmail 저장 완료`;
          } catch (error) { failures.push(`${entry.email}: ${error.message}`); }
        }
        const currentProject = latestKnownProject(projectId);
        if (!currentProject) throw new Error('메일 생성 결과를 반영할 프로젝트를 찾지 못했습니다.');
        const scheduleChanged = externalOperationStateChanged(projectId, 'gmailDraft', baseSignature);
        let artifacts = currentProject.data.externalArtifacts.map((item) => ({ ...item }));
        const resolvedUpdates = artifactUpdates.map(({ expectedConnectionIdentity, ...item }) => {
          if (!Core.connectionIdentityMatches(latestKnownConnection(item.connectionId), expectedConnectionIdentity)) return { ...item, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: 'Gmail 계정 변경 후 이전 계정에 저장된 메일' };
          return scheduleChanged ? { ...item, status: 'stale' } : item;
        });
        resolvedUpdates.filter((item) => item.status === 'created').forEach((item) => {
          artifacts = artifacts.map((artifact) => artifact.kind === 'gmailDraft' && artifact.personId === item.personId && artifact.status !== 'superseded' && artifact.connectionId !== item.connectionId
            ? { ...artifact, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: '프로젝트 기본 Gmail 계정 변경 후 새 계정에 다시 저장됨', replacementConnectionId: item.connectionId }
            : artifact);
        });
        artifacts = mergeExternalArtifactUpdates(artifacts, resolvedUpdates);
        const communication = { ...currentProject.data.communication, lastPreparedAt: new Date().toISOString() };
        const unresolved = artifacts.some((item) => item.kind === 'gmailDraft' && item.status === 'stale');
        state = Core.updateProject(state, projectId, { data: { communication, externalArtifacts: artifacts } });
        state = Core.setModuleStatus(state, projectId, 'gmailFlow', failures.length || scheduleChanged || unresolved ? 'needsReview' : 'complete', scheduleChanged ? `${createdCount}개 생성, ${updatedCount}개 수정 · 도중 일정 변경으로 재확인 필요` : failures.length ? `${createdCount}개 생성, ${updatedCount}개 수정, ${failures.length}개 실패` : unresolved ? `${createdCount}개 생성, ${updatedCount}개 수정 · 남은 메일 확인 필요` : `${createdCount}개 생성, ${updatedCount}개 수정`);
        const conflictReason = 'Gmail 저장 결과를 반영하는 동안 프로젝트 또는 계정이 바뀌어 메일 확인 필요';
        const conflictState = markExternalArtifactsForCommitConflict(state, projectId, 'gmailDraft', artifactUpdates, conflictReason);
        const commitResult = await persist('Gmail 저장 결과 반영됨', {
          externalCommit: externalCommitGuard({ reservation, project: currentProject, kind: 'gmailDraft', expectedConnections: artifactUpdates.map((item) => item.expectedConnectionIdentity), conflictState })
        });
        renderAll();
        if (commitResult?.externalConflict) showToast(createdCount + updatedCount ? 'Gmail 임시보관함에는 저장됐지만 그 사이 프로젝트 또는 계정이 바뀌어 프로젝트에는 확인 필요 상태로 남겼습니다.' : 'Gmail 저장 결과를 반영하는 사이 프로젝트 또는 계정이 바뀌어 프로젝트를 확인 필요 상태로 남겼습니다.', 'error');
        else showToast(scheduleChanged ? '메일 저장 중 일정이 바뀌어 해당 초안을 확인 대상으로 표시했습니다.' : failures.length ? `Gmail 임시보관함: 새 메일 ${createdCount}개, 수정 ${updatedCount}개, 실패 ${failures.length}개` : `Gmail 임시보관함에 새 메일 ${createdCount}개를 만들고 기존 메일 ${updatedCount}개를 수정했습니다.`, scheduleChanged || failures.length ? 'error' : unresolved ? 'normal' : 'success');
      } finally { await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
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
      if (event.target.matches('[data-column-name], [data-column-type]')) {
        markRosterDependenciesStale(project, '명단 컬럼 변경 후 일정 재검토 필요');
        await persist('명단 컬럼 변경됨'); renderPeoplePage(); return;
      }
      if (event.target.matches('[data-person-row]')) {
        const rowIndex = Number(event.target.dataset.personRow);
        const person = project.data.people[rowIndex] || (event.target.value.length ? ensureRosterPerson(project, rowIndex + 1) : null);
        if (person?.active === false) { renderPeoplePage(); showToast('제외된 행은 공용 명단 관리자에서 다시 포함한 뒤 수정해주세요.'); return; }
        if (person) person.values[event.target.dataset.columnId] = event.target.value;
        syncPersonDerivedFields(project);
        if (rosterSelection) updateRosterSelection(rosterSelection.anchor, rosterSelection.focus);
        markRosterDependenciesStale(project); await persist('명단 셀 편집됨'); renderPeoplePage();
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
      if (event.target.matches('[data-person-role-check], [data-person-active]')) {
        clearRosterHistory(); markRosterDependenciesStale(project, '명단 배정 조건 변경 후 일정 재검토 필요'); await persist('명단 배정 조건 변경됨'); renderPeoplePage(); return;
      }
      if (event.target.matches('[data-availability-all]')) {
        pushScheduleHistory(project);
        project.data.availability[event.target.dataset.availabilityAll] = event.target.checked ? project.data.slots.map((slot) => slot.id) : [];
        refreshScheduleConflicts(project); syncScheduleProjectState(project, `가능 시간 변경 · 문제 ${project.data.conflicts.length}건`); await persist(); renderSchedulePage(); return;
      }
      if (event.target.matches('[data-availability-person]')) {
        const personId = event.target.dataset.availabilityPerson; const slotId = event.target.dataset.availabilitySlot;
        pushScheduleHistory(project);
        const selected = new Set(project.data.availability[personId] || []); if (event.target.checked) selected.add(slotId); else selected.delete(slotId); project.data.availability[personId] = [...selected];
        refreshScheduleConflicts(project); syncScheduleProjectState(project, `가능 시간 변경 · 문제 ${project.data.conflicts.length}건`); await persist(); renderSchedulePage(); return;
      }
      if (event.target.matches('[data-assignment-slot]')) {
        const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); pushScheduleHistory(project);
        const slotId = event.target.dataset.assignmentSlot; const roleId = event.target.dataset.assignmentRole; const position = Number(event.target.dataset.assignmentPosition);
        const matches = project.data.assignments.filter((assignment) => assignment.slotId === slotId && assignment.roleId === roleId);
        const existing = matches[position]; if (scheduleRowLocked(project, slotId) || existing?.locked) { showToast('잠긴 배정은 잠금을 해제한 뒤 변경해주세요.', 'error'); renderSchedulePage(); return; } if (existing) project.data.assignments = project.data.assignments.filter((assignment) => assignment.id !== existing.id);
        if (event.target.value) project.data.assignments.push({ id: `assignment-${Date.now().toString(36)}-${position}`, slotId, roleId, personId: event.target.value, locked: false, source: 'manual' });
        refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `일정 배정 변경 · 문제 ${project.data.conflicts.length}건`, impact); await persist(); renderSchedulePage(); return;
      }
      if (event.target.matches('[data-slot-lock]')) {
        pushScheduleHistory(project); const slot = project.data.slots.find((item) => item.id === event.target.dataset.slotLock); if (slot) slot.locked = event.target.checked; project.data.assignments.filter((assignment) => assignment.slotId === slot?.id).forEach((assignment) => { assignment.locked = event.target.checked; }); refreshScheduleConflicts(project); syncScheduleProjectState(project, `일정 잠금 변경 · 문제 ${project.data.conflicts.length}건`); await persist(); return;
      }
      if (event.target.matches('[data-slot-status]')) {
        const slot = project.data.slots.find((item) => item.id === event.target.dataset.slotStatus); if (slot && scheduleRowLocked(project, slot.id)) { showToast('잠긴 일정은 잠금을 해제한 뒤 상태를 변경해주세요.', 'error'); renderSchedulePage(); return; } const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); pushScheduleHistory(project); if (slot) slot.status = event.target.value; refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `일정 상태 변경 · 문제 ${project.data.conflicts.length}건`, impact); await persist(); return;
      }
      if (event.target.matches('[data-slot-label]')) {
        const slot = project.data.slots.find((item) => item.id === event.target.dataset.slotLabel); if (slot && scheduleRowLocked(project, slot.id)) { showToast('잠긴 일정은 잠금을 해제한 뒤 세션명을 변경해주세요.', 'error'); renderSchedulePage(); return; } const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); pushScheduleHistory(project); if (slot) slot.label = event.target.value; refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `세션명 변경 · 문제 ${project.data.conflicts.length}건`, impact); await persist(); return;
      }
      if (event.target.matches('[data-zoom-slot-connection]')) {
        const slot = project.data.slots.find((item) => item.id === event.target.dataset.zoomSlotConnection);
        if (!slot) return;
        const previousConnectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
        slot.zoomConnectionId = event.target.value || null;
        const nextConnectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
        const routeChanged = previousConnectionId !== nextConnectionId;
        const superseded = routeChanged ? supersedeArtifactsForRoute(
          project,
          'zoom',
          nextConnectionId,
          (artifact) => artifact.slotId === slot.id,
          '일정별 Zoom 계정 변경 후 새 계정으로 다시 생성 필요'
        ) : 0;
        state = Core.updateProject(state, project.id, { data: project.data });
        if (superseded && project.installedModules.includes('zoom')) state = Core.setModuleStatus(state, project.id, 'zoom', 'stale', '일정별 Zoom 계정 변경 후 새 계정으로 다시 생성 필요');
        recordScheduleMergeImpact(project.id, null, { scheduleOnly: false });
        await persist(routeChanged ? '일정별 Zoom 계정 변경됨' : '일정별 Zoom 계정 저장됨');
        renderZoomPage(); renderDashboard();
        return;
      }
      if (event.target.matches('[data-role-field], #ruleAvoidRepeat, #ruleAvoidPast, #ruleGroupPreference, #ruleUnmarkedAvailable')) {
        await persistScheduleData();
      }
    });

    document.addEventListener('click', async (event) => {
      const zoomResolved = event.target.closest('[data-zoom-artifact-resolved]');
      if (zoomResolved) {
        const project = activeProject(); const artifact = project?.data.externalArtifacts.find((item) => item.kind === 'zoom' && item.externalId === zoomResolved.dataset.zoomArtifactResolved); if (!project || !artifact) return;
        artifact.status = 'superseded'; artifact.replacedAt = new Date().toISOString();
        const unresolved = project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.status === 'stale') || project.data.slots.some((slot) => slot.status === 'cancelled' && project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status !== 'superseded'));
        state = Core.updateProject(state, project.id, { data: project.data }); state = Core.setModuleStatus(state, project.id, 'zoom', unresolved ? 'needsReview' : 'complete', unresolved ? '기존 회의 정리 필요' : 'Zoom 회의 확인 완료'); await persist('Zoom 정리 상태 저장됨'); renderZoomPage(); renderDashboard(); showToast('Zoom에서 정리한 회의로 표시했습니다.', 'success'); return;
      }
      const personRemove = event.target.closest('[data-person-remove]');
      if (personRemove) {
        let project = activeProject(); if (!project) return;
        const personId = personRemove.dataset.personRemove; const projectId = project.id; const confirmSignature = scheduleChangeSignature(project);
        const person = project.data.people.find((item) => item.id === personId);
        if (project.data.assignments.some((assignment) => assignment.personId === personId && scheduleRowLocked(project, assignment.slotId))) { showToast('잠긴 일정에 배정된 사람은 잠금을 해제한 뒤 삭제해주세요.', 'error'); return; }
        if (await showConfirm(`“${person?.name || '이름 없는 사람'}”을 명단에서 삭제할까요? 연결된 가능 시간과 일정 배정도 삭제됩니다.`, { title: '명단 삭제', action: '삭제' })) {
          project = projectById(projectId);
          if (!project || scheduleChangeSignature(project) !== confirmSignature || project.data.assignments.some((assignment) => assignment.personId === personId && scheduleRowLocked(project, assignment.slotId))) { showToast('확인하는 동안 다른 창의 명단 또는 일정이 바뀌었습니다. 다시 시도해주세요.'); renderAll(); return; }
          const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project));
          clearRosterHistory(); clearScheduleHistory();
          removeRosterPeopleWithDependencies(project, new Set([personId]), beforeSnapshot); await persist(); renderAll();
        }
        return;
      }
      const roleRemove = event.target.closest('[data-role-remove]');
      if (roleRemove) {
        const project = activeProject(); if (!project) return;
        const used = project.data.people.some((person) => person.roleIds.includes(roleRemove.dataset.roleRemove)) || project.data.assignments.some((assignment) => assignment.roleId === roleRemove.dataset.roleRemove);
        if (used) { showToast('명단이나 일정에서 사용 중인 역할은 삭제할 수 없습니다.', 'error'); return; }
        project.data.roles = project.data.roles.filter((role) => role.id !== roleRemove.dataset.roleRemove);
        if (project.data.scheduleSheetInitialized) project.data.scheduleSheetColumns = project.data.scheduleSheetColumns.filter((column) => column.roleId !== roleRemove.dataset.roleRemove);
        state = Core.updateProject(state, project.id, { data: project.data }); await persist(); renderAll(); return;
      }
      const slotRemove = event.target.closest('[data-slot-remove]');
      if (slotRemove) {
        const project = activeProject(); if (!project) return;
        const slot = project.data.slots.find((item) => item.id === slotRemove.dataset.slotRemove);
        if (slot && scheduleRowLocked(project, slot.id)) { showToast('잠긴 세션 또는 배정은 잠금을 해제한 뒤 삭제해주세요.', 'error'); return; }
        const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project));
        pushScheduleHistory(project);
        project.data.slots = project.data.slots.filter((item) => item.id !== slotRemove.dataset.slotRemove);
        project.data.assignments = project.data.assignments.filter((assignment) => assignment.slotId !== slotRemove.dataset.slotRemove);
        Object.keys(project.data.availability).forEach((personId) => { project.data.availability[personId] = project.data.availability[personId].filter((id) => id !== slotRemove.dataset.slotRemove); });
        refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `세션 삭제 후 일정 확인 · 문제 ${project.data.conflicts.length}건`, impact); await persist(); renderAll(); return;
      }
      const versionRestore = event.target.closest('[data-version-restore]');
      if (versionRestore) {
        let project = activeProject(); if (!project) return;
        let version = project.data.versions[Number(versionRestore.dataset.versionRestore)]; if (!version) return;
        const projectId = project.id; const versionKey = version.id || `${version.createdAt || ''}|${version.name || ''}`; const confirmSignature = scheduleChangeSignature(project);
        if (lockedScheduleWouldChange(project, version)) { showToast('이 버전은 현재 잠긴 일정 또는 배정을 변경합니다. 잠금을 해제한 뒤 복원해주세요.', 'error'); return; }
        if (!await showConfirm(`“${version.name}” 상태로 일정을 복원할까요? 현재 상태는 먼저 별도 버전으로 저장하는 것을 권장합니다.`, { title: '일정 버전 복원', action: '복원', danger: false })) return;
        project = projectById(projectId); version = project?.data.versions.find((item) => (item.id || `${item.createdAt || ''}|${item.name || ''}`) === versionKey);
        if (!project || !version || scheduleChangeSignature(project) !== confirmSignature || lockedScheduleWouldChange(project, version)) { showToast('확인하는 동안 다른 창의 일정이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 복원해주세요.'); renderSchedulePage(); return; }
        const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); const currentSlots = project.data.slots; const currentAvailability = project.data.availability; pushScheduleHistory(project); project.data.slots = JSON.parse(JSON.stringify(version.slots));
        const validPersonIds = new Set(project.data.people.map((person) => person.id)); const validRoleIds = new Set(project.data.roles.map((role) => role.id)); const restoredSlotIds = new Set(project.data.slots.map((slot) => slot.id)); const versionAssignments = JSON.parse(JSON.stringify(version.assignments || [])); const validAssignments = versionAssignments.filter((assignment) => validPersonIds.has(assignment.personId) && restoredSlotIds.has(assignment.slotId) && (!assignment.roleId || validRoleIds.has(assignment.roleId))); const skippedAssignments = versionAssignments.length - validAssignments.length; project.data.assignments = validAssignments;
        if (version.availability && typeof version.availability === 'object') project.data.availability = Object.fromEntries(Object.entries(version.availability).filter(([personId]) => validPersonIds.has(personId)).map(([personId, slotIds]) => [personId, (slotIds || []).filter((slotId) => restoredSlotIds.has(slotId))]));
        else project.data.availability = Object.fromEntries(Object.entries(currentAvailability || {}).filter(([personId]) => validPersonIds.has(personId)).map(([personId, slotIds]) => { const selectedKeys = new Set((slotIds || []).map((slotId) => currentSlots.find((slot) => slot.id === slotId)).filter(Boolean).map(Ops.slotKey)); return [personId, project.data.slots.filter((slot) => selectedKeys.has(Ops.slotKey(slot))).map((slot) => slot.id)]; }));
        refreshScheduleConflicts(project);
        const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `일정 버전 복원 · 문제 ${project.data.conflicts.length}건`, impact); if (skippedAssignments) state = Core.setModuleStatus(state, project.id, 'schedule', 'needsReview', `일정 버전 복원 · 삭제된 명단/역할 배정 ${skippedAssignments}건 제외`); await persist(); renderAll(); showToast(skippedAssignments ? `일정 버전을 복원했고 현재 명단·역할과 맞지 않는 배정 ${skippedAssignments}건은 제외했습니다.` : '일정 버전을 복원했습니다.', skippedAssignments ? 'normal' : 'success'); return;
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
      const sidebarProject = event.target.closest('.sidebar-project[data-project-id]');
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
        const connectionId = authorizeConnection.dataset.connectionAuthorize;
        let connection = state.connections.find((item) => item.id === connectionId); if (!connection) return;
        let reservation = null; let externalStarted = false; let authorizationCompleted = false;
        authorizeConnection.disabled = true; authorizeConnection.textContent = '브라우저 로그인 기다리는 중';
        try {
          reservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connectionId]);
          if (!reservation.ok) { showToast('다른 창에서 같은 계정을 연결하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
          connection = state.connections.find((item) => item.id === connectionId);
          if (!connection) { showToast('다른 창에서 계정 설정이 삭제되었습니다.', 'error'); return; }
          beginExternalOperation(); externalStarted = true;
          const status = await globalThis.workspaceDesktop.authorizeConnection(connectionId, { loginHint: connection.account || '', selectAccount: true });
          authorizationCompleted = true;
          if (status?.state) {
            mergePersistedWorkspaceState(status.state);
          } else {
            const applied = Core.applyConnectionAuthorization(state, connectionId, status);
            state = applied.state;
            if (!applied.connection) throw new Error('로그인 중 계정 설정이 삭제되었습니다.');
            await persist();
          }
          connection = state.connections.find((item) => item.id === connectionId);
          if (!connection || status.connectionMissing) { if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll(); showToast('로그인은 완료됐지만 다른 창에서 계정 설정이 삭제되어 연결하지 않았습니다.', 'error'); return; }
          if (state.preferences.storageMode === 'drive') scheduleDriveStateSync();
          if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
          if (currentPage === 'connections') renderConnectionsPage();
          showToast(`${connection.account || connection.label} 계정을 연결했습니다.`, 'success');
        } catch (error) {
          connection = state.connections.find((item) => item.id === connectionId);
          if (!authorizationCompleted && connection) { connection.status = 'error'; connection.updatedAt = new Date().toISOString(); await persist(); }
          if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
          if (currentPage === 'connections') renderConnectionsPage();
          showToast(`계정에 로그인하지 못했습니다: ${error.message}`, 'error');
        } finally {
          if (reservation?.ok) await releaseExternalArtifacts(reservation.token);
          if (externalStarted) endExternalOperation();
          authorizeConnection.disabled = false;
        }
        return;
      }
      const disconnectConnection = event.target.closest('[data-connection-disconnect]');
      if (disconnectConnection) {
        const connectionId = disconnectConnection.dataset.connectionDisconnect;
        let connection = state.connections.find((item) => item.id === connectionId); if (!connection) return;
        const wasWorkspaceDrive = connectedDrive()?.id === connectionId;
        if (!await showConfirm(`“${connection.label}” 계정의 로그인을 해제할까요? 다시 연결할 수 있도록 계정 설정은 남겨둡니다.`, { title: '계정 연결 해제', action: '연결 해제' })) return;
        let reservation = null; let externalStarted = false;
        try {
          reservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connectionId]);
          if (!reservation.ok) { showToast('다른 창에서 같은 계정을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
          connection = state.connections.find((item) => item.id === connectionId);
          if (!connection) { showToast('다른 창에서 계정 설정이 삭제되었습니다.', 'error'); return; }
          beginExternalOperation(); externalStarted = true;
          const status = await globalThis.workspaceDesktop.disconnectConnection(connectionId);
          let needsPersist = false;
          if (status?.state) mergePersistedWorkspaceState(status.state);
          else {
            connection = state.connections.find((item) => item.id === connectionId);
            if (!connection) throw new Error('연결 해제 중 계정 설정이 삭제되었습니다.');
            connection.status = 'needsAuth'; connection.updatedAt = new Date().toISOString(); needsPersist = true;
          }
          if (wasWorkspaceDrive && state.preferences.storageMode === 'drive') { state.preferences.storageMode = 'local'; needsPersist = true; }
          if (needsPersist) await persist(wasWorkspaceDrive ? 'Drive 연결 해제 · 이 PC 저장으로 전환됨' : '계정 연결 해제됨');
          if (state.preferences.storageMode === 'drive') scheduleDriveStateSync();
          if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
          if (currentPage === 'connections') renderConnectionsPage();
          showToast(wasWorkspaceDrive ? 'Drive 연결을 해제하고 이 PC 저장으로 전환했습니다.' : '계정 연결을 해제했습니다.');
        } catch (error) { showToast(`계정 연결을 해제하지 못했습니다: ${error.message}`, 'error'); }
        finally { if (reservation?.ok) await releaseExternalArtifacts(reservation.token); if (externalStarted) endExternalOperation(); }
        return;
      }
      const removeConnection = event.target.closest('[data-connection-remove]');
      if (removeConnection) {
        const connectionId = removeConnection.dataset.connectionRemove;
        let connection = state.connections.find((item) => item.id === connectionId);
        if (!await showConfirm(`“${connection?.label || '계정'}” 설정을 완전히 삭제할까요? 프로젝트 기본 연결과 Workspace Drive 동기화 선택에서도 해제됩니다.`, { title: '계정 설정 삭제', action: '삭제' })) return;
        let reservation = null; let externalStarted = false;
        try {
          reservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connectionId]);
          if (!reservation.ok) { showToast('다른 창에서 같은 계정을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
          connection = state.connections.find((item) => item.id === connectionId);
          if (!connection) { showToast('다른 창에서 이미 계정 설정을 삭제했습니다.'); return; }
          beginExternalOperation(); externalStarted = true;
          await globalThis.workspaceDesktop.removeConnection(connectionId);
          connection = state.connections.find((item) => item.id === connectionId) || connection;
          retireArtifactsForConnection(connection, '계정 설정 삭제 후 기존 외부 항목 재확인 필요');
          state = Core.removeConnection(state, connectionId);
          await persist();
          if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
          if (currentPage === 'connections') renderConnectionsPage();
          showToast('계정 설정을 삭제했습니다.');
        } catch (error) { showToast(`계정 설정을 삭제하지 못했습니다: ${error.message}`, 'error'); }
        finally { if (reservation?.ok) await releaseExternalArtifacts(reservation.token); if (externalStarted) endExternalOperation(); }
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
    persistedStateBaseline = cloneState(state);
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
        const incomingRevision = Number(normalized._revision || 0); const currentRevision = Number(state._revision || 0);
        const newer = incomingRevision > currentRevision || (incomingRevision === currentRevision && String(normalized.updatedAt || '') > String(state.updatedAt || ''));
        if (newer) {
          if (schedulePersistBaseline || persistSaving || persistDirty || externalOperationCount || mailEditorDirty || hasFocusedWorkspaceDraft()) {
            deferredWorkspaceState = normalized;
            if (schedulePersistBaseline && !persistSaving) void flushSchedulePersist();
            else if (persistReconcileNeeded && !persistSaving) schedulePersistReconciliation();
            return;
          }
          applyIncomingWorkspaceState(normalized);
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

  async function commitFocusedWorkspaceDraft() {
    const target = document.activeElement;
    if (hasFocusedWorkspaceDraft()) target.blur();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if ($('#mailEditDialog').open) captureOpenPersonalMailDraft();
  }

  globalThis.flushWorkspaceEdits = async () => {
    clearTimeout(mailDraftTimer);
    await commitFocusedWorkspaceDraft();
    await flushRosterFormulaPersist();
    await flushArrangementPersist();
    await waitForExternalOperations();
    try { await flushSchedulePersist(); } catch (_) {}
    if (mailEditorDirty) await saveMailEditorDraft();
    for (let pass = 0; pass < 8; pass += 1) {
      await waitForPersistIdle();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (persistSaving) continue;
      clearTimeout(persistReconcileTimer); persistReconcileTimer = null;
      if (schedulePersistBaseline) { await flushSchedulePersist(); continue; }
      if (persistDirty || persistReconcileNeeded || pendingScheduleMergeHints.size) { await persist('종료 전 변경사항 저장됨'); continue; }
      break;
    }
    await waitForPersistIdle();
    if (persistSaving || persistDirty || persistReconcileNeeded || schedulePersistBaseline || pendingScheduleMergeHints.size) throw new Error('변경사항을 저장하지 못했습니다.');
    if (state.preferences.storageMode === 'drive' && !await flushDriveStateSync(false)) throw new Error(lastDriveSyncError?.message || 'Google Drive에 마지막 변경사항을 저장하지 못했습니다.');
    return true;
  };

  void initialize();
})();
