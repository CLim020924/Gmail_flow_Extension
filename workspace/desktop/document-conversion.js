'use strict';

const SOURCE_GROUPS = deepFreeze({
  presentation: {
    id: 'presentation',
    label: '프레젠테이션',
    sourceExtensions: ['ppt', 'pptx', 'pptm', 'odp'],
    targetExtensions: ['pdf', 'ppt', 'pptx', 'pptm', 'odp']
  },
  text: {
    id: 'text',
    label: '문서',
    sourceExtensions: ['hwp', 'hwpx', 'doc', 'docx', 'docm', 'odt', 'rtf'],
    targetExtensions: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'hwp', 'hwpx']
  },
  spreadsheet: {
    id: 'spreadsheet',
    label: '스프레드시트',
    sourceExtensions: ['cell', 'nxl', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv'],
    targetExtensions: ['pdf', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'cell', 'nxl']
  }
});

const FORMAT_DEFINITIONS = {
  ppt: ['PowerPoint 97-2003 프레젠테이션', 'presentation'],
  pptx: ['PowerPoint 프레젠테이션', 'presentation'],
  pptm: ['PowerPoint 매크로 프레젠테이션', 'presentation'],
  odp: ['OpenDocument 프레젠테이션', 'presentation'],
  hwp: ['한글 문서', 'text'],
  hwpx: ['한글 표준 문서', 'text'],
  doc: ['Word 97-2003 문서', 'text'],
  docx: ['Word 문서', 'text'],
  docm: ['Word 매크로 문서', 'text'],
  odt: ['OpenDocument 텍스트', 'text'],
  rtf: ['서식 있는 텍스트', 'text'],
  cell: ['한셀 문서', 'spreadsheet'],
  nxl: ['넥셀 문서', 'spreadsheet'],
  xls: ['Excel 97-2003 통합 문서', 'spreadsheet'],
  xlsx: ['Excel 통합 문서', 'spreadsheet'],
  xlsm: ['Excel 매크로 통합 문서', 'spreadsheet'],
  xlsb: ['Excel 바이너리 통합 문서', 'spreadsheet'],
  ods: ['OpenDocument 스프레드시트', 'spreadsheet'],
  csv: ['CSV 데이터', 'spreadsheet'],
  pdf: ['PDF 문서', 'output']
};

const OUTPUT_EXTENSION_SET = new Set([
  'pdf',
  'ppt', 'pptx', 'pptm', 'odp',
  'doc', 'docx', 'docm', 'odt', 'rtf', 'hwp', 'hwpx',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'cell', 'nxl'
]);

// These routes are intentionally excluded from the public matrix because the
// current Hancom help does not document the required import/export direction.
// A successful SaveAs call on one product version is not enough to claim that
// the route is portable across supported user installations.
const EXCLUDED_CONVERSION_TARGETS = deepFreeze({
  hwp: ['doc'],
  hwpx: ['doc'],
  docm: ['hwp', 'hwpx'],
  xlsb: ['cell', 'nxl']
});

