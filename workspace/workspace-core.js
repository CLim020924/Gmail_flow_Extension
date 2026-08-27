(function exposeWorkspaceCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkspaceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const FORMAT = 'cmoe-workspace';
  const VERSION = 2;

  const MODULE_CATALOG = [
    {
      id: 'people',
      name: '명단 준비',
      shortName: '명단',
      description: 'Excel·한글 표·CSV 또는 일반 텍스트를 이름·이메일·전화번호가 구분된 명단으로 정리합니다.',
      category: 'core',
      core: true,
      accent: 'blue',
      page: 'people'
    },
    {
      id: 'forms',
      name: 'Google 설문 만들기',
      shortName: '설문',
      description: '신청자 정보를 받거나 참여 가능한 시간을 조사하고 최신 응답을 가져옵니다.',
      category: 'source',
      core: false,
      accent: 'violet',
      page: 'forms'
    },
    {
      id: 'schedule',
      name: '일정 편성',
      shortName: '일정',
      description: '역할별 인원과 사람별 가능 시간을 기준으로 일정표를 만들고 직접 수정합니다.',
      category: 'core',
      core: true,
      accent: 'green',
      page: 'schedule'
    },
    {
      id: 'layout',
      name: '일정표 저장·내보내기',
      shortName: '일정표',
      description: '편성된 일정을 확인하고 Excel 또는 CSV 파일로 저장합니다.',
      category: 'core',
      core: true,
      accent: 'amber',
      page: 'layout'
    },
    {
      id: 'zoom',
      name: 'Zoom 회의 만들기',
      shortName: 'Zoom',
      description: '확정된 일정마다 Zoom 회의를 만들고 참가 링크를 일정에 연결합니다.',
      category: 'integration',
      core: false,
      accent: 'cyan',
      page: 'zoom'
    },
    {
      id: 'gmailFlow',
      name: '안내 메일 준비',
      shortName: '메일',
      description: '명단·일정·Zoom 링크로 받는 사람별 메일을 만들고 Gmail 임시보관함에 저장합니다.',
      category: 'integration',
      core: false,
      accent: 'red',
      page: 'gmailFlow'
    }
  ];

  const WORKFLOW_ORDER = ['people', 'forms', 'schedule', 'layout', 'zoom', 'gmailFlow'];
  const CONNECTION_TYPES = [
    { id: 'forms', name: 'Google Forms', provider: 'Google' },
    { id: 'drive', name: 'Google Drive', provider: 'Google' },
    { id: 'gmail', name: 'Gmail', provider: 'Google' },
    { id: 'zoom', name: 'Zoom', provider: 'Zoom' }
  ];

  const TASK_TYPE_CATALOG = [
    { id: 'people', name: '명단·데이터', description: '명단이나 업무 대상 자료를 입력하고 정리합니다.', moduleId: 'people', icon: '표' },
    { id: 'checklist', name: '진행상황·체크리스트', description: '제출·확인·완료 항목을 업무에 맞게 관리합니다.', icon: '✓' },
    { id: 'validation', name: '누락·오류 확인', description: '확인 기준과 발견한 오류를 기록하고 처리합니다.', icon: '!' },
    { id: 'documentReview', name: '문서 검토', description: '문서의 날짜·시간·필수 항목과 검토 결과를 관리합니다.', icon: '문' },
    { id: 'aiReview', name: 'AI 활용·검토', description: '사용할 프롬프트와 AI 결과, 사람의 최종 확인을 기록합니다.', icon: 'AI' },
    { id: 'forms', name: 'Google 설문', description: '정보나 가능한 시간을 Google 설문으로 수집합니다.', moduleId: 'forms', icon: '설' },
    { id: 'schedule', name: '일정·그룹 편성', description: '가능 시간과 조건을 바탕으로 일정을 편성합니다.', moduleId: 'schedule', icon: '일' },
    { id: 'zoom', name: 'Zoom 회의', description: '확정된 일정에 Zoom 회의를 연결합니다.', moduleId: 'zoom', icon: 'Z' },
    { id: 'gmailFlow', name: '안내 메일', description: '대상자별 안내 메일을 작성하고 Gmail에 저장합니다.', moduleId: 'gmailFlow', icon: 'G' },
    { id: 'layout', name: '결과표·Excel', description: '프로젝트 결과를 표로 확인하고 Excel로 저장합니다.', moduleId: 'layout', icon: 'X' },
    { id: 'report', name: '결과 정리·보고서', description: '기존 방식, 테스트 결과, 개선점과 적용 가능성을 정리합니다.', icon: '결' }
  ];

  const BUILTIN_WORKFLOW_TIMESTAMP = '2026-08-19T00:00:00.000Z';

  const BUILTIN_WORKFLOW_TEMPLATES = [
    {
      id: 'template-blank', familyId: 'blank', version: 1, builtin: true,
      name: '빈 프로젝트', description: '명단부터 시작해 필요한 작업만 직접 추가합니다.', category: '기본',
      steps: [{ id: 'template-blank-step-people', type: 'people', name: '명단·자료 준비' }]
    },
    {
      id: 'template-kac', familyId: 'kac', version: 1, builtin: true,
      name: 'KAC 응시자 관리', description: '응시자 명단, 제출 확인, 문서 검토와 안내 업무를 순서대로 관리합니다.', category: 'CMOE 업무',
      steps: [
        { id: 'template-kac-step-people', type: 'people', name: '응시자 명단 준비' },
        { id: 'template-kac-step-checklist', type: 'checklist', name: '제출서류·진행상황 확인' },
        { id: 'template-kac-step-document-review', type: 'documentReview', name: '코칭일지 검토' },
        { id: 'template-kac-step-ai-review', type: 'aiReview', name: 'AI 검토 결과 확인' },
        { id: 'template-kac-step-gmail', type: 'gmailFlow', name: '응시자 안내 메일' },
        { id: 'template-kac-step-layout', type: 'layout', name: '최종 응시자 현황표' }
      ]
    },
    {
      id: 'template-education', familyId: 'education', version: 1, builtin: true,
      name: '교육 프로그램 운영', description: '교육생 명단부터 일정·출결·수료·안내 결과까지 관리합니다.', category: 'CMOE 업무',
      steps: [
        { id: 'template-education-step-people', type: 'people', name: '교육생 명단 준비' },
        { id: 'template-education-step-forms', type: 'forms', name: '신청·가능 시간 조사' },
        { id: 'template-education-step-schedule', type: 'schedule', name: '교육 일정 편성' },
        { id: 'template-education-step-checklist', type: 'checklist', name: '출결·수료 진행상황' },
        { id: 'template-education-step-gmail', type: 'gmailFlow', name: '교육 전후 안내 메일' },
        { id: 'template-education-step-layout', type: 'layout', name: '교육 운영 결과표' }
      ]
    },
    {
      id: 'template-communication', familyId: 'communication', version: 1, builtin: true,
      name: '안내문·메일 업무', description: '명단을 정리하고 대상자별 안내문과 Gmail 초안을 만듭니다.', category: '빠른 시작',
      steps: [{ id: 'template-communication-step-people', type: 'people', name: '받는 사람 명단' }, { id: 'template-communication-step-gmail', type: 'gmailFlow', name: '안내 메일 작성' }]
    },
    {
      id: 'template-document-review', familyId: 'document-review', version: 1, builtin: true,
      name: '문서·AI 검토 실험', description: '검토 기준과 AI 프롬프트, 결과 및 사람의 확인 내용을 함께 기록합니다.', category: 'AI 업무',
      steps: [
        { id: 'template-document-review-step-review', type: 'documentReview', name: '문서 검토 기준 정하기' },
        { id: 'template-document-review-step-ai', type: 'aiReview', name: 'AI로 직접 테스트하기' },
        { id: 'template-document-review-step-report', type: 'report', name: '테스트 결과 정리' }
      ]
    },
    {
      id: 'template-data-cleanup', familyId: 'data-cleanup', version: 1, builtin: true,
      name: 'Excel·명단 정리', description: '데이터를 붙여넣고 누락·중복을 확인한 뒤 결과표로 저장합니다.', category: '데이터 업무',
      steps: [{ id: 'template-data-cleanup-step-people', type: 'people', name: '데이터 가져오기' }, { id: 'template-data-cleanup-step-validation', type: 'validation', name: '누락·중복 확인' }, { id: 'template-data-cleanup-step-layout', type: 'layout', name: '정리 결과 저장' }]
    }
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

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function cloneMergeValue(value) {
    if (Array.isArray(value)) return value.map(cloneMergeValue);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneMergeValue(item)]));
    return value;
  }

  function mergeValuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => mergeValuesEqual(item, right[index]));
    }
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && mergeValuesEqual(left[key], right[key]));
  }

  function stableArrayItemKey(item) {
    if (!isPlainObject(item)) return null;
    if (item.id !== undefined && item.id !== null && String(item.id) !== '') return `id:${typeof item.id}:${String(item.id)}`;
    if (item.formId !== undefined && item.formId !== null && String(item.formId) !== '') return `form:${typeof item.formId}:${String(item.formId)}`;
    if (item.kind !== undefined && item.externalId !== undefined && item.externalId !== null && String(item.externalId) !== '') {
      return `artifact:${String(item.kind || 'artifact')}:${typeof item.externalId}:${String(item.externalId)}`;
    }
    return null;
  }

  function primitiveArrayToken(value) {
    return `${typeof value}:${JSON.stringify(value)}`;
  }

  function mergePrimitiveArrays(base, current, incoming) {
    const baseTokens = new Set(base.map(primitiveArrayToken));
    const currentTokens = new Set(current.map(primitiveArrayToken));
    const incomingTokens = new Set(incoming.map(primitiveArrayToken));
    const values = new Map([...base, ...current, ...incoming].map((item) => [primitiveArrayToken(item), item]));
    const orderedTokens = [...new Set([...current, ...incoming, ...base].map(primitiveArrayToken))];
    return orderedTokens
      .filter((token) => baseTokens.has(token)
        ? currentTokens.has(token) && incomingTokens.has(token)
        : currentTokens.has(token) || incomingTokens.has(token))
      .map((token) => cloneMergeValue(values.get(token)));
  }

  function keyedArrayMap(items) {
    const result = new Map();
    for (const item of items) {
      const key = stableArrayItemKey(item);
      if (!key || result.has(key)) return null;
      result.set(key, item);
    }
    return result;
  }

  function mergePresence(baseHas, baseValue, currentHas, currentValue, incomingHas, incomingValue) {
    const currentUnchanged = currentHas === baseHas && (!currentHas || mergeValuesEqual(currentValue, baseValue));
    const incomingUnchanged = incomingHas === baseHas && (!incomingHas || mergeValuesEqual(incomingValue, baseValue));
    const branchesEqual = currentHas === incomingHas && (!currentHas || mergeValuesEqual(currentValue, incomingValue));
    const artifactTerminal = currentHas && incomingHas && isPlainObject(currentValue) && isPlainObject(incomingValue)
      && [baseValue, currentValue, incomingValue].some((value) => isPlainObject(value) && value.kind && (value.externalId || value.slotId || value.personId))
      && [baseValue, currentValue, incomingValue].some((value) => isPlainObject(value) && value.status === 'superseded');
    const artifactArrayTerminal = currentHas && incomingHas && Array.isArray(currentValue) && Array.isArray(incomingValue)
      && [baseValue, currentValue, incomingValue].some((value) => Array.isArray(value) && value.some((item) => isPlainObject(item) && item.kind && item.status === 'superseded'));

    if (artifactTerminal) return { present: true, value: mergeObjectValues(isPlainObject(baseValue) ? baseValue : {}, currentValue, incomingValue) };
    if (artifactArrayTerminal) return { present: true, value: mergeArrayValues(Array.isArray(baseValue) ? baseValue : [], currentValue, incomingValue) };

    if (branchesEqual) return currentHas ? { present: true, value: cloneMergeValue(currentValue) } : { present: false };
    if (incomingUnchanged) return currentHas ? { present: true, value: cloneMergeValue(currentValue) } : { present: false };
    if (!incomingHas) return { present: false };
    if (!currentHas) return { present: true, value: cloneMergeValue(incomingValue) };

    if (isPlainObject(currentValue) && isPlainObject(incomingValue)) {
      const objectBase = isPlainObject(baseValue) ? baseValue : {};
      return { present: true, value: mergeObjectValues(objectBase, currentValue, incomingValue) };
    }
    if (Array.isArray(currentValue) && Array.isArray(incomingValue)) {
      const arrayBase = Array.isArray(baseValue) ? baseValue : [];
      return { present: true, value: mergeArrayValues(arrayBase, currentValue, incomingValue) };
    }
    if (currentUnchanged) return { present: true, value: cloneMergeValue(incomingValue) };
    return { present: true, value: cloneMergeValue(incomingValue) };
  }

  function mergeObjectValues(base, current, incoming) {
    const result = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(incoming)]);
    keys.forEach((key) => {
      const merged = mergePresence(
        Object.prototype.hasOwnProperty.call(base, key), base[key],
        Object.prototype.hasOwnProperty.call(current, key), current[key],
        Object.prototype.hasOwnProperty.call(incoming, key), incoming[key]
      );
      if (merged.present) result[key] = merged.value;
    });
    const artifactLike = [base, current, incoming].some((value) => isPlainObject(value) && value.kind && (value.externalId || value.slotId || value.personId));
    if (artifactLike) {
      const terminal = [current, incoming, base].find((value) => isPlainObject(value) && value.status === 'superseded');
      if (terminal) {
        result.status = 'superseded';
        if (terminal.replacedAt) result.replacedAt = terminal.replacedAt;
        if (terminal.replacementReason) result.replacementReason = terminal.replacementReason;
      }
    }
    return result;
  }

  function mergeKeyedArrays(base, current, incoming, baseMap, currentMap, incomingMap) {
    const orderedKeys = [...new Set([
      ...current.map(stableArrayItemKey),
      ...incoming.map(stableArrayItemKey),
      ...base.map(stableArrayItemKey)
    ])];
    const result = [];
    orderedKeys.forEach((key) => {
      const merged = mergePresence(
        baseMap.has(key), baseMap.get(key),
        currentMap.has(key), currentMap.get(key),
        incomingMap.has(key), incomingMap.get(key)
      );
      if (merged.present) result.push(merged.value);
    });
    return result;
  }

  function mergeArrayValues(base, current, incoming) {
    const allItems = [...base, ...current, ...incoming];
    if (allItems.every((item) => item === null || (typeof item !== 'object' && typeof item !== 'function'))) {
      return mergePrimitiveArrays(base, current, incoming);
    }
    const baseMap = keyedArrayMap(base);
    const currentMap = keyedArrayMap(current);
    const incomingMap = keyedArrayMap(incoming);
    if (baseMap && currentMap && incomingMap && allItems.every((item) => stableArrayItemKey(item))) {
      return mergeKeyedArrays(base, current, incoming, baseMap, currentMap, incomingMap);
    }
    return cloneMergeValue(incoming);
  }

  function threeWayMerge(base, current, incoming) {
    // Preserve changes made on either branch since the acknowledged base;
    // when both branches change the same scalar, the incoming save wins.
    return mergePresence(true, base, true, current, true, incoming).value;
  }

  function makeId(prefix = 'item') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function taskType(type) {
    return TASK_TYPE_CATALOG.find((item) => item.id === type) || TASK_TYPE_CATALOG.find((item) => item.id === 'checklist');
  }

  function normalizeWorkflowStep(step = {}, index = 0) {
    const definition = taskType(step.type || step.moduleId);
    const checklist = Array.isArray(step.checklist) ? step.checklist.map((item) => ({
      id: item.id || makeId('check'),
      text: String(item.text || '').trim(),
      done: Boolean(item.done)
    })).filter((item) => item.text) : [];
    return {
      id: step.id || makeId('step'),
      type: definition.id,
      moduleId: definition.moduleId || null,
      name: String(step.name || definition.name).trim() || definition.name,
      description: String(step.description || definition.description || '').trim(),
      status: ['notStarted', 'inProgress', 'needsReview', 'complete', 'stale'].includes(step.status) ? step.status : 'notStarted',
      instructions: String(step.instructions || '').trim(),
      notes: String(step.notes || '').trim(),
      checklist,
      order: Number.isFinite(Number(step.order)) ? Number(step.order) : index,
      updatedAt: step.updatedAt || null
    };
  }

  function normalizeWorkflowTemplate(template = {}, index = 0) {
    const steps = Array.isArray(template.steps) && template.steps.length ? template.steps : [{ type: 'people' }];
    const configuration = template.configuration && typeof template.configuration === 'object' ? template.configuration : {};
    return {
      id: template.id || makeId('template'),
      familyId: template.familyId || template.id || makeId('template-family'),
      version: Math.max(1, Number(template.version) || 1),
      builtin: Boolean(template.builtin),
      name: String(template.name || '이름 없는 업무 템플릿').trim(),
      description: String(template.description || '').trim(),
      category: String(template.category || '사용자 템플릿').trim(),
      steps: steps.map(normalizeWorkflowStep).map((step, stepIndex) => ({ ...step, order: stepIndex, status: 'notStarted', updatedAt: null })),
      configuration: {
        columns: Array.isArray(configuration.columns) ? clone(configuration.columns) : [],
        roles: Array.isArray(configuration.roles) ? clone(configuration.roles) : [],
        scheduleRules: configuration.scheduleRules && typeof configuration.scheduleRules === 'object' ? clone(configuration.scheduleRules) : {},
        communication: configuration.communication && typeof configuration.communication === 'object' ? {
          subjectTemplate: configuration.communication.subjectTemplate || '',
          bodyTemplate: configuration.communication.bodyTemplate || '',
          bodyHtmlTemplate: configuration.communication.bodyHtmlTemplate || ''
        } : {},
        layout: configuration.layout && typeof configuration.layout === 'object' ? clone(configuration.layout) : {}
      },
      projectSettings: template.projectSettings && typeof template.projectSettings === 'object' ? clone(template.projectSettings) : {},
      createdAt: template.createdAt || nowIso(),
      updatedAt: template.updatedAt || nowIso(),
      order: Number.isFinite(Number(template.order)) ? Number(template.order) : index
    };
  }

  function builtinWorkflowTemplates() {
    return BUILTIN_WORKFLOW_TEMPLATES.map((template, index) => normalizeWorkflowTemplate({
      ...template,
      createdAt: BUILTIN_WORKFLOW_TIMESTAMP,
      updatedAt: BUILTIN_WORKFLOW_TIMESTAMP
    }, index));
  }

  function normalizeWorkflowTemplates(input = []) {
    const builtins = builtinWorkflowTemplates();
    const custom = (Array.isArray(input) ? input : []).filter((item) => !item?.builtin && !builtins.some((builtin) => builtin.id === item?.id)).map(normalizeWorkflowTemplate);
    return [...builtins, ...custom];
  }

  function workflowForModules(moduleIds = WORKFLOW_ORDER) {
    return moduleIds.map((moduleId, index) => normalizeWorkflowStep({ type: moduleId, moduleId, order: index }, index));
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
      library: { rosters: [], mailTemplates: [], layoutTemplates: [], workflowTemplates: builtinWorkflowTemplates() },
      deletedConnectionIds: [],
      deletedLibraryIds: [],
      preferences: {
        theme: 'light',
        showArchivedProjects: false,
        storageMode: 'local',
        workspaceDriveConnectionId: null
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
      workflowTemplate: {
        id: project.workflowTemplate?.id || null,
        familyId: project.workflowTemplate?.familyId || null,
        version: Math.max(0, Number(project.workflowTemplate?.version) || 0),
        name: String(project.workflowTemplate?.name || '').trim(),
        modified: Boolean(project.workflowTemplate?.modified)
      },
      workflow: (Array.isArray(project.workflow) && project.workflow.length
        ? project.workflow
        : workflowForModules([...installed])
      ).map(normalizeWorkflowStep).sort((a, b) => a.order - b.order).map((step, index) => ({
        ...step,
        order: index,
        status: step.moduleId ? moduleState[step.moduleId]?.status || step.status : step.status,
        updatedAt: step.moduleId ? moduleState[step.moduleId]?.updatedAt || step.updatedAt : step.updatedAt
      })),
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
        rosterName: String(data.rosterName || '').trim(),
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
        rosterViews: Array.isArray(data.rosterViews) ? data.rosterViews.map((view) => ({
          id: view.id || makeId('roster-view'),
          name: String(view.name || '단계 명단').trim(),
          parentId: view.parentId || null,
          personIds: [...new Set(Array.isArray(view.personIds) ? view.personIds : [])],
          excludedPersonIds: [...new Set(Array.isArray(view.excludedPersonIds) ? view.excludedPersonIds : [])],
          createdAt: view.createdAt || nowIso(),
          updatedAt: view.updatedAt || nowIso()
        })) : [],
        activeRosterViewId: data.activeRosterViewId || null,
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
          unmarkedMeansAvailable: Boolean(data.scheduleRules?.unmarkedMeansAvailable),
          rosterViewId: data.scheduleRules?.rosterViewId || null
        },
        versions: Array.isArray(data.versions) ? data.versions : [],
        forms: {
          definitions: Array.isArray(data.forms?.definitions) ? data.forms.definitions : [],
          linkedForms: Array.isArray(data.forms?.linkedForms) ? data.forms.linkedForms : [],
          selectedFormId: data.forms?.selectedFormId || null,
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
    const projects = Array.isArray(input.projects) ? input.projects.map(normalizeProject) : [];
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
        layoutTemplates: Array.isArray(input.library?.layoutTemplates) ? input.library.layoutTemplates : [],
        workflowTemplates: normalizeWorkflowTemplates(input.library?.workflowTemplates)
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
    state.projects.forEach((project) => {
      project.installedModules = project.installedModules.filter((id) => extensions.has(id));
    });
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
    const selectedTemplate = state.library.workflowTemplates.find((template) => template.id === values.templateId)
      || state.library.workflowTemplates.find((template) => template.familyId === values.preset)
      || state.library.workflowTemplates.find((template) => template.id === 'template-blank');
    const workflow = Array.isArray(values.workflow) && values.workflow.length
      ? values.workflow
      : (!values.templateId && values.preset ? workflowForModules(workflowModulesForPreset(values.preset)) : selectedTemplate.steps);
    const moduleIds = [...new Set(workflow.map((step) => taskType(step.type || step.moduleId).moduleId).filter(Boolean))];
    const project = normalizeProject({
      id: values.id || makeId('project'),
      name,
      client: values.client,
      description: values.description,
      startDate: values.startDate,
      endDate: values.endDate,
      installedModules: Array.isArray(values.installedModules)
        ? values.installedModules
        : moduleIds,
      workflow,
      workflowTemplate: values.workflowTemplate || (!values.templateId && values.preset ? null : {
        id: selectedTemplate.id,
        familyId: selectedTemplate.familyId,
        version: selectedTemplate.version,
        name: selectedTemplate.name
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
      settings: { ...clone(selectedTemplate.projectSettings), ...(values.settings || {}) },
      data: values.data || clone(selectedTemplate.configuration)
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
    result.project.workflow = result.project.workflow.map((step) => ({
      ...step,
      status: 'notStarted',
      updatedAt: null,
      notes: '',
      checklist: step.checklist.map((item) => ({ ...item, done: false }))
    }));
    result.project.counts = { people: 0, sessions: 0, unresolved: 0 };
    result.project.data = {
      ...result.project.data,
      people: [],
      slots: [],
      availability: {},
      assignments: [],
      conflicts: [],
        versions: [],
        forms: { definitions: [], linkedForms: [], selectedFormId: null, lastResponseSyncAt: null },
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
    project.workflow = project.workflow.map((step) => step.moduleId === moduleId ? { ...step, status, updatedAt: nowIso() } : step);
    project.updatedAt = nowIso();
    state.updatedAt = nowIso();
    return state;
  }

  function updateProjectWorkflow(stateInput, projectId, steps = []) {
    if (!Array.isArray(steps) || !steps.length) throw new Error('프로젝트에는 작업이 하나 이상 필요합니다.');
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const workflow = steps.map(normalizeWorkflowStep).map((step, index) => ({ ...step, order: index }));
    const installedModules = [...new Set([
      ...project.installedModules,
      ...workflow.map((step) => step.moduleId).filter(Boolean)
    ])];
    return updateProject(state, projectId, { workflow, installedModules });
  }

  function setWorkflowStepStatus(stateInput, projectId, stepId, status, notes) {
    if (!['notStarted', 'inProgress', 'needsReview', 'complete', 'stale'].includes(status)) throw new Error('알 수 없는 작업 상태입니다.');
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const step = project.workflow.find((item) => item.id === stepId);
    if (!step) throw new Error('작업 단계를 찾을 수 없습니다.');
    step.status = status;
    step.updatedAt = nowIso();
    if (notes !== undefined) step.notes = String(notes || '');
    if (step.moduleId && project.moduleState[step.moduleId]) project.moduleState[step.moduleId] = { status, summary: step.notes || '', updatedAt: step.updatedAt };
    project.updatedAt = nowIso();
    state.updatedAt = nowIso();
    return state;
  }

  function saveWorkflowTemplate(stateInput, projectId, values = {}) {
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const name = String(values.name || '').trim();
    if (!name) throw new Error('업무 템플릿 이름을 입력해주세요.');
    const sameFamily = state.library.workflowTemplates.filter((item) => !item.builtin && item.name.toLowerCase() === name.toLowerCase());
    const familyId = sameFamily[0]?.familyId || makeId('template-family');
    const version = sameFamily.reduce((max, item) => Math.max(max, item.version), 0) + 1;
    const template = normalizeWorkflowTemplate({
      id: makeId('template'), familyId, version, name,
      description: values.description || `${project.name}에서 저장한 업무 구성`,
      category: values.category || '사용자 템플릿',
      steps: project.workflow,
      configuration: {
        columns: project.data.columns,
        roles: project.data.roles,
        scheduleRules: project.data.scheduleRules,
        communication: project.data.communication,
        layout: project.data.layout
      },
      projectSettings: {
        timezone: project.settings.timezone,
        sessionDurationMinutes: project.settings.sessionDurationMinutes,
        participantMin: project.settings.participantMin,
        participantMax: project.settings.participantMax,
        coachRequired: project.settings.coachRequired,
        changeApprovalRequired: project.settings.changeApprovalRequired
      },
      createdAt: nowIso(), updatedAt: nowIso()
    });
    state.library.workflowTemplates.push(template);
    state.updatedAt = nowIso();
    return { state, template };
  }

  function removeWorkflowTemplate(stateInput, templateId) {
    const state = normalizeState(stateInput);
    const template = state.library.workflowTemplates.find((item) => item.id === templateId);
    if (!template) throw new Error('업무 템플릿을 찾을 수 없습니다.');
    if (template.builtin) throw new Error('기본 업무 템플릿은 삭제할 수 없습니다.');
    state.library.workflowTemplates = state.library.workflowTemplates.filter((item) => item.id !== templateId);
    if (!state.deletedLibraryIds.includes(templateId)) state.deletedLibraryIds.push(templateId);
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

  function connectionIdentity(connection) {
    if (!connection) return null;
    return {
      id: String(connection.id || ''),
      type: String(connection.type || ''),
      status: String(connection.status || ''),
      account: String(connection.account || '').trim().toLowerCase(),
      updatedAt: String(connection.updatedAt || '')
    };
  }

  function connectionIdentityMatches(connection, expectedIdentity) {
    const actual = connectionIdentity(connection);
    const expected = connectionIdentity(expectedIdentity);
    return Boolean(actual && expected && mergeValuesEqual(actual, expected));
  }

  function applyConnectionAuthorization(stateInput, connectionId, status = {}, reason = '로그인 계정 변경 후 기존 외부 항목 재확인 필요') {
    const state = normalizeState(stateInput);
    const connection = state.connections.find((item) => item.id === connectionId);
    if (!connection) return { state, connection: null, accountChanged: false, retiredArtifacts: 0, reviewedForms: 0 };
    const previousAccount = String(connection.account || '').trim().toLowerCase();
    connection.status = status.connected ? 'connected' : 'needsAuth';
    connection.account = String(status.account || connection.account || '').trim();
    connection.updatedAt = nowIso();
    const nextAccount = connection.account.toLowerCase();
    const accountChanged = Boolean(status.connected && (!previousAccount || previousAccount !== nextAccount));
    let retiredArtifacts = 0;
    let reviewedForms = 0;
    if (accountChanged) {
      const artifactKind = connection.type === 'gmail' ? 'gmailDraft' : connection.type === 'zoom' ? 'zoom' : '';
      const moduleId = connection.type === 'gmail' ? 'gmailFlow' : connection.type;
      [...state.projects, ...Object.values(state.quickWorkspaces || {})].forEach((project) => {
        let changed = false;
        if (artifactKind) {
          project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
            if (artifact.kind !== artifactKind || artifact.connectionId !== connection.id || artifact.status === 'superseded') return artifact;
            changed = true; retiredArtifacts += 1;
            return { ...artifact, status: 'superseded', replacedAt: nowIso(), replacementReason: reason };
          });
        }
        if (connection.type === 'forms') {
          project.data.forms.linkedForms = project.data.forms.linkedForms.map((linked) => {
            if (linked.connectionId !== connection.id) return linked;
            changed = true; reviewedForms += 1;
            return { ...linked, needsReview: true, reviewReason: reason };
          });
        }
        if (!changed) return;
        const stamp = nowIso();
        if (project.installedModules.includes(moduleId)) {
          project.moduleState[moduleId] = { status: 'needsReview', summary: reason, updatedAt: stamp };
          project.workflow = project.workflow.map((step) => step.moduleId === moduleId ? { ...step, status: 'needsReview', updatedAt: stamp } : step);
        }
        project.updatedAt = stamp;
      });
    }
    state.updatedAt = nowIso();
    return { state, connection, accountChanged, retiredArtifacts, reviewedForms };
  }

  function removeConnection(stateInput, connectionId) {
    const state = normalizeState(stateInput);
    const removedWorkspaceDrive = workspaceDriveConnection(state)?.id === connectionId || state.preferences.workspaceDriveConnectionId === connectionId;
    state.connections = state.connections.filter((connection) => connection.id !== connectionId);
    if (state.preferences.workspaceDriveConnectionId === connectionId) state.preferences.workspaceDriveConnectionId = null;
    if (removedWorkspaceDrive && state.preferences.storageMode === 'drive') state.preferences.storageMode = 'local';
    state.projects = state.projects.map((project) => {
      const defaults = { ...project.settings.defaultConnectionIds };
      Object.keys(defaults).forEach((key) => { if (defaults[key] === connectionId) defaults[key] = null; });
      return normalizeProject({ ...project, settings: { ...project.settings, defaultConnectionIds: defaults } });
    });
    state.updatedAt = nowIso();
    return state;
  }

  function workspaceDriveConnection(stateInput) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : createEmptyState();
    const connected = (Array.isArray(state.connections) ? state.connections : []).filter((connection) => connection.type === 'drive' && connection.status === 'connected');
    const selectedId = state.preferences?.workspaceDriveConnectionId || '';
    const selected = connected.find((connection) => connection.id === selectedId);
    if (selectedId) return selected || null;
    return connected.length === 1 ? connected[0] : null;
  }

  function getActiveProject(stateInput) {
    const state = normalizeState(stateInput);
    return state.projects.find((project) => project.id === state.activeProjectId) || null;
  }

  function getProjectProgress(project) {
    if (!project) return { complete: 0, total: 0, percent: 0 };
    const workflow = Array.isArray(project.workflow) ? project.workflow : [];
    const complete = workflow.filter((step) => step.status === 'complete').length;
    return { complete, total: workflow.length, percent: workflow.length ? Math.round((complete / workflow.length) * 100) : 0 };
  }

  return {
    FORMAT,
    VERSION,
    MODULE_CATALOG,
    WORKFLOW_ORDER,
    CONNECTION_TYPES,
    TASK_TYPE_CATALOG,
    BUILTIN_WORKFLOW_TEMPLATES,
    configureExtensionCatalog,
    threeWayMerge,
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
    updateProjectWorkflow,
    setWorkflowStepStatus,
    saveWorkflowTemplate,
    removeWorkflowTemplate,
    addConnection,
    connectionIdentity,
    connectionIdentityMatches,
    applyConnectionAuthorization,
    removeConnection,
    workspaceDriveConnection,
    getActiveProject,
    getProjectProgress
  };
});
