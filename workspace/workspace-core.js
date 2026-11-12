(function exposeWorkspaceCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkspaceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const FORMAT = 'cmoe-workspace';
  const VERSION = 4;
  const DEFAULT_TIMEZONE = 'Asia/Seoul';
  const DOCUMENT_EDITOR_ID = 'documentEditor';
  const DOCUMENT_EDITOR_MODES = Object.freeze(['pptxPdf', 'certificateMaker', 'pdfMerge', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge', 'documentSplit']);
  const LEGACY_DOCUMENT_MODULE_MODES = Object.freeze({ pptxPdf: 'pptxPdf', certificateMaker: 'certificateMaker' });

  const MODULE_CATALOG = [
    {
      id: 'people',
      name: '명단',
      shortName: '명단',
      description: 'Excel·한글 표·CSV 또는 일반 텍스트를 이름·이메일·전화번호가 구분된 명단으로 정리합니다.',
      category: 'core',
      core: true,
      workflow: true,
      standalone: true,
      accent: 'blue',
      page: 'people'
    },
    {
      id: 'forms',
      name: '설문',
      shortName: '설문',
      description: '신청자 정보를 받거나 참여 가능한 시간을 조사하고 최신 응답을 가져옵니다.',
      category: 'source',
      core: false,
      workflow: true,
      standalone: true,
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
      workflow: true,
      standalone: true,
      accent: 'green',
      page: 'schedule'
    },
    {
      id: 'projectCalendar',
      name: '캘린더',
      shortName: '캘린더',
      description: '프로젝트 일정과 진행 내용, 담당자, 외부 회의를 한눈에 보고 갑작스러운 변경을 안전하게 조정합니다.',
      category: 'core',
      core: true,
      workflow: true,
      standalone: true,
      accent: 'cyan',
      icon: '캘',
      page: 'projectCalendar'
    },
    {
      id: 'layout',
      name: '일정표',
      shortName: '일정표',
      description: '편성된 일정을 확인하고 Excel 또는 CSV 파일로 저장합니다.',
      category: 'core',
      core: true,
      workflow: true,
      standalone: true,
      accent: 'amber',
      page: 'layout'
    },
    {
      id: 'zoom',
      name: 'Zoom',
      shortName: 'Zoom',
      description: '확정된 일정마다 Zoom 회의를 만들고 참가 링크를 일정에 연결합니다.',
      category: 'integration',
      core: false,
      workflow: true,
      standalone: true,
      accent: 'cyan',
      page: 'zoom'
    },
    {
      id: 'gmailFlow',
      name: '메일',
      shortName: '메일',
      description: '명단·일정·Zoom 링크로 받는 사람별 메일을 만들고 Gmail 임시보관함에 저장합니다.',
      category: 'integration',
      core: false,
      workflow: true,
      standalone: true,
      accent: 'red',
      page: 'gmailFlow'
    },
    {
      id: DOCUMENT_EDITOR_ID,
      name: '문서 편집',
      shortName: '문서',
      description: '문서 변환·일괄 생성과 PDF·PowerPoint·Word·Excel의 구조별 합치기·나누기를 한곳에서 사용합니다.',
      category: 'utility',
      core: false,
      workflow: false,
      projectStep: true,
      standalone: true,
      defaultInstalled: true,
      accent: 'indigo',
      icon: '문',
      page: DOCUMENT_EDITOR_ID
    }
  ];

  const WORKFLOW_ORDER = ['people', 'forms', 'schedule', 'projectCalendar', 'layout', 'zoom', 'gmailFlow'];
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
    { id: 'projectCalendar', name: '캘린더', description: '전체 일정과 진행 내용을 보고 예외 상황의 시간·인원 배치를 조정합니다.', moduleId: 'projectCalendar', icon: '캘' },
    { id: 'zoom', name: 'Zoom 회의', description: '확정된 일정에 Zoom 회의를 연결합니다.', moduleId: 'zoom', icon: 'Z' },
    { id: 'gmailFlow', name: '안내 메일', description: '대상자별 안내 메일을 작성하고 Gmail에 저장합니다.', moduleId: 'gmailFlow', icon: 'G' },
    { id: 'layout', name: '결과표·Excel', description: '프로젝트 결과를 표로 확인하고 Excel로 저장합니다.', moduleId: 'layout', icon: 'X' },
    { id: DOCUMENT_EDITOR_ID, name: '문서 편집', description: '변환·일괄 생성·PDF·PowerPoint·Word·Excel 합치기와 나누기를 필요한 모드로 실행합니다.', moduleId: DOCUMENT_EDITOR_ID, icon: '문' },
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
      id: 'template-education', familyId: 'education', version: 2, builtin: true,
      name: '교육 프로그램 운영', description: '교육생 명단부터 일정·출결·수료·안내 결과까지 관리합니다.', category: 'CMOE 업무',
      steps: [
        { id: 'template-education-step-people', type: 'people', name: '교육생 명단 준비' },
        { id: 'template-education-step-forms', type: 'forms', name: '신청·가능 시간 조사' },
        { id: 'template-education-step-schedule', type: 'schedule', name: '교육 일정 편성' },
        { id: 'template-education-step-calendar', type: 'projectCalendar', name: '교육 일정 운영' },
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
    const next = manifests.filter((item) => (item?.contributes?.workflow || item?.contributes?.projectStep || item?.contributes?.standalone) && item.contributes.page).map((item) => ({
      id: item.id,
      name: item.name,
      shortName: item.shortName || item.name,
      description: item.description || '',
      category: item.category || 'utility',
      core: Boolean(item.core),
      workflow: Boolean(item.contributes.workflow),
      projectStep: Boolean(item.contributes.projectStep),
      standalone: Boolean(item.contributes.standalone || item.contributes.workflow),
      defaultInstalled: Boolean(item.defaultInstalled),
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
    WORKFLOW_ORDER.splice(0, WORKFLOW_ORDER.length, ...next.filter((item) => item.workflow).map((item) => item.id));
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

  function storedStringId(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function canonicalModuleId(value) {
    const id = storedStringId(value);
    return Object.prototype.hasOwnProperty.call(LEGACY_DOCUMENT_MODULE_MODES, id) ? DOCUMENT_EDITOR_ID : id;
  }

  function normalizeDocumentMode(value, fallback = '') {
    const mode = storedStringId(value) || storedStringId(fallback);
    return DOCUMENT_EDITOR_MODES.includes(mode) ? mode : '';
  }

  function documentModeForLegacyId(value) {
    return LEGACY_DOCUMENT_MODULE_MODES[storedStringId(value)] || '';
  }

  function migratedDocumentStepName(value, legacyId, fallback) {
    const name = String(value || '').trim();
    const defaults = legacyId === 'pptxPdf'
      ? new Set(['PPTX 일괄 PDF 변환', 'PPTX → PDF 변환'])
      : new Set(['템플릿 문서 일괄 만들기']);
    if (!name || defaults.has(name)) return legacyId === 'pptxPdf' ? '문서 편집 · PPTX→PDF' : legacyId === 'certificateMaker' ? '문서 편집 · 일괄 만들기' : fallback;
    return name;
  }

  const CONNECTION_AUTH_STAGES = new Set([
    'callback_start',
    'authorization_callback',
    'token_exchange',
    'profile_lookup',
    'credential_persist'
  ]);
  const CONNECTION_AUTH_ERROR_MAX_LENGTH = 160;
  const CONNECTION_AUTH_CODE_MAX_LENGTH = 64;

  function sanitizedConnectionAuthError(value) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\b(?:https?|ftp):\/\/[^\s]+/gi, '[주소 숨김]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일 숨김]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[인증정보 숨김]')
      .replace(/\b(access[_\s-]*token|refresh[_\s-]*token|id[_\s-]*token|authorization[_\s-]*code|auth[_\s-]*code|code[_\s-]*verifier|client[_\s-]*secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[숨김]')
      .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[인증정보 숨김]')
      .replace(/\b[A-Za-z0-9+/_=-]{80,}\b/g, '[민감정보 숨김]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CONNECTION_AUTH_ERROR_MAX_LENGTH);
  }

  function normalizedConnectionAuthStage(value) {
    const stage = typeof value === 'string' ? value.trim() : '';
    return CONNECTION_AUTH_STAGES.has(stage) ? stage : '';
  }

  function normalizedConnectionAuthCode(value) {
    const code = typeof value === 'string' ? value.trim() : '';
    return code.length <= CONNECTION_AUTH_CODE_MAX_LENGTH && /^[A-Z0-9][A-Z0-9_.-]*$/.test(code) ? code : '';
  }

  function normalizedConnectionAuthStatus(value) {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
  }

  function normalizedConnectionAuthDiagnostics(connection) {
    const diagnostics = {};
    const lastAuthError = sanitizedConnectionAuthError(connection?.lastAuthError);
    const lastAuthStage = normalizedConnectionAuthStage(connection?.lastAuthStage);
    const lastAuthCode = normalizedConnectionAuthCode(connection?.lastAuthCode);
    const lastAuthStatus = normalizedConnectionAuthStatus(connection?.lastAuthStatus);
    if (lastAuthError) diagnostics.lastAuthError = lastAuthError;
    if (lastAuthStage) diagnostics.lastAuthStage = lastAuthStage;
    if (lastAuthCode) diagnostics.lastAuthCode = lastAuthCode;
    if (lastAuthStatus !== null) diagnostics.lastAuthStatus = lastAuthStatus;
    return diagnostics;
  }

  function isValidTimeZone(value) {
    const zone = typeof value === 'string' ? value.trim() : '';
    if (!zone) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalizeTimeZone(value, fallback = DEFAULT_TIMEZONE) {
    const zone = typeof value === 'string' ? value.trim() : '';
    if (isValidTimeZone(zone)) return zone;
    return isValidTimeZone(fallback) ? String(fallback).trim() : DEFAULT_TIMEZONE;
  }

  function normalizePersonRoleIds(roleIds, roles = []) {
    const activeRoleIds = roles.filter((role) => role?.active !== false).map((role) => storedStringId(role?.id)).filter(Boolean);
    const allowed = new Set(activeRoleIds);
    const selected = [...new Set((Array.isArray(roleIds) ? roleIds : []).map(storedStringId).filter((id) => allowed.has(id)))];
    return selected.length ? selected : activeRoleIds.slice(0, 1);
  }

  function normalizePersonValues(person, columns = []) {
    const values = person?.values && typeof person.values === 'object' && !Array.isArray(person.values) ? { ...person.values } : {};
    const legacyByType = { name: person?.name, email: person?.email, phone: person?.phone, group: person?.group };
    columns.forEach((column) => {
      const legacy = legacyByType[column?.type];
      if (legacy === null || legacy === undefined || String(legacy).length === 0 || !column?.id) return;
      if (!Object.prototype.hasOwnProperty.call(values, column.id) || String(values[column.id] ?? '').length === 0) values[column.id] = String(legacy);
    });
    return values;
  }

  function taskType(type) {
    const id = canonicalModuleId(type);
    const task = TASK_TYPE_CATALOG.find((item) => item.id === id);
    if (task) return task;
    const module = MODULE_CATALOG.find((item) => item.id === id);
    if (module) return { id: module.id, name: module.name, description: module.description || '', moduleId: module.id, icon: module.icon || module.name?.slice(0, 1) || '?' };
    if (id) return { id, name: id, description: '', moduleId: id, icon: '?' };
    return TASK_TYPE_CATALOG.find((item) => item.id === 'checklist');
  }

  function normalizeWorkflowStep(step = {}, index = 0) {
    const rawType = storedStringId(step.type);
    const rawModuleId = storedStringId(step.moduleId);
    const legacyId = Object.prototype.hasOwnProperty.call(LEGACY_DOCUMENT_MODULE_MODES, rawModuleId)
      ? rawModuleId
      : Object.prototype.hasOwnProperty.call(LEGACY_DOCUMENT_MODULE_MODES, rawType) ? rawType : '';
    const definition = taskType(rawType || rawModuleId);
    const explicitModuleId = canonicalModuleId(rawModuleId);
    const moduleId = explicitModuleId || definition.moduleId || null;
    const documentMode = moduleId === DOCUMENT_EDITOR_ID
      ? normalizeDocumentMode(step.documentMode, documentModeForLegacyId(legacyId))
      : '';
    const checklist = Array.isArray(step.checklist) ? step.checklist.map((item) => ({
      id: item.id || makeId('check'),
      text: String(item.text || '').trim(),
      done: Boolean(item.done)
    })).filter((item) => item.text) : [];
    return {
      id: step.id || makeId('step'),
      type: definition.id,
      moduleId,
      ...(documentMode ? { documentMode } : {}),
      name: migratedDocumentStepName(step.name, legacyId, definition.name),
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

  function normalizeActivity(activity = {}, index = 0) {
    const source = activity && typeof activity === 'object' && !Array.isArray(activity) ? activity : {};
    const status = typeof source.status === 'string' && source.status.trim() ? source.status : 'todo';
    return {
      ...source,
      id: source.id || makeId('activity'),
      status,
      order: Number.isFinite(Number(source.order)) ? Number(source.order) : index,
      locked: Boolean(source.locked)
    };
  }

  function normalizeScheduleSlot(slot) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return slot;
    const normalized = { ...slot };
    if (normalized.endDate == null) {
      delete normalized.endDate;
      return normalized;
    }
    if (typeof normalized.endDate === 'string') {
      const endDate = normalized.endDate.trim();
      const startDate = typeof normalized.date === 'string' ? normalized.date.trim() : normalized.date;
      if (!endDate || endDate === startDate) delete normalized.endDate;
      else normalized.endDate = endDate;
    }
    return normalized;
  }

  function normalizeScheduleVersion(version) {
    if (!version || typeof version !== 'object' || Array.isArray(version)) return version;
    return {
      ...version,
      ...(Array.isArray(version.slots) ? { slots: version.slots.map(normalizeScheduleSlot) } : {})
    };
  }

  function normalizeActivityAssignment(assignment = {}) {
    const source = assignment && typeof assignment === 'object' && !Array.isArray(assignment) ? assignment : {};
    const status = typeof source.status === 'string' && source.status.trim() ? source.status : 'planned';
    return {
      ...source,
      id: source.id || makeId('activity-assignment'),
      status,
      locked: Boolean(source.locked)
    };
  }

  function normalizeProjectCalendarExtension(extensionDataInput) {
    const extensionData = isPlainObject(extensionDataInput) ? cloneMergeValue(extensionDataInput) : {};
    if (!Object.prototype.hasOwnProperty.call(extensionData, 'projectCalendar')) return extensionData;
    const source = isPlainObject(extensionData.projectCalendar) ? extensionData.projectCalendar : {};
    const schemaVersion = Number(source.schemaVersion);
    const entitiesWithIds = (items) => (Array.isArray(items) ? items : [])
      .filter((item) => isPlainObject(item) && storedStringId(item.id))
      .map((item) => ({ ...cloneMergeValue(item), id: storedStringId(item.id) }));
    const deletedSessionIds = [...new Set((Array.isArray(source.deletedSessionIds) ? source.deletedSessionIds : []).map(storedStringId).filter(Boolean))];
    const deletedGroupIds = [...new Set((Array.isArray(source.deletedGroupIds) ? source.deletedGroupIds : []).map(storedStringId).filter(Boolean))];
    const deletedSessionSet = new Set(deletedSessionIds); const deletedGroupSet = new Set(deletedGroupIds);
    const sessions = entitiesWithIds(source.sessions).filter((session) => !deletedSessionSet.has(session.id));
    const sessionIds = new Set(sessions.map((session) => session.id));
    const groups = entitiesWithIds(source.groups).map((group) => {
      const deletedMemberIds = [...new Set((Array.isArray(group.deletedMemberIds) ? group.deletedMemberIds : []).map(storedStringId).filter(Boolean))];
      const deletedMemberSet = new Set(deletedMemberIds);
      const legacyMembers = (Array.isArray(group.memberIds) ? group.memberIds : []).map((personId) => ({ personId, roleId: group.roleByPersonId?.[personId] }));
      const memberSource = Array.isArray(group.members) && group.members.length ? group.members : legacyMembers;
      const memberIds = new Set();
      const members = memberSource.filter(isPlainObject).map((member) => {
        const personId = storedStringId(member.personId || member.id); const roleId = storedStringId(member.roleId);
        if (!personId || deletedMemberSet.has(personId) || memberIds.has(personId)) return null;
        memberIds.add(personId);
        return { ...cloneMergeValue(member), id: personId, personId, ...(roleId ? { roleId } : {}) };
      }).filter(Boolean);
      return { ...group, sessionId: storedStringId(group.sessionId), members, deletedMemberIds };
    }).filter((group) => !deletedGroupSet.has(group.id) && sessionIds.has(group.sessionId));
    extensionData.projectCalendar = {
      ...source,
      schemaVersion: Number.isSafeInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1,
      deletedSessionIds,
      deletedGroupIds,
      sessions,
      groups,
      view: typeof source.view === 'string' && source.view.trim() ? source.view.trim() : 'month'
    };
    return extensionData;
  }

  function normalizeProjectExtensionData(extensionDataInput) {
    const extensionData = normalizeProjectCalendarExtension(extensionDataInput);
    const existingEditor = isPlainObject(extensionData[DOCUMENT_EDITOR_ID]) ? cloneMergeValue(extensionData[DOCUMENT_EDITOR_ID]) : {};
    const modes = isPlainObject(existingEditor.modes) ? cloneMergeValue(existingEditor.modes) : {};
    let migrated = false;
    Object.entries(LEGACY_DOCUMENT_MODULE_MODES).forEach(([legacyId, mode]) => {
      if (!Object.prototype.hasOwnProperty.call(extensionData, legacyId)) return;
      const legacyValue = cloneMergeValue(extensionData[legacyId]); const current = modes[mode];
      modes[mode] = isPlainObject(legacyValue) && isPlainObject(current) ? { ...legacyValue, ...current } : (current === undefined ? legacyValue : current);
      delete extensionData[legacyId]; migrated = true;
    });
    if (migrated || Object.keys(existingEditor).length) extensionData[DOCUMENT_EDITOR_ID] = { ...existingEditor, modes };
    return extensionData;
  }

  function workflowForModules(moduleIds = WORKFLOW_ORDER) {
    return moduleIds.map((moduleId, index) => normalizeWorkflowStep({ type: moduleId, moduleId, order: index }, index));
  }

  function isStandaloneOnlyModuleId(moduleId) {
    const module = MODULE_CATALOG.find((item) => item.id === storedStringId(moduleId));
    return Boolean(module && module.workflow === false && module.projectStep !== true && module.standalone);
  }

  function supportsProjectStep(moduleOrId) {
    const module = typeof moduleOrId === 'string'
      ? MODULE_CATALOG.find((item) => item.id === storedStringId(moduleOrId))
      : moduleOrId;
    return Boolean(module && (module.workflow !== false || module.projectStep === true));
  }

  function excludedFromQuickWorkspace(moduleId) {
    const module = MODULE_CATALOG.find((item) => item.id === storedStringId(moduleId));
    return Boolean(module && module.workflow === false);
  }

  function workflowTaskCatalog() {
    const result = TASK_TYPE_CATALOG.map((item) => ({ ...item }));
    const moduleIds = new Set(result.map((item) => item.moduleId).filter(Boolean));
    MODULE_CATALOG.filter(supportsProjectStep).forEach((module) => {
      if (moduleIds.has(module.id)) return;
      result.push({ id: module.id, name: module.name, description: module.description || '', moduleId: module.id, icon: module.icon || module.name?.slice(0, 1) || '?' });
    });
    return result;
  }

  function workflowModuleIdForStep(step = {}) {
    const explicitModuleId = canonicalModuleId(step?.moduleId);
    return explicitModuleId || taskType(step?.type).moduleId || '';
  }

  const MODULE_STATUS_PRIORITY = Object.freeze({ notStarted: 0, complete: 1, inProgress: 2, stale: 3, needsReview: 4 });

  function normalizeModuleStatusRecord(value = {}) {
    const current = value && typeof value === 'object' && !Array.isArray(value) ? cloneMergeValue(value) : {};
    return {
      ...current,
      status: Object.prototype.hasOwnProperty.call(MODULE_STATUS_PRIORITY, current.status) ? current.status : 'notStarted',
      updatedAt: current.updatedAt || null,
      summary: current.summary || ''
    };
  }

  function mergeModuleStatusRecords(left, right) {
    if (!left) return normalizeModuleStatusRecord(right);
    if (!right) return normalizeModuleStatusRecord(left);
    const first = normalizeModuleStatusRecord(left); const second = normalizeModuleStatusRecord(right);
    const firstTime = Number.isFinite(Date.parse(first.updatedAt || '')) ? Date.parse(first.updatedAt) : 0;
    const secondTime = Number.isFinite(Date.parse(second.updatedAt || '')) ? Date.parse(second.updatedAt) : 0;
    const secondWins = secondTime > firstTime || (secondTime === firstTime && MODULE_STATUS_PRIORITY[second.status] > MODULE_STATUS_PRIORITY[first.status]);
    return secondWins ? { ...first, ...second } : { ...second, ...first };
  }

  function normalizeStoredModuleStates(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const result = {};
    Object.entries(source).forEach(([rawId, rawValue]) => {
      const moduleId = canonicalModuleId(rawId); if (!moduleId) return;
      const record = normalizeModuleStatusRecord(rawValue);
      if (moduleId !== DOCUMENT_EDITOR_ID) {
        result[moduleId] = mergeModuleStatusRecords(result[moduleId], record);
        return;
      }
      const previous = result[moduleId] || {};
      const modes = { ...(previous.modes || {}) };
      Object.entries(record.modes && typeof record.modes === 'object' && !Array.isArray(record.modes) ? record.modes : {}).forEach(([mode, modeState]) => {
        const normalizedMode = normalizeDocumentMode(mode); if (normalizedMode) modes[normalizedMode] = mergeModuleStatusRecords(modes[normalizedMode], modeState);
      });
      const legacyMode = documentModeForLegacyId(rawId);
      if (legacyMode) modes[legacyMode] = mergeModuleStatusRecords(modes[legacyMode], record);
      const aggregateSource = { ...record }; delete aggregateSource.modes;
      result[moduleId] = { ...mergeModuleStatusRecords(previous, aggregateSource), modes };
    });
    return result;
  }

  function normalizedDocumentModeStates(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(DOCUMENT_EDITOR_MODES.map((mode) => [mode, normalizeModuleStatusRecord(source[mode])]));
  }

  function aggregateDocumentEditorState(value = {}) {
    const base = normalizeModuleStatusRecord(value); const modes = normalizedDocumentModeStates(value.modes);
    return { ...base, modes };
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
      library: { rosters: [], mailTemplates: [], layoutTemplates: [], workflowTemplates: builtinWorkflowTemplates(), formTemplates: [] },
      deletedConnectionIds: [],
      knownLibraryIds: [],
      deletedLibraryIds: [],
      preferences: {
        theme: 'light',
        showArchivedProjects: false,
        storageMode: 'local',
        defaultTimezone: DEFAULT_TIMEZONE,
        workspaceDriveConnectionId: null,
        globalDefaultConnectionIds: {
          forms: null,
          gmail: null,
          zoom: null
        }
      },
      updatedAt: nowIso()
    };
  }

  function normalizeProject(projectInput, defaultTimezone = DEFAULT_TIMEZONE) {
    const project = projectInput && typeof projectInput === 'object' && !Array.isArray(projectInput) ? projectInput : {};
    const data = project.data && typeof project.data === 'object' ? project.data : {};
    const forms = data.forms && typeof data.forms === 'object' && !Array.isArray(data.forms) ? data.forms : {};
    const formDefinitions = Array.isArray(forms.definitions) ? forms.definitions : [];
    const hasActiveFormDefinition = Object.prototype.hasOwnProperty.call(forms, 'activeDefinitionId');
    const installed = new Set((Array.isArray(project.installedModules) ? project.installedModules : []).map(canonicalModuleId).filter((moduleId) => moduleId && !isStandaloneOnlyModuleId(moduleId)));
    MODULE_CATALOG.filter((module) => module.core).forEach((module) => installed.add(module.id));
    const projectWorkflow = (Array.isArray(project.workflow) ? project.workflow : []).filter((step) => !isStandaloneOnlyModuleId(workflowModuleIdForStep(step)));
    const workflowModuleIds = projectWorkflow.map(workflowModuleIdForStep).filter(Boolean);
    const storedModuleState = normalizeStoredModuleStates(project.moduleState);
    const moduleIds = new Set([
      ...MODULE_CATALOG.filter((module) => module.workflow !== false).map((module) => module.id),
      ...installed,
      ...Object.keys(storedModuleState).map(canonicalModuleId).filter((moduleId) => moduleId && !isStandaloneOnlyModuleId(moduleId)),
      ...workflowModuleIds
    ]);
    const moduleState = {};
    for (const moduleId of moduleIds) {
      const current = normalizeModuleStatusRecord(storedModuleState[moduleId]);
      moduleState[moduleId] = moduleId === DOCUMENT_EDITOR_ID ? aggregateDocumentEditorState(current) : current;
    }
    const legacyRoleMin = Number.isFinite(Number(project.settings?.participantMin)) ? Math.max(0, Number(project.settings.participantMin)) : 1;
    const legacyRoleMax = Number.isFinite(Number(project.settings?.participantMax)) ? Math.max(1, legacyRoleMin, Number(project.settings.participantMax)) : Math.max(1, legacyRoleMin);
    const defaultRoles = [
      { id: 'member', name: '배정 인원', candidateFilter: 'all', minPerSession: legacyRoleMin, maxPerSession: legacyRoleMax, targetSessions: 1, active: true, color: '#2879b8' }
    ];
    const columns = Array.isArray(data.columns) ? data.columns : [];
    const roles = Array.isArray(data.roles) && data.roles.length ? data.roles.map((role) => {
      const minPerSession = Math.max(0, Number(role.minPerSession) || 0);
      return {
        id: storedStringId(role.id) || makeId('role'),
        name: String(role.name || '역할').trim(),
        candidateFilter: typeof role.candidateFilter === 'string' ? role.candidateFilter : 'manual',
        minPerSession,
        maxPerSession: Math.max(1, minPerSession, Number(role.maxPerSession) || 1),
        targetSessions: Math.max(0, Number(role.targetSessions) || 0),
        active: role.active !== false,
        color: role.color || '#66717e'
      };
    }) : defaultRoles;
    if (!roles.some((role) => role.active !== false)) roles[0] = { ...roles[0], active: true };
    const facilitatorRole = roles.find((role) => role.id === 'coach' || /(코치|coach|진행자|강사)/i.test(role.name));
    const primaryRole = roles.find((role) => role.active !== false && role !== facilitatorRole) || roles.find((role) => role.active !== false) || roles[0];
    const normalizedDefaultTimezone = normalizeTimeZone(defaultTimezone);
    const hasTimezoneOverrideField = Object.prototype.hasOwnProperty.call(project.settings || {}, 'timezoneOverride');
    const legacyTimezoneOverride = !hasTimezoneOverrideField
      && isValidTimeZone(project.settings?.timezone)
      && project.settings.timezone !== DEFAULT_TIMEZONE
      ? String(project.settings.timezone).trim()
      : null;
    const timezoneOverride = isValidTimeZone(project.settings?.timezoneOverride)
      ? String(project.settings.timezoneOverride).trim()
      : legacyTimezoneOverride;
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
      workflow: (projectWorkflow.length
        ? projectWorkflow
        : workflowForModules([...installed])
      ).map(normalizeWorkflowStep).sort((a, b) => a.order - b.order).map((step, index) => ({
        ...step,
        order: index,
        status: step.moduleId === DOCUMENT_EDITOR_ID && step.documentMode
          ? moduleState[DOCUMENT_EDITOR_ID]?.steps?.[step.id]?.status || step.status
          : step.moduleId ? moduleState[step.moduleId]?.status || step.status : step.status,
        updatedAt: step.moduleId === DOCUMENT_EDITOR_ID && step.documentMode
          ? moduleState[DOCUMENT_EDITOR_ID]?.steps?.[step.id]?.updatedAt || step.updatedAt
          : step.moduleId ? moduleState[step.moduleId]?.updatedAt || step.updatedAt : step.updatedAt
      })),
      settings: {
        timezone: timezoneOverride || normalizedDefaultTimezone,
        timezoneOverride,
        sessionDurationMinutes: Number(project.settings?.sessionDurationMinutes) || 60,
        participantMin: Number(primaryRole?.minPerSession) || 0,
        participantMax: Math.max(1, Number(primaryRole?.maxPerSession) || 1),
        coachRequired: Boolean(facilitatorRole && Number(facilitatorRole.minPerSession) >= 1),
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
        columns,
        people: Array.isArray(data.people) ? data.people.map((person, index) => ({
          id: person.id || makeId('person'),
          sourceOrder: Number.isFinite(Number(person.sourceOrder)) ? Number(person.sourceOrder) : index,
          values: normalizePersonValues(person, columns),
          name: String(person.name || '').trim(),
          email: String(person.email || '').trim(),
          phone: String(person.phone || '').trim(),
          group: String(person.group || '').trim(),
          roleIds: normalizePersonRoleIds(person.roleIds, roles),
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
        slots: Array.isArray(data.slots) ? data.slots.map(normalizeScheduleSlot) : [],
        activities: Array.isArray(data.activities) ? data.activities.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map(normalizeActivity) : [],
        availability: data.availability && typeof data.availability === 'object' ? data.availability : {},
        assignments: Array.isArray(data.assignments) ? data.assignments : [],
        activityAssignments: Array.isArray(data.activityAssignments) ? data.activityAssignments.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map(normalizeActivityAssignment) : [],
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
        versions: Array.isArray(data.versions) ? data.versions.map(normalizeScheduleVersion) : [],
        forms: {
          ...forms,
          definitions: formDefinitions,
          linkedForms: Array.isArray(forms.linkedForms) ? forms.linkedForms : [],
          activeDefinitionId: hasActiveFormDefinition ? (forms.activeDefinitionId || null) : (formDefinitions.at(-1)?.id || null),
          selectedFormId: forms.selectedFormId || null,
          lastResponseSyncAt: forms.lastResponseSyncAt || null
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
        extensionData: normalizeProjectExtensionData(data.extensionData)
      }
    };
  }

  function normalizeState(input) {
    const fallback = createEmptyState();
    if (!input || typeof input !== 'object') input = fallback;
    const preferences = {
      ...fallback.preferences,
      ...(input.preferences || {}),
      defaultTimezone: normalizeTimeZone(input.preferences?.defaultTimezone || input.preferences?.timezone || fallback.preferences.defaultTimezone),
      globalDefaultConnectionIds: {
        ...fallback.preferences.globalDefaultConnectionIds,
        ...(input.preferences?.globalDefaultConnectionIds || {})
      }
    };
    const availableIds = new Set(MODULE_CATALOG.map((module) => module.id));
    const sourceVersion = Math.max(0, Number(input.version || 0));
    const hasStoredExtensions = Array.isArray(input.installedExtensions);
    const rawInstalledExtensions = (hasStoredExtensions ? input.installedExtensions : MODULE_CATALOG.map((module) => module.id)).map(storedStringId).filter(Boolean);
    const installedExtensions = [...new Set(rawInstalledExtensions.map(canonicalModuleId).filter(Boolean))];
    if (sourceVersion < VERSION) MODULE_CATALOG.filter((module) => module.defaultInstalled).forEach((module) => {
      const shouldInstall = module.id !== DOCUMENT_EDITOR_ID
        || sourceVersion < 3
        || !hasStoredExtensions
        || rawInstalledExtensions.some((id) => canonicalModuleId(id) === DOCUMENT_EDITOR_ID);
      if (shouldInstall && !installedExtensions.includes(module.id)) installedExtensions.push(module.id);
    });
    MODULE_CATALOG.filter((module) => module.core).forEach((module) => { if (!installedExtensions.includes(module.id)) installedExtensions.push(module.id); });
    const projects = Array.isArray(input.projects) ? input.projects.map((project) => normalizeProject(project, preferences.defaultTimezone)) : [];
    const rememberedIds = new Set([...availableIds, ...installedExtensions]);
    Object.keys(input.quickWorkspaces || {}).map(canonicalModuleId).filter(Boolean).forEach((id) => rememberedIds.add(id));
    Object.keys(input.quickTasks || {}).map(canonicalModuleId).filter(Boolean).forEach((id) => rememberedIds.add(id));
    [...projects, ...Object.values(input.quickWorkspaces || {})].forEach((project) => {
      (Array.isArray(project?.installedModules) ? project.installedModules : []).map(canonicalModuleId).filter(Boolean).forEach((id) => rememberedIds.add(id));
      Object.keys(project?.moduleState || {}).map(canonicalModuleId).filter(Boolean).forEach((id) => rememberedIds.add(id));
      (Array.isArray(project?.workflow) ? project.workflow : []).map((step) => canonicalModuleId(step?.moduleId)).filter(Boolean).forEach((id) => rememberedIds.add(id));
    });
    const quickWorkspaces = {};
    for (const moduleId of rememberedIds) {
      if (excludedFromQuickWorkspace(moduleId)) continue;
      const existing = Object.entries(input.quickWorkspaces || {}).find(([rawId]) => canonicalModuleId(rawId) === moduleId)?.[1];
      if (!existing && !installedExtensions.includes(moduleId)) continue;
      const source = existing || { id: `quick-${moduleId}`, name: `${MODULE_CATALOG.find((item) => item.id === moduleId)?.name || moduleId} 빠른 작업`, status: 'active', installedModules: installedExtensions };
      quickWorkspaces[moduleId] = { ...normalizeProject(source, preferences.defaultTimezone), id: `quick-${moduleId}`, scope: 'quick', installedModules: installedExtensions.filter((id) => !excludedFromQuickWorkspace(id)), extensionInstalled: availableIds.has(moduleId) && installedExtensions.includes(moduleId) };
    }
    const library = {
      rosters: Array.isArray(input.library?.rosters) ? input.library.rosters : [],
      mailTemplates: Array.isArray(input.library?.mailTemplates) ? input.library.mailTemplates : [],
      layoutTemplates: Array.isArray(input.library?.layoutTemplates) ? input.library.layoutTemplates : [],
      workflowTemplates: normalizeWorkflowTemplates(input.library?.workflowTemplates),
      formTemplates: Array.isArray(input.library?.formTemplates) ? input.library.formTemplates : []
    };
    const liveLibraryIds = new Set(Object.values(library).flatMap((items) => items
      .filter((item) => item?.builtin !== true)
      .map((item) => storedStringId(item?.id))).filter(Boolean));
    const knownLibraryIds = [...new Set([
      ...(Array.isArray(input.knownLibraryIds) ? input.knownLibraryIds : []),
      ...(Array.isArray(input.deletedLibraryIds) ? input.deletedLibraryIds : []),
      ...liveLibraryIds
    ].map(storedStringId).filter(Boolean))];
    const deletedLibraryIds = [...new Set([
      ...(Array.isArray(input.deletedLibraryIds) ? input.deletedLibraryIds : []),
      ...knownLibraryIds.filter((id) => !liveLibraryIds.has(id))
    ].map(storedStringId).filter(Boolean))];
    const deletedLibraryIdSet = new Set(deletedLibraryIds);
    Object.keys(library).forEach((key) => { library[key] = library[key].filter((item) => item?.builtin === true || !deletedLibraryIdSet.has(storedStringId(item?.id))); });
    const activeExists = projects.some((project) => project.id === input.activeProjectId && project.status !== 'archived');
    const firstActive = projects.find((project) => project.status !== 'archived');
    const quickTasks = {};
    for (const moduleId of rememberedIds) {
      const candidates = Object.entries(input.quickTasks || {})
        .filter(([rawId, tasks]) => canonicalModuleId(rawId) === moduleId && Array.isArray(tasks))
        .flatMap(([, tasks]) => tasks);
      const seenTaskIds = new Set();
      quickTasks[moduleId] = candidates.filter((task, index) => {
        const taskId = storedStringId(task?.id); const key = taskId || `anonymous:${index}:${JSON.stringify(task)}`;
        if (seenTaskIds.has(key)) return false;
        seenTaskIds.add(key); return true;
      });
    }
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
        updatedAt: connection.updatedAt || nowIso(),
        ...normalizedConnectionAuthDiagnostics(connection)
      })) : [],
      installedExtensions,
      quickWorkspaces,
      quickTasks,
      library,
      deletedConnectionIds: Array.isArray(input.deletedConnectionIds) ? input.deletedConnectionIds : [],
      knownLibraryIds,
      deletedLibraryIds,
      preferences,
      updatedAt: input.updatedAt || nowIso()
    };
  }

  function setExtensionInstalled(stateInput, moduleId, installed) {
    moduleId = canonicalModuleId(moduleId);
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
    if (installed && !state.quickWorkspaces[moduleId] && module.workflow !== false) state.quickWorkspaces[moduleId] = { ...normalizeProject({ id: `quick-${moduleId}`, name: `${module.name} 빠른 작업`, installedModules: [...extensions] }, state.preferences.defaultTimezone), scope: 'quick' };
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
    if (workflow.some((step) => isStandaloneOnlyModuleId(workflowModuleIdForStep(step)))) throw new Error('독립 프로그램은 프로젝트 업무 순서에 추가할 수 없습니다.');
    const moduleIds = [...new Set(workflow.map((step) => canonicalModuleId(step.moduleId) || taskType(step.type).moduleId).filter(Boolean))];
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
    }, state.preferences.defaultTimezone);
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
        },
        forms: {
          ...current.data?.forms,
          ...(patch.data?.forms || {})
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
    if (index >= 0) state.projects[index] = normalizeProject(merged, state.preferences.defaultTimezone);
    else state.quickWorkspaces[quickId] = { ...normalizeProject(merged, state.preferences.defaultTimezone), id: projectId, scope: 'quick' };
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

  function createDetachedProjectCopy(sourceInput, values = {}) {
    const sourceDefaultTimezone = normalizeTimeZone(sourceInput?.settings?.timezone);
    const source = normalizeProject(clone(sourceInput || {}), sourceDefaultTimezone);
    const timestamp = nowIso();
    const externalModules = new Set(['forms', 'zoom', 'gmailFlow']);
    const project = normalizeProject({
      ...source,
      id: values.id || makeId('project-copy'),
      name: values.name || source.name,
      settings: {
        ...source.settings,
        defaultConnectionIds: { forms: null, drive: null, gmail: null, zoom: null }
      },
      moduleState: Object.fromEntries(Object.entries(source.moduleState).map(([moduleId, module]) => [moduleId, externalModules.has(moduleId) ? { status: 'notStarted', updatedAt: null, summary: '' } : module])),
      workflow: source.workflow.map((step) => externalModules.has(step.moduleId) ? { ...step, status: 'notStarted', updatedAt: null } : step),
      data: {
        ...source.data,
        slots: source.data.slots.map(({ zoomConnectionId, ...slot }) => slot),
        forms: {
          ...source.data.forms,
          linkedForms: [],
          selectedFormId: null,
          lastResponseSyncAt: null
        },
        externalArtifacts: []
      },
      createdAt: values.createdAt || timestamp,
      updatedAt: timestamp
    }, source.settings.timezone);
    return { ...project, scope: values.scope || 'quick' };
  }

  function pruneRosterReferences(project) {
    const data = project?.data;
    if (!data) return { removedAssignmentIds: [], removedActivityAssignmentIds: [], removedRosterViewMemberships: 0, removedGroupMemberships: 0, removedGroupPersonReferences: 0, removedGroupRoleReferences: 0 };
    const validPersonIds = new Set((data.people || []).map((person) => person.id));
    const validRoleIds = new Set((data.roles || []).map((role) => role.id));
    const removedAssignmentIds = new Set((data.assignments || []).filter((assignment) => !validPersonIds.has(assignment.personId)).map((assignment) => assignment.id));
    data.assignments = (data.assignments || []).filter((assignment) => validPersonIds.has(assignment.personId));
    data.availability = Object.fromEntries(Object.entries(data.availability || {}).filter(([personId]) => validPersonIds.has(personId)));
    const validActivityIds = new Set((data.activities || []).map((activity) => activity.id));
    const validAssignmentIds = new Set(data.assignments.map((assignment) => assignment.id));
    const removedActivityAssignmentIds = [];
    data.activityAssignments = (data.activityAssignments || []).filter((link) => {
      const hasValidActivity = Boolean(link.activityId && validActivityIds.has(link.activityId));
      const hasValidAssignment = Boolean(link.assignmentId && validAssignmentIds.has(link.assignmentId));
      const valid = (!link.personId || validPersonIds.has(link.personId))
        && (hasValidActivity || hasValidAssignment)
        && (!link.assignmentId || validAssignmentIds.has(link.assignmentId));
      if (!valid) removedActivityAssignmentIds.push(link.id);
      return valid;
    });
    let removedRosterViewMemberships = 0;
    data.rosterViews = (data.rosterViews || []).map((view) => {
      const personIds = (view.personIds || []).filter((personId) => validPersonIds.has(personId));
      const excludedPersonIds = (view.excludedPersonIds || []).filter((personId) => validPersonIds.has(personId));
      removedRosterViewMemberships += (view.personIds || []).length - personIds.length + (view.excludedPersonIds || []).length - excludedPersonIds.length;
      return { ...view, personIds, excludedPersonIds };
    });
    const validRosterViewIds = new Set(data.rosterViews.map((view) => view.id));
    if (!validRosterViewIds.has(data.activeRosterViewId)) data.activeRosterViewId = null;
    if (data.scheduleRules && !validRosterViewIds.has(data.scheduleRules.rosterViewId)) data.scheduleRules.rosterViewId = null;
    let removedGroupPersonReferences = 0;
    let removedGroupRoleReferences = 0;
    const projectCalendar = data.extensionData?.projectCalendar;
    if (isPlainObject(projectCalendar) && Array.isArray(projectCalendar.groups)) {
      projectCalendar.groups = projectCalendar.groups.map((group) => {
        if (!isPlainObject(group)) return group;
        const removedPersonIds = [];
        const members = (Array.isArray(group.members) ? group.members : []).filter((member) => {
          if (!isPlainObject(member) || !validPersonIds.has(member.personId)) {
            if (isPlainObject(member) && storedStringId(member.personId)) removedPersonIds.push(storedStringId(member.personId));
            removedGroupPersonReferences += 1;
            return false;
          }
          if (member.roleId != null && storedStringId(member.roleId) && !validRoleIds.has(member.roleId)) {
            if (storedStringId(member.personId)) removedPersonIds.push(storedStringId(member.personId));
            removedGroupRoleReferences += 1;
            return false;
          }
          return true;
        });
        return { ...group, members, deletedMemberIds: [...new Set([...(group.deletedMemberIds || []).map(storedStringId), ...removedPersonIds].filter(Boolean))] };
      });
    }
    return {
      removedAssignmentIds: [...removedAssignmentIds],
      removedActivityAssignmentIds,
      removedRosterViewMemberships,
      removedGroupMemberships: removedGroupPersonReferences + removedGroupRoleReferences,
      removedGroupPersonReferences,
      removedGroupRoleReferences
    };
  }

  function duplicateProject(stateInput, projectId) {
    const state = normalizeState(stateInput);
    const source = state.projects.find((project) => project.id === projectId);
    if (!source) throw new Error('복제할 프로젝트를 찾을 수 없습니다.');
    const result = createProject(state, {
      ...clone(source),
      id: makeId('project'),
      name: `${source.name} 복사본`,
      status: 'active',
      settings: {
        ...clone(source.settings),
        defaultConnectionIds: { forms: null, drive: null, gmail: null, zoom: null }
      }
    });
    const duplicatedModuleIds = new Set([
      ...MODULE_CATALOG.filter((module) => module.workflow !== false).map((module) => module.id),
      ...result.project.workflow.map((step) => step.moduleId).filter(Boolean)
    ]);
    result.project.moduleState = Object.fromEntries(
      [...duplicatedModuleIds].map((moduleId) => [moduleId, moduleId === DOCUMENT_EDITOR_ID
        ? { status: 'notStarted', updatedAt: null, summary: '', modes: Object.fromEntries(DOCUMENT_EDITOR_MODES.map((mode) => [mode, { status: 'notStarted', updatedAt: null, summary: '' }])), steps: {} }
        : { status: 'notStarted', updatedAt: null, summary: '' }])
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
      rosterName: '',
      people: [],
      rosterViews: [],
      activeRosterViewId: null,
      workItems: [],
      activeWorkItemId: null,
      slots: [],
      activities: [],
      availability: {},
      assignments: [],
      activityAssignments: [],
      conflicts: [],
      scheduleCustomValues: {},
      scheduleRules: { ...result.project.data.scheduleRules, rosterViewId: null },
      versions: [],
      forms: { definitions: [], linkedForms: [], activeDefinitionId: null, selectedFormId: null, lastResponseSyncAt: null },
      communication: { subjectTemplate: '[{프로젝트}] 일정 안내', bodyTemplate: '{이름}님, 아래 일정으로 안내드립니다.\n\n{개인일정}', bodyHtmlTemplate: '', mailEdits: {}, lastPreparedAt: null },
      externalArtifacts: [],
      extensionData: {}
    };
    result.state.projects[0] = normalizeProject(result.project, result.state.preferences.defaultTimezone);
    return result;
  }

  function setModuleInstalled(stateInput, projectId, moduleId, installed) {
    moduleId = canonicalModuleId(moduleId);
    const module = MODULE_CATALOG.find((item) => item.id === moduleId);
    if (!module) throw new Error('알 수 없는 모듈입니다.');
    if (!supportsProjectStep(module)) throw new Error('이 프로그램은 프로젝트 업무 단계로 추가할 수 없습니다.');
    if (module.core && !installed) throw new Error('핵심 모듈은 제거할 수 없습니다.');
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const modules = new Set(project.installedModules);
    if (installed) modules.add(moduleId); else modules.delete(moduleId);
    return updateProject(state, projectId, { installedModules: [...modules] });
  }

  function setModuleStatus(stateInput, projectId, moduleId, status, summary = '') {
    moduleId = canonicalModuleId(moduleId);
    if (!['notStarted', 'inProgress', 'needsReview', 'complete', 'stale'].includes(status)) {
      throw new Error('알 수 없는 작업 상태입니다.');
    }
    if (isStandaloneOnlyModuleId(moduleId)) throw new Error('독립 프로그램에는 프로젝트 진행 상태를 설정할 수 없습니다.');
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId) || Object.values(state.quickWorkspaces).find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const updatedAt = nowIso();
    project.moduleState[moduleId] = { ...(project.moduleState[moduleId] || {}), status, summary, updatedAt };
    project.workflow = project.workflow.map((step) => step.moduleId === moduleId ? { ...step, status, updatedAt } : step);
    project.updatedAt = updatedAt;
    state.updatedAt = updatedAt;
    return state;
  }

  function setDocumentModeStatus(stateInput, projectId, documentMode, status, summary = '', stepId = '') {
    const mode = normalizeDocumentMode(documentMode);
    if (!mode) throw new Error('알 수 없는 문서 편집 모드입니다.');
    if (!Object.prototype.hasOwnProperty.call(MODULE_STATUS_PRIORITY, status)) throw new Error('알 수 없는 작업 상태입니다.');
    const state = normalizeState(stateInput);
    const project = state.projects.find((item) => item.id === projectId) || Object.values(state.quickWorkspaces).find((item) => item.id === projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const candidates = project.workflow.filter((step) => step.moduleId === DOCUMENT_EDITOR_ID && (!step.documentMode || step.documentMode === mode));
    const target = stepId ? candidates.find((step) => step.id === stepId) : candidates.length === 1 ? candidates[0] : candidates.find((step) => step.documentMode === mode);
    const updatedAt = nowIso(); const record = { status, summary, updatedAt };
    const current = aggregateDocumentEditorState(project.moduleState[DOCUMENT_EDITOR_ID]);
    const modes = { ...current.modes, [mode]: { ...(current.modes?.[mode] || {}), ...record } };
    const steps = { ...(current.steps && typeof current.steps === 'object' && !Array.isArray(current.steps) ? current.steps : {}) };
    if (target) steps[target.id] = { ...(steps[target.id] || {}), ...record, documentMode: mode };
    const aggregate = Object.values(modes).reduce((selected, candidate) => mergeModuleStatusRecords(selected, candidate), null) || record;
    project.moduleState[DOCUMENT_EDITOR_ID] = { ...current, ...aggregate, modes, steps };
    if (target) project.workflow = project.workflow.map((step) => step.id === target.id ? { ...step, documentMode: mode, status, updatedAt } : step);
    project.updatedAt = updatedAt; state.updatedAt = updatedAt;
    return state;
  }

  function updateProjectWorkflow(stateInput, projectId, steps = []) {
    if (!Array.isArray(steps) || !steps.length) throw new Error('프로젝트에는 작업이 하나 이상 필요합니다.');
    if (steps.some((step) => isStandaloneOnlyModuleId(workflowModuleIdForStep(step)))) throw new Error('독립 프로그램은 프로젝트 업무 순서에 추가할 수 없습니다.');
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
    if (step.moduleId === DOCUMENT_EDITOR_ID && step.documentMode) {
      const summary = notes !== undefined ? String(notes || '') : step.notes || '';
      const updated = setDocumentModeStatus(state, projectId, step.documentMode, status, summary, step.id);
      const updatedProject = updated.projects.find((item) => item.id === projectId);
      const updatedStep = updatedProject?.workflow.find((item) => item.id === stepId);
      if (updatedStep && notes !== undefined) updatedStep.notes = summary;
      return updated;
    }
    step.status = status;
    step.updatedAt = nowIso();
    if (notes !== undefined) step.notes = String(notes || '');
    if (step.moduleId && project.moduleState[step.moduleId]) project.moduleState[step.moduleId] = { ...project.moduleState[step.moduleId], status, summary: step.notes || '', updatedAt: step.updatedAt };
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
    const supportsGlobalDefault = ['forms', 'gmail', 'zoom'].includes(connection.type);
    const previousAutomaticDefaultId = supportsGlobalDefault ? resolveDefaultConnectionId(state, null, connection.type) : null;
    state.connections.push(connection);
    if (supportsGlobalDefault && !state.preferences.globalDefaultConnectionIds[connection.type]) {
      if (previousAutomaticDefaultId) state.preferences.globalDefaultConnectionIds[connection.type] = previousAutomaticDefaultId;
      else if (state.connections.filter((item) => item.type === connection.type).length === 1) state.preferences.globalDefaultConnectionIds[connection.type] = connection.id;
    }
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

  function captureProjectConnectionIdentities(stateInput, projectInput) {
    const connections = Array.isArray(stateInput?.connections) ? stateInput.connections : [];
    const project = projectInput && typeof projectInput === 'object' ? projectInput : {};
    const connectionIds = new Set(Object.values(project.settings?.defaultConnectionIds || {}).filter(Boolean));
    (project.data?.slots || []).forEach((slot) => { if (slot.zoomConnectionId) connectionIds.add(slot.zoomConnectionId); });
    (project.data?.externalArtifacts || []).forEach((artifact) => {
      if (artifact.connectionId) connectionIds.add(artifact.connectionId);
      if (artifact.replacementConnectionId) connectionIds.add(artifact.replacementConnectionId);
    });
    (project.data?.forms?.linkedForms || []).forEach((linked) => { if (linked.connectionId) connectionIds.add(linked.connectionId); });
    return Object.fromEntries([...connectionIds].map((connectionId) => {
      const connection = connections.find((item) => item.id === connectionId);
      return connection ? [connectionId, connectionIdentity(connection)] : null;
    }).filter(Boolean));
  }

  function reconcileSavedQuickTask(stateInput, taskInput) {
    const state = normalizeState(stateInput);
    const rawTask = clone(taskInput || {});
    const project = normalizeProject(rawTask, state.preferences.defaultTimezone);
    const expectedIdentities = rawTask.connectionIdentities && typeof rawTask.connectionIdentities === 'object' && !Array.isArray(rawTask.connectionIdentities)
      ? rawTask.connectionIdentities
      : {};
    const liveConnections = new Map(state.connections.map((connection) => [connection.id, connection]));
    const validConnection = (connectionId, type = '') => {
      if (!connectionId) return false;
      const live = liveConnections.get(connectionId);
      const expected = expectedIdentities[connectionId];
      const expectedAccount = String(expected?.account || '').trim().toLowerCase();
      const liveAccount = String(live?.account || '').trim().toLowerCase();
      return Boolean(live && expected
        && String(live.id || '') === String(expected.id || '')
        && String(live.type || '') === String(expected.type || '')
        && (!type || live.type === type)
        && expectedAccount
        && liveAccount === expectedAccount);
    };
    const reviewedAt = nowIso();
    let reviewedConnections = 0;
    const modulesToReview = new Map();
    const reviewModule = (moduleId, reason) => {
      modulesToReview.set(moduleId, reason);
    };

    const defaults = { ...project.settings.defaultConnectionIds };
    Object.entries(defaults).forEach(([type, connectionId]) => {
      if (!connectionId || validConnection(connectionId, type)) return;
      defaults[type] = null;
      reviewedConnections += 1;
      if (type === 'gmail') reviewModule('gmailFlow', '저장 당시 Gmail 계정이 달라 사용 계정 재확인 필요');
      if (type === 'zoom') reviewModule('zoom', '저장 당시 Zoom 계정이 달라 사용 계정 재확인 필요');
      if (type === 'forms') reviewModule('forms', '저장 당시 Google Forms 계정이 달라 사용 계정 재확인 필요');
    });
    project.settings = { ...project.settings, defaultConnectionIds: defaults };

    const affectedZoomSlotIds = new Set();
    project.data.slots = project.data.slots.map((slot) => {
      if (!slot.zoomConnectionId || validConnection(slot.zoomConnectionId, 'zoom')) return slot;
      affectedZoomSlotIds.add(slot.id); reviewedConnections += 1; reviewModule('zoom', '저장 당시 Zoom 계정이 달라 일정 재확인 필요');
      return { ...slot, zoomConnectionId: null };
    });
    project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
      const type = artifact.kind === 'gmailDraft' ? 'gmail' : artifact.kind === 'zoom' ? 'zoom' : '';
      const directInvalid = Boolean(artifact.connectionId && !validConnection(artifact.connectionId, type));
      const replacementInvalid = Boolean(artifact.replacementConnectionId && !validConnection(artifact.replacementConnectionId));
      if (!directInvalid && !replacementInvalid) return artifact;
      let next = replacementInvalid ? { ...artifact, replacementConnectionId: null } : { ...artifact };
      if (!directInvalid) return next;
      next.connectionId = null;
      reviewedConnections += 1;
      if (artifact.kind === 'gmailDraft') {
        reviewModule('gmailFlow', '저장 당시 Gmail 계정이 달라 메일 초안 재확인 필요');
        if (artifact.status !== 'superseded') next = { ...next, status: 'superseded', replacedAt: artifact.replacedAt || reviewedAt, replacementReason: '저장 당시 Gmail 계정과 현재 계정이 달라 새 계정에서 다시 확인 필요' };
      } else if (artifact.kind === 'zoom') {
        if (artifact.slotId) affectedZoomSlotIds.add(artifact.slotId);
        reviewModule('zoom', '저장 당시 Zoom 계정이 달라 회의 재확인 필요');
        if (artifact.status !== 'superseded') next = { ...next, status: 'superseded', replacedAt: artifact.replacedAt || reviewedAt, replacementReason: '저장 당시 Zoom 계정과 현재 계정이 달라 새 계정에서 다시 확인 필요' };
      }
      return next;
    });
    if (affectedZoomSlotIds.size) {
      const affectedPersonIds = new Set(project.data.assignments.filter((assignment) => affectedZoomSlotIds.has(assignment.slotId)).map((assignment) => assignment.personId).filter(Boolean));
      project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
        if (artifact.kind !== 'gmailDraft' || artifact.status === 'superseded' || !affectedPersonIds.has(artifact.personId)) return artifact;
        reviewModule('gmailFlow', '저장된 Zoom 연결 변경 후 안내 메일의 회의 링크 재확인 필요');
        return { ...artifact, status: 'stale', replacementReason: '저장된 Zoom 연결 변경 후 안내 메일의 회의 링크 재확인 필요' };
      });
    }
    project.data.forms = {
      ...project.data.forms,
      linkedForms: project.data.forms.linkedForms.map((linked) => {
        if (linked.connectionId && validConnection(linked.connectionId, 'forms') && !linked.connectionReviewRequired) return linked;
        reviewedConnections += 1; reviewModule('forms', '저장 당시 Google Forms 계정 재확인 필요');
        const reason = linked.connectionReviewReason || '저장 당시 Google Forms 계정과 현재 계정을 다시 확인해주세요.';
        return { ...linked, connectionId: validConnection(linked.connectionId, 'forms') ? linked.connectionId : null, needsReview: true, reviewReason: reason, connectionReviewRequired: true, connectionReviewReason: reason };
      })
    };
    modulesToReview.forEach((reason, moduleId) => {
      project.moduleState[moduleId] = { ...(project.moduleState[moduleId] || {}), status: 'needsReview', summary: reason, updatedAt: reviewedAt };
      project.workflow = project.workflow.map((step) => step.moduleId === moduleId ? { ...step, status: 'needsReview', updatedAt: reviewedAt } : step);
    });
    project.updatedAt = reviewedAt;
    return {
      project: { ...project, savedAt: rawTask.savedAt || null, scope: rawTask.scope || 'quick', connectionIdentities: expectedIdentities },
      reviewedConnections,
      needsAccountReview: reviewedConnections > 0
    };
  }

  function applyConnectionAuthorization(stateInput, connectionId, status = {}, reason = '로그인 계정 변경 후 기존 외부 항목 재확인 필요') {
    const state = normalizeState(stateInput);
    const connection = state.connections.find((item) => item.id === connectionId);
    if (!connection) return { state, connection: null, accountChanged: false, retiredArtifacts: 0, reviewedForms: 0 };
    const previousAccount = String(connection.account || '').trim().toLowerCase();
    connection.status = status.connected ? 'connected' : 'needsAuth';
    connection.account = String(status.account || connection.account || '').trim();
    delete connection.lastAuthError;
    delete connection.lastAuthStage;
    delete connection.lastAuthCode;
    delete connection.lastAuthStatus;
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
        let gmailDependencyChanged = false;
        const zoomSlotIds = connection.type === 'zoom' ? new Set(project.data.slots.filter((slot) => slot.zoomConnectionId === connection.id || (!slot.zoomConnectionId && resolveDefaultConnectionId(state, project, 'zoom') === connection.id)).map((slot) => slot.id)) : new Set();
        if (artifactKind) {
          project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
            if (artifact.kind !== artifactKind || artifact.connectionId !== connection.id || artifact.status === 'superseded') return artifact;
            changed = true; retiredArtifacts += 1;
            return { ...artifact, status: 'superseded', replacedAt: nowIso(), replacementReason: reason };
          });
        }
        if (connection.type === 'zoom' && zoomSlotIds.size) {
          const personIds = new Set(project.data.assignments.filter((assignment) => zoomSlotIds.has(assignment.slotId)).map((assignment) => assignment.personId).filter(Boolean));
          project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
            if (artifact.kind !== 'gmailDraft' || artifact.status === 'superseded' || !personIds.has(artifact.personId)) return artifact;
            gmailDependencyChanged = true;
            return { ...artifact, status: 'stale', replacementReason: 'Zoom 로그인 계정 변경 후 안내 메일의 회의 링크 재확인 필요' };
          });
        }
        if (connection.type === 'forms') {
          const inheritedFormsConnection = resolveDefaultConnectionId(state, project, 'forms') === connection.id;
          project.data.forms.linkedForms = project.data.forms.linkedForms.map((linked) => {
            if (linked.connectionId !== connection.id && !(inheritedFormsConnection && !linked.connectionId)) return linked;
            changed = true; reviewedForms += 1;
            return { ...linked, connectionId: linked.connectionId || connection.id, needsReview: true, reviewReason: reason, connectionReviewRequired: true, connectionReviewReason: reason };
          });
        }
        if (!changed && !gmailDependencyChanged) return;
        const stamp = nowIso();
        if (project.installedModules.includes(moduleId)) {
          project.moduleState[moduleId] = { status: 'needsReview', summary: reason, updatedAt: stamp };
          project.workflow = project.workflow.map((step) => step.moduleId === moduleId ? { ...step, status: 'needsReview', updatedAt: stamp } : step);
        }
        if (gmailDependencyChanged && project.installedModules.includes('gmailFlow')) {
          project.moduleState.gmailFlow = { status: 'needsReview', summary: 'Zoom 로그인 계정 변경 후 안내 메일의 회의 링크 재확인 필요', updatedAt: stamp };
          project.workflow = project.workflow.map((step) => step.moduleId === 'gmailFlow' ? { ...step, status: 'needsReview', updatedAt: stamp } : step);
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
    state.deletedConnectionIds = [...new Set([...(state.deletedConnectionIds || []), connectionId].filter(Boolean))];
    if (state.preferences.workspaceDriveConnectionId === connectionId) state.preferences.workspaceDriveConnectionId = null;
    Object.keys(state.preferences.globalDefaultConnectionIds).forEach((type) => {
      if (state.preferences.globalDefaultConnectionIds[type] === connectionId) state.preferences.globalDefaultConnectionIds[type] = null;
    });
    if (removedWorkspaceDrive && state.preferences.storageMode === 'drive') state.preferences.storageMode = 'local';
    state.projects = state.projects.map((project) => {
      const defaults = { ...project.settings.defaultConnectionIds };
      Object.keys(defaults).forEach((key) => { if (defaults[key] === connectionId) defaults[key] = null; });
      return normalizeProject({ ...project, settings: { ...project.settings, defaultConnectionIds: defaults } }, state.preferences.defaultTimezone);
    });
    state.quickWorkspaces = Object.fromEntries(Object.entries(state.quickWorkspaces || {}).map(([moduleId, project]) => {
      const defaults = { ...project.settings.defaultConnectionIds };
      Object.keys(defaults).forEach((key) => { if (defaults[key] === connectionId) defaults[key] = null; });
      return [moduleId, { ...normalizeProject({ ...project, settings: { ...project.settings, defaultConnectionIds: defaults } }, state.preferences.defaultTimezone), scope: project.scope || 'quick', extensionInstalled: project.extensionInstalled !== false }];
    }));
    state.updatedAt = nowIso();
    return state;
  }

  function resolveDefaultConnectionId(stateInput, project, type) {
    const state = stateInput && typeof stateInput === 'object' ? stateInput : createEmptyState();
    const projectConnectionId = project?.settings?.defaultConnectionIds?.[type] || null;
    if (projectConnectionId) return projectConnectionId;
    if (!['forms', 'gmail', 'zoom'].includes(type)) return null;
    const selectedId = state.preferences?.globalDefaultConnectionIds?.[type] || null;
    if (selectedId) return selectedId;
    const configured = (Array.isArray(state.connections) ? state.connections : []).filter((connection) => connection.type === type);
    return configured.length === 1 ? configured[0].id : null;
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
    DEFAULT_TIMEZONE,
    DOCUMENT_EDITOR_ID,
    DOCUMENT_EDITOR_MODES,
    MODULE_CATALOG,
    WORKFLOW_ORDER,
    CONNECTION_TYPES,
    TASK_TYPE_CATALOG,
    workflowTaskCatalog,
    supportsProjectStep,
    BUILTIN_WORKFLOW_TEMPLATES,
    configureExtensionCatalog,
    threeWayMerge,
    createEmptyState,
    isValidTimeZone,
    normalizePersonRoleIds,
    canonicalModuleId,
    normalizeDocumentMode,
    normalizeState,
    createProject,
    updateProject,
    setActiveProject,
    archiveProject,
    restoreProject,
    createDetachedProjectCopy,
    pruneRosterReferences,
    duplicateProject,
    setModuleInstalled,
    setExtensionInstalled,
    setModuleStatus,
    setDocumentModeStatus,
    updateProjectWorkflow,
    setWorkflowStepStatus,
    saveWorkflowTemplate,
    removeWorkflowTemplate,
    addConnection,
    connectionIdentity,
    connectionIdentityMatches,
    captureProjectConnectionIdentities,
    reconcileSavedQuickTask,
    applyConnectionAuthorization,
    removeConnection,
    resolveDefaultConnectionId,
    workspaceDriveConnection,
    getActiveProject,
    getProjectProgress
  };
});