const TARGET_COMPATIBILITY_NOTES = deepFreeze({
  pdf: 'PDF는 화면·인쇄 모양을 고정하는 결과이며 원본의 편집 기능과 동작(수식·애니메이션·매크로·자동화)은 사용할 수 없습니다.',
  ppt: '이전 PowerPoint 형식이라 최신 효과나 기능이 달라질 수 있습니다.',
  pptm: '매크로 사용 프레젠테이션입니다. 원본에 없는 매크로가 새로 생기지는 않습니다.',
  odp: 'OpenDocument 형식을 오가는 변환은 프로그램별 기능 차이로 일부 전용 기능·개체·서식이 달라지거나 빠질 수 있습니다.',
  doc: '이전 Word 형식이라 최신 레이아웃 기능이 달라질 수 있습니다.',
  docm: '매크로 사용 Word 문서입니다. 원본에 없는 매크로가 새로 생기지는 않습니다.',
  odt: 'OpenDocument 형식을 오가는 변환은 프로그램별 기능 차이로 일부 전용 기능·개체·서식이 달라지거나 빠질 수 있습니다.',
  rtf: 'RTF를 오가는 변환은 복잡한 페이지 배치·표·텍스트 상자·그리기 개체가 단순화될 수 있습니다.',
  hwp: '한컴 한글 형식으로 바뀌므로 완료 후 실제 결과 미리보기를 확인해주세요.',
  hwpx: '한컴 한글 표준 형식으로 바뀌므로 완료 후 실제 결과 미리보기를 확인해주세요.',
  xls: '이전 Excel 형식이라 최신 함수·표·서식 기능이 달라질 수 있습니다.',
  xlsm: '매크로 사용 Excel 통합 문서입니다. 원본에 없는 매크로가 새로 생기지는 않습니다.',
  xlsb: 'Excel 바이너리 통합 문서라 다른 스프레드시트 프로그램과의 호환성이 달라질 수 있습니다.',
  ods: 'OpenDocument 형식을 오가는 변환은 프로그램별 기능 차이로 일부 전용 기능·개체·서식이 달라지거나 빠질 수 있습니다.',
  csv: 'CSV 결과에는 현재 시트의 값만 저장되며 여러 시트·수식·서식·그림은 보존되지 않습니다.',
  cell: '한컴 한셀 형식으로 바뀌므로 완료 후 실제 결과 미리보기를 확인해주세요.',
  nxl: '이전 한셀 형식이라 최신 함수·표·서식 기능이 달라질 수 있습니다.'
});

const MACRO_CAPABLE_EXTENSIONS_BY_GROUP = deepFreeze({
  presentation: ['ppt', 'pptm'],
  text: ['doc', 'docm'],
  spreadsheet: ['xls', 'xlsm', 'xlsb']
});

const FORMAT_METADATA = deepFreeze(Object.fromEntries(Object.entries(FORMAT_DEFINITIONS).map(([extension, definition]) => {
  const [label, group] = definition;
  return [extension, {
    extension,
    label,
    displayLabel: `${label} (.${extension})`,
    group,
    source: group !== 'output',
    output: OUTPUT_EXTENSION_SET.has(extension)
  }];
})));

const DEPENDENCY_METADATA = deepFreeze({
  officePowerPoint: { id: 'officePowerPoint', engine: 'powerpoint', label: 'Microsoft PowerPoint' },
  officeWord: { id: 'officeWord', engine: 'word', label: 'Microsoft Word' },
  officeExcel: { id: 'officeExcel', engine: 'excel', label: 'Microsoft Excel' },
  hancomWriter: { id: 'hancomWriter', engine: 'hancomWriter', label: '한컴오피스 한글' },
  hancomCell: { id: 'hancomCell', engine: 'hancomCell', label: '한컴오피스 한셀' }
});

const ENGINE_TO_DEPENDENCY = deepFreeze(Object.fromEntries(
  Object.values(DEPENDENCY_METADATA).map((item) => [item.engine, item.id])
));

const DEPENDENCY_ALIASES = deepFreeze({
  officePowerPoint: ['officePowerPoint', 'powerpoint', 'powerPoint', 'microsoftPowerPoint'],
  officeWord: ['officeWord', 'word', 'microsoftWord'],
  officeExcel: ['officeExcel', 'excel', 'microsoftExcel'],
  hancomWriter: ['hancomWriter', 'hangul', 'hwp'],
  hancomCell: ['hancomCell', 'hancell', 'hanCell', 'cell']
});

