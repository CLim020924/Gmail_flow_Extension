(function exposeWorkspaceCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkspaceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const FORMAT = 'cmoe-workspace';
  const VERSION = 1;

  const MODULE_CATALOG = [
    {
      id: 'people',
      name: '명단 준비',
      shortName: '명단',
      description: 'Excel·한글 표·CSV 또는 일반 텍스트를 이름·이메일·전화번호가 구분된 명단으로 정리합니다.',
      category: 'core',
      core: true,
      accent: 'blue'
    },
    {
      id: 'forms',
      name: 'Google 설문 만들기',
      shortName: '설문',
      description: '신청자 정보를 받거나 참여 가능한 시간을 조사하고 최신 응답을 가져옵니다.',
      category: 'source',
      core: false,
      accent: 'violet'
    },
    {
      id: 'schedule',
      name: '일정 편성',
      shortName: '일정',
      description: '역할별 인원과 사람별 가능 시간을 기준으로 일정표를 만들고 직접 수정합니다.',
      category: 'core',
      core: true,
      accent: 'green'
    },
    {
      id: 'layout',
      name: '일정표 저장·내보내기',
      shortName: '일정표',
      description: '편성된 일정을 확인하고 Excel 또는 CSV 파일로 저장합니다.',
      category: 'core',
      core: true,
      accent: 'amber'
    },
    {
      id: 'zoom',
      name: 'Zoom 회의 만들기',
      shortName: 'Zoom',
      description: '확정된 일정마다 Zoom 회의를 만들고 참가 링크를 일정에 연결합니다.',
      category: 'integration',
      core: false,
      accent: 'cyan'
    },
    {
      id: 'gmailFlow',
      name: '안내 메일 준비',
      shortName: '메일',
      description: '명단·일정·Zoom 링크로 받는 사람별 메일을 만들고 Gmail 임시보관함에 저장합니다.',
      category: 'integration',
      core: false,
      accent: 'red'
    }
  ];

  const WORKFLOW_ORDER = ['people', 'forms', 'schedule', 'layout', 'zoom', 'gmailFlow'];
  const CONNECTION_TYPES = [
    { id: 'forms', name: 'Google Forms', provider: 'Google' },
    { id: 'drive', name: 'Google Drive', provider: 'Google' },
    { id: 'gmail', name: 'Gmail', provider: 'Google' },
    { id: 'zoom', name: 'Zoom', provider: 'Zoom' }
  ];

  function configureExtensionCatalog(manifests = []) {
    if (!Array.isArray(manifests) || !manifests.length) return MODULE_CATALOG;
    const next = manifests.filter((item) => item?.contributes?.workflow && item.contributes.page).map((item) => ({
      id: item.id,
      name: item.name,
      shortName: item.shortName || item.name,
      description: item.description || '',
      category: item.category || 'utility',
      core: Boolean(item.core),
      accent: item.accent || 'slate',
      icon: item.icon || item.name?.slice(0, 1) || '?',
      version: item.version || '0.0.0',
      bundled: Boolean(item.bundled),
      source: item.source || (item.bundled ? 'bundled' : 'local'),
      permissions: Array.isArray(item.permissions) ? [...item.permissions] : [],
      declarative: item.declarative || null,
      page: item.contributes.page,
      order: Number(item.contributes.order) || 999
    })).sort((a, b) => a.order - b.order);
    if (!next.length) return MODULE_CATALOG;
    MODULE_CATALOG.splice(0, MODULE_CATALOG.length, ...next);
    WORKFLOW_ORDER.splice(0, WORKFLOW_ORDER.length, ...next.map((item) => item.id));
    return MODULE_CATALOG;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function makeId(prefix = 'item') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createEmptyState() {
    return {
      format: FORMAT,
      version: VERSION,
      _revision: 0,
      _baseRevision: 0,
      activeProjectId: null,
      projects: [],
      connections: [],
      installedExtensions: MODULE_CATALOG.map((module) => module.id),
      quickWorkspaces: {},
      quickTasks: {},
      library: { rosters: [], mailTemplates: [], layoutTemplates: [] },
      deletedConnectionIds: [],
      deletedLibraryIds: [],
      preferences: {
        theme: 'light',
        showArchivedProjects: false,
        storageMode: 'local'
      },
      updatedAt: nowIso()
    };
  }

  function normalizeProject(project) {
    const knownModuleIds = new Set(MODULE_CATALOG.map((module) => module.id));
    const installed = new Set((Array.isArray(project.installedModules) ? project.installedModules : []).filter((id) => knownModuleIds.has(id)));
    MODULE_CATALOG.filter((module) => module.core).forEach((module) => installed.add(module.id));
    const moduleState = {};
    for (const module of MODULE_CATALOG) {
      const current = project.moduleState?.[module.id] || {};
      moduleState[module.id] = {
        status: ['notStarted', 'inProgress', 'needsReview', 'complete', 'stale'].includes(current.status)
          ? current.status
          : 'notStarted',
        updatedAt: current.updatedAt || null,
        summary: current.summary || ''
      };
    }
    const defaultRoles = [
      { id: 'member', name: '배정 인원', candidateFilter: 'all', minPerSession: 1, maxPerSession: 1, targetSessions: 1, active: true, color: '#2879b8' }
    ];
    const data = project.data && typeof project.data === 'object' ? project.data : {};
    const roles = Array.isArray(data.roles) && data.roles.length ? data.roles.map((role) => ({
      id: role.id || makeId('role'),
      name: String(role.name || '역할').trim(),
      candidateFilter: typeof role.candidateFilter === 'string' ? role.candidateFilter : 'manual',
      minPerSession: Math.max(0, Number(role.minPerSession) || 0),
      maxPerSession: Math.max(1, Number(role.maxPerSession) || 1),
      targetSessions: Math.max(0, Number(role.targetSessions) || 0),
      active: role.active !== false,
      color: role.color || '#66717e'
    })) : defaultRoles;
    return {
      id: project.id || makeId('project'),
      name: String(project.name || '이름 없는 프로젝트').trim(),
      client: String(project.client || '').trim(),
      description: String(project.description || '').trim(),
      status: ['active', 'paused', 'completed', 'archived'].includes(project.status) ? project.status : 'active',
      startDate: project.startDate || '',
      endDate: project.endDate || '',
      createdAt: project.createdAt || nowIso(),
      updatedAt: project.updatedAt || nowIso(),
      installedModules: [...installed],
      moduleState,
      settings: {
        timezone: project.settings?.timezone || 'Asia/Seoul',
        sessionDurationMinutes: Number(project.settings?.sessionDurationMinutes) || 60,
        participantMin: Number.isFinite(Number(project.settings?.participantMin)) ? Number(project.settings.participantMin) : 2,
        participantMax: Number.isFinite(Number(project.settings?.participantMax)) ? Number(project.settings.participantMax) : 2,
        coachRequired: Boolean(project.settings?.coachRequired),
        changeApprovalRequired: project.settings?.changeApprovalRequired !== false,
        defaultConnectionIds: {
          forms: project.settings?.defaultConnectionIds?.forms || null,
          drive: project.settings?.defaultConnectionIds?.drive || null,
          gmail: project.settings?.defaultConnectionIds?.gmail || null,
          zoom: project.settings?.defaultConnectionIds?.zoom || null
        }
      },
      counts: {
        people: Array.isArray(data.people) ? data.people.filter((person) => person.active !== false).length : Number(project.counts?.people) || 0,
        sessions: Array.isArray(data.slots) ? data.slots.length : Number(project.counts?.sessions) || 0,
        unresolved: Array.isArray(data.conflicts) ? data.conflicts.length : Number(project.counts?.unresolved) || 0
      },
      data: {
        columns: Array.isArray(data.columns) ? data.columns : [],
        people: Array.isArray(data.people) ? data.people.map((person, index) => ({
          id: person.id || makeId('person'),
          sourceOrder: Number.isFinite(Number(person.sourceOrder)) ? Number(person.sourceOrder) : index,
          values: person.values && typeof person.values === 'object' ? person.values : {},
          name: String(person.name || '').trim(),
          email: String(person.email || '').trim(),
          phone: String(person.phone || '').trim(),
          group: String(person.group || '').trim(),
          roleIds: Array.isArray(person.roleIds) && person.roleIds.length ? person.roleIds : ['participant'],
          active: person.active !== false
        })) : [],
        workItems: Array.isArray(data.workItems) ? data.workItems.map((item) => ({
          id: item.id || makeId('work'),
          name: String(item.name || '이름 없는 작업').trim(),
          type: ['grouping', 'matching', 'free'].includes(item.type) ? item.type : 'free',
          createdAt: item.createdAt || nowIso(),
          updatedAt: item.updatedAt || nowIso(),
          sourceRosterUpdatedAt: item.sourceRosterUpdatedAt || null,
          settings: item.settings && typeof item.settings === 'object' ? item.settings : {},
          columns: Array.isArray(item.columns) ? item.columns.map((column) => ({ id: column.id || makeId('work-column'), name: String(column.name || '컬럼').trim() })) : [],
          rows: Array.isArray(item.rows) ? item.rows.map((row) => ({ id: row.id || makeId('work-row'), personId: row.personId || null, values: row.values && typeof row.values === 'object' ? row.values : {} })) : []
        })) : [],
        activeWorkItemId: data.activeWorkItemId || null,
        roles,
        slots: Array.isArray(data.slots) ? data.slots : [],
        availability: data.availability && typeof data.availability === 'object' ? data.availability : {},
        assignments: Array.isArray(data.assignments) ? data.assignments : [],
        conflicts: Array.isArray(data.conflicts) ? data.conflicts : [],
        scheduleSheetInitialized: Boolean(data.scheduleSheetInitialized),
        scheduleSheetColumns: Array.isArray(data.scheduleSheetColumns) ? data.scheduleSheetColumns.map((column) => ({
          id: column.id || makeId('schedule-column'),
          key: column.key || `custom:${column.id || makeId('schedule-column')}`,
          name: String(column.name || '새 컬럼').trim(),
          kind: ['system', 'role', 'custom'].includes(column.kind) ? column.kind : 'custom',
          roleId: column.roleId || null
        })) : [],
        scheduleCustomValues: data.scheduleCustomValues && typeof data.scheduleCustomValues === 'object' ? data.scheduleCustomValues : {},
        scheduleRules: {
          avoidRepeatPairing: data.scheduleRules?.avoidRepeatPairing !== false,
          avoidPastPairing: data.scheduleRules?.avoidPastPairing !== false,
          groupPreference: ['none', 'same', 'different'].includes(data.scheduleRules?.groupPreference) ? data.scheduleRules.groupPreference : 'none',
          unmarkedMeansAvailable: Boolean(data.scheduleRules?.unmarkedMeansAvailable)
        },
        versions: Array.isArray(data.versions) ? data.versions : [],
        forms: {
          definitions: Array.isArray(data.forms?.definitions) ? data.forms.definitions : [],
          linkedForms: Array.isArray(data.forms?.linkedForms) ? data.forms.linkedForms : [],
          lastResponseSyncAt: data.forms?.lastResponseSyncAt || null
        },
        communication: {
          subjectTemplate: data.communication?.subjectTemplate || '[{프로젝트}] 일정 안내',
          bodyTemplate: data.communication?.bodyTemplate || '{이름}님, 아래 일정으로 안내드립니다.\n\n{개인일정}',
          bodyHtmlTemplate: data.communication?.bodyHtmlTemplate || '',
          mailEdits: data.communication?.mailEdits && typeof data.communication.mailEdits === 'object' ? data.communication.mailEdits : {},
          lastPreparedAt: data.communication?.lastPreparedAt || null
        },
        layout: {
          type: data.layout?.type || 'list',
          name: data.layout?.name || '기본 일정 목록',
          fields: Array.isArray(data.layout?.fields) ? data.layout.fields : ['date', 'time', 'role', 'person', 'status']
        },
        externalArtifacts: Array.isArray(data.externalArtifacts) ? data.externalArtifacts : [],
        extensionData: data.extensionData && typeof data.extensionData === 'object' ? data.extensionData : {}
      }
    };
  }

  function normalizeState(input) {
    const fallback = createEmptyState();
    if (!input || typeof input !== 'object') input = fallback;
    const knownIds = new Set(MODULE_CATALOG.map((module) => module.id));
    const installedExtensions = [...new Set((Array.isArray(input.installedExtensions) ? input.installedExtensions : MODULE_CATALOG.map((module) => module.id)).filter((id) => knownIds.has(id)))];
    MODULE_CATALOG.filter((module) => module.core).forEach((module) => { if (!installedExtensions.includes(module.id)) installedExtensions.push(module.id); });
    const projects = Array.isArray(input.projects) ? input.projects.map(normalizeProject).map((project) => ({ ...project, installedModules: [...installedExtensions] })) : [];
    const quickWorkspaces = {};
    for (const moduleId of knownIds) {
      const existing = input.quickWorkspaces?.[moduleId];
      if (!existing && !installedExtensions.includes(moduleId)) continue;
      const source = existing || { id: `quick-${moduleId}`, name: `${MODULE_CATALOG.find((item) => item.id === moduleId)?.name || moduleId} 빠른 작업`, status: 'active', installedModules: installedExtensions };
      quickWorkspaces[moduleId] = { ...normalizeProject(source), id: `quick-${moduleId}`, scope: 'quick', installedModules: [...installedExtensions], extensionInstalled: installedExtensions.includes(moduleId) };
    }
    const activeExists = projects.some((project) => project.id === input.activeProjectId && project.status !== 'archived');
    const firstActive = projects.find((project) => project.status !== 'archived');
    return {
      format: FORMAT,
      version: VERSION,
      _revision: Number(input._revision || 0),
      _baseRevision: Number(input._baseRevision ?? input._revision ?? 0),
      activeProjectId: activeExists ? input.activeProjectId : firstActive?.id || null,
      projects,
      connections: Array.isArray(input.connections) ? input.connections.map((connection) => ({
        id: connection.id || makeId('connection'),
        type: CONNECTION_TYPES.some((type) => type.id === connection.type) ? connection.type : 'forms',
        label: String(connection.label || '').trim() || '이름 없는 연결',
        account: String(connection.account || '').trim(),
        status: ['connected', 'needsAuth', 'error'].includes(connection.status) ? connection.status : 'needsAuth',
        createdAt: connection.createdAt || nowIso(),
        updatedAt: connection.updatedAt || nowIso()
      })) : [],
      installedExtensions,
      quickWorkspaces,
      quickTasks: Object.fromEntries([...knownIds].map((id) => [id, Array.isArray(input.quickTasks?.[id]) ? input.quickTasks[id] : []])),
      library: {
        rosters: Array.isArray(input.library?.rosters) ? input.library.rosters : [],
        mailTemplates: Array.isArray(input.library?.mailTemplates) ? input.library.mailTemplates : [],
        layoutTemplates: Array.isArray(input.library?.layoutTemplates) ? input.library.layoutTemplates : []
      },
      deletedConnectionIds: Array.isArray(input.deletedConnectionIds) ? input.deletedConnectionIds : [],
      deletedLibraryIds: Array.isArray(input.deletedLibraryIds) ? input.deletedLibraryIds : [],
      preferences: { ...fallback.preferences, ...(input.preferences || {}) },
      updatedAt: input.updatedAt || nowIso()
    };
  }

  function setExtensionInstalled(stateInput, moduleId, installed) {
    const state = normalizeState(stateInput);
    const module = MODULE_CATALOG.find((item) => item.id === moduleId);
    if (!module) throw new Error('알 수 없는 프로그램입니다.');
    if (module.core && !installed) throw new Error('핵심 프로그램은 제거할 수 없습니다.');
    const extensions = new Set(state.installedExtensions);
    if (installed) extensions.add(moduleId); else extensions.delete(moduleId);
    state.installedExtensions = [...extensions];
    state.projects.forEach((project) => { project.installedModules = [...extensions]; });
    if (installed && !state.quickWorkspaces[moduleId]) state.quickWorkspaces[moduleId] = { ...normalizeProject({ id: `quick-${moduleId}`, name: `${module.name} 빠른 작업`, installedModules: [...extensions] }), scope: 'quick' };
    if (state.quickWorkspaces[moduleId]) state.quickWorkspaces[moduleId].extensionInstalled = installed;
    state.updatedAt = nowIso();
    return state;
  }

  function workflowModulesForPreset(preset) {
    if (preset === 'schedule') return ['people', 'schedule', 'layout'];
    if (preset === 'scheduleZoom') return ['people', 'schedule', 'layout', 'zoom'];
    if (preset === 'scheduleMail') return ['people', 'schedule', 'layout', 'gmailFlow'];
    return WORKFLOW_ORDER.slice();
  }

  function createProject(stateInput, values = {}) {
    const state = normalizeState(stateInput);
    const name = String(values.name || '').trim();
    if (!name) throw new Error('프로젝트 이름을 입력해주세요.');
    const timestamp = nowIso();
    const project = normalizeProject({
      id: values.id || makeId('project'),
      name,
      client: values.client,
      description: values.description,
      startDate: values.startDate,
      endDate: values.endDate,
      installedModules: Array.isArray(values.installedModules)
        ? values.installedModules
        : workflowModulesForPreset(values.preset || 'full'),
      createdAt: timestamp,
      updatedAt: timestamp,
      settings: values.settings || {}
    });
    state.projects.unshift(project);
    state.activeProjectId = project.id;
    state.updatedAt = timestamp;
    return { state, project };
  }

  function updateProject(stateInput, projectId, patch = {}) {
    const state = normalizeState(stateInput);
    const index = state.projects.findIndex((project) => project.id === projectId);
    const quickId = Object.keys(state.quickWorkspaces).find((id) => state.quickWorkspaces[id]?.id === projectId);
    if (index < 0 && !quickId) throw new Error('프로젝트 또는 빠른 작업을 찾을 수 없습니다.');
    const current = index >= 0 ? state.projects[index] : state.quickWorkspaces[quickId];
    const merged = {
      ...current,
      ...patch,
      data: {
        ...current.data,
        ...(patch.data || {}),
        scheduleRules: {
          ...current.data?.scheduleRules,
          ...(patch.data?.scheduleRules || {})
        },
        layout: {
          ...current.data?.layout,
          ...(patch.data?.layout || {})
        }
      },
      settings: {
        ...current.settings,
        ...(patch.settings || {}),
        defaultConnectionIds: {
          ...current.settings.defaultConnectionIds,
          ...(patch.settings?.defaultConnectionIds || {})
        }
      },
      updatedAt: nowIso()
    };
    if (!String(merged.name || '').trim()) throw new Error('프로젝트 이름은 비워둘 수 없습니다.');
    if (index >= 0) state.projects[index] = normalizeProject(merged);
    else state.quickWorkspaces[quickId] = { ...normalizeProject(merged), id: projectId, scope: 'quick' };
    state.updatedAt = nowIso();
    return state;
  }

  function setActiveProject(stateInput, projectId) {
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId && item.status !== 'archived');
    if (!project) throw new Error('전환할 프로젝트를 찾을 수 없습니다.');
    state.activeProjectId = project.id;
    state.updatedAt = nowIso();
    return state;
  }

  function archiveProject(stateInput, projectId) {
    let state = updateProject(stateInput, projectId, { status: 'archived' });
    if (state.activeProjectId === projectId) {
      state.activeProjectId = state.projects.find((project) => project.status !== 'archived')?.id || null;
    }
    return state;
  }

  function restoreProject(stateInput, projectId) {
    return updateProject(stateInput, projectId, { status: 'active' });
  }

  function duplicateProject(stateInput, projectId) {
    const state = normalizeState(stateInput);
    const source = state.projects.find((project) => project.id === projectId);
    if (!source) throw new Error('복제할 프로젝트를 찾을 수 없습니다.');
    const result = createProject(state, {
      ...clone(source),
      id: makeId('project'),
      name: `${source.name} 복사본`,
      status: 'active'
    });
    result.project.moduleState = Object.fromEntries(
      MODULE_CATALOG.map((module) => [module.id, { status: 'notStarted', updatedAt: null, summary: '' }])
    );
    result.project.counts = { people: 0, sessions: 0, unresolved: 0 };
    result.project.data = {
      ...result.project.data,
      people: [],
      slots: [],
      availability: {},
      assignments: [],
      conflicts: [],
        versions: [],
        forms: { definitions: [], linkedForms: [], lastResponseSyncAt: null },
        communication: { subjectTemplate: '[{프로젝트}] 일정 안내', bodyTemplate: '{이름}님, 아래 일정으로 안내드립니다.\n\n{개인일정}', bodyHtmlTemplate: '', mailEdits: {}, lastPreparedAt: null },
      externalArtifacts: []
    };
    result.state.projects[0] = normalizeProject(result.project);
    return result;
  }

  function setModuleInstalled(stateInput, projectId, moduleId, installed) {
    const module = MODULE_CATALOG.find((item) => item.id === moduleId);
    if (!module) throw new Error('알 수 없는 모듈입니다.');
    if (module.core && !installed) throw new Error('핵심 모듈은 제거할 수 없습니다.');
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const modules = new Set(project.installedModules);
    if (installed) modules.add(moduleId); else modules.delete(moduleId);
    return updateProject(state, projectId, { installedModules: [...modules] });
  }

  function setModuleStatus(stateInput, projectId, moduleId, status, summary = '') {
    if (!['notStarted', 'inProgress', 'needsReview', 'complete', 'stale'].includes(status)) {
      throw new Error('알 수 없는 작업 상태입니다.');
    }
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId) || Object.values(state.quickWorkspaces).find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    project.moduleState[moduleId] = { status, summary, updatedAt: nowIso() };
    project.updatedAt = nowIso();
    state.updatedAt = nowIso();
    return state;
  }

  function addConnection(stateInput, values = {}) {
    const state = normalizeState(stateInput);
    if (!CONNECTION_TYPES.some((type) => type.id === values.type)) throw new Error('연결 종류를 선택해주세요.');
    const label = String(values.label || '').trim();
    if (!label) throw new Error('연결 이름을 입력해주세요.');
    const connection = {
      id: values.id || makeId('connection'),
      type: values.type,
      label,
      account: String(values.account || '').trim(),
      status: values.status || 'needsAuth',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    state.connections.push(connection);
    state.updatedAt = nowIso();
    return { state, connection };
  }

  function removeConnection(stateInput, connectionId) {
    const state = normalizeState(stateInput);
    state.connections = state.connections.filter((connection) => connection.id !== connectionId);
    state.projects = state.projects.map((project) => {
      const defaults = { ...project.settings.defaultConnectionIds };
      Object.keys(defaults).forEach((key) => { if (defaults[key] === connectionId) defaults[key] = null; });
      return normalizeProject({ ...project, settings: { ...project.settings, defaultConnectionIds: defaults } });
    });
    state.updatedAt = nowIso();
    return state;
  }

  function getActiveProject(stateInput) {
    const state = normalizeState(stateInput);
    return state.projects.find((project) => project.id === state.activeProjectId) || null;
  }

  function getProjectProgress(project) {
    if (!project) return { complete: 0, total: 0, percent: 0 };
    const installed = WORKFLOW_ORDER.filter((id) => project.installedModules.includes(id));
    const complete = installed.filter((id) => project.moduleState?.[id]?.status === 'complete').length;
    return { complete, total: installed.length, percent: installed.length ? Math.round((complete / installed.length) * 100) : 0 };
  }

  return {
    FORMAT,
    VERSION,
    MODULE_CATALOG,
    WORKFLOW_ORDER,
    CONNECTION_TYPES,
    configureExtensionCatalog,
    createEmptyState,
    normalizeState,
    createProject,
    updateProject,
    setActiveProject,
    archiveProject,
    restoreProject,
    duplicateProject,
    setModuleInstalled,
    setExtensionInstalled,
    setModuleStatus,
    addConnection,
    removeConnection,
    getActiveProject,
    getProjectProgress
  };
});
