(() => {
  const Core = globalThis.WorkspaceCore;
  const Ops = globalThis.OperationsCore;
  const ExternalProgress = globalThis.WorkspaceExternalProgress;
  const CalendarCore = globalThis.ProjectCalendarCore;
  const SessionSchedulerCore = globalThis.ProjectSessionSchedulerCore;
  const SessionSchedulerUI = globalThis.ProjectSessionSchedulerUI;
  const GuideCore = globalThis.WorkspaceGuideCore;
  const launchParams = new URLSearchParams(location.search);
  const smokeDiagnostics = launchParams.get('smoke') === '1';
  const requestedStandaloneProgram = launchParams.get('mode') === 'standalone' ? launchParams.get('app') || '' : '';
  const standaloneProgram = Core.canonicalModuleId?.(requestedStandaloneProgram) || requestedStandaloneProgram;
  const launchDocumentMode = Core.normalizeDocumentMode?.(launchParams.get('documentMode'), ['pptxPdf', 'certificateMaker'].includes(requestedStandaloneProgram) ? requestedStandaloneProgram : '') || '';
  const projectLinkedProgram = standaloneProgram && launchParams.get('dataMode') === 'project' ? standaloneProgram : '';
  const linkedProjectId = projectLinkedProgram ? launchParams.get('projectId') || '' : '';
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
    projectCalendar: '캘린더에서 운영하기', layout: '일정표 저장하기', zoom: 'Zoom 회의 만들기', gmailFlow: '안내 메일 준비하기',
    documentEditor: '문서 편집 열기'
  };
  const CONNECTION_SERVICE_DETAILS = {
    forms: { icon: 'F', description: '설문을 만들고 응답을 명단과 일정에 반영합니다.' },
    drive: { icon: 'D', description: 'Workspace 자료를 Google Drive에 저장하고 동기화합니다.' },
    gmail: { icon: 'G', description: '안내 메일을 Gmail 임시보관함에 준비합니다.' },
    zoom: { icon: 'Z', description: '확정된 일정으로 Zoom 회의와 참여 링크를 만듭니다.' }
  };

  let state = Core.createEmptyState();
  let persistedStateBaseline = Core.createEmptyState();
  let currentPage = 'dashboard';
  let navigationGeneration = 0;
  let confirmResolver = null;
  let rosterImportPreviewResolver = null;
  let rosterImportPreviewMatrix = null;
  let loginBrowserResolver = null;
  let loginBrowserView = null;
  let nameInputResolver = null;
  let saveTimer = null;
  let driveSyncTimer = null;
  let driveSyncDirty = false;
  let driveSyncPromise = null;
  let lastDriveSyncError = null;
  let extensionManifests = [];
  const connectionProviderStatuses = {};
  const activeConnectionAuthorizations = new Set();
  const pendingConnectionAuthorizationCancels = new Set();
  let mailEditorDirty = false;
  let mailEditorProjectId = null;
  let mailDraftTimer = null;
  let formEditorDirty = false;
  let formEditorProjectId = null;
  let formDraftTimer = null;
  let formPreviewReturnFocus = null;
  let draggedFormItemId = null;
  let formStructureHistory = [];
  let formStructureHistoryScope = '';
  let formStructureHistoryPending = false;
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
  let scheduleHistoryProjectId = '';
  let schedulePersistTimer = null;
  let schedulePersistBaseline = null;
  let schedulePersistProjectId = null;
  let schedulePersistMessage = '일정 셀 편집 저장됨';
  let scheduleAssignmentSequence = 0;
  let scheduleEditGeneration = 0;
  let sheetContextOrigin = null;
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
  let pendingMergedFormsRender = false;
  let pendingMergedFormsFocusToken = null;
  let formsMergeRefreshScheduled = false;
  let formsMergeRefreshPromise = null;
  let selectedSessionPersonId = null;
  let selectedSessionAssignmentId = null;
  let pendingSessionChange = null;
  let calendarView = 'month';
  let calendarAnchorDate = '';
  let calendarProjectId = '';
  let calendarSelectedSlotId = null;
  let calendarSelectedSessionId = null;
  let calendarSurfaceMode = 'sessions';
  let sessionSchedulerController = null;
  let sessionSchedulerProjectId = '';
  let calendarDetailReturnFocus = null;
  let calendarAdjustmentDraft = null;
  let calendarDragSelection = null;
  let calendarEventEditor = null;
  let dashboardCalendarAnchorDate = '';
  const dashboardCalendarExpandedDates = new Set();
  let sheetChoiceResolver = null;
  let templateInsertionTarget = 'body';
  let templateAutocompleteState = null;
  let activeWorkflowStepId = null;
  let newProjectWorkflowDraft = [];
  let newProjectWorkflowModified = false;
  let workflowEditorDraft = [];
  let workflowEditorTemplateDraft = null;
  let gmailFlowSummary = { connected: false, email: '', rosters: 0, templates: 0, structures: 0 };
  let appUpdateState = { currentVersion: '', packaged: false, portable: false, checking: false, installing: false, canceling: false, checked: null, progress: null, error: '' };
  let guideSession = null;
  let guideStarting = false;
  let guideRefreshFrame = null;
  let guideMutationObserver = null;
  let guideResizeObserver = null;
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
  const hasStoredId = (value) => value !== null && value !== undefined && value !== '';
  const storedId = (primary, fallback = null) => hasStoredId(primary) ? primary : fallback;

  function acceptPersistedBaseline(nextState) {
    const nextRevision = Number(nextState?._revision || 0);
    if (nextRevision >= Number(persistedStateBaseline?._revision || 0)) persistedStateBaseline = cloneState(nextState);
  }

  function mergePersistedWorkspaceState(nextState) {
    const currentSurfaceProjectId = surfaceProjectId(state);
    const currentSurfaceProject = projectFromState(state, currentSurfaceProjectId);
    const currentScheduleSnapshot = currentSurfaceProject ? scheduleSnapshot(currentSurfaceProject) : '';
    const returnedState = Core.normalizeState(nextState);
    const mergeBase = cloneState(persistedStateBaseline);
    const returnedIsNewer = Number(returnedState._revision || 0) > Number(mergeBase._revision || 0)
      || (Number(returnedState._revision || 0) === Number(mergeBase._revision || 0) && String(returnedState.updatedAt || '') >= String(mergeBase.updatedAt || ''));
    const authoritativeState = returnedIsNewer ? returnedState : mergeBase;
    const localState = cloneState(state);
    acceptPersistedBaseline(authoritativeState);
    state = Core.normalizeState(Core.threeWayMerge(mergeBase, authoritativeState, localState));
    const mergedSurfaceProject = projectFromState(state, currentSurfaceProjectId);
    if (currentSurfaceProjectId && (!mergedSurfaceProject || currentScheduleSnapshot !== scheduleSnapshot(mergedSurfaceProject))) clearScheduleHistory(currentSurfaceProjectId);
    if (JSON.stringify(state) !== JSON.stringify(authoritativeState)) persistDirty = true;
    return state;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function configureSheetSelector(node, label) {
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', label);
    node.setAttribute('aria-pressed', 'false');
    return node;
  }

  function setSheetSelectorPressed(node, pressed) {
    node.classList.toggle('sheet-selector-selected', pressed);
    node.classList.toggle('sheet-row-selected', pressed);
    node.setAttribute('aria-pressed', String(pressed));
  }

  function assertSmokeUi(condition, message) {
    if (smokeDiagnostics && !condition) throw new Error(`Workspace UI accessibility smoke failed: ${message}`);
  }

  function assertAccessibleSheet(table, inputSelector, selectorSelector) {
    if (!smokeDiagnostics || !table) return;
    assertSmokeUi($$(inputSelector, table).every((control) => Boolean(control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || control.closest('label'))), `${table.id} controls have accessible names`);
    assertSmokeUi($$(selectorSelector, table).every((selector) => selector.tabIndex === 0 && selector.getAttribute('role') === 'button' && Boolean(selector.getAttribute('aria-label'))), `${table.id} row and column selectors are keyboard reachable`);
  }

  function assertStaticAccessibilityMarkup() {
    if (!smokeDiagnostics) return;
    $$('dialog').forEach((dialog) => { const labelId = dialog.getAttribute('aria-labelledby'); assertSmokeUi(Boolean(labelId && document.getElementById(labelId)), `${dialog.id} has a valid aria-labelledby target`); });
    assertSmokeUi($$('[data-rich-command="bold"], [data-rich-command="italic"], [data-rich-command="underline"]').every((button) => Boolean(button.getAttribute('aria-label')) && button.hasAttribute('aria-pressed')), 'rich text toggle buttons expose names and pressed state');
    assertSmokeUi(['mailSubjectTemplate', 'mailBodyEditor', 'mailEditSubject', 'mailEditBody'].every((id) => { const control = document.getElementById(id); return control?.getAttribute('aria-autocomplete') === 'list' && control.getAttribute('aria-controls') === 'templateVariableAutocomplete' && control.hasAttribute('aria-expanded'); }), 'template autocomplete controls expose combobox state');
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
    if (projectLinkedProgram) return linkedProjectId ? state.projects.find((item) => item.id === linkedProjectId && item.status !== 'archived') || null : Core.getActiveProject(state);
    if (standaloneProgram) return state.quickWorkspaces?.[standaloneProgram] || null;
    return Core.getActiveProject(state);
  }

  function projectById(projectId) {
    return state.projects.find((item) => item.id === projectId) || Object.values(state.quickWorkspaces || {}).find((item) => item.id === projectId) || null;
  }

  function surfaceProjectId(stateInput = state) {
    if (projectLinkedProgram) return linkedProjectId;
    if (standaloneProgram) return stateInput.quickWorkspaces?.[standaloneProgram]?.id || '';
    return stateInput.activeProjectId || '';
  }

  function projectFromState(stateInput, projectId) {
    return stateInput?.projects?.find((item) => item.id === projectId) || Object.values(stateInput?.quickWorkspaces || {}).find((item) => item.id === projectId) || null;
  }

  function defaultConnectionId(project, type, stateInput = state) {
    return Core.resolveDefaultConnectionId(stateInput, project, type);
  }

  function effectiveConnectionDefaults(project, stateInput = state) {
    return {
      forms: defaultConnectionId(project, 'forms', stateInput),
      gmail: defaultConnectionId(project, 'gmail', stateInput),
      zoom: defaultConnectionId(project, 'zoom', stateInput)
    };
  }

  function buildWorkspaceMailPackage(project, stateInput = state) {
    return Ops.buildMailPackage(project, effectiveConnectionDefaults(project, stateInput));
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
    if (guideSession) {
      clearTimeout(saveTimer);
      clearTimeout(persistReconcileTimer); persistReconcileTimer = null;
      persistReconcileNeeded = false; persistReconcileBlocked = false; persistDirty = false;
      pendingScheduleMergeHints.clear();
      const saveStatus = $('#saveStatus');
      if (saveStatus) saveStatus.textContent = '연습 중 · 저장 안 함';
      scheduleGuideRefresh();
      return { ok: true, guideMode: true, state: cloneState(state) };
    }
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
      const requestProjectId = surfaceProjectId(requestState);
      const result = await storage.save(requestState, { scheduleProjects, baseState: requestBaseState, externalCommit });
      let mergedRosterChanged = Boolean(result?.merged);
      let mergedArrangementChanged = Boolean(result?.merged);
      let mergedScheduleChanged = Boolean(result?.merged);
      let mergedFormsChanged = Boolean(result?.merged);
      if (result?.state) {
        const normalized = Core.normalizeState(result.state);
        if (result.merged) {
          const activeProjectChanged = !standaloneProgram && normalized.activeProjectId !== requestState.activeProjectId;
          const requestedProject = projectFromState(requestState, requestProjectId);
          const mergedProject = projectFromState(normalized, requestProjectId);
          mergedRosterChanged = activeProjectChanged || !requestedProject || !mergedProject || rosterSnapshot(requestedProject) !== rosterSnapshot(mergedProject);
          mergedScheduleChanged = activeProjectChanged || !requestedProject || !mergedProject || scheduleSnapshot(requestedProject) !== scheduleSnapshot(mergedProject);
          const requestedItem = requestedProject?.data.workItems.find((item) => item.id === requestedProject.data.activeWorkItemId);
          const mergedItem = mergedProject?.data.workItems.find((item) => item.id === requestedProject?.data.activeWorkItemId);
          const arrangementContent = (item) => item ? JSON.stringify({ columns: item.columns, rows: item.rows }) : '';
          mergedArrangementChanged = activeProjectChanged || requestedProject?.data.activeWorkItemId !== mergedProject?.data.activeWorkItemId || (Boolean(requestedItem || mergedItem) && (!requestedItem || !mergedItem || arrangementContent(requestedItem) !== arrangementContent(mergedItem)));
          mergedFormsChanged = activeProjectChanged || formsSurfaceSnapshot(requestState, requestedProject) !== formsSurfaceSnapshot(normalized, mergedProject);
        }
        const localAdvanced = requestSequence !== persistSequence || JSON.stringify(state) !== JSON.stringify(requestState); requestHadLocalAdvance = localAdvanced;
        acceptPersistedBaseline(normalized);
        state = localAdvanced ? Core.normalizeState(Core.threeWayMerge(requestState, normalized, state)) : normalized;
        if (result.merged && (mergedRosterChanged || mergedArrangementChanged || mergedScheduleChanged || mergedFormsChanged)) pendingMergedSurfaceRender = true;
        if (result.merged && mergedFormsChanged) { pendingMergedFormsRender = true; scheduleMergedFormsRefresh(); }
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
          clearScheduleHistory(requestProjectId);
          const input = document.activeElement; const project = activeProject();
          if (project && input?.matches?.('[data-schedule-input]')) {
            const snapshot = scheduleSnapshot(project);
            input.dataset.scheduleBefore = snapshot; input.dataset.scheduleImpactBefore = snapshot;
          }
        }
        if (mergedFormsChanged) clearFormStructureHistory();
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
    if (guideSession) return { ok: true, token: null, keys: reservationKeys, guideMode: true };
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
    if (guideSession) { driveSyncDirty = false; clearTimeout(driveSyncTimer); driveSyncTimer = null; return; }
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
    if (guideSession) {
      driveSyncDirty = false;
      if (notify) showToast('가이드에서는 실제 Drive에 저장하지 않습니다. 연습용 동기화 흐름만 확인합니다.', 'success');
      return true;
    }
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
    if (guideSession) {
      if (notify) showToast('가이드에서는 실제 Drive에 저장하지 않습니다.', 'success');
      return true;
    }
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
    } catch (error) {
      lastDriveSyncError = error;
      if (notify && error?.code === 'DRIVE_SYNC_RESOLUTION_REQUIRED' && globalThis.workspaceDesktop?.resolveDriveConflictWithLocal) {
        const useLocal = await showConfirm(
          'Drive 저장본과 이 PC의 내용이 서로 다릅니다.\n\n이 PC 내용을 유지하면 현재 Drive 저장본을 새 버전으로 바꿉니다. Drive 내용을 유지하려면 취소한 뒤 “Drive에서 불러오기”를 눌러주세요.',
          { title: 'Drive 내용 선택', action: '이 PC 내용으로 저장' }
        );
        if (!useLocal) {
          showToast('Drive 내용을 유지하려면 아래 “Drive에서 불러오기”를 눌러 확인해주세요. 어느 쪽도 자동으로 덮어쓰지 않았습니다.');
          return false;
        }
        const currentConnection = latestKnownConnection(connection.id);
        const expectedWorkspaceIdentity = workspaceStateIdentity(latestKnownWorkspaceState());
        if (!Core.connectionIdentityMatches(currentConnection, Core.connectionIdentity(connection))) {
          lastDriveSyncError = new Error('확인하는 동안 Drive 계정 연결이 바뀌었습니다. 다시 저장해주세요.');
          showToast(lastDriveSyncError.message, 'error');
          return false;
        }
        try {
          const result = await globalThis.workspaceDesktop.resolveDriveConflictWithLocal(connection.id, Core.connectionIdentity(currentConnection), expectedWorkspaceIdentity, error.remoteIdentity);
          lastDriveSyncError = null;
          state.preferences.lastDriveSyncAt = result.modifiedTime || new Date().toISOString();
          if ($('#driveSyncStatus')) $('#driveSyncStatus').textContent = `마지막 Drive 저장: ${formatUpdatedAt(state.preferences.lastDriveSyncAt)}`;
          showToast('이 PC의 현재 Workspace 내용을 Drive에 안전하게 저장했습니다.', 'success');
          return true;
        } catch (resolutionError) {
          lastDriveSyncError = resolutionError;
          showToast(`Drive 저장 실패: ${resolutionError.message}`, 'error');
          return false;
        }
      }
      if (notify) showToast(`Drive 저장 실패: ${error.message}`, 'error');
      return false;
    }
  }

  function openDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog.open) {
      // A modal dialog always wins the browser top-layer hit test over a popover.
      // Guide dialogs stay non-modal because the four guide blockers already
      // restrict interaction to the highlighted control.
      if (guideSession && typeof dialog.show === 'function') dialog.show();
      else dialog.showModal();
    }
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

  function showRosterImportPreview(analysis, sourceLabel = '붙여넣은 내용') {
    const matrix = Array.isArray(analysis?.matrix) ? analysis.matrix : [];
    if (!matrix.length) return Promise.resolve(null);
    const project = activeProject();
    const result = Ops.matrixToRoster(matrix, { roles: project?.data?.roles || [] });
    const columns = result.columns || [];
    const people = result.people || [];
    $('#rosterImportPreviewDescription').textContent = `${sourceLabel}을(를) ${people.length}명 · ${columns.length}개 열로 해석했습니다.`;
    const summary = $('#rosterImportPreviewSummary'); summary.replaceChildren(
      element('strong', '', `${people.length}명`),
      element('span', '', columns.map((column) => column.name).join(' · ') || '인식된 열 없음')
    );
    const warnings = [...new Set([...(analysis?.warnings || []), ...(result.warnings || []).slice(0, 8)])];
    const warningBox = $('#rosterImportPreviewWarnings'); warningBox.hidden = !warnings.length;
    if (warnings.length) warningBox.querySelector('span').textContent = warnings.join(' ');
    const table = $('#rosterImportPreviewTable');
    const headerRow = element('tr'); columns.forEach((column) => headerRow.append(element('th', '', column.name)));
    table.tHead.replaceChildren(headerRow); table.tBodies[0].replaceChildren();
    people.slice(0, 40).forEach((person) => {
      const row = element('tr');
      columns.forEach((column) => {
        const value = person.values?.[column.id] || '';
        const cell = element('td', '', value || '—');
        if (value) cell.title = value; else cell.classList.add('muted-cell');
        row.append(cell);
      });
      table.tBodies[0].append(row);
    });
    const more = $('#rosterImportPreviewMore'); more.hidden = people.length <= 40; more.textContent = people.length > 40 ? `화면에는 처음 40명만 표시합니다. 적용하면 ${people.length}명 전체를 가져옵니다.` : '';
    rosterImportPreviewMatrix = matrix.map((row) => row.slice());
    openDialog('rosterImportPreviewDialog');
    return new Promise((resolve) => { rosterImportPreviewResolver = resolve; });
  }

  function resolveRosterImportPreview(apply) {
    closeDialog('rosterImportPreviewDialog');
    const resolver = rosterImportPreviewResolver;
    const matrix = apply ? rosterImportPreviewMatrix : null;
    rosterImportPreviewResolver = null; rosterImportPreviewMatrix = null;
    resolver?.(matrix);
  }

  async function previewRosterText(text, sourceLabel) {
    const analysis = Ops.analyzeRosterInput(text);
    if (!analysis.matrix.length) return null;
    return showRosterImportPreview(analysis, sourceLabel);
  }

  async function previewRosterMatrix(matrix, sourceLabel) {
    return showRosterImportPreview({ matrix, format: 'spreadsheet', inferred: false, warnings: [] }, sourceLabel);
  }

  async function chooseLoginBrowser(type = '') {
    const providerName = type === 'zoom' ? 'Zoom' : 'Google';
    let choices;
    try {
      choices = await (globalThis.workspaceDesktop?.listLoginBrowsers?.() || Promise.resolve([{ id: 'system', label: '기본 브라우저' }]));
    } catch (error) {
      showToast(`로그인에 사용할 브라우저를 확인하지 못했습니다: ${error.message}`, 'error');
      return null;
    }
    const allowed = new Set(['system', 'windows-picker', 'chrome', 'edge']);
    choices = (Array.isArray(choices) ? choices : [])
      .filter((choice) => allowed.has(choice?.id))
      .filter((choice, index, list) => list.findIndex((item) => item.id === choice.id) === index);
    if (!choices.length) choices = [{ id: 'system', label: '기본 브라우저' }];
    loginBrowserView = { providerName, choices };
    renderLoginBrowserChoices();
    if (loginBrowserResolver) { const previousResolver = loginBrowserResolver; loginBrowserResolver = null; previousResolver(null); }
    openDialog('loginBrowserDialog');
    setTimeout(() => $('#loginBrowserChoices button')?.focus());
    return new Promise((resolve) => { loginBrowserResolver = resolve; });
  }

  function setLoginBrowserStatus(message = '', tone = '') {
    const status = $('#loginBrowserStatus');
    status.textContent = message;
    status.hidden = !message;
    status.className = `login-browser-status${tone ? ` ${tone}` : ''}`;
  }

  function renderLoginBrowserChoices() {
    if (!loginBrowserView) return;
    loginBrowserView.stage = 'browsers';
    loginBrowserView.browserId = '';
    const { providerName, choices } = loginBrowserView;
    const descriptions = {
      system: 'Windows에서 기본으로 정한 브라우저로 바로 엽니다.',
      'windows-picker': 'Windows 앱 선택 화면에서 Edge·Firefox 등 사용할 브라우저를 고릅니다.',
      chrome: '업무용·개인용 Chrome 사용자를 고른 뒤 로그인합니다.',
      edge: '업무용·개인용 Edge 사용자를 고른 뒤 로그인합니다.'
    };
    const icons = { system: '기본', 'windows-picker': '···', chrome: 'C', edge: 'E' };
    $('#loginBrowserDialogTitle').textContent = `${providerName} 로그인을 어디에서 열까요?`;
    $('#loginBrowserDialogDescription').textContent = '사용하려는 계정이 있는 브라우저를 고르세요. Chrome이나 Edge는 다음 화면에서 사용자를 선택할 수 있습니다.';
    $('#loginBrowserBack').hidden = true;
    setLoginBrowserStatus();
    const container = $('#loginBrowserChoices');
    container.replaceChildren();
    choices.forEach((choice) => {
      const button = element('button', 'login-browser-choice');
      if (choice.id === 'windows-picker' || (choices.length % 2 === 1 && choice === choices.at(-1))) button.classList.add('login-browser-choice-wide');
      button.type = 'button';
      button.dataset.loginBrowserChoice = choice.id;
      const copy = element('span', 'login-browser-choice-copy');
      copy.append(element('strong', '', String(choice.label || choice.id)), element('small', '', descriptions[choice.id] || '선택한 브라우저에서 로그인'));
      button.append(element('span', 'login-browser-choice-icon', icons[choice.id] || '↗'), copy);
      container.append(button);
    });
  }

  async function renderLoginBrowserProfiles(browserId) {
    if (!loginBrowserView || !['chrome', 'edge'].includes(browserId)) return;
    const activeView = loginBrowserView;
    activeView.stage = 'profiles';
    activeView.browserId = browserId;
    const browserLabel = browserId === 'chrome' ? 'Chrome' : 'Edge';
    const container = $('#loginBrowserChoices');
    $('#loginBrowserDialogTitle').textContent = `${browserLabel} 사용자를 선택하세요`;
    $('#loginBrowserDialogDescription').textContent = `${browserLabel}에 저장된 사용자 중 ${loginBrowserView.providerName} 로그인에 사용할 사용자를 고르세요.`;
    $('#loginBrowserBack').hidden = false;
    container.replaceChildren();
    setLoginBrowserStatus('브라우저 사용자를 확인하고 있습니다.');
    let profiles;
    try {
      profiles = await globalThis.workspaceDesktop?.listLoginBrowserProfiles?.(browserId);
    } catch (error) {
      profiles = [];
      setLoginBrowserStatus(`${browserLabel} 사용자를 확인하지 못했습니다: ${error.message}`, 'error');
    }
    if (loginBrowserView !== activeView || activeView.stage !== 'profiles' || activeView.browserId !== browserId || !$('#loginBrowserDialog')?.open) return;
    profiles = (Array.isArray(profiles) ? profiles : [])
      .filter((profile) => /^[A-Za-z0-9_-]{43}$/.test(String(profile?.id || '')))
      .slice(0, 100);
    container.replaceChildren();
    if (!profiles.length) {
      if ($('#loginBrowserStatus').hidden) setLoginBrowserStatus(`${browserLabel} 사용자를 찾지 못했습니다. 브라우저를 한 번 실행한 뒤 다시 시도하거나 다른 브라우저를 선택하세요.`, 'error');
      $('#loginBrowserBack').focus();
      return;
    }
    setLoginBrowserStatus();
    profiles.forEach((profile) => {
      const label = String(profile.label || `${browserLabel} 사용자`).trim().slice(0, 80) || `${browserLabel} 사용자`;
      const account = String(profile.account || '').trim().slice(0, 320);
      const button = element('button', 'login-browser-choice login-browser-profile-choice');
      button.type = 'button';
      button.dataset.loginBrowserProfile = profile.id;
      button.dataset.loginBrowserProfileBrowser = browserId;
      const copy = element('span', 'login-browser-choice-copy');
      copy.append(
        element('strong', '', label),
        element('small', '', `${account || '이 브라우저 사용자'}${profile.isLastUsed ? ' · 최근 사용' : ''}`)
      );
      button.append(element('span', 'login-browser-choice-icon', Array.from(label)[0]?.toUpperCase() || '●'), copy);
      container.append(button);
    });
    setTimeout(() => container.querySelector('button')?.focus());
  }

  function resolveLoginBrowser(value) {
    closeDialog('loginBrowserDialog');
    const resolver = loginBrowserResolver;
    loginBrowserResolver = null;
    loginBrowserView = null;
    resolver?.(value || null);
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

  function navigate(page, options = {}) {
    const requestedDocumentMode = Core.normalizeDocumentMode?.(page) || Core.normalizeDocumentMode?.(options.documentMode) || '';
    page = requestedDocumentMode ? 'documentEditor' : (Core.canonicalModuleId?.(page) || page);
    if (currentPage === 'gmailFlow' && page !== 'gmailFlow' && mailEditorDirty) void saveMailEditorDraft(mailEditorProjectId);
    if (currentPage === 'forms' && page !== 'forms' && formEditorDirty) void saveFormEditorDraft(formEditorProjectId).catch(() => {});
    if (currentPage === 'forms' && page !== 'forms') unlockFormsEditorAfterMerge();
    if (smokeDiagnostics) { navigationTrace.push({ from: currentPage, to: page, stack: new Error().stack?.split('\n').slice(1, 5) }); if (navigationTrace.length > 30) navigationTrace.shift(); }
    navigationGeneration += 1;
    currentPage = page;
    const module = Core.MODULE_CATALOG.find((item) => item.id === page);
    const visiblePage = module?.page === 'declarative' ? 'declarative' : page;
    $$('.page').forEach((panel) => panel.classList.toggle('active', panel.dataset.page === visiblePage));
    $$('.nav-button').forEach((button) => { const active = button.dataset.nav === page; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    if (page === 'projects') renderProjectsPage();
    if (page === 'modules') renderModulesPage();
    if (page === 'connections') { renderConnectionsPage(); if (!guideSession) void refreshConnectionProviderStatuses(); }
    if (page === 'settings' && !guideSession) void refreshConnectionProviderStatuses();
    if (page === 'library') renderLibraryPage();
    if (page === 'people') renderPeoplePage();
    if (page === 'arrange') renderArrangementPage();
    if (page === 'schedule') renderSchedulePage();
    if (page === 'projectCalendar') renderProjectCalendarPage();
    if (page === 'layout') renderLayoutPage();
    if (page === 'forms') { renderFormsPage(); scheduleMergedFormsRefresh(); }
    if (page === 'zoom') renderZoomPage();
    if (page === 'gmailFlow') renderGmailPage();
    if (page === 'documentEditor') globalThis.CMOEDocumentToolsUI?.show('documentEditor', requestedDocumentMode ? { mode: requestedDocumentMode } : options);
    if (page === 'workflowTask') renderWorkflowTaskPage();
    if (visiblePage === 'declarative') renderDeclarativePage(page);
    scheduleGuideRefresh();
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

  const DASHBOARD_CALENDAR_COLORS = ['#1769aa', '#2b7c68', '#996a16', '#7654a8', '#b4594f', '#3d7f9a', '#7a6c32', '#9a4f78'];

  function dashboardProjectColor(projectId) {
    const index = Math.max(0, state.projects.findIndex((project) => project.id === projectId));
    return DASHBOARD_CALENDAR_COLORS[index % DASHBOARD_CALENDAR_COLORS.length];
  }

  function slotRangeText(slot, { includeYear = false } = {}) {
    const endDate = CalendarCore.slotEndDate(slot);
    const start = calendarDateLabel(slot.date, { year: includeYear, weekday: false });
    if (endDate === slot.date) return `${start} · ${slot.startTime || '--:--'}–${slot.endTime || '--:--'}`;
    return `${start} ${slot.startTime || '--:--'} → ${calendarDateLabel(endDate, { year: includeYear && slot.date.slice(0, 4) !== endDate.slice(0, 4), weekday: false })} ${slot.endTime || '--:--'}`;
  }

  function slotDateKeys(slot, limit = 370) {
    const start = slot?.date; const end = CalendarCore.slotEndDate(slot);
    if (!CalendarCore.isValidDateKey(start) || !CalendarCore.isValidDateKey(end) || end < start) return [];
    const dates = []; let date = start;
    while (date && date <= end && dates.length < limit) { dates.push(date); date = CalendarCore.addDays(date, 1); }
    if (dates.at(-1) !== end) dates.push(end);
    return dates;
  }

  function dashboardCalendarItems(project) {
    const sessions = project?.data?.extensionData?.projectCalendar?.sessions;
    const normalizedSessions = (Array.isArray(sessions) ? sessions : []).filter((session) => {
      const startDate = session?.startDate || session?.date;
      const endDate = session?.endDate || startDate;
      return session?.id && CalendarCore.isValidDateKey(startDate) && CalendarCore.isValidDateKey(endDate) && endDate >= startDate;
    });
    if (!normalizedSessions.length) return (project?.data?.slots || []).map((slot) => ({ ...slot, dashboardKind: 'slot' }));
    return normalizedSessions.map((session) => ({
      id: session.id,
      label: session.title || session.name || '이름 없는 세션',
      date: session.startDate || session.date,
      endDate: session.endDate || session.startDate || session.date,
      startTime: '00:00',
      endTime: '23:59',
      status: session.status || 'draft',
      dashboardKind: 'session'
    }));
  }

  function renderDashboardCalendar() {
    const grid = $('#dashboardCalendarGrid');
    if (!grid || !CalendarCore) return;
    const projects = state.projects.filter((project) => project.status !== 'archived');
    const filter = $('#dashboardCalendarProjectFilter');
    const previousFilter = filter.value;
    const allOption = element('option', '', '모든 진행 프로젝트'); allOption.value = '';
    filter.replaceChildren(allOption, ...projects.map((project) => { const option = element('option', '', project.name); option.value = project.id; return option; }));
    filter.value = projects.some((project) => project.id === previousFilter) ? previousFilter : '';
    const selectedProjects = filter.value ? projects.filter((project) => project.id === filter.value) : projects;
    const workspaceZone = state.preferences?.defaultTimezone || 'Asia/Seoul';
    const today = CalendarCore.dateKeyInTimeZone(new Date(), workspaceZone);
    if (!CalendarCore.isValidDateKey(dashboardCalendarAnchorDate)) dashboardCalendarAnchorDate = `${today.slice(0, 7)}-01`;
    const range = CalendarCore.monthGrid(dashboardCalendarAnchorDate);
    const days = range?.days || [];
    const recordsByDate = new Map(days.map((entry) => [entry.date, []]));
    const uniqueVisibleSlots = new Set();
    selectedProjects.forEach((project) => {
      CalendarCore.sortSlots(dashboardCalendarItems(project), { project }).forEach((slot) => {
        days.forEach((entry) => {
          if (!CalendarCore.slotOccursOnDate(slot, entry.date)) return;
          recordsByDate.get(entry.date).push({ project, slot });
          uniqueVisibleSlots.add(`${project.id}|${slot.id}`);
        });
      });
    });
    recordsByDate.forEach((records, date) => records.sort((left, right) => {
      const leftCancelled = left.slot.status === 'cancelled' ? 1 : 0;
      const rightCancelled = right.slot.status === 'cancelled' ? 1 : 0;
      if (leftCancelled !== rightCancelled) return leftCancelled - rightCancelled;
      const leftTime = date === left.slot.date ? (left.slot.startTime || '24:00') : '00:00';
      const rightTime = date === right.slot.date ? (right.slot.startTime || '24:00') : '00:00';
      return leftTime.localeCompare(rightTime)
        || String(left.project.name || '').localeCompare(String(right.project.name || ''), 'ko')
        || String(left.slot.label || '').localeCompare(String(right.slot.label || ''), 'ko');
    }));
    $('#dashboardCalendarPeriod').textContent = calendarDateLabel(range.monthStart, { day: false });
    const legend = $('#dashboardCalendarLegend'); legend.replaceChildren();
    selectedProjects.forEach((project) => {
      const item = element('span', 'dashboard-calendar-legend-item'); item.style.setProperty('--project-color', dashboardProjectColor(project.id));
      item.append(element('span', 'dashboard-calendar-project-dot'), element('span', '', project.name)); legend.append(item);
    });
    if (!selectedProjects.length) legend.append(element('span', '', '진행 중인 프로젝트가 없습니다.'));
    grid.replaceChildren();
    let weekRow = null;
    days.forEach((entry, index) => {
      if (index % 7 === 0) { weekRow = element('div', 'dashboard-calendar-week-row'); weekRow.setAttribute('role', 'row'); grid.append(weekRow); }
      const cell = element('section', `dashboard-calendar-day${entry.inMonth ? '' : ' outside-month'}${entry.date === today ? ' today' : ''}`); cell.setAttribute('role', 'gridcell'); cell.dataset.dashboardCalendarDate = entry.date;
      cell.append(element('span', 'dashboard-calendar-day-number', String(Number(entry.date.slice(8, 10)))));
      const events = element('div', 'dashboard-calendar-events'); const records = recordsByDate.get(entry.date) || []; const expanded = dashboardCalendarExpandedDates.has(entry.date);
      records.slice(0, expanded ? records.length : 3).forEach(({ project, slot }) => {
        const phase = CalendarCore.classifySlot(slot, { project }); const endDate = CalendarCore.slotEndDate(slot);
        const button = element('button', `dashboard-calendar-event phase-${phase.status} status-${slot.status || 'draft'}`); button.type = 'button'; button.dataset.dashboardCalendarProject = project.id; if (slot.dashboardKind === 'session') button.dataset.dashboardCalendarSession = slot.id; else button.dataset.dashboardCalendarSlot = slot.id; button.style.setProperty('--project-color', dashboardProjectColor(project.id));
        const segmentTime = slot.dashboardKind === 'session' ? (entry.date === slot.date ? '시작' : entry.date === endDate ? '종료' : '진행') : entry.date === slot.date ? slot.startTime : entry.date === endDate ? `종료 ${slot.endTime}` : '계속';
        const copy = element('span'); copy.append(element('strong', '', `${segmentTime || '--:--'} ${slot.label || '이름 없는 일정'}`), element('small', '', project.name)); button.append(copy);
        const visibleRange = slot.dashboardKind === 'session'
          ? `${calendarDateLabel(slot.date, { year: true, weekday: false })}${endDate !== slot.date ? `–${calendarDateLabel(endDate, { year: slot.date.slice(0, 4) !== endDate.slice(0, 4), weekday: false })}` : ''}`
          : slotRangeText(slot, { includeYear: true });
        button.title = `${project.name} · ${slot.label || '이름 없는 일정'} · ${visibleRange}`;
        button.setAttribute('aria-label', `${button.title}. 해당 프로젝트 캘린더 열기`); events.append(button);
      });
      if (records.length > 3) {
        const more = element('button', 'dashboard-calendar-more', expanded ? '일정 접기' : `＋${records.length - 3}개 더 보기`); more.type = 'button'; more.dataset.dashboardCalendarShowDay = entry.date; more.setAttribute('aria-expanded', String(expanded)); more.setAttribute('aria-label', `${calendarDateLabel(entry.date, { weekday: true })} 일정 ${expanded ? '접기' : `${records.length - 3}개 더 보기`}`); events.append(more);
      }
      cell.append(events); weekRow.append(cell);
    });
    const empty = $('#dashboardCalendarEmpty'); empty.hidden = uniqueVisibleSlots.size > 0;
    const visibleProjectCount = new Set([...uniqueVisibleSlots].map((key) => key.split('|')[0])).size;
    $('#dashboardCalendarPanel').dataset.summary = `${visibleProjectCount}개 프로젝트 · ${uniqueVisibleSlots.size}개 세션·일정`;
  }

  function renderDashboard() {
    const project = activeProject();
    const quickLaunch = $('#homeQuickLaunch'); quickLaunch.replaceChildren();
    Core.MODULE_CATALOG.filter((module) => state.installedExtensions.includes(module.id)).forEach((module) => {
      const button = element('button', 'quick-launch-button'); button.type = 'button'; button.dataset.programLaunch = module.id;
      button.append(element('span', `module-icon accent-${module.accent}`, module.icon || module.shortName.slice(0, 1)));
      const helper = module.id === 'projectCalendar' ? (project ? `${project.name} 일정 열기` : '프로젝트를 선택하면 사용 가능') : '프로젝트 없이 바로 사용';
      const copy = element('span'); copy.append(element('strong', '', module.name), element('small', '', helper)); button.append(copy); quickLaunch.append(button);
    });
    renderDashboardCalendar();
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
      const taskDefinition = Core.workflowTaskCatalog().find((item) => item.id === workflowStep.type);
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
    newProjectWorkflowDraft = (selected?.steps || []).map((step, index) => {
      const definition = Core.workflowTaskCatalog().find((item) => item.id === step.type || item.moduleId === step.moduleId);
      return { ...JSON.parse(JSON.stringify(step)), moduleId: step.moduleId || definition?.moduleId || null, order: index };
    });
    newProjectWorkflowModified = false;
    renderNewProjectWorkflowDraft();
  }

  function availableWorkflowTaskTypes() {
    return Core.workflowTaskCatalog().filter((type) => !type.moduleId || state.installedExtensions.includes(type.moduleId));
  }

  function renderNewProjectWorkflowDraft() {
    const preview = $('#newProjectStepPreview');
    if (preview) preview.replaceChildren(...newProjectWorkflowDraft.map((step) => element('span', '', step.name)));
    const list = $('#newProjectWorkflowList');
    if (!list) return;
    list.replaceChildren();
    if (!newProjectWorkflowDraft.length) list.append(element('div', 'list-empty', '시작 단계가 없습니다. 아래에서 첫 작업을 추가하세요.'));
    newProjectWorkflowDraft.forEach((step, index) => {
      const row = element('div', 'workflow-editor-row new-project-workflow-row'); row.dataset.newProjectWorkflowStep = step.id;
      row.append(element('span', 'workflow-editor-order', String(index + 1)));
      const copy = element('div', 'new-project-workflow-copy');
      copy.append(element('strong', '', step.name), element('small', '', step.description || Core.workflowTaskCatalog().find((item) => item.id === step.type)?.description || ''));
      const actions = element('div', 'workflow-editor-actions');
      const up = element('button', 'secondary-button', '↑'); up.type = 'button'; up.dataset.newProjectWorkflowMove = step.id; up.dataset.direction = '-1'; up.disabled = index === 0; up.title = '위로 이동';
      const down = element('button', 'secondary-button', '↓'); down.type = 'button'; down.dataset.newProjectWorkflowMove = step.id; down.dataset.direction = '1'; down.disabled = index === newProjectWorkflowDraft.length - 1; down.title = '아래로 이동';
      const remove = element('button', 'secondary-button danger-text', '삭제'); remove.type = 'button'; remove.dataset.newProjectWorkflowRemove = step.id;
      actions.append(up, down, remove); row.append(copy, actions); list.append(row);
    });
    const typeSelect = $('#newProjectWorkflowStepType');
    const previous = typeSelect?.value;
    if (typeSelect) {
      const types = availableWorkflowTaskTypes();
      typeSelect.replaceChildren(...types.map((type) => { const option = element('option', '', type.name); option.value = type.id; return option; }));
      if (types.some((type) => type.id === previous)) typeSelect.value = previous;
    }
  }

  function openWorkflowEditor() {
    const project = activeProject();
    if (!project) return;
    workflowEditorDraft = JSON.parse(JSON.stringify(project.workflow || []));
    workflowEditorTemplateDraft = { ...project.workflowTemplate, modified: true };
    const typeSelect = $('#workflowStepType');
    typeSelect.replaceChildren(...availableWorkflowTaskTypes().map((type) => { const option = element('option', '', type.name); option.value = type.id; return option; }));
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
    if (step.moduleId) openWorkflowModule(step.moduleId, { stepId: step.id, documentMode: step.documentMode || '' });
    else navigate('workflowTask');
  }

  function renderWorkflowTaskPage() {
    const project = activeProject(); const step = project?.workflow.find((item) => item.id === activeWorkflowStepId);
    if (!project || !step) { navigate('dashboard'); return; }
    const definition = Core.workflowTaskCatalog().find((item) => item.id === step.type);
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
          const duplicate = element('button', 'secondary-button compact', '구조 복제');
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
      if (module.projectStep || module.contributes?.projectStep) titleRow.append(element('span', 'project-step-badge', '프로젝트 단계에 추가 가능'));
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
    Core.CONNECTION_TYPES.forEach((service) => {
      const details = CONNECTION_SERVICE_DETAILS[service.id] || { icon: service.name.slice(0, 1), description: '이 서비스의 계정을 Workspace에 연결합니다.' };
      const connections = state.connections.filter((connection) => connection.type === service.id);
      const connected = connections.filter((connection) => connection.status === 'connected');
      const hasError = !connected.length && connections.some((connection) => connection.status === 'error');
      const statusKey = connected.length ? 'connected' : hasError ? 'error' : 'needsAuth';
      const statusText = connected.length ? '연결됨' : hasError ? '연결 오류' : '연결 필요';
      const titleId = `connection-service-${service.id}-title`;
      const card = element('article', `service-connection-card service-type-${service.id}`);
      card.dataset.serviceCard = service.id;
      card.setAttribute('aria-labelledby', titleId);

      const header = element('header', 'service-connection-header');
      const icon = element('span', 'service-connection-icon', details.icon);
      icon.setAttribute('aria-hidden', 'true');
      const heading = element('div', 'service-connection-heading');
      const title = element('h2', '', service.name); title.id = titleId;
      heading.append(title, element('p', '', details.description));
      const summary = element('span', `service-connection-status ${statusKey}`, statusText);
      summary.setAttribute('aria-live', 'polite');
      summary.tabIndex = -1;
      header.append(icon, heading, summary);
      card.append(header);

      const accountArea = element('div', 'service-account-area');
      if (!connections.length) {
        accountArea.append(element('p', 'service-account-empty', '아직 연결된 계정이 없습니다.'));
      } else {
        const accountList = element('ul', 'service-account-list');
        accountList.setAttribute('aria-label', `${service.name} 연결 계정`);
        const supportsWorkspaceDefault = ['forms', 'gmail', 'zoom'].includes(service.id);
        const defaultId = supportsWorkspaceDefault ? Core.resolveDefaultConnectionId(state, null, service.id) : null;
        connections.forEach((connection) => {
          const row = element('li', 'service-account-row');
          const identity = element('div', 'service-account-identity');
          const nameLine = element('div', 'service-account-name');
          nameLine.append(element('strong', '', connection.account || connection.label));
          if (defaultId === connection.id) nameLine.append(element('span', 'connection-default-badge', 'Workspace 기본'));
          const accountStatusText = connection.status === 'connected' ? '사용 가능' : connection.status === 'error' ? `연결 오류 · ${publicPersistedConnectionError(connection.lastAuthError, connection.type)}` : '로그인 필요';
          identity.append(nameLine, element('small', '', connection.account && connection.label !== connection.account ? `${connection.label} · ${accountStatusText}` : accountStatusText));
          const actions = element('div', 'service-account-actions');
          const providerName = service.id === 'zoom' ? 'Zoom' : 'Google';
          const authorizationActive = activeConnectionAuthorizations.has(connection.id);
          const authorize = element('button', 'secondary-button compact', authorizationActive ? '로그인 취소' : connection.status === 'connected' ? '다시 로그인' : `${providerName} 로그인`);
          authorize.type = 'button';
          if (authorizationActive) {
            authorize.dataset.connectionAuthorizationCancel = connection.id;
            authorize.setAttribute('aria-label', `${connection.account || connection.label} 로그인 취소`);
            authorize.disabled = pendingConnectionAuthorizationCancels.has(connection.id);
            if (authorize.disabled) authorize.textContent = '취소 중';
          } else {
            authorize.dataset.connectionAuthorize = connection.id;
            authorize.setAttribute('aria-label', `${connection.account || connection.label} ${connection.status === 'connected' ? '다시 로그인' : `${providerName} 로그인`}`);
          }
          actions.append(authorize);
          if (connection.status === 'connected') {
            const disconnect = element('button', 'text-button', '연결 해제');
            disconnect.type = 'button'; disconnect.dataset.connectionDisconnect = connection.id; disconnect.setAttribute('aria-label', `${connection.account || connection.label} 연결 해제`);
            actions.append(disconnect);
          }
          const remove = element('button', 'text-button danger-text', '삭제');
          remove.type = 'button'; remove.dataset.connectionRemove = connection.id; remove.setAttribute('aria-label', `${connection.account || connection.label} 계정 설정 삭제`);
          actions.append(remove);
          row.append(identity, actions);
          accountList.append(row);
        });
        accountArea.append(accountList);

        if (supportsWorkspaceDefault && connections.length > 1) {
          const defaultPicker = element('label', 'service-default-picker');
          defaultPicker.append(element('span', '', '모든 프로젝트의 기본 계정'));
          const select = document.createElement('select');
          select.dataset.serviceDefault = service.id;
          select.setAttribute('aria-label', `Workspace 기본 ${service.name} 계정`);
          const placeholder = element('option', '', '기본 계정 선택'); placeholder.value = ''; select.append(placeholder);
          connections.forEach((connection) => {
            const option = element('option', '', `${connection.account || connection.label}${connection.status === 'connected' ? '' : ' · 로그인 필요'}`);
            option.value = connection.id; select.append(option);
          });
          const explicitId = state.preferences.globalDefaultConnectionIds?.[service.id] || '';
          select.value = connections.some((connection) => connection.id === explicitId) ? explicitId : '';
          select.addEventListener('change', (event) => { void updateGlobalDefaultConnection(service.id, event.currentTarget.value); });
          defaultPicker.append(select, element('small', '', '새 프로젝트와 별도 계정을 고르지 않은 프로젝트에서 사용합니다.'));
          accountArea.append(defaultPicker);
          assertSmokeUi(Boolean(defaultPicker.querySelector(`[data-service-default="${service.id}"]`)), `${service.name} Workspace default picker is rendered`);
        }
      }
      card.append(accountArea);

      const footer = element('footer', 'service-connection-footer');
      const connect = element('button', 'primary-button service-connect-button', connections.length ? '다른 계정 연결' : `${service.id === 'zoom' ? 'Zoom' : 'Google'}에서 계정 연결`);
      connect.type = 'button'; connect.dataset.serviceConnect = service.id; connect.setAttribute('aria-label', `${service.name} ${connections.length ? '다른 계정 연결' : '계정 연결'}`);
      footer.append(connect);
      if (connected.length) footer.append(element('small', '', '로그인 권한은 이 PC의 보안 저장소에 보관됩니다.'));
      if (footer.childElementCount) card.append(footer);
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
    const standaloneModule = Core.MODULE_CATALOG.find((item) => item.id === standaloneProgram);
    if (standaloneModule?.workflow === false) {
      $('#standaloneWorkMenu').hidden = true;
      $('#standaloneConnectionStatus').textContent = '프로젝트와 관계없이 사용하며 결과는 선택한 폴더에만 저장됩니다.';
      return;
    }
    if (projectLinkedProgram) {
      $('#standaloneWorkMenu').hidden = true; const project = activeProject(); $('#standaloneConnectionStatus').textContent = project ? `${project.name} · 실제 프로젝트에 자동 저장됩니다.` : '캘린더를 사용할 프로젝트를 먼저 선택해주세요.'; return;
    }
    $('#standaloneWorkMenu').hidden = false;
    const select = $('#quickTaskSelect'); select.replaceChildren(element('option', '', '현재 빠른 작업'));
    (state.quickTasks?.[standaloneProgram] || []).slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).forEach((task) => { const option = element('option', '', `${task.name} · ${formatUpdatedAt(task.savedAt)}`); option.value = task.id; select.append(option); });
    const projectSelect = $('#standaloneProjectSelect'); projectSelect.replaceChildren(element('option', '', '프로젝트 자료 가져오기'));
    state.projects.filter((item) => item.status !== 'archived').forEach((item) => { const option = element('option', '', item.name); option.value = item.id; projectSelect.append(option); });
    const quickProject = activeProject();
    const quickConnectionId = standaloneProgram === 'gmailFlow' ? defaultConnectionId(quickProject, 'gmail') : null;
    const connected = state.connections.find((item) => item.id === quickConnectionId && item.status === 'connected');
    $('#standaloneConnectionStatus').textContent = standaloneProgram === 'gmailFlow'
      ? (connected?.account || 'Workspace 기본 Gmail 계정 연결이 필요합니다.')
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
      roleIds: Ops.normalizePersonRoleIds([], project.data.roles),
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
    const removedAssignmentIds = new Set((project.data.assignments || []).filter((assignment) => removedPersonIds.has(assignment.personId) || restoredPersonIds.has(assignment.personId)).map((assignment) => assignment.id));
    project.data.assignments = (Array.isArray(project.data.assignments) ? project.data.assignments : [])
      .filter((assignment) => !removedPersonIds.has(assignment.personId) && !restoredPersonIds.has(assignment.personId));
    project.data.assignments.push(...JSON.parse(JSON.stringify((Array.isArray(value.assignments) ? value.assignments : []).filter((assignment) => restoredPersonIds.has(assignment.personId) && validSlotIds.has(assignment.slotId) && (!assignment.roleId || validRoleIds.has(assignment.roleId))))));
    removeActivityAssignmentLinks(project, { assignmentIds: removedAssignmentIds, personIds: removedPersonIds });
    pruneActivityAssignmentsAfterCalendarChange(project);
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
    $$('[data-select-roster-row]', $('#rosterEditorTable')).forEach((cell) => { const row = Number(cell.dataset.selectRosterRow); setSheetSelectorPressed(cell, mode === 'row' && row >= minRow && row <= maxRow); });
    $$('[data-select-roster-column]', $('#rosterEditorTable')).forEach((cell) => { const col = Number(cell.dataset.selectRosterColumn); setSheetSelectorPressed(cell, mode === 'column' && col >= minCol && col <= maxCol); });
    const allSelector = $('#rosterEditorTable [data-select-roster-all]'); if (allSelector) setSheetSelectorPressed(allSelector, mode === 'all');
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
    const removedAssignmentIds = new Set(project.data.assignments.filter((assignment) => ids.has(assignment.personId)).map((assignment) => assignment.id));
    project.data.people = project.data.people.filter((person) => !ids.has(person.id));
    project.data.assignments = project.data.assignments.filter((assignment) => !ids.has(assignment.personId));
    removeActivityAssignmentLinks(project, { assignmentIds: removedAssignmentIds, personIds: ids });
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
    const letterRow = element('tr', 'sheet-letter-row'); const corner = configureSheetSelector(element('th', 'sheet-corner', ''), '명단 표 전체 선택'); corner.dataset.selectRosterAll = 'true'; corner.title = '전체 표 선택'; letterRow.append(corner);
    project.data.columns.forEach((_column, index) => { const columnName = spreadsheetColumnName(index); const letter = configureSheetSelector(element('th', 'sheet-letter', columnName), `${columnName}열 전체 선택`); letter.dataset.selectRosterColumn = String(index); letter.title = `${columnName}열 전체 선택`; letterRow.append(letter); });
    const roleLetter = element('th', 'sheet-letter roster-role-letter', ''); roleLetter.setAttribute('aria-hidden', 'true');
    letterRow.append(roleLetter, element('th', 'sheet-letter', spreadsheetColumnName(project.data.columns.length)));
    const headRow = element('tr'); headRow.append(element('th', 'sheet-row-number', '1'));
    project.data.columns.forEach((column, columnIndex) => {
      const th = element('th');
      th.dataset.sheetRow = '0'; th.dataset.sheetCol = String(columnIndex);
      const wrapper = element('div', 'column-head');
      const nameInput = element('input');
      nameInput.type = 'text'; nameInput.value = column.name; nameInput.dataset.columnName = column.id; nameInput.setAttribute('aria-label', `${spreadsheetColumnName(columnIndex)}열 컬럼 이름`);
      const typeSelect = element('select');
      typeSelect.dataset.columnType = column.id; typeSelect.setAttribute('aria-label', `${spreadsheetColumnName(columnIndex)}열 데이터 종류`);
      [
        ['name', '이름'], ['email', '수신 이메일'], ['id', '아이디'], ['phone', '전화번호'],
        ['group', '그룹·분류'], ['text', '일반 텍스트'], ['date', '날짜'], ['number', '숫자'], ['url', '링크']
      ].forEach(([value, label]) => {
        const option = element('option', '', label); option.value = value; option.selected = column.type === value; typeSelect.append(option);
      });
      wrapper.append(nameInput, typeSelect); th.append(wrapper); headRow.append(th);
    });
    const roleHeader = element('th', 'roster-role-header', '배정 역할'); roleHeader.scope = 'col'; roleHeader.title = '일정 편성에서 수동 후보로 사용할 역할';
    headRow.append(roleHeader);
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
      const rowNumber = configureSheetSelector(element('th', 'sheet-row-number', String(rowIndex + 2)), `${rowIndex + 2}행 전체 선택`); rowNumber.dataset.selectRosterRow = String(rowIndex + 1); rowNumber.title = `${rowIndex + 2}행 전체 선택`; tr.append(rowNumber);
      project.data.columns.forEach((column, columnIndex) => {
        const td = element('td');
        td.dataset.sheetRow = String(rowIndex + 1); td.dataset.sheetCol = String(columnIndex);
        const input = element('input');
        input.type = column.type === 'email' ? 'email' : 'text'; input.autocomplete = 'off'; input.setAttribute('aria-label', `${rowIndex + 2}행 ${spreadsheetColumnName(columnIndex)}열 ${column.name}`);
        input.value = person?.values?.[column.id] || '';
        input.readOnly = inactive; input.setAttribute('aria-readonly', String(inactive));
        if (inactive) input.setAttribute('aria-describedby', 'rosterEditorAccessibilityHelp');
        input.dataset.personRow = String(rowIndex);
        if (person) input.dataset.personValue = person.id;
        input.dataset.columnId = column.id;
        td.append(input); tr.append(td);
      });
      const roleCell = element('td', 'roster-role-cell');
      if (person) {
        const assignedRoleIds = new Set(Ops.normalizePersonRoleIds(person.roleIds, project.data.roles));
        const assignedRoles = project.data.roles.filter((role) => role.active !== false && assignedRoleIds.has(role.id));
        if (inactive) {
          roleCell.append(element('span', 'roster-role-readonly', assignedRoles.map((role) => role.name).join(', ') || '역할 없음'));
        } else {
          const picker = element('details', 'roster-role-picker'); picker.dataset.personRolePicker = person.id;
          const roleNames = assignedRoles.map((role) => role.name).join(', ') || '역할 선택';
          const summaryButton = element('summary', '', roleNames);
          summaryButton.setAttribute('aria-label', `${person.name || `${rowIndex + 2}행`} 배정 역할: ${roleNames}`);
          const options = element('div', 'roster-role-options');
          project.data.roles.filter((role) => role.active !== false).forEach((role) => {
            const label = element('label', 'roster-role-option');
            const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = assignedRoleIds.has(role.id);
            checkbox.dataset.personRoleCheck = person.id; checkbox.dataset.roleId = role.id;
            checkbox.setAttribute('aria-label', `${person.name || `${rowIndex + 2}행`} · ${role.name} 역할`);
            label.append(checkbox, element('span', '', role.name)); options.append(label);
          });
          picker.append(summaryButton, options); roleCell.append(picker);
        }
      } else roleCell.append(element('span', 'roster-role-empty', '—'));
      tr.append(roleCell, element('td', 'roster-add-column-spacer', ''));
      return tr;
    });
    table.tBodies[0].replaceChildren(...rows);
    if (rosterSelection && [rosterSelection.anchor, rosterSelection.focus].some((point) => point.row > project.data.people.length || point.col >= project.data.columns.length)) rosterSelection = null;
    if (rosterSelection) updateRosterSelection(rosterSelection.anchor, rosterSelection.focus, rosterSelection.mode);
    else { $('#rosterSelectionStatus').textContent = '선택 없음'; $('#rosterCellAddress').textContent = '—'; $('#rosterCellValue').value = ''; $('#rosterCellValue').disabled = true; }
    syncRosterHistoryControls();
    assertAccessibleSheet(table, 'input:not([type="hidden"]), select', '[data-select-roster-all], [data-select-roster-column], [data-select-roster-row]');
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
    $$('[data-select-arrangement-row]', $('#arrangementBoard')).forEach((cell) => { const row = Number(cell.dataset.selectArrangementRow); setSheetSelectorPressed(cell, mode === 'row' && row >= minRow && row <= maxRow); });
    $$('[data-select-arrangement-column]', $('#arrangementBoard')).forEach((cell) => { const col = Number(cell.dataset.selectArrangementColumn); setSheetSelectorPressed(cell, mode === 'column' && col >= minCol && col <= maxCol); });
    const allSelector = $('#arrangementBoard [data-select-arrangement-all]'); if (allSelector) setSheetSelectorPressed(allSelector, mode === 'all');
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
    const table = $('#arrangementBoard'); const letterRow = element('tr', 'sheet-letter-row'); const corner = configureSheetSelector(element('th', 'sheet-corner', ''), '작업표 전체 선택'); corner.dataset.selectArrangementAll = 'true'; corner.title = '전체 표 선택'; letterRow.append(corner);
    item.columns.forEach((_column, index) => { const columnName = spreadsheetColumnName(index); const letter = configureSheetSelector(element('th', 'sheet-letter', columnName), `${columnName}열 전체 선택`); letter.dataset.selectArrangementColumn = String(index); letter.title = `${columnName}열 전체 선택`; letterRow.append(letter); }); letterRow.append(element('th', 'sheet-letter', spreadsheetColumnName(item.columns.length)));
    const headerRow = element('tr'); headerRow.append(element('th', 'sheet-row-number', '1'));
    item.columns.forEach((column, index) => { const th = element('th', 'arrangement-column-header'); th.dataset.arrangementRow = '-1'; th.dataset.arrangementCol = String(index); const name = element('button', 'arrangement-column-name', column.name); name.type = 'button'; name.dataset.arrangementRenameColumn = column.id; name.title = '드래그하여 선택 · 더블클릭하여 컬럼 이름 변경'; const remove = element('button', 'arrangement-column-remove', '×'); remove.type = 'button'; remove.dataset.arrangementRemoveColumn = column.id; remove.setAttribute('aria-label', `${column.name} 컬럼 삭제`); th.append(name, remove); headerRow.append(th); });
    const addTh = element('th', 'arrangement-add-column'); const add = element('button', '', '＋ 컬럼'); add.type = 'button'; add.dataset.arrangementAddColumn = 'true'; addTh.append(add); headerRow.append(addTh); table.tHead.replaceChildren(letterRow, headerRow);
    const visibleRows = Math.max(item.rows.length + 2, 5); const rows = Array.from({ length: visibleRows }, (_, rowIndex) => { const tr = element('tr'); const rowNumber = configureSheetSelector(element('th', 'sheet-row-number', String(rowIndex + 2)), `${rowIndex + 2}행 전체 선택`); rowNumber.dataset.selectArrangementRow = String(rowIndex); rowNumber.title = `${rowIndex + 2}행 전체 선택`; tr.append(rowNumber); item.columns.forEach((column, colIndex) => { const td = element('td'); td.dataset.arrangementRow = String(rowIndex); td.dataset.arrangementCol = String(colIndex); const input = element('input'); input.type = 'text'; input.autocomplete = 'off'; input.value = item.rows[rowIndex]?.values?.[column.id] || ''; input.dataset.arrangementInput = 'true'; input.setAttribute('aria-label', `${rowIndex + 2}행 ${spreadsheetColumnName(colIndex)}열 ${column.name}`); td.append(input); tr.append(td); }); tr.append(element('td', 'roster-add-column-spacer', '')); return tr; });
    table.tBodies[0].replaceChildren(...rows);
    if (arrangementSelection && arrangementSelection.focus.col < item.columns.length) updateArrangementSelection(arrangementSelection.anchor, arrangementSelection.focus, arrangementSelection.mode); else { arrangementSelection = null; $('#arrangementSelectionStatus').textContent = '선택 없음'; $('#arrangementCellAddress').textContent = '—'; $('#arrangementCellValue').value = ''; $('#arrangementCellValue').disabled = true; }
    syncArrangementHistoryControls();
    assertAccessibleSheet(table, '[data-arrangement-input]', '[data-select-arrangement-all], [data-select-arrangement-column], [data-select-arrangement-row]');
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
      const remove = element('button', 'role-delete', '×'); remove.type = 'button'; remove.title = '역할 삭제'; remove.setAttribute('aria-label', `${role.name || '역할'} 역할 삭제`); remove.dataset.roleRemove = role.id; remove.disabled = project.data.roles.length <= 1;
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
    const table = element('table', 'availability-table'); table.setAttribute('aria-label', '사람별 가능 시간');
    const head = element('thead'); const headRow = element('tr');
    const nameHeading = element('th', '', '이름 / 전체'); nameHeading.scope = 'col'; headRow.append(nameHeading);
    project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).forEach((slot) => {
      const th = element('th', 'slot-heading'); th.scope = 'col'; th.textContent = slotRangeText(slot, { includeYear: true }); headRow.append(th);
    });
    head.append(headRow); table.append(head);
    const body = element('tbody');
    const scheduleView = project.data.rosterViews.find((view) => view.id === project.data.scheduleRules.rosterViewId) || null; const scheduleIds = new Set(rosterViewIncludedIds(scheduleView, project));
    project.data.people.filter((person) => person.active !== false && scheduleIds.has(person.id)).forEach((person) => {
      const row = element('tr');
      const nameCell = element('th'); nameCell.scope = 'row';
      const allLabel = element('label', 'check-row');
      const all = element('input'); all.type = 'checkbox'; all.dataset.availabilityAll = person.id;
      const selected = project.data.availability[person.id] || [];
      all.checked = project.data.slots.length > 0 && project.data.slots.every((slot) => selected.includes(slot.id));
      allLabel.append(all, document.createTextNode(person.name || '이름 없음')); nameCell.append(allLabel); row.append(nameCell);
      project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).forEach((slot) => {
        const cell = element('td'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.includes(slot.id); checkbox.dataset.availabilityPerson = person.id; checkbox.dataset.availabilitySlot = slot.id; checkbox.setAttribute('aria-label', `${person.name || '이름 없음'}, ${slotRangeText(slot, { includeYear: true })} 가능`); cell.append(checkbox); row.append(cell);
      });
      body.append(row);
    });
    table.append(body); container.replaceChildren(table);
    assertSmokeUi($$('input[type="checkbox"]', table).every((input) => Boolean(input.getAttribute('aria-label') || input.closest('label'))), 'availability checkboxes have accessible names');
  }

  function defaultScheduleSheetColumns(project) {
    return [
      { id: 'schedule-date', key: 'date', name: '날짜', kind: 'system', roleId: null },
      { id: 'schedule-end-date', key: 'endDate', name: '종료 날짜', kind: 'system', roleId: null },
      { id: 'schedule-start', key: 'startTime', name: '시작', kind: 'system', roleId: null },
      { id: 'schedule-end', key: 'endTime', name: '종료', kind: 'system', roleId: null },
      { id: 'schedule-label', key: 'label', name: '세션명', kind: 'system', roleId: null },
      ...project.data.roles.filter((role) => role.active).map((role) => ({ id: `schedule-role-${role.id}`, key: `role:${role.id}`, name: role.name, kind: 'role', roleId: role.id })),
      { id: 'schedule-status', key: 'status', name: '상태', kind: 'system', roleId: null },
      { id: 'schedule-locked', key: 'locked', name: '잠금', kind: 'system', roleId: null }
    ];
  }

  function ensureScheduleEndDateColumn(project) {
    if (!project?.data.scheduleSheetInitialized || !Array.isArray(project.data.scheduleSheetColumns) || project.data.scheduleSheetColumns.some((column) => column.key === 'endDate')) return false;
    const dateIndex = project.data.scheduleSheetColumns.findIndex((column) => column.key === 'date');
    project.data.scheduleSheetColumns.splice(dateIndex >= 0 ? dateIndex + 1 : 0, 0, { id: 'schedule-end-date', key: 'endDate', name: '종료 날짜', kind: 'system', roleId: null });
    return true;
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
    const storedColumns = project.data.scheduleSheetInitialized && Array.isArray(project.data.scheduleSheetColumns) ? project.data.scheduleSheetColumns : null;
    if (storedColumns && project.data.slots.some((slot) => slot.endDate)) ensureScheduleEndDateColumn(project);
    const columns = storedColumns
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
    if (column.key === 'endDate') return slot.endDate || slot.date || '';
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
      if (keys.has('endDate') && slot.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(slot.endDate)) messages.push({ type: 'sheet', message: `${index + 2}행: 종료 날짜를 YYYY-MM-DD 형식으로 입력해주세요.` });
      if (slot.endDate && slot.date && slot.endDate < slot.date) messages.push({ type: 'sheet', message: `${index + 2}행: 종료 날짜는 시작 날짜보다 빠를 수 없습니다.` });
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
      const removedAssignmentIds = new Set(project.data.assignments.filter((item) => item.slotId === slot.id && item.roleId === column.role.id).map((item) => item.id));
      project.data.assignments = project.data.assignments.filter((item) => !(item.slotId === slot.id && item.roleId === column.role.id));
      removeActivityAssignmentLinks(project, { assignmentIds: removedAssignmentIds });
      peopleTokens(text).forEach((name, position) => {
        const lowered = name.toLowerCase();
        const person = project.data.people.find((item) => [item.name, item.email, item.phone].some((candidate) => String(candidate || '').toLowerCase() === lowered));
        project.data.assignments.push({ id: `assignment-${Date.now().toString(36)}-${rowIndex}-${scheduleAssignmentSequence++}-${position}`, slotId: slot.id, personId: person?.id || '', personName: person?.name || name, roleId: column.role.id, roleName: column.role.name, locked: Boolean(slot.locked), source: 'manual-sheet' });
      });
      pruneActivityAssignmentsAfterCalendarChange(project);
    } else if (column.kind === 'custom') {
      project.data.scheduleCustomValues[slot.id] ||= {}; project.data.scheduleCustomValues[slot.id][column.id] = String(value ?? '');
    } else if (column.key === 'status') {
      const statusMap = { '편성 중': 'draft', '초안': 'draft', draft: 'draft', '확정': 'confirmed', confirmed: 'confirmed', '변경됨': 'changed', changed: 'changed', '취소': 'cancelled', cancelled: 'cancelled' };
      slot.status = statusMap[text] || text || 'draft';
    } else if (column.key === 'locked') {
      slot.locked = /^(예|y|yes|true|1|잠금)$/i.test(text); project.data.assignments.filter((item) => item.slotId === slot.id).forEach((item) => { item.locked = slot.locked; });
    } else {
      if (column.key === 'endDate') { if (!text || text === slot.date) delete slot.endDate; else slot.endDate = text; }
      else slot[column.key] = text;
      if (column.key === 'date' && slot.endDate && text && slot.endDate < text) delete slot.endDate;
      if (column.key === 'startTime' && text && !slot.endTime) slot.endTime = Ops.addMinutesToTime(text, project.settings?.sessionDurationMinutes);
    }
    scheduleEditGeneration += 1;
    refreshScheduleConflicts(project);
    return true;
  }

  function scheduleSnapshot(project) {
    const relatedModules = new Set(['schedule', 'projectCalendar', 'zoom', 'gmailFlow', 'forms']);
    return JSON.stringify({ slots: project.data.slots, activities: project.data.activities, assignments: project.data.assignments, activityAssignments: project.data.activityAssignments, availability: project.data.availability, scheduleSheetInitialized: project.data.scheduleSheetInitialized, scheduleSheetColumns: project.data.scheduleSheetColumns, scheduleCustomValues: project.data.scheduleCustomValues, projectCalendar: project.data.extensionData?.projectCalendar || {}, externalArtifacts: project.data.externalArtifacts || [], moduleState: Object.fromEntries(Object.entries(project.moduleState || {}).filter(([moduleId]) => relatedModules.has(moduleId))), workflowState: (project.workflow || []).filter((step) => relatedModules.has(step.moduleId)).map((step) => ({ id: step.id, status: step.status, updatedAt: step.updatedAt, notes: step.notes })) });
  }

  function removeActivityAssignmentLinks(project, { activityIds = [], assignmentIds = [], personIds = [] } = {}) {
    const removedActivityIds = activityIds instanceof Set ? activityIds : new Set(activityIds || []);
    const removedAssignmentIds = assignmentIds instanceof Set ? assignmentIds : new Set(assignmentIds || []);
    const removedPersonIds = personIds instanceof Set ? personIds : new Set(personIds || []);
    const validActivityIds = new Set((project.data.activities || []).map((activity) => activity.id));
    const validAssignmentIds = new Set((project.data.assignments || []).map((assignment) => assignment.id));
    const validPersonIds = new Set((project.data.people || []).map((person) => person.id));
    const before = (project.data.activityAssignments || []).length;
    project.data.activityAssignments = (project.data.activityAssignments || []).filter((link) => {
      const hasValidActivity = hasStoredId(link.activityId) && validActivityIds.has(link.activityId);
      const hasValidAssignment = hasStoredId(link.assignmentId) && validAssignmentIds.has(link.assignmentId);
      return !removedActivityIds.has(link.activityId)
        && !removedAssignmentIds.has(link.assignmentId)
        && !removedPersonIds.has(link.personId)
        && (hasValidActivity || hasValidAssignment)
        && (!hasStoredId(link.personId) || validPersonIds.has(link.personId));
    });
    return before - project.data.activityAssignments.length;
  }

  function removeCalendarDataForSlots(project, slotIds, removedAssignmentIds = []) {
    const ids = slotIds instanceof Set ? slotIds : new Set(slotIds || []);
    if (!ids.size) return;
    const removedActivityIds = new Set((project.data.activities || []).filter((activity) => ids.has(storedId(activity.eventId, activity.slotId))).map((activity) => activity.id));
    project.data.activities = (project.data.activities || []).filter((activity) => !removedActivityIds.has(activity.id));
    removeActivityAssignmentLinks(project, { activityIds: removedActivityIds, assignmentIds: removedAssignmentIds });
    ids.forEach((slotId) => { if (project.data.scheduleCustomValues) delete project.data.scheduleCustomValues[slotId]; });
  }

  function restoreScheduleSnapshot(project, snapshot) {
    const data = JSON.parse(snapshot);
    project.data.slots = Array.isArray(data.slots) ? data.slots : [];
    project.data.activities = Array.isArray(data.activities) ? data.activities : [];
    project.data.assignments = Array.isArray(data.assignments) ? data.assignments : [];
    project.data.activityAssignments = Array.isArray(data.activityAssignments) ? data.activityAssignments : [];
    project.data.availability = data.availability && typeof data.availability === 'object' ? data.availability : project.data.availability;
    project.data.scheduleSheetInitialized = data.scheduleSheetInitialized;
    project.data.scheduleSheetColumns = data.scheduleSheetColumns;
    project.data.scheduleCustomValues = data.scheduleCustomValues || {};
    project.data.extensionData ||= {};
    project.data.extensionData.projectCalendar = data.projectCalendar && typeof data.projectCalendar === 'object' ? data.projectCalendar : project.data.extensionData.projectCalendar || {};
    const restoredSideEffects = Array.isArray(data.externalArtifacts) && data.moduleState && typeof data.moduleState === 'object';
    if (Array.isArray(data.externalArtifacts)) project.data.externalArtifacts = data.externalArtifacts;
    if (data.moduleState && typeof data.moduleState === 'object') project.moduleState = { ...(project.moduleState || {}), ...data.moduleState };
    if (Array.isArray(data.workflowState)) {
      const savedSteps = new Map(data.workflowState.map((step) => [step.id, step]));
      project.workflow = (project.workflow || []).map((step) => savedSteps.has(step.id) ? { ...step, ...savedSteps.get(step.id) } : step);
    }
    refreshScheduleConflicts(project);
    return restoredSideEffects;
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
    const scheduleKeys = ['roles', 'slots', 'activities', 'availability', 'assignments', 'activityAssignments', 'conflicts', 'scheduleRules', 'scheduleSheetInitialized', 'scheduleSheetColumns', 'scheduleCustomValues', 'versions'];
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
    clearScheduleHistory(project.id);
  }

  function hasFocusedWorkspaceDraft() {
    const target = document.activeElement;
    if (!target?.matches?.('[data-person-row], [data-column-name], #rosterCellValue, [data-arrangement-input], #arrangementCellValue, [data-schedule-input], #scheduleCellValue, #mailSubjectTemplate, #mailBodyEditor, #mailEditSubject, #mailEditBody, #formTitleInput, #formDescriptionInput, #formEmailCollection, #formQuizMode, [data-form-editor-input], #calendarAdjustmentDialog input, #calendarAdjustmentDialog select, #calendarActivityDialog input, #calendarActivityDialog textarea')) return false;
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
    clearFormStructureHistory();
    rosterSelecting = false;
    arrangementSelecting = false;
    scheduleSelecting = false;
    $('#rosterEditorTable')?.classList.remove('range-selecting');
    $('#arrangementBoard')?.classList.remove('range-selecting');
    $('#scheduleBoard')?.classList.remove('range-selecting');
    acceptPersistedBaseline(nextState);
    state = nextState;
    pendingMergedSurfaceRender = false;
    pendingMergedFormsRender = false;
    pendingMergedFormsFocusToken = null;
    if (state.preferences.storageMode === 'drive') scheduleDriveStateSync();
    if (mailEditorDirty && currentPage === 'gmailFlow') {
      showToast('다른 창의 변경사항을 받았습니다. 작성 중인 메일은 그대로 보호됩니다.');
      renderGmailPage();
      renderConnectionsPage();
    } else if (formEditorDirty && currentPage === 'forms') {
      showToast('다른 창의 변경사항을 받았습니다. 편집 중인 설문은 그대로 보호됩니다.');
      renderFormsPage();
      renderConnectionsPage();
    } else renderAll();
  }

  function applyDeferredWorkspaceState() {
    if (deferredWorkspaceState && persistReconcileNeeded) schedulePersistReconciliation();
    if ((!deferredWorkspaceState && !pendingMergedSurfaceRender) || persistSaving || persistDirty || externalOperationCount || schedulePersistBaseline || mailEditorDirty || formEditorDirty || hasFocusedWorkspaceDraft()) return false;
    let handled = false;
    if (deferredWorkspaceState) {
      handled = true;
      const nextState = deferredWorkspaceState;
      deferredWorkspaceState = null;
      const nextRevision = Number(nextState._revision || 0);
      const currentRevision = Number(state._revision || 0);
      const newer = nextRevision > currentRevision || (nextRevision === currentRevision && String(nextState.updatedAt || '') > String(state.updatedAt || ''));
      if (newer) { applyIncomingWorkspaceState(nextState); return true; }
    }
    if (pendingMergedSurfaceRender) {
      pendingMergedSurfaceRender = false;
      renderAll();
      return true;
    }
    return handled;
  }

  function formsWorkspaceSurfaceChanged(leftState, rightState) {
    const projectId = surfaceProjectId(leftState) || surfaceProjectId(rightState);
    if (!projectId || (!standaloneProgram && leftState.activeProjectId !== rightState.activeProjectId)) return true;
    return formsSurfaceSnapshot(leftState, projectFromState(leftState, projectId)) !== formsSurfaceSnapshot(rightState, projectFromState(rightState, projectId));
  }

  function captureFormsFocusToken(target = document.activeElement) {
    if (!target?.closest?.('#page-forms')) return null;
    return {
      id: target.id || '',
      itemId: target.dataset?.formItemId || '',
      field: target.dataset?.formItemField || '',
      entryKind: target.dataset?.formEntryKind || '',
      entryIndex: target.dataset?.formEntryIndex || '',
      nestedGroup: target.dataset?.formNestedGroup || '',
      start: typeof target.selectionStart === 'number' ? target.selectionStart : null,
      end: typeof target.selectionEnd === 'number' ? target.selectionEnd : null
    };
  }

  function restoreFormsFocusToken(token) {
    if (!token || currentPage !== 'forms') return;
    let target = token.id ? document.getElementById(token.id) : null;
    if (!target && token.itemId) {
      target = $$('[data-form-editor-input]', $('#formQuestionList')).find((control) => control.dataset.formItemId === token.itemId
        && (control.dataset.formItemField || '') === token.field
        && (control.dataset.formEntryKind || '') === token.entryKind
        && (control.dataset.formEntryIndex || '') === token.entryIndex
        && (control.dataset.formNestedGroup || '') === token.nestedGroup);
    }
    if (!target?.isConnected || target.disabled) target = $('#formTitleInput');
    target?.focus({ preventScroll: true });
    if (target && token.start != null && typeof target.setSelectionRange === 'function') {
      const length = String(target.value || '').length;
      target.setSelectionRange(Math.min(token.start, length), Math.min(token.end ?? token.start, length));
    }
  }

  function lockFormsEditorForMerge() {
    if (currentPage !== 'forms') return;
    pendingMergedFormsFocusToken ||= captureFormsFocusToken();
    $$('.form-template-library, .form-builder-layout, #page-forms > .page-heading .button-row', $('#page-forms')).forEach((surface) => { surface.inert = true; surface.setAttribute('aria-busy', 'true'); });
    const mergeStatus = $('#formsMergeStatus'); if (mergeStatus) mergeStatus.hidden = false;
    if ($('#formEditorStatus')) $('#formEditorStatus').textContent = '다른 창의 설문 변경사항을 안전하게 합치는 중…';
  }

  function unlockFormsEditorAfterMerge() {
    $$('.form-template-library, .form-builder-layout, #page-forms > .page-heading .button-row', $('#page-forms')).forEach((surface) => { surface.inert = false; surface.removeAttribute('aria-busy'); });
    const mergeStatus = $('#formsMergeStatus'); if (mergeStatus) mergeStatus.hidden = true;
  }

  function scheduleMergedFormsRefresh() {
    if (!pendingMergedFormsRender || formsMergeRefreshScheduled || formsMergeRefreshPromise || currentPage !== 'forms') return;
    lockFormsEditorForMerge(); formsMergeRefreshScheduled = true;
    setTimeout(() => {
      formsMergeRefreshScheduled = false;
      if (!pendingMergedFormsRender || currentPage !== 'forms') { unlockFormsEditorAfterMerge(); return; }
      void refreshMergedFormsSurface();
    }, 0);
  }

  async function refreshMergedFormsSurface() {
    if (formsMergeRefreshPromise) return formsMergeRefreshPromise;
    if (!pendingMergedFormsRender || currentPage !== 'forms') { unlockFormsEditorAfterMerge(); return null; }
    lockFormsEditorForMerge();
    const focusToken = pendingMergedFormsFocusToken;
    formsMergeRefreshPromise = (async () => {
      let completed = false;
      try {
        await waitForExternalOperations();
        if (formEditorDirty) await saveFormEditorDraft();
        await waitForPersistIdle();
        if (persistDirty && persistReconcileNeeded) {
          schedulePersistReconciliation();
          await new Promise((resolve) => setTimeout(resolve, 0));
          await waitForPersistIdle();
        }
        const active = document.activeElement; if (active?.closest?.('.form-editor-shell')) active.blur();
        const hadDeferredState = Boolean(deferredWorkspaceState);
        applyDeferredWorkspaceState();
        if (hadDeferredState && deferredWorkspaceState) return;
        pendingMergedFormsRender = false;
        renderAll(); completed = true;
        showToast('다른 창의 최신 설문 변경사항을 반영했습니다.');
      } catch (error) {
        showToast(`다른 창의 설문 변경사항을 반영하지 못했습니다. 현재 입력은 보존했습니다. · ${error.message}`, 'error');
      } finally {
        if (completed || !pendingMergedFormsRender) unlockFormsEditorAfterMerge();
        if (completed) pendingMergedFormsFocusToken = null;
        formsMergeRefreshPromise = null;
        if (completed) restoreFormsFocusToken(focusToken);
        else if (pendingMergedFormsRender && currentPage === 'forms') setTimeout(scheduleMergedFormsRefresh, 50);
      }
    })();
    return formsMergeRefreshPromise;
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
      formEditorDirty,
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
    globalThis.__workspaceScheduleHistoryDiagnostics = () => ({
      projectId: scheduleHistoryProjectId,
      historyLength: scheduleHistory.length,
      futureLength: scheduleFuture.length
    });
    globalThis.__workspaceSeedScheduleHistory = () => {
      const project = activeProject();
      if (!project) return false;
      pushScheduleHistory(project);
      return scheduleHistoryProjectId === project.id && scheduleHistory.length > 0;
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
    const current = pendingScheduleMergeHints.get(projectId) || { changedSlotIds: [], changedSessionIds: [], changedGroupIds: [], zoomReviewSlotIds: [], affectedPersonIds: [] };
    pendingScheduleMergeHints.set(projectId, {
      changedSlotIds: [...new Set([...current.changedSlotIds, ...(impact?.changedSlotIds || [])])],
      changedSessionIds: [...new Set([...(current.changedSessionIds || []), ...(impact?.changedSessionIds || [])])],
      changedGroupIds: [...new Set([...(current.changedGroupIds || []), ...(impact?.changedGroupIds || [])])],
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
      const previous = beforeSlots.get(slot.id); const dependencyChanged = !previous || [slot.date, CalendarCore.slotEndDate(slot), slot.startTime, slot.endTime, slot.label].join('|') !== [previous.date, CalendarCore.slotEndDate(previous), previous.startTime, previous.endTime, previous.label].join('|') || assignmentSignature(project.data.assignments, slot.id) !== assignmentSignature(before.assignments, slot.id);
      if (dependencyChanged) slot.status = 'changed';
    });
    return impact;
  }

  function linkedGoogleFormReviewReason(linked) {
    if (!linked) return '';
    if (linked.connectionReviewRequired) return linked.connectionReviewReason || '사용할 Google 계정 확인 필요';
    if (linked.availabilityScheduleReviewRequired) return linked.availabilityScheduleReviewReason || '프로젝트 일정과 설문 선택지 다시 맞추기 필요';
    if (linked.responseReviewRequired) return linked.responseReviewReason || '응답 동기화 결과 확인 필요';
    if (linked.needsReview) return linked.reviewReason || '설문 연결 확인 필요';
    if (linked.setupStatus === 'shellCreated') return '설문 질문 구성 대기';
    if (linked.setupStatus === 'configuring') return '설문 질문 구성 결과 확인 중';
    if (linked.setupStatus === 'needsReview') return linked.reviewReason || '설문 질문 구성 결과 확인 필요';
    return '';
  }

  function reconcileFormsModuleStatus(stateInput, projectId, normalSummary = '') {
    const project = stateInput.projects?.find((item) => item.id === projectId)
      || Object.values(stateInput.quickWorkspaces || {}).find((item) => item?.id === projectId);
    if (!project?.installedModules?.includes('forms')) return stateInput;
    const linkedForms = project.data.forms?.linkedForms || [];
    const reviews = linkedForms.map((linked) => ({ linked, reason: linkedGoogleFormReviewReason(linked) })).filter((item) => item.reason);
    if (reviews.length) {
      const first = reviews[0];
      const title = first.linked.title || '설문';
      return Core.setModuleStatus(stateInput, projectId, 'forms', 'needsReview', `확인 필요한 설문 ${reviews.length}개 · ${title}: ${first.reason}`);
    }
    return Core.setModuleStatus(stateInput, projectId, 'forms', 'inProgress', normalSummary || (linkedForms.length ? `연결된 설문 ${linkedForms.length}개` : '연결된 설문 없음'));
  }

  function applyAvailabilityFormConsistency(project, linked) {
    if (linked?.type !== 'availability' || !Ops.googleFormAvailabilityConsistency) return { consistent: true, reason: '' };
    const consistency = Ops.googleFormAvailabilityConsistency(project, linked);
    const previousScheduleReason = linked.availabilityScheduleReviewReason || '';
    if (consistency.consistent) {
      const scheduleOwnedGeneralReview = Boolean(previousScheduleReason && linked.reviewReason === previousScheduleReason);
      delete linked.availabilityScheduleReviewRequired;
      delete linked.availabilityScheduleReviewReason;
      if (scheduleOwnedGeneralReview) {
        linked.reviewReason = '';
        linked.needsReview = Boolean(linked.connectionReviewRequired || ['shellCreated', 'configuring', 'needsReview'].includes(linked.setupStatus));
      }
      return consistency;
    }
    linked.availabilityScheduleReviewRequired = true;
    linked.availabilityScheduleReviewReason = consistency.reason;
    linked.needsReview = true;
    if (!linked.connectionReviewRequired && (!linked.reviewReason || linked.reviewReason === previousScheduleReason)) linked.reviewReason = consistency.reason;
    return consistency;
  }

  function markAvailabilityFormsForScheduleReview(project) {
    let reviewCount = 0;
    (project?.data?.forms?.linkedForms || []).forEach((linked) => {
      if (linked.type !== 'availability') return;
      const before = JSON.stringify(linked);
      const consistency = applyAvailabilityFormConsistency(project, linked);
      if (!consistency.consistent) reviewCount += 1;
      if (JSON.stringify(linked) !== before) linked.updatedAt = new Date().toISOString();
    });
    return reviewCount;
  }

  function syncScheduleProjectState(project, summary, impact = null) {
    const availabilityReviewCount = markAvailabilityFormsForScheduleReview(project);
    state = Core.updateProject(state, project.id, { data: project.data });
    state = Core.setModuleStatus(state, project.id, 'schedule', project.data.conflicts.length ? 'needsReview' : 'inProgress', summary || `일정 ${project.data.slots.length}개 · 확인할 문제 ${project.data.conflicts.length}건`);
    if (impact && project.installedModules.includes('zoom') && impact.zoomReviewSlotIds?.length) state = Core.setModuleStatus(state, project.id, 'zoom', 'stale', '일정 변경 후 Zoom 확인 필요');
    if (impact && project.installedModules.includes('gmailFlow') && impact.affectedPersonIds?.length) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', '일정 변경 후 안내 메일 확인 필요');
    if (project.installedModules.includes('forms') && (availabilityReviewCount || project.data.forms?.linkedForms?.some((linked) => linked.type === 'availability'))) state = reconcileFormsModuleStatus(state, project.id);
    recordScheduleMergeImpact(project.id, impact);
  }

  function pushScheduleHistory(project) {
    if (!project?.id) return;
    pushScheduleHistorySnapshot(scheduleSnapshot(project), project.id);
  }

  function syncScheduleHistoryControls() {
    const projectId = activeProject()?.id || '';
    const historyInScope = Boolean(projectId && projectId === scheduleHistoryProjectId);
    ['scheduleUndo', 'sessionUndo', 'calendarUndo'].forEach((id) => { if ($(`#${id}`)) $(`#${id}`).disabled = !historyInScope || !scheduleHistory.length; });
    ['scheduleRedo', 'sessionRedo', 'calendarRedo'].forEach((id) => { if ($(`#${id}`)) $(`#${id}`).disabled = !historyInScope || !scheduleFuture.length; });
  }

  function pushScheduleHistorySnapshot(snapshot, projectId = activeProject()?.id || '') {
    if (!projectId) return;
    if (scheduleHistoryProjectId !== projectId) {
      scheduleHistory = [];
      scheduleFuture = [];
      scheduleHistoryProjectId = projectId;
    }
    scheduleHistory.push(snapshot); if (scheduleHistory.length > 80) scheduleHistory.shift(); scheduleFuture = []; syncScheduleHistoryControls();
  }

  function clearScheduleHistory(projectId = '') {
    if (projectId && scheduleHistoryProjectId && scheduleHistoryProjectId !== projectId) return false;
    scheduleHistory = [];
    scheduleFuture = [];
    scheduleHistoryProjectId = projectId || '';
    pendingSessionChange = null;
    const formula = $('#scheduleCellValue');
    if (formula) ['scheduleEditing', 'scheduleImpactBefore', 'scheduleEditRow', 'scheduleEditCol', 'scheduleEditValue'].forEach((key) => delete formula.dataset[key]);
    syncScheduleHistoryControls();
    return true;
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
    if (project?.id && scheduleHistoryProjectId !== project.id) {
      scheduleHistory = [];
      scheduleFuture = [];
      scheduleHistoryProjectId = project.id;
      syncScheduleHistoryControls();
      return;
    }
    const from = undo ? scheduleHistory : scheduleFuture; const to = undo ? scheduleFuture : scheduleHistory;
    if (!project || !from.length) return;
    const dependencyBaseline = takeSchedulePersistBaseline(project, null);
    const before = JSON.parse(scheduleSnapshot(project));
    const targetSnapshot = from.pop(); const targetData = JSON.parse(targetSnapshot); const projectCalendarChanged = JSON.stringify(before.projectCalendar || {}) !== JSON.stringify(targetData.projectCalendar || {});
    to.push(scheduleSnapshot(project)); const restoredSideEffects = restoreScheduleSnapshot(project, targetSnapshot);
    const dependencyBefore = typeof dependencyBaseline === 'string' ? JSON.parse(dependencyBaseline) : dependencyBaseline || before;
    const impact = restoredSideEffects
      ? scheduleMutationImpact(dependencyBefore, { slots: project.data.slots, assignments: project.data.assignments })
      : applyScheduleMutationImpact(project, dependencyBaseline || before);
    pendingSessionChange = null;
    if (restoredSideEffects) state = Core.updateProject(state, project.id, { data: project.data, moduleState: project.moduleState, workflow: project.workflow });
    else syncScheduleProjectState(project, undo ? '일정 변경 실행 취소' : '일정 변경 다시 실행', impact);
    recordScheduleMergeImpact(project.id, impact, { scheduleOnly: !restoredSideEffects && !projectCalendarChanged });
    syncScheduleHistoryControls(); await persist(undo ? '실행 취소됨' : '다시 실행됨'); if (currentPage === 'projectCalendar') renderProjectCalendarPage(); else renderSchedulePage();
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
    $$('[data-select-schedule-row]', $('#scheduleBoard')).forEach((cell) => { const row = Number(cell.dataset.selectScheduleRow); setSheetSelectorPressed(cell, mode === 'row' && row >= minRow && row <= maxRow); });
    $$('[data-select-schedule-column]', $('#scheduleBoard')).forEach((cell) => { const col = Number(cell.dataset.selectScheduleColumn); setSheetSelectorPressed(cell, mode === 'column' && col >= minCol && col <= maxCol); });
    const allSelector = $('#scheduleBoard [data-select-schedule-all]'); if (allSelector) setSheetSelectorPressed(allSelector, mode === 'all');
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
    const letters = element('tr', 'sheet-letter-row'); const corner = configureSheetSelector(element('th', 'sheet-corner', ''), '일정표 전체 선택'); corner.dataset.selectScheduleAll = 'true'; letters.append(corner);
    columns.forEach((_column, index) => { const columnName = spreadsheetColumnName(index); const th = configureSheetSelector(element('th', 'sheet-letter', columnName), `${columnName}열 전체 선택`); th.dataset.selectScheduleColumn = String(index); letters.append(th); });
    letters.append(element('th', 'sheet-letter schedule-add-column-letter', spreadsheetColumnName(columns.length)));
    const headers = element('tr'); headers.append(element('th', 'sheet-row-number', '1'));
    columns.forEach((column, columnIndex) => { const th = element('th', 'schedule-column-header'); th.dataset.scheduleRow = '-1'; th.dataset.scheduleCol = String(columnIndex); th.dataset.scheduleHeader = column.key; const name = element('button', 'schedule-column-name', column.name); name.type = 'button'; name.dataset.scheduleRenameColumn = column.id; name.title = '드래그하여 선택 · 더블클릭하여 컬럼 이름 변경'; const remove = element('button', 'schedule-column-remove', '×'); remove.type = 'button'; remove.dataset.scheduleRemoveColumn = column.id; remove.title = '컬럼 삭제'; remove.setAttribute('aria-label', `${column.name} 컬럼 삭제`); th.append(name, remove); headers.append(th); });
    const plusHeader = element('th', 'schedule-inline-add'); const plusColumn = element('button', 'add-empty-column', '＋ 컬럼'); plusColumn.type = 'button'; plusColumn.dataset.scheduleAddColumnInline = 'true'; plusHeader.append(plusColumn); headers.append(plusHeader); table.tHead.replaceChildren(letters, headers);
    const visibleRows = Math.max(sortedSlots.length + 2, 5); const rows = Array.from({ length: visibleRows }, (_, rowIndex) => {
      const slot = sortedSlots[rowIndex]; const tr = element('tr'); if (slot) tr.dataset.scheduleSlot = slot.id; const number = configureSheetSelector(element('th', 'sheet-row-number', String(rowIndex + 2)), `${rowIndex + 2}행 전체 선택`); number.dataset.selectScheduleRow = String(rowIndex); tr.append(number);
      columns.forEach((column, columnIndex) => {
        const td = element('td', column.role ? 'schedule-role-cell' : ''); td.dataset.scheduleRow = String(rowIndex); td.dataset.scheduleCol = String(columnIndex);
        const input = element('input'); input.type = ['date', 'endDate'].includes(column.key) ? 'date' : ['startTime', 'endTime'].includes(column.key) ? 'time' : 'text'; if (input.type === 'time') input.step = '300'; input.value = scheduleCellValue(project, rowIndex, columnIndex); input.dataset.scheduleInput = 'true'; input.autocomplete = 'off'; input.disabled = Boolean(slot && scheduleRowLocked(project, slot.id) && column.key !== 'locked'); input.setAttribute('aria-label', `${rowIndex + 2}행 ${spreadsheetColumnName(columnIndex)}열 ${column.name}`);
        if (column.role) { input.setAttribute('list', `schedule-role-${column.role.id}`); const unknown = peopleTokens(input.value).some((name) => !project.data.people.some((person) => [person.name, person.email, person.phone].includes(name))); td.classList.toggle('schedule-invalid', unknown); input.setAttribute('aria-invalid', String(unknown)); if (unknown) input.title = '명단에서 찾을 수 없는 사람이 포함되어 있습니다.'; }
        td.append(input); tr.append(td);
      });
      if (!columns.length) { const td = element('td', 'empty-sheet-cell'); td.dataset.scheduleRow = String(rowIndex); td.dataset.scheduleCol = '0'; const input = element('input'); input.type = 'text'; input.dataset.scheduleInput = 'true'; input.dataset.schedulePasteAnchor = 'true'; input.setAttribute('aria-label', `${rowIndex + 2}행 A열 일정 값`); input.placeholder = rowIndex === 0 ? '첫 셀에 표를 붙여넣으세요' : ''; td.append(input); tr.append(td); }
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
    assertAccessibleSheet(table, '[data-schedule-input]', '[data-select-schedule-all], [data-select-schedule-column], [data-select-schedule-row]');
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
    return `${slotRangeText(slot, { includeYear: true })}${slot.label ? ` · ${slot.label}` : ''}`;
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
      timeZone: CalendarCore.projectTimeZone(project),
      change
    });
  }

  function scheduleChangeSignature(project) {
    return JSON.stringify({
      slots: project.data.slots.map((slot) => [slot.id, slot.date, CalendarCore.slotEndDate(slot), slot.startTime, slot.endTime, slot.label, slot.status, Boolean(slot.locked)]),
      activities: (project.data.activities || []).map((activity) => [activity.id, storedId(activity.eventId, storedId(activity.slotId, '')), activity.title || '', activity.description || '', Number(activity.startOffsetMinutes) || 0, Number(activity.durationMinutes) || 0, activity.status || '', Boolean(activity.locked), Number(activity.order) || 0]),
      assignments: project.data.assignments.map((assignment) => [assignment.id, assignment.slotId, assignment.personId, assignment.roleId, Boolean(assignment.locked)]),
      activityAssignments: (project.data.activityAssignments || []).map((assignment) => [assignment.id, assignment.activityId || '', assignment.assignmentId || '', assignment.personId || '', assignment.roleId || '', Boolean(assignment.locked)]),
      people: project.data.people.map((person) => [person.id, person.name, person.active !== false, [...(person.roleIds || [])].sort(), Object.entries(person.values || {}).sort(([a], [b]) => a.localeCompare(b))]),
      roles: project.data.roles.map((role) => [role.id, role.name, role.active !== false, role.candidateFilter || 'manual', Number(role.minPerSession) || 0, Number(role.maxPerSession) || 0, Number(role.targetSessions) || 0]),
      availability: Object.entries(project.data.availability || {}).sort(([a], [b]) => a.localeCompare(b)).map(([personId, slotIds]) => [personId, Array.isArray(slotIds) ? [...slotIds].sort() : slotIds]),
      projectCalendar: project.data.extensionData?.projectCalendar || {},
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

  function scheduleRowLockReasons(project, slotId) {
    const slot = project?.data.slots.find((item) => item.id === slotId);
    const activityIds = new Set((project?.data.activities || []).filter((activity) => storedId(activity.eventId, activity.slotId) === slotId).map((activity) => activity.id));
    const assignmentIds = new Set((project?.data.assignments || []).filter((assignment) => assignment.slotId === slotId).map((assignment) => assignment.id));
    const reasons = [];
    if (slot?.locked) reasons.push('일정 자체 잠금');
    if (project?.data.assignments.some((assignment) => assignment.slotId === slotId && assignment.locked)) reasons.push('인원 배치 잠금');
    if (project?.data.activities?.some((activity) => activityIds.has(activity.id) && activity.locked)) reasons.push('진행 항목 잠금');
    if (project?.data.activityAssignments?.some((assignment) => assignment.locked && (activityIds.has(assignment.activityId) || assignmentIds.has(assignment.assignmentId) || storedId(assignment.eventId, assignment.slotId) === slotId))) reasons.push('진행 담당자 잠금');
    return reasons;
  }

  function scheduleRowLocked(project, slotId) {
    return scheduleRowLockReasons(project, slotId).length > 0;
  }

  function scheduleRowLockMessage(project, slotId, action = '변경') {
    const reasons = scheduleRowLockReasons(project, slotId);
    return reasons.length ? `${reasons.join(' · ')} 때문에 ${action}할 수 없습니다. 잠금을 만든 항목에서 먼저 해제해주세요.` : '';
  }

  function hasLockedSchedule(project) {
    return Boolean(project?.data.slots.some((slot) => slot.locked)
      || project?.data.assignments.some((assignment) => assignment.locked)
      || project?.data.activities?.some((activity) => activity.locked)
      || project?.data.activityAssignments?.some((assignment) => assignment.locked));
  }

  function lockedScheduleWouldChange(project, version) {
    const nextSlots = Array.isArray(version?.slots) ? version.slots : [];
    const nextAssignments = Array.isArray(version?.assignments) ? version.assignments : [];
    const nextSlotIds = new Set(nextSlots.map((slot) => slot.id));
    const nextActivities = Array.isArray(version?.activities) ? version.activities : (project.data.activities || []).filter((activity) => nextSlotIds.has(storedId(activity.eventId, activity.slotId)));
    const nextActivityIds = new Set(nextActivities.map((activity) => activity.id));
    const candidateActivityAssignments = Array.isArray(version?.activityAssignments) ? version.activityAssignments : (project.data.activityAssignments || []);
    const nextAssignmentById = new Map(nextAssignments.map((assignment) => [assignment.id, assignment]));
    const nextActivityById = new Map(nextActivities.map((activity) => [activity.id, activity]));
    const linkSlotId = (link, activityById, assignmentById) => {
      const activity = hasStoredId(link.activityId) ? activityById.get(link.activityId) : null;
      const assignment = hasStoredId(link.assignmentId) ? assignmentById.get(link.assignmentId) : null;
      return activity ? storedId(activity.eventId, activity.slotId) : storedId(assignment?.slotId, storedId(link.eventId, link.slotId));
    };
    const nextActivityAssignments = candidateActivityAssignments.filter((link) => {
      const hasActivity = hasStoredId(link.activityId) && nextActivityIds.has(link.activityId);
      const assignment = hasStoredId(link.assignmentId) ? nextAssignmentById.get(link.assignmentId) : null;
      if (!hasActivity && !assignment) return false;
      const slotId = linkSlotId(link, nextActivityById, nextAssignmentById);
      if (hasActivity && assignment && assignment.slotId !== slotId) return false;
      return Boolean(assignment) || !hasStoredId(slotId) || nextAssignments.some((item) => item.slotId === slotId && (!hasStoredId(link.personId) || item.personId === link.personId));
    });
    const slotSignature = (slot) => JSON.stringify(slot ? [slot.id, slot.date, CalendarCore.slotEndDate(slot), slot.startTime, slot.endTime, slot.label, slot.status, storedId(slot.calendarSessionId), storedId(slot.scheduleGroupId), Boolean(slot.locked)] : null);
    const assignmentSignature = (assignment) => JSON.stringify(assignment ? [assignment.id, assignment.slotId, assignment.personId, assignment.roleId, storedId(assignment.calendarSessionId), storedId(assignment.scheduleGroupId), Boolean(assignment.locked)] : null);
    const activitySignature = (activity) => JSON.stringify(activity ? [activity.id, storedId(activity.eventId, activity.slotId), activity.title, activity.description, Number(activity.startOffsetMinutes) || 0, Number(activity.durationMinutes) || 0, activity.status, Boolean(activity.locked), Number(activity.order) || 0] : null);
    const activityAssignmentSignature = (assignment) => JSON.stringify(assignment ? [assignment.id, assignment.activityId, assignment.assignmentId, assignment.personId, assignment.roleId, Boolean(assignment.locked)] : null);
    const protectedSlotIds = new Set(project.data.slots.filter((slot) => slot.locked).map((slot) => slot.id));
    project.data.assignments.filter((assignment) => assignment.locked).forEach((assignment) => protectedSlotIds.add(assignment.slotId));
    const currentActivityById = new Map((project.data.activities || []).map((activity) => [activity.id, activity])); const currentAssignmentById = new Map(project.data.assignments.map((assignment) => [assignment.id, assignment]));
    (project.data.activities || []).filter((activity) => activity.locked).forEach((activity) => { const slotId = storedId(activity.eventId, activity.slotId); if (hasStoredId(slotId)) protectedSlotIds.add(slotId); });
    (project.data.activityAssignments || []).filter((assignment) => assignment.locked).forEach((assignment) => { const slotId = linkSlotId(assignment, currentActivityById, currentAssignmentById); if (hasStoredId(slotId)) protectedSlotIds.add(slotId); });
    for (const slotId of protectedSlotIds) {
      const currentSlot = project.data.slots.find((slot) => slot.id === slotId);
      const nextSlot = nextSlots.find((slot) => slot.id === slotId);
      if (slotSignature(currentSlot) !== slotSignature(nextSlot)) return true;
      const currentRow = project.data.assignments.filter((assignment) => assignment.slotId === slotId).map(assignmentSignature).sort();
      const nextRow = nextAssignments.filter((assignment) => assignment.slotId === slotId).map(assignmentSignature).sort();
      if (JSON.stringify(currentRow) !== JSON.stringify(nextRow)) return true;
      const currentActivities = (project.data.activities || []).filter((activity) => storedId(activity.eventId, activity.slotId) === slotId);
      const candidateActivities = nextActivities.filter((activity) => storedId(activity.eventId, activity.slotId) === slotId);
      if (JSON.stringify(currentActivities.map(activitySignature).sort()) !== JSON.stringify(candidateActivities.map(activitySignature).sort())) return true;
      const currentLinks = (project.data.activityAssignments || []).filter((assignment) => linkSlotId(assignment, currentActivityById, currentAssignmentById) === slotId).map(activityAssignmentSignature).sort();
      const candidateLinks = nextActivityAssignments.filter((assignment) => linkSlotId(assignment, nextActivityById, nextAssignmentById) === slotId).map(activityAssignmentSignature).sort();
      if (JSON.stringify(currentLinks) !== JSON.stringify(candidateLinks)) return true;
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

  function externalOperationSignature(project, kind, stateInput = state) {
    return Ops.externalOperationFingerprint(project, kind, stateInput.connections, effectiveConnectionDefaults(project, stateInput));
  }

  function externalCommitGuard({ reservation, project, kind, expectedConnections = [], conflictState }) {
    const latestConnections = latestKnownWorkspaceState().connections || [];
    return {
      token: reservation?.token || '',
      projectId: project?.id || '',
      kind,
      reservationKeys: reservation?.keys || [],
      expectedFingerprint: Ops.externalOperationFingerprint(project, kind, latestConnections, effectiveConnectionDefaults(project, state)),
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

  function markGoogleFormForCommitConflict(stateInput, projectId, formId, reason) {
    let next = cloneState(stateInput);
    const project = next.projects.find((item) => item.id === projectId) || Object.values(next.quickWorkspaces || {}).find((item) => item?.id === projectId);
    if (!project) return next;
    project.data.forms.linkedForms = project.data.forms.linkedForms.map((linked) => linked.formId === formId
      ? { ...linked, needsReview: true, reviewReason: reason, updatedAt: new Date().toISOString() }
      : linked);
    next = Core.updateProject(next, projectId, { data: { forms: project.data.forms } });
    if (project.installedModules.includes('forms')) next = Core.setModuleStatus(next, projectId, 'forms', 'needsReview', reason);
    return next;
  }

  function externalOperationStateChanged(projectId, kind, baseSignature) {
    const currentProject = projectById(projectId);
    if (!currentProject || externalOperationSignature(currentProject, kind) !== baseSignature) return true;
    const deferredProject = deferredWorkspaceState?.projects?.find((item) => item.id === projectId) || Object.values(deferredWorkspaceState?.quickWorkspaces || {}).find((item) => item?.id === projectId);
    return Boolean(deferredProject && externalOperationSignature(deferredProject, kind, deferredWorkspaceState) !== baseSignature);
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

  function staleGmailDraftsForZoomSlots(project, slotIds, reason = 'Zoom 계정 변경 후 안내 메일의 회의 링크 재확인 필요') {
    const targetSlotIds = slotIds instanceof Set ? slotIds : new Set(slotIds || []);
    const personIds = new Set(project.data.assignments.filter((assignment) => targetSlotIds.has(assignment.slotId)).map((assignment) => assignment.personId).filter(Boolean));
    let changed = 0;
    project.data.externalArtifacts.forEach((artifact) => {
      if (artifact.kind !== 'gmailDraft' || artifact.status === 'superseded' || !personIds.has(artifact.personId)) return;
      if (artifact.status !== 'stale' || artifact.replacementReason !== reason) changed += 1;
      artifact.status = 'stale';
      artifact.replacementReason = reason;
    });
    return { changed, personIds: [...personIds] };
  }

  function protectLinkedFormsForRouteChange(project, previousConnectionId, nextConnectionId, reason = 'Google Forms 기본 계정 변경 후 설문 연결 계정 재확인 필요') {
    const previousId = String(previousConnectionId || '').trim();
    const nextId = String(nextConnectionId || '').trim();
    if (!project?.data?.forms || previousId === nextId) return { changed: 0, pinned: 0, reviewed: 0 };
    let pinned = 0; let reviewed = 0;
    const linkedForms = (project.data.forms.linkedForms || []).map((linked) => {
      if (linked.connectionId) return linked;
      if (previousId) {
        pinned += 1;
        return { ...linked, connectionId: previousId };
      }
      reviewed += 1;
      return { ...linked, connectionId: nextId, needsReview: true, reviewReason: linked.reviewReason || reason, connectionReviewRequired: true, connectionReviewReason: reason };
    });
    if (pinned || reviewed) project.data.forms = { ...project.data.forms, linkedForms };
    return { changed: pinned + reviewed, pinned, reviewed };
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
      const zoomSlotIds = connection.type === 'zoom' ? new Set(project.data.slots.filter((slot) => slot.zoomConnectionId === connection.id || (!slot.zoomConnectionId && defaultConnectionId(project, 'zoom') === connection.id)).map((slot) => slot.id)) : new Set();
      const externalArtifacts = project.data.externalArtifacts.map((artifact) => {
        if (!artifactKind || artifact.kind !== artifactKind || artifact.connectionId !== connection.id || artifact.status === 'superseded') return artifact;
        projectRetired += 1;
        return { ...artifact, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: reason };
      });
      let forms = project.data.forms;
      if (connection.type === 'forms') {
        const inheritedFormsConnection = defaultConnectionId(project, 'forms') === connection.id;
        const linkedForms = (project.data.forms.linkedForms || []).map((linked) => {
          if (linked.connectionId !== connection.id && !(inheritedFormsConnection && !linked.connectionId)) return linked;
          linkedFormsChanged = true;
          return { ...linked, connectionId: linked.connectionId || connection.id, needsReview: true, reviewReason: linked.reviewReason || reason, connectionReviewRequired: true, connectionReviewReason: reason };
        });
        if (linkedFormsChanged) forms = { ...project.data.forms, linkedForms };
      }
      project.data.externalArtifacts = externalArtifacts;
      const gmailDependency = connection.type === 'zoom'
        ? staleGmailDraftsForZoomSlots(project, zoomSlotIds, 'Zoom 계정 연결 변경 후 안내 메일의 회의 링크 재확인 필요')
        : { changed: 0, personIds: [] };
      if (!projectRetired && !linkedFormsChanged && !gmailDependency.changed) return;
      retired += projectRetired;
      state = Core.updateProject(state, projectId, { data: { externalArtifacts: project.data.externalArtifacts, forms } });
      const moduleId = connection.type === 'gmail' ? 'gmailFlow' : connection.type;
      if (project.installedModules.includes(moduleId)) state = Core.setModuleStatus(state, projectId, moduleId, 'needsReview', reason);
      if (gmailDependency.changed && project.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, projectId, 'gmailFlow', 'needsReview', 'Zoom 계정 연결 변경 후 안내 메일의 회의 링크 재확인 필요');
      recordScheduleMergeImpact(projectId, {
        changedSlotIds: [],
        zoomReviewSlotIds: [...zoomSlotIds],
        affectedPersonIds: gmailDependency.personIds
      }, { scheduleOnly: false });
    });
    return retired;
  }

  function pendingZoomSlots(project) {
    return ExternalProgress.pendingZoomSlots(project, (slot) => slot.zoomConnectionId || defaultConnectionId(project, 'zoom'));
  }

  function zoomSlotReadiness(project, slot) {
    return Ops.zoomMeetingSlotReadiness(slot, project?.settings?.timezone || 'Asia/Seoul');
  }

  function pendingGmailEntries(project) {
    const connectionId = defaultConnectionId(project, 'gmail');
    return ExternalProgress.pendingGmailEntries(project, buildWorkspaceMailPackage(project).entries, connectionId);
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
    $('#sessionChangeTitle').textContent = `${person?.name || '선택한 사람'} · ${role?.name || '역할 미정'} · ${actionLabel}`;
    $('#sessionChangeSummary').textContent = plan.action === 'remove'
      ? sessionSlotLabel(fromSlot)
      : plan.action === 'add'
        ? sessionSlotLabel(toSlot)
        : `${sessionSlotLabel(fromSlot)} → ${sessionSlotLabel(toSlot)}`;
    const warningList = $('#sessionChangeWarnings'); warningList.replaceChildren();
    const affectedPeers = Math.max(0, plan.impact.affectedPersonIds.length - 1);
    const impact = element('span', 'session-impact-chip', affectedPeers ? `함께 확인할 사람 ${affectedPeers}명` : '다른 사람 영향 없음'); warningList.append(impact);
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
    const nextAssignmentIds = new Set(pending.plan.nextAssignments.map((assignment) => assignment.id));
    const removedAssignmentIds = new Set(project.data.assignments.filter((assignment) => !nextAssignmentIds.has(assignment.id)).map((assignment) => assignment.id));
    pushScheduleHistory(project);
    if (pending.newSlot && !project.data.slots.some((slot) => slot.id === pending.newSlot.id)) project.data.slots.push(pending.newSlot);
    project.data.assignments = pending.plan.nextAssignments;
    removeActivityAssignmentLinks(project, { assignmentIds: removedAssignmentIds });
    pruneActivityAssignmentsAfterCalendarChange(project);
    markScheduleChangeStale(project, pending.plan.impact);
    refreshScheduleConflicts(project);
    syncScheduleProjectState(project, `${project.data.slots.length}개 일정 · 변경 내용 확인`, pending.plan.impact);
    const action = pending.plan.action;
    selectedSessionPersonId = pending.plan.impact.personId;
    selectedSessionAssignmentId = action === 'remove' ? null : pending.change.nextAssignmentId || pending.plan.impact.assignmentId;
    pendingSessionChange = null;
    await persist(action === 'remove' ? '사람 일정 제외됨' : action === 'add' ? '사람 일정 추가됨' : '사람 일정 변경됨');
    renderSchedulePage();
    showToast(action === 'remove' ? '사람을 일정에서 제외했습니다.' : action === 'add' ? '사람 일정을 추가했습니다.' : '사람 일정을 변경했습니다.', 'success');
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
    [...new Set(project.data.slots.flatMap((slot) => slotDateKeys(slot)))].sort().forEach((date) => { const option = element('option', '', formatDate(date)); option.value = date; dateSelect.append(option); }); dateSelect.value = [...dateSelect.options].some((option) => option.value === previousDate) ? previousDate : '';
    const people = sessionRosterPeople(project); const pool = $('#sessionPersonPool');
    const selectedPerson = project.data.people.find((person) => person.id === selectedSessionPersonId && person.active !== false) || null;
    const selectedAssignments = selectedPerson ? project.data.assignments.filter((assignment) => assignment.personId === selectedPerson.id).sort((a, b) => Ops.slotKey(project.data.slots.find((slot) => slot.id === a.slotId) || {}).localeCompare(Ops.slotKey(project.data.slots.find((slot) => slot.id === b.slotId) || {}))) : [];
    if (!selectedPerson) { selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null; }
    else if (selectedSessionAssignmentId !== 'new' && !selectedAssignments.some((assignment) => assignment.id === selectedSessionAssignmentId)) selectedSessionAssignmentId = selectedAssignments.length === 0 ? 'new' : selectedAssignments.length === 1 ? selectedAssignments[0].id : null;
    pool.replaceChildren(...(people.length ? people.map((person) => {
      const count = project.data.assignments.filter((assignment) => assignment.personId === person.id).length;
      const chip = element('button', `session-person-chip${selectedSessionPersonId === person.id ? ' selected' : ''}`); chip.type = 'button'; chip.draggable = true; chip.dataset.sessionPerson = person.id; chip.title = count ? '사람을 선택해 현재 일정을 변경' : '사람을 선택해 새 일정에 배정';
      chip.append(element('strong', '', person.name || '이름 없음'), element('small', '', `${person.group || person.email || '분류 없음'} · ${count ? `일정 ${count}개` : '미배정'}`)); return chip;
    }) : [element('div', 'list-empty', '검색 조건에 맞는 사람이 없습니다.')]));

    const selectedPanel = $('#sessionSelectedPersonPanel'); selectedPanel.replaceChildren();
    if (selectedPerson) {
      const heading = element('div', 'session-selected-heading'); const copy = element('span'); copy.append(element('small', '', '선택한 사람'), element('strong', '', selectedPerson.name || '이름 없음'));
      const clear = element('button', 'text-button', '선택 해제'); clear.type = 'button'; clear.dataset.sessionClearPerson = 'true'; heading.append(copy, clear); selectedPanel.append(heading);
      const current = element('div', 'session-current-options');
      selectedAssignments.forEach((assignment) => { const slot = project.data.slots.find((item) => item.id === assignment.slotId); const role = project.data.roles.find((item) => item.id === assignment.roleId); const label = `${sessionSlotLabel(slot)} · ${role?.name || assignment.roleName || '역할 미정'}`; const button = element('button', selectedSessionAssignmentId === assignment.id ? 'selected' : '', label); button.type = 'button'; button.dataset.sessionOriginAssignment = assignment.id; button.title = label; current.append(button); });
      const add = element('button', selectedSessionAssignmentId === 'new' ? 'selected add' : 'add', '＋ 새 일정 추가'); add.type = 'button'; add.dataset.sessionOriginNew = 'true'; current.append(add); selectedPanel.append(current);
      selectedPanel.append(element('p', 'session-selection-help', selectedSessionAssignmentId === 'new' ? '추가할 일정을 캘린더에서 선택하세요.' : selectedSessionAssignmentId ? '옮길 일정을 캘린더에서 선택하세요.' : '변경할 현재 일정을 먼저 선택하세요.'));
      selectedPanel.hidden = false; $('#sessionTargetLegend').hidden = false;
    } else { selectedPanel.hidden = true; $('#sessionTargetLegend').hidden = true; }
    const visibleDate = dateSelect.value; const slots = project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).filter((slot) => !visibleDate || CalendarCore.slotOccursOnDate(slot, visibleDate));
    const byDate = new Map(); slots.forEach((slot) => { const groupDate = visibleDate || slot.date || '날짜 미정'; if (!byDate.has(groupDate)) byDate.set(groupDate, []); byDate.get(groupDate).push(slot); });
    const board = $('#sessionCalendarBoard'); const columns = [...byDate.entries()].map(([date, dateSlots]) => {
      const column = element('section', 'session-date-column'); column.append(element('h3', '', date === '날짜 미정' ? date : formatDate(date)));
      dateSlots.forEach((slot) => {
        const card = element('article', `session-slot-card status-${slot.status || 'draft'}`); card.dataset.sessionSlot = slot.id; card.setAttribute('aria-label', sessionSlotLabel(slot)); card.title = sessionSlotLabel(slot);
        let currentAssignment = null; let targetPlan = null;
        if (pendingSessionChange?.plan.impact.toSlotId === slot.id) card.classList.add('is-pending-target');
        if (selectedPerson && selectedSessionAssignmentId) {
          currentAssignment = selectedAssignments.find((assignment) => assignment.id === selectedSessionAssignmentId);
          if (currentAssignment?.slotId === slot.id) card.classList.add('is-current');
          else {
            const change = { action: selectedSessionAssignmentId === 'new' ? 'add' : 'move', assignmentId: selectedSessionAssignmentId === 'new' ? '' : selectedSessionAssignmentId, personId: selectedPerson.id, toSlotId: slot.id, roleId: sessionChangeRole(project, selectedPerson.id, selectedSessionAssignmentId) };
            targetPlan = makeSessionChangePlan(project, change);
            card.classList.add(!targetPlan.canApply ? 'is-blocked-target' : targetPlan.warnings.length ? 'is-warning-target' : 'is-ready-target');
          }
        }
        const heading = element('div', 'session-slot-heading'); const title = element('span'); title.append(element('strong', '', slotRangeText(slot, { includeYear: true })), element('small', '', slot.label || '이름 없는 세션'));
        const rowLocked = scheduleRowLocked(project, slot.id); const actions = element('span', 'session-slot-actions');
        if (selectedPerson && selectedSessionAssignmentId && currentAssignment?.slotId !== slot.id) { const choose = element('button', 'session-target-button', '여기로'); choose.type = 'button'; choose.dataset.sessionTarget = slot.id; choose.setAttribute('aria-label', `${selectedPerson.name || '선택한 사람'}을(를) ${sessionSlotLabel(slot)}로 ${selectedSessionAssignmentId === 'new' ? '추가' : '이동'}`); if (targetPlan && !targetPlan.canApply) choose.title = `적용 전에 확인 필요: ${(targetPlan.blockers || []).join(' · ') || '일정 충돌'}`; else if (targetPlan?.warnings.length) choose.title = `주의: ${targetPlan.warnings.join(' · ')}`; actions.append(choose); }
        const edit = element('button', '', '시간 변경'); edit.type = 'button'; edit.dataset.sessionEdit = slot.id; edit.disabled = rowLocked; edit.title = rowLocked ? '잠금을 해제한 뒤 변경할 수 있습니다.' : '세션 시간 변경'; const remove = element('button', '', '×'); remove.type = 'button'; remove.dataset.sessionRemove = slot.id; remove.disabled = rowLocked; remove.title = rowLocked ? '잠금을 해제한 뒤 삭제할 수 있습니다.' : '세션 삭제'; remove.setAttribute('aria-label', `${sessionSlotLabel(slot)} 세션 삭제`); actions.append(edit, remove); heading.append(title, actions); card.append(heading);
        const assignments = element('div', 'session-assignments');
        project.data.assignments.filter((assignment) => assignment.slotId === slot.id).forEach((assignment) => { const person = project.data.people.find((item) => item.id === assignment.personId); if (!person || person.active === false) return; const roleName = project.data.roles.find((role) => role.id === assignment.roleId)?.name || assignment.roleName || '참여'; const label = `${person.name || '이름 없음'} · ${roleName}`; const chip = element('div', `session-assignment-chip${selectedSessionPersonId === person.id ? ' selected-person' : ''}${selectedSessionAssignmentId === assignment.id ? ' selected-assignment' : ''}`); chip.draggable = !(assignment.locked || slot.locked); chip.dataset.sessionAssignment = assignment.id; chip.dataset.sessionPerson = person.id; const select = element('button', 'session-assignment-select'); select.type = 'button'; select.dataset.sessionAssignmentSelect = assignment.id; select.setAttribute('aria-pressed', String(selectedSessionAssignmentId === assignment.id)); select.setAttribute('aria-label', `${label} 배정 선택`); select.append(element('span', '', label)); const eject = element('button', 'session-assignment-eject', '×'); eject.type = 'button'; eject.dataset.sessionUnassign = assignment.id; eject.disabled = Boolean(assignment.locked || slot.locked); eject.title = eject.disabled ? '잠금을 해제한 뒤 일정에서 뺄 수 있습니다.' : '이 세션에서 빼기'; eject.setAttribute('aria-label', `${person.name || '이름 없음'}을(를) 이 세션에서 빼기`); chip.append(select, eject); assignments.append(chip); });
        if (!assignments.children.length) assignments.append(element('div', 'session-drop-hint', '인원을 여기에 놓으세요'));
        card.append(assignments); column.append(card);
      }); return column;
    });
    const emptyDrop = element('button', 'session-empty-drop'); emptyDrop.type = 'button'; emptyDrop.dataset.sessionEmptyDrop = 'true'; emptyDrop.title = '사람을 끌어 놓거나 클릭하면 새 날짜와 시간을 입력합니다.'; emptyDrop.append(element('strong', '', '＋ 새 시간 만들기'), element('small', '', '끌어 놓기 또는 클릭'));
    board.replaceChildren(...columns, emptyDrop);
    assertSmokeUi(!board.querySelector('.session-assignment-chip[role="button"] button'), 'session assignment actions do not nest buttons');
    assertSmokeUi(!board.querySelector('.session-slot-card[tabindex]'), 'session cards expose explicit keyboard actions instead of inert focus stops');
    $('#sessionBoardStatus').textContent = selectedPerson ? `${selectedPerson.name || '선택한 사람'} · 현재 일정 ${selectedAssignments.length}개 · ${visibleDate ? `${formatDate(visibleDate)} 보기` : '전체 날짜 보기'}` : `${people.length}명 · 사람을 선택하면 현재 일정과 이동 후보가 표시됩니다.`;
    renderSessionChangePreview(project);
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

  function calendarDateLabel(dateKey, options = {}) {
    if (!CalendarCore?.isValidDateKey(dateKey)) return dateKey || '날짜 미정';
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Intl.DateTimeFormat('ko-KR', { year: options.year === false ? undefined : 'numeric', month: 'long', day: options.day === false ? undefined : 'numeric', weekday: options.weekday ? 'short' : undefined, timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  }

  function calendarPhaseLabel(phase) {
    if (!phase) return '';
    if (phase.status === 'past') return '종료';
    if (phase.status === 'live') return '진행 중';
    if (phase.status === 'invalid') return '시간 확인 필요';
    if (phase.status === 'imminent') {
      const minutes = Math.max(0, Math.round(phase.minutesUntilStart));
      if (minutes < 60) return `${minutes}분 후`;
      if (minutes < 24 * 60) return `${Math.round(minutes / 60)}시간 후`;
      return '24시간 이내';
    }
    return '예정';
  }

  function shiftCalendarAnchor(anchor, amount, view = calendarView) {
    if (!CalendarCore?.isValidDateKey(anchor)) return anchor;
    if (view === 'week') return CalendarCore.addDays(anchor, amount * 7);
    const [year, month] = anchor.split('-').map(Number); const target = new Date(Date.UTC(year, month - 1 + amount, 1));
    return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  function calendarSlotAssignments(project, slotId) {
    return project.data.assignments.filter((assignment) => assignment.slotId === slotId).map((assignment) => ({
      assignment,
      person: project.data.people.find((person) => person.id === assignment.personId),
      role: project.data.roles.find((role) => role.id === assignment.roleId)
    })).filter((item) => item.person && item.person.active !== false);
  }

  function resetCalendarFilters({ showCancelled = false } = {}) {
    if ($('#calendarSearch')) $('#calendarSearch').value = '';
    if ($('#calendarRoleFilter')) $('#calendarRoleFilter').value = '';
    if ($('#calendarHideCancelled')) $('#calendarHideCancelled').checked = !showCancelled;
  }

  function calendarFiltersActive(project) {
    return Boolean(($('#calendarSearch')?.value || '').trim()
      || ($('#calendarRoleFilter')?.value || '')
      || ($('#calendarHideCancelled')?.checked && project?.data.slots.some((slot) => slot.status === 'cancelled')));
  }

  function calendarFilteredSlots(project) {
    const query = ($('#calendarSearch')?.value || '').trim().toLocaleLowerCase('ko-KR');
    const roleId = $('#calendarRoleFilter')?.value || '';
    const hideCancelled = $('#calendarHideCancelled')?.checked !== false;
    return CalendarCore.sortSlots(project.data.slots, { project }).filter((slot) => {
      if (hideCancelled && slot.status === 'cancelled') return false;
      const assignments = calendarSlotAssignments(project, slot.id);
      if (roleId && !assignments.some((item) => item.assignment.roleId === roleId)) return false;
      if (!query) return true;
      const custom = Object.values(project.data.scheduleCustomValues?.[slot.id] || {});
      const haystack = [slot.label, slot.date, slot.endDate, slot.startTime, slot.endTime, ...custom, ...assignments.flatMap((item) => [item.person.name, item.person.group, item.person.email, item.role?.name])].filter(Boolean).join(' ').toLocaleLowerCase('ko-KR');
      return haystack.includes(query);
    });
  }

  function ensureCalendarAnchor(project) {
    const storedView = project.data.extensionData?.projectCalendar?.view;
    if (calendarProjectId !== project.id) {
      calendarProjectId = project.id;
      calendarView = ['month', 'week'].includes(storedView) ? storedView : 'month';
      calendarAnchorDate = '';
      calendarSelectedSlotId = null;
      resetCalendarFilters();
    }
    if (!calendarAnchorDate || !CalendarCore.isValidDateKey(calendarAnchorDate)) calendarAnchorDate = CalendarCore.initialAnchorMonth(project.data.slots, { project }) || CalendarCore.dateKeyInTimeZone(new Date(), CalendarCore.projectTimeZone(project));
    return calendarAnchorDate;
  }

  function calendarEventButton(project, slot, phase, visibleDate = slot.date) {
    const assignments = calendarSlotAssignments(project, slot.id); const roleNames = [...new Set(assignments.map((item) => item.role?.name || item.assignment.roleName).filter(Boolean))]; const lockReasons = scheduleRowLockReasons(project, slot.id);
    const button = element('button', `calendar-event phase-${phase.status} status-${slot.status || 'draft'}${lockReasons.length ? ' locked' : ''}${calendarSelectedSlotId === slot.id ? ' selected' : ''}`); button.type = 'button'; button.dataset.calendarEvent = slot.id; if (lockReasons.length) button.title = `잠금: ${lockReasons.join(' · ')}`;
    const endDate = CalendarCore.slotEndDate(slot); const segmentTime = visibleDate === slot.date ? slot.startTime || '--:--' : visibleDate === endDate ? `종료 ${slot.endTime || '--:--'}` : '계속';
    const copy = element('span', 'calendar-event-copy'); const title = `${segmentTime} ${slot.label || '이름 없는 일정'}`;
    const phaseText = calendarPhaseLabel(phase); const peopleText = assignments.length ? `${assignments.length}명${roleNames.length ? ` · ${roleNames.slice(0, 2).join('·')}` : ''}` : '배정 없음';
    copy.append(element('strong', '', title), element('small', '', `${phaseText} · ${peopleText}`)); button.append(copy);
    button.setAttribute('aria-label', `${slotRangeText(slot)} ${slot.label || '이름 없는 일정'}, ${phaseText}, ${peopleText}`);
    return button;
  }

  function renderProjectCalendarGrid(project) {
    const grid = $('#projectCalendarGrid'); const allSlots = calendarFilteredSlots(project); const timezone = CalendarCore.projectTimeZone(project); const today = CalendarCore.dateKeyInTimeZone(new Date(), timezone);
    const range = calendarView === 'week' ? CalendarCore.weekRange(calendarAnchorDate) : CalendarCore.monthGrid(calendarAnchorDate);
    const days = range?.days || []; const slotMap = new Map(days.map((day) => [typeof day === 'string' ? day : day.date, []]));
    allSlots.forEach((slot) => { slotMap.forEach((items, date) => { if (CalendarCore.slotOccursOnDate(slot, date)) items.push(slot); }); });
    grid.classList.toggle('week-view', calendarView === 'week'); grid.setAttribute('aria-rowcount', String(Math.ceil(days.length / 7))); grid.replaceChildren();
    let weekRow = null;
    days.forEach((entry, dayIndex) => {
      if (dayIndex % 7 === 0) { weekRow = element('div', 'calendar-week-row'); weekRow.setAttribute('role', 'row'); weekRow.setAttribute('aria-rowindex', String(Math.floor(dayIndex / 7) + 1)); grid.append(weekRow); }
      const date = typeof entry === 'string' ? entry : entry.date; const inMonth = typeof entry === 'string' ? true : entry.inMonth;
      const cell = element('section', `calendar-day${inMonth ? '' : ' outside-month'}${date === today ? ' today' : ''}`); cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String((dayIndex % 7) + 1)); cell.dataset.calendarDate = date; cell.setAttribute('aria-label', calendarDateLabel(date, { weekday: true }));
      const header = element('div', 'calendar-day-header'); const number = element('span', 'calendar-day-number', String(Number(date.slice(8, 10))));
      const add = element('button', 'calendar-day-add', '＋'); add.type = 'button'; add.dataset.calendarAddDate = date; add.setAttribute('aria-label', `${calendarDateLabel(date, { weekday: true })} 일정 추가`); header.append(number, add); cell.append(header);
      const events = element('div', 'calendar-day-events'); const daySlots = slotMap.get(date) || []; const limit = calendarView === 'week' ? daySlots.length : 3;
      daySlots.slice(0, limit).forEach((slot) => events.append(calendarEventButton(project, slot, CalendarCore.classifySlot(slot, { project }), date)));
      if (daySlots.length > limit) { const more = element('button', 'calendar-more-events', `＋${daySlots.length - limit}개 더 보기`); more.type = 'button'; more.dataset.calendarShowDay = date; events.append(more); }
      cell.append(events); weekRow.append(cell);
    });
    assertSmokeUi($$('.calendar-week-row', grid).every((row) => row.getAttribute('role') === 'row' && row.children.length === 7), 'calendar grid exposes seven-cell ARIA rows');
    const visibleSlots = [...new Map([...slotMap.values()].flat().map((slot) => [slot.id, slot])).values()]; const affectedPeople = new Set(visibleSlots.flatMap((slot) => calendarSlotAssignments(project, slot.id).map((item) => item.person.id)));
    const needsReview = visibleSlots.filter((slot) => ['changed', 'cancelled'].includes(slot.status) || CalendarCore.classifySlot(slot, { project }).status === 'invalid').length;
    $('#calendarSummary').textContent = `${visibleSlots.length}개 일정 · ${affectedPeople.size}명 배치 · ${needsReview}건 확인 필요 · ${timezone}`;
    const noSchedules = project.data.slots.length === 0; const noFilterMatches = !noSchedules && calendarFiltersActive(project) && allSlots.length === 0;
    $('#calendarEmpty').hidden = !noSchedules;
    $('#calendarFilterEmpty').hidden = !noFilterMatches;
    grid.hidden = noSchedules || noFilterMatches;
    $('.calendar-weekdays').hidden = noSchedules || noFilterMatches;
    if (smokeDiagnostics && !grid.hidden && grid.offsetParent !== null) {
      const renderedRows = $$('.calendar-week-row', grid); const rowRects = renderedRows.map((row) => row.getBoundingClientRect());
      assertSmokeUi(renderedRows.every((row) => { const rects = [...row.children].map((cell) => cell.getBoundingClientRect()); return rects.length === 7 && rects.every((rect) => Math.abs(rect.top - rects[0].top) < 2) && rects.slice(1).every((rect, index) => rect.left > rects[index].left); }), 'calendar days render as seven horizontal columns');
      assertSmokeUi(rowRects.slice(1).every((rect, index) => rect.top > rowRects[index].top), 'calendar week rows render vertically without overlap');
    }
  }

  function calendarPeriodText() {
    if (calendarView === 'week') {
      const range = CalendarCore.weekRange(calendarAnchorDate); if (!range) return '';
      const start = calendarDateLabel(range.start, { weekday: false }); const end = calendarDateLabel(range.end, { year: range.start.slice(0, 4) !== range.end.slice(0, 4), weekday: false }); return `${start} – ${end}`;
    }
    return calendarDateLabel(`${calendarAnchorDate.slice(0, 7)}-01`, { day: false });
  }

  function activityActualRange(slot, activity) {
    const startOffset = Math.max(0, Number(activity.startOffsetMinutes) || 0); const duration = Math.max(1, Number(activity.durationMinutes) || 1);
    const start = CalendarCore.offsetDateTime(slot.date, slot.startTime, startOffset); const end = CalendarCore.offsetDateTime(slot.date, slot.startTime, startOffset + duration);
    return start && end ? { start, end, duration } : null;
  }

  function calendarActivityLocked(project, activity) {
    return Boolean(activity?.locked || (project?.data.activityAssignments || []).some((assignment) => assignment.activityId === activity?.id && assignment.locked));
  }

  function renderCalendarDetail(project) {
    const detail = $('#calendarDetail'); const slot = project.data.slots.find((item) => item.id === calendarSelectedSlotId);
    if (!slot) { detail.hidden = true; return; }
    if (!calendarFilteredSlots(project).some((item) => item.id === slot.id)) { detail.hidden = true; return; }
    const phase = CalendarCore.classifySlot(slot, { project }); const lockReasons = scheduleRowLockReasons(project, slot.id); const rowLocked = lockReasons.length > 0; const badges = $('#calendarDetailBadges'); badges.replaceChildren();
    const stateLabel = ({ draft: '편성 중', confirmed: '확정', changed: '변경됨', cancelled: '취소' })[slot.status] || slot.status || '편성 중';
    badges.append(element('span', `calendar-state-badge ${slot.status || 'draft'}`, stateLabel), element('span', `calendar-state-badge ${phase.status}`, calendarPhaseLabel(phase)));
    if (rowLocked) badges.append(element('span', 'calendar-state-badge', '잠김'));
    $('#calendarDetailTitle').textContent = slot.label || '이름 없는 일정';
    const durationText = phase.wallDurationMinutes ? (phase.wallDurationMinutes >= 24 * 60 ? ` · ${Math.floor(phase.wallDurationMinutes / (24 * 60))}일 ${Math.round((phase.wallDurationMinutes % (24 * 60)) / 60)}시간` : ` · ${phase.wallDurationMinutes}분`) : '';
    $('#calendarDetailTime').textContent = `${slotRangeText(slot, { includeYear: true })}${durationText}`;
    const lockNotice = $('#calendarLockNotice'); lockNotice.hidden = !rowLocked; lockNotice.textContent = rowLocked ? `잠금 원인: ${lockReasons.join(' · ')}. 이 잠금을 만든 일정·배치·진행 항목에서 해제해야 수정할 수 있습니다.` : '';

    const agenda = $('#calendarAgenda'); agenda.replaceChildren(); const activities = (project.data.activities || []).filter((activity) => storedId(activity.eventId, activity.slotId) === slot.id).sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || Number(a.startOffsetMinutes || 0) - Number(b.startOffsetMinutes || 0));
    if (!activities.length) {
      const empty = element('div', 'list-empty'); empty.append(element('strong', '', '아직 진행 항목이 없습니다.'), element('p', '', '시간별로 할 일과 담당자를 추가하면 당일 진행표처럼 사용할 수 있습니다.')); agenda.append(empty);
    } else activities.forEach((activity) => {
      const range = activityActualRange(slot, activity); const activityPhase = range ? CalendarCore.classifySlot({ date: range.start.date, endDate: range.end.date, startTime: range.start.time, endTime: range.end.time }, { project }) : { status: 'invalid' };
      const assigned = (project.data.activityAssignments || []).filter((item) => item.activityId === activity.id).map((item) => project.data.people.find((person) => person.id === item.personId)?.name).filter(Boolean);
      const row = element('article', `calendar-agenda-item phase-${activityPhase.status}`); const activityTime = range ? (range.start.date === range.end.date ? `${calendarDateLabel(range.start.date, { year: false })} ${range.start.time}–${range.end.time}` : `${calendarDateLabel(range.start.date, { year: false })} ${range.start.time} → ${calendarDateLabel(range.end.date, { year: false })} ${range.end.time}`) : '시간 확인'; const time = element('time', '', activityTime);
      const copy = element('div'); copy.append(element('strong', '', activity.title || '진행 항목'), element('small', '', [assigned.length ? assigned.join(', ') : '담당자 미지정', activity.description].filter(Boolean).join(' · ')));
      const edit = element('button', 'calendar-agenda-edit', '수정'); edit.type = 'button'; edit.dataset.calendarEditActivity = activity.id; edit.disabled = rowLocked || calendarActivityLocked(project, activity); if (edit.disabled) edit.title = scheduleRowLockMessage(project, slot.id, '진행 항목을 수정') || '잠긴 진행 항목입니다.'; row.append(time, copy, edit); agenda.append(row);
    });

    const customDetails = $('#calendarCustomDetails'); customDetails.replaceChildren(); const customValues = project.data.scheduleCustomValues?.[slot.id] || {};
    (project.data.scheduleSheetColumns || []).filter((column) => column.kind === 'custom' && String(customValues[column.id] || '').trim()).forEach((column) => { customDetails.append(element('dt', '', column.name), element('dd', '', customValues[column.id])); });
    $('#calendarCustomSection').hidden = customDetails.children.length === 0;

    const conference = $('#calendarConference'); conference.replaceChildren(); const artifact = (project.data.externalArtifacts || []).filter((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status !== 'superseded').sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0];
    if (!artifact) conference.append(element('strong', '', '연결된 회의 없음'), element('small', '', '필요하면 외부 회의 프로그램에서 이 일정에 회의를 연결할 수 있습니다.'));
    else {
      const provider = artifact.provider || (artifact.kind === 'zoom' ? 'Zoom' : '외부 회의'); const status = artifact.status === 'created' ? '연결됨' : artifact.status === 'stale' ? '일정 변경 후 다시 확인 필요' : '상태 확인 필요'; conference.append(element('strong', '', `${provider} · ${status}`), element('small', '', artifact.reviewReason || (artifact.status === 'created' ? '일정에 연결된 회의를 바로 열 수 있습니다.' : '외부 서비스의 시간을 확인한 뒤 갱신해주세요.')));
      const actions = element('div', 'button-row'); if (artifact.joinUrl) { const join = element('button', 'secondary-button compact', '참가 링크 열기'); join.type = 'button'; join.dataset.calendarOpenUrl = artifact.joinUrl; actions.append(join); } if (artifact.startUrl) { const host = element('button', 'secondary-button compact', '호스트로 시작'); host.type = 'button'; host.dataset.calendarOpenUrl = artifact.startUrl; actions.append(host); } if (actions.children.length) conference.append(actions);
    }

    const groups = $('#calendarAssignments'); groups.replaceChildren(); const assignments = calendarSlotAssignments(project, slot.id);
    project.data.roles.filter((role) => role.active !== false || assignments.some((item) => item.assignment.roleId === role.id)).forEach((role) => {
      const members = assignments.filter((item) => item.assignment.roleId === role.id); if (!members.length && !Number(role.minPerSession)) return;
      const row = element('div', 'calendar-assignment-group'); const label = element('strong', '', `${role.name} ${members.length}${role.maxPerSession ? `/${role.maxPerSession}` : ''}`); const tags = element('div', 'calendar-person-tags'); members.forEach((item) => tags.append(element('span', 'calendar-person-tag', `${item.person.name || '이름 없음'}${item.person.group ? ` · ${item.person.group}` : ''}`)));
      if (members.length < Number(role.minPerSession || 0)) tags.append(element('span', 'calendar-role-warning', `${Number(role.minPerSession) - members.length}명 부족`)); if (!members.length) tags.append(element('span', 'calendar-role-warning', '배정 없음')); row.append(label, tags); groups.append(row);
    });
    if (!groups.children.length) groups.append(element('div', 'list-empty', '아직 배정된 사람이 없습니다.'));
    $('#calendarEditEvent').disabled = Boolean(rowLocked || slot.status === 'cancelled'); $('#calendarAdjustEvent').disabled = Boolean(rowLocked || slot.status === 'cancelled'); $('#calendarCancelEvent').disabled = Boolean(rowLocked || slot.status === 'cancelled'); $('#calendarAddActivity').disabled = Boolean(rowLocked || slot.status === 'cancelled');
    [$('#calendarEditEvent'), $('#calendarAdjustEvent'), $('#calendarCancelEvent'), $('#calendarAddActivity')].forEach((button) => { button.title = rowLocked ? scheduleRowLockMessage(project, slot.id) : slot.status === 'cancelled' ? '취소된 일정은 수정할 수 없습니다.' : ''; });
    detail.hidden = false;
  }

  async function dispatchSessionSchedulerAction(action) {
    if (!SessionSchedulerCore?.applyAction) return { ok: false, blockers: [{ message: '세션 편성 모듈을 불러오지 못했습니다.' }] };
    await flushSchedulePersist();
    const project = activeProject();
    if (!project) return { ok: false, blockers: [{ message: '현재 프로젝트를 찾지 못했습니다.' }] };
    const beforeSnapshot = scheduleSnapshot(project);
    let result;
    try {
      result = SessionSchedulerCore.applyAction(project, action, { operations: Ops, now: new Date() });
    } catch (error) {
      return { ok: false, blockers: [{ message: error.message || '세션 편성 변경을 적용하지 못했습니다.' }] };
    }
    if (!result?.ok || !result.data) return result || { ok: false, blockers: [{ message: '세션 편성 변경 결과를 확인하지 못했습니다.' }] };
    pushScheduleHistorySnapshot(beforeSnapshot, project.id);
    project.data = result.data;
    const impact = result.impact && Array.isArray(result.impact.changedSlotIds) ? result.impact : null;
    const scheduleChanged = Boolean(impact && (impact.changedSlotIds.length || impact.removedSlotIds?.length || impact.removedAssignmentIds?.length));
    if (scheduleChanged) {
      markScheduleChangeStale(project, impact);
      refreshScheduleConflicts(project);
      syncScheduleProjectState(project, result.message || '세션 그룹 배치 변경', impact);
      recordScheduleMergeImpact(project.id, impact, { scheduleOnly: false });
    } else {
      state = Core.updateProject(state, project.id, { data: project.data });
      recordScheduleMergeImpact(project.id, result.impact || null, { scheduleOnly: false });
    }
    state = Core.setModuleStatus(state, project.id, 'projectCalendar', project.data.conflicts.length ? 'needsReview' : 'inProgress', result.message || '세션 일정 편집 중');
    await persist(result.message || '세션 일정 저장됨');
    renderDashboardCalendar();
    return result;
  }

  function openLegacyCalendarSurface() {
    calendarSurfaceMode = 'legacy';
    calendarSelectedSessionId = sessionSchedulerController?.selectedSessionId?.() || calendarSelectedSessionId;
    renderProjectCalendarPage();
  }

  function ensureSessionSchedulerController() {
    const projectId = activeProject()?.id || '';
    if (sessionSchedulerController && sessionSchedulerProjectId !== projectId) {
      sessionSchedulerController.destroy?.();
      sessionSchedulerController = null;
    }
    if (sessionSchedulerController || !SessionSchedulerUI?.create || !$('#sessionSchedulerMount')) return sessionSchedulerController;
    sessionSchedulerController = SessionSchedulerUI.create({
      mount: $('#sessionSchedulerMount'),
      getProject: () => activeProject(),
      dispatch: dispatchSessionSchedulerAction,
      confirm: (message, options = {}) => showConfirm(message, options),
      toast: (message, tone = 'normal') => showToast(message, tone),
      onOpenLegacy: openLegacyCalendarSurface
    });
    sessionSchedulerProjectId = projectId;
    return sessionSchedulerController;
  }

  function renderProjectCalendarPage() {
    const project = activeProject(); if (!project) { if (standaloneProgram) { $('#projectCalendarGrid').replaceChildren(); $('#calendarEmpty').hidden = false; $('#calendarFilterEmpty').hidden = true; } else navigate('dashboard'); return; }
    project.data.activities ||= []; project.data.activityAssignments ||= []; project.data.extensionData ||= {}; project.data.extensionData.projectCalendar ||= {};
    const projectChanged = calendarProjectId !== project.id;
    if (projectChanged) { calendarProjectId = project.id; calendarSurfaceMode = 'sessions'; calendarSelectedSlotId = null; calendarSelectedSessionId = null; }
    const useSessionSurface = calendarSurfaceMode !== 'legacy' && SessionSchedulerCore && SessionSchedulerUI;
    $('#sessionSchedulerMount').hidden = !useSessionSurface;
    $('#legacyCalendarWorkspace').hidden = useSessionSurface;
    $('#calendarLegacyHeadingActions').hidden = useSessionSurface;
    if (useSessionSurface) {
      const controller = ensureSessionSchedulerController();
      const requestedSessionId = calendarSelectedSessionId;
      calendarSelectedSessionId = null;
      controller?.render?.(projectChanged ? { mode: 'overview', selectedSessionId: null } : {});
      if (requestedSessionId) controller?.openSession?.(requestedSessionId);
      return;
    }
    if (!['month', 'week'].includes(calendarView)) calendarView = project.data.extensionData.projectCalendar.view || 'month'; ensureCalendarAnchor(project);
    $('#calendarMonthView').classList.toggle('active', calendarView === 'month'); $('#calendarMonthView').setAttribute('aria-pressed', String(calendarView === 'month'));
    $('#calendarWeekView').classList.toggle('active', calendarView === 'week'); $('#calendarWeekView').setAttribute('aria-pressed', String(calendarView === 'week'));
    const roleSelect = $('#calendarRoleFilter'); const previousRole = roleSelect.value; const allRoles = element('option', '', '모든 역할'); allRoles.value = ''; roleSelect.replaceChildren(allRoles); project.data.roles.filter((role) => role.active !== false).forEach((role) => { const option = element('option', '', role.name); option.value = role.id; roleSelect.append(option); }); if ([...roleSelect.options].some((option) => option.value === previousRole)) roleSelect.value = previousRole;
    $('#calendarPeriodLabel').textContent = calendarPeriodText(); renderProjectCalendarGrid(project); renderCalendarDetail(project); syncScheduleHistoryControls();
  }

  function closeCalendarDetail({ restoreFocus = true } = {}) {
    $('#calendarDetail').hidden = true; calendarSelectedSlotId = null; $$('.calendar-event.selected', $('#projectCalendarGrid')).forEach((item) => item.classList.remove('selected'));
    const returnFocus = calendarDetailReturnFocus; calendarDetailReturnFocus = null;
    if (restoreFocus) {
      const eventButton = returnFocus?.slotId ? $$('[data-calendar-event]', $('#projectCalendarGrid')).find((item) => item.dataset.calendarEvent === returnFocus.slotId) : null;
      (eventButton || (returnFocus?.element?.isConnected ? returnFocus.element : null) || $('#calendarSearch'))?.focus?.();
    }
  }

  function selectCalendarEvent(slotId, trigger = null) {
    const project = activeProject(); if (!project?.data.slots.some((slot) => slot.id === slotId)) return;
    const focusSource = trigger || document.activeElement;
    calendarSelectedSlotId = slotId; calendarDetailReturnFocus = { slotId: focusSource?.dataset?.calendarEvent || slotId, element: focusSource }; renderProjectCalendarGrid(project); renderCalendarDetail(project); $('#calendarDetailClose').focus();
  }

  function inclusiveCalendarDayCount(startDate, endDate) {
    const ordered = CalendarCore.orderedDateRange(startDate, endDate); if (!ordered) return 0;
    let count = 1; let cursor = ordered.start;
    while (cursor < ordered.end && count <= 3660) { cursor = CalendarCore.addDays(cursor, 1); count += 1; }
    return cursor === ordered.end ? count : 0;
  }

  function wallMinuteOffset(startDate, startTime, endDate, endTime) {
    if (!CalendarCore.isValidDateKey(startDate) || !CalendarCore.isValidDateKey(endDate)) return null; const start = CalendarCore.timeToMinutes(startTime); const end = CalendarCore.timeToMinutes(endTime); if (start == null || end == null) return null;
    const startDay = Date.parse(`${startDate}T00:00:00Z`); const endDay = Date.parse(`${endDate}T00:00:00Z`); if (!Number.isFinite(startDay) || !Number.isFinite(endDay)) return null;
    return Math.round((endDay - startDay) / 60000) + end - start;
  }

  function renderCalendarEventRangeSummary() {
    const summary = $('#calendarEventRangeSummary'); const save = $('#calendarEventSave'); if (!summary || !save) return false;
    const candidate = {
      date: $('#calendarEventStartDate').value,
      endDate: $('#calendarEventEndDate').value,
      startTime: $('#calendarEventStartTime').value,
      endTime: $('#calendarEventEndTime').value
    };
    const project = projectById(calendarEventEditor?.projectId) || activeProject(); const interval = CalendarCore.slotInterval(candidate, { project });
    if (!interval.ok) {
      const message = ({ invalidDate: '시작 날짜를 선택해주세요.', invalidEndDate: '종료 날짜를 선택해주세요.', invalidDateRange: '종료 날짜는 시작 날짜보다 빠를 수 없습니다.', invalidTime: '시작과 종료 시간을 모두 선택해주세요.', invalidTimeRange: '같은 날에는 종료 시간을 시작 시간보다 늦게 선택해주세요.', nonexistentLocalTime: '선택한 시간대에 존재하지 않는 시각입니다.' })[interval.reason] || '시작과 종료 날짜·시간을 다시 확인해주세요.';
      summary.textContent = message; summary.classList.add('invalid'); save.disabled = true; return false;
    }
    const days = inclusiveCalendarDayCount(candidate.date, candidate.endDate); const rangeSlot = { ...candidate, endDate: candidate.endDate === candidate.date ? '' : candidate.endDate };
    summary.textContent = `${slotRangeText(rangeSlot, { includeYear: true })} · ${days > 1 ? `${days}일 범위` : `${interval.wallDurationMinutes}분`}`;
    summary.classList.remove('invalid'); save.disabled = false; return true;
  }

  function openCalendarEventEditor({ slotId = '', startDate = '', endDate = '', sourcePage = currentPage, pendingAssignment = null } = {}) {
    const project = activeProject(); if (!project) return;
    const slot = slotId ? project.data.slots.find((item) => item.id === slotId) : null;
    if (slot && (slot.status === 'cancelled' || scheduleRowLocked(project, slot.id))) { showToast(slot.status === 'cancelled' ? '취소된 일정은 편집할 수 없습니다.' : scheduleRowLockMessage(project, slot.id, '일정을 편집'), 'error'); return; }
    const timezone = CalendarCore.projectTimeZone(project); const today = CalendarCore.dateKeyInTimeZone(new Date(), timezone); const firstDate = CalendarCore.isValidDateKey(startDate) ? startDate : slot?.date || today;
    const lastDate = CalendarCore.isValidDateKey(endDate) ? endDate : slot ? CalendarCore.slotEndDate(slot) : firstDate;
    const startTime = slot?.startTime || '09:00'; const defaultEnd = Ops.addMinutesToTime(startTime, project.settings?.sessionDurationMinutes) || '10:00';
    calendarEventEditor = { projectId: project.id, slotId: slot?.id || '', signature: scheduleChangeSignature(project), sourcePage, pendingAssignment };
    $('#calendarEventDialogEyebrow').textContent = slot ? '일정 편집' : (firstDate === lastDate ? '새 일정' : '선택한 날짜 범위');
    $('#calendarEventDialogTitle').textContent = slot ? '날짜와 시간 편집' : '새 일정 만들기';
    $('#calendarEventDialogDescription').textContent = slot ? '일정 이름과 시작·종료를 한 화면에서 바꿀 수 있습니다.' : firstDate === lastDate ? '날짜와 시간을 선택하면 캘린더와 일정표에 함께 반영됩니다.' : `${calendarDateLabel(firstDate)}부터 ${calendarDateLabel(lastDate)}까지 선택했습니다. 시작과 종료 시간만 정하세요.`;
    $('#calendarEventTitle').value = slot?.label || '';
    $('#calendarEventStartDate').value = firstDate; $('#calendarEventEndDate').value = lastDate;
    $('#calendarEventStartTime').value = startTime; $('#calendarEventEndTime').value = slot?.endTime || (firstDate === lastDate ? defaultEnd : '18:00');
    $('#calendarEventSave').textContent = slot ? '변경 저장' : '일정 추가'; renderCalendarEventRangeSummary(); openDialog('calendarEventDialog');
    setTimeout(() => { const title = $('#calendarEventTitle'); title.focus(); if (title.value) title.select(); });
  }

  function applyCalendarEventDuration(minutes) {
    const date = $('#calendarEventStartDate').value; const time = $('#calendarEventStartTime').value; const result = CalendarCore.offsetDateTime(date, time, Number(minutes)); if (!result) return;
    $('#calendarEventEndDate').value = result.date; $('#calendarEventEndTime').value = result.time; renderCalendarEventRangeSummary();
  }

  async function saveCalendarEvent(event) {
    event.preventDefault(); if (!renderCalendarEventRangeSummary()) return false;
    await flushSchedulePersist(); const editor = calendarEventEditor; let project = projectById(editor?.projectId); if (!project || project.id !== activeProject()?.id) { closeDialog('calendarEventDialog'); showToast('편집하던 프로젝트가 바뀌었습니다. 다시 열어주세요.', 'error'); return false; }
    if (scheduleChangeSignature(project) !== editor.signature) { closeDialog('calendarEventDialog'); showToast('편집하는 동안 일정이 바뀌었습니다. 최신 일정을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return false; }
    const title = $('#calendarEventTitle').value.trim(); if (!title) { showToast('일정 이름을 입력해주세요.', 'error'); $('#calendarEventTitle').focus(); return false; }
    const candidate = { date: $('#calendarEventStartDate').value, startTime: $('#calendarEventStartTime').value, endTime: $('#calendarEventEndTime').value };
    const selectedEndDate = $('#calendarEventEndDate').value; if (selectedEndDate !== candidate.date) candidate.endDate = selectedEndDate;
    const interval = CalendarCore.slotInterval(candidate, { project }); if (!interval.ok) { renderCalendarEventRangeSummary(); return false; }
    const before = scheduleSnapshot(project); const existing = editor.slotId ? project.data.slots.find((item) => item.id === editor.slotId) : null;
    if (editor.slotId && (!existing || existing.status === 'cancelled' || scheduleRowLocked(project, existing.id))) { closeDialog('calendarEventDialog'); showToast(!existing ? '다른 창에서 이 일정이 삭제되었습니다.' : '다른 창에서 이 일정의 상태가 바뀌었습니다.', 'error'); renderAll(); return false; }
    const timeChanged = Boolean(existing && (existing.date !== candidate.date || CalendarCore.slotEndDate(existing) !== selectedEndDate || existing.startTime !== candidate.startTime || existing.endTime !== candidate.endTime));
    let movePlan = null;
    if (timeChanged) {
      movePlan = Ops.planScheduleBatchChange({ people: project.data.people, roles: project.data.roles, slots: project.data.slots, assignments: project.data.assignments, activities: project.data.activities || [], availability: project.data.availability, rules: project.data.scheduleRules, timeZone: CalendarCore.projectTimeZone(project), changeSet: { slotChanges: [{ action: 'move', slotId: existing.id, ...candidate, endDate: selectedEndDate }], assignmentChanges: [] } });
      if (!movePlan.canApply) { const reason = movePlan.blockers[0]?.message || '현재 배치와 진행 항목 때문에 이 시간으로 변경할 수 없습니다.'; showToast(reason, 'error'); return false; }
    }
    if (existing && !timeChanged && existing.label === title) { closeDialog('calendarEventDialog'); calendarEventEditor = null; return true; }
    pushScheduleHistory(project); let savedSlot;
    if (!existing) {
      savedSlot = { id: `slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, ...candidate, label: title, locked: false, status: 'draft' };
      project.data.slots.push(savedSlot);
    } else {
      if (timeChanged) {
        project.data.slots = movePlan.nextSlots; project.data.assignments = movePlan.nextAssignments;
      }
      savedSlot = project.data.slots.find((item) => item.id === existing.id); savedSlot.label = title;
      if ((timeChanged || existing.label !== title) && savedSlot.status === 'confirmed') savedSlot.status = 'changed';
    }
    if (savedSlot.endDate) ensureScheduleEndDateColumn(project);
    refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, before);
    syncScheduleProjectState(project, `${existing ? '일정 편집' : '새 일정 추가'} · 문제 ${project.data.conflicts.length}건`, impact);
    if (project.installedModules.includes('projectCalendar')) state = Core.setModuleStatus(state, project.id, 'projectCalendar', project.data.conflicts.length ? 'needsReview' : 'inProgress', `${title} · ${slotRangeText(savedSlot)}`);
    calendarSelectedSlotId = savedSlot.id; calendarAnchorDate = calendarView === 'month' ? `${savedSlot.date.slice(0, 7)}-01` : savedSlot.date;
    const pendingAssignment = editor.pendingAssignment; closeDialog('calendarEventDialog'); calendarEventEditor = null; await persist(existing ? '캘린더 일정 편집됨' : '캘린더 일정 추가됨'); renderAll();
    if (!existing && pendingAssignment) { const latest = projectById(project.id); if (latest) previewSessionChange(latest, { personId: pendingAssignment.personId, assignmentId: pendingAssignment.assignmentId, toSlotId: savedSlot.id }); }
    else if (currentPage === 'projectCalendar') selectCalendarEvent(savedSlot.id); else showToast(`${title} 일정을 저장했습니다.`, 'success');
    return true;
  }

  function updateCalendarDragHighlight() {
    const grid = $('#projectCalendarGrid'); if (!grid) return; const range = CalendarCore.orderedDateRange(calendarDragSelection?.startDate, calendarDragSelection?.endDate);
    $$('.calendar-day', grid).forEach((day) => { const selected = Boolean(range && day.dataset.calendarDate >= range.start && day.dataset.calendarDate <= range.end); day.classList.toggle('range-selecting', selected); day.classList.toggle('range-start', Boolean(selected && day.dataset.calendarDate === range.start)); day.classList.toggle('range-end', Boolean(selected && day.dataset.calendarDate === range.end)); });
  }

  function openCalendarActivityDialog(activityId = '') {
    const project = activeProject(); const slot = project?.data.slots.find((item) => item.id === calendarSelectedSlotId); if (!project || !slot) return;
    if (slot.status === 'cancelled') { showToast('취소된 일정에는 진행 항목을 추가하거나 수정할 수 없습니다.', 'error'); return; }
    if (scheduleRowLocked(project, slot.id)) { showToast(scheduleRowLockMessage(project, slot.id, '진행 항목을 수정'), 'error'); return; }
    const activity = activityId ? (project.data.activities || []).find((item) => item.id === activityId) : null; if (calendarActivityLocked(project, activity)) { showToast('잠긴 진행 항목은 잠금을 만든 곳에서 먼저 해제해주세요.', 'error'); return; }
    const range = activity ? activityActualRange(slot, activity) : { start: { date: slot.date, time: slot.startTime }, end: { date: CalendarCore.slotEndDate(slot), time: slot.endTime } };
    $('#calendarActivityDialogTitle').textContent = activity ? '진행 항목 수정' : '진행 항목 추가'; $('#calendarActivityId').value = activity?.id || ''; $('#calendarActivitySlotId').value = slot.id; $('#calendarActivityTitle').value = activity?.title || ''; $('#calendarActivityDescription').value = activity?.description || ''; $('#calendarActivityStartDate').value = range?.start?.date || slot.date; $('#calendarActivityStart').value = range?.start?.time || slot.startTime; $('#calendarActivityEndDate').value = range?.end?.date || CalendarCore.slotEndDate(slot); $('#calendarActivityEnd').value = range?.end?.time || slot.endTime; $('#calendarDeleteActivity').hidden = !activity;
    [$('#calendarActivityStartDate'), $('#calendarActivityEndDate')].forEach((input) => { input.min = slot.date; input.max = CalendarCore.slotEndDate(slot); });
    const selectedPeople = new Set((project.data.activityAssignments || []).filter((item) => item.activityId === activity?.id).map((item) => item.personId)); const people = $('#calendarActivityPeople'); people.replaceChildren();
    calendarSlotAssignments(project, slot.id).forEach((item) => { const label = element('label', 'calendar-activity-person'); const input = element('input'); input.type = 'checkbox'; input.value = item.assignment.id; input.dataset.calendarActivityAssignment = item.assignment.id; input.checked = selectedPeople.has(item.person.id); const copy = element('span'); copy.append(element('strong', '', item.person.name || '이름 없음'), element('small', '', item.role?.name || item.assignment.roleName || '역할 미정')); label.append(input, copy); people.append(label); });
    if (!people.children.length) people.append(element('div', 'list-empty', '이 일정에 먼저 사람을 배치해주세요.'));
    $('#calendarActivityDialog').dataset.calendarSignature = scheduleChangeSignature(project); openDialog('calendarActivityDialog'); setTimeout(() => $('#calendarActivityTitle').focus());
  }

  async function saveCalendarActivity(event) {
    event.preventDefault(); const project = activeProject(); const slotId = $('#calendarActivitySlotId').value; const slot = project?.data.slots.find((item) => item.id === slotId); if (!project || !slot) return;
    if (scheduleChangeSignature(project) !== $('#calendarActivityDialog').dataset.calendarSignature) { closeDialog('calendarActivityDialog'); showToast('확인하는 동안 일정이 바뀌었습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.', 'error'); renderProjectCalendarPage(); return; }
    if (slot.status === 'cancelled' || scheduleRowLocked(project, slot.id)) { closeDialog('calendarActivityDialog'); showToast(slot.status === 'cancelled' ? '취소된 일정에는 진행 항목을 저장할 수 없습니다.' : scheduleRowLockMessage(project, slot.id, '진행 항목을 저장'), 'error'); renderProjectCalendarPage(); return; }
    const activityStartDate = $('#calendarActivityStartDate').value; const activityEndDate = $('#calendarActivityEndDate').value; const activityStartTime = $('#calendarActivityStart').value; const activityEndTime = $('#calendarActivityEnd').value;
    const startOffsetMinutes = wallMinuteOffset(slot.date, slot.startTime, activityStartDate, activityStartTime); const durationMinutes = wallMinuteOffset(activityStartDate, activityStartTime, activityEndDate, activityEndTime); const slotDurationMinutes = CalendarCore.slotInterval(slot, { project }).wallDurationMinutes;
    if (startOffsetMinutes == null || durationMinutes == null || slotDurationMinutes == null || startOffsetMinutes < 0 || durationMinutes <= 0 || startOffsetMinutes + durationMinutes > slotDurationMinutes) { showToast('진행 항목의 시작과 종료를 전체 일정 범위 안에서 선택해주세요.', 'error'); return; }
    const id = $('#calendarActivityId').value || `activity-${Date.now().toString(36)}`; const current = project.data.activities.find((item) => item.id === id); if (calendarActivityLocked(project, current)) { showToast('잠긴 진행 항목은 수정할 수 없습니다.', 'error'); return; }
    pushScheduleHistory(project); const next = { ...(current || {}), id, eventId: slot.id, title: $('#calendarActivityTitle').value.trim(), description: $('#calendarActivityDescription').value.trim(), startOffsetMinutes, durationMinutes, status: current?.status || 'todo', order: current?.order ?? project.data.activities.filter((item) => storedId(item.eventId, item.slotId) === slot.id).length, locked: false, updatedAt: new Date().toISOString(), createdAt: current?.createdAt || new Date().toISOString() };
    if (current) project.data.activities[project.data.activities.findIndex((item) => item.id === id)] = next; else project.data.activities.push(next);
    project.data.activityAssignments = project.data.activityAssignments.filter((item) => item.activityId !== id); $$('[data-calendar-activity-assignment]:checked', $('#calendarActivityPeople')).forEach((input, index) => { const assignment = project.data.assignments.find((item) => item.id === input.value); if (assignment) project.data.activityAssignments.push({ id: `activity-assignment-${Date.now().toString(36)}-${index}`, activityId: id, assignmentId: assignment.id, personId: assignment.personId, roleId: assignment.roleId, status: 'planned', locked: false }); });
    refreshScheduleConflicts(project); state = Core.updateProject(state, project.id, { data: project.data }); state = Core.setModuleStatus(state, project.id, 'projectCalendar', 'inProgress', `${slot.label || '일정'} 진행 항목 저장`); recordScheduleMergeImpact(project.id, { changedSlotIds: [slot.id], zoomReviewSlotIds: [], affectedPersonIds: [] }); closeDialog('calendarActivityDialog'); await persist('캘린더 진행 항목 저장됨'); renderProjectCalendarPage(); showToast('진행 항목과 담당자를 저장했습니다.', 'success');
  }

  async function deleteCalendarActivity() {
    let project = activeProject(); const id = $('#calendarActivityId').value; const activity = project?.data.activities.find((item) => item.id === id); const slotId = activity ? storedId(activity.eventId, activity.slotId) : null; if (!project || !activity) return;
    if (scheduleRowLocked(project, slotId) || calendarActivityLocked(project, activity)) { showToast(scheduleRowLockMessage(project, slotId, '진행 항목을 삭제') || '잠긴 진행 항목은 삭제할 수 없습니다.', 'error'); return; }
    if (!await showConfirm(`“${activity.title || '진행 항목'}”을 삭제할까요?`, { title: '진행 항목 삭제', action: '삭제' })) return;
    project = activeProject(); const current = project?.data.activities.find((item) => item.id === id); if (!project || !current || scheduleRowLocked(project, slotId) || calendarActivityLocked(project, current) || scheduleChangeSignature(project) !== $('#calendarActivityDialog').dataset.calendarSignature) { closeDialog('calendarActivityDialog'); showToast('확인하는 동안 일정 또는 잠금 상태가 바뀌었습니다. 다시 시도해주세요.', 'error'); return; }
    pushScheduleHistory(project); project.data.activities = project.data.activities.filter((item) => item.id !== id); project.data.activityAssignments = project.data.activityAssignments.filter((item) => item.activityId !== id); state = Core.updateProject(state, project.id, { data: project.data }); recordScheduleMergeImpact(project.id, { changedSlotIds: [slotId], zoomReviewSlotIds: [], affectedPersonIds: [] }); closeDialog('calendarActivityDialog'); await persist('캘린더 진행 항목 삭제됨'); renderProjectCalendarPage(); showToast('진행 항목을 삭제했습니다.');
  }

  function calendarAdjustmentScope(project) {
    return new Set(calendarAdjustmentDraft?.selectedSlotIds || []).has(calendarAdjustmentDraft?.sourceSlotId)
      ? new Set(calendarAdjustmentDraft.selectedSlotIds)
      : new Set([calendarAdjustmentDraft?.sourceSlotId].filter(Boolean));
  }

  function calendarAdjustmentChangeSet(project) {
    const draft = calendarAdjustmentDraft; const source = project?.data.slots.find((slot) => slot.id === draft?.sourceSlotId); if (!project || !source || !draft) return { slotChanges: [], assignmentChanges: [] };
    const date = $('#calendarAdjustDate').value; const endDate = $('#calendarAdjustEndDate').value; const startTime = $('#calendarAdjustStart').value; const endTime = $('#calendarAdjustEnd').value; const slotChanges = [];
    if (date !== source.date || endDate !== CalendarCore.slotEndDate(source) || startTime !== source.startTime || endTime !== source.endTime) slotChanges.push({ action: 'move', slotId: source.id, date, endDate, startTime, endTime });
    const scope = calendarAdjustmentScope(project); const assignmentChanges = [];
    project.data.assignments.filter((assignment) => scope.has(assignment.slotId)).forEach((assignment) => {
      const target = draft.assignmentTargets[assignment.id] ?? assignment.slotId; const roleId = draft.assignmentRoles[assignment.id] || assignment.roleId;
      if (target === '__remove__') assignmentChanges.push({ action: 'remove', assignmentId: assignment.id });
      else if (target !== assignment.slotId || roleId !== assignment.roleId) assignmentChanges.push({ action: 'move', assignmentId: assignment.id, toSlotId: target, roleId });
    });
    draft.additions.forEach((addition) => assignmentChanges.push({ action: 'add', nextAssignmentId: addition.id, personId: addition.personId, roleId: addition.roleId, toSlotId: addition.toSlotId }));
    return { slotChanges, assignmentChanges };
  }

  function makeCalendarAdjustmentPlan(project) {
    const changeSet = calendarAdjustmentChangeSet(project);
    const plan = Ops.planScheduleBatchChange({ people: project.data.people, roles: project.data.roles, slots: project.data.slots, assignments: project.data.assignments, activities: project.data.activities || [], availability: project.data.availability, rules: project.data.scheduleRules, timeZone: CalendarCore.projectTimeZone(project), changeSet });
    return { plan, changeSet, changeCount: changeSet.slotChanges.length + changeSet.assignmentChanges.length };
  }

  function renderCalendarAdjustmentImpact(project) {
    if (!calendarAdjustmentDraft) return; const result = makeCalendarAdjustmentPlan(project); calendarAdjustmentDraft.lastPlan = result;
    const { plan, changeCount } = result; const impact = $('#calendarAdjustmentImpact'); impact.replaceChildren();
    const cards = [
      ['변경 작업', changeCount],
      ['영향받는 일정', plan.impact.changedSlotIds.length],
      ['영향받는 사람', plan.impact.affectedPersonIds.length],
      ['외부 회의 확인', plan.metadata.artifactImpact.zoom.reviewSlotIds.length]
    ];
    cards.forEach(([label, value]) => { const card = element('div', 'calendar-impact-card'); card.append(element('small', '', label), element('strong', '', String(value))); impact.append(card); });
    const issues = [...plan.blockers.map((item) => ({ ...item, blocking: true })), ...plan.warnings]; const warnings = $('#calendarAdjustmentWarnings'); warnings.replaceChildren();
    issues.forEach((issue) => { const row = element('div', issue.blocking ? 'warning-item blocking' : 'warning-item', `${issue.blocking ? '적용 불가 · ' : '확인 · '}${issue.message}`); warnings.append(row); }); warnings.hidden = issues.length === 0;
    $('#calendarApplyAdjustment').disabled = !plan.canApply || changeCount === 0; $('#calendarApplyAdjustment').textContent = plan.canApply && changeCount ? `${changeCount}개 변경 적용` : changeCount ? '문제를 확인해주세요' : '변경할 내용 없음';
  }

  function renderCalendarAdjustmentAssignments(project) {
    const draft = calendarAdjustmentDraft; if (!draft) return; const scope = calendarAdjustmentScope(project); const container = $('#calendarAdjustmentAssignments'); container.replaceChildren();
    const slotOptions = [...scope].map((slotId) => project.data.slots.find((slot) => slot.id === slotId)).filter(Boolean).sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b)));
    project.data.assignments.filter((assignment) => scope.has(assignment.slotId)).forEach((assignment) => {
      const person = project.data.people.find((item) => item.id === assignment.personId); const origin = project.data.slots.find((item) => item.id === assignment.slotId); const row = element('div', 'calendar-adjustment-row'); row.dataset.calendarAdjustAssignment = assignment.id;
      const copy = element('span'); copy.append(element('strong', '', person?.name || assignment.personName || '이름 없음'), element('small', '', `${calendarDateLabel(origin?.date, { year: false })} ${origin?.startTime || ''} · ${origin?.label || '일정'}`));
      const role = element('select'); role.setAttribute('aria-label', `${person?.name || '사람'} 역할`); role.dataset.calendarAdjustRole = assignment.id; project.data.roles.filter((item) => item.active !== false || item.id === assignment.roleId).forEach((item) => { const option = element('option', '', item.name); option.value = item.id; role.append(option); }); role.value = draft.assignmentRoles[assignment.id] || assignment.roleId;
      const target = element('select'); target.setAttribute('aria-label', `${person?.name || '사람'} 이동할 일정`); target.dataset.calendarAdjustTarget = assignment.id; slotOptions.forEach((slot) => { const option = element('option', '', `${slot.id === assignment.slotId ? '현재 · ' : ''}${slotRangeText(slot)} · ${slot.label || '일정'}`); option.value = slot.id; target.append(option); }); const remove = element('option', '', '일정에서 제외'); remove.value = '__remove__'; target.append(remove); target.value = draft.assignmentTargets[assignment.id] ?? assignment.slotId;
      const locked = Boolean(assignment.locked || origin?.locked); role.disabled = locked; target.disabled = locked; if (locked) copy.append(element('small', '', '잠김'));
      row.append(copy, role, target); container.append(row);
    });
    draft.additions.forEach((addition) => {
      const person = project.data.people.find((item) => item.id === addition.personId); const role = project.data.roles.find((item) => item.id === addition.roleId); const targetSlot = project.data.slots.find((item) => item.id === addition.toSlotId); const row = element('div', 'calendar-adjustment-row');
      const copy = element('span'); copy.append(element('strong', '', person?.name || '이름 없음'), element('small', '', '새로 추가할 배정'));
      const roleLabel = element('span', 'calendar-person-tag', role?.name || '역할 미정'); const target = element('select'); target.dataset.calendarAdjustAdditionTarget = addition.id; slotOptions.forEach((slot) => { const option = element('option', '', `${slotRangeText(slot)} · ${slot.label || '일정'}`); option.value = slot.id; target.append(option); }); const remove = element('option', '', '초안에서 제거'); remove.value = '__remove__'; target.append(remove); target.value = targetSlot?.id || draft.sourceSlotId; row.append(copy, roleLabel, target); container.append(row);
    });
    if (!container.children.length) container.append(element('div', 'list-empty', '선택한 일정에 배정된 사람이 없습니다. 아래에서 사람을 추가할 수 있습니다.'));

    const alreadyIncluded = new Set([...project.data.assignments.filter((item) => scope.has(item.slotId)).map((item) => item.personId), ...draft.additions.map((item) => item.personId)]); const personSelect = $('#calendarAdjustAddPerson'); const previousPerson = personSelect.value; const choosePerson = element('option', '', '사람 선택'); choosePerson.value = ''; personSelect.replaceChildren(choosePerson);
    project.data.people.filter((person) => person.active !== false && !alreadyIncluded.has(person.id)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')).forEach((person) => { const option = element('option', '', `${person.name || '이름 없음'}${person.group ? ` · ${person.group}` : ''}`); option.value = person.id; personSelect.append(option); }); if ([...personSelect.options].some((option) => option.value === previousPerson)) personSelect.value = previousPerson;
    const roleSelect = $('#calendarAdjustAddRole'); const previousRole = roleSelect.value; roleSelect.replaceChildren(); project.data.roles.filter((role) => role.active !== false).forEach((role) => { const option = element('option', '', role.name); option.value = role.id; roleSelect.append(option); }); if ([...roleSelect.options].some((option) => option.value === previousRole)) roleSelect.value = previousRole;
    const targetSelect = $('#calendarAdjustAddTarget'); const previousTarget = targetSelect.value; targetSelect.replaceChildren(); slotOptions.forEach((slot) => { const option = element('option', '', `${slotRangeText(slot)} · ${slot.label || '일정'}`); option.value = slot.id; targetSelect.append(option); }); targetSelect.value = [...targetSelect.options].some((option) => option.value === previousTarget) ? previousTarget : draft.sourceSlotId;
    $('#calendarAdjustAddPersonButton').disabled = personSelect.options.length <= 1 || !roleSelect.options.length || !targetSelect.options.length; renderCalendarAdjustmentImpact(project);
  }

  function renderCalendarRelatedEvents(project) {
    const draft = calendarAdjustmentDraft; const source = project.data.slots.find((slot) => slot.id === draft?.sourceSlotId); if (!source || !draft) return;
    const candidates = CalendarCore.sortSlots(project.data.slots.filter((slot) => slot.id !== source.id && slot.status !== 'cancelled' && !scheduleRowLocked(project, slot.id)), { project });
    const lockedCount = project.data.slots.filter((slot) => slot.id !== source.id && slot.status !== 'cancelled' && scheduleRowLocked(project, slot.id)).length;
    const query = ($('#calendarRelatedSearch')?.value || '').trim().toLocaleLowerCase('ko-KR');
    const visible = candidates.filter((slot) => {
      if (!query) return true;
      const people = calendarSlotAssignments(project, slot.id).flatMap((item) => [item.person.name, item.person.group, item.role?.name]);
      return [slot.label, slot.date, slot.endDate, slot.startTime, slot.endTime, ...people].filter(Boolean).join(' ').toLocaleLowerCase('ko-KR').includes(query);
    });
    const selectedCount = draft.selectedSlotIds.filter((slotId) => slotId !== source.id).length; const summary = $('#calendarRelatedSummary');
    summary.textContent = candidates.length ? `${selectedCount ? `${selectedCount}개 선택 · ` : ''}선택 가능한 다른 일정 ${candidates.length}개${lockedCount ? ` · 잠긴 ${lockedCount}개 제외` : ''}` : `선택 가능한 다른 일정 없음${lockedCount ? ` · 잠긴 ${lockedCount}개 제외` : ''}`;
    const container = $('#calendarRelatedEvents'); container.replaceChildren();
    if (!visible.length) { container.append(element('div', 'list-empty', candidates.length ? '검색 조건에 맞는 일정이 없습니다.' : '함께 조정할 잠금 해제 일정이 없습니다.')); return; }
    visible.forEach((slot) => { const label = element('label', 'calendar-related-event'); const input = element('input'); input.type = 'checkbox'; input.value = slot.id; input.dataset.calendarRelatedEvent = slot.id; input.checked = draft.selectedSlotIds.includes(slot.id); const copy = element('span'); copy.append(element('strong', '', slot.label || '이름 없는 일정'), element('small', '', slotRangeText(slot))); label.append(input, copy); container.append(label); });
  }

  function openCalendarAdjustment() {
    const project = activeProject(); const slot = project?.data.slots.find((item) => item.id === calendarSelectedSlotId); if (!project || !slot) return;
    if (slot.status === 'cancelled') { showToast('취소된 일정은 조정할 수 없습니다.', 'error'); return; }
    if (scheduleRowLocked(project, slot.id)) { showToast(scheduleRowLockMessage(project, slot.id, '일정을 조정'), 'error'); return; }
    calendarAdjustmentDraft = { projectId: project.id, sourceSlotId: slot.id, signature: scheduleChangeSignature(project), selectedSlotIds: [slot.id], assignmentTargets: {}, assignmentRoles: {}, additions: [], lastPlan: null };
    $('#calendarAdjustmentSubtitle').textContent = `${slot.label || '이름 없는 일정'} · ${slotRangeText(slot, { includeYear: true })}`; $('#calendarAdjustDate').value = slot.date; $('#calendarAdjustStart').value = slot.startTime; $('#calendarAdjustEndDate').value = CalendarCore.slotEndDate(slot); $('#calendarAdjustEnd').value = slot.endTime;
    $('#calendarRelatedSearch').value = ''; $('#calendarRelatedPicker').open = false;
    renderCalendarRelatedEvents(project); renderCalendarAdjustmentAssignments(project); openDialog('calendarAdjustmentDialog'); setTimeout(() => $('#calendarAdjustDate').focus());
  }

  function handleCalendarRelatedEvent(slotId, checked) {
    const project = activeProject(); const draft = calendarAdjustmentDraft; if (!project || !draft) return; const selected = new Set(draft.selectedSlotIds); if (checked) selected.add(slotId); else selected.delete(slotId); selected.add(draft.sourceSlotId); draft.selectedSlotIds = [...selected];
    if (!checked) { project.data.assignments.filter((assignment) => assignment.slotId === slotId).forEach((assignment) => { delete draft.assignmentTargets[assignment.id]; delete draft.assignmentRoles[assignment.id]; }); draft.additions.forEach((addition) => { if (addition.toSlotId === slotId) addition.toSlotId = draft.sourceSlotId; }); }
    renderCalendarRelatedEvents(project); renderCalendarAdjustmentAssignments(project);
  }

  function addCalendarAdjustmentPerson() {
    const project = activeProject(); if (!project || !calendarAdjustmentDraft) return; const personId = $('#calendarAdjustAddPerson').value; const roleId = $('#calendarAdjustAddRole').value; const toSlotId = $('#calendarAdjustAddTarget').value; if (!personId || !roleId || !toSlotId) { showToast('추가할 사람·역할·일정을 선택해주세요.', 'error'); return; }
    calendarAdjustmentDraft.additions.push({ id: `assignment-${Date.now().toString(36)}-${calendarAdjustmentDraft.additions.length}`, personId, roleId, toSlotId }); renderCalendarAdjustmentAssignments(project);
  }

  function pruneActivityAssignmentsAfterCalendarChange(project) {
    const activityById = new Map((project.data.activities || []).map((activity) => [activity.id, activity])); const assignmentById = new Map(project.data.assignments.map((assignment) => [assignment.id, assignment]));
    const before = (project.data.activityAssignments || []).length; project.data.activityAssignments = (project.data.activityAssignments || []).filter((link) => {
      const activity = hasStoredId(link.activityId) ? activityById.get(link.activityId) : null; const linkedAssignment = hasStoredId(link.assignmentId) ? assignmentById.get(link.assignmentId) : null;
      if (!activity && !linkedAssignment) return false;
      const slotId = activity ? storedId(activity.eventId, activity.slotId) : linkedAssignment?.slotId;
      if (activity && linkedAssignment && hasStoredId(slotId) && linkedAssignment.slotId !== slotId) return false;
      if (!hasStoredId(slotId)) return Boolean(activity);
      const candidates = project.data.assignments.filter((item) => item.slotId === slotId && (!hasStoredId(link.personId) || item.personId === link.personId));
      const authoritative = linkedAssignment || candidates.find((item) => item.roleId === link.roleId) || (candidates.length === 1 ? candidates[0] : null);
      if (!authoritative) return false;
      link.assignmentId = authoritative.id;
      link.personId = authoritative.personId;
      link.roleId = authoritative.roleId;
      return true;
    });
    return before - project.data.activityAssignments.length;
  }

  async function applyCalendarAdjustment(event, { guideSimulation = false } = {}) {
    event.preventDefault(); let project = activeProject(); const draft = calendarAdjustmentDraft; if (!project || !draft) return false; const latest = guideSimulation ? project : latestKnownProject(draft.projectId);
    if (!latest || scheduleChangeSignature(latest) !== draft.signature || scheduleChangeSignature(project) !== draft.signature) { closeDialog('calendarAdjustmentDialog'); calendarAdjustmentDraft = null; showToast('미리보는 동안 다른 창에서 일정이 바뀌었습니다. 최신 내용을 반영했으니 다시 조정해주세요.', 'error'); applyDeferredWorkspaceState(); renderAll(); return false; }
    const newlyLockedSlotId = [...calendarAdjustmentScope(project)].find((slotId) => scheduleRowLocked(project, slotId)); if (newlyLockedSlotId) { closeDialog('calendarAdjustmentDialog'); calendarAdjustmentDraft = null; showToast(scheduleRowLockMessage(project, newlyLockedSlotId, '일정을 조정'), 'error'); renderProjectCalendarPage(); return false; }
    const result = makeCalendarAdjustmentPlan(project); if (!result.changeCount) { showToast('변경할 내용을 선택해주세요.'); return false; } if (!result.plan.canApply) { renderCalendarAdjustmentImpact(project); showToast('충돌이나 잠금 문제를 먼저 확인해주세요.', 'error'); return false; }
    const before = scheduleSnapshot(project); const nextAssignmentIds = new Set(result.plan.nextAssignments.map((assignment) => assignment.id)); const removedAssignmentIds = new Set(project.data.assignments.filter((assignment) => !nextAssignmentIds.has(assignment.id)).map((assignment) => assignment.id)); pushScheduleHistory(project); project.data.slots = result.plan.nextSlots; project.data.assignments = result.plan.nextAssignments; const removedActivityLinks = removeActivityAssignmentLinks(project, { assignmentIds: removedAssignmentIds }) + pruneActivityAssignmentsAfterCalendarChange(project); refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, before); syncScheduleProjectState(project, `캘린더에서 ${result.changeCount}개 변경 · 문제 ${project.data.conflicts.length}건`, impact); state = Core.setModuleStatus(state, project.id, 'projectCalendar', project.data.conflicts.length ? 'needsReview' : 'inProgress', `${impact.changedSlotIds.length}개 일정 조정${removedActivityLinks ? ` · 진행 담당 ${removedActivityLinks}건 재확인` : ''}`);
    const moved = project.data.slots.find((slot) => slot.id === draft.sourceSlotId); if (moved) calendarAnchorDate = calendarView === 'month' ? `${moved.date.slice(0, 7)}-01` : moved.date; closeDialog('calendarAdjustmentDialog'); calendarAdjustmentDraft = null; await persist('프로젝트 캘린더 일정 조정됨'); renderAll(); selectCalendarEvent(draft.sourceSlotId); if (!guideSimulation) showToast(`${impact.changedSlotIds.length}개 일정을 한 번에 반영했습니다.`, 'success'); return true;
  }

  async function cancelCalendarEvent() {
    let project = activeProject(); let slot = project?.data.slots.find((item) => item.id === calendarSelectedSlotId); if (!project || !slot || scheduleRowLocked(project, slot.id) || slot.status === 'cancelled') return; const projectId = project.id; const slotId = slot.id; const signature = scheduleChangeSignature(project); const affected = calendarSlotAssignments(project, slot.id); const hasConference = project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status !== 'superseded');
    if (!await showConfirm(`${slotRangeText(slot, { includeYear: true })} “${slot.label || '일정'}”을 취소할까요?\n\n배정 인원 ${affected.length}명은 미배정으로 전환되고${hasConference ? ' · 연결된 외부 회의는 정리 필요 상태로 표시되며' : ''} 안내 메일도 다시 확인 대상으로 표시됩니다.`, { title: '일정 취소', action: '일정 취소' })) return;
    project = projectById(projectId); slot = project?.data.slots.find((item) => item.id === slotId); if (!project || !slot || scheduleChangeSignature(project) !== signature || scheduleRowLocked(project, slot.id)) { showToast('확인하는 동안 일정이 바뀌었습니다. 다시 시도해주세요.', 'error'); return; }
    const before = scheduleSnapshot(project); const removedAssignmentIds = new Set(project.data.assignments.filter((item) => item.slotId === slotId).map((item) => item.id)); pushScheduleHistory(project); slot.status = 'cancelled'; project.data.assignments = project.data.assignments.filter((item) => item.slotId !== slotId); removeActivityAssignmentLinks(project, { assignmentIds: removedAssignmentIds }); pruneActivityAssignmentsAfterCalendarChange(project); refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, before); syncScheduleProjectState(project, `일정 취소 · ${affected.length}명 미배정`, impact); state = Core.setModuleStatus(state, project.id, 'projectCalendar', 'needsReview', `${slot.label || '일정'} 취소 후 재배치 필요`); closeCalendarDetail({ restoreFocus: false }); await persist('프로젝트 캘린더 일정 취소됨'); renderAll(); showToast('일정을 취소하고 영향 항목을 확인 필요 상태로 표시했습니다.', 'success');
  }

  async function duplicateCalendarEvent() {
    const project = activeProject(); const slot = project?.data.slots.find((item) => item.id === calendarSelectedSlotId); if (!project || !slot) return; const before = scheduleSnapshot(project); pushScheduleHistory(project); const stamp = Date.now().toString(36); const nextId = `slot-${stamp}`; const copy = { ...cloneState(slot), id: nextId, label: `${slot.label || '일정'} 복사본`, status: 'draft', locked: false, zoomConnectionId: null }; project.data.slots.push(copy); if (project.data.scheduleCustomValues?.[slot.id]) project.data.scheduleCustomValues[nextId] = cloneState(project.data.scheduleCustomValues[slot.id]);
    (project.data.activities || []).filter((activity) => storedId(activity.eventId, activity.slotId) === slot.id).forEach((activity, index) => { const id = `activity-${stamp}-${index}`; project.data.activities.push({ ...cloneState(activity), id, eventId: nextId, slotId: undefined, locked: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
    refreshScheduleConflicts(project); const impact = applyScheduleMutationImpact(project, before); syncScheduleProjectState(project, '캘린더 일정 복제', impact); state = Core.setModuleStatus(state, project.id, 'projectCalendar', 'inProgress', '복제한 일정의 시간·인원 확인 필요'); calendarSelectedSlotId = nextId; await persist('프로젝트 캘린더 일정 복제됨'); renderProjectCalendarPage(); selectCalendarEvent(nextId); showToast('진행 내용만 복제했습니다. 시간과 사람 배치를 확인해주세요.', 'success');
  }

  function addCalendarEvent(date = '', endDate = date) {
    const project = activeProject(); if (!project) return; const targetDate = CalendarCore.isValidDateKey(date) ? date : CalendarCore.dateKeyInTimeZone(new Date(), CalendarCore.projectTimeZone(project)); const targetEndDate = CalendarCore.isValidDateKey(endDate) ? endDate : targetDate;
    openCalendarEventEditor({ startDate: targetDate, endDate: targetEndDate, sourcePage: currentPage });
  }

  function scheduleHeaderKey(value, project) {
    const text = String(value || '').trim(); const normalized = text.toLowerCase().replace(/[\s_.·-]/g, '');
    const aliases = {
      날짜: 'date', date: 'date', 일자: 'date', 시작날짜: 'date', startdate: 'date', 종료날짜: 'endDate', 종료일: 'endDate', 마지막날짜: 'endDate', enddate: 'endDate',
      시작: 'startTime', 시작시간: 'startTime', start: 'startTime', starttime: 'startTime',
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
    const usedKeys = new Set(); let dateCount = 0; let timeCount = 0;
    return Array.from({ length: width }, (_, index) => {
      const header = String(headers[index] || `컬럼${index + 1}`).trim() || `컬럼${index + 1}`; let key = scheduleHeaderKey(header, project);
      if (!key && !hasHeader) {
        const values = rows.map((row) => String(row[index] || '').trim()).filter(Boolean); const dateMatches = values.filter((value) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value)).length; const timeMatches = values.filter((value) => /^\d{1,2}:\d{2}$/.test(value)).length;
        if (values.length && dateMatches >= Math.ceil(values.length * .7)) { dateCount += 1; key = dateCount === 1 ? 'date' : dateCount === 2 ? 'endDate' : ''; }
        else if (values.length && timeMatches >= Math.ceil(values.length * .7)) { timeCount += 1; key = timeCount === 1 ? 'startTime' : timeCount === 2 ? 'endTime' : ''; }
      }
      if (key && usedKeys.has(key)) key = ''; if (key) usedKeys.add(key);
      const roleId = key?.startsWith('role:') ? key.slice(5) : null;
      return { id: `schedule-column-${Date.now().toString(36)}-${index}`, key: key || `custom:import-${Date.now().toString(36)}-${index}`, name: hasHeader ? header : ({ date: '날짜', endDate: '종료 날짜', startTime: '시작', endTime: '종료' })[key] || header, kind: roleId ? 'role' : key ? 'system' : 'custom', roleId };
    });
  }

  async function importScheduleMatrix(matrix, mode = 'replace') {
    let project = activeProject(); if (!project || !matrix?.length) return; const projectId = project.id; const confirmationSnapshot = scheduleSnapshot(project);
    const hasHeader = looksLikeScheduleHeader(matrix); const importedColumns = inferredScheduleColumns(matrix, project, hasHeader);
    const hasRecoverableSchedule = () => Boolean(project.data.slots.length || project.data.activities?.length || project.data.assignments.length || project.data.activityAssignments?.length);
    if (mode === 'replace' && hasLockedSchedule(project)) { showToast('잠긴 세션 또는 배정이 있습니다. 잠금을 해제한 뒤 일정표를 교체해주세요.', 'error'); return; }
    if (mode === 'replace' && hasRecoverableSchedule()) {
      if (!await showConfirm('현재 일정표를 Excel 시트 내용으로 교체할까요?\n\n교체 직전의 일정·인원 배치·진행 내용·진행 담당 연결은 “Excel 교체 전 자동 백업” 일정 버전으로 저장합니다. 필요하면 일정 출력의 저장된 버전에서 그대로 되돌릴 수 있습니다.\n\nExcel 행에는 앱 내부 연결 ID가 없으므로 가져온 새 일정에 기존 진행 내용이 자동으로 재연결되지는 않습니다.', { title: '백업 후 일정표 교체', action: '백업 후 교체' })) return;
      const currentProject = activeProject();
      if (!currentProject || currentProject.id !== projectId || scheduleSnapshot(currentProject) !== confirmationSnapshot) { showToast('확인하는 동안 일정이 바뀌었습니다. 최신 일정을 확인한 뒤 다시 가져와주세요.', 'error'); renderSchedulePage(); return; }
      project = currentProject;
      if (hasLockedSchedule(project)) { showToast('새로 잠긴 세션 또는 배정이 있어 일정표 교체를 중단했습니다.', 'error'); return; }
    }
    const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project));
    pushScheduleHistory(project);
    let recoveryVersion = null;
    if (mode === 'replace') {
      if (hasRecoverableSchedule()) {
        recoveryVersion = createScheduleVersion(project, `Excel 교체 전 자동 백업 ${project.data.versions.length + 1}`);
        project.data.versions.push(recoveryVersion);
      }
      project.data.slots = []; project.data.activities = []; project.data.assignments = []; project.data.activityAssignments = []; project.data.conflicts = []; project.data.scheduleCustomValues = {}; project.data.scheduleSheetColumns = importedColumns; project.data.scheduleSheetInitialized = true;
    }
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
    showToast(`${importedColumns.length}열 × ${rows.length}행을 자동 감지해 일정표에 가져왔습니다.${recoveryVersion ? ` 이전 일정은 “${recoveryVersion.name}”으로 보관했습니다.` : ''}`, project.data.conflicts.length ? 'normal' : 'success');
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
      person.roleIds = Ops.normalizePersonRoleIds(person.roleIds, project.data.roles);
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
    const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); pushScheduleHistory(project); const ids = new Set(targets.map((slot) => slot.id)); const removedAssignmentIds = new Set(project.data.assignments.filter((item) => ids.has(item.slotId)).map((item) => item.id)); project.data.slots = project.data.slots.filter((slot) => !ids.has(slot.id)); project.data.assignments = project.data.assignments.filter((item) => !ids.has(item.slotId)); removeCalendarDataForSlots(project, ids, removedAssignmentIds);
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

  function formsSurfaceSnapshot(workspaceState, project) {
    return JSON.stringify({
      projectId: project?.id || '',
      forms: project?.data?.forms || null,
      templates: workspaceState?.library?.formTemplates || [],
      connections: (workspaceState?.connections || []).filter((item) => item.type === 'forms').map((item) => [item.id, item.status, item.account, item.label, item.updatedAt]),
      globalDefaultConnectionId: workspaceState?.preferences?.globalDefaultConnectionIds?.forms || null,
      projectDefaultConnectionId: project?.settings?.defaultConnectionIds?.forms || null
    });
  }

  const FORM_ITEM_LABELS = {
    shortText: '단답형', paragraph: '장문형', radio: '객관식 질문', checkbox: '체크박스', dropdown: '드롭다운',
    scale: '선형 배율', date: '날짜', time: '시간', rating: '평점', radioGrid: '객관식 그리드', checkboxGrid: '체크박스 그리드',
    section: '섹션', textBlock: '제목 및 설명', image: '이미지', video: '동영상', fileUpload: '파일 업로드', unknown: '지원되지 않는 항목'
  };
  const FORM_CHOICE_KINDS = new Set(['radio', 'checkbox', 'dropdown', 'radioGrid', 'checkboxGrid']);
  const FORM_QUESTION_KINDS = new Set(['shortText', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'date', 'time', 'rating', 'radioGrid', 'checkboxGrid', 'fileUpload', 'unknown']);
  const FORM_GRADABLE_KINDS = new Set(['shortText', 'radio', 'checkbox', 'dropdown']);

  function fallbackFormItem(kind = 'shortText', overrides = {}) {
    const item = {
      id: `form-item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      title: kind === 'section' ? '새 섹션' : kind === 'textBlock' ? '제목' : kind === 'image' ? '이미지' : kind === 'video' ? '동영상' : '제목 없는 질문',
      description: '',
      required: false,
      ...overrides
    };
    if (FORM_CHOICE_KINDS.has(kind)) item.options ||= [{ id: `option-${Date.now().toString(36)}`, value: '옵션 1' }];
    if (kind === 'scale') Object.assign(item, { low: 1, high: 5, lowLabel: '', highLabel: '', ...overrides });
    if (kind === 'date') Object.assign(item, { includeYear: true, includeTime: false, ...overrides });
    if (kind === 'time') Object.assign(item, { duration: false, ...overrides });
    if (kind === 'rating') Object.assign(item, { ratingScaleLevel: 5, ratingIconType: 'STAR', ...overrides });
    if (['radioGrid', 'checkboxGrid'].includes(kind)) item.rows ||= [{ id: `row-${Date.now().toString(36)}`, title: '행 1', required: false }];
    if (kind === 'image') item.image ||= { sourceUri: '', altText: '', alignment: 'LEFT', width: 480 };
    if (kind === 'video') Object.assign(item, { youtubeUri: '', caption: '', alignment: 'LEFT', width: 480, ...overrides });
    return item;
  }

  function createFormItem(kind = 'shortText', overrides = {}) {
    return Ops.createGoogleFormItem ? Ops.createGoogleFormItem(kind, overrides) : fallbackFormItem(kind, overrides);
  }

  const FORM_SIMPLE_CHOICE_KINDS = new Set(['radio', 'checkbox', 'dropdown']);
  const FORM_GRID_KINDS = new Set(['radioGrid', 'checkboxGrid']);
  const FORM_QUESTION_IMAGE_KINDS = new Set(['shortText', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'date', 'time', 'rating', 'radioGrid', 'checkboxGrid']);

  function formTypeChangeLosses(item, nextKind) {
    if (!item || item.kind === nextKind) return [];
    const losses = [];
    const keepsSimpleChoices = FORM_SIMPLE_CHOICE_KINDS.has(item.kind) && FORM_SIMPLE_CHOICE_KINDS.has(nextKind);
    const keepsGrid = FORM_GRID_KINDS.has(item.kind) && FORM_GRID_KINDS.has(nextKind);
    if (FORM_SIMPLE_CHOICE_KINDS.has(item.kind) && !keepsSimpleChoices) losses.push('선택지와 선택지 순서 설정');
    if (FORM_GRID_KINDS.has(item.kind) && !keepsGrid) losses.push('그리드의 행·열과 행별 필수 설정');
    const keepsGrading = item.kind === nextKind || (FORM_SIMPLE_CHOICE_KINDS.has(item.kind) && FORM_SIMPLE_CHOICE_KINDS.has(nextKind));
    if (item.grading && !keepsGrading) losses.push('정답·배점·피드백');
    if (item.kind === 'scale' && nextKind !== 'scale') losses.push('배율 범위와 양끝 설명');
    if (item.kind === 'date' && nextKind !== 'date') losses.push('연도·시간 포함 설정');
    if (item.kind === 'time' && nextKind !== 'time') losses.push('기간 입력 설정');
    if (item.kind === 'rating' && nextKind !== 'rating') losses.push('평점 단계와 모양');
    if (item.kind === 'image' && nextKind !== 'image') losses.push('이미지 주소와 표시 설정');
    if (item.kind === 'video' && nextKind !== 'video') losses.push('동영상 주소와 표시 설정');
    if (item.questionImage && !FORM_QUESTION_IMAGE_KINDS.has(nextKind)) losses.push('질문 이미지');
    return [...new Set(losses)];
  }

  function changeFormItemKind(item, nextKind) {
    const common = {
      id: item.id,
      title: item.title,
      description: item.description,
      required: Boolean(item.required),
      key: item.key,
      sourceBinding: item.sourceBinding ? cloneState(item.sourceBinding) : undefined
    };
    if (item.questionImage && FORM_QUESTION_IMAGE_KINDS.has(nextKind)) common.questionImage = cloneState(item.questionImage);
    if (FORM_SIMPLE_CHOICE_KINDS.has(item.kind) && FORM_SIMPLE_CHOICE_KINDS.has(nextKind)) Object.assign(common, { options: cloneState(item.options || []), shuffle: Boolean(item.shuffle) });
    if (FORM_GRID_KINDS.has(item.kind) && FORM_GRID_KINDS.has(nextKind)) Object.assign(common, { rows: cloneState(item.rows || []), options: cloneState(item.options || []), shuffleRows: Boolean(item.shuffleRows) });
    if (item.grading && (item.kind === nextKind || (FORM_SIMPLE_CHOICE_KINDS.has(item.kind) && FORM_SIMPLE_CHOICE_KINDS.has(nextKind)))) common.grading = cloneState(item.grading);
    return createFormItem(nextKind, common);
  }

  function normalizeFormDefinition(definition, project) {
    if (Ops.normalizeGoogleFormDefinition) return Ops.normalizeGoogleFormDefinition(definition, { projectName: project?.name || '' });
    const source = cloneState(definition || {});
    const items = Array.isArray(source.items) ? source.items : Array.isArray(source.questions) ? source.questions.map((item) => createFormItem(item.kind === 'text' ? 'shortText' : item.kind, item)) : [];
    return {
      id: source.id || `form-definition-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      schemaVersion: 2,
      type: source.type || 'custom',
      title: source.title || `${project?.name || ''} 설문`.trim(),
      description: source.description || '',
      collectEmail: source.collectEmail || source.settings?.emailCollectionType || 'DO_NOT_COLLECT',
      settings: { ...(source.settings || {}), emailCollectionType: source.collectEmail || source.settings?.emailCollectionType || 'DO_NOT_COLLECT', isQuiz: Boolean(source.settings?.isQuiz) },
      items,
      createdAt: source.createdAt || new Date().toISOString(),
      updatedAt: source.updatedAt || new Date().toISOString()
    };
  }

  function newBlankFormDefinition(project) {
    return Ops.createBlankGoogleFormDefinition
      ? Ops.createBlankGoogleFormDefinition(project || '새 설문')
      : normalizeFormDefinition({ title: `${project?.name || '새'} 설문`, items: [createFormItem('shortText')] }, project);
  }

  function newSemanticFormDefinition(project, type) {
    if (!['registration', 'availability'].includes(type) || !Ops.buildGoogleFormDefinition) return newBlankFormDefinition(project);
    return normalizeFormDefinition(Ops.buildGoogleFormDefinition(project, type), project);
  }

  function formDefinitionIsPristineBlank(definition, project) {
    const items = definition?.items || [];
    return definition?.type === 'custom' && !definition.formId && definition.source !== 'google'
      && definition.title === `${project?.name || ''} 설문`.trim() && !String(definition.description || '').trim()
      && String(definition.settings?.emailCollectionType || definition.collectEmail || 'DO_NOT_COLLECT') === 'DO_NOT_COLLECT'
      && definition.settings?.isQuiz !== true && items.length === 1 && items[0].kind === 'shortText'
      && items[0].title === '질문' && !String(items[0].description || '').trim() && items[0].required !== true;
  }

  function semanticFormDefinitionIssue(definition, project) {
    if (!definition || !['registration', 'availability'].includes(definition.type)) return '';
    const items = Array.isArray(definition.items) ? definition.items : [];
    const byKey = (key) => items.filter((item) => item.key === key || (key === 'slots' && item.sourceBinding?.type === 'projectSlots'));
    const names = byKey('name');
    if (names.length !== 1 || names[0].kind !== 'shortText' || names[0].required !== true) return '명단과 안전하게 연결하려면 필수 단답형 “성함” 질문을 하나 유지해주세요.';
    if (definition.type === 'registration') {
      const phones = byKey('phone').filter((item) => item.kind === 'shortText');
      const emails = byKey('email').filter((item) => item.kind === 'shortText');
      const emailMode = String(definition.settings?.emailCollectionType || definition.collectEmail || '').toUpperCase();
      if (!phones.length && !emails.length && !['VERIFIED', 'RESPONDER_INPUT'].includes(emailMode)) return '신청자를 구분할 휴대폰 단답형 질문이나 Google 이메일 수집을 유지해주세요.';
      return '';
    }
    const slots = byKey('slots');
    if (slots.length !== 1 || slots[0].kind !== 'checkbox' || slots[0].required !== true) return '가능 시간 연동을 유지하려면 필수 체크박스 일정 질문을 하나 유지해주세요.';
    if (!project?.data?.slots?.some((slot) => slot.status !== 'cancelled')) return '가능 시간 설문을 만들려면 프로젝트 일정을 먼저 추가해주세요.';
    const scheduleReadiness = Ops.availabilityFormScheduleReadiness?.(project);
    if (scheduleReadiness && !scheduleReadiness.ready) return `가능 시간 설문을 만들기 전에 일정을 확인해주세요. ${scheduleReadiness.blockers[0]?.message || '프로젝트 날짜·시간을 확인해주세요.'}`;
    const projectFingerprint = Ops.projectAvailabilitySlotFingerprint?.(project) || '';
    const draftFingerprint = Ops.googleFormAvailabilitySlotFingerprint?.(definition) || '';
    if (!projectFingerprint || projectFingerprint !== draftFingerprint) return '가능 시간 선택지가 현재 프로젝트 일정과 다릅니다. 현재 일정으로 새 초안을 만들어주세요.';
    return '';
  }

  function formDefinitionShapeIsSafe(definition) {
    if (!definition || Number(definition.schemaVersion) < 2 || !Array.isArray(definition.items) || !definition.settings || typeof definition.settings !== 'object' || Array.isArray(definition.settings)) return false;
    const itemIds = new Set();
    return definition.items.every((item) => {
      const itemId = String(item?.id || '').trim();
      if (!item || typeof item !== 'object' || Array.isArray(item) || !itemId || !Object.prototype.hasOwnProperty.call(FORM_ITEM_LABELS, item.kind) || itemIds.has(itemId)) return false;
      itemIds.add(itemId);
      if (FORM_CHOICE_KINDS.has(item.kind) && !Array.isArray(item.options)) return false;
      if (FORM_GRID_KINDS.has(item.kind) && !Array.isArray(item.rows)) return false;
      for (const key of ['options', 'rows']) {
        if (item[key] == null) continue;
        if (!Array.isArray(item[key])) return false;
        const entryIds = new Set();
        if (!item[key].every((entry) => {
          const entryId = String(entry?.id || '').trim();
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entryId || entryIds.has(entryId)) return false;
          entryIds.add(entryId); return true;
        })) return false;
      }
      if (item.grading != null && (typeof item.grading !== 'object' || Array.isArray(item.grading) || !Array.isArray(item.grading.correctAnswers))) return false;
      for (const media of [item.image, item.questionImage]) if (media != null && (typeof media !== 'object' || Array.isArray(media))) return false;
      return true;
    });
  }

  function activeFormDefinition(project, { create = true } = {}) {
    if (!project) return null;
    project.data.forms ||= { definitions: [], linkedForms: [], activeDefinitionId: null, selectedFormId: null };
    project.data.forms.definitions ||= [];
    let definition = project.data.forms.definitions.find((item) => item.id === project.data.forms.activeDefinitionId) || project.data.forms.definitions.at(-1) || null;
    if (!definition && create) {
      definition = newBlankFormDefinition(project);
      project.data.forms.definitions.push(definition);
      project.data.forms.activeDefinitionId = definition.id;
      state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } });
      return projectById(project.id)?.data.forms.definitions.find((item) => item.id === definition.id) || definition;
    }
    if (!definition) return null;
    const normalized = formDefinitionShapeIsSafe(definition)
      ? definition
      : normalizeFormDefinition(definition, project);
    const index = project.data.forms.definitions.findIndex((item) => item.id === definition.id);
    if (index >= 0) project.data.forms.definitions[index] = normalized;
    project.data.forms.activeDefinitionId = normalized.id;
    return normalized;
  }

  function formDefinitionSignature(definition) {
    return JSON.stringify(definition || null);
  }

  function formStructureScope(project, definition) {
    return project && definition ? `${project.id}\u0000${definition.id}` : '';
  }

  function syncFormStructureUndo() {
    const project = activeProject(); const definition = activeFormDefinition(project, { create: false });
    if ($('#undoFormStructure')) $('#undoFormStructure').disabled = !definition || formStructureHistoryScope !== formStructureScope(project, definition) || !formStructureHistory.length;
  }

  function clearFormStructureHistory() {
    formStructureHistory = []; formStructureHistoryScope = ''; formStructureHistoryPending = false;
    if ($('#undoFormStructure')) $('#undoFormStructure').disabled = true;
  }

  function rememberFormStructure() {
    const project = activeProject(); const definition = activeFormDefinition(project, { create: false }); if (!project || !definition) return false;
    const scope = formStructureScope(project, definition);
    if (formStructureHistoryScope !== scope) { formStructureHistory = []; formStructureHistoryScope = scope; }
    formStructureHistory.push({ snapshot: cloneState(definition), expectedSignature: '' }); if (formStructureHistory.length > 30) formStructureHistory.shift();
    formStructureHistoryPending = true;
    syncFormStructureUndo(); return true;
  }

  function undoFormStructureChange() {
    const project = activeProject(); const definition = activeFormDefinition(project, { create: false }); const scope = formStructureScope(project, definition);
    if (!project || !definition || scope !== formStructureHistoryScope || !formStructureHistory.length) return false;
    const entry = formStructureHistory.at(-1);
    if (!entry.expectedSignature || formDefinitionSignature(definition) !== entry.expectedSignature) { clearFormStructureHistory(); return false; }
    formStructureHistory.pop(); const restored = entry.snapshot; restored.updatedAt = new Date().toISOString();
    if (formStructureHistory.length) formStructureHistory.at(-1).expectedSignature = formDefinitionSignature(restored);
    const index = project.data.forms.definitions.findIndex((item) => item.id === definition.id); if (index < 0) return false;
    project.data.forms.definitions[index] = restored; project.data.forms.activeDefinitionId = restored.id;
    state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } }); markFormEditorDirty(project.id, '설문 구성 실행 취소됨');
    renderFormEditor(restored); updateFormCreationReadiness(restored); syncFormStructureUndo(); return true;
  }

  function confirmedFormDraft(projectId, definitionId, signature = '') {
    const project = projectById(projectId);
    const definition = project?.data.forms?.definitions?.find((item) => item.id === definitionId);
    if (!project || !definition || activeProject()?.id !== projectId || project.data.forms.activeDefinitionId !== definitionId) return null;
    if (signature && formDefinitionSignature(definition) !== signature) return null;
    return { project, definition };
  }

  function freshFormDefinition(source, project, { preserveSemantics = false, semanticType = '', semanticQuestionIds = {} } = {}) {
    const definition = normalizeFormDefinition(cloneState(source), project);
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    definition.id = `form-definition-${stamp}`;
    definition.type = preserveSemantics && ['registration', 'availability'].includes(semanticType || definition.type) ? (semanticType || definition.type) : 'custom';
    delete definition.formId; delete definition.revisionId; delete definition.responderUri; delete definition.editUri; delete definition.documentTitle; delete definition.publishSettings;
    definition.source = 'workspace';
    definition.createdAt = new Date().toISOString(); definition.updatedAt = definition.createdAt;
    const semanticKeyByQuestionId = new Map();
    Object.entries(semanticQuestionIds || {}).forEach(([key, questionId]) => { if (questionId) semanticKeyByQuestionId.set(String(questionId), key); });
    ['name', 'phone', 'email', 'group', 'participantId', 'slots', 'notes'].forEach((key) => {
      const questionId = semanticQuestionIds?.[key]; if (questionId) semanticKeyByQuestionId.set(String(questionId), key);
    });
    definition.items = (definition.items || []).map((item, index) => {
      const copy = cloneState(item); copy.id = `form-item-${stamp}-${index}`;
      if (preserveSemantics && !copy.key && semanticKeyByQuestionId.has(String(copy.questionId || ''))) copy.key = semanticKeyByQuestionId.get(String(copy.questionId));
      delete copy.googleItemId; delete copy.questionId;
      const projectSlotBinding = copy.sourceBinding?.type === 'projectSlots' || (definition.type === 'availability' && copy.key === 'slots');
      if (!preserveSemantics) { delete copy.key; delete copy.sourceBinding; }
      else if (projectSlotBinding) copy.sourceBinding = { type: 'projectSlots' };
      if (!['fileUpload', 'unknown'].includes(copy.kind)) { delete copy.readOnly; delete copy.unsupportedReason; }
      copy.options = (copy.options || []).map((option, optionIndex) => {
        const next = { ...option, id: `form-option-${stamp}-${index}-${optionIndex}` };
        if (!preserveSemantics) { delete next.slotId; if (projectSlotBinding) next.value = String(next.value || '').replace(/^\[[^\]]+\]\s*/, ''); }
        else if (projectSlotBinding && !next.slotId) next.slotId = String(next.value || '').match(/^\[([^\]]+)\]/)?.[1] || '';
        return next;
      });
      copy.rows = (copy.rows || []).map((row, rowIndex) => { const next = { ...row, id: `form-row-${stamp}-${index}-${rowIndex}` }; delete next.questionId; return next; });
      return copy;
    });
    return definition;
  }

  function refreshedAvailabilityFormDefinition(source, project, semanticQuestionIds = {}) {
    const definition = freshFormDefinition(source, project, {
      preserveSemantics: true,
      semanticType: 'availability',
      semanticQuestionIds
    });
    const generated = Ops.buildGoogleFormDefinition?.(project, 'availability');
    const generatedSlots = generated?.items?.find((item) => item.key === 'slots' || item.sourceBinding?.type === 'projectSlots');
    const slotsIndex = definition.items.findIndex((item) => item.key === 'slots' || item.sourceBinding?.type === 'projectSlots');
    if (!generatedSlots || slotsIndex < 0) return null;
    const slotsItem = definition.items[slotsIndex];
    slotsItem.options = (generatedSlots.options || []).map((option, optionIndex) => ({
      ...cloneState(option),
      id: `${slotsItem.id}-slot-option-${optionIndex + 1}`
    }));
    slotsItem.key = 'slots';
    slotsItem.sourceBinding = { type: 'projectSlots' };
    definition.updatedAt = new Date().toISOString();
    return definition;
  }

  function duplicateFormItem(item) {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const copy = cloneState(item);
    copy.id = `form-item-${stamp}`;
    delete copy.key; delete copy.sourceBinding; delete copy.googleItemId; delete copy.questionId; delete copy.readOnly; delete copy.unsupportedReason;
    copy.options = (copy.options || []).map((option, index) => { const next = { ...option, id: `form-option-${stamp}-${index}` }; delete next.slotId; return next; });
    copy.rows = (copy.rows || []).map((row, index) => { const next = { ...row, id: `form-row-${stamp}-${index}` }; delete next.questionId; return next; });
    return copy;
  }

  function mutateActiveFormDefinition(mutator, message = '설문 편집 자동 저장됨') {
    const project = activeProject(); if (!project) return null;
    const definition = activeFormDefinition(project); if (!definition) return null;
    mutator(definition, project);
    definition.updatedAt = new Date().toISOString();
    const index = project.data.forms.definitions.findIndex((item) => item.id === definition.id);
    if (index >= 0) project.data.forms.definitions[index] = definition;
    project.data.forms.activeDefinitionId = definition.id;
    state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } });
    const scope = formStructureScope(project, definition);
    if (formStructureHistoryPending && formStructureHistoryScope === scope && formStructureHistory.length) {
      formStructureHistory.at(-1).expectedSignature = formDefinitionSignature(definition); formStructureHistoryPending = false;
    } else if (formStructureHistoryScope === scope && formStructureHistory.length) clearFormStructureHistory();
    markFormEditorDirty(project.id, message);
    updateFormCreationReadiness(definition);
    return projectById(project.id)?.data.forms.definitions.find((item) => item.id === definition.id) || definition;
  }

  function updateFormCreationReadiness(definition) {
    if (!definition || !$('#createGoogleForm')) return [];
    const unsupported = Ops.googleFormUnsupportedItems ? Ops.googleFormUnsupportedItems(definition) : (definition.items || []).filter((item) => item.readOnly || ['fileUpload', 'unknown'].includes(item.kind));
    const semanticIssue = semanticFormDefinitionIssue(definition, activeProject());
    $('#createGoogleForm').disabled = !definition.title?.trim() || Boolean(unsupported.length) || Boolean(semanticIssue);
    if (!formEditorDirty && !pendingMergedFormsRender && !formsMergeRefreshPromise && $('#formEditorStatus')) $('#formEditorStatus').textContent = semanticIssue || (unsupported.length ? `${unsupported[0].title || '항목'}: ${unsupported[0].reason || unsupported[0].unsupportedReason || 'Google Forms에서 확인 필요'}${unsupported.length > 1 ? ` · 외 ${unsupported.length - 1}개` : ''}` : '이 PC와 Workspace에 자동 저장됨');
    return unsupported;
  }

  function markFormEditorDirty(projectId, message = '설문 편집 자동 저장됨') {
    formEditorDirty = true; formEditorProjectId = projectId;
    if ($('#formEditorStatus')) $('#formEditorStatus').textContent = '변경사항 저장 중…';
    clearTimeout(formDraftTimer);
    formDraftTimer = setTimeout(() => { void saveFormEditorDraft(projectId, message).catch(() => {}); }, 650);
  }

  async function saveFormEditorDraft(projectId = formEditorProjectId, message = '설문 편집 자동 저장됨') {
    clearTimeout(formDraftTimer); formDraftTimer = null;
    if (!formEditorDirty || !projectId) return;
    const project = projectById(projectId); if (!project) { formEditorDirty = false; return; }
    formEditorDirty = false;
    try {
      await persist(message);
      if (activeProject()?.id === projectId) updateFormCreationReadiness(activeFormDefinition(projectById(projectId)));
    } catch (error) {
      formEditorDirty = true;
      if ($('#formEditorStatus')) $('#formEditorStatus').textContent = '저장하지 못함 · 다시 시도 필요';
      throw error;
    } finally { applyDeferredWorkspaceState(); }
  }

  async function ensureFormDraftSaved(actionLabel = '다음 작업') {
    if (!formEditorDirty) return true;
    try {
      await saveFormEditorDraft();
      return true;
    } catch (error) {
      showToast(`설문 변경사항을 저장하지 못해 ${actionLabel}을(를) 중단했습니다. 다시 저장한 뒤 시도해주세요.${error?.message ? ` · ${error.message}` : ''}`, 'error');
      return false;
    }
  }

  function formField(label, control, className = 'form-field') {
    const field = element('label', className); field.append(element('span', '', label), control); return field;
  }

  function editorControl(tag, value, field, label, { type = '', itemId = '', min = '', max = '', rows = 0 } = {}) {
    const control = document.createElement(tag); control.value = value ?? ''; control.dataset.formEditorInput = 'true';
    if (field) control.dataset.formItemField = field;
    if (itemId) control.dataset.formItemId = itemId;
    if (type) control.type = type;
    if (min !== '') control.min = String(min); if (max !== '') control.max = String(max); if (rows) control.rows = rows;
    control.setAttribute('aria-label', label); return control;
  }

  function appendFormOptionsEditor(parent, item, { rows = false } = {}) {
    const key = rows ? 'rows' : 'options'; const values = item[key] || [];
    const wrapper = element('div', rows ? 'form-option-list form-grid-editor' : 'form-option-list');
    wrapper.append(element('small', 'form-subfield-label', rows ? '행' : '선택지'));
    values.forEach((entry, index) => {
      const row = element('div', 'form-option-row'); row.append(element('span', 'form-option-marker', rows ? '↔' : item.kind === 'radio' ? '○' : item.kind === 'checkbox' ? '□' : `${index + 1}.`));
      const input = editorControl('input', rows ? entry.title : entry.value, rows ? 'rowTitle' : 'optionValue', `${rows ? '행' : '선택지'} ${index + 1}`, { itemId: item.id });
      input.dataset.formEntryIndex = String(index); input.dataset.formEntryKind = key; input.disabled = Boolean(item.readOnly);
      const remove = element('button', 'icon-button', '×'); remove.type = 'button'; remove.dataset.formRemoveEntry = key; remove.dataset.formItemId = item.id; remove.dataset.formEntryIndex = String(index); remove.setAttribute('aria-label', `${rows ? '행' : '선택지'} ${index + 1} 삭제`); remove.disabled = Boolean(item.readOnly) || values.length <= 1;
      row.append(input);
      if (rows) { const required = editorControl('input', '', 'rowRequired', `행 ${index + 1} 필수`, { type: 'checkbox', itemId: item.id }); required.checked = Boolean(entry.required); required.dataset.formEntryIndex = String(index); required.dataset.formEntryKind = key; required.disabled = Boolean(item.readOnly); row.append(formField('필수', required, 'check-field compact')); }
      row.append(remove); wrapper.append(row);
      if (!rows && FORM_SIMPLE_CHOICE_KINDS.has(item.kind)) {
        const media = element('details', 'form-option-media'); media.open = Boolean(entry.image?.contentUri && !entry.image?.sourceUri);
        media.append(element('summary', '', entry.image ? `선택지 ${index + 1} 이미지 변경` : `선택지 ${index + 1}에 이미지 추가`));
        const source = editorControl('input', entry.image?.sourceUri || '', 'optionImageSourceUri', `선택지 ${index + 1} 이미지 주소`, { type: 'url', itemId: item.id }); source.dataset.formEntryIndex = String(index); source.dataset.formEntryKind = key; source.disabled = Boolean(item.readOnly);
        const alt = editorControl('input', entry.image?.altText || '', 'optionImageAltText', `선택지 ${index + 1} 이미지 설명`, { itemId: item.id }); alt.dataset.formEntryIndex = String(index); alt.dataset.formEntryKind = key; alt.disabled = Boolean(item.readOnly);
        const controls = element('div', 'form-option-media-controls'); controls.append(formField('공개 이미지 주소', source), formField('접근성 설명', alt));
        const clear = element('button', 'text-button danger-text compact', '선택지 이미지 입력 지우기'); clear.type = 'button'; clear.dataset.formRemoveOptionImage = item.id; clear.dataset.formEntryIndex = String(index); clear.disabled = Boolean(item.readOnly); controls.append(clear);
        if (entry.image?.contentUri && !entry.image?.sourceUri) controls.append(element('small', 'field-help', 'Google의 임시 미리보기 주소만 있습니다. 새 공개 주소를 넣거나 이미지만 제거해야 새 설문으로 만들 수 있습니다.'));
        media.append(controls); wrapper.append(media);
      }
    });
    const add = element('button', 'text-button compact', rows ? '+ 행 추가' : '+ 선택지 추가'); add.type = 'button'; add.dataset.formAddEntry = key; add.dataset.formItemId = item.id; add.disabled = Boolean(item.readOnly); wrapper.append(add); parent.append(wrapper);
  }

  function appendFormSpecificEditor(body, item, quizMode) {
    if (FORM_CHOICE_KINDS.has(item.kind)) {
      appendFormOptionsEditor(body, item);
      if (['radio', 'checkbox'].includes(item.kind) && !(item.options || []).some((option) => option.isOther)) {
        const other = element('button', 'text-button compact', '+ “기타” 선택지'); other.type = 'button'; other.dataset.formAddOther = item.id; other.disabled = Boolean(item.readOnly); body.append(other);
      }
      const shuffleField = ['radioGrid', 'checkboxGrid'].includes(item.kind) ? 'shuffleRows' : 'shuffle';
      const shuffle = editorControl('input', '', shuffleField, shuffleField === 'shuffleRows' ? '행 순서 섞기' : '선택지 순서 섞기', { type: 'checkbox', itemId: item.id }); shuffle.checked = Boolean(item[shuffleField]); shuffle.disabled = Boolean(item.readOnly);
      body.append(formField(shuffleField === 'shuffleRows' ? '응답자마다 행 순서 섞기' : '응답자마다 선택지 순서 섞기', shuffle, 'check-field'));
    }
    if (['radioGrid', 'checkboxGrid'].includes(item.kind)) appendFormOptionsEditor(body, item, { rows: true });
    if (item.kind === 'scale') {
      const fields = element('div', 'form-inline-fields');
      fields.append(formField('시작', editorControl('input', item.low ?? 1, 'low', '배율 시작', { type: 'number', itemId: item.id, min: 0, max: 1 })), formField('끝', editorControl('input', item.high ?? 5, 'high', '배율 끝', { type: 'number', itemId: item.id, min: 2, max: 10 })), formField('낮은 값 설명', editorControl('input', item.lowLabel || '', 'lowLabel', '낮은 값 설명', { itemId: item.id })), formField('높은 값 설명', editorControl('input', item.highLabel || '', 'highLabel', '높은 값 설명', { itemId: item.id })));
      body.append(fields);
    }
    if (item.kind === 'date') {
      const row = element('div', 'form-inline-fields');
      [['includeYear', '연도 포함'], ['includeTime', '시간 포함']].forEach(([field, label]) => { const input = editorControl('input', '', field, label, { type: 'checkbox', itemId: item.id }); input.checked = Boolean(item[field]); row.append(formField(label, input, 'check-field')); }); body.append(row);
    }
    if (item.kind === 'time') {
      const input = editorControl('input', '', 'duration', '기간 입력으로 사용', { type: 'checkbox', itemId: item.id }); input.checked = Boolean(item.duration); body.append(formField('시간대가 아닌 기간(시:분:초)으로 받기', input, 'check-field'));
    }
    if (item.kind === 'rating') {
      const scale = editorControl('select', '', 'ratingScaleLevel', '평점 단계', { itemId: item.id }); [3, 4, 5, 6, 7, 8, 9, 10].forEach((value) => { const option = element('option', '', `${value}단계`); option.value = String(value); scale.append(option); }); scale.value = String(item.ratingScaleLevel || 5);
      const icon = editorControl('select', '', 'ratingIconType', '평점 아이콘', { itemId: item.id }); [['STAR', '별'], ['HEART', '하트'], ['THUMB_UP', '좋아요']].forEach(([value, label]) => { const option = element('option', '', label); option.value = value; icon.append(option); }); icon.value = item.ratingIconType || 'STAR';
      const row = element('div', 'form-inline-fields'); row.append(formField('단계', scale), formField('모양', icon)); body.append(row);
    }
    if (item.kind === 'image') {
      item.image ||= {};
      const source = editorControl('input', item.image.sourceUri || '', 'sourceUri', '이미지 주소', { type: 'url', itemId: item.id }); source.dataset.formNestedGroup = 'image';
      const alt = editorControl('input', item.image.altText || '', 'altText', '이미지 대체 텍스트', { itemId: item.id }); alt.dataset.formNestedGroup = 'image';
      const alignment = editorControl('select', '', 'alignment', '이미지 정렬', { itemId: item.id }); [['LEFT', '왼쪽'], ['CENTER', '가운데'], ['RIGHT', '오른쪽']].forEach(([value, label]) => { const option = element('option', '', label); option.value = value; alignment.append(option); }); alignment.value = item.image.alignment || 'CENTER'; alignment.dataset.formNestedGroup = 'image';
      const width = editorControl('input', item.image.width || 0, 'width', '이미지 너비', { type: 'number', itemId: item.id, min: 0, max: 740 }); width.dataset.formNestedGroup = 'image';
      body.append(formField('공개 이미지 주소', source), formField('접근성 설명', alt)); const row = element('div', 'form-inline-fields'); row.append(formField('정렬', alignment), formField('너비(px, 0은 자동)', width)); body.append(row);
    }
    if (item.kind === 'video') {
      const alignment = editorControl('select', '', 'alignment', '동영상 정렬', { itemId: item.id }); [['LEFT', '왼쪽'], ['CENTER', '가운데'], ['RIGHT', '오른쪽']].forEach(([value, label]) => { const option = element('option', '', label); option.value = value; alignment.append(option); }); alignment.value = item.alignment || 'CENTER';
      const width = editorControl('input', item.width || 0, 'width', '동영상 너비', { type: 'number', itemId: item.id, min: 0, max: 740 });
      body.append(formField('YouTube 주소', editorControl('input', item.youtubeUri || '', 'youtubeUri', 'YouTube 주소', { type: 'url', itemId: item.id })), formField('캡션', editorControl('input', item.caption || '', 'caption', '동영상 캡션', { itemId: item.id }))); const row = element('div', 'form-inline-fields'); row.append(formField('정렬', alignment), formField('너비(px, 0은 자동)', width)); body.append(row);
    }
    if (FORM_QUESTION_KINDS.has(item.kind) && !['fileUpload', 'unknown'].includes(item.kind)) {
      const media = element('details', 'form-question-image-editor'); media.open = Boolean(item.questionImage?.contentUri && !item.questionImage?.sourceUri);
      media.append(element('summary', '', item.questionImage ? '질문 이미지 변경' : '질문에 이미지 추가'));
      const source = editorControl('input', item.questionImage?.sourceUri || '', 'sourceUri', '질문 이미지 주소', { type: 'url', itemId: item.id }); source.dataset.formNestedGroup = 'questionImage';
      const alt = editorControl('input', item.questionImage?.altText || '', 'altText', '질문 이미지 설명', { itemId: item.id }); alt.dataset.formNestedGroup = 'questionImage';
      const controls = element('div', 'form-question-image-controls'); controls.append(formField('공개 이미지 주소', source), formField('접근성 설명', alt));
      const clear = element('button', 'text-button danger-text compact', '질문 이미지 입력 지우기'); clear.type = 'button'; clear.dataset.formRemoveQuestionImage = item.id; controls.append(clear);
      if (item.questionImage?.contentUri && !item.questionImage?.sourceUri) controls.append(element('small', 'field-help', 'Google의 임시 미리보기 주소만 있습니다. 새 공개 주소를 넣거나 이미지만 제거해야 새 설문으로 만들 수 있습니다.'));
      media.append(controls); body.append(media);
    }
    if (['fileUpload', 'unknown'].includes(item.kind) || item.readOnly) body.append(element('div', 'notice warning form-unsupported', item.unsupportedReason || 'Google Forms API에서 이 항목은 앱 안에서 수정하거나 새로 만들 수 없습니다. Google Forms에서 고급 편집을 사용하세요.'));
    if (quizMode && FORM_GRADABLE_KINDS.has(item.kind)) {
      const grading = element('details', 'form-grading-editor'); grading.open = Boolean(item.grading);
      grading.append(element('summary', '', '정답 및 점수'));
      const point = editorControl('input', item.grading?.pointValue ?? 1, 'pointValue', '배점', { type: 'number', itemId: item.id, min: 0, max: 999 }); point.dataset.formNestedGroup = 'grading';
      const answers = editorControl('textarea', (item.grading?.correctAnswers || []).join('\n'), 'correctAnswers', '정답', { itemId: item.id, rows: 3 }); answers.dataset.formNestedGroup = 'grading'; answers.placeholder = '정답이 여러 개면 한 줄에 하나씩 입력';
      const content = element('div', 'form-inline-fields'); content.append(formField('배점', point), formField('정답', answers));
      if (item.kind === 'shortText') {
        const feedback = editorControl('input', item.grading?.generalFeedback?.text || '', 'generalFeedback', '전체 피드백', { itemId: item.id }); feedback.dataset.formNestedGroup = 'grading'; content.append(formField('응답 후 피드백', feedback));
      } else {
        const right = editorControl('input', item.grading?.whenRight?.text || '', 'whenRight', '정답 피드백', { itemId: item.id }); right.dataset.formNestedGroup = 'grading';
        const wrong = editorControl('input', item.grading?.whenWrong?.text || '', 'whenWrong', '오답 피드백', { itemId: item.id }); wrong.dataset.formNestedGroup = 'grading';
        content.append(formField('정답 피드백', right), formField('오답 피드백', wrong));
      }
      const feedbackMaterialCount = ['generalFeedback', 'whenRight', 'whenWrong'].reduce((count, field) => count + (Array.isArray(item.grading?.[field]?.material) ? item.grading[field].material.length : 0) + (Array.isArray(item.grading?.[field]?.materials) ? item.grading[field].materials.length : 0), 0);
      if (feedbackMaterialCount) content.append(element('small', 'field-help', `Google Forms에서 연결한 피드백 자료 ${feedbackMaterialCount}개는 그대로 보존됩니다.`));
      const clearGrading = element('button', 'text-button danger-text compact', '채점 정보 지우기'); clearGrading.type = 'button'; clearGrading.dataset.formClearGrading = item.id; content.append(clearGrading);
      grading.append(content); body.append(grading);
    }
  }

  function renderFormEditor(definition) {
    const list = $('#formQuestionList'); if (!list || !definition) return;
    const project = activeProject(); const linkedDraft = project?.data.forms.linkedForms.find((item) => item.definitionId === definition.id || item.formId === definition.formId);
    const changedAfterCreate = Boolean(linkedDraft?.setupStatus === 'configured' && Date.parse(definition.updatedAt || '') > Date.parse(linkedDraft.configuredAt || linkedDraft.updatedAt || ''));
    if ($('#formDraftBadge')) $('#formDraftBadge').textContent = definition.source === 'google' || definition.formId
      ? 'Google에서 가져옴 · 수정본은 새 설문으로 생성'
      : changedAfterCreate ? 'Google 생성 후 수정됨 · 새 설문으로 생성' : linkedDraft?.setupStatus === 'configured' ? 'Google에 생성된 설문과 연결됨' : '아직 Google에 생성되지 않음';
    if ($('#createGoogleForm')) $('#createGoogleForm').textContent = definition.source === 'google' || definition.formId
      ? '새 Google 설문으로 만들기'
      : changedAfterCreate ? '새 Google 설문으로 만들기' : linkedDraft?.setupStatus === 'configured' ? 'Google에서 설문 열기' : 'Google 설문 생성';
    $('#formTitleInput').value = definition.title || '';
    $('#formDescriptionInput').value = definition.description || '';
    $('#formEmailCollection').value = definition.collectEmail || definition.settings?.emailCollectionType || 'DO_NOT_COLLECT';
    $('#formQuizMode').checked = Boolean(definition.settings?.isQuiz);
    list.replaceChildren();
    const items = definition.items || [];
    if (!items.length) list.append(element('div', 'form-editor-empty', '아직 질문이 없습니다. 아래 “질문 추가”를 눌러 시작하세요.'));
    items.forEach((item, index) => {
      const card = element('article', `form-editor-card${item.readOnly ? ' read-only' : ''}`); card.dataset.formItemId = item.id;
      const head = element('div', 'form-card-head');
      const handle = element('button', 'form-drag-handle', '⠿'); handle.type = 'button'; handle.tabIndex = -1; handle.draggable = !item.readOnly; handle.setAttribute('aria-label', `항목 ${index + 1} 이동`); handle.disabled = Boolean(item.readOnly);
      const type = editorControl('select', '', 'kind', '질문 유형', { itemId: item.id }); type.className = 'form-item-type';
      Object.entries(FORM_ITEM_LABELS).filter(([kind]) => !['unknown', 'fileUpload'].includes(kind) || kind === item.kind).forEach(([kind, label]) => { const option = element('option', '', label); option.value = kind; type.append(option); }); type.value = item.kind; type.disabled = Boolean(item.readOnly);
      head.append(handle, element('span', 'form-item-number', `${index + 1}`), type); card.append(head);
      const body = element('div', 'form-card-body');
      const title = editorControl('input', item.title || '', 'title', `${FORM_ITEM_LABELS[item.kind] || '항목'} 제목`, { itemId: item.id }); title.className = 'form-item-title'; title.placeholder = ['image', 'video'].includes(item.kind) ? '설명(선택)' : '질문'; title.disabled = Boolean(item.readOnly);
      const description = editorControl('textarea', item.description || '', 'description', '항목 설명', { itemId: item.id, rows: 2 }); description.placeholder = '설명(선택)'; description.disabled = Boolean(item.readOnly);
      body.append(title, description); appendFormSpecificEditor(body, item, Boolean(definition.settings?.isQuiz)); card.append(body);
      const actions = element('div', 'form-card-actions');
      const up = element('button', 'icon-button', '↑'); up.type = 'button'; up.dataset.formMoveItem = '-1'; up.dataset.formItemId = item.id; up.setAttribute('aria-label', '위로 이동'); up.disabled = index === 0 || Boolean(item.readOnly);
      const down = element('button', 'icon-button', '↓'); down.type = 'button'; down.dataset.formMoveItem = '1'; down.dataset.formItemId = item.id; down.setAttribute('aria-label', '아래로 이동'); down.disabled = index === items.length - 1 || Boolean(item.readOnly);
      const duplicate = element('button', 'icon-button', '⧉'); duplicate.type = 'button'; duplicate.dataset.formDuplicateItem = item.id; duplicate.setAttribute('aria-label', '항목 복제'); duplicate.disabled = Boolean(item.readOnly);
      const remove = element('button', 'icon-button danger-text', '⌫'); remove.type = 'button'; remove.dataset.formRemoveItem = item.id; remove.setAttribute('aria-label', item.readOnly ? '가져온 고급 항목을 이 초안에서 제거' : '항목 삭제');
      actions.append(up, down, duplicate, remove);
      if (FORM_QUESTION_KINDS.has(item.kind) && !['unknown', 'fileUpload'].includes(item.kind)) {
        const required = editorControl('input', '', 'required', '필수 질문', { type: 'checkbox', itemId: item.id }); required.checked = ['radioGrid', 'checkboxGrid'].includes(item.kind) ? Boolean(item.rows?.length && item.rows.every((row) => row.required)) : Boolean(item.required); required.disabled = Boolean(item.readOnly); actions.append(formField('필수', required, 'check-field form-required-toggle'));
      }
      card.append(actions); list.append(card);
    });
    formEditorProjectId = activeProject()?.id || null;
    if ($('#formEditorStatus')) $('#formEditorStatus').textContent = formEditorDirty ? '변경사항 저장 중…' : '이 PC와 Workspace에 자동 저장됨';
    syncFormStructureUndo();
  }

  function appendFormPreviewItem(preview, item, index) {
    if (item.kind === 'section') { const section = element('section', 'form-question-preview form-section-preview'); section.append(element('small', '', `섹션 ${index + 1}`), element('h2', '', item.title || '제목 없는 섹션'), element('p', '', item.description || '')); preview.append(section); return; }
    if (item.kind === 'textBlock') { const block = element('section', 'form-question-preview form-text-preview'); block.append(element('h3', '', item.title || ''), element('p', '', item.description || '')); preview.append(block); return; }
    if (item.kind === 'image') { const block = element('section', 'form-question-preview'); block.append(element('strong', '', item.title || '이미지')); const uri = item.image?.sourceUri || item.image?.contentUri || ''; if (/^https:\/\//i.test(uri)) { const img = document.createElement('img'); img.src = uri; img.alt = item.image?.altText || item.title || '설문 이미지'; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; block.append(img); } else block.append(element('div', 'fake-input', uri ? 'http 이미지는 보안을 위해 앱 미리보기에서 불러오지 않습니다. Google 설문에서는 주소를 사용합니다.' : '이미지 주소를 입력하면 여기에 표시됩니다.')); preview.append(block); return; }
    if (item.kind === 'video') { const block = element('section', 'form-question-preview'); block.append(element('strong', '', item.title || '동영상'), element('p', '', item.caption || item.youtubeUri || 'YouTube 주소를 입력하세요.')); preview.append(block); return; }
    const card = element('section', 'form-question-preview');
    card.append(element('small', '', `질문 ${index + 1}${item.required ? ' · 필수' : ''}`), element('strong', '', item.title || '제목 없는 질문'));
    if (item.description) card.append(element('p', '', item.description));
    const questionImageUri = item.questionImage?.sourceUri || item.questionImage?.contentUri || '';
    if (/^https:\/\//i.test(questionImageUri)) { const img = document.createElement('img'); img.src = questionImageUri; img.alt = item.questionImage?.altText || `${item.title || '질문'} 이미지`; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; img.className = 'form-question-preview-image'; card.append(img); }
    if (['shortText', 'paragraph'].includes(item.kind)) { const input = document.createElement(item.kind === 'paragraph' ? 'textarea' : 'input'); input.disabled = true; input.placeholder = item.kind === 'paragraph' ? '장문형 텍스트' : '단답형 텍스트'; card.append(input); }
    else if (FORM_CHOICE_KINDS.has(item.kind) && !['radioGrid', 'checkboxGrid'].includes(item.kind)) {
      if (item.kind === 'dropdown') { const select = document.createElement('select'); select.disabled = true; select.append(element('option', '', '선택')); (item.options || []).forEach((option) => select.append(element('option', '', option.value))); card.append(select); }
      else { const options = element('div', 'form-options'); (item.options || []).forEach((option) => { const row = element('span', '', `${item.kind === 'radio' ? '○' : '□'} ${option.value}`); const uri = option.image?.sourceUri || option.image?.contentUri || ''; if (/^https:\/\//i.test(uri)) { const img = document.createElement('img'); img.src = uri; img.alt = option.image?.altText || `${option.value} 이미지`; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; row.append(img); } options.append(row); }); card.append(options); }
    } else if (item.kind === 'scale') { const options = element('div', 'form-options form-scale-preview'); for (let value = Number(item.low ?? 1); value <= Number(item.high ?? 5); value += 1) options.append(element('span', '', `○ ${value}`)); card.append(options); }
    else if (item.kind === 'date') { const input = document.createElement('input'); input.type = 'date'; input.disabled = true; card.append(input); if (item.includeTime) { const time = document.createElement('input'); time.type = 'time'; time.disabled = true; time.setAttribute('aria-label', '함께 입력할 시간'); card.append(time); } }
    else if (item.kind === 'time') { const input = document.createElement('input'); input.type = item.duration ? 'text' : 'time'; input.placeholder = item.duration ? '시 : 분 : 초' : ''; input.disabled = true; card.append(input); }
    else if (item.kind === 'rating') { card.append(element('div', 'form-rating-preview', Array.from({ length: Number(item.ratingScaleLevel || 5) }, () => item.ratingIconType === 'HEART' ? '♡' : item.ratingIconType === 'THUMB_UP' ? '👍' : '☆').join(' '))); }
    else if (['radioGrid', 'checkboxGrid'].includes(item.kind)) { const table = element('table', 'form-preview-grid'); const head = element('tr'); head.append(element('th', '', '')); (item.options || []).forEach((option) => head.append(element('th', '', option.value))); const thead = element('thead'); thead.append(head); const tbody = element('tbody'); (item.rows || []).forEach((row) => { const tr = element('tr'); tr.append(element('th', '', row.title)); (item.options || []).forEach(() => tr.append(element('td', '', item.kind === 'radioGrid' ? '○' : '□'))); tbody.append(tr); }); table.append(thead, tbody); card.append(table); }
    else if (item.kind === 'fileUpload') { const button = element('button', 'secondary-button', '파일 추가'); button.type = 'button'; button.disabled = true; card.append(button); }
    else card.append(element('div', 'notice warning', item.unsupportedReason || '이 항목은 Google Forms에서 확인하세요.'));
    preview.append(card);
  }

  function renderFormPreview(definition) {
    const preview = $('#formDefinitionPreview'); if (!preview) return;
    preview.replaceChildren();
    const heading = element('header', 'form-preview-heading'); heading.append(element('h1', '', definition.title || '제목 없는 설문'), element('p', '', definition.description || '')); preview.append(heading);
    const emailCollection = definition.collectEmail || definition.settings?.emailCollectionType || 'DO_NOT_COLLECT';
    if (emailCollection === 'VERIFIED') preview.append(element('div', 'notice info', '응답자의 Google 계정 이메일이 확인되어 함께 수집됩니다.'));
    if (emailCollection === 'RESPONDER_INPUT') { const email = element('section', 'form-question-preview'); email.append(element('small', '', '필수'), element('strong', '', '이메일')); const input = document.createElement('input'); input.type = 'email'; input.placeholder = '이메일 주소'; input.disabled = true; email.append(input); preview.append(email); }
    (definition.items || []).forEach((item, index) => appendFormPreviewItem(preview, item, index));
    if (!(definition.items || []).length) preview.append(element('div', 'list-empty', '미리 볼 질문이 없습니다.'));
    const submit = element('button', 'primary-button', '제출'); submit.type = 'button'; submit.disabled = true; preview.append(submit, element('small', 'field-help', '미리보기에서는 응답이 저장되지 않습니다.'));
  }

  function renderFormsPage() {
    const project = activeProject(); if (!project) { navigate('dashboard'); return; }
    const linkedForms = project.data.forms.linkedForms || [];
    const selectedLinked = selectedLinkedForm(project);
    const linkedSelect = $('#linkedFormSelect');
    linkedSelect.replaceChildren();
    if (!linkedForms.length) linkedSelect.append(element('option', '', '연결된 설문 없음'));
    linkedForms.forEach((linked, index) => {
      const linkedConnection = state.connections.find((item) => item.id === linked.connectionId);
      const linkedLabel = linked.title || `${linked.type === 'availability' ? '가능 시간 조사' : linked.type === 'registration' ? '신청자 정보' : '자유 설문'} ${index + 1}`;
      const shortFormId = String(linked.formId || '').slice(-6);
      const option = element('option', '', `${linkedLabel}${linkedConnection?.account ? ` · ${linkedConnection.account}` : ''}${shortFormId ? ` · …${shortFormId}` : ''}`);
      option.value = linked.formId; option.selected = linked.formId === selectedLinked?.formId; linkedSelect.append(option);
    });
    linkedSelect.disabled = !linkedForms.length;
    const setupIncomplete = Boolean(selectedLinked?.source === 'created' && selectedLinked.setupStatus && selectedLinked.setupStatus !== 'configured');
    const connectionReviewRequired = Boolean(selectedLinked && (selectedLinked.connectionReviewRequired || !selectedLinked.connectionId));
    const confirmAccountButton = $('#confirmLinkedFormAccount');
    const candidateConnectionId = defaultConnectionId(project, 'forms');
    const candidateConnection = state.connections.find((item) => item.id === candidateConnectionId && item.type === 'forms' && item.status === 'connected');
    const availabilityConsistency = selectedLinked?.type === 'availability' && Ops.googleFormAvailabilityConsistency ? Ops.googleFormAvailabilityConsistency(project, selectedLinked) : { consistent: true, reason: '' };
    const availabilityScheduleReviewRequired = Boolean(selectedLinked?.availabilityScheduleReviewRequired || !availabilityConsistency.consistent);
    $('#syncFormResponses').disabled = !selectedLinked || setupIncomplete || connectionReviewRequired || availabilityScheduleReviewRequired;
    if (confirmAccountButton) { confirmAccountButton.hidden = !selectedLinked || !connectionReviewRequired; confirmAccountButton.disabled = !candidateConnection; }
    $('#openLinkedForm').disabled = !selectedLinked;
    if ($('#openLinkedFormResponse')) $('#openLinkedFormResponse').disabled = !selectedLinked?.responderUri;
    if ($('#copyLinkedFormResponse')) $('#copyLinkedFormResponse').disabled = !selectedLinked?.responderUri;
    if ($('#copyLinkedForm')) $('#copyLinkedForm').disabled = !selectedLinked;
    if ($('#removeLinkedForm')) $('#removeLinkedForm').disabled = !selectedLinked;
    const responseStatus = $('#formResponseStatus'); const responseSummary = $('#formResponseSummary');
    if (!selectedLinked) { responseStatus.textContent = 'Google Forms에서 만든 설문도 편집 주소나 Form ID로 가져올 수 있습니다.'; responseSummary.hidden = true; responseSummary.replaceChildren(); }
    else {
      const connection = state.connections.find((item) => item.id === selectedLinked.connectionId);
      const details = [selectedLinked.type === 'availability' ? '가능 시간 조사' : selectedLinked.type === 'registration' ? '신청자 정보' : '자유 설문'];
      if (connection) details.push(`${connection.label}${connection.account ? ` · ${connection.account}` : ''}`);
      if (Number.isFinite(Number(selectedLinked.responseCount))) details.push(`마지막 응답 ${Number(selectedLinked.responseCount)}건`);
      if (selectedLinked.lastSyncedAt) details.push(`동기화 ${formatUpdatedAt(selectedLinked.lastSyncedAt)}`);
      if (selectedLinked.setupStatus === 'shellCreated') details.push('설문 생성됨 · 질문 구성 대기');
      if (selectedLinked.setupStatus === 'configuring') details.push('질문 구성 결과 확인 필요');
      if (selectedLinked.setupStatus === 'needsReview') details.push(selectedLinked.reviewReason || '질문 구성 결과 확인 필요');
      if (selectedLinked.published === true && selectedLinked.acceptingResponses !== false) details.push('응답 받는 중');
      else if (selectedLinked.published === true) details.push('게시됨 · 응답 닫힘');
      else if (selectedLinked.published === false) details.push('게시되지 않음');
      if (selectedLinked.advancedItemCount) details.push(`Google에서 편집할 고급 항목 ${selectedLinked.advancedItemCount}개`);
      if (availabilityScheduleReviewRequired) details.push(selectedLinked.availabilityScheduleReviewReason || availabilityConsistency.reason || '프로젝트 일정과 설문 선택지를 다시 맞춰야 함');
      if (connectionReviewRequired) details.push(selectedLinked.connectionReviewReason || '사용할 Google 계정 다시 확인 필요');
      else if (selectedLinked.responseReviewRequired) details.push(selectedLinked.responseReviewReason || '응답 동기화 결과 확인 필요');
      else if (selectedLinked.needsReview) details.push('확인 필요');
      responseStatus.textContent = details.join(' · ');
      responseSummary.hidden = false; responseSummary.replaceChildren();
      const responseCopy = selectedLinked.type === 'availability' ? '응답을 사람별 가능 시간에 반영합니다.' : selectedLinked.type === 'registration' ? '응답을 프로젝트 명단과 안전하게 병합합니다.' : '자유 설문의 응답 수만 확인하며 명단이나 일정은 자동으로 바꾸지 않습니다.';
      responseSummary.append(element('strong', '', Number.isFinite(Number(selectedLinked.responseCount)) ? `최근 응답 ${Number(selectedLinked.responseCount)}건` : '아직 응답을 가져오지 않음'), element('small', '', responseCopy));
    }
    const templateSelect = $('#sharedFormTemplateSelect'); templateSelect?.replaceChildren(element('option', '', '전역 설문 양식 선택'));
    (state.library.formTemplates || []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko')).forEach((template) => { const semanticType = template.semanticType || template.definition?.type; const semanticLabel = semanticType === 'registration' ? ' · 명단 연동' : semanticType === 'availability' ? ' · 가능 시간 연동' : ''; const option = element('option', '', `${template.name || template.definition?.title || '이름 없는 설문 양식'}${semanticLabel} · 저장 ${formatUpdatedAt(template.updatedAt || template.savedAt)}`); option.value = template.id; templateSelect?.append(option); });
    if ($('#loadSharedFormTemplate')) $('#loadSharedFormTemplate').disabled = !(state.library.formTemplates || []).length;
    if ($('#deleteSharedFormTemplate')) $('#deleteSharedFormTemplate').disabled = !(state.library.formTemplates || []).length;
    const definition = activeFormDefinition(project);
    const draftSelect = $('#projectFormDraftSelect'); draftSelect.replaceChildren();
    (project.data.forms.definitions || []).forEach((draft, index) => { const option = element('option', '', `초안 ${index + 1} · ${draft.title || '제목 없는 설문'}${draft.source === 'google' || draft.formId ? ' · Google에서 가져옴' : ''} · ${formatUpdatedAt(draft.updatedAt || draft.createdAt)}`); option.value = draft.id; option.selected = draft.id === definition?.id; option.title = option.textContent; draftSelect.append(option); });
    draftSelect.disabled = !definition;
    $('#deleteProjectFormDraft').disabled = !definition;
    const editorAlreadyVisible = formEditorProjectId === project.id && $('#formQuestionList')?.childElementCount;
    if (!formEditorDirty || !editorAlreadyVisible) renderFormEditor(definition);
    updateFormCreationReadiness(definition);
  }

  function renderZoomPage() {
    const project = activeProject(); if (!project) { navigate('dashboard'); return; }
    const zoomConnections = state.connections.filter((connection) => connection.type === 'zoom');
    const defaultId = defaultConnectionId(project, 'zoom');
    const defaultConnection = zoomConnections.find((connection) => connection.id === defaultId);
    const defaultSource = project.settings.defaultConnectionIds.zoom ? '이 프로젝트의 예외 계정' : 'Workspace 기본 계정';
    $('#zoomReadiness').textContent = !zoomConnections.length
      ? '사용할 Zoom 계정이 없습니다. “사용할 Zoom 계정 확인”에서 먼저 계정을 연결하세요.'
      : !defaultConnection
        ? `연결해 둔 Zoom 계정은 ${zoomConnections.length}개지만 Workspace 기본 계정이 없습니다. 계정 연결에서 한 번만 기본값을 선택하세요.`
        : defaultConnection.status !== 'connected'
          ? `${defaultSource} “${defaultConnection.label}”에 다시 로그인해야 합니다. 어떤 회의를 만들지는 확인할 수 있지만 실제 생성은 되지 않습니다.`
          : `Zoom 회의는 ${defaultSource} “${defaultConnection.label}”으로 생성됩니다.`;
    const table = $('#zoomPlanTable'); const head = element('tr');
    ['일정 범위', '시간', '세션명', '생성 계정', '회의 상태', '참가 링크'].forEach((label) => head.append(element('th', '', label))); table.tHead.replaceChildren(head);
    const rows = project.data.slots.slice().sort((a, b) => Ops.slotKey(a).localeCompare(Ops.slotKey(b))).map((slot) => {
      const row = element('tr'); row.append(element('td', '', slotRangeText(slot, { includeYear: true })), element('td', '', `${slot.startTime}–${slot.endTime}`), element('td', '', slot.label || ''));
      const accountCell = element('td'); const select = element('select'); select.dataset.zoomSlotConnection = slot.id;
      const inherit = element('option', '', defaultConnection ? `${defaultSource} · ${defaultConnection.label}` : 'Workspace 기본 계정 선택 필요'); inherit.value = ''; select.append(inherit);
      zoomConnections.forEach((connection) => { const option = element('option', '', `${connection.label}${connection.status !== 'connected' ? ' · 로그인 필요' : ''}`); option.value = connection.id; option.selected = slot.zoomConnectionId === connection.id; select.append(option); }); accountCell.append(select); row.append(accountCell);
      const slotConnectionId = slot.zoomConnectionId || defaultId;
      const artifact = latestActiveExternalArtifact(project, 'zoom', (item) => item.slotId === slot.id && item.connectionId === slotConnectionId);
      const replacedArtifact = project.data.externalArtifacts.slice().reverse().find((item) => item.kind === 'zoom' && item.slotId === slot.id && (item.status === 'superseded' || item.connectionId !== slotConnectionId));
      const meetingReadiness = zoomSlotReadiness(project, slot);
      const blockedStatus = meetingReadiness.code === 'multiDayZoomUnsupported' ? '여러 날 일정 · 생성 안 함' : '시간대 확인 필요';
      const needsCleanup = Boolean(artifact && artifact.status !== 'superseded' && (artifact.status === 'stale' || slot.status === 'cancelled' || !meetingReadiness.ready)); const status = element('td', '', needsCleanup ? '기존 회의 정리 필요' : !meetingReadiness.ready ? blockedStatus : artifact?.status === 'created' ? '만들기 완료' : '아직 만들지 않음');
      if (!meetingReadiness.ready) { status.classList.add('needs-review'); status.title = meetingReadiness.message; }
      if (meetingReadiness.ready && !artifact && replacedArtifact) status.textContent = '선택한 계정으로 다시 만들기 필요';
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
    if (projectLinkedProgram) { navigate(targetId); return; }
    if (!standaloneProgram) { navigate(targetId); return; }
    const source = activeProject(); const target = state.quickWorkspaces[targetId];
    if (source && target && source.id !== target.id) {
      const targetHasData = target.data.people.length || target.data.slots.length || target.data.assignments.length;
      if (targetHasData && !await showConfirm(`${Core.MODULE_CATALOG.find((item) => item.id === targetId)?.name || '다음 프로그램'}에서 작업 중이던 내용을 현재 자료로 바꿀까요? 별도로 저장한 자료는 그대로 유지됩니다.`, { title: '현재 자료로 계속 작업', action: '자료 가져오기', danger: false })) return;
      const detached = Core.createDetachedProjectCopy(source, { id: target.id, name: target.name, scope: 'quick' });
      detached.installedModules = [...new Set([...(detached.installedModules || []), targetId])];
      assertSmokeUi(!(detached.data.externalArtifacts || []).length && Object.values(detached.settings.defaultConnectionIds || {}).every((id) => !id), 'related program copies do not inherit external artifacts or account overrides');
      state.quickWorkspaces[targetId] = detached; await persist('작업 전달됨');
    }
    await globalThis.workspaceDesktop.openProgram(targetId);
  }

  function bindRichEditor(editor) {
    editor.addEventListener('paste', (event) => {
      const html = event.clipboardData?.getData('text/html'); if (!html) return;
      event.preventDefault(); document.execCommand('insertHTML', false, sanitizeRichHtml(html));
    });
    editor.addEventListener('drop', (event) => event.preventDefault());
    ['focus', 'input', 'keyup', 'mouseup'].forEach((type) => editor.addEventListener(type, () => syncRichToolbarState(editor)));
  }

  function syncRichToolbarState(editor) {
    const toolbar = $(`[data-editor-toolbar="${editor.id}"]`); if (!toolbar) return;
    $$('[data-rich-command][aria-pressed]', toolbar).forEach((button) => {
      let pressed = false; try { pressed = Boolean(document.queryCommandState(button.dataset.richCommand)); } catch (_) {}
      button.setAttribute('aria-pressed', String(pressed));
    });
  }

  function templateVariableNames(project) {
    return [...new Set(['프로젝트', '이름', '이메일', '개인일정', ...project.data.columns.map((column) => column.name).filter(Boolean)])];
  }

  function hideTemplateAutocomplete() {
    const previousTarget = templateAutocompleteState?.target;
    templateAutocompleteState = null;
    const menu = $('#templateVariableAutocomplete');
    if (!menu) return;
    if (previousTarget) { previousTarget.setAttribute('aria-expanded', 'false'); previousTarget.removeAttribute('aria-activedescendant'); }
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
    if (templateAutocompleteState?.target && templateAutocompleteState.target !== target) { templateAutocompleteState.target.setAttribute('aria-expanded', 'false'); templateAutocompleteState.target.removeAttribute('aria-activedescendant'); }
    const query = context.query.trim().toLocaleLowerCase('ko-KR'); const available = templateVariableNames(project);
    const starts = available.filter((name) => name.toLocaleLowerCase('ko-KR').startsWith(query));
    const items = [...starts, ...available.filter((name) => !starts.includes(name) && name.toLocaleLowerCase('ko-KR').includes(query))];
    templateAutocompleteState = { ...context, target, items, index: 0 };
    if (items.length) menu.replaceChildren(...items.map((name, index) => {
      const button = element('button'); button.type = 'button'; button.id = `${target.id}-template-option-${index}`; button.dataset.templateAutocomplete = name; button.role = 'option'; button.classList.toggle('active', index === 0); button.setAttribute('aria-selected', String(index === 0));
      button.append(element('span', '', `{${name}}`), element('small', '', index === 0 ? 'Enter' : '선택')); return button;
    }));
    else menu.replaceChildren(element('div', 'variable-autocomplete-empty', '일치하는 명단 컬럼이 없습니다.'));
    target.setAttribute('aria-expanded', 'true'); if (items.length) target.setAttribute('aria-activedescendant', `${target.id}-template-option-0`); else target.removeAttribute('aria-activedescendant');
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
    $$('#templateVariableAutocomplete [data-template-autocomplete]').forEach((button, index) => { button.classList.toggle('active', index === current.index); button.setAttribute('aria-selected', String(index === current.index)); if (index === current.index) { current.target.setAttribute('aria-activedescendant', button.id); button.scrollIntoView({ block: 'nearest' }); } });
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
    const accountSource = project.settings.defaultConnectionIds.gmail ? '이 프로젝트의 예외 계정' : 'Workspace 기본 계정';
    const connectedEmail = workspaceGmail?.account || workspaceGmail?.label || '';
    const accountButton = $('#gmailFlowAccountButton');
    accountButton.classList.toggle('connected', workspaceGmailReady);
    accountButton.classList.toggle('needs-auth', !workspaceGmailReady);
    $('#gmailFlowAccountAvatar').textContent = connectedEmail ? connectedEmail.slice(0, 1).toUpperCase() : 'G';
    $('#gmailFlowAccountText').textContent = connectedEmail || 'Workspace 기본 Gmail 계정 필요';
    $('#gmailFlowAccountStatus').textContent = !workspaceGmailId
      ? '계정 연결에서 모든 프로젝트가 사용할 Gmail 계정을 한 번만 선택하세요.'
      : !workspaceGmail
        ? '선택한 Workspace Gmail 연결을 찾을 수 없습니다.'
        : workspaceGmailReady
          ? `${accountSource} · ${workspaceGmail.label}`
          : `${accountSource} · ${workspaceGmail.label} 로그인 필요`;
    $('#legacyGmailFlowStatus').textContent = gmailFlowSummary.needsAdditionalPermission
      ? `Gmail Flow도 ${gmailFlowSummary.rememberedEmail || connectedEmail || '이 계정'}을 사용 · 최초 1회 권한 확인 필요`
      : workspaceGmailReady
        ? `Gmail Flow도 같은 Workspace 계정(${connectedEmail})을 사용합니다.`
        : 'Gmail Flow도 위 Workspace Gmail 계정을 함께 사용합니다.';
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
    const pkg = buildWorkspaceMailPackage(project);
    const empty = pkg.entries.filter((entry) => !entry.assignments.length).length;
    const missingZoom = pkg.entries.filter((entry) => entry.assignments.some((assignment) => !assignment.zoomJoinUrl)).length;
    const packageReadiness = !pkg.entries.length
      ? '받는 사람 명단을 먼저 가져와주세요.'
      : empty || missingZoom
        ? `${pkg.entries[0]?.name || '받는 사람'}${pkg.entries.length > 1 ? ` 외 ${pkg.entries.length - 1}명` : ''}에게 보낼 예정입니다.${empty ? ` 일정이 없는 사람 ${empty}명을 확인해주세요.` : ''}${missingZoom ? ` Zoom 링크가 없는 사람 ${missingZoom}명을 확인해주세요.` : ''}`
        : `${pkg.entries[0]?.name || '받는 사람'}${pkg.entries.length > 1 ? ` 외 ${pkg.entries.length - 1}명` : ''}의 명단과 일정 연결을 확인했습니다.`;
    const accountReadiness = workspaceGmailReady
      ? `Gmail 임시보관함은 ${connectedEmail} 계정에 저장됩니다.`
      : 'Gmail 임시보관함을 만들려면 Workspace 기본 Gmail 계정을 연결해주세요.';
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
    if (guideSession) { showToast('가이드에서는 실제 파일을 만들지 않습니다. 저장될 내용만 체험했습니다.', 'success'); return; }
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = element('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function guideAccent(guide) {
    const accents = { blue: '#2879b8', violet: '#7454a6', green: '#2f8f5b', cyan: '#16879b', amber: '#b8781d', red: '#b44747' };
    const module = guide.moduleId ? Core.MODULE_CATALOG.find((item) => item.id === guide.moduleId) : null;
    if (guide.group === 'featured') return '#1769aa';
    if (guide.group === 'management') return '#5f6b78';
    return accents[module?.accent] || '#1769aa';
  }

  function guideChoiceCard(guide) {
    const button = element('button', `guide-choice-card${guide.group === 'featured' ? ' featured' : ''}`);
    button.type = 'button'; button.dataset.guideStart = guide.id;
    button.style.setProperty('--guide-accent', guideAccent(guide));
    const icon = element('span', 'guide-choice-icon', guide.icon || guide.name.slice(0, 1)); icon.setAttribute('aria-hidden', 'true');
    const copy = element('span', 'guide-choice-copy'); copy.append(element('strong', '', guide.name), element('small', '', guide.description));
    const meta = element('span', 'guide-choice-meta'); meta.append(element('b', '', `${guide.steps.length}단계`), element('span', '', `약 ${guide.minutes}분`));
    button.append(icon, copy, meta);
    button.setAttribute('aria-label', `${guide.name}. ${guide.description} ${guide.steps.length}단계, 약 ${guide.minutes}분`);
    return button;
  }

  function renderGuideCatalog() {
    if (!GuideCore) return;
    const featured = $('#guideFeaturedCatalog'); const programs = $('#guideProgramCatalog'); const management = $('#guideManagementCatalog');
    if (!featured || !programs || !management) return;
    featured.replaceChildren(...GuideCore.GUIDES.filter((guide) => guide.group === 'featured').map(guideChoiceCard));
    programs.replaceChildren(...GuideCore.GUIDES.filter((guide) => guide.group === 'program').map(guideChoiceCard));
    management.replaceChildren(...GuideCore.GUIDES.filter((guide) => guide.group === 'management').map(guideChoiceCard));
  }

  function openGuideLibrary() {
    if (!GuideCore) { showToast('가이드 구성 파일을 불러오지 못했습니다.', 'error'); return; }
    if (standaloneProgram) { showToast('전체 Workspace 창의 환경 설정에서 가이드를 시작해주세요.'); return; }
    renderGuideCatalog(); openDialog('guideLibraryDialog');
  }

  function workspaceStateIsNewer(candidate, current) {
    if (!candidate) return false;
    if (!current) return true;
    const candidateRevision = Number(candidate._revision || 0); const currentRevision = Number(current._revision || 0);
    if (candidateRevision !== currentRevision) return candidateRevision > currentRevision;
    return String(candidate.updatedAt || '') > String(current.updatedAt || '');
  }

  function setGuideLayerVisible(visible) {
    const layer = $('#guideLayer'); if (!layer) return;
    if (visible) {
      layer.inert = false;
      layer.setAttribute('aria-hidden', 'false');
      try { if (layer.showPopover && !layer.matches(':popover-open')) layer.showPopover(); else if (!layer.showPopover) layer.style.display = 'block'; }
      catch (_) { layer.style.display = 'block'; }
    } else {
      if (layer.contains(document.activeElement)) document.activeElement.blur();
      try { if (layer.hidePopover && layer.matches(':popover-open')) layer.hidePopover(); }
      catch (_) {}
      layer.inert = true;
      layer.setAttribute('aria-hidden', 'true');
      if (!layer.showPopover) layer.style.display = 'none';
    }
  }

  function promoteGuideLayer() {
    const layer = $('#guideLayer'); if (!guideSession || !layer?.showPopover) return;
    try {
      if (layer.matches(':popover-open')) layer.hidePopover();
      layer.showPopover();
    } catch (_) {}
  }

  function clearGuideTarget() {
    if (!guideSession?.target) return;
    const target = guideSession.target; const original = guideSession.targetOriginal || {};
    target.classList.remove('guide-target-active');
    if (original.describedBy == null) target.removeAttribute('aria-describedby'); else target.setAttribute('aria-describedby', original.describedBy);
    if (original.tabIndex == null) target.removeAttribute('tabindex'); else target.setAttribute('tabindex', original.tabIndex);
    if (original.disabled != null && 'disabled' in target) target.disabled = original.disabled;
    if (original.title == null) target.removeAttribute('title'); else target.setAttribute('title', original.title);
    guideResizeObserver?.disconnect();
    guideSession.target = null; guideSession.targetOriginal = null;
  }

  function elementCanFocus(target) {
    return Boolean(target?.matches?.('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]'));
  }

  function attachGuideTarget(target) {
    if (!guideSession || guideSession.target === target) return;
    clearGuideTarget();
    guideSession.target = target;
    const step = guideSession.guide.steps[guideSession.stepIndex];
    guideSession.targetOriginal = {
      describedBy: target.getAttribute('aria-describedby'),
      tabIndex: target.getAttribute('tabindex'),
      disabled: 'disabled' in target ? Boolean(target.disabled) : null,
      title: target.getAttribute('title')
    };
    // Simulated external actions are intercepted in capture phase. Temporarily
    // enabling their button lets a real mouse click reach the guide without
    // allowing the underlying Drive/Google/Zoom/Gmail operation to run.
    if (step?.interaction === 'simulate' && 'disabled' in target && target.disabled) {
      target.disabled = false; target.title = '가이드 연습용 모의 동작입니다. 실제 서비스나 파일은 변경하지 않습니다.';
    }
    target.classList.add('guide-target-active');
    const describedBy = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)); describedBy.add('guideStepDescription');
    describedBy.add('guideKeyboardHint');
    target.setAttribute('aria-describedby', [...describedBy].join(' '));
    if (!elementCanFocus(target)) target.setAttribute('tabindex', '-1');
    guideResizeObserver?.disconnect(); guideResizeObserver?.observe(target);
  }

  function guideVisibleRect(target) {
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let rect = target.getBoundingClientRect();
    let visible = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    for (let parent = target.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) continue;
      const parentRect = parent.getBoundingClientRect();
      visible.left = Math.max(visible.left, parentRect.left); visible.top = Math.max(visible.top, parentRect.top);
      visible.right = Math.min(visible.right, parentRect.right); visible.bottom = Math.min(visible.bottom, parentRect.bottom);
    }
    visible.left = Math.max(viewport.left, visible.left); visible.top = Math.max(viewport.top, visible.top);
    visible.right = Math.min(viewport.right, visible.right); visible.bottom = Math.min(viewport.bottom, visible.bottom);
    if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
    const padding = 6;
    const left = Math.max(3, visible.left - padding); const top = Math.max(3, visible.top - padding);
    const right = Math.min(innerWidth - 3, visible.right + padding); const bottom = Math.min(innerHeight - 3, visible.bottom + padding);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function guideTargetUnavailable(step, target) {
    return Boolean(step && target && step.interaction !== 'simulate' && step.interaction !== 'next' && target.matches?.(':disabled'));
  }

  function guideTargetHitTestable(target) {
    if (!target?.isConnected) return false;
    const rect = target.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false;
    const visible = guideVisibleRect(target); if (!visible) return false;
    const hitX = Math.max(0, Math.min(innerWidth - 1, visible.left + visible.width / 2));
    const hitY = Math.max(0, Math.min(innerHeight - 1, visible.top + visible.height / 2));
    const layer = $('#guideLayer');
    const underlying = document.elementsFromPoint(hitX, hitY).find((item) => !layer?.contains(item));
    return Boolean(underlying && (underlying === target || target.contains(underlying)));
  }

  function setGuideRect(node, left, top, width, height) {
    if (!node) return;
    node.style.left = `${Math.max(0, Math.round(left))}px`; node.style.top = `${Math.max(0, Math.round(top))}px`;
    node.style.width = `${Math.max(0, Math.round(width))}px`; node.style.height = `${Math.max(0, Math.round(height))}px`;
  }

  function resetGuideTargetGeometry() {
    const spotlight = $('#guideSpotlight'); if (spotlight) spotlight.hidden = true;
    setGuideRect($('#guideBlockTop'), 0, 0, innerWidth, innerHeight);
    [$('#guideBlockRight'), $('#guideBlockBottom'), $('#guideBlockLeft')].forEach((node) => setGuideRect(node, 0, 0, 0, 0));
  }

  function positionGuideMissing() {
    resetGuideTargetGeometry();
    const coach = $('#guideCoach'); coach.style.left = '50%'; coach.style.top = '50%'; coach.style.width = `min(390px, calc(100vw - 24px))`; coach.style.maxHeight = 'calc(100vh - 24px)'; coach.style.transform = 'translate(-50%, -50%)';
  }

  function positionGuideElements() {
    if (!guideSession || guideSession.rendering) return false;
    const target = guideSession.target;
    if (!target?.isConnected) { scheduleGuideRefresh(); return false; }
    const rect = guideVisibleRect(target);
    if (!rect) { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); scheduleGuideRefresh(); return false; }
    const spotlight = $('#guideSpotlight'); spotlight.hidden = false; setGuideRect(spotlight, rect.left, rect.top, rect.width, rect.height);
    setGuideRect($('#guideBlockTop'), 0, 0, innerWidth, rect.top);
    setGuideRect($('#guideBlockBottom'), 0, rect.bottom, innerWidth, innerHeight - rect.bottom);
    setGuideRect($('#guideBlockLeft'), 0, rect.top, rect.left, rect.height);
    setGuideRect($('#guideBlockRight'), rect.right, rect.top, innerWidth - rect.right, rect.height);
    const coach = $('#guideCoach'); coach.style.transform = 'none'; coach.style.visibility = 'hidden'; coach.style.left = '12px'; coach.style.top = '12px'; coach.style.width = `min(390px, calc(100vw - 24px))`; coach.style.maxHeight = 'calc(100vh - 24px)';
    const measured = coach.getBoundingClientRect();
    const position = GuideCore.positionCoach(rect, { width: measured.width || 390, height: measured.height || 260 }, { width: innerWidth, height: innerHeight });
    coach.dataset.placement = position.placement; coach.style.left = `${position.left}px`; coach.style.top = `${position.top}px`; coach.style.width = `${position.width}px`; coach.style.maxHeight = `${position.maxHeight}px`; coach.style.visibility = 'visible';
    return true;
  }

  function publishPositionedGuideStep() {
    if (!guideSession) return;
    $('#guideNext').disabled = false; $('#guidePrevious').disabled = guideSession.stepIndex === 0; $('#guideRetry').disabled = false;
  }

  function scheduleGuideRefresh() {
    if (!guideSession) return;
    cancelAnimationFrame(guideRefreshFrame);
    guideRefreshFrame = requestAnimationFrame(() => {
      guideRefreshFrame = null;
      if (!guideSession || guideSession.rendering || guideSession.advancing || guideSession.simulationComplete || !$('#guideTargetMissing')?.hidden) return;
      const step = guideSession.guide.steps[guideSession.stepIndex];
      const nextTarget = step?.target ? document.querySelector(step.target) : null;
      if (!nextTarget || guideTargetUnavailable(step, nextTarget) || !guideTargetHitTestable(nextTarget)) {
        clearGuideTarget(); void showGuideStep(); return;
      }
      if (nextTarget !== guideSession.target) {
        const previousTarget = guideSession.target; const active = document.activeElement;
        const restoreFocus = !active || active === document.body || previousTarget === active || previousTarget?.contains?.(active);
        attachGuideTarget(nextTarget);
        $('#guideLiveRegion').textContent = `${guideSession.stepIndex + 1}/${guideSession.guide.steps.length}단계의 연습 영역이 새 내용으로 갱신되었습니다.`;
        if (restoreFocus) requestAnimationFrame(() => nextTarget.focus({ preventScroll: true }));
      }
      if (positionGuideElements()) publishPositionedGuideStep();
    });
  }

  function setupGuideObservers() {
    guideMutationObserver?.disconnect(); guideResizeObserver?.disconnect();
    guideMutationObserver = new MutationObserver((records) => {
      if (records.every((record) => record.target === $('#guideLayer') || record.target.closest?.('#guideLayer'))) return;
      scheduleGuideRefresh();
    });
    guideMutationObserver.observe(document.body, { childList: true, subtree: true });
    guideResizeObserver = new ResizeObserver(() => scheduleGuideRefresh());
    window.addEventListener('resize', scheduleGuideRefresh);
    document.addEventListener('scroll', scheduleGuideRefresh, true);
  }

  function cleanupGuideObservers() {
    cancelAnimationFrame(guideRefreshFrame); guideRefreshFrame = null;
    guideMutationObserver?.disconnect(); guideMutationObserver = null;
    guideResizeObserver?.disconnect(); guideResizeObserver = null;
    window.removeEventListener('resize', scheduleGuideRefresh);
    document.removeEventListener('scroll', scheduleGuideRefresh, true);
  }

  function closeGuideTransientDialogs(target = null) {
    const owner = target?.closest?.('dialog') || null;
    $$('dialog[open]').forEach((dialog) => { if (dialog !== owner && dialog.id !== 'guideLibraryDialog') dismissGuideDialog(dialog); });
  }

  function dismissGuideDialog(dialog) {
    if (!dialog?.open) return;
    if (dialog.id === 'confirmDialog') { resolveConfirm(false); return; }
    if (dialog.id === 'nameInputDialog') { resolveNameInput(null); return; }
    if (dialog.id === 'sheetChoiceDialog') { resolveWorkbookSheet(null); return; }
    dialog.close();
  }

  function guideInteractionHint(step) {
    if (step.interaction === 'target') return '강조된 곳을 직접 눌러 다음으로 진행하세요.';
    if (step.interaction === 'simulate') return '강조된 버튼을 눌러 안전한 모의 결과를 확인하세요.';
    if (step.interaction === 'practice') return '강조된 영역에서 직접 연습한 뒤 ‘다음’을 누르세요.';
    return '내용을 확인한 뒤 ‘다음’을 누르세요.';
  }

  async function prepareGuideStep(step) {
    if (step.page === 'documentEditor' && step.documentMode) {
      globalThis.CMOEDocumentToolsUI?.setDocumentMode?.(step.documentMode, { force: true });
    }
    if (step.page === 'projectCalendar') {
      const wantsSessionSurface = /\[data-session|\.pss-/.test(step.target || '');
      const wantsLegacySurface = /\[data-calendar-event|#calendar|\.calendar-/.test(step.target || '');
      if (wantsSessionSurface && calendarSurfaceMode !== 'sessions') {
        calendarSurfaceMode = 'sessions';
        renderProjectCalendarPage();
      } else if (wantsLegacySurface && calendarSurfaceMode !== 'legacy') {
        calendarSurfaceMode = 'legacy';
        renderProjectCalendarPage();
      }
    }
    if (step.prepare === 'schedule-preview') {
      const project = activeProject();
      // Automatic scheduling creates fresh assignment IDs. Anchor the exercise
      // to the stable demo person and choose any other live slot instead.
      const assignment = project?.data.assignments.find((item) => item.personId === 'guide-person-2') || project?.data.assignments[0];
      const destination = project?.data.slots.find((item) => item.status !== 'cancelled' && item.id !== assignment?.slotId);
      if (project && assignment && destination) {
        selectedSessionPersonId = assignment.personId; selectedSessionAssignmentId = assignment.id;
        previewSessionChange(project, { personId: assignment.personId, assignmentId: assignment.id, toSlotId: destination.id });
      }
    }
  }

  async function findGuideTarget(step, token) {
    for (let attempt = 0; attempt < 28; attempt += 1) {
      if (!guideSession || token !== guideSession.transitionToken) return null;
      const target = document.querySelector(step.target);
      if (target) {
        // A selector can exist inside a collapsed <details> while being
        // impossible to click. Open every containing section before measuring.
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
          if (parent.matches?.('details:not([open])')) parent.open = true;
        }
        const owner = target.closest('dialog'); closeGuideTransientDialogs(target);
        if (owner?.open) promoteGuideLayer();
        if (!guideTargetUnavailable(step, target) && guideTargetHitTestable(target)) return target;
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      }
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    return null;
  }

  async function showGuideStep() {
    if (!guideSession) return;
    const session = guideSession; const token = ++session.transitionToken; session.rendering = true; session.simulationComplete = false;
    $('#guideNext').disabled = true; $('#guidePrevious').disabled = true; $('#guideRetry').disabled = true;
    clearGuideTarget(); resetGuideTargetGeometry();
    const step = session.guide.steps[session.stepIndex];
    if (!step) { session.rendering = false; await finishGuide('complete'); return; }
    if (currentPage !== step.page) navigate(step.page);
    await prepareGuideStep(step);
    $('#guideStepTitle').textContent = step.title; $('#guideStepDescription').textContent = step.description;
    $('#guideInteractionHint').textContent = guideInteractionHint(step);
    $('#guideStepCount').textContent = `${session.stepIndex + 1} / ${session.guide.steps.length}`;
    $('#guideProgressBar').style.width = `${((session.stepIndex + 1) / session.guide.steps.length) * 100}%`;
    $('#guideNext').hidden = ['target', 'simulate'].includes(step.interaction);
    $('#guideNext').textContent = session.stepIndex === session.guide.steps.length - 1 ? '가이드 마치기' : '다음';
    $('#guideRetry').hidden = true; $('#guideTargetMissing').hidden = true;
    $('#guideLiveRegion').textContent = `${session.stepIndex + 1}/${session.guide.steps.length}단계. ${step.title}. ${guideInteractionHint(step)} Esc를 누르면 종료합니다.`;
    const target = await findGuideTarget(step, token);
    if (!guideSession || token !== guideSession.transitionToken) return;
    session.rendering = false;
    if (!target) {
      $('#guideTargetMissing').hidden = false; $('#guideRetry').hidden = false; $('#guideNext').hidden = false; $('#guideNext').textContent = '이 단계 건너뛰기';
      $('#guideNext').disabled = false; $('#guidePrevious').disabled = session.stepIndex === 0; $('#guideRetry').disabled = false;
      const missingMessage = `${session.stepIndex + 1}/${session.guide.steps.length}단계의 항목을 찾지 못했습니다. 다시 찾기, 건너뛰기 또는 가이드 종료를 선택하세요.`;
      $('#guideLiveRegion').textContent = missingMessage;
      positionGuideMissing(); requestAnimationFrame(() => $('#guideRetry')?.focus()); return;
    }
    attachGuideTarget(target);
    promoteGuideLayer();
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    // Publish the step as interactive only after the spotlight and four input
    // blockers describe this exact target. Otherwise a fast click (or assistive
    // test) can observe the new target while the previous step still owns the
    // visible and hit-test geometry until the next animation frame.
    if (!positionGuideElements()) { scheduleGuideRefresh(); return; }
    publishPositionedGuideStep();
    requestAnimationFrame(() => {
      if (!guideSession || guideSession.transitionToken !== token) return;
      positionGuideElements();
      try { target.focus({ preventScroll: true }); } catch (_) {}
    });
  }

  async function advanceGuideStep(direction = 1) {
    if (!guideSession || guideSession.advancing) return;
    if (direction > 0 && guideSession.stepIndex >= guideSession.guide.steps.length - 1) { await finishGuide('complete'); return; }
    guideSession.advancing = true;
    guideSession.stepIndex = Math.max(0, Math.min(guideSession.guide.steps.length - 1, guideSession.stepIndex + direction));
    try { await showGuideStep(); } finally { if (guideSession) guideSession.advancing = false; }
  }

  function guideSimulationMessage(name) {
    return ({
      'finish-new-project': '연습 프로젝트가 준비되었습니다. 실제 프로젝트 목록에는 추가하지 않았습니다.',
      'finish-workflow-editor': '연습용 업무 구성을 적용했습니다. 실제 템플릿과 프로젝트는 그대로입니다.',
      'finish-project-settings': '연습용 프로젝트 설정을 확인했습니다.',
      'schedule-generate': '현재 조건으로 일정표를 다시 계산하는 과정을 확인했습니다. 변경은 연습 프로젝트에만 적용됩니다.',
      'google-form': '체험용 Google 설문이 생성된 상태로 표시했습니다. Google에는 아무것도 만들지 않았습니다.',
      'google-responses': '가상 응답을 사람별 가능 시간에 반영했습니다.',
      'calendar-adjustment': '입력한 일정 이동·사람 재배치를 연습 프로젝트에 반영했습니다. 실제 프로젝트는 바뀌지 않았습니다.',
      'export-excel': 'Excel로 저장될 내용을 확인했습니다. 실제 파일은 만들지 않았습니다.',
      'export-csv': 'CSV로 저장될 내용을 확인했습니다. 실제 파일은 만들지 않았습니다.',
      'zoom-meetings': '가이드 일정에 모의 Zoom 회의 상태를 연결했습니다. Zoom API는 호출하지 않았습니다.',
      'gmail-drafts': '받는 사람별 모의 Gmail 초안 상태를 만들었습니다. Gmail에는 저장하지 않았습니다.',
      'connect-service': '가이드용 연결 완료 상태를 확인했습니다. 로그인 창이나 토큰 저장은 실행하지 않았습니다.',
      'drive-push': 'Drive 동기화 과정을 확인했습니다. 실제 업로드나 자료 덮어쓰기는 하지 않았습니다.',
      'document-pptx-files': '샘플 문서 목록을 모의로 추가했습니다.',
      'document-pptx-output': '문서 변환 결과 폴더를 모의로 선택했습니다.',
      'document-pptx-convert': '문서 일괄 변환 상태를 모의로 완료했습니다.',
      'document-certificate-template': '가이드용 문서 양식을 불러왔습니다.',
      'document-certificate-data': '가이드용 문서 정보 표를 모의로 불러왔습니다.',
      'document-certificate-preview': '현재 행의 문서 결과를 모의 미리보기로 확인했습니다.',
      'document-certificate-output': '가이드 문서 결과 폴더를 모의로 선택했습니다.',
      'document-certificate-generate': '행별 문서 일괄 생성 상태를 모의로 완료했습니다.',
      'document-merge-pdf-files': '한국어 샘플 PDF를 목록 순서대로 추가했습니다.',
      'document-merge-pdf-output': 'PDF 결과 이름과 가이드 폴더를 모의로 준비했습니다.',
      'document-merge-pdf-run': '현재 목록 순서대로 PDF 합치기를 모의로 완료했습니다.',
      'document-merge-pptx-files': '한국어 샘플 PPTX를 목록 순서대로 추가했습니다.',
      'document-merge-pptx-output': 'PPTX 결과 이름과 가이드 폴더를 모의로 준비했습니다.',
      'document-merge-pptx-run': '현재 목록 순서대로 PPTX 합치기를 모의로 완료했습니다.',
      'document-merge-documents-files': 'PPTX·HWPX·XLSX 샘플을 목록 순서대로 추가했습니다.',
      'document-merge-documents-output': '여러 문서를 합칠 PDF 이름과 가이드 폴더를 모의로 준비했습니다.',
      'document-merge-documents-run': '서로 다른 문서를 목록 순서대로 PDF 하나에 합친 상태를 모의로 완료했습니다.'
    })[name] || '안전한 모의 동작을 완료했습니다.';
  }

  async function simulateGuideAction(name) {
    const project = activeProject();
    let documentToolResult = null;
    if (String(name || '').startsWith('document-')) {
      if (!globalThis.CMOEDocumentToolsUI?.simulateGuideAction) throw new Error('문서 도구 가이드를 준비하지 못했습니다.');
      documentToolResult = await globalThis.CMOEDocumentToolsUI.simulateGuideAction(name);
      if (documentToolResult?.completed === false) return documentToolResult;
    }
    if (name === 'finish-new-project') { closeDialog('newProjectDialog'); navigate('dashboard'); }
    if (name === 'finish-workflow-editor') { closeDialog('workflowEditorDialog'); renderDashboard(); }
    if (name === 'finish-project-settings') closeDialog('projectSettingsDialog');
    if (name === 'google-form' && project) {
      let linked = project.data.forms.linkedForms[0];
      if (!linked) {
        const now = new Date().toISOString();
        const definition = activeFormDefinition(project, { create: false });
        linked = { formId: 'guide-form', definitionId: definition?.id || '', type: definition?.type || 'availability', source: 'created', setupStatus: 'configured', configuredAt: now, title: definition?.title || '가이드 가능 시간 조사', editUri: '', responderUri: '', connectionId: 'guide-forms', published: true, acceptingResponses: true, responseCount: 0, lastSyncedAt: null, createdAt: now, needsReview: false, responseReviewRequired: false, responseReviewReason: '', availabilitySlotFingerprint: Ops.projectAvailabilitySlotFingerprint?.(project) || '' };
        project.data.forms.linkedForms.push(linked);
      } else { linked.needsReview = false; linked.setupStatus = 'configured'; linked.published = true; linked.acceptingResponses = true; }
      project.data.forms.selectedFormId = linked?.formId || null; state = Core.updateProject(state, project.id, { data: project.data }); renderFormsPage();
    }
    if (name === 'schedule-generate' && project) {
      const generated = Ops.generateSchedule({ people: project.data.people, roles: project.data.roles, slots: project.data.slots, availability: project.data.availability, existingAssignments: project.data.assignments, rules: project.data.scheduleRules, timeZone: CalendarCore.projectTimeZone(project) });
      project.data.assignments = generated.assignments; project.data.conflicts = generated.conflicts;
      state = Core.updateProject(state, project.id, { data: project.data }); renderSchedulePage();
    }
    if (name === 'google-responses' && project) {
      project.data.forms.lastResponseSyncAt = new Date().toISOString();
      const linked = project.data.forms.linkedForms[0];
      if (linked) { linked.lastSyncedAt = project.data.forms.lastResponseSyncAt; linked.responseCount = 3; linked.responseReviewRequired = false; linked.responseReviewReason = ''; }
      project.data.availability['guide-person-3'] = ['guide-slot-future-b', 'guide-slot-future-c'];
      state = Core.updateProject(state, project.id, { data: project.data }); renderFormsPage();
    }
    if (name === 'calendar-adjustment' && project) {
      let result = makeCalendarAdjustmentPlan(project);
      if (!result.changeCount) {
        const source = project.data.slots.find((item) => item.id === calendarAdjustmentDraft?.sourceSlotId);
        if (source) {
          $('#calendarAdjustDate').value = CalendarCore.addDays(source.date, 1);
          $('#calendarAdjustEndDate').value = CalendarCore.addDays(CalendarCore.slotEndDate(source), 1);
          renderCalendarAdjustmentImpact(project);
          result = makeCalendarAdjustmentPlan(project);
        }
      }
      if (!result.changeCount || !result.plan.canApply) {
        const message = '현재 변경안에는 적용할 수 없는 충돌이 있습니다. 영향 확인 내용을 고친 뒤 다시 눌러주세요.';
        showToast(message, 'error'); return { completed: false, message };
      }
      const applied = await applyCalendarAdjustment({ preventDefault() {} }, { guideSimulation: true });
      if (!applied) return { completed: false, message: '변경안을 적용하지 못했습니다. 내용을 확인한 뒤 다시 시도해주세요.' };
    }
    if (name === 'zoom-meetings' && project) {
      const existing = new Set(project.data.externalArtifacts.filter((item) => item.kind === 'zoom').map((item) => item.slotId));
      project.data.slots.filter((slot) => slot.status !== 'cancelled' && !existing.has(slot.id)).forEach((slot) => project.data.externalArtifacts.push({ kind: 'zoom', externalId: `guide-${slot.id}`, slotId: slot.id, connectionId: 'guide-zoom', status: 'created', joinUrl: '', createdAt: new Date().toISOString() }));
      state = Core.updateProject(state, project.id, { data: project.data }); renderZoomPage();
    }
    if (name === 'gmail-drafts' && project) {
      project.data.people.filter((person) => person.email).forEach((person) => project.data.externalArtifacts.push({ kind: 'gmailDraft', externalId: `guide-draft-${person.id}`, personId: person.id, connectionId: 'guide-gmail', status: 'created', createdAt: new Date().toISOString() }));
      state = Core.updateProject(state, project.id, { data: project.data }); renderGmailPage();
    }
    if (name === 'connect-service') {
      const zoom = state.connections.find((item) => item.id === 'guide-zoom'); if (zoom) { zoom.label = '가이드에서 연결됨'; zoom.status = 'connected'; }
      renderConnectionsPage();
    }
    if (name === 'drive-push') $('#driveSyncStatus').textContent = '가이드 모의 동기화 완료 · 실제 Drive에는 업로드하지 않았습니다.';
    const message = documentToolResult?.message || guideSimulationMessage(name); showToast(message, 'success'); return { completed: true, message };
  }

  async function handleGuideSimulationClick(step) {
    if (!guideSession || guideSession.advancing) return;
    guideSession.advancing = true;
    let result;
    try { result = await simulateGuideAction(step.simulation); }
    catch (error) {
      if (!guideSession) return;
      const message = `모의 동작을 완료하지 못했습니다: ${error.message}`;
      guideSession.advancing = false; $('#guideInteractionHint').textContent = message; $('#guideLiveRegion').textContent = message; showToast(message, 'error'); scheduleGuideRefresh(); return;
    }
    if (!guideSession) return;
    const message = result.message;
    $('#guideInteractionHint').textContent = message;
    $('#guideLiveRegion').textContent = message;
    if (!result.completed) { guideSession.advancing = false; scheduleGuideRefresh(); return; }
    if (guideSession.stepIndex === guideSession.guide.steps.length - 1) {
      guideSession.simulationComplete = true; $('#guideNext').hidden = false; $('#guideNext').textContent = '가이드 마치기'; guideSession.advancing = false;
      if (!guideSession.target?.isConnected || !guideTargetHitTestable(guideSession.target)) { clearGuideTarget(); positionGuideMissing(); }
      else positionGuideElements();
      $('#guideNext').focus({ preventScroll: true }); return;
    }
    await new Promise((resolve) => setTimeout(resolve, 520));
    if (guideSession) {
      guideSession.stepIndex += 1;
      try { await showGuideStep(); } finally { if (guideSession) guideSession.advancing = false; }
    }
  }

  function nudgeGuideCoach() {
    const coach = $('#guideCoach'); coach.classList.remove('guide-nudge'); void coach.offsetWidth; coach.classList.add('guide-nudge');
    $('#guideInteractionHint').textContent = '지금은 밝게 강조된 영역만 사용할 수 있습니다.';
  }

  function guideFocusableItems() {
    if (!guideSession) return [];
    const target = guideSession.target; const items = [];
    if (target) {
      if (elementCanFocus(target)) items.push(target);
      const descendants = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])', target);
      const activeInside = target.contains(document.activeElement) && document.activeElement !== target ? document.activeElement : null;
      items.push(...descendants);
      if (activeInside) items.push(activeInside);
    }
    items.push(...$$('button:not([disabled]):not([hidden])', $('#guideCoach')));
    return [...new Set(items)].filter((item) => item.offsetParent !== null || item === document.activeElement);
  }

  function handleGuideKeydown(event) {
    if (!guideSession) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); void finishGuide('escape'); return;
    }
    if (event.key === 'F6') {
      const coach = $('#guideCoach'); const target = guideSession.target;
      const destination = coach.contains(document.activeElement)
        ? target
        : (!$('#guideNext').hidden && !$('#guideNext').disabled ? $('#guideNext') : $('#guideExit'));
      if (destination) { event.preventDefault(); event.stopImmediatePropagation(); destination.focus({ preventScroll: true }); }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = guideFocusableItems(); if (!focusables.length) return;
    const index = focusables.indexOf(document.activeElement); const next = event.shiftKey ? (index <= 0 ? focusables.length - 1 : index - 1) : (index < 0 || index === focusables.length - 1 ? 0 : index + 1);
    event.preventDefault(); event.stopImmediatePropagation(); focusables[next].focus();
  }

  function handleGuideClickCapture(event) {
    if (!guideSession) return;
    const coach = $('#guideCoach'); if (coach.contains(event.target)) return;
    const step = guideSession.guide.steps[guideSession.stepIndex]; const target = guideSession.target;
    if (target?.contains(event.target)) {
      if (step.interaction === 'next') {
        event.preventDefault(); event.stopImmediatePropagation(); nudgeGuideCoach();
        $('#guideInteractionHint').textContent = '이 단계는 화면의 의미를 확인하는 단계입니다. 안내 카드의 ‘다음’을 눌러주세요.'; return;
      }
      if (step.interaction === 'simulate') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!guideSession.simulationComplete) void handleGuideSimulationClick(step);
        return;
      }
      if (step.interaction === 'target' && !guideSession.advancing) {
        guideSession.advancing = true;
        setTimeout(async () => {
          if (!guideSession) return;
          promoteGuideLayer(); guideSession.stepIndex += 1;
          try { await showGuideStep(); } finally { if (guideSession) guideSession.advancing = false; }
        }, 180);
      }
      const protectedAction = event.target.closest('[data-service-connect], [data-connection-authorize], [data-connection-authorization-cancel], [data-connection-disconnect], [data-connection-remove], [data-program-launch], [data-module-toggle], [data-program-shortcut], [data-program-shortcut-remove], [data-document-mode], [data-document-merge-mode], [data-document-split-kind], #openProgramLocation, #installExtensionFile, #openRosterManager, #chooseExcelRoster, #importScheduleExcel, #exportScheduleExcel, #exportArrangementExcel, #pushDriveState, #pullDriveState, #createGoogleForm, #syncFormResponses, #createZoomMeetings, #createGmailDrafts, #exportExcelButton, #exportCsvButton, #documentConversionSource, #choosePptxFiles, #prepareDocumentDependencies, #prepareDocumentMergeDependencies, #documentConversionTargets button, #choosePptxPdfOutput, #runPptxPdf, #openPptxPdfOutput, [data-pptx-result-preview], #chooseCertificateTemplate, #saveCertificateProfile, #importCertificateData, #chooseCertificateOutput, #generateCertificates, #openCertificateOutput, #chooseDocumentMergeFiles, #reverseDocumentMergeFiles, #clearDocumentMergeFiles, #chooseDocumentMergeOutput, #runDocumentMerge, #cancelDocumentMerge, #previewDocumentMergeOutput, #openDocumentMergeOutput, #chooseDocumentSplitFile, #documentSplitMethodEqual, #documentSplitMethodCustom, #documentSplitEqualSize, #addDocumentSplitGroup, #chooseDocumentSplitOutput, #runDocumentSplit, #cancelDocumentSplit, [data-document-split-remove], [data-document-split-preview], #openDocumentSplitOutput');
      const safeDocumentRoutePractice = step.interaction === 'practice' && (
        (step.target === '#documentConversionSource' && protectedAction?.matches('#documentConversionSource'))
        || (step.target === '#documentConversionTargets' && protectedAction?.matches('#documentConversionTargets button'))
      );
      if (protectedAction && !safeDocumentRoutePractice && !['target', 'simulate'].includes(step.interaction)) { event.preventDefault(); event.stopImmediatePropagation(); nudgeGuideCoach(); }
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation(); nudgeGuideCoach();
  }

  function handleGuideSubmitCapture(event) {
    if (!guideSession) return;
    event.preventDefault(); event.stopImmediatePropagation();
    nudgeGuideCoach();
    const message = '가이드에서는 Enter로 양식을 바로 제출하지 않습니다. 안내된 버튼이나 ‘다음’을 사용하세요.';
    $('#guideInteractionHint').textContent = message; $('#guideLiveRegion').textContent = message;
  }

  function currentDocumentToolGuideReadiness() {
    return globalThis.CMOEDocumentToolsUI?.documentToolGuideReadiness?.() || { ready: true, message: '' };
  }

  async function startGuide(guideId) {
    if (guideSession || guideStarting || !GuideCore) return;
    const guide = GuideCore.guideById(guideId); if (!guide) { showToast('선택한 가이드를 찾지 못했습니다.', 'error'); return; }
    const initialDocumentReadiness = currentDocumentToolGuideReadiness();
    if (!initialDocumentReadiness.ready) { showToast(initialDocumentReadiness.message, 'normal'); return; }
    guideStarting = true;
    $$('[data-guide-start]').forEach((button) => { button.disabled = true; });
    try {
      if (globalThis.flushWorkspaceEdits) await globalThis.flushWorkspaceEdits();
      const flushedDocumentReadiness = currentDocumentToolGuideReadiness();
      if (!flushedDocumentReadiness.ready) { showToast(flushedDocumentReadiness.message, 'normal'); return; }
      const latestRealState = Core.normalizeState(await storage.load());
      await globalThis.workspaceDesktop?.setGuideMode?.(true);
      const enteringDocumentReadiness = currentDocumentToolGuideReadiness();
      if (!enteringDocumentReadiness.ready) {
        await globalThis.workspaceDesktop?.setGuideMode?.(false);
        showToast(enteringDocumentReadiness.message, 'normal');
        return;
      }
      closeDialog('guideLibraryDialog');
      guideSession = {
        guide, stepIndex: 0, transitionToken: 0, advancing: false, rendering: false,
        originalPage: currentPage, originalFocus: document.activeElement,
        realStateFallback: cloneState(latestRealState), latestExternalState: null,
        target: null, targetOriginal: null, startedAt: new Date().toISOString()
      };
      clearTimeout(mailDraftTimer); mailDraftTimer = null; clearTimeout(rosterFormulaPersistTimer); rosterFormulaPersistTimer = null; rosterFormulaDraft = null;
      clearTimeout(saveTimer); saveTimer = null;
      clearTimeout(arrangementPersistTimer); arrangementPersistTimer = null; arrangementDrafts.clear();
      clearTimeout(schedulePersistTimer); schedulePersistTimer = null; schedulePersistBaseline = null; schedulePersistProjectId = null;
      clearTimeout(driveSyncTimer); driveSyncTimer = null; driveSyncDirty = false;
      persistDirty = false; persistReconcileNeeded = false; pendingScheduleMergeHints.clear(); deferredWorkspaceState = null;
      mailEditorDirty = false; mailEditorProjectId = null; selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null;
      rosterSelection = null; arrangementSelection = null; scheduleSelection = null; clearRosterHistory(); clearArrangementHistory(); clearScheduleHistory();
      calendarView = 'month'; calendarAnchorDate = ''; calendarProjectId = ''; calendarSelectedSlotId = null; calendarSelectedSessionId = null; calendarSurfaceMode = 'legacy'; calendarAdjustmentDraft = null; calendarDragSelection = null; calendarEventEditor = null;
      state = GuideCore.createDemoState(Core, new Date());
      const documentGuideEntered = globalThis.CMOEDocumentToolsUI?.enterGuideDemo?.(guide.moduleId);
      if (guide.moduleId === 'documentEditor' && documentGuideEntered === false) throw new Error('문서 작업 상태가 바뀌어 가이드를 안전하게 시작할 수 없습니다. 작업이 끝난 뒤 다시 시도해주세요.');
      document.body.classList.add('guide-mode'); $('#saveStatus').textContent = '연습 중 · 저장 안 함';
      renderAll(); navigate(guide.startPage);
      setGuideLayerVisible(true); setupGuideObservers();
      await showGuideStep();
    } catch (error) {
      if (guideSession) await finishGuide('error');
      else {
        await globalThis.workspaceDesktop?.setGuideMode?.(false).catch?.(() => {});
        cleanupGuideObservers(); document.body.classList.remove('guide-mode'); setGuideLayerVisible(false);
      }
      showToast(`가이드를 시작하지 못했습니다: ${error.message}`, 'error');
    } finally {
      guideStarting = false;
      $$('[data-guide-start]').forEach((button) => { button.disabled = false; });
    }
  }

  async function finishGuide(reason = 'exit') {
    if (!guideSession || guideSession.ending) return;
    const session = guideSession; session.ending = true; session.transitionToken += 1;
    cleanupGuideObservers(); clearGuideTarget(); setGuideLayerVisible(false); document.body.classList.remove('guide-mode');
    $$('dialog[open]').forEach((dialog) => dismissGuideDialog(dialog));
    let loaded = null;
    try { await globalThis.workspaceDesktop?.setGuideMode?.(false); } catch (_) {}
    try { loaded = Core.normalizeState(await storage.load()); } catch (_) {}
    const candidates = [session.realStateFallback, loaded, session.latestExternalState].filter(Boolean).map((item) => Core.normalizeState(item));
    let restored = candidates[0] || Core.createEmptyState();
    candidates.slice(1).forEach((candidate) => { if (workspaceStateIsNewer(candidate, restored)) restored = candidate; });
    state = restored; persistedStateBaseline = cloneState(restored); deferredWorkspaceState = null;
    persistDirty = false; persistReconcileNeeded = false; persistReconcileBlocked = false; pendingScheduleMergeHints.clear();
    mailEditorDirty = false; mailEditorProjectId = null; selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null;
    rosterSelection = null; arrangementSelection = null; scheduleSelection = null; calendarAdjustmentDraft = null; calendarDragSelection = null; calendarEventEditor = null;
    const returnPage = session.originalPage || 'settings'; guideSession = null;
    renderAll(); navigate(returnPage);
    globalThis.CMOEDocumentToolsUI?.exitGuideDemo?.();
    $('#saveStatus').textContent = '저장됨';
    const focusTarget = returnPage === 'settings' ? $('#openGuideLibrary') : session.originalFocus;
    setTimeout(() => focusTarget?.focus?.(), 0);
    if (reason !== 'error') showToast(reason === 'complete' ? '가이드를 마쳤습니다. 실제 자료는 그대로입니다.' : '가이드를 종료하고 최신 실제 자료로 돌아왔습니다.', 'success');
  }

  function bindGuideEvents() {
    renderGuideCatalog();
    $('#openGuideLibrary')?.addEventListener('click', openGuideLibrary);
    $('#guideLibraryDialog')?.addEventListener('click', (event) => { const start = event.target.closest('[data-guide-start]'); if (start) void startGuide(start.dataset.guideStart); });
    $('#guideNext')?.addEventListener('click', () => void advanceGuideStep(1));
    $('#guidePrevious')?.addEventListener('click', () => void advanceGuideStep(-1));
    $('#guideRetry')?.addEventListener('click', () => void showGuideStep());
    $('#guideExit')?.addEventListener('click', () => void finishGuide('exit'));
    document.addEventListener('keydown', handleGuideKeydown, true);
    document.addEventListener('click', handleGuideClickCapture, true);
    document.addEventListener('submit', handleGuideSubmitCapture, true);
    globalThis.__workspaceGuide = {
      start: startGuide, finish: finishGuide,
      get active() { return Boolean(guideSession); },
      get starting() { return guideStarting; },
      get guideId() { return guideSession?.guide.id || null; },
      get stepIndex() { return guideSession?.stepIndex ?? -1; },
      get demoProjectId() { return guideSession ? activeProject()?.id || null : null; }
    };
  }

  function renderSettings() {
    $('#storageMode').value = state.preferences.storageMode || 'local';
    $('#workspaceTimezone').value = state.preferences.defaultTimezone || Core.DEFAULT_TIMEZONE;
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
    renderAppUpdate();
  }

  function renderAppUpdate() {
    const status = $('#appVersionStatus'); if (!status) return;
    const install = $('#installAppUpdate'); const cancel = $('#cancelAppUpdate'); const check = $('#checkAppUpdate'); const progress = $('#appUpdateProgress');
    const available = Boolean(appUpdateState.checked?.available); const latest = appUpdateState.checked?.feed?.version || '';
    status.textContent = appUpdateState.error
      ? `현재 ${appUpdateState.currentVersion || '—'} · 확인 실패: ${appUpdateState.error}`
      : appUpdateState.checking ? `현재 ${appUpdateState.currentVersion || '—'} · 새 버전을 확인하고 있습니다…`
      : available ? `현재 ${appUpdateState.currentVersion} · 새 버전 ${latest}`
      : appUpdateState.checked ? `현재 ${appUpdateState.currentVersion} · 최신 버전입니다.`
      : `현재 버전 ${appUpdateState.currentVersion || '확인 중'}`;
    check.disabled = appUpdateState.checking || appUpdateState.installing;
    install.hidden = !available; install.disabled = appUpdateState.installing;
    cancel.hidden = !appUpdateState.installing || appUpdateState.portable;
    cancel.disabled = Boolean(appUpdateState.canceling);
    install.textContent = appUpdateState.portable ? '설치형으로 전환' : appUpdateState.installing ? '업데이트 준비 중…' : '다운로드 후 업데이트';
    progress.hidden = !appUpdateState.progress;
    if (appUpdateState.progress) progress.textContent = `다운로드 ${Math.round(appUpdateState.progress.percent || 0)}% · ${Math.round((appUpdateState.progress.received || 0) / 1024 / 1024)}MB / ${Math.round((appUpdateState.progress.total || 0) / 1024 / 1024)}MB`;
  }

  async function checkAppUpdate({ quiet = false } = {}) {
    if (!globalThis.workspaceDesktop?.checkForUpdates || appUpdateState.checking) return;
    appUpdateState.checking = true; appUpdateState.error = ''; renderAppUpdate();
    try { appUpdateState.checked = await globalThis.workspaceDesktop.checkForUpdates(); appUpdateState.portable = Boolean(appUpdateState.checked.portable); }
    catch (error) { appUpdateState.error = error.message; if (!quiet) showToast(`업데이트를 확인하지 못했습니다: ${error.message}`, 'error'); }
    finally { appUpdateState.checking = false; renderAppUpdate(); }
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
    if (currentPage === 'projectCalendar') renderProjectCalendarPage();
    if (currentPage === 'layout') renderLayoutPage();
    if (currentPage === 'forms') renderFormsPage();
    if (currentPage === 'zoom') renderZoomPage();
    if (currentPage === 'gmailFlow') renderGmailPage();
    if (currentPage === 'documentEditor') globalThis.CMOEDocumentToolsUI?.show('documentEditor');
    if (currentPage === 'workflowTask') renderWorkflowTaskPage();
    if (Core.MODULE_CATALOG.find((item) => item.id === currentPage)?.page === 'declarative') renderDeclarativePage(currentPage);
    scheduleGuideRefresh();
  }

  function resetNewProjectForm() {
    $('#newProjectForm').reset();
    $('#newProjectWorkflowDetails').open = false;
    $('#newProjectTemplateId').value = 'template-blank';
    renderNewProjectTemplates('template-blank');
  }

  function projectSettingsScheduleRoles(project) {
    const roles = project?.data?.roles || [];
    const facilitator = roles.find((role) => role.id === 'coach' || /(코치|coach|진행자|강사)/i.test(role.name));
    const primary = roles.find((role) => role.active !== false && role !== facilitator) || roles.find((role) => role.active !== false) || roles[0] || null;
    return { primary, facilitator };
  }

  function openProjectSettings() {
    const project = activeProject();
    if (!project) return;
    const scheduleRoles = projectSettingsScheduleRoles(project);
    $('#settingsProjectName').value = project.name;
    $('#settingsProjectClient').value = project.client;
    $('#settingsStartDate').value = project.startDate;
    $('#settingsEndDate').value = project.endDate;
    $('#settingsDuration').value = project.settings.sessionDurationMinutes;
    $('#settingsTimezoneOverride').value = project.settings.timezoneOverride || '';
    $('#settingsTimezoneHelp').textContent = project.settings.timezoneOverride
      ? `이 프로젝트는 ${project.settings.timezone} 시간대를 사용합니다.`
      : `Workspace 기본값 ${state.preferences.defaultTimezone || Core.DEFAULT_TIMEZONE}을 사용합니다.`;
    $('#settingsParticipantMinLabel').textContent = `${scheduleRoles.primary?.name || '기본 역할'} · 일정별 최소`;
    $('#settingsParticipantMaxLabel').textContent = `${scheduleRoles.primary?.name || '기본 역할'} · 일정별 최대`;
    $('#settingsParticipantMin').value = scheduleRoles.primary?.minPerSession ?? project.settings.participantMin;
    $('#settingsParticipantMax').value = scheduleRoles.primary?.maxPerSession ?? project.settings.participantMax;
    $('#settingsCoachRequiredRow').hidden = !scheduleRoles.facilitator;
    $('#settingsCoachRequiredLabel').textContent = `${scheduleRoles.facilitator?.name || '진행 역할'}을 일정마다 최소 1명으로 사용`;
    $('#settingsCoachRequired').checked = Boolean(scheduleRoles.facilitator && Number(scheduleRoles.facilitator.minPerSession) >= 1);
    $('#settingsRoleHelp').textContent = scheduleRoles.facilitator
      ? '여기서는 자주 쓰는 기본 인원만 빠르게 바꿉니다. 역할 이름·후보 명단·세부 횟수는 일정 편성 화면에서 설정할 수 있습니다.'
      : '진행자·코치처럼 별도 역할이 필요하면 일정 편성 화면에서 원하는 이름으로 역할을 추가할 수 있습니다.';
    $('#settingsChangeApproval').checked = project.settings.changeApprovalRequired;

    const container = $('#defaultConnectionSelectors');
    container.replaceChildren();
    Core.CONNECTION_TYPES.filter((type) => type.id !== 'drive').forEach((type) => {
      const supportsWorkspaceDefault = ['forms', 'gmail', 'zoom'].includes(type.id);
      const workspaceDefaultId = supportsWorkspaceDefault ? Core.resolveDefaultConnectionId(state, null, type.id) : null;
      const workspaceDefault = state.connections.find((connection) => connection.id === workspaceDefaultId && connection.type === type.id);
      const label = element('label', 'form-field', supportsWorkspaceDefault ? `${type.name} 계정` : `기본 ${type.name} 연결`);
      const select = element('select');
      select.dataset.defaultConnectionType = type.id;
      const none = element('option', '', supportsWorkspaceDefault
        ? (workspaceDefault ? `Workspace 기본값 사용 · ${workspaceDefault.label}` : 'Workspace 기본값 사용 · 아직 선택 안 됨')
        : '지정하지 않음');
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
    assertSmokeUi(Boolean(container.querySelector('[data-default-connection-type="forms"] option')?.textContent.includes('Workspace 기본값 사용')), 'project settings expose the Workspace Forms default with a project exception');
    openDialog('projectSettingsDialog');
  }

  async function switchProject(projectId, options = {}) {
    try {
      if (schedulePersistTimer) await flushSchedulePersist();
      if (mailEditorDirty) await saveMailEditorDraft(mailEditorProjectId);
      const navigationAtStart = navigationGeneration;
      state = Core.setActiveProject(state, projectId);
      rosterSelection = null; rosterHistory = []; rosterFuture = []; arrangementSelection = null; arrangementHistory = []; arrangementFuture = [];
      scheduleSelection = null; clearScheduleHistory(); selectedSessionPersonId = null; selectedSessionAssignmentId = null; pendingSessionChange = null;
      calendarProjectId = ''; calendarSelectedSlotId = null; calendarSelectedSessionId = null; calendarSurfaceMode = 'sessions'; resetCalendarFilters();
      if (options.calendarSessionId) {
        const destinationProject = projectById(projectId); const session = destinationProject?.data?.extensionData?.projectCalendar?.sessions?.find((item) => item.id === options.calendarSessionId);
        calendarProjectId = projectId; calendarSurfaceMode = 'sessions'; calendarSelectedSessionId = session?.id || null;
      }
      if (options.calendarSlotId) {
        const destinationProject = projectById(projectId); const slot = destinationProject?.data.slots.find((item) => item.id === options.calendarSlotId);
        calendarProjectId = projectId; calendarSurfaceMode = 'legacy'; calendarView = 'month'; calendarSelectedSlotId = slot?.id || null;
        calendarAnchorDate = slot?.date ? `${slot.date.slice(0, 7)}-01` : '';
      }
      await persist('프로젝트 전환됨');
      renderAll();
      if (navigationGeneration === navigationAtStart) navigate(options.page || 'dashboard');
    } catch (error) { showToast(error.message, 'error'); }
  }

  function openWorkflowModule(moduleId, options = {}) {
    moduleId = Core.canonicalModuleId?.(moduleId) || moduleId;
    let project = activeProject();
    if (!project) return;
    if (!project.workflow.some((step) => step.moduleId === moduleId)) {
      const definition = Core.workflowTaskCatalog().find((item) => item.moduleId === moduleId);
      if (definition) {
        state = Core.updateProjectWorkflow(state, project.id, [...project.workflow, { type: definition.id, moduleId, name: definition.name, description: definition.description }]);
        project = activeProject();
      }
    }
    const targetStep = project.workflow.find((step) => step.id === options.stepId && step.moduleId === moduleId)
      || (moduleId === 'documentEditor' ? project.workflow.find((step) => step.id === activeWorkflowStepId && step.moduleId === moduleId) : null);
    if (targetStep?.status === 'notStarted') {
      state = Core.setWorkflowStepStatus(state, project.id, targetStep.id, 'inProgress', targetStep.notes || '초기 설정을 시작했습니다.');
      void persist();
      renderAll();
    } else if (!targetStep && project.moduleState[moduleId]?.status === 'notStarted') {
      state = Core.setModuleStatus(state, project.id, moduleId, 'inProgress', '초기 설정을 시작했습니다.');
      void persist();
      renderAll();
    }
    const module = Core.MODULE_CATALOG.find((item) => item.id === moduleId);
    if (Core.MODULE_CATALOG.some((item) => item.id === moduleId && item.page)) {
      navigate(moduleId, { documentMode: options.documentMode || targetStep?.documentMode || '' });
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
      if (!newProjectWorkflowDraft.length) { showToast('프로젝트에는 시작 작업이 하나 이상 필요합니다.', 'error'); return; }
      const selectedTemplate = state.library.workflowTemplates.find((template) => template.id === form.get('templateId'));
      const result = Core.createProject(state, {
        name: form.get('name'),
        client: form.get('client'),
        startDate: form.get('startDate'),
        endDate: form.get('endDate'),
        templateId: form.get('templateId'),
        workflow: newProjectWorkflowDraft,
        workflowTemplate: selectedTemplate ? {
          id: selectedTemplate.id, familyId: selectedTemplate.familyId, version: selectedTemplate.version,
          name: selectedTemplate.name, modified: newProjectWorkflowModified
        } : null
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
    const scheduleRoles = projectSettingsScheduleRoles(project);
    const participantMin = Number($('#settingsParticipantMin').value);
    const participantMax = Number($('#settingsParticipantMax').value);
    if (!Number.isFinite(participantMin) || participantMin < 0 || !Number.isFinite(participantMax) || participantMax < 1) {
      showToast('기본 역할의 최소·최대 인원을 올바르게 입력해주세요.', 'error');
      return;
    }
    if (participantMin > participantMax) {
      showToast(`${scheduleRoles.primary?.name || '기본 역할'}의 최소 인원은 최대 인원보다 클 수 없습니다.`, 'error');
      return;
    }
    const timezoneOverride = $('#settingsTimezoneOverride').value.trim();
    if (timezoneOverride && !Core.isValidTimeZone(timezoneOverride)) {
      showToast('시간대 이름을 확인해주세요. 예: Asia/Seoul, UTC, America/New_York', 'error');
      $('#settingsTimezoneOverride').focus();
      return;
    }
    const defaultConnectionIds = {};
    $$('[data-default-connection-type]').forEach((select) => { defaultConnectionIds[select.dataset.defaultConnectionType] = select.value || null; });
    try {
      const previousName = project.name;
      const previousTimezone = project.settings.timezone;
      const previousEffectiveConnectionIds = {
        forms: defaultConnectionId(project, 'forms'),
        gmail: defaultConnectionId(project, 'gmail'),
        zoom: defaultConnectionId(project, 'zoom')
      };
      if (scheduleRoles.primary) { scheduleRoles.primary.minPerSession = participantMin; scheduleRoles.primary.maxPerSession = Math.max(1, participantMin, participantMax); }
      if (scheduleRoles.facilitator) scheduleRoles.facilitator.minPerSession = $('#settingsCoachRequired').checked ? Math.max(1, Number(scheduleRoles.facilitator.minPerSession) || 0) : 0;
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
          timezoneOverride: timezoneOverride || null,
          coachRequired: Boolean(scheduleRoles.facilitator && $('#settingsCoachRequired').checked),
          changeApprovalRequired: $('#settingsChangeApproval').checked,
          defaultConnectionIds
        }
      });
      const updatedProject = projectById(project.id);
      const nextEffectiveConnectionIds = {
        forms: defaultConnectionId(updatedProject, 'forms'),
        gmail: defaultConnectionId(updatedProject, 'gmail'),
        zoom: defaultConnectionId(updatedProject, 'zoom')
      };
      const formsRouteChanged = previousEffectiveConnectionIds.forms !== nextEffectiveConnectionIds.forms;
      const gmailRouteChanged = previousEffectiveConnectionIds.gmail !== nextEffectiveConnectionIds.gmail;
      const zoomRouteChanged = previousEffectiveConnectionIds.zoom !== nextEffectiveConnectionIds.zoom;
      const timezoneChanged = previousTimezone !== updatedProject.settings.timezone;
      refreshScheduleConflicts(updatedProject);
      const projectNameChanged = previousName !== updatedProject.name;
      let gmailStale = false; let zoomStale = false; let formsNeedsReview = false; let gmailStaleReason = '';
      let routeImpact = null;
      if (projectNameChanged) {
        updatedProject.data.externalArtifacts.forEach((artifact) => {
          if (artifact.status === 'superseded') return;
          if (artifact.kind === 'gmailDraft') { artifact.status = 'stale'; gmailStale = true; gmailStaleReason = '프로젝트 이름 변경 후 Gmail 확인 필요'; }
          if (artifact.kind === 'zoom') { artifact.status = 'stale'; zoomStale = true; }
        });
      }
      if (gmailRouteChanged) {
        gmailStale = supersedeArtifactsForRoute(
          updatedProject,
          'gmailDraft',
          nextEffectiveConnectionIds.gmail,
          () => true,
          '프로젝트 기본 Gmail 계정 변경 후 새 계정으로 다시 생성 필요'
        ) > 0 || gmailStale;
        if (gmailStale) gmailStaleReason = '기본 Gmail 계정 변경 후 새 계정으로 다시 생성 필요';
      }
      if (formsRouteChanged) {
        const formsImpact = protectLinkedFormsForRouteChange(
          updatedProject,
          previousEffectiveConnectionIds.forms,
          nextEffectiveConnectionIds.forms,
          '프로젝트 기본 Google Forms 계정 변경 후 설문 연결 계정 재확인 필요'
        );
        formsNeedsReview = formsImpact.reviewed > 0;
      }
      if (zoomRouteChanged) {
        const inheritedSlotIds = new Set(updatedProject.data.slots.filter((slot) => !slot.zoomConnectionId).map((slot) => slot.id));
        zoomStale = supersedeArtifactsForRoute(
          updatedProject,
          'zoom',
          nextEffectiveConnectionIds.zoom,
          (artifact) => inheritedSlotIds.has(artifact.slotId),
          '프로젝트 기본 Zoom 계정 변경 후 새 계정으로 다시 생성 필요'
        ) > 0 || zoomStale;
        const gmailDependency = staleGmailDraftsForZoomSlots(updatedProject, inheritedSlotIds, '프로젝트 기본 Zoom 계정 변경 후 안내 메일의 회의 링크 재확인 필요');
        if (gmailDependency.changed) { gmailStale = true; if (!gmailRouteChanged) gmailStaleReason = '프로젝트 기본 Zoom 계정 변경 후 안내 메일의 회의 링크 재확인 필요'; }
        routeImpact = { changedSlotIds: [], zoomReviewSlotIds: [...inheritedSlotIds], affectedPersonIds: gmailDependency.personIds };
      }
      if (timezoneChanged) {
        const allSlotIds = updatedProject.data.slots.map((slot) => slot.id);
        const affectedPersonIds = [...new Set(updatedProject.data.assignments.map((assignment) => assignment.personId).filter(Boolean))];
        updatedProject.data.externalArtifacts.forEach((artifact) => {
          if (artifact.status === 'superseded') return;
          if (artifact.kind === 'zoom') { artifact.status = 'stale'; zoomStale = true; }
          if (artifact.kind === 'gmailDraft') { artifact.status = 'stale'; gmailStale = true; gmailStaleReason = '프로젝트 시간대 변경 후 일정과 회의 링크 재확인 필요'; }
        });
        routeImpact = {
          changedSlotIds: [],
          zoomReviewSlotIds: [...new Set([...(routeImpact?.zoomReviewSlotIds || []), ...allSlotIds])],
          affectedPersonIds: [...new Set([...(routeImpact?.affectedPersonIds || []), ...affectedPersonIds])]
        };
      }
      state = Core.updateProject(state, updatedProject.id, { data: updatedProject.data });
      if (updatedProject.data.slots.length) state = Core.setModuleStatus(state, updatedProject.id, 'schedule', updatedProject.data.conflicts.length ? 'needsReview' : 'stale', updatedProject.data.conflicts.length ? `설정 변경 후 일정 문제 ${updatedProject.data.conflicts.length}건` : '프로젝트 설정 변경 후 일정 재검토 필요');
      if (formsNeedsReview && updatedProject.installedModules.includes('forms')) state = Core.setModuleStatus(state, updatedProject.id, 'forms', 'needsReview', '프로젝트 기본 Google Forms 계정 변경 후 설문 연결 계정 재확인 필요');
      if (gmailStale && updatedProject.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, updatedProject.id, 'gmailFlow', 'stale', gmailStaleReason || '안내 메일 확인 필요');
      if (zoomStale && updatedProject.installedModules.includes('zoom')) state = Core.setModuleStatus(state, updatedProject.id, 'zoom', 'stale', timezoneChanged ? '프로젝트 시간대 변경 후 Zoom 일정 재확인 필요' : zoomRouteChanged ? '기본 Zoom 계정 변경 후 새 계정으로 다시 생성 필요' : '프로젝트 이름 변경 후 Zoom 확인 필요');
      recordScheduleMergeImpact(updatedProject.id, routeImpact, { scheduleOnly: false });
      await persist();
      closeDialog('projectSettingsDialog');
      renderAll();
      showToast('프로젝트 설정을 저장했습니다.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function updateDocumentToolWorkflowStatus(moduleId, status, summary, details = {}) {
    moduleId = Core.canonicalModuleId?.(moduleId) || moduleId;
    const projectId = projectLinkedProgram ? linkedProjectId : (!standaloneProgram ? state.activeProjectId : '');
    const project = projectId ? state.projects.find((item) => item.id === projectId) : null;
    if (!project?.workflow.some((step) => step.moduleId === moduleId)) return;
    if (moduleId === 'documentEditor' && Core.normalizeDocumentMode?.(details.documentMode)) {
      const mode = Core.normalizeDocumentMode(details.documentMode);
      const activeStep = project.workflow.find((step) => step.id === activeWorkflowStepId && step.moduleId === moduleId);
      const modeSteps = project.workflow.filter((step) => step.moduleId === moduleId && (!step.documentMode || step.documentMode === mode));
      const targetStep = activeStep || (modeSteps.length === 1 ? modeSteps[0] : modeSteps.find((step) => step.status !== 'complete'));
      state = Core.setDocumentModeStatus(state, project.id, mode, status, summary, targetStep?.id || '');
    } else state = Core.setModuleStatus(state, project.id, moduleId, status, summary);
    await persist(status === 'complete' ? '프로젝트 단계 완료됨' : '프로젝트 단계 확인 필요');
    renderAll();
  }

  async function updateGlobalDefaultConnection(type, connectionId) {
    if (!['forms', 'gmail', 'zoom'].includes(type)) return;
    const serviceLabel = type === 'forms' ? 'Google Forms' : type === 'gmail' ? 'Gmail' : 'Zoom';
    const selected = connectionId ? state.connections.find((connection) => connection.id === connectionId && connection.type === type) : null;
    if (connectionId && !selected) { showToast('선택한 계정 연결을 찾을 수 없습니다.', 'error'); renderConnectionsPage(); return; }
    const inheritedProjects = [
      ...state.projects,
      ...Object.values(state.quickWorkspaces || {}).filter((project) => type === 'forms'
        ? project?.id === 'quick-forms'
        : type === 'gmail'
          ? project?.id === 'quick-gmailFlow'
          : project?.id === 'quick-zoom' || project?.id === 'quick-gmailFlow')
    ].filter((project) => project && !project.settings.defaultConnectionIds[type]);
    const previousRoutes = new Map(inheritedProjects.map((project) => [project.id, defaultConnectionId(project, type)]));
    state.preferences.globalDefaultConnectionIds = {
      ...(state.preferences.globalDefaultConnectionIds || {}),
      [type]: selected?.id || null
    };
    let affectedProjects = 0;
    for (const inheritedProject of inheritedProjects) {
      let project = projectById(inheritedProject.id);
      if (!project) continue;
      const nextConnectionId = defaultConnectionId(project, type);
      if (previousRoutes.get(project.id) === nextConnectionId) continue;
      if (type === 'forms') {
        const formsImpact = protectLinkedFormsForRouteChange(
          project,
          previousRoutes.get(project.id),
          nextConnectionId,
          'Workspace 기본 Google Forms 계정 변경 후 설문 연결 계정 재확인 필요'
        );
        if (formsImpact.changed) {
          state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } });
          project = projectById(project.id);
          if (formsImpact.reviewed && project?.installedModules.includes('forms')) state = Core.setModuleStatus(state, project.id, 'forms', 'needsReview', 'Workspace 기본 Google Forms 계정 변경 후 설문 연결 계정 재확인 필요');
        }
        affectedProjects += 1;
        continue;
      }
      const kind = type === 'gmail' ? 'gmailDraft' : 'zoom';
      const inheritedSlotIds = type === 'zoom' ? new Set(project.data.slots.filter((slot) => !slot.zoomConnectionId).map((slot) => slot.id)) : null;
      const superseded = supersedeArtifactsForRoute(
        project,
        kind,
        nextConnectionId,
        type === 'zoom' ? (artifact) => inheritedSlotIds.has(artifact.slotId) : () => true,
        `Workspace 기본 ${type === 'gmail' ? 'Gmail' : 'Zoom'} 계정 변경 후 새 계정으로 다시 생성 필요`
      );
      const gmailDependency = type === 'zoom'
        ? staleGmailDraftsForZoomSlots(project, inheritedSlotIds, 'Workspace 기본 Zoom 계정 변경 후 안내 메일의 회의 링크 재확인 필요')
        : { changed: 0, personIds: [] };
      if (superseded || gmailDependency.changed) {
        state = Core.updateProject(state, project.id, { data: project.data });
        project = projectById(project.id);
        const moduleId = type === 'gmail' ? 'gmailFlow' : 'zoom';
        if (superseded && project?.installedModules.includes(moduleId)) state = Core.setModuleStatus(state, project.id, moduleId, 'stale', `Workspace 기본 ${type === 'gmail' ? 'Gmail' : 'Zoom'} 계정 변경 후 새 계정으로 다시 생성 필요`);
        if (gmailDependency.changed && project?.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', 'Workspace 기본 Zoom 계정 변경 후 안내 메일의 회의 링크 재확인 필요');
        if (project && !String(project.scope || '').includes('quick')) recordScheduleMergeImpact(project.id, {
          changedSlotIds: [],
          zoomReviewSlotIds: type === 'zoom' ? [...inheritedSlotIds] : [],
          affectedPersonIds: gmailDependency.personIds
        }, { scheduleOnly: false });
      }
      affectedProjects += 1;
    }
    await persist(`Workspace 기본 ${serviceLabel} 계정 변경됨`);
    renderAll();
    const automaticId = !selected ? Core.resolveDefaultConnectionId(state, null, type) : null;
    const automaticConnection = state.connections.find((connection) => connection.id === automaticId && connection.type === type);
    showToast(selected
      ? `${selected.label} 계정을 모든 프로젝트의 기본 ${serviceLabel} 계정으로 저장했습니다.${affectedProjects ? ` 상속 중인 작업 ${affectedProjects}개를 함께 갱신했습니다.` : ''}`
      : automaticConnection
        ? `${automaticConnection.label} 계정만 연결되어 있어 Workspace 기본 ${serviceLabel} 계정으로 자동 사용합니다.`
        : `Workspace 기본 ${serviceLabel} 계정 선택을 해제했습니다.`, 'success');
  }

  function connectionService(type) {
    return Core.CONNECTION_TYPES.find((item) => item.id === type) || { id: type, name: type, provider: type === 'zoom' ? 'Zoom' : 'Google' };
  }

  function isGoogleConnectionConfigError(error, type = '') {
    if (type === 'zoom') return false;
    const message = String(error?.message ?? error ?? '');
    return ['GOOGLE_OAUTH_CONFIG_REQUIRED', 'GOOGLE_OAUTH_BUILD_CONFIG_REQUIRED'].includes(error?.code)
      || /client[_ ]secret|client id|OAuth (?:JSON|관리자 설정)|데스크톱 OAuth|Google Cloud|Google 연결 구성/i.test(message);
  }

  function publicPersistedConnectionError(value, type = '') {
    const message = String(value || '').trim();
    if (isGoogleConnectionConfigError({ message }, type)) return 'Google 로그인 준비 오류';
    return message || '다시 로그인 필요';
  }

  function publicConnectionAuthError(error, type = '') {
    if (isGoogleConnectionConfigError(error, type)) return 'Google 로그인 준비 오류';
    const providerCode = String(error?.oauthProviderCode || error?.code || '').toLowerCase();
    if (error?.code === 'NETWORK_TIMEOUT') return '네트워크 시간 초과';
    if (error?.code === 'AUTHORIZATION_TIMEOUT') return '로그인 시간 초과';
    if (type === 'zoom' && error?.oauthStage === 'authorization_callback' && /unauthorized_client/.test(providerCode)) return 'Zoom 앱 사용 승인 필요';
    if (/취소|거부/.test(String(error?.message || ''))) return '로그인 승인을 완료하지 않음';
    if (type === 'zoom' && error?.oauthStage === 'token_exchange' && /invalid_client|unauthorized_client/.test(providerCode)) return 'Zoom 앱 사용 승인 필요';
    if (type === 'zoom' && error?.oauthStage === 'token_exchange' && /invalid_grant/.test(providerCode)) return 'Zoom 로그인 응답 만료';
    if (type === 'zoom' && error?.oauthStage === 'profile_lookup' && [401, 403].includes(Number(error?.status))) return 'Zoom 계정 권한 확인 필요';
    if (type === 'zoom' && error?.oauthStage === 'credential_persist') return 'Zoom 로그인 정보 저장 실패';
    if (type === 'zoom') return 'Zoom 로그인 확인 필요';
    return '다시 로그인 필요';
  }

  function publicConnectionFailureMessage(error, type = '') {
    if (isGoogleConnectionConfigError(error, type)) return '이 설치본에서 Google 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.';
    if (type === 'zoom' && (error?.code === 'ZOOM_OAUTH_CONFIG_REQUIRED' || /Public Client ID|Zoom 연결 구성/.test(String(error?.message || '')))) return '이 설치본에서 Zoom 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.';
    if (error?.code === 'OAUTH_AUTHORIZATION_URL_REJECTED') return '로그인을 준비하는 중 문제가 발생했습니다. 최신 설치본을 다시 설치해주세요.';
    const providerCode = String(error?.oauthProviderCode || error?.code || '').toLowerCase();
    if (type === 'zoom' && error?.code === 'AUTHORIZATION_TIMEOUT') return 'Zoom 로그인이 5분 안에 완료되지 않았습니다. 다시 연결해 로그인과 권한 승인을 마쳐주세요.';
    if (type === 'zoom' && error?.oauthStage === 'authorization_callback' && /unauthorized_client/.test(providerCode)) return '현재 Zoom 앱이 이 계정에 허용되지 않았습니다. Zoom 앱의 외부 베타 공유 승인을 확인해주세요.';
    if (type === 'zoom' && error?.oauthStage === 'authorization_callback' && /access_denied/.test(providerCode)) return 'Zoom 로그인 또는 권한 승인이 완료되지 않았습니다. 다시 연결해 승인해주세요.';
    if (type === 'zoom' && error?.oauthStage === 'token_exchange' && /invalid_client|unauthorized_client/.test(providerCode)) return '현재 Zoom 앱이 이 계정에 허용되지 않았습니다. 승인된 Zoom 계정으로 로그인하거나 Zoom 앱의 베타 공유 승인을 확인해주세요.';
    if (type === 'zoom' && error?.oauthStage === 'token_exchange' && /invalid_grant/.test(providerCode)) return 'Zoom 로그인 응답이 만료되었거나 이미 사용되었습니다. 계정을 다시 연결해주세요.';
    if (type === 'zoom' && error?.oauthStage === 'profile_lookup' && [401, 403].includes(Number(error?.status))) return 'Zoom 로그인은 받았지만 계정 정보를 확인할 권한이 없습니다. Zoom 앱 권한을 확인한 뒤 다시 로그인해주세요.';
    if (type === 'zoom' && error?.oauthStage === 'credential_persist') return 'Zoom 로그인은 완료됐지만 이 PC의 보안 저장소에 계정 정보를 저장하지 못했습니다. Windows 보안 저장소를 확인한 뒤 다시 시도해주세요.';
    if (['LOGIN_BROWSER_UNAVAILABLE', 'LOGIN_BROWSER_LAUNCH_FAILED'].includes(error?.code)) return '선택한 브라우저를 실행할 수 없습니다. 다른 브라우저를 선택해주세요.';
    if (['LOGIN_BROWSER_PROFILE_NOT_ALLOWED', 'LOGIN_BROWSER_PROFILE_UNAVAILABLE'].includes(error?.code)) return '선택한 브라우저 사용자를 찾을 수 없습니다. 사용자를 다시 선택해주세요.';
    if (error?.code === 'LOGIN_BROWSER_PICKER_UNAVAILABLE') return 'Windows 브라우저 선택 화면을 열 수 없습니다. Chrome이나 Edge를 직접 선택해주세요.';
    return String(error?.message || '잠시 후 다시 시도해주세요.');
  }

  function applyConnectionAuthDiagnostic(connection, error) {
    connection.status = 'error';
    connection.lastAuthError = publicConnectionAuthError(error, connection.type);
    const stage = String(error?.oauthStage || '');
    const code = String(error?.oauthProviderCode || error?.code || '').toUpperCase();
    const status = Number(error?.status);
    if (stage) connection.lastAuthStage = stage; else delete connection.lastAuthStage;
    if (code) connection.lastAuthCode = code; else delete connection.lastAuthCode;
    if (Number.isInteger(status)) connection.lastAuthStatus = status; else delete connection.lastAuthStatus;
    connection.updatedAt = new Date().toISOString();
  }

  async function providerStatus(type, { refresh = false } = {}) {
    if (!refresh && connectionProviderStatuses[type]) return connectionProviderStatuses[type];
    const fallback = { provider: type === 'zoom' ? 'zoom' : 'google', type, ready: type !== 'zoom', requiresPublicClientId: type === 'zoom', requiresClientSecret: false, authMode: 'public-pkce' };
    const status = await (globalThis.workspaceDesktop?.connectionProviderStatus?.(type) || Promise.resolve(fallback));
    connectionProviderStatuses[type] = { ...fallback, ...(status || {}) };
    return connectionProviderStatuses[type];
  }

  async function refreshConnectionProviderStatuses() {
    try {
      await Promise.all(Core.CONNECTION_TYPES.map((service) => providerStatus(service.id, { refresh: true })));
      if (currentPage === 'connections') renderConnectionsPage();
      if (currentPage === 'settings') renderSettings();
    } catch (error) {
      if (smokeDiagnostics) console.warn('계정 제공자 상태를 확인하지 못했습니다.', error);
    }
  }

  async function cancelWorkspaceConnectionAuthorization(connectionId, triggerButton = null) {
    connectionId = String(connectionId || '').trim();
    if (!connectionId || !activeConnectionAuthorizations.has(connectionId) || pendingConnectionAuthorizationCancels.has(connectionId)) return false;
    pendingConnectionAuthorizationCancels.add(connectionId);
    let cancellationAccepted = false;
    if (triggerButton?.isConnected) { triggerButton.disabled = true; triggerButton.textContent = '취소 중'; }
    try {
      const result = await globalThis.workspaceDesktop.cancelConnectionAuthorization(connectionId);
      if (result?.cancelled) {
        cancellationAccepted = true;
        showToast('로그인 취소를 요청했습니다.');
        return true;
      }
      return false;
    } catch (error) {
      showToast(`로그인을 취소하지 못했습니다: ${error.message}`, 'error');
      return false;
    } finally {
      if (!cancellationAccepted || !activeConnectionAuthorizations.has(connectionId)) pendingConnectionAuthorizationCancels.delete(connectionId);
      if (currentPage === 'connections') renderConnectionsPage();
    }
  }

  async function authorizeWorkspaceConnection(connectionId, triggerButton = null, selectedBrowser = null) {
    let connection = state.connections.find((item) => item.id === connectionId); if (!connection) return false;
    const originalButtonText = triggerButton?.textContent || '';
    let reservation = null; let externalStarted = false; let authorizationCompleted = false;
    if (triggerButton) { triggerButton.disabled = true; triggerButton.textContent = '로그인 준비 중'; }
    try {
      const readiness = await providerStatus(connection.type, { refresh: true });
      if (!readiness.ready) {
        showToast(connection.type === 'zoom'
          ? '이 설치본에서 Zoom 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.'
          : '이 설치본에서 Google 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.', 'error');
        return false;
      }
      if (guideSession) {
        connection.status = 'connected';
        connection.account ||= 'guide@example.com';
        ['lastAuthError', 'lastAuthStage', 'lastAuthCode', 'lastAuthStatus'].forEach((key) => delete connection[key]);
        connection.updatedAt = new Date().toISOString();
        renderAll();
        showToast('가이드에서는 실제 브라우저를 열지 않고 로그인 과정을 체험합니다.', 'success');
        return true;
      }
      const browserSelection = selectedBrowser || await chooseLoginBrowser(connection.type);
      if (!browserSelection?.browserId) return false;
      if (triggerButton) triggerButton.textContent = '브라우저 로그인 기다리는 중';
      reservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connectionId]);
      if (!reservation.ok) { showToast('다른 창에서 같은 계정을 연결하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return false; }
      connection = state.connections.find((item) => item.id === connectionId);
      if (!connection) { showToast('다른 창에서 계정 설정이 삭제되었습니다.', 'error'); return false; }
      beginExternalOperation(); externalStarted = true;
      activeConnectionAuthorizations.add(connectionId);
      if (currentPage === 'connections') renderConnectionsPage();
      const status = await globalThis.workspaceDesktop.authorizeConnection(connectionId, {
        loginHint: '',
        selectAccount: true,
        browserId: browserSelection.browserId,
        browserProfileId: browserSelection.browserProfileId || ''
      });
      authorizationCompleted = true;
      if (status?.cancelled) return false;
      if (status?.state) {
        mergePersistedWorkspaceState(status.state);
      } else {
        const applied = Core.applyConnectionAuthorization(state, connectionId, status);
        state = applied.state;
        if (!applied.connection) throw new Error('로그인 중 계정 설정이 삭제되었습니다.');
        await persist();
      }
      connection = state.connections.find((item) => item.id === connectionId);
      if (!connection || status.connectionMissing) {
        if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
        showToast('로그인은 완료됐지만 다른 창에서 계정 설정이 삭제되어 연결하지 않았습니다.', 'error');
        return false;
      }
      if (state.preferences.storageMode === 'drive') scheduleDriveStateSync();
      if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
      if (currentPage === 'connections') renderConnectionsPage();
      showToast(`${connection.account || connection.label} 계정을 연결했습니다. 모든 프로젝트에서 사용할 수 있습니다.`, 'success');
      return true;
    } catch (error) {
      if (error?.code === 'AUTHORIZATION_CANCELLED') return false;
      connection = state.connections.find((item) => item.id === connectionId);
      if (!authorizationCompleted && connection) { applyConnectionAuthDiagnostic(connection, error); await persist(); }
      if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
      if (currentPage === 'connections') renderConnectionsPage();
      showToast(`계정에 로그인하지 못했습니다: ${publicConnectionFailureMessage(error, connection?.type)}`, 'error');
      return false;
    } finally {
      const authorizationWasActive = activeConnectionAuthorizations.delete(connectionId);
      pendingConnectionAuthorizationCancels.delete(connectionId);
      if (reservation?.ok) await releaseExternalArtifacts(reservation.token);
      if (externalStarted) endExternalOperation();
      if (triggerButton?.isConnected) { triggerButton.disabled = false; triggerButton.textContent = originalButtonText; }
      if (authorizationWasActive && currentPage === 'connections') renderConnectionsPage();
    }
  }

  async function startServiceConnection(type, triggerButton = null) {
    const service = connectionService(type);
    const previousState = state;
    let connectionId = '';
    const originalButtonText = triggerButton?.textContent || '';
    if (triggerButton) { triggerButton.disabled = true; triggerButton.textContent = '로그인 준비 중'; }
    try {
      const status = await providerStatus(type, { refresh: true });
      if (!status.ready) {
        showToast(type === 'zoom'
          ? '이 설치본에서 Zoom 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.'
          : '이 설치본에서 Google 로그인을 준비할 수 없습니다. 최신 설치본을 다시 설치해주세요.', 'error');
        return false;
      }
      if (guideSession) return authorizeWorkspaceConnection(state.connections.find((connection) => connection.type === type)?.id || '', triggerButton);
      const browserSelection = await chooseLoginBrowser(type);
      if (!browserSelection?.browserId) return false;
      const result = Core.addConnection(state, {
        type,
        label: `${service.name} 계정`,
        account: '',
        status: 'needsAuth'
      });
      state = result.state;
      connectionId = result.connection.id;
      const config = { provider: type === 'zoom' ? 'zoom' : 'google', type, authMode: 'public-pkce' };
      let reservation = null; let externalStarted = false;
      try {
        reservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connectionId]);
        if (!reservation.ok) throw new Error('다른 창에서 같은 계정 설정을 처리하고 있습니다.');
        beginExternalOperation(); externalStarted = true;
        await globalThis.workspaceDesktop.configureConnection(connectionId, config);
        delete connectionProviderStatuses[type];
      } finally { if (reservation?.ok) await releaseExternalArtifacts(reservation.token); if (externalStarted) endExternalOperation(); }
      await persist('전역 계정 연결 시작됨');
      renderAll();
      if (currentPage === 'connections') renderConnectionsPage();
      const connected = await authorizeWorkspaceConnection(connectionId, null, browserSelection);
      const pendingConnection = state.connections.find((connection) => connection.id === connectionId);
      if (!connected && pendingConnection?.status === 'needsAuth' && !pendingConnection.lastAuthError) {
        state = previousState;
        await globalThis.workspaceDesktop.removeConnection(connectionId).catch(() => {});
        await persist('계정 연결 취소됨').catch(() => {});
        renderAll();
        return false;
      }
      if (connected) {
        await providerStatus(type, { refresh: true });
        if (currentPage === 'connections') {
          renderConnectionsPage();
          setTimeout(() => $(`[data-service-card="${type}"] .service-connection-status`)?.focus?.());
        }
      }
      return connected;
    } catch (error) {
      if (connectionId) {
        state = previousState;
        await globalThis.workspaceDesktop.removeConnection(connectionId).catch(() => {});
        await persist('계정 연결 준비 취소됨').catch(() => {});
      }
      showToast(publicConnectionFailureMessage(error, type), 'error');
      return false;
    } finally {
      if (triggerButton?.isConnected) { triggerButton.disabled = false; triggerButton.textContent = originalButtonText; }
    }
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
    const result = Ops.matrixToRoster(matrix, { roles: project.data.roles });
    clearRosterHistory();
    clearScheduleHistory(project.id);
    project.data.columns = result.columns; project.data.people = result.people; reconcileRosterViewsAfterReplacement(project); project.data.availability = {}; project.data.assignments = []; project.data.activityAssignments = [];
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
      person.roleIds = Ops.normalizePersonRoleIds(person.roleIds, project.data.roles);
    });
    syncPersonDerivedFields(project); reconcileRosterViewsAfterReplacement(project); project.data.availability = {}; project.data.assignments = []; project.data.activityAssignments = [];
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
      rules: project.data.scheduleRules,
      timeZone: CalendarCore.projectTimeZone(project)
    });
    const nextAssignmentIds = new Set(result.assignments.map((assignment) => assignment.id)); const removedAssignmentIds = new Set(project.data.assignments.filter((assignment) => !nextAssignmentIds.has(assignment.id)).map((assignment) => assignment.id));
    project.data.assignments = result.assignments;
    const removedActivityLinks = removeActivityAssignmentLinks(project, { assignmentIds: removedAssignmentIds }) + pruneActivityAssignmentsAfterCalendarChange(project);
    refreshScheduleConflicts(project);
    const assignmentSignature = (items, slotId) => items.filter((item) => item.slotId === slotId).map((item) => `${item.personId}|${item.roleId}`).sort().join(',');
    const changedSlotIds = project.data.slots.filter((slot) => assignmentSignature(beforeAssignments, slot.id) !== assignmentSignature(result.assignments, slot.id)).map((slot) => slot.id);
    const zoomReviewSlotIds = changedSlotIds.filter((slotId) => (beforeAssignments.some((item) => item.slotId === slotId)) !== (result.assignments.some((item) => item.slotId === slotId)));
    const affectedPersonIds = [...new Set([...beforeAssignments, ...result.assignments].filter((item) => changedSlotIds.includes(item.slotId)).map((item) => item.personId).filter(Boolean))];
    markScheduleChangeStale(project, { changedSlotIds, zoomReviewSlotIds, affectedPersonIds });
    syncScheduleProjectState(project, `시간대 ${project.data.slots.length}개 · 확인할 문제 ${project.data.conflicts.length}건${removedActivityLinks ? ` · 진행 담당 ${removedActivityLinks}건 재확인` : ''}`, { changedSlotIds, zoomReviewSlotIds, affectedPersonIds });
    await persist(); renderAll();
    showToast(project.data.conflicts.length ? `일정표를 만들었습니다. 확인할 문제가 ${project.data.conflicts.length}건 있습니다.${replacing ? ' 이전 일정은 자동 백업했습니다.' : ''}` : `조건에 맞춰 일정표를 만들었습니다.${replacing ? ' 이전 일정은 자동 백업했습니다.' : ''}`, project.data.conflicts.length ? 'normal' : 'success');
  }

  function createScheduleVersion(project, name = `일정 ${project.data.versions.length + 1}차`) {
    return {
      id: `version-${Date.now().toString(36)}`,
      name,
      createdAt: new Date().toISOString(),
      slots: JSON.parse(JSON.stringify(project.data.slots)),
      activities: JSON.parse(JSON.stringify(project.data.activities || [])),
      assignments: JSON.parse(JSON.stringify(project.data.assignments)),
      activityAssignments: JSON.parse(JSON.stringify(project.data.activityAssignments || [])),
      availability: JSON.parse(JSON.stringify(project.data.availability)),
      scheduleSheetInitialized: Boolean(project.data.scheduleSheetInitialized),
      scheduleSheetColumns: JSON.parse(JSON.stringify(project.data.scheduleSheetColumns || [])),
      scheduleCustomValues: JSON.parse(JSON.stringify(project.data.scheduleCustomValues || {})),
      projectCalendar: JSON.parse(JSON.stringify(project.data.extensionData?.projectCalendar || {})),
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
    const entry = buildWorkspaceMailPackage(project).entries.find((item) => item.personId === personId); if (!entry) return;
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

  function closeSheetContextMenu({ restoreFocus = false } = {}) {
    const menu = $('#sheetContextMenu'); if (!menu || menu.hidden) return;
    const origin = sheetContextOrigin; menu.hidden = true; menu.replaceChildren(); menu.removeAttribute('data-sheet-kind'); sheetContextOrigin = null;
    if (restoreFocus && origin?.isConnected) origin.focus?.({ preventScroll: true });
  }

  function sheetPointInsideSelection(point, selection) {
    if (!point || !selection) return false;
    return point.row >= Math.min(selection.anchor.row, selection.focus.row)
      && point.row <= Math.max(selection.anchor.row, selection.focus.row)
      && point.col >= Math.min(selection.anchor.col, selection.focus.col)
      && point.col <= Math.max(selection.anchor.col, selection.focus.col);
  }

  function sheetContextItems(kind) {
    const common = [
      { action: 'copy', label: '선택 범위 복사', shortcut: 'Ctrl+C' },
      { action: 'cut', label: '선택 범위 잘라내기', shortcut: 'Ctrl+X' },
      { separator: true },
      { action: 'clear', label: '선택 셀 내용 지우기', shortcut: 'Del' }
    ];
    if (kind === 'schedule') return [...common, { separator: true }, { action: 'undo', label: '실행 취소', shortcut: 'Ctrl+Z' }, { action: 'redo', label: '다시 실행', shortcut: 'Ctrl+Y' }, { separator: true }, { action: 'insert-column', label: '새 컬럼 추가' }];
    return [...common, { action: 'fill-down', label: '맨 위 값을 아래로 채우기' }, { separator: true }, { action: 'insert-row', label: '선택 위치에 행 삽입' }, { action: 'delete-rows', label: '선택한 행 삭제' }, { action: 'insert-column', label: '선택 위치에 컬럼 삽입' }, { action: 'delete-columns', label: '선택한 컬럼 삭제' }];
  }

  function runSheetContextAction(kind, action) {
    const origin = sheetContextOrigin; closeSheetContextMenu();
    const cell = origin?.closest?.('td, th') || origin;
    if (cell?.isConnected) { if (!cell.hasAttribute('tabindex')) cell.tabIndex = -1; cell.focus?.({ preventScroll: true }); }
    if (action === 'copy' || action === 'cut') { document.execCommand(action); return; }
    const actionButtons = {
      roster: { clear: 'rosterClearSelection', 'fill-down': 'rosterFillDown', 'insert-row': 'rosterInsertRow', 'delete-rows': 'rosterDeleteRows', 'insert-column': 'rosterInsertColumn', 'delete-columns': 'rosterDeleteColumns' },
      arrangement: { clear: 'arrangementClearSelection', 'fill-down': 'arrangementFillDown', 'insert-row': 'arrangementInsertRow', 'delete-rows': 'arrangementDeleteRows', 'insert-column': 'arrangementInsertColumn', 'delete-columns': 'arrangementDeleteColumns' },
      schedule: { undo: 'scheduleUndo', redo: 'scheduleRedo' }
    };
    if (kind === 'schedule' && action === 'clear') { cell?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); return; }
    if (kind === 'schedule' && action === 'insert-column') { $('#scheduleBoard [data-schedule-add-column-inline]')?.click(); return; }
    const buttonId = actionButtons[kind]?.[action]; if (buttonId) $(`#${buttonId}`)?.click();
  }

  function openSheetContextMenu(kind, event, point, selection, updateSelection) {
    if (guideSession || !point) return;
    event.preventDefault(); event.stopPropagation();
    if (!sheetPointInsideSelection(point, selection)) updateSelection(point, point, 'cells');
    const menu = $('#sheetContextMenu'); if (!menu) return;
    closeSheetContextMenu(); sheetContextOrigin = event.target;
    sheetContextItems(kind).forEach((item) => {
      if (item.separator) { const separator = element('div', 'sheet-context-separator'); separator.setAttribute('role', 'separator'); menu.append(separator); return; }
      const button = element('button'); button.type = 'button'; button.dataset.sheetContextAction = item.action; button.setAttribute('role', 'menuitem'); button.append(element('span', '', item.label));
      if (item.shortcut) button.append(element('kbd', '', item.shortcut));
      if (item.action === 'undo') button.disabled = $('#scheduleUndo')?.disabled;
      if (item.action === 'redo') button.disabled = $('#scheduleRedo')?.disabled;
      menu.append(button);
    });
    menu.dataset.sheetKind = kind; menu.hidden = false;
    const originRect = event.target.getBoundingClientRect(); const menuRect = menu.getBoundingClientRect();
    const requestedX = event.clientX || originRect.left + Math.min(originRect.width, 24); const requestedY = event.clientY || originRect.bottom;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menuRect.width - 8, requestedX))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - menuRect.height - 8, requestedY))}px`;
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  function bindEvents() {
    bindGuideEvents();
    bindRichEditor($('#mailBodyEditor')); bindRichEditor($('#mailEditBody'));
    $('#sheetContextMenu').addEventListener('click', (event) => {
      const action = event.target.closest('[data-sheet-context-action]'); if (!action || action.disabled) return;
      runSheetContextAction($('#sheetContextMenu').dataset.sheetKind, action.dataset.sheetContextAction);
    });
    $('#sheetContextMenu').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeSheetContextMenu({ restoreFocus: true }); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = $$('button:not(:disabled)', $('#sheetContextMenu')); if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement); let index = current;
      if (event.key === 'Home') index = 0; else if (event.key === 'End') index = buttons.length - 1; else index = (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[index].focus();
    });
    document.addEventListener('pointerdown', (event) => { if (!$('#sheetContextMenu').hidden && !$('#sheetContextMenu').contains(event.target)) closeSheetContextMenu(); }, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#sheetContextMenu').hidden) { event.preventDefault(); closeSheetContextMenu({ restoreFocus: true }); } }, true);
    document.addEventListener('scroll', () => closeSheetContextMenu(), true);
    globalThis.addEventListener('resize', () => closeSheetContextMenu());
    const setCalendarView = async (view) => {
      const project = activeProject(); if (!project || !['month', 'week'].includes(view) || calendarView === view) return; calendarView = view;
      const today = CalendarCore.dateKeyInTimeZone(new Date(), CalendarCore.projectTimeZone(project)); const selectedDate = project.data.slots.find((slot) => slot.id === calendarSelectedSlotId)?.date;
      if (view === 'week') calendarAnchorDate = CalendarCore.isValidDateKey(selectedDate) ? selectedDate : calendarAnchorDate?.slice(0, 7) === today?.slice(0, 7) ? today : calendarAnchorDate || today;
      else calendarAnchorDate = `${(calendarAnchorDate || today).slice(0, 7)}-01`;
      project.data.extensionData ||= {}; project.data.extensionData.projectCalendar ||= {}; project.data.extensionData.projectCalendar.view = view; state = Core.updateProject(state, project.id, { data: project.data }); renderProjectCalendarPage(); await persist('캘린더 보기 저장됨');
    };
    $('#dashboardCalendarPrevious').addEventListener('click', () => { dashboardCalendarAnchorDate = shiftCalendarAnchor(dashboardCalendarAnchorDate, -1, 'month'); renderDashboardCalendar(); });
    $('#dashboardCalendarNext').addEventListener('click', () => { dashboardCalendarAnchorDate = shiftCalendarAnchor(dashboardCalendarAnchorDate, 1, 'month'); renderDashboardCalendar(); });
    $('#dashboardCalendarToday').addEventListener('click', () => { const today = CalendarCore.dateKeyInTimeZone(new Date(), state.preferences?.defaultTimezone || 'Asia/Seoul'); dashboardCalendarAnchorDate = `${today.slice(0, 7)}-01`; renderDashboardCalendar(); });
    $('#dashboardCalendarProjectFilter').addEventListener('change', renderDashboardCalendar);
    $('#dashboardCalendarGrid').addEventListener('click', (event) => {
      const more = event.target.closest('[data-dashboard-calendar-show-day]');
      if (more) { const date = more.dataset.dashboardCalendarShowDay; if (dashboardCalendarExpandedDates.has(date)) dashboardCalendarExpandedDates.delete(date); else dashboardCalendarExpandedDates.add(date); renderDashboardCalendar(); return; }
      const item = event.target.closest('[data-dashboard-calendar-project][data-dashboard-calendar-session], [data-dashboard-calendar-project][data-dashboard-calendar-slot]');
      if (item?.dataset.dashboardCalendarSession) void switchProject(item.dataset.dashboardCalendarProject, { page: 'projectCalendar', calendarSessionId: item.dataset.dashboardCalendarSession });
      else if (item) void switchProject(item.dataset.dashboardCalendarProject, { page: 'projectCalendar', calendarSlotId: item.dataset.dashboardCalendarSlot });
    });
    $('#calendarMonthView').addEventListener('click', () => void setCalendarView('month'));
    $('#calendarWeekView').addEventListener('click', () => void setCalendarView('week'));
    $('#calendarShowSessions').addEventListener('click', () => { calendarSurfaceMode = 'sessions'; calendarSelectedSlotId = null; calendarSelectedSessionId = null; sessionSchedulerController?.showOverview?.(); renderProjectCalendarPage(); });
    $('#calendarPrevious').addEventListener('click', () => { const project = activeProject(); if (!project) return; calendarAnchorDate = shiftCalendarAnchor(calendarAnchorDate, -1); renderProjectCalendarPage(); });
    $('#calendarNext').addEventListener('click', () => { const project = activeProject(); if (!project) return; calendarAnchorDate = shiftCalendarAnchor(calendarAnchorDate, 1); renderProjectCalendarPage(); });
    $('#calendarToday').addEventListener('click', () => { const project = activeProject(); if (!project) return; const today = CalendarCore.dateKeyInTimeZone(new Date(), CalendarCore.projectTimeZone(project)); calendarAnchorDate = calendarView === 'month' ? `${today.slice(0, 7)}-01` : today; renderProjectCalendarPage(); });
    $('#calendarSearch').addEventListener('input', () => { const project = activeProject(); if (project) { renderProjectCalendarGrid(project); renderCalendarDetail(project); } });
    $('#calendarRoleFilter').addEventListener('change', () => { const project = activeProject(); if (project) { renderProjectCalendarGrid(project); renderCalendarDetail(project); } });
    $('#calendarHideCancelled').addEventListener('change', () => { const project = activeProject(); if (project) { renderProjectCalendarGrid(project); renderCalendarDetail(project); } });
    $('#calendarResetFilters').addEventListener('click', () => { const project = activeProject(); if (!project) return; resetCalendarFilters({ showCancelled: true }); renderProjectCalendarPage(); $('#calendarSearch').focus(); });
    $('#calendarAddEvent').addEventListener('click', () => addCalendarEvent());
    $('#scheduleAddEventButton').addEventListener('click', () => addCalendarEvent());
    $('#calendarUndo').addEventListener('click', () => void moveScheduleHistory(activeProject(), true));
    $('#calendarRedo').addEventListener('click', () => void moveScheduleHistory(activeProject(), false));
    $('#calendarDetailClose').addEventListener('click', () => closeCalendarDetail());
    $('#calendarEditEvent').addEventListener('click', () => openCalendarEventEditor({ slotId: calendarSelectedSlotId, sourcePage: currentPage }));
    $('#calendarAddActivity').addEventListener('click', () => openCalendarActivityDialog());
    $('#calendarAdjustEvent').addEventListener('click', openCalendarAdjustment);
    $('#calendarCancelEvent').addEventListener('click', () => void cancelCalendarEvent());
    $('#calendarDuplicateEvent').addEventListener('click', () => void duplicateCalendarEvent());
    $('#calendarActivityForm').addEventListener('submit', (event) => void saveCalendarActivity(event));
    $('#calendarActivityStartDate').addEventListener('input', (event) => { if ($('#calendarActivityEndDate').value < event.target.value) $('#calendarActivityEndDate').value = event.target.value; });
    $('#calendarEventForm').addEventListener('submit', (event) => void saveCalendarEvent(event));
    ['calendarEventStartDate', 'calendarEventEndDate', 'calendarEventStartTime', 'calendarEventEndTime'].forEach((id) => $(`#${id}`).addEventListener('input', (event) => { if (id === 'calendarEventStartDate' && $('#calendarEventEndDate').value && $('#calendarEventEndDate').value < event.target.value) $('#calendarEventEndDate').value = event.target.value; renderCalendarEventRangeSummary(); }));
    $$('.calendar-time-presets [data-calendar-duration]').forEach((button) => button.addEventListener('click', () => applyCalendarEventDuration(Number(button.dataset.calendarDuration))));
    $$('.calendar-time-presets [data-calendar-time-preset]').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.calendarTimePreset === 'workday') { $('#calendarEventStartTime').value = '09:00'; $('#calendarEventEndTime').value = '18:00'; }
      if (button.dataset.calendarTimePreset === 'same-day') { $('#calendarEventEndDate').value = $('#calendarEventStartDate').value; if (CalendarCore.timeToMinutes($('#calendarEventEndTime').value) <= CalendarCore.timeToMinutes($('#calendarEventStartTime').value)) applyCalendarEventDuration(activeProject()?.settings?.sessionDurationMinutes || 60); }
      renderCalendarEventRangeSummary();
    }));
    $('#calendarDeleteActivity').addEventListener('click', () => void deleteCalendarActivity());
    $('#calendarAdjustmentForm').addEventListener('submit', (event) => void applyCalendarAdjustment(event));
    ['calendarAdjustDate', 'calendarAdjustStart', 'calendarAdjustEndDate', 'calendarAdjustEnd'].forEach((id) => $(`#${id}`).addEventListener('input', () => { const project = activeProject(); if (project && calendarAdjustmentDraft) renderCalendarAdjustmentImpact(project); }));
    $('#calendarAdjustAddPersonButton').addEventListener('click', addCalendarAdjustmentPerson);
    $('#calendarRelatedSearch').addEventListener('input', () => { const project = activeProject(); if (project && calendarAdjustmentDraft) renderCalendarRelatedEvents(project); });
    $('#calendarRelatedEvents').addEventListener('change', (event) => { const input = event.target.closest('[data-calendar-related-event]'); if (input) handleCalendarRelatedEvent(input.value, input.checked); });
    $('#calendarAdjustmentAssignments').addEventListener('change', (event) => {
      const project = activeProject(); if (!project || !calendarAdjustmentDraft) return;
      if (event.target.matches('[data-calendar-adjust-target]')) calendarAdjustmentDraft.assignmentTargets[event.target.dataset.calendarAdjustTarget] = event.target.value;
      if (event.target.matches('[data-calendar-adjust-role]')) calendarAdjustmentDraft.assignmentRoles[event.target.dataset.calendarAdjustRole] = event.target.value;
      if (event.target.matches('[data-calendar-adjust-addition-target]')) { const addition = calendarAdjustmentDraft.additions.find((item) => item.id === event.target.dataset.calendarAdjustAdditionTarget); if (addition && event.target.value === '__remove__') calendarAdjustmentDraft.additions = calendarAdjustmentDraft.additions.filter((item) => item.id !== addition.id); else if (addition) addition.toSlotId = event.target.value; }
      renderCalendarAdjustmentAssignments(project);
    });
    const projectCalendarGrid = $('#projectCalendarGrid');
    projectCalendarGrid.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button, input, select, textarea, a, summary')) return; const day = event.target.closest('[data-calendar-date]'); if (!day) return;
      calendarDragSelection = { pointerId: event.pointerId, startDate: day.dataset.calendarDate, endDate: day.dataset.calendarDate, moved: false }; projectCalendarGrid.setPointerCapture?.(event.pointerId); updateCalendarDragHighlight(); event.preventDefault();
    });
    projectCalendarGrid.addEventListener('pointermove', (event) => {
      if (!calendarDragSelection || calendarDragSelection.pointerId !== event.pointerId) return; const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-calendar-date]'); if (!hit || !projectCalendarGrid.contains(hit)) return;
      if (hit.dataset.calendarDate !== calendarDragSelection.endDate) { calendarDragSelection.endDate = hit.dataset.calendarDate; calendarDragSelection.moved = true; updateCalendarDragHighlight(); }
    });
    const finishCalendarDrag = (event, cancelled = false) => {
      if (!calendarDragSelection || calendarDragSelection.pointerId !== event.pointerId) return; const selection = calendarDragSelection; calendarDragSelection = null; try { if (projectCalendarGrid.hasPointerCapture?.(event.pointerId)) projectCalendarGrid.releasePointerCapture(event.pointerId); } catch (_) {} updateCalendarDragHighlight();
      if (!cancelled) { const range = CalendarCore.orderedDateRange(selection.startDate, selection.endDate); if (range) addCalendarEvent(range.start, range.end); }
    };
    projectCalendarGrid.addEventListener('pointerup', (event) => finishCalendarDrag(event));
    projectCalendarGrid.addEventListener('pointercancel', (event) => finishCalendarDrag(event, true));
    projectCalendarGrid.addEventListener('click', (event) => {
      const eventButton = event.target.closest('[data-calendar-event]'); if (eventButton) { selectCalendarEvent(eventButton.dataset.calendarEvent, eventButton); return; }
      const add = event.target.closest('[data-calendar-add-date]'); if (add) { addCalendarEvent(add.dataset.calendarAddDate); return; }
      const day = event.target.closest('[data-calendar-show-day]'); if (day) { calendarView = 'week'; calendarAnchorDate = day.dataset.calendarShowDay; renderProjectCalendarPage(); }
    });
    projectCalendarGrid.addEventListener('dblclick', (event) => { const eventButton = event.target.closest('[data-calendar-event]'); if (eventButton) openCalendarEventEditor({ slotId: eventButton.dataset.calendarEvent, sourcePage: currentPage }); });
    $('#projectCalendarGrid').addEventListener('keydown', (event) => {
      const control = event.target.closest('[data-calendar-event], [data-calendar-add-date], [data-calendar-show-day]'); const day = control?.closest('[data-calendar-date]');
      if (!control || !day || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 })[event.key]; const targetDate = CalendarCore.addDays(day.dataset.calendarDate, offset); const targetDay = $(`[data-calendar-date="${targetDate}"]`, $('#projectCalendarGrid')); if (!targetDay) return;
      let target = null;
      if (control.matches('[data-calendar-event]')) { const sourceEvents = $$('[data-calendar-event]', day); const eventIndex = Math.max(0, sourceEvents.indexOf(control)); const targetEvents = $$('[data-calendar-event]', targetDay); target = targetEvents[eventIndex] || targetEvents[0] || $('[data-calendar-add-date]', targetDay); }
      else if (control.matches('[data-calendar-show-day]')) target = $('[data-calendar-show-day]', targetDay) || $('[data-calendar-event]', targetDay) || $('[data-calendar-add-date]', targetDay);
      else target = $('[data-calendar-add-date]', targetDay);
      if (target) { event.preventDefault(); target.focus(); }
    });
    $('#calendarDetail').addEventListener('click', (event) => {
      const edit = event.target.closest('[data-calendar-edit-activity]'); if (edit) { openCalendarActivityDialog(edit.dataset.calendarEditActivity); return; }
      const link = event.target.closest('[data-calendar-open-url]'); if (link) { const url = link.dataset.calendarOpenUrl; if (!/^https?:\/\//i.test(url || '')) { showToast('안전한 외부 회의 주소가 아닙니다.', 'error'); return; } if (globalThis.workspaceDesktop?.openExternal) void globalThis.workspaceDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer'); }
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && currentPage === 'projectCalendar' && !document.querySelector('dialog[open]') && !$('#calendarDetail').hidden) { event.preventDefault(); closeCalendarDetail(); } });
    $$('[data-calendar-empty-add]').forEach((button) => button.addEventListener('click', () => void addCalendarEvent()));
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
    document.addEventListener('focusin', (event) => { if (pendingMergedFormsRender && event.target.closest?.('.form-editor-shell')) scheduleMergedFormsRefresh(); }, true);
    document.addEventListener('beforeinput', (event) => {
      if (!pendingMergedFormsRender || !event.target.closest?.('.form-editor-shell')) return;
      event.preventDefault(); scheduleMergedFormsRefresh();
    }, true);
    document.addEventListener('click', (event) => {
      if (!pendingMergedFormsRender || !event.target.closest?.('.form-editor-shell')) return;
      event.preventDefault(); event.stopImmediatePropagation(); scheduleMergedFormsRefresh();
    }, true);
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
    rosterTable.addEventListener('contextmenu', (event) => {
      const cell = event.target.closest('[data-sheet-row][data-sheet-col]'); if (!cell) return;
      openSheetContextMenu('roster', event, { row: Number(cell.dataset.sheetRow), col: Number(cell.dataset.sheetCol) }, rosterSelection, updateRosterSelection);
    });
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
      const project = activeProject(); if (!project) return; const matrix = project.data.columns.length ? Ops.parseDelimited(text, { inferVertical: false }) : Ops.analyzeRosterInput(text).matrix; if (!matrix.length) return;
      if (!project.data.columns.length) {
        if (!event.target.closest('[data-empty-roster-paste-anchor="true"]')) return;
        event.preventDefault();
        const structured = matrix.length > 1 || matrix.some((row) => row.length > 1);
        if (!structured) { showToast('한 셀 값만 입력하려면 먼저 컬럼을 추가하세요.'); return; }
        const confirmedMatrix = await showRosterImportPreview({ matrix, format: 'clipboard', inferred: matrix[0]?.length > 1, warnings: matrix[0]?.length > 1 ? ['붙여넣은 내용을 자동으로 나눴습니다. 열과 빈칸을 확인해주세요.'] : [] }, '명단 셀에 붙여넣은 내용');
        if (confirmedMatrix?.length) { clearRosterHistory(); await applyRosterMatrix(confirmedMatrix); }
        return;
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
      const columnSelector = event.target.closest('[data-select-roster-column]'); const rowSelector = event.target.closest('[data-select-roster-row]'); const allSelector = event.target.closest('[data-select-roster-all]');
      if (['Enter', ' '].includes(event.key) && (columnSelector || rowSelector || allSelector) && project.data.columns.length) {
        event.preventDefault(); const visibleRows = Math.max(project.data.people.length + 2, 5); const lastColumn = project.data.columns.length - 1;
        if (columnSelector) { const col = Number(columnSelector.dataset.selectRosterColumn); updateRosterSelection({ row: 0, col }, { row: visibleRows, col }, 'column'); }
        else if (rowSelector) { const row = Number(rowSelector.dataset.selectRosterRow); updateRosterSelection({ row, col: 0 }, { row, col: lastColumn }, 'row'); }
        else updateRosterSelection({ row: 0, col: 0 }, { row: visibleRows, col: lastColumn }, 'all');
        return;
      }
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
    arrangementBoard.addEventListener('contextmenu', (event) => {
      const cell = event.target.closest('[data-arrangement-row][data-arrangement-col]'); if (!cell) return;
      openSheetContextMenu('arrangement', event, { row: Number(cell.dataset.arrangementRow), col: Number(cell.dataset.arrangementCol) }, arrangementSelection, updateArrangementSelection);
    });
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
      const columnSelector = event.target.closest('[data-select-arrangement-column]'); const rowSelector = event.target.closest('[data-select-arrangement-row]'); const allSelector = event.target.closest('[data-select-arrangement-all]');
      if (['Enter', ' '].includes(event.key) && (columnSelector || rowSelector || allSelector) && item.columns.length) {
        event.preventDefault(); const visibleRows = Math.max(item.rows.length + 2, 5); const lastColumn = item.columns.length - 1;
        if (columnSelector) { const col = Number(columnSelector.dataset.selectArrangementColumn); updateArrangementSelection({ row: -1, col }, { row: visibleRows - 1, col }, 'column'); }
        else if (rowSelector) { const row = Number(rowSelector.dataset.selectArrangementRow); updateArrangementSelection({ row, col: 0 }, { row, col: lastColumn }, 'row'); }
        else updateArrangementSelection({ row: -1, col: 0 }, { row: visibleRows - 1, col: lastColumn }, 'all');
        return;
      }
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
    scheduleTable.addEventListener('contextmenu', (event) => {
      const cell = event.target.closest('[data-schedule-row][data-schedule-col]'); if (!cell) return;
      openSheetContextMenu('schedule', event, { row: Number(cell.dataset.scheduleRow), col: Number(cell.dataset.scheduleCol) }, scheduleSelection, updateScheduleSelection);
    });
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
      if (event.target.dataset.scheduleBefore) { pushScheduleHistorySnapshot(event.target.dataset.scheduleBefore, project.id); delete event.target.dataset.scheduleBefore; }
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
      const columnSelector = event.target.closest('[data-select-schedule-column]'); const rowSelector = event.target.closest('[data-select-schedule-row]'); const allSelector = event.target.closest('[data-select-schedule-all]'); const columns = scheduleSheetColumns(project);
      if (['Enter', ' '].includes(event.key) && (columnSelector || rowSelector || allSelector) && columns.length) {
        event.preventDefault(); const visibleRows = Math.max(project.data.slots.length + 2, 5); const lastColumn = columns.length - 1;
        if (columnSelector) { const col = Number(columnSelector.dataset.selectScheduleColumn); updateScheduleSelection({ row: -1, col }, { row: visibleRows - 1, col }, 'column'); }
        else if (rowSelector) { const row = Number(rowSelector.dataset.selectScheduleRow); updateScheduleSelection({ row, col: 0 }, { row, col: lastColumn }, 'row'); }
        else updateScheduleSelection({ row: -1, col: 0 }, { row: visibleRows - 1, col: lastColumn }, 'all');
        return;
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
      if (!event.target.dataset.scheduleEditing) { pushScheduleHistorySnapshot(beforeSnapshot, project.id); event.target.dataset.scheduleEditing = 'true'; }
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
    $('#sessionAddEmptyTime').addEventListener('click', () => addCalendarEvent());
    $('#sessionPersonPool').addEventListener('click', (event) => { const chip = event.target.closest('[data-session-person]'); if (!chip) return; const project = activeProject(); if (!project) return; if (selectedSessionPersonId === chip.dataset.sessionPerson) { selectedSessionPersonId = null; selectedSessionAssignmentId = null; } else { selectedSessionPersonId = chip.dataset.sessionPerson; const assignments = project.data.assignments.filter((item) => item.personId === selectedSessionPersonId); selectedSessionAssignmentId = assignments.length === 0 ? 'new' : assignments.length === 1 ? assignments[0].id : null; } pendingSessionChange = null; renderSessionPlanner(project); });
    $('#sessionPersonPool').addEventListener('dragstart', (event) => { const chip = event.target.closest('[data-session-person]'); if (!chip) return; const project = activeProject(); const assignments = project?.data.assignments.filter((item) => item.personId === chip.dataset.sessionPerson) || []; if (assignments.length > 1) { event.preventDefault(); selectedSessionPersonId = chip.dataset.sessionPerson; selectedSessionAssignmentId = null; pendingSessionChange = null; renderSessionPlanner(project); showToast('변경할 현재 일정을 먼저 선택해주세요.'); return; } event.dataTransfer.setData('application/x-cmoe-person', chip.dataset.sessionPerson); if (assignments.length === 1) event.dataTransfer.setData('application/x-cmoe-assignment', assignments[0].id); event.dataTransfer.effectAllowed = assignments.length ? 'move' : 'copy'; });
    $('#sessionCalendarBoard').addEventListener('dragstart', (event) => { const chip = event.target.closest('[data-session-assignment]'); if (!chip) return; event.dataTransfer.setData('application/x-cmoe-assignment', chip.dataset.sessionAssignment); event.dataTransfer.setData('application/x-cmoe-person', chip.dataset.sessionPerson); event.dataTransfer.effectAllowed = 'move'; });
    $('#sessionCalendarBoard').addEventListener('keydown', (event) => {
      const card = event.target.closest('[data-session-slot]'); if (event.target.closest('button') || !card || !['Enter', ' '].includes(event.key) || !selectedSessionPersonId) return;
      event.preventDefault(); if (!selectedSessionAssignmentId) { showToast('변경할 현재 일정을 먼저 선택해주세요.'); return; }
      const project = activeProject(); if (project) previewSessionChange(project, { personId: selectedSessionPersonId, assignmentId: selectedSessionAssignmentId, toSlotId: card.dataset.sessionSlot });
    });
    $('#sessionCalendarBoard').addEventListener('dragover', (event) => { const target = event.target.closest('[data-session-slot], [data-session-empty-drop]'); if (!target) return; event.preventDefault(); target.classList.add('drag-over'); });
    $('#sessionCalendarBoard').addEventListener('dragleave', (event) => { event.target.closest('[data-session-slot]')?.classList.remove('drag-over'); });
    $('#sessionCalendarBoard').addEventListener('drop', (event) => { const target = event.target.closest('[data-session-slot], [data-session-empty-drop]'); if (!target) return; event.preventDefault(); target.classList.remove('drag-over'); const project = activeProject(); const personId = event.dataTransfer.getData('application/x-cmoe-person'); const assignmentId = event.dataTransfer.getData('application/x-cmoe-assignment'); if (!project || !personId) return; selectedSessionPersonId = personId; selectedSessionAssignmentId = assignmentId || 'new'; if (target.dataset.sessionEmptyDrop) openCalendarEventEditor({ sourcePage: 'schedule', pendingAssignment: { personId, assignmentId } }); else previewSessionChange(project, { personId, assignmentId, toSlotId: target.dataset.sessionSlot }); });
    $('#sessionCalendarBoard').addEventListener('click', async (event) => {
      await flushSchedulePersist(); const project = activeProject(); if (!project) return;
      if (event.target.closest('[data-session-empty-drop]')) { addCalendarEvent(); return; }
      const unassign = event.target.closest('[data-session-unassign]'); if (unassign) { const assignment = project.data.assignments.find((item) => item.id === unassign.dataset.sessionUnassign); if (assignment) { selectedSessionPersonId = assignment.personId; selectedSessionAssignmentId = assignment.id; previewSessionChange(project, { personId: assignment.personId, assignmentId: assignment.id, action: 'remove' }); } return; }
      const assignmentChip = event.target.closest('[data-session-assignment]'); if (assignmentChip) { selectedSessionPersonId = assignmentChip.dataset.sessionPerson; selectedSessionAssignmentId = assignmentChip.dataset.sessionAssignment; pendingSessionChange = null; renderSessionPlanner(project); return; }
      const target = event.target.closest('[data-session-target]'); if (target && selectedSessionPersonId) { if (!selectedSessionAssignmentId) { showToast('변경할 현재 일정을 먼저 선택해주세요.'); return; } previewSessionChange(project, { personId: selectedSessionPersonId, assignmentId: selectedSessionAssignmentId, toSlotId: target.dataset.sessionTarget }); return; }
      const edit = event.target.closest('[data-session-edit]'); if (edit) { openCalendarEventEditor({ slotId: edit.dataset.sessionEdit, sourcePage: 'schedule' }); return; }
      const remove = event.target.closest('[data-session-remove]'); if (remove) { const projectId = project.id; const slotId = remove.dataset.sessionRemove; let currentProject = project; let slot = currentProject.data.slots.find((item) => item.id === slotId); let assignments = currentProject.data.assignments.filter((item) => item.slotId === slotId); if (slot && scheduleRowLocked(currentProject, slot.id)) { showToast(scheduleRowLockMessage(currentProject, slot.id, '삭제'), 'error'); return; } if (!slot) return; const confirmSignature = scheduleChangeSignature(currentProject); if (!await showConfirm(`${slotRangeText(slot, { includeYear: true })} 세션을 삭제할까요? 배정 인원 ${assignments.length}명의 Zoom·메일도 다시 확인해야 합니다.`, { title: '세션 삭제', action: '삭제' })) return; currentProject = projectById(projectId); slot = currentProject?.data.slots.find((item) => item.id === slotId); if (!currentProject || !slot || scheduleRowLocked(currentProject, slot.id) || scheduleChangeSignature(currentProject) !== confirmSignature) { showToast('다른 창의 일정 변경을 반영했습니다. 다시 시도해주세요.'); renderSchedulePage(); return; } assignments = currentProject.data.assignments.filter((item) => item.slotId === slot.id); const removedAssignmentIds = new Set(assignments.map((item) => item.id)); pushScheduleHistory(currentProject); const impact = { changedSlotIds: [slot.id], zoomReviewSlotIds: [slot.id], affectedPersonIds: assignments.map((item) => item.personId) }; markScheduleChangeStale(currentProject, impact); currentProject.data.slots = currentProject.data.slots.filter((item) => item.id !== slot.id); currentProject.data.assignments = currentProject.data.assignments.filter((item) => item.slotId !== slot.id); removeCalendarDataForSlots(currentProject, [slot.id], removedAssignmentIds); Object.keys(currentProject.data.availability).forEach((personId) => { currentProject.data.availability[personId] = currentProject.data.availability[personId].filter((id) => id !== slot.id); }); refreshScheduleConflicts(currentProject); syncScheduleProjectState(currentProject, `세션 삭제 · 문제 ${currentProject.data.conflicts.length}건`, impact); renderSchedulePage(); await persist('세션 삭제됨'); return; }
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
        const editor = document.getElementById(toolbar.dataset.editorToolbar); editor.focus(); document.execCommand(button.dataset.richCommand, false, null); syncRichToolbarState(editor);
      });
      toolbar.addEventListener('input', (event) => {
        const color = event.target.closest('[data-rich-color]'); if (!color) return;
        const editor = document.getElementById(toolbar.dataset.editorToolbar); editor.focus(); document.execCommand(color.dataset.richColor, false, color.value); syncRichToolbarState(editor);
      });
    });
    $$('.nav-button').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
    const openNewProjectDialog = (templateId = 'template-blank') => { resetNewProjectForm(); renderNewProjectTemplates(templateId); openDialog('newProjectDialog'); };
    $$('[data-open-new-project]').forEach((button) => button.addEventListener('click', () => openNewProjectDialog()));
    $('#newProjectButton').addEventListener('click', () => openNewProjectDialog());
    $('#newProjectTemplatePicker').addEventListener('change', (event) => { if (event.target.name === 'templateChoice') renderNewProjectTemplates(event.target.value); });
    $('#newProjectWorkflowList').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-new-project-workflow-remove]');
      if (remove) { newProjectWorkflowDraft = newProjectWorkflowDraft.filter((step) => step.id !== remove.dataset.newProjectWorkflowRemove); newProjectWorkflowModified = true; renderNewProjectWorkflowDraft(); return; }
      const move = event.target.closest('[data-new-project-workflow-move]');
      if (!move) return;
      const index = newProjectWorkflowDraft.findIndex((step) => step.id === move.dataset.newProjectWorkflowMove);
      const target = index + Number(move.dataset.direction);
      if (index >= 0 && target >= 0 && target < newProjectWorkflowDraft.length) {
        [newProjectWorkflowDraft[index], newProjectWorkflowDraft[target]] = [newProjectWorkflowDraft[target], newProjectWorkflowDraft[index]];
        newProjectWorkflowModified = true; renderNewProjectWorkflowDraft();
      }
    });
    $('#addNewProjectWorkflowStep').addEventListener('click', () => {
      const definition = Core.workflowTaskCatalog().find((item) => item.id === $('#newProjectWorkflowStepType').value); if (!definition) return;
      if (definition.moduleId && definition.moduleId !== 'documentEditor' && newProjectWorkflowDraft.some((step) => step.moduleId === definition.moduleId)) { showToast(`“${definition.name}”은 이미 시작 단계에 있습니다. ↑↓로 원하는 위치에 옮겨주세요.`); return; }
      newProjectWorkflowDraft.push({ id: `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: definition.id, moduleId: definition.moduleId || null, name: definition.name, description: definition.description, status: 'notStarted', instructions: '', notes: '', checklist: [], order: newProjectWorkflowDraft.length, updatedAt: null });
      newProjectWorkflowModified = true; renderNewProjectWorkflowDraft();
    });
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
      const definition = Core.workflowTaskCatalog().find((item) => item.id === $('#workflowStepType').value); if (!definition) return;
      if (definition.moduleId && definition.moduleId !== 'documentEditor' && workflowEditorDraft.some((step) => step.moduleId === definition.moduleId)) { showToast(`“${definition.name}”은 이미 이 프로젝트에 있습니다. ↑↓로 원하는 위치에 옮겨주세요.`); return; }
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
    $('#checkAppUpdate').addEventListener('click', () => void checkAppUpdate());
    $('#installAppUpdate').addEventListener('click', async () => {
      if (appUpdateState.portable) { await globalThis.workspaceDesktop.openUpdateDownloads(); return; }
      if (!await showConfirm(`CMOE Workspace ${appUpdateState.checked?.feed?.version || ''}을 내려받아 검증한 뒤 업데이트할까요?\n작업 내용을 저장하고 앱을 종료한 다음 같은 위치에 설치하고 한 번만 다시 실행합니다.`, { title: '프로그램 업데이트', action: '업데이트' })) return;
      appUpdateState.installing = true; appUpdateState.error = ''; renderAppUpdate();
      try { await globalThis.workspaceDesktop.installUpdate(); }
      catch (error) { appUpdateState.installing = false; appUpdateState.progress = null; appUpdateState.error = error.message; renderAppUpdate(); showToast(`업데이트를 시작하지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#cancelAppUpdate').addEventListener('click', async () => {
      if (!appUpdateState.installing || appUpdateState.canceling) return;
      appUpdateState.canceling = true; renderAppUpdate();
      try {
        const result = await globalThis.workspaceDesktop.cancelUpdate();
        if (result?.canceled) showToast('업데이트 다운로드 취소를 요청했습니다.', 'success');
      } catch (error) { showToast(`다운로드를 취소하지 못했습니다: ${error.message}`, 'error'); }
      finally { appUpdateState.canceling = false; renderAppUpdate(); }
    });
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
        let entry = project ? buildWorkspaceMailPackage(project).entries.find((item) => item.personId === personId) : null;
        if (artifact && entry) {
          let connection = state.connections.find((item) => item.id === artifact.connectionId && item.status === 'connected');
          if (!connection) { message = '수정 내용은 저장했습니다. Gmail 계정에 다시 로그인하면 임시보관함의 메일도 변경할 수 있습니다.'; tone = 'error'; }
          else {
            try { reservation = await reserveExternalArtifacts(projectId, 'gmailDraft', [personId]); }
            catch (error) { message = `수정 내용은 저장했지만 Gmail 변경 작업을 시작하지 못했습니다: ${error.message}`; tone = 'error'; }
            if (reservation && !reservation.ok) { message = '수정 내용은 저장했습니다. 다른 창에서 같은 Gmail 메일을 처리 중이므로 완료 후 다시 확인해주세요.'; tone = 'normal'; }
            if (reservation?.ok) {
              beginExternalOperation(); externalStarted = true;
              project = projectById(projectId); artifact = latestActiveExternalArtifact(project, 'gmailDraft', (item) => item.personId === personId); entry = project ? buildWorkspaceMailPackage(project).entries.find((item) => item.personId === personId) : null;
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
    $('#projectSettingsButton').addEventListener('click', openProjectSettings);
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
      const matrix = await previewRosterText(text, 'Gmail 받는 사람 명단'); if (!matrix?.length) return;
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
      if (!standaloneProgram || projectLinkedProgram) return;
      const current = activeProject(); const hasData = current.data.people.length || current.data.slots.length || current.data.communication.mailEdits && Object.keys(current.data.communication.mailEdits).length;
      if (hasData && !await showConfirm('현재 빠른 작업을 비우고 새 작업을 시작할까요? 필요한 내용은 먼저 작업 저장을 눌러 보관하세요.', { title: '새 빠른 작업', action: '새 작업' })) return;
      const fresh = Core.normalizeState({ ...Core.createEmptyState(), installedExtensions: state.installedExtensions }).quickWorkspaces[standaloneProgram];
      state.quickWorkspaces[standaloneProgram] = { ...fresh, id: `quick-${standaloneProgram}`, scope: 'quick', updatedAt: new Date().toISOString() };
      mailEditorDirty = false; await persist(); renderAll(); navigate(standaloneProgram); showToast('새 빠른 작업을 시작했습니다.', 'success');
    });
    $('#saveQuickTask').addEventListener('click', async () => {
      if (!standaloneProgram || projectLinkedProgram) return; const name = await requestName('빠른 작업 저장 이름', `${Core.MODULE_CATALOG.find((item) => item.id === standaloneProgram)?.name || '작업'} ${new Date().toLocaleDateString('ko-KR')}`); if (!name) return;
      const snapshot = JSON.parse(JSON.stringify(activeProject())); snapshot.id = `task-${Date.now().toString(36)}`; snapshot.name = name; snapshot.savedAt = new Date().toISOString(); snapshot.updatedAt = snapshot.savedAt;
      const formsConnectionId = defaultConnectionId(activeProject(), 'forms') || '';
      snapshot.data.forms.linkedForms = snapshot.data.forms.linkedForms.map((linked) => {
        if (linked.connectionId || !formsConnectionId) return linked;
        return { ...linked, connectionId: formsConnectionId };
      });
      snapshot.connectionIdentities = Core.captureProjectConnectionIdentities(state, snapshot);
      if (!state.quickTasks[standaloneProgram]) state.quickTasks[standaloneProgram] = []; state.quickTasks[standaloneProgram].push(snapshot);
      await persist(); renderQuickTasks(); $('#quickTaskSelect').value = snapshot.id; showToast('빠른 작업을 저장했습니다.', 'success');
    });
    $('#quickTaskSelect').addEventListener('change', async (event) => {
      if (!event.target.value || !standaloneProgram || projectLinkedProgram) return; const task = state.quickTasks[standaloneProgram].find((item) => item.id === event.target.value); if (!task) return;
      if (!await showConfirm(`“${task.name}” 작업을 불러올까요? 현재 빠른 작업은 교체됩니다.`, { title: '저장된 작업 불러오기', action: '불러오기', danger: false })) { event.target.value = ''; return; }
      const restored = Core.reconcileSavedQuickTask(state, task);
      state.quickWorkspaces[standaloneProgram] = { ...JSON.parse(JSON.stringify(restored.project)), id: `quick-${standaloneProgram}`, scope: 'quick', updatedAt: new Date().toISOString() };
      mailEditorDirty = false; await persist(); renderAll(); navigate(standaloneProgram); showToast(restored.needsAccountReview ? '저장된 작업을 불러왔습니다. 외부 서비스 계정이 달라 표시된 연결을 확인해주세요.' : '저장된 작업을 불러왔습니다.', restored.needsAccountReview ? 'normal' : 'success');
    });
    $('#standaloneProjectSelect').addEventListener('change', async (event) => {
      const project = state.projects.find((item) => item.id === event.target.value); if (!project || !standaloneProgram || projectLinkedProgram) return;
      if (!await showConfirm(`“${project.name}”의 자료를 현재 빠른 작업으로 복사할까요? 원본 프로젝트는 바뀌지 않습니다.`, { title: '프로젝트 자료 가져오기', action: '가져오기', danger: false })) { event.target.value = ''; return; }
      const copy = Core.createDetachedProjectCopy(project, { id: `quick-${standaloneProgram}`, name: `${project.name} · 빠른 작업`, scope: 'quick' }); copy.installedModules = [...new Set([...(copy.installedModules || []), standaloneProgram])];
      assertSmokeUi(!(copy.data.externalArtifacts || []).length && Object.values(copy.settings.defaultConnectionIds || {}).every((id) => !id), 'project imports do not inherit external artifacts or account overrides');
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
    $$('[data-roster-import-result]').forEach((button) => button.addEventListener('click', () => resolveRosterImportPreview(button.dataset.rosterImportResult === 'apply')));
    $$('[data-confirm-result]').forEach((button) => button.addEventListener('click', () => resolveConfirm(button.dataset.confirmResult === 'true')));
    $('#confirmForm').addEventListener('submit', (event) => { event.preventDefault(); resolveConfirm(true); });
    $('#confirmDialog').addEventListener('cancel', (event) => { event.preventDefault(); resolveConfirm(false); });
    $('#rosterImportPreviewDialog').addEventListener('cancel', (event) => { event.preventDefault(); resolveRosterImportPreview(false); });
    $('#loginBrowserDialog').addEventListener('click', (event) => {
      const profile = event.target.closest('[data-login-browser-profile]');
      if (profile) {
        resolveLoginBrowser({ browserId: profile.dataset.loginBrowserProfileBrowser, browserProfileId: profile.dataset.loginBrowserProfile });
        return;
      }
      const choice = event.target.closest('[data-login-browser-choice]');
      if (!choice) return;
      const browserId = choice.dataset.loginBrowserChoice;
      if (['chrome', 'edge'].includes(browserId)) void renderLoginBrowserProfiles(browserId);
      else resolveLoginBrowser(browserId ? { browserId, browserProfileId: '' } : null);
    });
    $('#loginBrowserBack').addEventListener('click', () => { renderLoginBrowserChoices(); setTimeout(() => $('#loginBrowserChoices button')?.focus()); });
    $('#loginBrowserDialog').addEventListener('cancel', (event) => { event.preventDefault(); resolveLoginBrowser(null); });
    $$('[data-name-result]').forEach((button) => button.addEventListener('click', () => resolveNameInput(null)));
    $('#nameInputForm').addEventListener('submit', (event) => { event.preventDefault(); const value = $('#nameInputValue').value.trim(); if (value) resolveNameInput(value); });
    $('#nameInputDialog').addEventListener('cancel', (event) => { event.preventDefault(); resolveNameInput(null); });
    $('#sheetChoiceDialog').addEventListener('cancel', (event) => { event.preventDefault(); resolveWorkbookSheet(null); });
    $('#shortcutForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const desktop = $('#shortcutDesktop').checked; const startMenu = $('#shortcutStartMenu').checked;
      if (!desktop && !startMenu) { showToast('바로가기를 만들 위치를 하나 이상 선택해주세요.', 'error'); return; }
      try { const programId = $('#shortcutProgramId').value; await globalThis.workspaceDesktop.createProgramShortcuts(programId, { desktop, startMenu, projectId: programId === 'projectCalendar' ? activeProject()?.id || '' : '' }); closeDialog('shortcutDialog'); showToast('선택한 위치에 바로가기를 만들었습니다.', 'success'); }
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
    $('#workspaceTimezone').addEventListener('change', async (event) => {
      const nextTimezone = event.target.value.trim();
      if (!Core.isValidTimeZone(nextTimezone)) {
        showToast('시간대 이름을 확인해주세요. 예: Asia/Seoul, UTC, America/New_York', 'error');
        renderSettings();
        return;
      }
      const inheritedProjects = [...state.projects, ...Object.values(state.quickWorkspaces || {})].filter((project) => project && !project.settings.timezoneOverride);
      const previousTimezones = new Map(inheritedProjects.map((project) => [project.id, project.settings.timezone]));
      state.preferences.defaultTimezone = nextTimezone;
      state = Core.normalizeState(state);
      let affectedProjects = 0;
      for (const inheritedProject of inheritedProjects) {
        let project = projectById(inheritedProject.id);
        if (!project || previousTimezones.get(project.id) === project.settings.timezone) continue;
        affectedProjects += 1;
        const slotIds = project.data.slots.map((slot) => slot.id);
        const affectedPersonIds = [...new Set(project.data.assignments.map((assignment) => assignment.personId).filter(Boolean))];
        let zoomStale = false; let gmailStale = false;
        project.data.externalArtifacts.forEach((artifact) => {
          if (artifact.status === 'superseded') return;
          if (artifact.kind === 'zoom') { artifact.status = 'stale'; zoomStale = true; }
          if (artifact.kind === 'gmailDraft') { artifact.status = 'stale'; gmailStale = true; }
        });
        state = Core.updateProject(state, project.id, { data: project.data });
        project = projectById(project.id);
        if (slotIds.length && project?.installedModules.includes('schedule')) state = Core.setModuleStatus(state, project.id, 'schedule', 'stale', 'Workspace 기본 시간대 변경 후 일정 시각 재확인 필요');
        if (zoomStale && project?.installedModules.includes('zoom')) state = Core.setModuleStatus(state, project.id, 'zoom', 'stale', 'Workspace 기본 시간대 변경 후 Zoom 일정 재확인 필요');
        if (gmailStale && project?.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', 'Workspace 기본 시간대 변경 후 일정과 회의 링크 재확인 필요');
        if (state.projects.some((item) => item.id === project?.id)) recordScheduleMergeImpact(project.id, { changedSlotIds: [], zoomReviewSlotIds: slotIds, affectedPersonIds }, { scheduleOnly: false });
      }
      await persist('Workspace 기본 시간대 변경됨');
      renderAll();
      showToast(`기본 시간대를 ${nextTimezone}(으)로 바꿨습니다.${affectedProjects ? ` 상속 중인 프로젝트 ${affectedProjects}개를 다시 확인해주세요.` : ''}`, 'success');
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

    $('#applyRosterPaste')?.addEventListener('click', async () => {
      const text = $('#rosterPasteInput').value;
      if (!text.trim()) { showToast('붙여넣은 데이터가 없습니다.', 'error'); return; }
      const matrix = await previewRosterText(text, '붙여넣은 명단');
      if (matrix?.length) await applyRosterMatrix(matrix);
    });
    $('#rosterFileInput')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      const maxRosterFileBytes = 20 * 1024 * 1024;
      if (file.size > maxRosterFileBytes) { showToast('명단 파일이 20MB를 넘습니다. 필요한 시트·행만 CSV 또는 TSV로 저장한 뒤 다시 선택해주세요.', 'error'); event.target.value = ''; return; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch (_) { text = new TextDecoder('euc-kr').decode(bytes); }
        const matrix = await previewRosterText(text, file.name);
        if (!matrix?.length) { showToast('파일에서 가져올 명단 데이터를 찾지 못했습니다.', 'error'); return; }
        await applyRosterMatrix(matrix);
      } catch (error) { showToast(`명단 파일을 읽지 못했습니다: ${error.message}`, 'error'); }
      finally { event.target.value = ''; }
    });
    $('#chooseExcelRoster')?.addEventListener('click', async () => {
      if (!globalThis.workspaceDesktop?.chooseSpreadsheet) { showToast('Excel 직접 가져오기는 데스크톱 앱에서 사용할 수 있습니다.', 'error'); return; }
      try {
        const result = await globalThis.workspaceDesktop.chooseSpreadsheet();
        if (!result.canceled) {
          const matrix = await previewRosterMatrix(result.matrix, result.sheetName ? `${result.name || 'Excel 파일'} · ${result.sheetName}` : result.name || 'Excel 파일');
          if (matrix?.length) await applyRosterMatrix(matrix);
        }
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
    $('#arrangementDownloadCsv').addEventListener('click', async () => { const item = activeWorkItem(); if (!item) return; if (globalThis.workspaceDesktop?.exportWorkItem) { try { const result = await globalThis.workspaceDesktop.exportWorkItem(item); if (!result.canceled) showToast('작업표를 Excel로 저장했습니다.', 'success'); } catch (error) { showToast(`Excel을 저장하지 못했습니다: ${error.message}`, 'error'); } return; } const rows = [item.columns.map((column) => column.name), ...item.rows.map((row) => item.columns.map((column) => row.values[column.id] || ''))]; const csv = rows.map((row) => row.map(Ops.escapeCsv).join(',')).join('\r\n'); downloadText(`${item.name}.csv`, `\ufeff${csv}`, 'text/csv;charset=utf-8'); });
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
      const beforeSnapshot = scheduleSnapshot(project); pushScheduleHistory(project); project.data.slots = []; project.data.activities = []; project.data.availability = {}; project.data.assignments = []; project.data.activityAssignments = []; refreshScheduleConflicts(project);
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
    const updateFormHeader = () => {
      mutateActiveFormDefinition((definition) => {
        definition.title = $('#formTitleInput').value;
        definition.description = $('#formDescriptionInput').value;
        definition.collectEmail = $('#formEmailCollection').value;
        definition.settings ||= {};
        definition.settings.emailCollectionType = definition.collectEmail;
        definition.settings.isQuiz = Boolean($('#formQuizMode').checked);
      });
    };
    ['formTitleInput', 'formDescriptionInput'].forEach((id) => $(`#${id}`).addEventListener('input', updateFormHeader));
    $('#formEmailCollection').addEventListener('change', () => { updateFormHeader(); renderFormEditor(activeFormDefinition(activeProject())); });
    $('#formQuizMode').addEventListener('change', async (event) => {
      const control = event.currentTarget;
      const project = activeProject(); const definition = activeFormDefinition(project); const hasGrading = (definition?.items || []).some((item) => item.grading);
      if (!control.checked && hasGrading) {
        const projectId = project?.id; const definitionId = definition?.id; const signature = formDefinitionSignature(definition);
        control.checked = true;
        if (!await showConfirm('퀴즈를 끄면 질문에 입력한 정답·배점·피드백이 지워집니다. 계속할까요?', { title: '퀴즈 해제', action: '채점 정보 지우기', danger: false })) return;
        if (!confirmedFormDraft(projectId, definitionId, signature)) { showToast('확인하는 동안 편집 중인 설문이 바뀌어 퀴즈 설정을 적용하지 않았습니다.'); renderFormsPage(); return; }
        control.checked = false;
      }
      if (!control.checked && hasGrading) rememberFormStructure();
      const next = mutateActiveFormDefinition((draft) => {
        draft.settings ||= {}; draft.settings.isQuiz = Boolean(control.checked);
        if (!draft.settings.isQuiz) (draft.items || []).forEach((item) => { delete item.grading; });
      }, '설문 퀴즈 설정 변경됨');
      renderFormEditor(next);
    });

    $('#formQuestionList').addEventListener('focusin', (event) => event.target.closest('.form-editor-card')?.classList.add('active'));
    $('#formQuestionList').addEventListener('focusout', (event) => event.target.closest('.form-editor-card')?.classList.remove('active'));
    $('#formQuestionList').addEventListener('input', (event) => {
      const control = event.target.closest('[data-form-item-field]'); if (!control) return;
      if (control.dataset.formItemField === 'kind') return;
      const next = mutateActiveFormDefinition((definition) => {
        const item = definition.items.find((candidate) => candidate.id === control.dataset.formItemId); if (!item) return;
        const field = control.dataset.formItemField; const entryKind = control.dataset.formEntryKind; const entryIndex = Number(control.dataset.formEntryIndex);
        if (entryKind && Number.isInteger(entryIndex)) {
          const entry = item[entryKind]?.[entryIndex];
          if (entry && field === 'rowRequired') { entry.required = Boolean(control.checked); item.required = Boolean(item.rows?.length && item.rows.every((row) => row.required)); }
          else if (entry && field === 'optionImageSourceUri') { entry.image ||= {}; entry.image.sourceUri = control.value; if (!entry.image.sourceUri && !entry.image.contentUri && !entry.image.altText) delete entry.image; }
          else if (entry && field === 'optionImageAltText') { entry.image ||= {}; entry.image.altText = control.value; if (!entry.image.sourceUri && !entry.image.contentUri && !entry.image.altText) delete entry.image; }
          else if (entry) entry[entryKind === 'rows' ? 'title' : 'value'] = control.value;
          return;
        }
        const nested = control.dataset.formNestedGroup;
        if (nested) {
          item[nested] ||= {};
          if (nested === 'grading' && field === 'correctAnswers') item[nested][field] = control.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
          else if (nested === 'grading' && ['whenRight', 'whenWrong', 'generalFeedback'].includes(field)) {
            const previousFeedback = item[nested][field] && typeof item[nested][field] === 'object' ? item[nested][field] : {};
            const hasMaterials = (Array.isArray(previousFeedback.material) && previousFeedback.material.length) || (Array.isArray(previousFeedback.materials) && previousFeedback.materials.length);
            item[nested][field] = control.value || hasMaterials ? { ...previousFeedback, text: control.value } : null;
          }
          else item[nested][field] = control.type === 'checkbox' ? control.checked : control.type === 'number' ? Number(control.value) : control.value;
          if (nested === 'questionImage' && !item[nested].sourceUri && !item[nested].contentUri && !item[nested].altText) delete item[nested];
          return;
        }
        item[field] = control.type === 'checkbox' ? control.checked : control.type === 'number' || ['ratingScaleLevel', 'low', 'high'].includes(field) ? Number(control.value) : control.value;
        if (field === 'required' && ['radioGrid', 'checkboxGrid'].includes(item.kind)) (item.rows || []).forEach((row) => { row.required = Boolean(control.checked); });
      });
      if (control.dataset.formItemField === 'rowRequired') {
        const item = next?.items?.find((candidate) => candidate.id === control.dataset.formItemId);
        const required = control.closest('.form-editor-card')?.querySelector('[data-form-item-field="required"]'); if (required) required.checked = Boolean(item?.rows?.length && item.rows.every((row) => row.required));
      } else if (control.dataset.formItemField === 'required') {
        const item = next?.items?.find((candidate) => candidate.id === control.dataset.formItemId);
        if (FORM_GRID_KINDS.has(item?.kind)) control.closest('.form-editor-card')?.querySelectorAll('[data-form-item-field="rowRequired"]').forEach((rowControl) => { rowControl.checked = Boolean(control.checked); });
      }
    });
    $('#formQuestionList').addEventListener('change', async (event) => {
      const control = event.target.closest('[data-form-item-field]'); if (!control) return;
      if (control.dataset.formItemField !== 'kind') return;
      const project = activeProject(); const definition = activeFormDefinition(project); const current = definition?.items.find((item) => item.id === control.dataset.formItemId); if (!project || !definition || !current) return;
      const nextKind = control.value; const previousKind = current.kind; control.value = previousKind;
      if (nextKind === previousKind) return;
      const losses = formTypeChangeLosses(current, nextKind);
      const signature = formDefinitionSignature(definition);
      if (losses.length && !await showConfirm(`질문 유형을 바꾸면 ${losses.join(', ')}이(가) 지워집니다. 계속할까요?`, { title: '질문 유형 변경', action: '유형 변경', danger: false })) { renderFormEditor(activeFormDefinition(activeProject())); return; }
      if (!confirmedFormDraft(project.id, definition.id, signature)) { showToast('확인하는 동안 편집 중인 설문이 바뀌었습니다. 다시 시도해주세요.'); renderFormsPage(); return; }
      rememberFormStructure();
      const next = mutateActiveFormDefinition((definition) => {
        const index = definition.items.findIndex((item) => item.id === control.dataset.formItemId); if (index < 0) return;
        definition.items[index] = changeFormItemKind(definition.items[index], nextKind);
      }, '설문 질문 유형 변경됨');
      renderFormEditor(next);
    });
    $('#formQuestionList').addEventListener('paste', (event) => {
      const input = event.target.closest('[data-form-entry-kind="options"]'); if (!input) return;
      const values = String(event.clipboardData?.getData('text/plain') || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (values.length < 2) return;
      event.preventDefault();
      rememberFormStructure();
      const next = mutateActiveFormDefinition((definition) => {
        const item = definition.items.find((candidate) => candidate.id === input.dataset.formItemId); if (!item) return;
        const index = Number(input.dataset.formEntryIndex);
        item.options.splice(index, 1, ...values.map((value, offset) => ({ id: `form-option-${Date.now().toString(36)}-${index + offset}`, value })));
      }, '설문 선택지 여러 개 붙여넣음');
      renderFormEditor(next);
    });
    $('#formQuestionList').addEventListener('click', async (event) => {
      const add = event.target.closest('[data-form-add-entry]');
      const addOther = event.target.closest('[data-form-add-other]');
      const removeEntry = event.target.closest('[data-form-remove-entry]');
      const removeItem = event.target.closest('[data-form-remove-item]');
      const duplicate = event.target.closest('[data-form-duplicate-item]');
      const move = event.target.closest('[data-form-move-item]');
      const removeQuestionImage = event.target.closest('[data-form-remove-question-image]');
      const removeOptionImage = event.target.closest('[data-form-remove-option-image]');
      const clearGrading = event.target.closest('[data-form-clear-grading]');
      if (!add && !addOther && !removeEntry && !removeItem && !duplicate && !move && !removeQuestionImage && !removeOptionImage && !clearGrading) return;
      if (removeItem) {
        const project = activeProject(); const definition = activeFormDefinition(project, { create: false }); const current = definition?.items.find((item) => item.id === removeItem.dataset.formRemoveItem);
        if (current?.readOnly) {
          const signature = formDefinitionSignature(definition);
          if (!await showConfirm(`“${current.title || FORM_ITEM_LABELS[current.kind] || '고급 항목'}”은 가져온 Google 설문에서 읽기 전용인 항목입니다. 새 초안에서 이 항목을 제거할까요? Google에 있는 원본 설문은 바뀌지 않습니다.`, { title: '가져온 항목 제거', action: '초안에서 제거', danger: false })) return;
          if (!confirmedFormDraft(project.id, definition.id, signature)) { showToast('확인하는 동안 편집 중인 설문이 바뀌어 항목을 제거하지 않았습니다.'); renderFormsPage(); return; }
        }
      }
      rememberFormStructure();
      const next = mutateActiveFormDefinition((definition) => {
        const itemId = addOther?.dataset.formAddOther || removeQuestionImage?.dataset.formRemoveQuestionImage || removeOptionImage?.dataset.formRemoveOptionImage || clearGrading?.dataset.formClearGrading || removeItem?.dataset.formRemoveItem || duplicate?.dataset.formDuplicateItem || (add || removeEntry || move)?.dataset.formItemId;
        const index = definition.items.findIndex((item) => item.id === itemId); if (index < 0) return;
        const item = definition.items[index];
        if (add) {
          const key = add.dataset.formAddEntry;
          item[key] ||= [];
          const rowRequired = key === 'rows' ? Boolean(item[key].length && item[key].every((row) => row.required)) : false;
          item[key].push(key === 'rows' ? { id: `form-row-${Date.now().toString(36)}-${item[key].length}`, title: `행 ${item[key].length + 1}`, required: rowRequired } : { id: `form-option-${Date.now().toString(36)}-${item[key].length}`, value: `옵션 ${item[key].length + 1}` });
          if (key === 'rows') item.required = Boolean(item.rows.length && item.rows.every((row) => row.required));
        } else if (addOther) item.options.push({ id: `form-option-${Date.now().toString(36)}-other`, value: '기타', isOther: true });
        else if (removeEntry) {
          const key = removeEntry.dataset.formRemoveEntry; if ((item[key] || []).length > 1) item[key].splice(Number(removeEntry.dataset.formEntryIndex), 1);
          if (key === 'rows') item.required = Boolean(item.rows.length && item.rows.every((row) => row.required));
        } else if (removeQuestionImage) delete item.questionImage;
        else if (removeOptionImage) { const option = item.options?.[Number(removeOptionImage.dataset.formEntryIndex)]; if (option) delete option.image; }
        else if (clearGrading) delete item.grading;
        else if (removeItem) definition.items.splice(index, 1);
        else if (duplicate) {
          const copy = duplicateFormItem(item); copy.title = `${item.title || '항목'} 복사본`; definition.items.splice(index + 1, 0, copy);
        } else if (move) {
          const target = Math.max(0, Math.min(definition.items.length - 1, index + Number(move.dataset.formMoveItem))); if (target !== index) definition.items.splice(target, 0, ...definition.items.splice(index, 1));
        }
      }, '설문 항목 구성 변경됨');
      renderFormEditor(next);
    });
    $('#formQuestionList').addEventListener('dragstart', (event) => { const handle = event.target.closest('.form-drag-handle'); const card = handle?.closest('[data-form-item-id]'); if (!handle?.draggable || !card) { event.preventDefault(); return; } draggedFormItemId = card.dataset.formItemId; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', draggedFormItemId); card.classList.add('dragging'); });
    $('#formQuestionList').addEventListener('dragend', (event) => { event.target.closest('.form-editor-card')?.classList.remove('dragging'); draggedFormItemId = null; $$('.form-editor-card.drag-over', $('#formQuestionList')).forEach((card) => card.classList.remove('drag-over')); });
    $('#formQuestionList').addEventListener('dragover', (event) => { const card = event.target.closest('.form-editor-card'); if (!card || !draggedFormItemId || card.dataset.formItemId === draggedFormItemId) return; event.preventDefault(); card.classList.add('drag-over'); });
    $('#formQuestionList').addEventListener('dragleave', (event) => event.target.closest('.form-editor-card')?.classList.remove('drag-over'));
    $('#formQuestionList').addEventListener('drop', (event) => {
      const target = event.target.closest('.form-editor-card'); const sourceId = draggedFormItemId || event.dataTransfer.getData('text/plain'); if (!target || !sourceId || target.dataset.formItemId === sourceId) return; event.preventDefault();
      rememberFormStructure();
      const next = mutateActiveFormDefinition((definition) => { const from = definition.items.findIndex((item) => item.id === sourceId); const to = definition.items.findIndex((item) => item.id === target.dataset.formItemId); if (from < 0 || to < 0) return; definition.items.splice(to, 0, ...definition.items.splice(from, 1)); }, '설문 질문 순서 변경됨');
      draggedFormItemId = null; renderFormEditor(next);
    });
    $('#addFormQuestion').addEventListener('click', () => { rememberFormStructure(); const next = mutateActiveFormDefinition((definition) => definition.items.push(createFormItem('shortText')), '설문 질문 추가됨'); renderFormEditor(next); setTimeout(() => $('#formQuestionList .form-editor-card:last-child .form-item-title')?.focus()); });
    $$('[data-add-form-item]').forEach((button) => button.addEventListener('click', () => { rememberFormStructure(); const next = mutateActiveFormDefinition((definition) => definition.items.push(createFormItem(button.dataset.addFormItem)), '설문 항목 추가됨'); renderFormEditor(next); }));
    $('#undoFormStructure').addEventListener('click', () => { if (undoFormStructureChange()) showToast('방금 바꾼 설문 구성을 되돌렸습니다.', 'success'); });
    $('#projectFormDraftSelect').addEventListener('change', async (event) => {
      const select = event.currentTarget; const projectId = activeProject()?.id; const definitionId = select.value;
      if (!await ensureFormDraftSaved('설문 초안 전환')) { renderFormsPage(); return; }
      if (select.value !== definitionId) return;
      const project = projectById(projectId); const definition = project?.data.forms.definitions.find((item) => item.id === definitionId); if (!project || !definition || activeProject()?.id !== projectId) { showToast('프로젝트가 바뀌어 설문 초안을 전환하지 않았습니다.'); renderFormsPage(); return; }
      project.data.forms.activeDefinitionId = definition.id; state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } });
      await persist('프로젝트 설문 초안 선택됨'); renderFormsPage();
    });
    $('#deleteProjectFormDraft').addEventListener('click', async () => {
      if (!await ensureFormDraftSaved('설문 초안 삭제')) return;
      let project = activeProject(); const definition = activeFormDefinition(project, { create: false }); if (!project || !definition) return;
      const projectId = project.id; const definitionId = definition.id; const signature = formDefinitionSignature(definition);
      const linked = project.data.forms.linkedForms.some((item) => item.definitionId === definition.id || item.formId === definition.formId);
      if (!await showConfirm(`“${definition.title || '제목 없는 설문'}” 초안을 삭제할까요?${linked ? ' Google에 있는 실제 설문과 프로젝트의 응답 연결은 삭제되지 않습니다.' : ''}`, { title: '프로젝트 설문 초안 삭제', action: '초안 삭제' })) return;
      const confirmed = confirmedFormDraft(projectId, definitionId, signature); project = confirmed?.project; const index = project?.data.forms.definitions.findIndex((item) => item.id === definitionId) ?? -1; if (!project || index < 0) { showToast('확인하는 동안 프로젝트나 설문이 바뀌어 초안을 삭제하지 않았습니다.'); renderFormsPage(); return; }
      project.data.forms.definitions.splice(index, 1);
      let next = project.data.forms.definitions[Math.min(index, project.data.forms.definitions.length - 1)] || null;
      if (!next) { next = newBlankFormDefinition(project); project.data.forms.definitions.push(next); }
      project.data.forms.activeDefinitionId = next.id; state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } });
      await persist('프로젝트 설문 초안 삭제됨'); renderFormsPage(); showToast('프로젝트에서 초안만 삭제했습니다.', 'success');
    });
    const startNewFormDraft = async (type = 'custom') => {
      const starterLabel = type === 'registration' ? '신청 명단 설문' : type === 'availability' ? '가능 시간 설문' : '자유 설문';
      if (!await ensureFormDraftSaved(`${starterLabel} 만들기`)) return;
      let project = activeProject(); if (!project) return;
      const current = activeFormDefinition(project, { create: false });
      const replacePristineBlank = formDefinitionIsPristineBlank(current, project);
      const projectId = project.id; const definitionId = current?.id || ''; const signature = formDefinitionSignature(current);
      if (current?.items?.length && !replacePristineBlank && !await showConfirm(`현재 설문은 프로젝트에 보존됩니다. 새 ${starterLabel}으로 편집을 시작할까요?`, { title: `${starterLabel} 시작`, action: '새로 만들기', danger: false })) return;
      if (current?.items?.length && !confirmedFormDraft(projectId, definitionId, signature)) { showToast('확인하는 동안 프로젝트나 설문이 바뀌어 새 초안을 만들지 않았습니다.'); renderFormsPage(); return; }
      project = projectById(projectId); if (!project || activeProject()?.id !== projectId) return; const definition = type === 'custom' ? newBlankFormDefinition(project) : newSemanticFormDefinition(project, type);
      const replaceIndex = replacePristineBlank ? project.data.forms.definitions.findIndex((item) => item.id === definitionId) : -1;
      if (replaceIndex >= 0) project.data.forms.definitions.splice(replaceIndex, 1, definition); else project.data.forms.definitions.push(definition); project.data.forms.activeDefinitionId = definition.id;
      state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } }); markFormEditorDirty(project.id, `새 ${starterLabel} 초안 저장됨`); renderFormEditor(definition); renderFormsPage(); showToast(`${starterLabel}을(를) 시작했습니다. 질문을 필요한 대로 편집해주세요.`, 'success');
    };
    $('#newBlankForm').addEventListener('click', () => { void startNewFormDraft('custom'); });
    $('#newRegistrationForm').addEventListener('click', () => { void startNewFormDraft('registration'); });
    $('#newAvailabilityForm').addEventListener('click', () => { void startNewFormDraft('availability'); });
    $('#previewGoogleFormDraft').addEventListener('click', async (event) => {
      const returnFocus = event.currentTarget;
      if (!await ensureFormDraftSaved('응답 화면 미리보기')) return;
      const definition = activeFormDefinition(activeProject()); if (!definition) return;
      formPreviewReturnFocus = returnFocus; renderFormPreview(definition); openDialog('formPreviewDialog');
    });
    $('#closeFormPreview').addEventListener('click', () => { closeDialog('formPreviewDialog'); formPreviewReturnFocus?.focus(); formPreviewReturnFocus = null; });
    $('#formPreviewDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDialog('formPreviewDialog'); formPreviewReturnFocus?.focus(); formPreviewReturnFocus = null; });
    $('#openGoogleFormsCreate').addEventListener('click', async () => {
      try { await globalThis.workspaceDesktop.openExternal('https://forms.google.com/'); }
      catch (error) { showToast(`Google Forms를 열지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#jumpToLinkedForms').addEventListener('click', () => {
      const tools = $('#formLinkedTools'); if (!tools) return;
      tools.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => $('#linkedFormId')?.focus(), 350);
    });
    $('#saveSharedFormTemplate').addEventListener('click', async () => {
      if (!await ensureFormDraftSaved('전역 설문 양식 저장')) return;
      const project = activeProject(); const definition = activeFormDefinition(project); if (!definition) return;
      const projectId = project.id; const definitionId = definition.id; const signature = formDefinitionSignature(definition);
      const name = await requestName('전역 설문 양식 이름', definition.title || '새 설문 양식'); if (!name?.trim()) return;
      const confirmed = confirmedFormDraft(projectId, definitionId, signature); if (!confirmed) { showToast('이름을 입력하는 동안 프로젝트나 설문이 바뀌어 전역 양식을 저장하지 않았습니다.'); renderFormsPage(); return; }
      const linkedSemantic = confirmed.project.data.forms.linkedForms.find((item) => item.definitionId === confirmed.definition.id || (confirmed.definition.formId && item.formId === confirmed.definition.formId));
      const semanticType = ['registration', 'availability'].includes(linkedSemantic?.type)
        ? linkedSemantic.type
        : ['registration', 'availability'].includes(confirmed.definition.type) ? confirmed.definition.type : 'custom';
      const semanticQuestionIds = linkedSemantic?.questionIds || {};
      const now = new Date().toISOString(); const template = { id: `form-template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), semanticType, definition: freshFormDefinition(confirmed.definition, confirmed.project, { preserveSemantics: semanticType !== 'custom', semanticType, semanticQuestionIds }), savedAt: now, updatedAt: now };
      state.library.formTemplates ||= []; state.library.formTemplates.push(template); state.knownLibraryIds ||= []; if (!state.knownLibraryIds.includes(template.id)) state.knownLibraryIds.push(template.id);
      await persist('전역 설문 양식 저장됨'); renderFormsPage(); $('#sharedFormTemplateSelect').value = template.id; showToast('모든 프로젝트에서 쓸 수 있는 설문 양식으로 저장했습니다.', 'success');
    });
    $('#loadSharedFormTemplate').addEventListener('click', async () => {
      const templateId = $('#sharedFormTemplateSelect').value; let template = state.library.formTemplates?.find((item) => item.id === templateId); if (!template) { showToast('불러올 전역 설문 양식을 선택해주세요.', 'error'); return; }
      if (!await ensureFormDraftSaved('전역 설문 양식 불러오기')) return;
      const baseProject = activeProject(); const baseDefinition = activeFormDefinition(baseProject, { create: false }); if (!baseProject || !baseDefinition) return;
      const projectId = baseProject.id; const definitionId = baseDefinition.id; const signature = formDefinitionSignature(baseDefinition); const templateSignature = formDefinitionSignature(template);
      if (!await showConfirm(`“${template.name}” 양식을 새 설문 초안으로 불러올까요? 현재 설문도 프로젝트에 그대로 남습니다.`, { title: '전역 설문 양식 불러오기', action: '불러오기', danger: false })) return;
      const confirmed = confirmedFormDraft(projectId, definitionId, signature); template = state.library.formTemplates?.find((item) => item.id === templateId); if (!confirmed || !template || formDefinitionSignature(template) !== templateSignature) { showToast('확인하는 동안 프로젝트·설문 또는 전역 양식이 바뀌어 불러오지 않았습니다.'); renderFormsPage(); return; }
      const project = confirmed.project;
      const semanticType = ['registration', 'availability'].includes(template.semanticType || template.definition?.type) ? (template.semanticType || template.definition.type) : 'custom';
      const definition = semanticType === 'availability'
        ? refreshedAvailabilityFormDefinition(template.definition || template, project)
        : freshFormDefinition(template.definition || template, project, { preserveSemantics: semanticType === 'registration', semanticType });
      if (!definition) { showToast('이 양식에서 가능 시간 선택지를 찾지 못해 불러오지 않았습니다. 양식을 다시 확인해주세요.', 'error'); return; }
      project.data.forms.definitions.push(definition); project.data.forms.activeDefinitionId = definition.id; state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } }); markFormEditorDirty(project.id, '전역 설문 양식 불러옴'); renderFormEditor(definition); renderFormsPage(); showToast(semanticType === 'availability' && !project.data.slots.some((slot) => slot.status !== 'cancelled') ? '양식을 불러왔습니다. 가능 시간 선택지를 채우려면 프로젝트 일정을 먼저 추가해주세요.' : '전역 설문 양식을 새 초안으로 불러왔습니다.', 'success');
    });
    $('#deleteSharedFormTemplate').addEventListener('click', async () => {
      const templateId = $('#sharedFormTemplateSelect').value; const template = state.library.formTemplates?.find((item) => item.id === templateId); if (!template) { showToast('삭제할 전역 설문 양식을 선택해주세요.', 'error'); return; }
      const templateSignature = formDefinitionSignature(template);
      if (!await showConfirm(`“${template.name}” 양식을 전역 목록에서 삭제할까요? 프로젝트에 불러온 설문은 그대로 유지됩니다.`, { title: '전역 설문 양식 삭제', action: '삭제' })) return;
      const currentTemplate = state.library.formTemplates?.find((item) => item.id === templateId); if (!currentTemplate || formDefinitionSignature(currentTemplate) !== templateSignature) { showToast('확인하는 동안 전역 양식이 바뀌어 삭제하지 않았습니다.'); renderFormsPage(); return; }
      state.library.formTemplates = state.library.formTemplates.filter((item) => item.id !== templateId); state.deletedLibraryIds ||= []; if (!state.deletedLibraryIds.includes(templateId)) state.deletedLibraryIds.push(templateId);
      await persist('전역 설문 양식 삭제됨'); renderFormsPage(); showToast('전역 설문 양식을 삭제했습니다.');
    });
    $('#createGoogleForm').addEventListener('click', async () => {
      if (!await ensureFormDraftSaved('Google 설문 생성')) return;
      let project = activeProject(); if (!project) return;
      let definition = activeFormDefinition(project);
      let configuredLink = project.data.forms.linkedForms.find((item) => item.definitionId === definition?.id && item.setupStatus === 'configured');
      const semanticType = ['registration', 'availability'].includes(configuredLink?.type) ? configuredLink.type : definition?.type;
      if (semanticType === 'availability' && Ops.projectAvailabilitySlotFingerprint && Ops.googleFormAvailabilitySlotFingerprint) {
        const currentFingerprint = Ops.projectAvailabilitySlotFingerprint(project);
        const draftFingerprint = Ops.googleFormAvailabilitySlotFingerprint(definition);
        if (!currentFingerprint || currentFingerprint !== draftFingerprint) {
          const projectId = project.id; const definitionId = definition.id; const signature = formDefinitionSignature(definition);
          if (!project.data.slots.some((slot) => slot.status !== 'cancelled')) { showToast('현재 프로젝트에 설문 선택지로 넣을 일정이 없습니다. 일정을 먼저 추가해주세요.', 'error'); return; }
          if (!await showConfirm('이 가능 시간 설문 초안은 이전 일정 기준입니다. 현재 일정 선택지로 갱신한 새 초안을 만들까요? 기존 초안은 그대로 남습니다.', { title: '현재 일정으로 설문 갱신', action: '새 초안 만들기', danger: false })) return;
          const confirmed = confirmedFormDraft(projectId, definitionId, signature);
          if (!confirmed) { showToast('확인하는 동안 프로젝트나 설문이 바뀌어 새 초안을 만들지 않았습니다.', 'error'); renderFormsPage(); return; }
          const refreshed = refreshedAvailabilityFormDefinition(confirmed.definition, confirmed.project, configuredLink?.questionIds || {});
          if (!refreshed) { showToast('일정 선택지 질문을 찾지 못했습니다. 현재 일정으로 가능 시간 설문을 다시 구성해주세요.', 'error'); return; }
          confirmed.project.data.forms.definitions.push(refreshed); confirmed.project.data.forms.activeDefinitionId = refreshed.id;
          state = Core.updateProject(state, projectId, { data: { forms: confirmed.project.data.forms } });
          await persist('현재 일정 기준 가능 시간 설문 초안 생성됨'); renderFormsPage();
          showToast('현재 일정 선택지를 넣은 새 초안을 만들었습니다. 내용을 확인한 뒤 Google 설문 생성을 다시 눌러주세요.', 'success');
          return;
        }
      }
      const changedAfterCreate = Boolean(configuredLink && Date.parse(definition?.updatedAt || '') > Date.parse(configuredLink.configuredAt || configuredLink.updatedAt || ''));
      if (configuredLink && definition.source !== 'google' && !definition.formId && !changedAfterCreate) {
        try { await globalThis.workspaceDesktop.openExternal(configuredLink.editUri || `https://docs.google.com/forms/d/${encodeURIComponent(configuredLink.formId)}/edit`); }
        catch (error) { showToast(`Google 설문을 열지 못했습니다: ${error.message}`, 'error'); }
        return;
      }
      if (definition && (definition.source === 'google' || definition.formId || changedAfterCreate)) {
        const copy = freshFormDefinition(definition, project, {
          preserveSemantics: ['registration', 'availability'].includes(semanticType),
          semanticType,
          semanticQuestionIds: configuredLink?.questionIds || {}
        }); copy.title = definition.title;
        project.data.forms.definitions.push(copy); project.data.forms.activeDefinitionId = copy.id; state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } });
        await persist('새 Google 설문용 독립 초안 준비됨'); project = projectById(project.id); definition = project.data.forms.definitions.find((item) => item.id === copy.id); renderFormsPage();
      }
      let connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'forms') && item.type === 'forms' && item.status === 'connected');
      if (!definition?.title?.trim()) { showToast('설문 제목을 입력해주세요.', 'error'); $('#formTitleInput').focus(); return; }
      const semanticIssue = semanticFormDefinitionIssue(definition, project);
      if (semanticIssue) { showToast(semanticIssue, 'error'); return; }
      const unsupported = Ops.googleFormUnsupportedItems ? Ops.googleFormUnsupportedItems(definition) : (definition.items || []).filter((item) => item.readOnly || ['fileUpload', 'unknown'].includes(item.kind));
      if (unsupported.length) { const reason = unsupported.slice(0, 2).map((item) => `${item.title || FORM_ITEM_LABELS[item.kind] || '항목'}: ${item.reason || item.unsupportedReason || '확인 필요'}`).join(' · '); showToast(`Google 설문 생성 전에 확인해주세요. ${reason}`, 'error'); return; }
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
      beginExternalOperation(); let created = null; const expectedConnectionIdentity = Core.connectionIdentity(connection);
      try {
        let reusable = ExternalProgress.findReusableGoogleForm(project, definition.id, connection.id);
        if (reusable && reusable.setupStatus !== 'shellCreated') {
          project.data.forms.selectedFormId = reusable.formId;
          state = Core.updateProject(state, projectId, { data: { forms: project.data.forms } });
          await persist('확인할 Google 설문 선택됨'); renderAll();
          showToast('이 설문은 이전 질문 구성 결과가 불확실해 자동으로 다시 구성하지 않습니다. Google 설문을 열어 확인한 뒤 필요하면 프로젝트 연결을 해제하고 새로 만드세요.', 'error');
          return;
        }
        if (!reusable) {
          const createSignature = externalOperationSignature(project, 'googleForm');
          created = await globalThis.workspaceDesktop.createGoogleFormShell(connection.id, definition, expectedConnectionIdentity);
          const latestProject = latestKnownProject(projectId); if (!latestProject) throw new Error('생성한 설문을 연결할 프로젝트를 찾지 못했습니다.');
          const changedDuringCreate = externalOperationStateChanged(projectId, 'googleForm', createSignature)
            || !Core.connectionIdentityMatches(latestKnownConnection(connection.id), expectedConnectionIdentity);
          const now = new Date().toISOString();
          const shell = {
            ...created,
            definitionId: definition.id,
            type: definition.type,
            title: definition.title,
            ...(definition.type === 'availability' ? { availabilitySlotFingerprint: Ops.googleFormAvailabilitySlotFingerprint?.(definition) || '' } : {}),
            source: 'created',
            connectionId: connection.id,
            connectedAt: now,
            updatedAt: now,
            setupStatus: 'shellCreated',
            needsReview: true,
            reviewReason: changedDuringCreate ? '설문 생성 중 프로젝트 또는 계정 변경 확인 필요' : '설문은 생성됐으며 질문 구성을 시작하기 전입니다.'
          };
          const forms = ExternalProgress.upsertGoogleForm(latestProject.data.forms, shell);
          state = Core.updateProject(state, projectId, { data: { forms } });
          state = reconcileFormsModuleStatus(state, projectId, `${definition.title} 생성됨 · 질문 구성 대기`);
          recordScheduleMergeImpact(projectId, null, { scheduleOnly: false });
          const conflictReason = 'Google 설문 생성 후 프로젝트 또는 계정이 바뀌어 연결 확인 필요';
          const shellCommit = await persist('Google 설문 기본 정보 저장됨', {
            externalCommit: externalCommitGuard({ reservation, project: latestProject, kind: 'googleForm', expectedConnections: [expectedConnectionIdentity], conflictState: markGoogleFormForCommitConflict(state, projectId, created.formId, conflictReason) })
          });
          if (shellCommit?.externalConflict || changedDuringCreate) {
            renderAll(); showToast('Google 설문은 생성됐지만 그 사이 프로젝트 또는 계정이 바뀌어 질문을 자동 구성하지 않고 확인 필요 상태로 저장했습니다.', 'error'); return;
          }
          project = projectById(projectId); reusable = project?.data.forms.linkedForms.find((item) => item.formId === created.formId);
        } else created = { formId: reusable.formId, revisionId: reusable.revisionId || '', responderUri: reusable.responderUri || '', editUri: reusable.editUri || '' };

        project = projectById(projectId); reusable = project?.data.forms.linkedForms.find((item) => item.formId === created.formId);
        if (!project || !reusable || reusable.setupStatus !== 'shellCreated') throw new Error('질문을 구성할 설문 연결 상태를 확인할 수 없습니다.');
        const attemptId = `forms-setup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        let forms = ExternalProgress.upsertGoogleForm(project.data.forms, {
          ...reusable,
          ...(reusable.type === 'availability' ? { availabilitySlotFingerprint: Ops.googleFormAvailabilitySlotFingerprint?.(definition) || '' } : {}),
          setupStatus: 'configuring',
          setupAttemptId: attemptId,
          setupAttemptedAt: new Date().toISOString(),
          needsReview: true,
          reviewReason: 'Google 설문 질문 구성 결과를 확인하는 중입니다.'
        });
        state = Core.updateProject(state, projectId, { data: { forms } });
        state = reconcileFormsModuleStatus(state, projectId, `${definition.title} 질문 구성 중`);
        const journalCommit = await persist('Google 설문 질문 구성 기록됨', {
          externalCommit: externalCommitGuard({ reservation, project, kind: 'googleForm', expectedConnections: [expectedConnectionIdentity], conflictState: markGoogleFormForCommitConflict(state, projectId, created.formId, 'Google 설문 질문 구성 전 프로젝트 또는 계정 변경 확인 필요') })
        });
        if (journalCommit?.externalConflict) { renderAll(); showToast('설문 연결은 저장했지만 프로젝트 또는 계정이 바뀌어 질문을 자동 구성하지 않았습니다.', 'error'); return; }

        project = projectById(projectId);
        if (!project) throw new Error('질문 구성 전에 프로젝트를 찾지 못했습니다.');
        const configuredBaseSignature = externalOperationSignature(project, 'googleForm');
        const configured = await globalThis.workspaceDesktop.configureGoogleForm(connection.id, created.formId, definition, created.revisionId || reusable.revisionId || '', expectedConnectionIdentity);
        const latestProject = latestKnownProject(projectId); if (!latestProject) throw new Error('구성한 설문을 연결할 프로젝트를 찾지 못했습니다.');
        const changedDuringConfigure = externalOperationStateChanged(projectId, 'googleForm', configuredBaseSignature)
          || !Core.connectionIdentityMatches(latestKnownConnection(connection.id), expectedConnectionIdentity);
        const latestLinked = latestProject.data.forms.linkedForms.find((item) => item.formId === created.formId) || reusable;
        forms = ExternalProgress.upsertGoogleForm(latestProject.data.forms, {
          ...latestLinked,
          revisionId: configured.revisionId || latestLinked.revisionId || '',
          itemIds: configured.itemIds || {},
          questionIds: configured.questionIds || {},
          questionIdsByItemId: configured.questionIdsByItemId || {},
          rowQuestionIdsByItemId: configured.rowQuestionIdsByItemId || {},
          published: Boolean(configured.published),
          acceptingResponses: configured.publishSettings?.publishState?.isAcceptingResponses === true,
          publishState: configured.publishSettings?.publishState ? cloneState(configured.publishSettings.publishState) : null,
          publishSettings: configured.publishSettings || null,
          setupStatus: 'configured',
          configuredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          needsReview: changedDuringConfigure,
          reviewReason: changedDuringConfigure ? '질문 구성 중 프로젝트 또는 계정 변경 확인 필요' : ''
        });
        state = Core.updateProject(state, projectId, { data: { forms } });
        state = reconcileFormsModuleStatus(state, projectId, changedDuringConfigure ? `${definition.title} 질문 구성됨 · 변경사항 확인 필요` : `${definition.title} 생성됨`);
        const conflictReason = 'Google 설문 질문 구성 후 프로젝트 또는 계정이 바뀌어 연결 확인 필요';
        const commitResult = await persist('Google 설문 연결 저장됨', {
          externalCommit: externalCommitGuard({ reservation, project: latestProject, kind: 'googleForm', expectedConnections: [expectedConnectionIdentity], conflictState: markGoogleFormForCommitConflict(state, projectId, created.formId, conflictReason) })
        });
        renderAll();
        if (commitResult?.externalConflict) showToast('Google 설문 질문은 구성됐지만 그 사이 프로젝트 또는 계정이 바뀌어 연결을 확인 필요 상태로 저장했습니다.', 'error');
        else showToast(changedDuringConfigure ? '설문 질문은 구성했지만 도중 프로젝트가 바뀌어 연결 내용을 확인 대상으로 표시했습니다.' : 'Google 설문을 만들고 이 프로젝트에 연결했습니다.', changedDuringConfigure ? 'normal' : 'success');
      } catch (error) {
        if (created?.formId) {
          try {
            const latestProject = latestKnownProject(projectId);
            const linked = latestProject?.data.forms.linkedForms.find((item) => item.formId === created.formId);
            if (latestProject && linked) {
              const forms = ExternalProgress.upsertGoogleForm(latestProject.data.forms, { ...linked, setupStatus: 'needsReview', needsReview: true, lastSetupError: error.message, reviewReason: '질문 구성 결과가 불확실합니다. Google 설문에서 직접 확인해주세요.', updatedAt: new Date().toISOString() });
              state = Core.updateProject(state, projectId, { data: { forms } });
              state = reconcileFormsModuleStatus(state, projectId, 'Google 설문 질문 구성 결과 확인 필요');
              await persist('Google 설문 확인 필요', {
                externalCommit: externalCommitGuard({ reservation, project: latestProject, kind: 'googleForm', expectedConnections: [expectedConnectionIdentity], conflictState: markGoogleFormForCommitConflict(state, projectId, created.formId, 'Google 설문 질문 구성 결과 확인 필요') })
              });
            }
          } catch (_) {}
        }
        renderAll(); showToast(created ? `Google 설문은 생성되어 프로젝트에 보존했습니다. 질문 구성 결과를 확인해주세요: ${error.message}` : `Google 설문을 만들지 못했습니다: ${error.message}`, 'error');
      }
      finally { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
    });
    $('#importGoogleForm').addEventListener('click', async () => {
      const raw = $('#linkedFormId').value.trim(); if (!raw) { showToast('Google Forms 편집 주소 또는 Form ID를 입력해주세요.', 'error'); return; }
      let formId;
      try { formId = Ops.googleFormIdFromInput ? Ops.googleFormIdFromInput(raw) : raw.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/)?.[1] || raw; }
      catch (error) { showToast(error.message || 'Google Forms 편집 주소를 확인해주세요.', 'error'); return; }
      if (!formId) { showToast('공유·응답 주소가 아니라 Google Forms 편집 주소 또는 Form ID를 입력해주세요.', 'error'); return; }
      let project = activeProject(); if (!project) return;
      let connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'forms') && item.type === 'forms' && item.status === 'connected');
      if (!connection) { showToast('설문을 가져올 Google 계정에 먼저 로그인해주세요.', 'error'); navigate('connections'); return; }
      if (!await ensureFormDraftSaved('Google 설문 가져오기')) return;
      project = activeProject();
      connection = state.connections.find((item) => item.id === defaultConnectionId(project, 'forms') && item.type === 'forms' && item.status === 'connected');
      if (!project || !connection) { showToast('확인하는 동안 프로젝트 또는 Google 계정이 바뀌었습니다. 다시 시도해주세요.', 'error'); renderAll(); return; }
      const projectId = project.id; const signature = externalOperationSignature(project, 'googleForm'); const expectedConnectionIdentity = Core.connectionIdentity(connection);
      const alreadyImported = project.data.forms.definitions.some((item) => item.formId === formId);
      if (alreadyImported && !await showConfirm('이 Google 설문을 이전에 가져온 초안이 있습니다. Google의 최신 내용을 새 초안으로 추가할까요? 기존 로컬 초안은 그대로 보존됩니다.', { title: 'Google 설문 다시 가져오기', action: '새 초안으로 가져오기', danger: false })) return;
      project = projectById(projectId); connection = state.connections.find((item) => item.id === connection.id && item.type === 'forms' && item.status === 'connected');
      if (!project || activeProject()?.id !== projectId || !connection || externalOperationStateChanged(projectId, 'googleForm', signature) || !Core.connectionIdentityMatches(connection, expectedConnectionIdentity)) { showToast('확인하는 동안 프로젝트·설문 또는 Google 계정이 바뀌어 가져오지 않았습니다. 다시 시도해주세요.', 'error'); renderAll(); return; }
      let reservation; let connectionReservation;
      try { reservation = await reserveExternalArtifacts(projectId, 'googleForm', ['forms']); }
      catch (error) { showToast(`Google 설문 가져오기를 시작하지 못했습니다: ${error.message}`, 'error'); return; }
      if (!reservation.ok) { showToast('다른 창에서 이 프로젝트의 Google 설문을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
      try { connectionReservation = await reserveExternalArtifacts('workspace-connections', 'connection', [connection.id]); }
      catch (error) { await releaseExternalArtifacts(reservation.token); showToast(`Google 계정을 사용할 수 없습니다: ${error.message}`, 'error'); return; }
      if (!connectionReservation.ok) { await releaseExternalArtifacts(reservation.token); showToast('다른 창에서 같은 Google 계정을 처리하고 있습니다. 완료된 뒤 다시 시도해주세요.'); return; }
      project = projectById(projectId); connection = state.connections.find((item) => item.id === connection.id && item.type === 'forms' && item.status === 'connected');
      if (!project || activeProject()?.id !== projectId || !connection || externalOperationStateChanged(projectId, 'googleForm', signature) || !Core.connectionIdentityMatches(connection, expectedConnectionIdentity)) { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); showToast('가져오기 준비 중 프로젝트·설문 또는 Google 계정이 바뀌어 중단했습니다.', 'error'); renderAll(); return; }
      beginExternalOperation();
      try {
        const imported = await globalThis.workspaceDesktop.getGoogleForm(connection.id, formId, expectedConnectionIdentity);
        project = projectById(projectId); connection = state.connections.find((item) => item.id === connection.id && item.type === 'forms' && item.status === 'connected');
        if (!project || !connection || externalOperationStateChanged(projectId, 'googleForm', signature) || !Core.connectionIdentityMatches(connection, expectedConnectionIdentity)) { showToast('설문을 가져오는 동안 프로젝트 또는 Google 계정이 바뀌어 적용하지 않았습니다. 다시 시도해주세요.', 'error'); renderAll(); return; }
        const definition = normalizeFormDefinition(imported, project); definition.formId ||= formId; definition.type ||= 'custom'; definition.source = 'google'; definition.updatedAt = new Date().toISOString();
        const previousIndex = project.data.forms.definitions.findIndex((item) => item.formId === definition.formId);
        if (previousIndex >= 0) definition.id = `${definition.id}-import-${Date.now().toString(36)}`;
        project.data.forms.definitions.push(definition);
        project.data.forms.activeDefinitionId = definition.id;
        const discoveredQuestionIds = {}; const questionIdsByItemId = {}; const rowQuestionIdsByItemId = {};
        (definition.items || []).forEach((item) => { if (item.questionId) { discoveredQuestionIds[item.key || item.id] = item.questionId; questionIdsByItemId[item.id] = item.questionId; } const rows = Object.fromEntries((item.rows || []).filter((row) => row.questionId).map((row) => [row.id, row.questionId])); if (Object.keys(rows).length) rowQuestionIdsByItemId[item.id] = rows; });
        const unsupported = Ops.googleFormUnsupportedItems ? Ops.googleFormUnsupportedItems(definition) : (definition.items || []).filter((item) => item.readOnly);
        const now = new Date().toISOString(); const existing = project.data.forms.linkedForms.find((item) => item.formId === definition.formId) || {};
        const liveQuestionIds = [...Object.values(questionIdsByItemId), ...Object.values(rowQuestionIdsByItemId).flatMap((rows) => Object.values(rows))];
        const linkedType = ['registration', 'availability'].includes(existing.type) ? existing.type : definition.type || 'custom';
        const questionIds = Ops.mergeLiveGoogleFormQuestionIds
          ? Ops.mergeLiveGoogleFormQuestionIds(existing.questionIds, discoveredQuestionIds, liveQuestionIds)
          : { ...Object.fromEntries(Object.entries(existing.questionIds || {}).filter(([, questionId]) => liveQuestionIds.includes(questionId))), ...discoveredQuestionIds };
        if (['registration', 'availability'].includes(linkedType) && Ops.googleFormSemanticQuestionIds) {
          const semanticKeys = linkedType === 'registration' ? ['name', 'phone', 'email', 'group'] : ['participantId', 'name', 'slots', 'notes'];
          semanticKeys.forEach((key) => { delete questionIds[key]; });
          Object.assign(questionIds, Ops.googleFormSemanticQuestionIds(definition, linkedType, existing.questionIds || {}));
        }
        const livePublishState = definition.publishSettings?.publishState && typeof definition.publishSettings.publishState === 'object'
          ? definition.publishSettings.publishState
          : null;
        const linked = {
          ...existing, formId: definition.formId, definitionId: definition.id, revisionId: definition.revisionId || '', type: linkedType, title: definition.title,
          responderUri: definition.responderUri || existing.responderUri || '', editUri: definition.editUri || existing.editUri || `https://docs.google.com/forms/d/${encodeURIComponent(definition.formId)}/edit`,
          source: 'imported', connectionId: connection.id, connectedAt: existing.connectedAt || now, updatedAt: now, setupStatus: 'configured',
          questionIds, questionIdsByItemId, rowQuestionIdsByItemId, connectionReviewRequired: false, connectionReviewReason: '', availabilityScheduleReviewRequired: false, availabilityScheduleReviewReason: '', needsReview: false, reviewReason: '',
          ...(linkedType === 'availability' ? { availabilitySlotFingerprint: Ops.googleFormAvailabilitySlotFingerprint?.(definition) || '' } : {}),
          advancedItemCount: unsupported.length, publishSettings: definition.publishSettings || null,
          publishState: livePublishState ? cloneState(livePublishState) : null,
          published: livePublishState ? livePublishState.isPublished === true : null,
          acceptingResponses: livePublishState ? livePublishState.isAcceptingResponses === true : null
        };
        const availabilityConsistency = applyAvailabilityFormConsistency(project, linked);
        const linkedIndex = project.data.forms.linkedForms.findIndex((item) => item.formId === definition.formId);
        if (linkedIndex >= 0) project.data.forms.linkedForms[linkedIndex] = linked; else project.data.forms.linkedForms.push(linked);
        project.data.forms.selectedFormId = definition.formId;
        state = Core.updateProject(state, projectId, { data: { forms: project.data.forms } });
        state = reconcileFormsModuleStatus(state, projectId, `${definition.title} 가져옴${unsupported.length ? ` · 고급 항목 ${unsupported.length}개` : ''}`);
        recordScheduleMergeImpact(projectId, null, { scheduleOnly: false });
        await persist('기존 Google 설문 가져옴'); renderAll(); $('#linkedFormId').value = '';
        showToast(!availabilityConsistency.consistent
          ? `설문은 가져왔지만 현재 프로젝트 일정과 선택지가 달라 응답 자동 반영을 막았습니다. Google에서 일정을 맞춘 뒤 다시 가져와주세요. · ${availabilityConsistency.reason}`
          : unsupported.length ? `설문을 가져왔습니다. ${unsupported.length}개 고급 항목은 Google Forms에서 계속 편집할 수 있습니다.` : 'Google 설문 내용과 응답 연결을 가져왔습니다.', availabilityConsistency.consistent ? 'success' : 'error');
      } catch (error) { showToast(`Google 설문을 가져오지 못했습니다: ${error.message}`, 'error'); }
      finally { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
    });
    $('#linkedFormSelect').addEventListener('change', async (event) => {
      const project = activeProject(); if (!project) return;
      project.data.forms.selectedFormId = event.target.value || null;
      state = Core.updateProject(state, project.id, { data: project.data });
      await persist('사용할 Google 설문 선택됨'); renderFormsPage();
    });
    $('#copyLinkedForm').addEventListener('click', async () => {
      if (!await ensureFormDraftSaved('연결 설문 복사')) return;
      const project = activeProject(); const linked = selectedLinkedForm(project); if (!project || !linked) return;
      const source = project.data.forms.definitions.find((item) => item.id === linked.definitionId)
        || project.data.forms.definitions.find((item) => item.formId === linked.formId);
      if (!source) { showToast('이 연결에는 복사할 설문 내용이 없습니다. Google에서 열어 편집 주소로 다시 가져와주세요.', 'error'); return; }
      const copy = freshFormDefinition(source, project, {
        preserveSemantics: ['registration', 'availability'].includes(linked.type),
        semanticType: linked.type,
        semanticQuestionIds: linked.questionIds || {}
      }); copy.title = `${source.title || linked.title || '설문'} 사본`;
      project.data.forms.definitions.push(copy); project.data.forms.activeDefinitionId = copy.id;
      state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } }); markFormEditorDirty(project.id, '연결 설문을 새 초안으로 복사함'); renderFormEditor(copy); renderFormsPage();
      $('#formTitleInput').focus(); showToast('연결된 설문을 독립된 새 초안으로 복사했습니다. 수정 후 Google 설문 생성 버튼을 누르세요.', 'success');
    });
    $('#openLinkedForm').addEventListener('click', async () => {
      const linked = selectedLinkedForm(activeProject()); if (!linked) return;
      const url = linked.editUri || `https://docs.google.com/forms/d/${encodeURIComponent(linked.formId)}/edit`;
      try { await globalThis.workspaceDesktop.openExternal(url); }
      catch (error) { showToast(`Google 설문을 열지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#openLinkedFormResponse').addEventListener('click', async () => {
      const linked = selectedLinkedForm(activeProject()); if (!linked?.responderUri) return;
      try { await globalThis.workspaceDesktop.openExternal(linked.responderUri); }
      catch (error) { showToast(`설문 응답 화면을 열지 못했습니다: ${error.message}`, 'error'); }
    });
    $('#copyLinkedFormResponse').addEventListener('click', async () => {
      const linked = selectedLinkedForm(activeProject()); if (!linked?.responderUri) return;
      try {
        if (globalThis.workspaceDesktop?.writeClipboardText) await globalThis.workspaceDesktop.writeClipboardText(linked.responderUri);
        else await navigator.clipboard.writeText(linked.responderUri);
        showToast('응답 링크를 클립보드에 복사했습니다.', 'success');
      } catch (error) { showToast(`응답 링크를 복사하지 못했습니다: ${error.message}`, 'error'); }
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
      state = reconcileFormsModuleStatus(state, project.id);
      recordScheduleMergeImpact(project.id, null, { scheduleOnly: false });
      await persist('Google 설문 연결 해제됨'); renderAll(); showToast('프로젝트 연결만 해제했습니다. Google 설문은 그대로 남아 있습니다.', 'success');
    });
    $('#confirmLinkedFormAccount').addEventListener('click', async () => {
      let project = activeProject(); let linked = selectedLinkedForm(project); if (!project || !linked) return;
      const connectionId = defaultConnectionId(project, 'forms');
      let connection = state.connections.find((item) => item.id === connectionId && item.type === 'forms' && item.status === 'connected');
      if (!connection) { showToast('이 설문에 사용할 Workspace 기본 Google Forms 계정을 먼저 연결해주세요.', 'error'); navigate('connections'); return; }
      const projectId = project.id; const formId = linked.formId; const signature = externalOperationSignature(project, 'googleForm');
      const accountName = connection.account || connection.label || '선택한 Google 계정';
      if (!await showConfirm(`이 설문의 응답을 “${accountName}” 계정으로 가져오도록 다시 연결할까요? 해당 계정에 이 설문을 볼 권한이 있어야 합니다.`, { title: 'Google 설문 계정 다시 연결', action: '이 계정 사용', danger: false })) return;
      project = projectById(projectId); linked = project?.data.forms.linkedForms.find((item) => item.formId === formId);
      connection = state.connections.find((item) => item.id === connectionId && item.type === 'forms' && item.status === 'connected');
      if (!project || !linked || !connection || externalOperationSignature(project, 'googleForm') !== signature) { showToast('확인하는 동안 설문·프로젝트 또는 계정 상태가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      const previousConnectionReason = linked.connectionReviewReason || '';
      linked.connectionId = connection.id;
      linked.connectionReviewRequired = false;
      linked.connectionReviewReason = '';
      linked.accountConfirmedAt = new Date().toISOString();
      if (previousConnectionReason && linked.reviewReason === previousConnectionReason) { linked.needsReview = false; linked.reviewReason = ''; }
      state = Core.updateProject(state, projectId, { data: project.data });
      applyAvailabilityFormConsistency(project, linked);
      state = Core.updateProject(state, projectId, { data: { forms: project.data.forms } });
      state = reconcileFormsModuleStatus(state, projectId, `Google 설문 계정 확인됨 · ${accountName}`);
      recordScheduleMergeImpact(projectId, null, { scheduleOnly: false });
      await persist('Google 설문 사용 계정 다시 연결됨'); renderAll(); showToast(`이 설문을 ${accountName} 계정에 다시 연결했습니다.`, 'success');
    });
    $('#syncFormResponses').addEventListener('click', async () => {
      let project = activeProject(); if (!project) return;
      let linked = selectedLinkedForm(project);
      if (!linked) { showToast('응답을 가져올 Google 설문을 먼저 이 프로젝트에 연결해주세요.', 'error'); return; }
      if (linked.connectionReviewRequired || !linked.connectionId) { showToast('먼저 “현재 계정으로 다시 연결”을 눌러 이 설문에 사용할 Google 계정을 확인해주세요.', 'error'); return; }
      const initialAvailabilityConsistency = applyAvailabilityFormConsistency(project, linked);
      if (!initialAvailabilityConsistency.consistent) {
        state = Core.updateProject(state, project.id, { data: { forms: project.data.forms } });
        state = reconcileFormsModuleStatus(state, project.id);
        try { await persist('가능 시간 설문과 프로젝트 일정 불일치 확인됨'); } catch (_) {}
        renderAll(); showToast(`${initialAvailabilityConsistency.reason} Google에서 일정 선택지를 맞춘 뒤 설문을 다시 가져와주세요.`, 'error'); return;
      }
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
      if (!project || !linked || linked.connectionReviewRequired || !linked.connectionId || !connection || externalOperationStateChanged(projectId, 'googleForm', baseSignature)) { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); showToast('응답을 가져오기 전에 설문·프로젝트 또는 계정 상태가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      const reservedAvailabilityConsistency = applyAvailabilityFormConsistency(project, linked);
      if (!reservedAvailabilityConsistency.consistent) {
        state = Core.updateProject(state, projectId, { data: { forms: project.data.forms } });
        state = reconcileFormsModuleStatus(state, projectId);
        await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token);
        try { await persist('응답 가져오기 전 가능 시간 설문 일정 재확인됨'); } catch (_) {}
        renderAll(); showToast(`${reservedAvailabilityConsistency.reason} 응답을 가져오지 않았습니다.`, 'error'); return;
      }
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
        const responseNeedsReview = Boolean(result.needsReview || result.unmatched);
        workingProject.data.forms.lastResponseSyncAt = new Date().toISOString(); workingLinked.lastSyncedAt = workingProject.data.forms.lastResponseSyncAt; workingLinked.responseCount = payload.responses.length; workingLinked.responseReviewRequired = responseNeedsReview; workingLinked.responseReviewReason = responseNeedsReview ? result.message : '';
        if (result.dataChanged || result.changed) {
          if (result.type === 'availability') clearScheduleHistory(projectId); else clearRosterHistory();
          markRosterDependenciesStale(workingProject, result.type === 'availability' ? '가능 시간 응답 반영 후 일정 재검토 필요' : '설문 신청 명단 반영 후 일정 재검토 필요');
        }
        else state = Core.updateProject(state, projectId, { data: workingProject.data });
        state = reconcileFormsModuleStatus(state, projectId, `${payload.responses.length}건 동기화${responseNeedsReview ? ' · 응답 확인 필요' : ''}`);
        recordScheduleMergeImpact(projectId, null, { scheduleOnly: false });
        const commitResult = await persist('설문 응답 동기화됨', {
          externalCommit: externalCommitGuard({ reservation, project: latestProject, kind: 'googleForm', expectedConnections: [expectedConnectionIdentity], conflictState })
        });
        renderAll();
        if (commitResult?.externalConflict) showToast('설문 응답은 가져왔지만 그 사이 프로젝트 또는 계정이 바뀌어 응답을 적용하지 않고 확인 필요 상태로 남겼습니다.', 'error');
        else showToast(result.message, responseNeedsReview ? 'normal' : 'success');
      } catch (error) { showToast(`최신 설문 응답을 가져오지 못했습니다: ${error.message}`, 'error'); }
      finally { await releaseExternalArtifacts(connectionReservation.token); await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
    });
    $('#prepareZoomMeetings').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      const problems = [];
      const activeSlots = project.data.slots.filter((slot) => slot.status !== 'cancelled');
      const cancelledWithMeeting = project.data.slots.filter((slot) => slot.status === 'cancelled' && project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status !== 'superseded')).length;
      activeSlots.forEach((slot) => {
        const meetingReadiness = zoomSlotReadiness(project, slot);
        const connectionId = slot.zoomConnectionId || defaultConnectionId(project, 'zoom');
        const connection = state.connections.find((item) => item.id === connectionId && item.type === 'zoom');
        if (!meetingReadiness.ready) problems.push(`${slotRangeText(slot, { includeYear: true })} · ${meetingReadiness.message}`);
        if (!connection) problems.push(`${slotRangeText(slot, { includeYear: true })} · Zoom 계정 미지정`);
        else if (connection.status !== 'connected') problems.push(`${slotRangeText(slot, { includeYear: true })} · ${connection.label} 로그인 필요`);
        if (!project.data.assignments.some((assignment) => assignment.slotId === slot.id)) problems.push(`${slotRangeText(slot, { includeYear: true })} · 배정 인원 없음`);
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
      let invalid = pending.filter((slot) => !zoomSlotReadiness(project, slot).ready || !state.connections.some((item) => item.id === (slot.zoomConnectionId || defaultConnectionId(project, 'zoom')) && item.type === 'zoom' && item.status === 'connected'));
      if (!pending.length) { showToast('새로 생성할 Zoom 회의가 없습니다.'); return; }
      if (invalid.length) { const firstReadiness = zoomSlotReadiness(project, invalid[0]); showToast(firstReadiness.ready ? `Zoom 로그인을 확인해야 하는 일정 ${invalid.length}건을 먼저 수정해주세요.` : `${slotRangeText(invalid[0], { includeYear: true })} · ${firstReadiness.message}`, 'error'); return; }
      const replacementCount = pending.filter((slot) => project.data.externalArtifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id)).length;
      const replacementNotice = replacementCount ? ` 이 중 ${replacementCount}건은 일정이 바뀌어 새 회의를 만들며, 이전 회의는 Zoom에서 직접 정리해야 합니다.` : ' 이미 정상 참가 링크가 있는 일정은 건너뜁니다.';
      const projectId = project.id; const confirmationSignature = externalOperationSignature(project, 'zoom');
      if (!await approveExternalChange(project, `${pending.length}개의 Zoom 회의를 만들까요?${replacementNotice}`, { title: 'Zoom 회의 만들기', action: '회의 만들기' })) return;
      project = projectById(projectId); pending = project ? pendingZoomSlots(project) : [];
      if (!project || externalOperationSignature(project, 'zoom') !== confirmationSignature) { showToast('확인하는 동안 다른 창의 일정 또는 회의 상태가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      invalid = pending.filter((slot) => !zoomSlotReadiness(project, slot).ready || !state.connections.some((item) => item.id === (slot.zoomConnectionId || defaultConnectionId(project, 'zoom')) && item.type === 'zoom' && item.status === 'connected'));
      if (!pending.length || invalid.length) { const firstReadiness = invalid.length ? zoomSlotReadiness(project, invalid[0]) : null; showToast(invalid.length ? (firstReadiness.ready ? '최신 Zoom 로그인 상태를 다시 확인해주세요.' : `${slotRangeText(invalid[0], { includeYear: true })} · ${firstReadiness.message}`) : '다른 창에서 회의 생성이 완료되어 새로 만들 회의가 없습니다.', invalid.length ? 'error' : 'normal'); renderZoomPage(); return; }
      let reservation;
      try { reservation = await reserveExternalArtifacts(projectId, 'zoom', pending.map((slot) => slot.id)); }
      catch (error) { showToast(`회의 생성 작업을 시작하지 못했습니다: ${error.message}`, 'error'); return; }
      if (!reservation.ok) { showToast('다른 창에서 같은 Zoom 회의를 만들고 있습니다. 완료된 뒤 다시 확인해주세요.'); return; }
      project = projectById(projectId); pending = project ? pendingZoomSlots(project) : [];
      if (!project || externalOperationStateChanged(projectId, 'zoom', confirmationSignature)) { await releaseExternalArtifacts(reservation.token); showToast('회의 생성 준비 중 일정 또는 프로젝트 정보가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 시도해주세요.', 'error'); renderAll(); return; }
      beginExternalOperation();
      try {
        let sawScheduleChange = false; let sawCommitConflict = false;
        const batch = await ExternalProgress.runDurableBatch(pending, {
          execute: async (initialSlot) => {
            const iterationProject = projectById(projectId);
            const slot = iterationProject?.data.slots.find((item) => item.id === initialSlot.id);
            if (!iterationProject || !slot) throw new Error('최신 일정에서 항목을 찾지 못했습니다.');
            const iterationSignature = externalOperationSignature(iterationProject, 'zoom');
            if (externalOperationStateChanged(projectId, 'zoom', iterationSignature)) throw new Error('다른 창에서 일정 또는 프로젝트 정보가 바뀌었습니다.');
            const connectionId = slot.zoomConnectionId || defaultConnectionId(iterationProject, 'zoom');
            const zoomConnection = latestKnownConnection(connectionId);
            if (!zoomConnection || zoomConnection.type !== 'zoom' || zoomConnection.status !== 'connected') throw new Error('Zoom 계정의 최신 로그인 상태를 확인해주세요.');
            const expectedConnectionIdentity = Core.connectionIdentity(zoomConnection);
            const meetingReadiness = zoomSlotReadiness(iterationProject, slot); const meetingInterval = meetingReadiness.interval;
            if (!meetingReadiness.ready || !Number.isFinite(meetingInterval?.durationMinutes) || meetingInterval.durationMinutes <= 0) throw new Error(meetingReadiness.message || '이 일정의 날짜·시간이 프로젝트 시간대에서 유효하지 않아 Zoom 회의를 만들 수 없습니다. 일정표에서 시간을 먼저 고쳐주세요.');
            const duration = meetingInterval.durationMinutes;
            const meeting = await globalThis.workspaceDesktop.createZoomMeeting(connectionId, { topic: `${iterationProject.name}${slot.label ? ` · ${slot.label}` : ''}`, date: slot.date, endDate: slot.endDate || slot.date, startTime: slot.startTime, endTime: slot.endTime, duration, timezone: iterationProject.settings?.timezone || 'Asia/Seoul', agenda: `${iterationProject.name} 일정` }, expectedConnectionIdentity);
            return { slot, iterationSignature, expectedConnectionIdentity, artifact: { kind: 'zoom', slotId: slot.id, connectionId, status: 'created', externalId: String(meeting.id), joinUrl: meeting.join_url || '', startUrl: meeting.start_url || '', password: meeting.password || '', createdAt: new Date().toISOString() } };
          },
          commit: async (_initialSlot, payload, index) => {
            const currentProject = latestKnownProject(projectId);
            if (!currentProject) throw new Error('회의 생성 결과를 반영할 프로젝트를 찾지 못했습니다.');
            const scheduleChanged = externalOperationStateChanged(projectId, 'zoom', payload.iterationSignature);
            const connectionChanged = !Core.connectionIdentityMatches(latestKnownConnection(payload.artifact.connectionId), payload.expectedConnectionIdentity);
            sawScheduleChange ||= scheduleChanged; const artifacts = currentProject.data.externalArtifacts.map((item) => ({ ...item }));
            if (!scheduleChanged && !connectionChanged) artifacts.filter((item) => item.kind === 'zoom' && item.slotId === payload.artifact.slotId && item.status !== 'superseded').forEach((item) => {
              item.status = 'superseded'; item.replacedAt ||= new Date().toISOString(); item.replacementReason ||= '선택한 Zoom 계정으로 새 회의가 생성됨'; item.replacementConnectionId = payload.artifact.connectionId;
            });
            const committedArtifact = connectionChanged
              ? { ...payload.artifact, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: 'Zoom 계정 변경 후 이전 계정에 생성된 회의' }
              : { ...payload.artifact, status: scheduleChanged ? 'stale' : 'created' };
            artifacts.push(committedArtifact);
            state = Core.updateProject(state, projectId, { data: { externalArtifacts: artifacts } });
            state = Core.setModuleStatus(state, projectId, 'zoom', scheduleChanged || connectionChanged ? 'needsReview' : 'inProgress', `${index + 1}/${pending.length}개 회의 결과 저장됨`);
            const conflictReason = 'Zoom 생성 결과를 저장하는 동안 프로젝트 또는 계정이 바뀌어 회의 확인 필요';
            const commitResult = await persist(`Zoom ${index + 1}/${pending.length} 저장됨`, {
              externalCommit: externalCommitGuard({ reservation, project: currentProject, kind: 'zoom', expectedConnections: [payload.expectedConnectionIdentity], conflictState: markExternalArtifactsForCommitConflict(state, projectId, 'zoom', [committedArtifact], conflictReason) })
            });
            sawCommitConflict ||= Boolean(commitResult?.externalConflict);
            $('#zoomReadiness').textContent = `${index + 1}/${pending.length} 생성·저장 완료`;
            return commitResult;
          }
        });
        const createdCount = batch.successes.length; const failures = batch.failures.map(({ item, error }) => `${slotRangeText(item, { includeYear: true })}: ${error.message}`);
        const currentProject = latestKnownProject(projectId); if (!currentProject) throw new Error('회의 생성 결과를 반영할 프로젝트를 찾지 못했습니다.');
        const artifacts = currentProject.data.externalArtifacts;
        const unresolved = artifacts.some((item) => item.kind === 'zoom' && item.status === 'stale') || currentProject.data.slots.some((slot) => slot.status === 'cancelled' && artifacts.some((item) => item.kind === 'zoom' && item.slotId === slot.id && item.status !== 'superseded'));
        state = Core.setModuleStatus(state, projectId, 'zoom', failures.length || sawScheduleChange || sawCommitConflict || unresolved ? 'needsReview' : 'complete', sawScheduleChange || sawCommitConflict ? `${createdCount}개 생성 · 도중 변경으로 재확인 필요` : failures.length ? `${createdCount}개 생성, ${failures.length}개 실패` : unresolved ? `${createdCount}개 생성 · 기존 회의 정리 필요` : `${createdCount}개 생성 완료`);
        await persist('Zoom 생성 작업 저장됨');
        renderAll();
        if (sawCommitConflict) showToast(createdCount ? 'Zoom 회의는 생성됐지만 그 사이 프로젝트 또는 계정이 바뀌어 프로젝트에는 확인 필요 상태로 남겼습니다.' : 'Zoom 생성 결과를 저장하는 사이 프로젝트 또는 계정이 바뀌어 프로젝트를 확인 필요 상태로 남겼습니다.', 'error');
        else showToast(sawScheduleChange ? '회의 생성 중 일정이 바뀌어 새 회의를 확인 대상으로 표시했습니다.' : failures.length ? `Zoom ${createdCount}개 생성, ${failures.length}개 실패` : `Zoom 회의 ${createdCount}개를 생성했습니다.`, sawScheduleChange || failures.length ? 'error' : unresolved ? 'normal' : 'success');
      } catch (error) { renderAll(); showToast(`Zoom 생성 결과 저장을 중단했습니다: ${error.message}. 이미 저장된 회의는 다음 실행에서 건너뜁니다.`, 'error'); }
      finally { await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
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
      const pkg = buildWorkspaceMailPackage(project);
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
        let sawScheduleChange = false; let sawCommitConflict = false;
        const batch = await ExternalProgress.runDurableBatch(pending, {
          execute: async (initialEntry) => {
            const iterationProject = projectById(projectId);
            if (!iterationProject) throw new Error('최신 프로젝트를 찾지 못했습니다.');
            const iterationSignature = externalOperationSignature(iterationProject, 'gmailDraft');
            if (externalOperationStateChanged(projectId, 'gmailDraft', iterationSignature)) throw new Error('다른 창에서 명단·일정 또는 메일 내용이 바뀌었습니다.');
            const entry = buildWorkspaceMailPackage(iterationProject).entries.find((item) => item.personId === initialEntry.personId);
            if (!entry) throw new Error('최신 메일 준비 목록에서 받는 사람을 찾지 못했습니다.');
            const artifact = latestActiveExternalArtifact(iterationProject, 'gmailDraft', (item) => item.personId === entry.personId && item.connectionId === connection.id);
            if (artifact) {
              const artifactConnection = latestKnownConnection(artifact.connectionId);
              if (!artifactConnection || artifactConnection.type !== 'gmail' || artifactConnection.status !== 'connected') throw new Error('기존 메일을 만든 Gmail 계정에 다시 로그인해야 합니다.');
              const expectedConnectionIdentity = Core.connectionIdentity(artifactConnection);
              const draft = await globalThis.workspaceDesktop.updateGmailDraft(artifactConnection.id, artifact.externalId, entry, expectedConnectionIdentity);
              return { action: 'updated', entry, iterationSignature, expectedConnectionIdentity, artifact: { ...artifact, messageId: draft.message?.id || artifact.messageId, status: 'created', updatedAt: new Date().toISOString() } };
            }
            const currentConnection = latestKnownConnection(connection.id);
            if (!currentConnection || currentConnection.type !== 'gmail' || currentConnection.status !== 'connected') throw new Error('Gmail 계정의 최신 로그인 상태를 확인해주세요.');
            const expectedConnectionIdentity = Core.connectionIdentity(currentConnection);
            const draft = await globalThis.workspaceDesktop.createGmailDraft(currentConnection.id, entry, expectedConnectionIdentity);
            return { action: 'created', entry, iterationSignature, expectedConnectionIdentity, artifact: { kind: 'gmailDraft', personId: entry.personId, connectionId: currentConnection.id, status: 'created', externalId: draft.id, messageId: draft.message?.id || '', createdAt: new Date().toISOString() } };
          },
          commit: async (_initialEntry, payload, index) => {
            const currentProject = latestKnownProject(projectId); if (!currentProject) throw new Error('메일 생성 결과를 반영할 프로젝트를 찾지 못했습니다.');
            const scheduleChanged = externalOperationStateChanged(projectId, 'gmailDraft', payload.iterationSignature);
            const connectionChanged = !Core.connectionIdentityMatches(latestKnownConnection(payload.artifact.connectionId), payload.expectedConnectionIdentity);
            sawScheduleChange ||= scheduleChanged; let artifacts = currentProject.data.externalArtifacts.map((item) => ({ ...item }));
            const committedArtifact = connectionChanged
              ? { ...payload.artifact, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: 'Gmail 계정 변경 후 이전 계정에 저장된 메일' }
              : scheduleChanged ? { ...payload.artifact, status: 'stale' } : payload.artifact;
            if (committedArtifact.status === 'created') artifacts = artifacts.map((artifact) => artifact.kind === 'gmailDraft' && artifact.personId === committedArtifact.personId && artifact.status !== 'superseded' && artifact.connectionId !== committedArtifact.connectionId
              ? { ...artifact, status: 'superseded', replacedAt: new Date().toISOString(), replacementReason: '프로젝트 기본 Gmail 계정 변경 후 새 계정에 다시 저장됨', replacementConnectionId: committedArtifact.connectionId }
              : artifact);
            artifacts = mergeExternalArtifactUpdates(artifacts, [committedArtifact]);
            const communication = { ...currentProject.data.communication, lastPreparedAt: new Date().toISOString() };
            state = Core.updateProject(state, projectId, { data: { communication, externalArtifacts: artifacts } });
            state = Core.setModuleStatus(state, projectId, 'gmailFlow', scheduleChanged || connectionChanged ? 'needsReview' : 'inProgress', `${index + 1}/${pending.length}명 Gmail 결과 저장됨`);
            const conflictReason = 'Gmail 저장 결과를 반영하는 동안 프로젝트 또는 계정이 바뀌어 메일 확인 필요';
            const commitResult = await persist(`Gmail ${index + 1}/${pending.length} 저장됨`, {
              externalCommit: externalCommitGuard({ reservation, project: currentProject, kind: 'gmailDraft', expectedConnections: [payload.expectedConnectionIdentity], conflictState: markExternalArtifactsForCommitConflict(state, projectId, 'gmailDraft', [committedArtifact], conflictReason) })
            });
            sawCommitConflict ||= Boolean(commitResult?.externalConflict);
            $('#mailPackageStatus').textContent = `${index + 1}/${pending.length} Gmail 생성·저장 완료`;
            return commitResult;
          }
        });
        const createdCount = batch.successes.filter(({ result }) => result.action === 'created').length;
        const updatedCount = batch.successes.filter(({ result }) => result.action === 'updated').length;
        const failures = batch.failures.map(({ item, error }) => `${item.email}: ${error.message}`);
        const currentProject = latestKnownProject(projectId); if (!currentProject) throw new Error('메일 생성 결과를 반영할 프로젝트를 찾지 못했습니다.');
        const unresolved = currentProject.data.externalArtifacts.some((item) => item.kind === 'gmailDraft' && item.status === 'stale');
        state = Core.setModuleStatus(state, projectId, 'gmailFlow', failures.length || sawScheduleChange || sawCommitConflict || unresolved ? 'needsReview' : 'complete', sawScheduleChange || sawCommitConflict ? `${createdCount}개 생성, ${updatedCount}개 수정 · 도중 변경으로 재확인 필요` : failures.length ? `${createdCount}개 생성, ${updatedCount}개 수정, ${failures.length}개 실패` : unresolved ? `${createdCount}개 생성, ${updatedCount}개 수정 · 남은 메일 확인 필요` : `${createdCount}개 생성, ${updatedCount}개 수정`);
        await persist('Gmail 저장 작업 반영됨');
        renderAll();
        if (sawCommitConflict) showToast(createdCount + updatedCount ? 'Gmail 임시보관함에는 저장됐지만 그 사이 프로젝트 또는 계정이 바뀌어 프로젝트에는 확인 필요 상태로 남겼습니다.' : 'Gmail 저장 결과를 반영하는 사이 프로젝트 또는 계정이 바뀌어 프로젝트를 확인 필요 상태로 남겼습니다.', 'error');
        else showToast(sawScheduleChange ? '메일 저장 중 일정이 바뀌어 해당 초안을 확인 대상으로 표시했습니다.' : failures.length ? `Gmail 임시보관함: 새 메일 ${createdCount}개, 수정 ${updatedCount}개, 실패 ${failures.length}개` : `Gmail 임시보관함에 새 메일 ${createdCount}개를 만들고 기존 메일 ${updatedCount}개를 수정했습니다.`, sawScheduleChange || failures.length ? 'error' : unresolved ? 'normal' : 'success');
      } catch (error) { renderAll(); showToast(`Gmail 저장 결과 반영을 중단했습니다: ${error.message}. 이미 저장된 메일은 다음 실행에서 건너뜁니다.`, 'error'); }
      finally { await releaseExternalArtifacts(reservation.token); endExternalOperation(); }
    });
    $('#downloadMailPackage').addEventListener('click', () => {
      const project = activeProject(); if (!project) return; const pkg = buildWorkspaceMailPackage(project);
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
          const roles = new Set(person.roleIds || []); if (event.target.checked) roles.add(event.target.dataset.roleId); else roles.delete(event.target.dataset.roleId);
          const selectedRoleIds = Ops.normalizePersonRoleIds([...roles], project.data.roles);
          if (!roles.size || !selectedRoleIds.length) showToast('사람은 최소 한 개 역할을 가져야 합니다.');
          person.roleIds = selectedRoleIds;
        }
      }
      if (event.target.matches('[data-person-active]')) {
        const person = project.data.people.find((item) => item.id === event.target.dataset.personActive); if (person) person.active = event.target.checked;
      }
      if (event.target.matches('[data-person-role-check], [data-person-active]')) {
        const rolePersonId = event.target.dataset.personRoleCheck || ''; const roleId = event.target.dataset.roleId || '';
        clearRosterHistory(); markRosterDependenciesStale(project, '명단 배정 조건 변경 후 일정 재검토 필요'); await persist('명단 배정 조건 변경됨'); renderPeoplePage();
        if (rolePersonId) {
          const picker = $$('[data-person-role-picker]').find((item) => item.dataset.personRolePicker === rolePersonId);
          if (picker) { picker.open = true; $$('[data-person-role-check]', picker).find((item) => item.dataset.roleId === roleId)?.focus(); }
        }
        return;
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
        const existing = matches[position]; if (scheduleRowLocked(project, slotId) || existing?.locked) { showToast(scheduleRowLockMessage(project, slotId, '배치를 변경'), 'error'); renderSchedulePage(); return; } if (existing) { project.data.assignments = project.data.assignments.filter((assignment) => assignment.id !== existing.id); removeActivityAssignmentLinks(project, { assignmentIds: [existing.id] }); }
        if (event.target.value) project.data.assignments.push({ id: `assignment-${Date.now().toString(36)}-${position}`, slotId, roleId, personId: event.target.value, locked: false, source: 'manual' });
        pruneActivityAssignmentsAfterCalendarChange(project);
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
        const gmailDependency = routeChanged
          ? staleGmailDraftsForZoomSlots(project, new Set([slot.id]), '일정별 Zoom 계정 변경 후 안내 메일의 회의 링크 재확인 필요')
          : { changed: 0, personIds: [] };
        state = Core.updateProject(state, project.id, { data: project.data });
        if (superseded && project.installedModules.includes('zoom')) state = Core.setModuleStatus(state, project.id, 'zoom', 'stale', '일정별 Zoom 계정 변경 후 새 계정으로 다시 생성 필요');
        if (gmailDependency.changed && project.installedModules.includes('gmailFlow')) state = Core.setModuleStatus(state, project.id, 'gmailFlow', 'stale', '일정별 Zoom 계정 변경 후 안내 메일의 회의 링크 재확인 필요');
        recordScheduleMergeImpact(project.id, {
          changedSlotIds: [],
          zoomReviewSlotIds: routeChanged ? [slot.id] : [],
          affectedPersonIds: gmailDependency.personIds
        }, { scheduleOnly: false });
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
        const used = project.data.people.some((person) => person.roleIds.includes(roleRemove.dataset.roleRemove)) || project.data.assignments.some((assignment) => assignment.roleId === roleRemove.dataset.roleRemove) || project.data.activityAssignments.some((assignment) => assignment.roleId === roleRemove.dataset.roleRemove);
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
        const removedAssignmentIds = new Set(project.data.assignments.filter((assignment) => assignment.slotId === slotRemove.dataset.slotRemove).map((assignment) => assignment.id));
        project.data.slots = project.data.slots.filter((item) => item.id !== slotRemove.dataset.slotRemove);
        project.data.assignments = project.data.assignments.filter((assignment) => assignment.slotId !== slotRemove.dataset.slotRemove);
        removeCalendarDataForSlots(project, [slotRemove.dataset.slotRemove], removedAssignmentIds);
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
        const beforeSnapshot = takeSchedulePersistBaseline(project, scheduleSnapshot(project)); const currentSlots = project.data.slots; const currentActivities = project.data.activities || []; const currentActivityAssignments = project.data.activityAssignments || []; const currentAvailability = project.data.availability; pushScheduleHistory(project); project.data.slots = JSON.parse(JSON.stringify(version.slots));
        const validPersonIds = new Set(project.data.people.map((person) => person.id)); const validRoleIds = new Set(project.data.roles.map((role) => role.id)); const restoredSlotIds = new Set(project.data.slots.map((slot) => slot.id)); const versionAssignments = JSON.parse(JSON.stringify(version.assignments || [])); const validAssignments = versionAssignments.filter((assignment) => validPersonIds.has(assignment.personId) && restoredSlotIds.has(assignment.slotId) && (!assignment.roleId || validRoleIds.has(assignment.roleId))); const skippedAssignments = versionAssignments.length - validAssignments.length; project.data.assignments = validAssignments;
        project.data.activities = (Array.isArray(version.activities) ? JSON.parse(JSON.stringify(version.activities)) : JSON.parse(JSON.stringify(currentActivities))).filter((activity) => restoredSlotIds.has(storedId(activity.eventId, activity.slotId)));
        const restoredActivityIds = new Set(project.data.activities.map((activity) => activity.id)); const activityLinks = Array.isArray(version.activityAssignments) ? JSON.parse(JSON.stringify(version.activityAssignments)) : JSON.parse(JSON.stringify(currentActivityAssignments)); project.data.activityAssignments = activityLinks.filter((assignment) => restoredActivityIds.has(assignment.activityId) && validPersonIds.has(assignment.personId) && (!assignment.roleId || validRoleIds.has(assignment.roleId))); pruneActivityAssignmentsAfterCalendarChange(project); const skippedActivityAssignments = activityLinks.length - project.data.activityAssignments.length;
        if (version.availability && typeof version.availability === 'object') project.data.availability = Object.fromEntries(Object.entries(version.availability).filter(([personId]) => validPersonIds.has(personId)).map(([personId, slotIds]) => [personId, (slotIds || []).filter((slotId) => restoredSlotIds.has(slotId))]));
        else project.data.availability = Object.fromEntries(Object.entries(currentAvailability || {}).filter(([personId]) => validPersonIds.has(personId)).map(([personId, slotIds]) => { const selectedKeys = new Set((slotIds || []).map((slotId) => currentSlots.find((slot) => slot.id === slotId)).filter(Boolean).map(Ops.slotKey)); return [personId, project.data.slots.filter((slot) => selectedKeys.has(Ops.slotKey(slot))).map((slot) => slot.id)]; }));
        const versionCustomValues = version.scheduleCustomValues && typeof version.scheduleCustomValues === 'object' ? JSON.parse(JSON.stringify(version.scheduleCustomValues)) : project.data.scheduleCustomValues || {};
        project.data.scheduleCustomValues = Object.fromEntries(Object.entries(versionCustomValues).filter(([slotId]) => restoredSlotIds.has(slotId)));
        if (version.scheduleSheetInitialized !== undefined) project.data.scheduleSheetInitialized = Boolean(version.scheduleSheetInitialized);
        if (Array.isArray(version.scheduleSheetColumns)) project.data.scheduleSheetColumns = JSON.parse(JSON.stringify(version.scheduleSheetColumns));
        if (version.projectCalendar && typeof version.projectCalendar === 'object') { project.data.extensionData ||= {}; project.data.extensionData.projectCalendar = JSON.parse(JSON.stringify(version.projectCalendar)); }
        const rosterPrune = Core.pruneRosterReferences(project);
        const skippedGroupMembers = Number(rosterPrune.removedGroupMemberships || 0);
        refreshScheduleConflicts(project);
        const impact = applyScheduleMutationImpact(project, beforeSnapshot); syncScheduleProjectState(project, `일정 버전 복원 · 문제 ${project.data.conflicts.length}건`, impact); const skippedTotal = skippedAssignments + skippedActivityAssignments + skippedGroupMembers; if (skippedTotal) state = Core.setModuleStatus(state, project.id, 'schedule', 'needsReview', `일정 버전 복원 · 현재 명단/역할과 맞지 않는 항목 ${skippedTotal}건 제외`); await persist(); renderAll(); showToast(skippedTotal ? `일정 버전을 복원했고 현재 명단·역할과 맞지 않는 항목 ${skippedTotal}건은 제외했습니다.` : '일정 버전을 복원했습니다.', skippedTotal ? 'normal' : 'success'); return;
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
      if (programLaunch) { const programId = programLaunch.dataset.programLaunch; const project = activeProject(); if (programId === 'projectCalendar' && !project) { showToast('프로젝트 캘린더를 열려면 먼저 프로젝트를 만들거나 선택해주세요.', 'error'); return; } await globalThis.workspaceDesktop.openProgram(programId, programId === 'projectCalendar' ? { projectId: project.id } : undefined); return; }
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
        if (!await showConfirm(`“${module?.name || '확장'}” 로컬 확장 파일을 삭제할까요? 프로젝트의 설정과 데이터는 보존되며, 같은 확장을 다시 설치하면 이어서 사용할 수 있습니다.`, { title: '확장 파일 삭제', action: '삭제' })) return;
        await globalThis.workspaceDesktop.removeExtensionFile(extensionFileRemove.dataset.extensionFileRemove);
        const manifests = await globalThis.workspaceDesktop.listExtensions(); extensionManifests = manifests; Core.configureExtensionCatalog(manifests); state = Core.normalizeState(state);
        await persist(); renderAll(); renderModulesPage(); showToast('로컬 확장 파일을 삭제했습니다.'); return;
      }
      const openProject = event.target.closest('[data-project-open]');
      if (openProject) { await switchProject(openProject.dataset.projectOpen); return; }
      const duplicate = event.target.closest('[data-project-duplicate]');
      if (duplicate) {
        const source = state.projects.find((project) => project.id === duplicate.dataset.projectDuplicate); if (!source) return;
        if (!await showConfirm(`“${source.name}”의 업무 단계와 설정만 새 프로젝트로 복제할까요? 명단에 들어 있는 개인정보와 일정·메일·회의·설문 연결은 복제하지 않습니다.`, { title: '프로젝트 구조 복제', action: '구조 복제', danger: false })) return;
        const result = Core.duplicateProject(state, duplicate.dataset.projectDuplicate);
        state = result.state; await persist(); renderAll(); renderProjectsPage();
        showToast('명단 개인정보와 외부 연결을 제외하고 프로젝트 구조를 복제했습니다.', 'success'); return;
      }
      const restore = event.target.closest('[data-project-restore]');
      if (restore) {
        state = Core.restoreProject(state, restore.dataset.projectRestore);
        await persist(); renderAll(); renderProjectsPage(); showToast('프로젝트를 복원했습니다.', 'success'); return;
      }
      const serviceConnect = event.target.closest('[data-service-connect]');
      if (serviceConnect) {
        await startServiceConnection(serviceConnect.dataset.serviceConnect, serviceConnect);
        return;
      }
      const authorizationCancel = event.target.closest('[data-connection-authorization-cancel]');
      if (authorizationCancel) {
        await cancelWorkspaceConnectionAuthorization(authorizationCancel.dataset.connectionAuthorizationCancel, authorizationCancel);
        return;
      }
      const authorizeConnection = event.target.closest('[data-connection-authorize]');
      if (authorizeConnection) {
        await authorizeWorkspaceConnection(authorizeConnection.dataset.connectionAuthorize, authorizeConnection);
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
        if (!connection) { showToast('이미 삭제된 계정 설정입니다.'); return; }
        if (!await showConfirm(`“${connection?.label || '계정'}” 설정을 완전히 삭제할까요? Workspace 기본 계정, 프로젝트 예외 연결, Drive 동기화 선택에서도 해제됩니다.`, { title: '계정 설정 삭제', action: '삭제' })) return;
        connection = state.connections.find((item) => item.id === connectionId);
        if (!connection) { showToast('다른 창에서 이미 계정 설정을 삭제했습니다.'); return; }
        try {
          const credentialRemoval = guideSession
            ? Promise.resolve({ removed: true })
            : globalThis.workspaceDesktop.removeConnection(connectionId);
          retireArtifactsForConnection(connection, '계정 설정 삭제 후 기존 외부 항목 재확인 필요');
          state = Core.removeConnection(state, connectionId);
          if (!mailEditorDirty && !hasFocusedWorkspaceDraft()) renderAll();
          if (currentPage === 'connections') renderConnectionsPage();
          await Promise.all([persist(), credentialRemoval]);
          showToast('계정 설정을 삭제했습니다.');
        } catch (error) {
          showToast(`계정 설정은 목록에서 제거했지만 저장된 로그인 정보 정리를 완료하지 못했습니다: ${error.message}`, 'error');
        }
      }
    });

    $('#duplicateProjectButton').addEventListener('click', async () => {
      const project = activeProject(); if (!project) return;
      if (!await showConfirm(`“${project.name}”의 업무 단계와 설정만 새 프로젝트로 복제할까요? 명단에 들어 있는 개인정보와 일정·메일·회의·설문 연결은 복제하지 않습니다.`, { title: '프로젝트 구조 복제', action: '구조 복제', danger: false })) return;
      const result = Core.duplicateProject(state, project.id);
      state = result.state; await persist(); renderAll(); showToast('명단 개인정보와 외부 연결을 제외하고 프로젝트 구조를 복제했습니다.', 'success');
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
      if (projectLinkedProgram) document.body.classList.add('project-linked-program');
      const module = Core.MODULE_CATALOG.find((item) => item.id === standaloneProgram); $('#standaloneTitle').textContent = module?.name || 'CMOE 프로그램'; document.title = `${module?.name || 'CMOE'} · CMOE Workspace`;
      const related = { gmailFlow: ['people', 'schedule'], schedule: ['people', 'projectCalendar', 'layout', 'zoom', 'gmailFlow'], projectCalendar: ['people', 'schedule', 'layout', 'zoom', 'gmailFlow'], people: ['schedule', 'projectCalendar', 'gmailFlow', 'documentEditor'], layout: ['schedule', 'projectCalendar', 'gmailFlow', 'documentEditor'], zoom: ['schedule', 'projectCalendar', 'gmailFlow'], forms: ['people', 'schedule', 'projectCalendar'], documentEditor: ['people'] }[standaloneProgram] || [];
      $$('[data-quick-program]').forEach((button) => { button.hidden = !related.includes(button.dataset.quickProgram); });
      if (!state.installedExtensions.includes(standaloneProgram)) { await globalThis.workspaceDesktop.openWorkspace(); window.close(); return; }
      currentPage = standaloneProgram;
    }
    bindEvents();
    await globalThis.CMOEDocumentToolsUI?.initialize({ showToast, confirm: showConfirm, requestName, updateWorkflowStatus: updateDocumentToolWorkflowStatus });
    globalThis.workspaceDesktop?.onDocumentEditorModeRequested?.((mode) => navigate('documentEditor', { documentMode: mode }));
    assertStaticAccessibilityMarkup();
    renderAll();
    if (standaloneProgram) navigate(standaloneProgram, { documentMode: launchDocumentMode });
    if (globalThis.workspaceDesktop) {
      const info = await globalThis.workspaceDesktop.getAppInfo();
      $('#appVersion').textContent = `CMOE Workspace ${info.version}`;
      appUpdateState = { ...appUpdateState, currentVersion: info.version };
      try { appUpdateState = { ...appUpdateState, ...(await globalThis.workspaceDesktop.getUpdateStatus()) }; } catch (_) {}
      globalThis.workspaceDesktop.onUpdateProgress?.((progress) => { appUpdateState.progress = progress; renderAppUpdate(); });
      renderAppUpdate();
      if (appUpdateState.packaged && !smokeDiagnostics) setTimeout(() => void checkAppUpdate({ quiet: true }), 1500);
      globalThis.workspaceDesktop.onStateChanged((nextState) => {
        const normalized = Core.normalizeState(nextState);
        if (guideSession) {
          if (workspaceStateIsNewer(normalized, guideSession.latestExternalState || guideSession.realStateFallback)) guideSession.latestExternalState = normalized;
          return;
        }
        const incomingRevision = Number(normalized._revision || 0); const currentRevision = Number(state._revision || 0);
        const newer = incomingRevision > currentRevision || (incomingRevision === currentRevision && String(normalized.updatedAt || '') > String(state.updatedAt || ''));
        if (newer) {
          if (schedulePersistBaseline || persistSaving || persistDirty || externalOperationCount || mailEditorDirty || formEditorDirty || hasFocusedWorkspaceDraft()) {
            if (formsWorkspaceSurfaceChanged(state, normalized)) { pendingMergedFormsRender = true; scheduleMergedFormsRefresh(); }
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

  async function flushDriveStateForClose(timeoutMs = 2500) {
    if (state.preferences.storageMode !== 'drive' || (!driveSyncDirty && !driveSyncPromise)) return true;
    let timeout = null;
    const outcome = await Promise.race([
      flushDriveStateSync(false).then(
        (ok) => ({ settled: true, ok: Boolean(ok), error: ok ? null : lastDriveSyncError }),
        (error) => { driveSyncDirty = true; lastDriveSyncError = error; return { settled: true, ok: false, error }; }
      ),
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ settled: false, ok: false, error: null }), timeoutMs); })
    ]);
    clearTimeout(timeout);
    if (outcome.settled && outcome.ok) return true;
    const remoteError = outcome.error?.message || lastDriveSyncError?.message || (outcome.settled
      ? 'Google Drive 동기화를 완료하지 못했습니다.'
      : 'Google Drive 동기화가 백그라운드에서 아직 끝나지 않았습니다.');
    clearTimeout(saveTimer);
    if ($('#saveStatus')) $('#saveStatus').textContent = '이 PC 저장됨 · Drive 동기화 보류';
    return { ok: true, localSaved: true, remotePending: true, remoteError };
  }

  globalThis.flushWorkspaceEdits = async () => {
    if (guideSession) return true;
    clearTimeout(mailDraftTimer);
    clearTimeout(formDraftTimer);
    await commitFocusedWorkspaceDraft();
    await flushRosterFormulaPersist();
    await flushArrangementPersist();
    await waitForExternalOperations();
    try { await flushSchedulePersist(); } catch (_) {}
    if (mailEditorDirty) await saveMailEditorDraft();
    if (formEditorDirty) await saveFormEditorDraft();
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
    return flushDriveStateForClose();
  };

  void initialize();
})();