const PREPARATION_STATES = deepFreeze(['autoInstall', 'openOfficialInstaller', 'unavailable']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function conversionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function extensionInput(value) {
  if (!value || typeof value !== 'object') return value;
  return value.extension ?? value.name ?? value.fileName ?? value.filePath ?? value.path ?? '';
}

function normalizeExtension(value) {
  const input = extensionInput(value);
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withoutQuery = trimmed.split(/[?#]/, 1)[0];
  const baseName = withoutQuery.split(/[\\/]/).pop() || '';
  const lastDot = baseName.lastIndexOf('.');
  const candidate = lastDot >= 0 ? baseName.slice(lastDot + 1) : baseName;
  const normalized = candidate.trim().toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(normalized) ? normalized : '';
}

function getFormatMetadata(value) {
  return FORMAT_METADATA[normalizeExtension(value)] || null;
}

function getFormatLabel(value, includeExtension = true) {
  const metadata = getFormatMetadata(value);
  if (!metadata) return '';
  return includeExtension ? metadata.displayLabel : metadata.label;
}

function getGroupMetadata(value) {
  const metadata = getFormatMetadata(value);
  return metadata && SOURCE_GROUPS[metadata.group] ? SOURCE_GROUPS[metadata.group] : null;
}

function getTargetsForSource(value) {
  const sourceExtension = normalizeExtension(value);
  const metadata = FORMAT_METADATA[sourceExtension];
  if (!metadata?.source || !SOURCE_GROUPS[metadata.group]) return [];
  const targets = [...SOURCE_GROUPS[metadata.group].targetExtensions];
  if (metadata.group === 'text' && sourceExtension !== 'hwp' && sourceExtension !== 'hwpx') targets.splice(3, 0, 'docm');
  const excludedTargets = new Set(EXCLUDED_CONVERSION_TARGETS[sourceExtension] || []);
  return targets.filter((targetExtension) => targetExtension !== sourceExtension && !excludedTargets.has(targetExtension));
}

function routeCompatibilityNote(sourceExtension, targetExtension) {
  const group = FORMAT_METADATA[sourceExtension]?.group;
  const macroCapableExtensions = MACRO_CAPABLE_EXTENSIONS_BY_GROUP[group] || [];
  const notes = [];
  if (macroCapableExtensions.includes(sourceExtension) && !macroCapableExtensions.includes(targetExtension)) {
    notes.push(`.${sourceExtension} 원본에 매크로·자동화가 있다면 .${targetExtension} 결과에는 보존되지 않습니다.`);
  }

  const openDocumentExtensions = new Set(['odp', 'odt', 'ods']);
  if (openDocumentExtensions.has(sourceExtension) || openDocumentExtensions.has(targetExtension)) {
    notes.push('OpenDocument 형식을 오가는 변환은 프로그램별 기능 차이로 일부 전용 기능·개체·서식이 달라지거나 빠질 수 있습니다.');
  }

  const hancomText = new Set(['hwp', 'hwpx']);
  const microsoftText = new Set(['doc', 'docx', 'docm']);
  if ((hancomText.has(sourceExtension) && microsoftText.has(targetExtension))
    || (microsoftText.has(sourceExtension) && hancomText.has(targetExtension))) {
    notes.push('한컴 한글과 Microsoft Word 사이에서는 글맵시·도형·차트·수식·쪽 배치가 달라질 수 있습니다.');
  }

  const hancomSheets = new Set(['cell', 'nxl']);
  const microsoftSheets = new Set(['xls', 'xlsx', 'xlsm', 'xlsb']);
  if ((hancomSheets.has(sourceExtension) && microsoftSheets.has(targetExtension))
    || (microsoftSheets.has(sourceExtension) && hancomSheets.has(targetExtension))) {
    notes.push('한컴 한셀과 Microsoft Excel 사이에서는 함수·차트·피벗·조건부 서식이 달라지거나 빠질 수 있습니다.');
  }

  if (sourceExtension === 'rtf' || targetExtension === 'rtf') {
    notes.push(TARGET_COMPATIBILITY_NOTES.rtf);
  }
  if (sourceExtension === 'csv') {
    notes.push('CSV를 불러올 때 날짜·긴 번호·선행 0이 자동 변환될 수 있으므로 결과 값을 확인해야 합니다.');
  }
  if (targetExtension === 'csv') {
    notes.push(TARGET_COMPATIBILITY_NOTES.csv);
  }
  if (hancomSheets.has(sourceExtension)) {
    notes.push('CELL·NXL 원본의 한셀 매크로·VBA·자동화는 다른 파일 형식에 그대로 이전된다고 보장할 수 없습니다.');
  }

  const targetNote = TARGET_COMPATIBILITY_NOTES[targetExtension] || '';
  if (targetNote) notes.push(targetNote);
  return [...new Set(notes)].join(' ');
}

function getTargetMetadataForSource(value) {
  const sourceExtension = normalizeExtension(value);
  return getTargetsForSource(sourceExtension).map((extension) => Object.freeze({
    ...FORMAT_METADATA[extension],
    compatibilityNote: routeCompatibilityNote(sourceExtension, extension),
    route: selectConversionRoute(sourceExtension, extension)
  }));
}

function getCommonTargets(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const targetLists = values.map(getTargetsForSource);
  if (targetLists.some((targets) => targets.length === 0)) return [];
  const remaining = targetLists.slice(1).map((targets) => new Set(targets));
  return targetLists[0].filter((target) => remaining.every((targets) => targets.has(target)));
}

function engineForRoute(sourceExtension, targetExtension) {
  const group = FORMAT_METADATA[sourceExtension]?.group;
  if (group === 'text' && (
    sourceExtension === 'hwp' || sourceExtension === 'hwpx'
    || targetExtension === 'hwp' || targetExtension === 'hwpx'
  )) return 'hancomWriter';
  if (group === 'spreadsheet' && (
    sourceExtension === 'cell' || sourceExtension === 'nxl'
    || targetExtension === 'cell' || targetExtension === 'nxl'
  )) return 'hancomCell';
  if (group === 'presentation') return 'powerpoint';
  if (group === 'text') return 'word';
  if (group === 'spreadsheet') return 'excel';
  return '';
}

function compatibleFallbackFor(sourceExtension, targetExtension, engine) {
  const libreOffice = ['powerpoint', 'word', 'excel'].includes(engine);
  const rhwp = engine === 'hancomWriter' && (sourceExtension === 'hwp' || sourceExtension === 'hwpx') && (
    targetExtension === 'pdf' ||
    (sourceExtension === 'hwp' && targetExtension === 'hwpx') ||
    (sourceExtension === 'hwpx' && targetExtension === 'hwp')
  );
  return Object.freeze({ libreOffice, rhwp });
}

function selectConversionRoute(sourceValue, targetValue) {
  const sourceExtension = normalizeExtension(sourceValue);
  const targetExtension = normalizeExtension(targetValue);
  if (!getTargetsForSource(sourceExtension).includes(targetExtension)) return null;
  const engine = engineForRoute(sourceExtension, targetExtension);
  const requiredDependency = ENGINE_TO_DEPENDENCY[engine];
  if (!requiredDependency) return null;
  const compatibleFallback = compatibleFallbackFor(sourceExtension, targetExtension, engine);
  return Object.freeze({
    sourceExtension,
    targetExtension,
    sourceGroup: FORMAT_METADATA[sourceExtension].group,
    engine,
    requiredDependency,
    policy: 'strict',
    automaticFallback: false,
    compatibilityNote: routeCompatibilityNote(sourceExtension, targetExtension),
    compatibleFallback,
    compatibleFallbackIds: Object.freeze(Object.entries(compatibleFallback)
      .filter(([, compatible]) => compatible)
      .map(([id]) => id))
  });
}

function getConversionCatalog() {
  const sources = Object.values(FORMAT_METADATA)
    .filter((item) => item.source)
    .map((item) => Object.freeze({
      extension: item.extension,
      label: item.label,
      displayLabel: item.displayLabel,
      group: item.group,
      targets: Object.freeze(getTargetsForSource(item.extension)),
      targetMetadata: Object.freeze(getTargetMetadataForSource(item.extension).map((target) => Object.freeze({
        extension: target.extension,
        label: target.label,
        displayLabel: target.displayLabel,
        compatibilityNote: target.compatibilityNote,
        engine: target.route.engine,
        requiredDependency: target.route.requiredDependency
      })))
    }));
  return deepFreeze({
    sources,
    outputs: [...OUTPUT_EXTENSION_SET].map((extension) => ({
      extension,
      label: FORMAT_METADATA[extension].label,
      displayLabel: FORMAT_METADATA[extension].displayLabel,
      compatibilityNote: TARGET_COMPATIBILITY_NOTES[extension] || ''
    }))
  });
}

function normalizeDependencyId(value) {
  const requested = String(value || '').trim().toLowerCase();
  if (!requested) return '';
  for (const [dependencyId, aliases] of Object.entries(DEPENDENCY_ALIASES)) {
    if ([dependencyId, ...aliases].some((alias) => alias.toLowerCase() === requested)) return dependencyId;
  }
  return '';
}

function normalizePreparation(value) {
  const requested = String(value || '').trim().toLowerCase();
  return PREPARATION_STATES.find((state) => state.toLowerCase() === requested) || '';
}

function findCapabilityValue(capabilities, dependencyId) {
  const aliases = DEPENDENCY_ALIASES[dependencyId] || [dependencyId];
  const containers = [];
  if (capabilities && typeof capabilities === 'object') {
    containers.push(capabilities.dependencies, capabilities.engines, capabilities);
  }

  for (const container of containers) {
    if (!container) continue;
    if (container instanceof Map) {
      for (const alias of aliases) if (container.has(alias)) return { found: true, value: container.get(alias) };
      continue;
    }
    if (container instanceof Set) {
      for (const alias of aliases) if (container.has(alias)) return { found: true, value: true };
      continue;
    }
    if (Array.isArray(container)) {
      for (const item of container) {
        if (typeof item === 'string' && aliases.some((alias) => alias.toLowerCase() === item.toLowerCase())) {
          return { found: true, value: true };
        }
        if (item && typeof item === 'object') {
          const itemId = item.id ?? item.dependencyId ?? item.engine;
          if (aliases.some((alias) => alias.toLowerCase() === String(itemId || '').toLowerCase())) {
            return { found: true, value: item };
          }
        }
      }
      continue;
    }
    if (typeof container === 'object') {
      for (const alias of aliases) {
        if (Object.prototype.hasOwnProperty.call(container, alias)) return { found: true, value: container[alias] };
      }
    }
  }
  return { found: false, value: undefined };
}

function capabilityValueAvailable(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['', 'false', 'missing', 'blocked', 'unavailable', 'not-installed'].includes(normalized)) return false;
    return true;
  }
  if (!value || typeof value !== 'object') return false;
  for (const key of ['available', 'installed', 'registered', 'detected', 'present', 'enabled']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return Boolean(value[key]);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'blocked')) return !Boolean(value.blocked);
  if (typeof value.status === 'string') {
    return ['ready', 'available', 'installed', 'detected'].includes(value.status.trim().toLowerCase());
  }
  return Boolean(String(value.path || value.executablePath || '').trim());
}

function capabilityPreparation(capabilities, dependencyId, rawValue) {
  const direct = rawValue && typeof rawValue === 'object'
    ? normalizePreparation(rawValue.preparation ?? rawValue.prepare ?? rawValue.action)
    : '';
  if (direct) return direct;
  if (rawValue && typeof rawValue === 'object') {
    if (rawValue.autoInstall === true || rawValue.canAutoInstall === true) return 'autoInstall';
    if (rawValue.openOfficialInstaller === true || rawValue.canOpenOfficialInstaller === true || rawValue.officialInstaller === true) {
      return 'openOfficialInstaller';
    }
  }
  const preparationContainer = capabilities?.preparation ?? capabilities?.preparations;
  if (preparationContainer && typeof preparationContainer === 'object') {
    for (const alias of DEPENDENCY_ALIASES[dependencyId] || [dependencyId]) {
      const normalized = normalizePreparation(preparationContainer[alias]);
      if (normalized) return normalized;
    }
  }
  return 'unavailable';
}

function getDependencyAvailability(dependencyValue, capabilities = {}) {
  const dependencyId = normalizeDependencyId(dependencyValue);
  if (!dependencyId) return null;
  const found = findCapabilityValue(capabilities, dependencyId);
  const available = found.found && capabilityValueAvailable(found.value);
  return Object.freeze({
    dependencyId,
    engine: DEPENDENCY_METADATA[dependencyId].engine,
    label: DEPENDENCY_METADATA[dependencyId].label,
    available,
    blocked: !available,
    preparation: available ? null : capabilityPreparation(capabilities, dependencyId, found.value)
  });
}

function getCapabilityAvailability(capabilities = {}) {
  return Object.freeze(Object.fromEntries(Object.keys(DEPENDENCY_METADATA).map((dependencyId) => [
    dependencyId,
    getDependencyAvailability(dependencyId, capabilities)
  ])));
}

function isEngineAvailable(engineOrDependency, capabilities = {}) {
  const requested = String(engineOrDependency || '').trim();
  const dependencyId = normalizeDependencyId(requested) || ENGINE_TO_DEPENDENCY[requested];
  return dependencyId ? getDependencyAvailability(dependencyId, capabilities).available : false;
}

function unsupportedAvailability() {
  return Object.freeze({
    supported: false,
    available: false,
    blocked: true,
    preparation: 'unavailable',
    requiredDependency: null,
    route: null
  });
}

function getConversionAvailability(sourceValue, targetValue, capabilities = {}) {
  const route = selectConversionRoute(sourceValue, targetValue);
  if (!route) return unsupportedAvailability();
  const dependency = getDependencyAvailability(route.requiredDependency, capabilities);
  return Object.freeze({
    supported: true,
    available: dependency.available,
    blocked: dependency.blocked,
    preparation: dependency.preparation,
    requiredDependency: route.requiredDependency,
    dependency,
    route
  });
}

function aggregatePreparation(missingDependencies) {
  if (!missingDependencies.length) return null;
  if (missingDependencies.some((item) => item.preparation === 'unavailable')) return 'unavailable';
  if (missingDependencies.some((item) => item.preparation === 'openOfficialInstaller')) return 'openOfficialInstaller';
  return 'autoInstall';
}

function getBatchConversionAvailability(sourceValues, targetValue, capabilities = {}) {
  const sources = Array.isArray(sourceValues) ? sourceValues : [];
  const targetExtension = normalizeExtension(targetValue);
  if (!sources.length || !getCommonTargets(sources).includes(targetExtension)) {
    return Object.freeze({
      supported: false,
      available: false,
      blocked: true,
      preparation: 'unavailable',
      targetExtension,
      routes: Object.freeze([]),
      requiredDependencies: Object.freeze([]),
      missingDependencies: Object.freeze([])
    });
  }
  const routes = sources.map((source) => selectConversionRoute(source, targetExtension));
  const requiredDependencies = [...new Set(routes.map((route) => route.requiredDependency))];
  const dependencyStatuses = requiredDependencies.map((dependencyId) => getDependencyAvailability(dependencyId, capabilities));
  const missingDependencies = dependencyStatuses.filter((item) => item.blocked);
  return Object.freeze({
    supported: true,
    available: missingDependencies.length === 0,
    blocked: missingDependencies.length > 0,
    preparation: aggregatePreparation(missingDependencies),
    targetExtension,
    routes: Object.freeze(routes),
    requiredDependencies: Object.freeze(requiredDependencies),
    missingDependencies: Object.freeze(missingDependencies)
  });
}

function safeOutputExtension(targetValue, sourceValue) {
  const targetExtension = normalizeExtension(targetValue);
  if (!OUTPUT_EXTENSION_SET.has(targetExtension)) {
    throw conversionError('DOCUMENT_CONVERSION_TARGET_INVALID', '저장할 문서 형식이 올바르지 않습니다.');
  }
  if (arguments.length > 1 && sourceValue != null && sourceValue !== '') {
    const route = selectConversionRoute(sourceValue, targetExtension);
    if (!route) {
      throw conversionError('DOCUMENT_CONVERSION_ROUTE_UNSUPPORTED', '원본에서 선택한 형식으로는 변환할 수 없습니다.');
    }
  }
  return targetExtension;
}

function safeRouteOutputExtension(sourceValue, targetValue) {
  return safeOutputExtension(targetValue, sourceValue);
}

module.exports = {
  SOURCE_GROUPS,
  FORMAT_METADATA,
  FORMAT_REGISTRY: FORMAT_METADATA,
  DEPENDENCY_METADATA,
  DEPENDENCY_IDS: Object.freeze(Object.keys(DEPENDENCY_METADATA)),
  PREPARATION_STATES,
  TARGET_COMPATIBILITY_NOTES,
  normalizeExtension,
  getFormatMetadata,
  getFormatLabel,
  getGroupMetadata,
  getTargetsForSource,
  getTargetMetadataForSource,
  getCommonTargets,
  getConversionCatalog,
  selectConversionRoute,
  normalizeDependencyId,
  getDependencyAvailability,
  getCapabilityAvailability,
  isEngineAvailable,
  getConversionAvailability,
  getBatchConversionAvailability,
  safeOutputExtension,
  safeRouteOutputExtension
};
