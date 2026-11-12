(function exposeDocumentToolsUI(root) {
  'use strict';

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const api = () => root.workspaceDesktop;
  const RosterCore = root.CertificateRosterCore;

  const converter = {
    files: [],
    outputToken: '',
    outputName: '',
    requestId: '',
    running: false,
    cancelling: false,
    preparing: false,
    routeChecking: false,
    capabilities: null,
    sourceExtension: '',
    targetExtension: '',
    targetExtensions: [],
    targetMetadata: [],
    availability: null,
    preparationPlan: null,
    requiredFonts: [],
    fontReports: [],
    inspectionUnavailable: [],
    requiresPreview: false,
    routes: []
  };
  const DEFAULT_DOCUMENT_FORMAT_LABELS = Object.freeze({
    pdf: 'PDF 문서', ppt: 'PowerPoint 97-2003 프레젠테이션', pptx: 'PowerPoint 프레젠테이션', pptm: 'PowerPoint 매크로 프레젠테이션', odp: 'OpenDocument 프레젠테이션',
    doc: 'Word 97-2003 문서', docx: 'Word 문서', docm: 'Word 매크로 문서', odt: 'OpenDocument 텍스트', rtf: '서식 있는 텍스트',
    hwp: '한글 문서', hwpx: '한글 표준 문서', xls: 'Excel 97-2003 통합 문서', xlsx: 'Excel 통합 문서', xlsm: 'Excel 매크로 통합 문서',
    xlsb: 'Excel 바이너리 통합 문서', ods: 'OpenDocument 스프레드시트', csv: 'CSV 데이터', cell: '한셀 문서', nxl: '넥셀 문서'
  });
  // These are CMOE-owned file-format lettermarks, not copied vendor logos.
  // Keeping one compact visual vocabulary makes long conversion lists easier
  // to scan without adding trademark artwork or another runtime dependency.
  const DOCUMENT_FORMAT_VISUALS = Object.freeze({
    pdf: Object.freeze({ mark: 'PDF', family: 'pdf' }),
    ppt: Object.freeze({ mark: 'P', family: 'powerpoint' }),
    pptx: Object.freeze({ mark: 'P', family: 'powerpoint' }),
    pptm: Object.freeze({ mark: 'P', family: 'powerpoint' }),
    odp: Object.freeze({ mark: 'ODP', family: 'open-presentation' }),
    doc: Object.freeze({ mark: 'W', family: 'word' }),
    docx: Object.freeze({ mark: 'W', family: 'word' }),
    docm: Object.freeze({ mark: 'W', family: 'word' }),
    odt: Object.freeze({ mark: 'ODT', family: 'open-text' }),
    rtf: Object.freeze({ mark: 'R', family: 'word' }),
    hwp: Object.freeze({ mark: '한', family: 'hangul' }),
    hwpx: Object.freeze({ mark: '한', family: 'hangul' }),
    xls: Object.freeze({ mark: 'X', family: 'excel' }),
    xlsx: Object.freeze({ mark: 'X', family: 'excel' }),
    xlsm: Object.freeze({ mark: 'X', family: 'excel' }),
    xlsb: Object.freeze({ mark: 'X', family: 'excel' }),
    ods: Object.freeze({ mark: 'ODS', family: 'open-sheet' }),
    csv: Object.freeze({ mark: 'CSV', family: 'csv' }),
    cell: Object.freeze({ mark: '셀', family: 'hancell' }),
    nxl: Object.freeze({ mark: '셀', family: 'hancell' })
  });
  const DOCUMENT_APPLICATION_VISUALS = Object.freeze({
    officePowerPoint: 'powerpoint',
    officeWord: 'word',
    officeExcel: 'excel',
    hancomWriter: 'hangul',
    hancomCell: 'hancell',
    libreOffice: 'libreoffice',
    rhwp: 'hangul'
  });
  const DOCUMENT_APPLICATION_MARKS = Object.freeze({
    powerpoint: 'P',
    word: 'W',
    excel: 'X',
    hangul: '한',
    hancell: '셀',
    libreoffice: 'LO'
  });
  const DEFAULT_TARGET_COMPATIBILITY_NOTES = Object.freeze({
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
  const DEFAULT_SOURCE_GROUPS = Object.freeze([
    Object.freeze({ id: 'presentation', sources: Object.freeze(['ppt', 'pptx', 'pptm', 'odp']), targets: Object.freeze(['pdf', 'ppt', 'pptx', 'pptm', 'odp']) }),
    Object.freeze({ id: 'text', sources: Object.freeze(['hwp', 'hwpx', 'doc', 'docx', 'docm', 'odt', 'rtf']), targets: Object.freeze(['pdf', 'doc', 'docx', 'odt', 'rtf', 'hwp', 'hwpx']) }),
    Object.freeze({ id: 'spreadsheet', sources: Object.freeze(['cell', 'nxl', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv']), targets: Object.freeze(['pdf', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'cell', 'nxl']) })
  ]);
  const DEFAULT_EXCLUDED_CONVERSION_TARGETS = Object.freeze({
    hwp: Object.freeze(['doc']),
    hwpx: Object.freeze(['doc']),
    docm: Object.freeze(['hwp', 'hwpx']),
    xlsb: Object.freeze(['cell', 'nxl'])
  });
  function createDefaultSourceTargets() {
    return Object.freeze(Object.fromEntries(DEFAULT_SOURCE_GROUPS.flatMap((group) => group.sources.map((source) => {
      const targets = [...group.targets];
      if (group.id === 'text' && !['hwp', 'hwpx'].includes(source)) targets.splice(3, 0, 'docm');
      const excluded = new Set(DEFAULT_EXCLUDED_CONVERSION_TARGETS[source] || []);
      return [source, Object.freeze(targets.filter((target, index, items) => target !== source && !excluded.has(target) && items.indexOf(target) === index))];
    }))));
  }
  function defaultRouteCompatibilityNote(sourceExtension, targetExtension) {
    const group = DEFAULT_SOURCE_GROUPS.find((item) => item.sources.includes(sourceExtension))?.id || '';
    const macroSources = {
      presentation: ['ppt', 'pptm'],
      text: ['doc', 'docm'],
      spreadsheet: ['xls', 'xlsm', 'xlsb']
    };
    const macroTargets = {
      presentation: ['ppt', 'pptm'],
      text: ['doc', 'docm'],
      spreadsheet: ['xls', 'xlsm', 'xlsb']
    };
    const notes = [];
    if (macroSources[group]?.includes(sourceExtension) && !macroTargets[group]?.includes(targetExtension)) {
      notes.push(`.${sourceExtension} 원본에 매크로·자동화가 있다면 .${targetExtension} 결과에는 보존되지 않습니다.`);
    }
    if (['odp', 'odt', 'ods'].includes(sourceExtension) || ['odp', 'odt', 'ods'].includes(targetExtension)) {
      notes.push('OpenDocument 형식을 오가는 변환은 프로그램별 기능 차이로 일부 전용 기능·개체·서식이 달라지거나 빠질 수 있습니다.');
    }
    if ((['hwp', 'hwpx'].includes(sourceExtension) && ['doc', 'docx', 'docm'].includes(targetExtension))
      || (['doc', 'docx', 'docm'].includes(sourceExtension) && ['hwp', 'hwpx'].includes(targetExtension))) {
      notes.push('한컴 한글과 Microsoft Word 사이에서는 글맵시·도형·차트·수식·쪽 배치가 달라질 수 있습니다.');
    }
    if ((['cell', 'nxl'].includes(sourceExtension) && ['xls', 'xlsx', 'xlsm', 'xlsb'].includes(targetExtension))
      || (['xls', 'xlsx', 'xlsm', 'xlsb'].includes(sourceExtension) && ['cell', 'nxl'].includes(targetExtension))) {
      notes.push('한컴 한셀과 Microsoft Excel 사이에서는 함수·차트·피벗·조건부 서식이 달라지거나 빠질 수 있습니다.');
    }
    if (sourceExtension === 'rtf' || targetExtension === 'rtf') notes.push(DEFAULT_TARGET_COMPATIBILITY_NOTES.rtf);
    if (sourceExtension === 'csv') {
      notes.push('CSV를 불러올 때 날짜·긴 번호·선행 0이 자동 변환될 수 있으므로 결과 값을 확인해야 합니다.');
    }
    if (targetExtension === 'csv') notes.push(DEFAULT_TARGET_COMPATIBILITY_NOTES.csv);
    if (['cell', 'nxl'].includes(sourceExtension)) {
      notes.push('CELL·NXL 원본의 한셀 매크로·VBA·자동화는 다른 파일 형식에 그대로 이전된다고 보장할 수 없습니다.');
    }
    const targetNote = DEFAULT_TARGET_COMPATIBILITY_NOTES[targetExtension] || '';
    if (targetNote) notes.push(targetNote);
    return [...new Set(notes)].join(' ');
  }
  function createDefaultOutputMetadata() {
    return Object.freeze(Object.fromEntries(Object.entries(DEFAULT_DOCUMENT_FORMAT_LABELS).map(([extension, label]) => [
      extension,
      Object.freeze({ extension, label, compatibilityNote: DEFAULT_TARGET_COMPATIBILITY_NOTES[extension] || '' })
    ])));
  }
  function createDefaultRouteMetadata(sourceTargets) {
    return Object.freeze(Object.fromEntries(Object.entries(sourceTargets).map(([sourceExtension, targets]) => [
      sourceExtension,
      Object.freeze(Object.fromEntries(targets.map((targetExtension) => [
        targetExtension,
        Object.freeze({
          extension: targetExtension,
          label: DEFAULT_DOCUMENT_FORMAT_LABELS[targetExtension] || targetExtension.toUpperCase(),
          compatibilityNote: defaultRouteCompatibilityNote(sourceExtension, targetExtension)
        })
      ])))
    ])));
  }
  let documentFormatLabels = { ...DEFAULT_DOCUMENT_FORMAT_LABELS };
  let conversionSourceTargets = createDefaultSourceTargets();
  let conversionOutputMetadata = createDefaultOutputMetadata();
  let conversionRouteMetadata = createDefaultRouteMetadata(conversionSourceTargets);
  let conversionCatalogSignature = '';
  const DOCUMENT_MODE_META = Object.freeze({
    pptxPdf: { panel: 'pptxPdf' },
    certificateMaker: { panel: 'certificateMaker' },
    documentSplit: { panel: 'documentSplit' },
    excelDeduplicate: { panel: 'excelDeduplicate' },
    pdfMerge: { panel: 'documentMerge', kind: 'pdf', extension: '.pdf', label: 'PDF', unit: '쪽', countKey: 'pageCount', defaultName: '합친 PDF' },
    pptxMerge: { panel: 'documentMerge', kind: 'pptx', extension: '.pptx', label: 'PowerPoint', unit: '슬라이드', countKey: 'slideCount', defaultName: '합친 프레젠테이션' },
    wordMerge: { panel: 'documentMerge', kind: 'word', extension: '.docx', label: 'Word', unit: '쪽', countKey: 'pageCount', defaultName: '합친 Word 문서' },
    excelMerge: { panel: 'documentMerge', kind: 'excel', extension: '.xlsx', label: 'Excel', unit: '시트', countKey: 'sheetCount', defaultName: '합친 Excel 파일' },
    documentPdfMerge: { panel: 'documentMerge', kind: 'documents', extension: '.pdf', label: '여러 문서', unit: '쪽', countKey: 'pageCount', defaultName: '합친 문서' }
  });
  const emptyMergeState = (resultName) => ({
    files: [], outputToken: '', outputName: '', outputFileToken: '', resultName, requestId: '', running: false, cancelling: false, preparing: false, inspecting: false, inspectionGeneration: 0,
    completed: false, outcome: '', runTitle: '합치기 준비', runStatus: '파일과 저장 폴더를 준비해주세요.', progressValue: 0, progressVisible: false, dragIndex: -1,
    availability: null, preparationPlan: null, requiredDependencies: [], missingDependencies: [], runningDependencies: [], requiredFonts: [], fontReports: [],
    inspectionUnavailable: [], compatibilityInputs: [], requiresPreview: false, engine: '', compatibilityFallback: false, fallbackSupported: false, fallbackUnsupportedReasons: [], warnings: [], contentVerified: false, lastProgressEngine: '', lastProgressPhase: '', lastProgressIndex: -1,
    internalFallbackSuggested: false, internalFallbackPrompted: false, internalFallbackReason: '', internalFallback: false,
    baseStrategy: '', resultPageCount: 0, resultSectionCount: 0, headerFooterLinksDetached: 0, headerFooterLinkFailures: 0, resultSheetCount: 0, resultSheetNames: [], resultSheetTypes: [], resultSheetVisibility: [], sourcePageCounts: [], sourceSheetCounts: []
  });
  const mergeStates = {
    pdfMerge: emptyMergeState('합친 PDF'),
    pptxMerge: emptyMergeState('합친 프레젠테이션'),
    wordMerge: emptyMergeState('합친 Word 문서'),
    excelMerge: {
      ...emptyMergeState('합친 Excel 파일'),
      useFileNameAsSheetName: false,
      addCombinedSheet: false,
      combinedSheetRequestedName: '전체 통합',
      combinedSheetAdded: false,
      combinedSheetName: '',
      combinedRowCount: 0,
      combinedColumnCount: 0
    },
    documentPdfMerge: emptyMergeState('합친 문서')
  };
  const DOCUMENT_SPLIT_META = Object.freeze({
    pdf: Object.freeze({ kind: 'pdf', extension: '.pdf', label: 'PDF', unit: '쪽', countKey: 'pageCount' }),
    pptx: Object.freeze({ kind: 'pptx', extension: '.pptx', label: 'PowerPoint', unit: '슬라이드', countKey: 'slideCount' })
  });
  let splitGroupSequence = 0;
  function createSplitGroup(values = {}) {
    splitGroupSequence += 1;
    return { id: String(values.id || `split-group-${splitGroupSequence}`), pages: String(values.pages || ''), name: String(values.name || '') };
  }
  const emptySplitState = () => ({
    file: null, method: 'equal', equalSize: 2, groups: [createSplitGroup(), createSplitGroup()], outputToken: '', outputName: '', requestId: '',
    running: false, cancelling: false, confirming: false, completed: false, outcome: '', results: [], runTitle: '나누기 준비',
    runStatus: '파일, 나누는 방법, 저장 폴더를 준비해주세요.', progressValue: 0, progressVisible: false,
    engine: '', compatibilityFallback: false, requiresPreview: false, warnings: []
  });
  const splitStates = { pdf: emptySplitState(), pptx: emptySplitState() };
  const excelDedupe = {
    file: null, selectedSheetIndexes: [], outputToken: '', outputName: '', resultName: '중복 제거 결과',
    criteriaMode: 'all', columnIndexesBySheet: {}, criteriaDirty: false, criteriaAnalyzing: false, criteriaError: '', criteriaSequence: 0,
    requestId: '', analyzing: false, running: false, completed: false, result: null, outcome: '',
    review: null, reviewLoading: false, reviewSheetIndex: -1, activeReviewGroupId: '', mergeMissingValues: true,
    preferredRowsByGroup: {}, cellSourceRowsByGroup: {}, customValuesByGroup: {}, reviewedGroupIds: [], approvedGroupIds: [], activeColumnSheetIndex: 0
  };
  let excelDedupeCriteriaTimer = 0;
  let excelCompareRuleSequence = 0;
  const createExcelCompareRule = (values = {}) => ({
    id: String(values.id || `excel-compare-rule-${++excelCompareRuleSequence}`), source: ['key', 'a', 'b'].includes(values.source) ? values.source : 'key',
    columnIndex: Number(values.columnIndex) || 0, contains: String(values.contains || ''), groupName: String(values.groupName || '')
  });
  const excelCompare = {
    files: { a: null, b: null }, selections: { a: { sheetIndex: 0, headerRow: 1, keyColumn: 0 }, b: { sheetIndex: 0, headerRow: 1, keyColumn: 0 } },
    rules: [createExcelCompareRule()], outputToken: '', outputName: '', resultName: 'Excel 비교 분류 결과',
    analyzing: false, running: false, requestId: '', plan: null, planSignature: '', result: null, completed: false, outcome: ''
  };
  let excelCleanupTask = 'deduplicate';
  let documentSplitKind = 'pdf';
  let documentMode = 'pptxPdf';
  let conversionTargetRefreshSequence = 0;

  // Keep every renderer-to-preload assumption here so the backend bridge can change
  // without spreading Electron-specific method names through the UI.
  const DOCUMENT_MERGE_BRIDGE = Object.freeze({
    names: Object.freeze({
      chooseFiles: ['chooseDocumentMergeFiles'],
      inspectFiles: ['inspectDocumentMergeFiles'],
      chooseOutput: ['chooseDocumentOutputDirectory'],
      mergeFiles: ['mergeDocumentFiles'],
      openOutput: ['openDocumentOutputDirectory'],
      openFile: ['openDocumentOutputFile'],
      cancel: ['cancelDocumentToolJob']
    }),
    method(name, optional = false) {
      const desktop = api();
      const methodName = this.names[name].find((candidate) => typeof desktop?.[candidate] === 'function');
      if (methodName) return desktop[methodName].bind(desktop);
      if (optional) return null;
      throw new Error('현재 설치본에는 파일 합치기 기능이 연결되어 있지 않습니다. 앱을 최신 버전으로 다시 설치해주세요.');
    },
    chooseFiles(kind) { return this.method('chooseFiles')({ kind }); },
    inspectFiles(kind, fileTokens) {
      const inspect = this.method('inspectFiles', true);
      return inspect ? inspect({ kind, fileTokens }) : Promise.resolve(null);
    },
    chooseOutput() { return this.method('chooseOutput')(); },
    mergeFiles(payload) { return this.method('mergeFiles')(payload); },
    openOutput(outputToken) { return this.method('openOutput')(outputToken); },
    openFile(outputFileToken) { return this.method('openFile')(outputFileToken); },
    cancel(requestId) { return this.method('cancel')(requestId); }
  });
  const DOCUMENT_SPLIT_BRIDGE = Object.freeze({
    names: Object.freeze({
      chooseFile: ['chooseDocumentSplitFile'],
      chooseOutput: ['chooseDocumentOutputDirectory'],
      splitFile: ['splitDocumentFile'],
      openOutput: ['openDocumentOutputDirectory'],
      openFile: ['openDocumentOutputFile'],
      cancel: ['cancelDocumentToolJob']
    }),
    method(name) {
      const desktop = api();
      const methodName = this.names[name].find((candidate) => typeof desktop?.[candidate] === 'function');
      if (methodName) return desktop[methodName].bind(desktop);
      throw new Error('현재 설치본에는 파일 나누기 기능이 연결되어 있지 않습니다. 앱을 최신 버전으로 다시 설치해주세요.');
    },
    chooseFile(kind) { return this.method('chooseFile')({ kind }); },
    chooseOutput() { return this.method('chooseOutput')(); },
    splitFile(payload) { return this.method('splitFile')(payload); },
    openOutput(outputToken) { return this.method('openOutput')(outputToken); },
    openFile(outputFileToken) { return this.method('openFile')(outputFileToken); },
    cancel(requestId) { return this.method('cancel')(requestId); }
  });
  const DOCUMENT_CONVERSION_BRIDGE = Object.freeze({
    names: Object.freeze({
      chooseFiles: ['chooseDocumentConversionFiles', 'chooseDocumentFiles', 'choosePptxFiles'],
      targets: ['getDocumentConversionTargets'],
      convert: ['convertDocumentBatch', 'convertPptxBatch'],
      prepare: ['prepareDocumentDependencies'],
      installFontFile: ['chooseAndInstallDocumentFont']
    }),
    method(name, optional = false) {
      const desktop = api();
      const methodName = this.names[name].find((candidate) => typeof desktop?.[candidate] === 'function');
      if (methodName) return { methodName, invoke: desktop[methodName].bind(desktop) };
      if (optional) return null;
      throw new Error('현재 설치본에는 범용 문서 변환 기능이 연결되어 있지 않습니다. 앱을 최신 버전으로 다시 설치해주세요.');
    },
    chooseFiles(sourceExtensions = []) {
      const bridge = this.method('chooseFiles');
      const normalized = [...new Set((sourceExtensions || []).map(normalizeDocumentExtension).filter(Boolean))];
      return bridge.methodName === 'chooseDocumentConversionFiles'
        ? bridge.invoke(normalized.length ? { sourceExtensions: normalized } : {})
        : bridge.invoke();
    },
    targets(payload) {
      const bridge = this.method('targets', true);
      return bridge ? bridge.invoke(payload) : Promise.resolve(null);
    },
    convert(payload) {
      const bridge = this.method('convert');
      return bridge.methodName === 'convertPptxBatch'
        ? bridge.invoke({ requestId: payload.requestId, fileTokens: payload.fileTokens, outputToken: payload.outputToken })
        : bridge.invoke(payload);
    },
    prepare(payload) {
      const bridge = this.method('prepare', true);
      if (!bridge) throw new Error('현재 설치본에는 자동 준비 기능이 연결되어 있지 않습니다.');
      return bridge.invoke(payload);
    },
    installFontFile(payload) {
      return this.method('installFontFile').invoke(payload);
    }
  });
  const certificate = {
    template: null,
    fields: [],
    rows: [],
    slideNumber: 1,
    templatePreviewUrl: '',
    previewCache: {},
    previewCacheOrder: [],
    slideDrafts: {},
    showHiddenBlocks: false,
    currentRow: 0,
    filenameTemplate: '{A}',
    outputToken: '',
    outputName: '',
    running: false,
    cancelling: false,
    successfulIndexes: [],
    requestId: '',
    capabilities: null,
    certificatePdfReadiness: null,
    preparationPlan: null,
    preparing: false,
    profiles: [],
    selection: { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 },
    dragging: false,
    history: [],
    redo: [],
    editBaseline: null,
    previewing: false,
    templatePreviewSequence: 0,
    rowPreviewSequence: 0,
    preserveSelectionOnFocus: false,
    textRangeSelection: { blockId: '', start: 0, end: 0 },
    rosterImport: null,
    initialized: false
  };
  const rosterPicker = { catalog: null, selected: null, mappings: [], rows: [], loading: false, sequence: 0 };
  const guideDemo = { active: false, kind: '', snapshot: null };

  let callbacks = {};
  let progressUnsubscribe = null;
  let certificateContextOrigin = null;
  let capabilityRefreshPending = false;
  let certificateOverlayResizeObserver = null;
  let certificateOverlayResizeFrame = 0;

  function element(tagName, className = '', text = '') {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  }

  function documentFormatVisual(extension, options = {}) {
    if (options.automatic === true) return { extension: 'auto', mark: '↕', family: 'auto' };
    const normalized = normalizeDocumentExtension(extension);
    return {
      extension: normalized || 'document',
      ...(DOCUMENT_FORMAT_VISUALS[normalized] || {
        mark: (normalized || '문서').toUpperCase().slice(0, 3),
        family: 'generic'
      })
    };
  }

  function setDocumentFormatMark(node, extension, options = {}) {
    if (!node) return node;
    const visual = documentFormatVisual(extension, options);
    node.className = `document-format-mark document-format-mark-${visual.family}${options.className ? ` ${options.className}` : ''}`;
    node.dataset.documentFormatIcon = visual.extension;
    node.textContent = visual.mark;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function createDocumentFormatMark(extension, options = {}) {
    return setDocumentFormatMark(element('span'), extension, options);
  }

  function conversionApplicationVisual() {
    const dependencies = [...new Set([
      ...converter.routes.map((route) => String(route?.requiredDependency || '')),
      ...(converter.availability?.missingDependencies || []).map((item) => String(item?.dependencyId || item?.id || item || ''))
    ].filter(Boolean))].map((dependency) => DOCUMENT_APPLICATION_VISUALS[dependency]).filter(Boolean);
    return [...new Set(dependencies)].length === 1 ? dependencies[0] : '';
  }

  function setEngineBadgeApplication(badge, application = '') {
    if (!badge) return;
    if (application) badge.dataset.documentApp = application;
    else delete badge.dataset.documentApp;
  }

  function setEngineBadgeText(badge, text) {
    if (!badge) return;
    const label = String(text || '');
    const application = String(badge.dataset.documentApp || '');
    const mark = DOCUMENT_APPLICATION_MARKS[application];
    badge.replaceChildren();
    if (mark) {
      const markNode = element('span', `document-application-mark document-application-mark-${application}`, mark);
      markNode.setAttribute('aria-hidden', 'true');
      badge.append(markNode);
    }
    badge.append(document.createTextNode(label));
    badge.setAttribute('aria-label', label);
  }

  function notify(message, tone = 'normal') {
    if (typeof callbacks.showToast === 'function') callbacks.showToast(message, tone);
  }

  function isDocumentToolCancellation(error) {
    return error?.code === 'DOCUMENT_TOOL_CANCELLED' || /문서 작업을 중단했습니다|DOCUMENT_TOOL_CANCELLED/.test(String(error?.message || ''));
  }

  function confirmAction(message, options = {}) {
    if (typeof callbacks.confirm === 'function') return callbacks.confirm(message, options);
    return Promise.resolve(root.confirm(message));
  }

  function requestName(title, initialValue) {
    if (typeof callbacks.requestName === 'function') return callbacks.requestName(title, initialValue);
    return Promise.resolve(root.prompt(title, initialValue) || '');
  }

  function reportWorkflowStatus(moduleId, status, summary, details = {}) {
    if (typeof callbacks.updateWorkflowStatus !== 'function') return;
    Promise.resolve(callbacks.updateWorkflowStatus(moduleId, status, summary, details)).catch(() => {});
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value}B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  }

  function columnName(index) {
    let result = ''; let value = Number(index) + 1;
    while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
    return result;
  }

  function columnIndexFromName(value) {
    const token = String(value || '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(token)) return -1;
    let result = 0;
    for (const character of token) result = result * 26 + character.charCodeAt(0) - 64;
    return result - 1;
  }

  function safeCertificateFilenameStem(value, fallback = '파일') {
    let stem = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
    stem = stem.replace(/\s+/g, ' ').slice(0, 120);
    if (!stem || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(stem)) stem = fallback;
    return stem;
  }

  function certificateFilenameLabels() {
    const counts = new Map();
    certificate.fields.forEach((field) => {
      const label = String(field.label || '').trim();
      if (label) counts.set(label, (counts.get(label) || 0) + 1);
    });
    return counts;
  }

  function evaluateCertificateFilenameTemplate(template, row = null, rowNumber = 1) {
    const source = String(template ?? '').trim();
    if (!source) return { ok: false, error: '파일 이름 규칙을 입력해주세요.', stem: '' };
    const pattern = /\{([^{}\r\n]+)\}/g;
    const matches = [...source.matchAll(pattern)];
    if (/[{}]/.test(source.replace(pattern, ''))) return { ok: false, error: '파일 이름 규칙의 중괄호를 확인해주세요. 예: {A} 또는 {이름}', stem: '' };
    const labels = certificateFilenameLabels();
    const values = row?.values || [];
    const resolved = new Map();
    for (const match of matches) {
      const token = String(match[1] || '').trim();
      if (!token) return { ok: false, error: '빈 파일 이름 변수는 사용할 수 없습니다.', stem: '' };
      if (resolved.has(token)) continue;
      const letterIndex = columnIndexFromName(token);
      if (letterIndex >= 0) {
        if (letterIndex >= certificate.fields.length) return { ok: false, error: `표에 없는 열입니다: {${token}}`, stem: '' };
        resolved.set(token, String(values[letterIndex] ?? ''));
        continue;
      }
      if (!labels.has(token)) return { ok: false, error: `표에 없는 열 이름입니다: {${token}}`, stem: '' };
      if (labels.get(token) > 1) return { ok: false, error: `“${token}” 열 이름이 중복됩니다. {A}, {B}처럼 열 문자를 사용해주세요.`, stem: '' };
      const index = certificate.fields.findIndex((field) => String(field.label || '').trim() === token);
      resolved.set(token, String(values[index] ?? ''));
    }
    const rendered = source.replace(pattern, (_whole, rawToken) => resolved.get(String(rawToken || '').trim()) ?? '');
    const withoutAutomaticExtension = rendered.replace(/\.(?:pdf|pptx)[. ]*$/i, '');
    return { ok: true, error: '', stem: safeCertificateFilenameStem(withoutAutomaticExtension, `문서-${String(rowNumber).padStart(3, '0')}`), tokens: [...resolved.keys()] };
  }

  function engineCopy(status) {
    if (status?.engine === 'guide') return { label: '가이드 변환 환경', className: 'ready', detail: '실제 파일을 열거나 쓰지 않고 전체 흐름을 연습합니다.' };
    if (status?.engine === 'powerpoint') return { label: 'Microsoft PowerPoint 사용', className: 'ready', detail: 'PowerPoint가 설치되어 원본과 가장 가까운 PDF와 미리보기를 만듭니다.' };
    if (status?.engine === 'libreoffice') return { label: 'LibreOffice 사용', className: 'limited', detail: '자동 변환이 가능합니다. PC에 없는 글꼴은 줄바꿈이나 간격이 달라질 수 있으니 첫 결과를 확인해주세요.' };
    if (status?.powerPoint && status?.powerPointRunning) return { label: 'PowerPoint 사용 중', className: 'limited', detail: '열려 있는 PowerPoint 작업을 보호하고 있습니다. PowerPoint를 닫으면 자동 변환을 시작할 수 있습니다.' };
    return { label: 'PDF 변환 프로그램 필요', className: 'unavailable', detail: 'Microsoft PowerPoint 또는 LibreOffice가 설치되어야 PDF와 미리보기를 만들 수 있습니다. 템플릿 문서의 PPTX 출력은 계속 사용할 수 있습니다.' };
  }

  function normalizeDocumentExtension(value) {
    const source = String(value || '').trim().toLowerCase();
    const baseName = source.split(/[\\/]/).pop() || '';
    const extension = baseName.includes('.') ? baseName.slice(baseName.lastIndexOf('.') + 1) : baseName;
    return /^[a-z0-9]{1,12}$/.test(extension) ? extension : '';
  }

  function applyConversionCatalog(catalog) {
    if (!catalog || !Array.isArray(catalog.sources) || !catalog.sources.length) return false;
    const nextTargets = {};
    const nextLabels = { ...DEFAULT_DOCUMENT_FORMAT_LABELS };
    const nextOutputs = {};
    const nextRouteMetadata = {};
    const sourceItems = [];
    for (const output of Array.isArray(catalog.outputs) ? catalog.outputs : []) {
      const extension = normalizeDocumentExtension(output?.extension);
      if (!extension) continue;
      const label = String(output?.label || output?.displayLabel || '').trim().slice(0, 160);
      const compatibilityNote = String(output?.compatibilityNote || '').trim().slice(0, 500);
      if (label) nextLabels[extension] = label;
      nextOutputs[extension] = { extension, label: label || nextLabels[extension] || extension.toUpperCase(), compatibilityNote };
    }
    for (const source of catalog.sources) {
      const extension = normalizeDocumentExtension(source?.extension);
      if (!extension || nextTargets[extension]) continue;
      const targets = [...new Set((Array.isArray(source?.targets) ? source.targets : [])
        .map(normalizeDocumentExtension).filter((target) => target && target !== extension))];
      if (!targets.length) continue;
      const label = String(source?.label || source?.displayLabel || '').trim().slice(0, 160);
      if (label) nextLabels[extension] = label;
      nextTargets[extension] = Object.freeze(targets);
      const routeItems = Array.isArray(source?.targetMetadata) ? source.targetMetadata : [];
      nextRouteMetadata[extension] = Object.freeze(Object.fromEntries(routeItems.map((target) => {
        const targetExtension = normalizeDocumentExtension(target?.extension);
        if (!targetExtension || !targets.includes(targetExtension)) return null;
        return [targetExtension, Object.freeze({
          extension: targetExtension,
          label: String(target?.label || target?.displayLabel || nextLabels[targetExtension] || '').trim().slice(0, 160),
          compatibilityNote: String(target?.compatibilityNote || '').trim().slice(0, 500)
        })];
      }).filter(Boolean)));
      sourceItems.push({ extension, label: label || extension.toUpperCase() });
    }
    if (!sourceItems.length) return false;
    const nextSignature = JSON.stringify({
      outputs: Object.values(nextOutputs).map((item) => [item.extension, item.label, item.compatibilityNote]),
      sources: sourceItems.map((source) => [
        source.extension,
        source.label,
        nextTargets[source.extension],
        nextTargets[source.extension].map((targetExtension) => {
          const metadata = nextRouteMetadata[source.extension]?.[targetExtension] || nextOutputs[targetExtension] || {};
          return [targetExtension, metadata.label || '', metadata.compatibilityNote || ''];
        })
      ])
    });
    if (nextSignature === conversionCatalogSignature) return false;
    conversionSourceTargets = Object.freeze(nextTargets);
    documentFormatLabels = Object.freeze(nextLabels);
    conversionOutputMetadata = Object.freeze(nextOutputs);
    conversionRouteMetadata = Object.freeze(nextRouteMetadata);
    conversionCatalogSignature = nextSignature;
    const sourceSelect = $('#documentConversionSource');
    if (sourceSelect) {
      const selected = normalizeDocumentExtension(converter.sourceExtension);
      const automatic = document.createElement('option');
      automatic.value = '';
      automatic.textContent = '자동 감지 · 여러 형식을 함께 선택';
      const options = sourceItems.map((source) => {
        const option = document.createElement('option');
        option.value = source.extension;
        option.textContent = `${source.extension.toUpperCase()} · ${source.label}`;
        return option;
      });
      sourceSelect.replaceChildren(automatic, ...options);
      converter.sourceExtension = selected && nextTargets[selected] ? selected : '';
      sourceSelect.value = converter.sourceExtension;
    }
    return true;
  }

  function targetLabel(extension) {
    const normalized = normalizeDocumentExtension(extension);
    return documentFormatLabels[normalized] || normalized.toUpperCase() || '문서';
  }

  function shortFormatLabel(extension) {
    return normalizeDocumentExtension(extension).toUpperCase() || '문서';
  }

  function selectedConversionSourceExtensions() {
    const extension = normalizeDocumentExtension(converter.sourceExtension);
    return extension && conversionSourceTargets[extension] ? [extension] : [];
  }

  function converterSourceExtensions() {
    return [...new Set(converter.files.map((file) => normalizeDocumentExtension(file.extension || file.name)).filter(Boolean))];
  }

  function conversionSourceMismatchFiles() {
    const selected = normalizeDocumentExtension(converter.sourceExtension);
    if (!selected) return [];
    return converter.files.filter((file) => normalizeDocumentExtension(file.extension || file.name) !== selected);
  }

  function conversionHasSourceMismatch() {
    return conversionSourceMismatchFiles().length > 0;
  }

  function detectedConversionSourceLabel() {
    const extensions = converterSourceExtensions();
    if (!extensions.length) return converter.sourceExtension ? shortFormatLabel(converter.sourceExtension) : '자동 감지';
    if (extensions.length === 1) return shortFormatLabel(extensions[0]);
    const visible = extensions.slice(0, 3).map(shortFormatLabel).join('·');
    return extensions.length > 3 ? `${visible} 외 ${extensions.length - 3}개` : visible;
  }

  function localTargetsForCurrentRoute() {
    const selected = normalizeDocumentExtension(converter.sourceExtension);
    if (selected && (!converter.files.length || conversionHasSourceMismatch())) return [...(conversionSourceTargets[selected] || [])];
    if (converter.files.length) return localCommonTargets(converter.files);
    // PDF is the sole common output across every supported source type, so the
    // automatic route can still read clearly before a file is chosen.
    return ['pdf'];
  }

  function syncLocalConversionTargets({ keepTarget = true } = {}) {
    converter.targetExtensions = localTargetsForCurrentRoute();
    const selected = normalizeDocumentExtension(converter.sourceExtension);
    converter.targetMetadata = selected && conversionRouteMetadata[selected]
      ? converter.targetExtensions.map((extension) => conversionRouteMetadata[selected][extension] || conversionOutputMetadata[extension]).filter(Boolean)
      : [];
    if (!keepTarget || !converter.targetExtensions.includes(converter.targetExtension)) {
      converter.targetExtension = converter.targetExtensions.includes('pdf') ? 'pdf' : converter.targetExtensions[0] || '';
    }
  }

  function renderConversionRoute() {
    const sourceSelect = $('#documentConversionSource');
    const sourceIcon = $('#documentConversionSourceIcon');
    const summary = $('#documentConversionSourceSummary');
    const mismatchNotice = $('#documentConversionSourceMismatch');
    const chooseTitle = $('#documentConversionChooseTitle');
    const chooseHint = $('#documentConversionChooseHint');
    if (!sourceSelect || !summary || !mismatchNotice || !chooseTitle || !chooseHint) return;
    const locked = converter.running || converter.preparing || converter.routeChecking;
    $('#documentConversionRoutePicker')?.setAttribute('aria-busy', String(converter.routeChecking));
    const selected = normalizeDocumentExtension(converter.sourceExtension);
    const detected = converterSourceExtensions();
    const mismatches = conversionSourceMismatchFiles();
    const sourceLabel = detectedConversionSourceLabel();
    const target = converter.targetExtension ? shortFormatLabel(converter.targetExtension) : '결과 선택';
    const compatibilityNote = converter.targetExtension
      ? String((converter.targetMetadata.find((item) => normalizeDocumentExtension(item?.extension || item) === converter.targetExtension)
        || conversionOutputMetadata[converter.targetExtension])?.compatibilityNote || '')
      : '';
    sourceSelect.value = selected;
    setDocumentFormatMark(sourceIcon, selected, { automatic: !selected });
    sourceSelect.disabled = locked;
    sourceSelect.setAttribute('aria-invalid', String(mismatches.length > 0));
    const summaryItems = [
      element('strong', '', `${sourceLabel} → ${target}`),
      element('span', '', converter.files.length
        ? `선택한 ${converter.files.length}개 파일에서 ${detected.map(shortFormatLabel).join(' · ')} 형식을 감지했습니다.`
        : selected
        ? `${shortFormatLabel(selected)} 파일만 선택창에 표시합니다.`
        : '파일을 고르면 실제로 감지한 원본 형식을 여기에 표시합니다.')
    ];
    if (compatibilityNote) summaryItems.push(element('span', 'document-route-compatibility-note', compatibilityNote));
    summary.replaceChildren(...summaryItems);
    if (selected) {
      chooseTitle.textContent = `${shortFormatLabel(selected)} 파일 선택`;
      chooseHint.textContent = `.${selected.toUpperCase()} 파일만 표시하며, 더 선택하면 기존 목록에 이어집니다.`;
    } else {
      chooseTitle.textContent = '여러 문서 선택';
      chooseHint.textContent = '파일 형식을 자동으로 감지하며, 더 선택하면 기존 목록에 이어집니다.';
    }
    if (mismatches.length) {
      const formats = [...new Set(mismatches.map((file) => shortFormatLabel(file.extension || file.name)))];
      mismatchNotice.replaceChildren(
        element('strong', '', `${shortFormatLabel(selected)} 선택과 맞지 않는 파일 ${mismatches.length}개가 있습니다.`),
        document.createTextNode(` ${formats.join(' · ')} 파일은 목록에 그대로 보존했습니다. 해당 파일의 ×를 눌러 제외하거나 원본 형식을 “자동 감지”로 바꾸면 계속할 수 있습니다.`)
      );
      mismatchNotice.hidden = false;
    } else {
      mismatchNotice.replaceChildren();
      mismatchNotice.hidden = true;
    }
  }

  function localCommonTargets(files) {
    if (!files.length) return [];
    const lists = files.map((file) => conversionSourceTargets[normalizeDocumentExtension(file.extension || file.name)] || []);
    if (lists.some((list) => !list.length)) return [];
    return lists[0].filter((target) => lists.slice(1).every((list) => list.includes(target)));
  }

  function conversionIsReady() {
    const availability = converter.availability;
    if (!converter.files.length || !converter.targetExtension) return false;
    if (conversionHasSourceMismatch()) return false;
    if (converter.routeChecking) return false;
    if (conversionRunningDependencies().length) return false;
    if (converter.requiredFonts.length) return false;
    if (!availability) return Boolean(converter.capabilities?.engine);
    if (availability.ready === true || availability.available === true) return true;
    return availability.blocked === false;
  }

  function conversionRunningDependencies() {
    const dependencies = converter.capabilities?.dependencies || {};
    return [...new Set(converter.routes.map((route) => route?.requiredDependency).filter((id) => id && dependencies[id]?.running))];
  }

  function conversionMissingDependencies() {
    const availability = converter.availability || {};
    return [
      ...(availability.missingDependencies || availability.missing || []),
      ...converter.requiredFonts.map((family) => ({ label: `글꼴 ${family}`, id: family, kind: 'font' }))
    ];
  }

  function conversionDependencyLabel(item) {
    if (typeof item === 'string') return item;
    return item?.label || item?.dependency?.label || item?.dependencyId || item?.id || '필요 구성요소';
  }

  function renderConversionTargets() {
    const field = $('#documentConversionTargetField');
    const container = $('#documentConversionTargets');
    if (!field || !container) return;
    container.replaceChildren();
    field.hidden = false;
    if (!converter.files.length && !converter.targetExtensions.length) syncLocalConversionTargets();
    if (!converter.targetExtensions.length) {
      container.append(element('span', 'field-help', '함께 선택한 파일에 공통으로 적용할 수 있는 결과 형식이 없습니다. 같은 종류끼리 나누어 선택해주세요.'));
      renderConversionRoute();
      return;
    }
    converter.targetExtensions.forEach((extension) => {
      const normalized = normalizeDocumentExtension(extension?.extension || extension);
      if (!normalized) return;
      const metadata = converter.targetMetadata.find((item) => normalizeDocumentExtension(item?.extension || item) === normalized)
        || conversionOutputMetadata[normalized] || {};
      const button = element('button', `document-target-option${converter.targetExtension === normalized ? ' active' : ''}`);
      button.type = 'button';
      button.dataset.documentTarget = normalized;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `${normalized.toUpperCase()} · ${metadata.label || metadata.displayLabel || targetLabel(normalized)}`);
      button.setAttribute('aria-checked', String(converter.targetExtension === normalized));
      button.tabIndex = converter.targetExtension === normalized ? 0 : -1;
      button.disabled = converter.running || converter.preparing || converter.routeChecking;
      if (metadata.compatibilityNote) button.title = metadata.compatibilityNote;
      const copy = element('span', 'document-target-option-copy');
      copy.append(element('strong', '', normalized.toUpperCase()), element('small', '', metadata.label || metadata.displayLabel || targetLabel(normalized)));
      button.append(createDocumentFormatMark(normalized, { className: 'document-format-mark-target' }), copy);
      container.append(button);
    });
    renderConversionRoute();
  }

  function dependencyPlanKinds(plan = {}) {
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const unresolved = Array.isArray(plan.unresolved) ? plan.unresolved : [];
    const automaticActions = actions.filter((action) => action?.automatic === true);
    const officialActions = actions.filter((action) => (
      action?.type === 'officialInstaller' || action?.type === 'officialFontSource' || action?.automatic === false
    ));
    return {
      actions,
      unresolved,
      automaticActions,
      officialActions,
      hasAutomatic: automaticActions.length > 0,
      hasOfficial: officialActions.length > 0,
      hasUnresolved: unresolved.length > 0,
      hasUnresolvedFonts: unresolved.some((item) => item?.kind === 'font')
    };
  }

  function dependencyFontActionCopy(action) {
    if (!action) return { badge: '설치 파일 선택', detail: '클릭해 직접 보유한 정식 TTF·OTF·TTC 파일을 고르면 내부 글꼴명을 확인한 뒤 설치합니다.', automatic: false, fileSelectable: true };
    if (action.type === 'installOpenFontPerUser') return { badge: '자동 설치', detail: '클릭하면 검증된 공개 글꼴을 이 Windows 사용자에게 설치합니다.', automatic: true };
    if (action.type === 'installWindowsCapability') return { badge: 'Windows 기능', detail: '클릭하면 Windows의 공식 한국어 추가 글꼴을 설치하며 관리자 승인이 한 번 필요할 수 있습니다.', automatic: true };
    if (action.type === 'officialFontSource') return { badge: '보유 파일 설치', detail: '클릭해 공급사에서 받은 정식 TTF·OTF·TTC 파일을 고릅니다. 아래 큰 버튼은 공식 공급처를 엽니다.', automatic: false, fileSelectable: true };
    return { badge: action.automatic ? '자동 준비' : '공식 설치', detail: action.automatic ? '클릭하면 검증된 항목을 자동으로 준비합니다.' : '클릭하면 공식 설치 화면을 엽니다.', automatic: action.automatic === true };
  }

  function renderDependencyFontItems(selector, plan, requiredFonts, scope, busy) {
    const container = $(selector);
    if (!container) return;
    container.replaceChildren();
    const fonts = [...new Set((Array.isArray(requiredFonts) ? requiredFonts : []).map((family) => String(family || '').trim()).filter(Boolean))];
    if (!fonts.length) return;
    const fontRecords = new Map((Array.isArray(plan?.fonts) ? plan.fonts : []).map((record) => [String(record?.id || ''), record]));
    const actions = new Map((Array.isArray(plan?.actions) ? plan.actions : []).map((action) => [String(action?.id || ''), action]));
    for (const family of fonts) {
      const record = fontRecords.get(family);
      const action = record?.actionId ? actions.get(String(record.actionId)) : null;
      const copy = dependencyFontActionCopy(action);
      const button = element('button', 'document-dependency-item');
      button.type = 'button';
      button.dataset.documentFontScope = scope;
      button.dataset.documentFontFamily = family;
      if (action?.id) button.dataset.documentFontAction = action.id;
      if (copy.fileSelectable) button.dataset.documentFontFile = 'true';
      button.dataset.automatic = String(copy.automatic);
      button.disabled = Boolean(busy || (!action?.id && !copy.fileSelectable));
      button.setAttribute('aria-label', `${family} · ${copy.badge}. ${copy.detail}`);
      button.append(
        element('strong', '', family),
        element('b', 'document-dependency-item-badge', copy.badge),
        element('span', '', copy.detail)
      );
      container.append(button);
    }
  }

  function dependencyPreparationCopy(kinds, runningDependencies = []) {
    if (runningDependencies.length) return {
      badge: '문서 프로그램 사용 중',
      title: '사용 중인 문서 프로그램을 닫아주세요.',
      detail: '작업 중인 문서를 저장하고 프로그램을 닫은 뒤 다시 확인하면 자동으로 이어집니다.',
      button: '닫은 뒤 다시 확인'
    };
    if (kinds.actions.some((action) => action?.type === 'officialHancomAutomationGuide')) return {
      badge: '한글 자동 변환 설정 필요',
      title: '한컴 공식 오토메이션 설정을 확인해주세요.',
      detail: '한컴 한글은 설치만으로 문서 자동 변환이 준비되지 않습니다. 공식 FilePathCheckDLL 등록과 한글·DLL의 동일 비트 구성이 필요하며, 상업·조직 이용은 한컴의 별도 승인·라이선스를 확인해야 합니다. 앱은 승인되지 않은 DLL을 임의로 받지 않습니다.',
      button: '한컴 공식 설정 안내 열기'
    };
    if (!kinds.actions.length && kinds.hasUnresolvedFonts) return {
      badge: '정확한 글꼴 필요',
      title: '원본 글꼴을 확인해주세요.',
      detail: '저작권과 출처가 확인되지 않은 글꼴은 임의로 검색하거나 내려받지 않습니다. 해당 글꼴의 정식 설치 파일을 설치하면 앱이 자동으로 다시 감지합니다.',
      button: '정식 글꼴 설치 후 다시 확인'
    };
    if (kinds.hasAutomatic && kinds.hasOfficial) return {
      badge: kinds.hasUnresolved ? '일부 자동 준비 + 공식 확인' : '자동 준비 + 공식 확인',
      title: '자동 준비와 공식 설치를 이어서 진행합니다.',
      detail: `검증된 공개 구성 ${kinds.automaticActions.length}개는 자동으로 준비하고, 라이선스가 필요한 프로그램·글꼴 ${kinds.officialActions.length}개는 공급사 공식 화면을 엽니다.${kinds.hasUnresolved ? ` 출처를 확정할 수 없는 항목 ${kinds.unresolved.length}개는 임의로 받지 않습니다.` : ''} 설치 후 앱으로 돌아오면 다시 감지합니다.`,
      button: '자동 준비하고 공식 화면 열기'
    };
    if (kinds.hasAutomatic) return {
      badge: kinds.hasUnresolved ? '준비 가능한 항목 있음' : '자동 준비 가능',
      title: kinds.hasUnresolved ? '준비 가능한 구성부터 자동으로 설치합니다.' : '필요한 구성을 자동으로 준비할 수 있습니다.',
      detail: `출처와 SHA-256을 확인한 공개 구성만 사용자 영역에 자동으로 준비합니다.${kinds.hasUnresolved ? ` 출처를 확정할 수 없는 항목 ${kinds.unresolved.length}개는 건드리지 않고 남겨둡니다.` : ''} 임의 대체 글꼴은 사용하지 않습니다.`,
      button: '준비 가능한 항목 자동 설치'
    };
    if (kinds.hasOfficial) return {
      badge: kinds.hasUnresolved ? '공식 확인 + 직접 설치 필요' : '공식 설치 필요',
      title: '공식 설치·글꼴 안내를 확인해주세요.',
      detail: `라이선스가 필요한 프로그램·글꼴 ${kinds.officialActions.length}개의 공급사 공식 화면을 엽니다.${kinds.hasUnresolved ? ` 출처를 확정할 수 없는 항목 ${kinds.unresolved.length}개는 임의로 받지 않습니다.` : ''} 설치 후 앱으로 돌아오면 자동 감지합니다.`,
      button: '공식 설치·글꼴 안내 열기'
    };
    return {
      badge: '정확한 구성 필요',
      title: '필요한 구성을 확인해주세요.',
      detail: '출처가 확인되지 않은 파일을 임의로 내려받지 않습니다. 정식 설치를 마친 뒤 다시 확인해주세요.',
      button: '설치 후 다시 확인'
    };
  }

  function renderConversionAvailability() {
    const badge = $('#pptxPdfEngineBadge');
    const notice = $('#pptxPdfEngineNotice');
    const card = $('#documentDependencyCard');
    const prepareButton = $('#prepareDocumentDependencies');
    if (!badge || !notice || !card || !prepareButton) return;
    setEngineBadgeApplication(badge, converter.files.length ? conversionApplicationVisual() : '');
    renderDependencyFontItems('#documentDependencyItems', null, [], 'conversion', false);
    const label = targetLabel(converter.targetExtension);
    if (!converter.files.length) {
      const copy = engineCopy(converter.capabilities);
      badge.className = `engine-badge ${copy.className === 'unavailable' ? 'checking' : copy.className}`;
      setEngineBadgeText(badge, '파일 선택 후 자동 확인');
      notice.replaceChildren(element('strong', '', '설치된 문서 프로그램과 글꼴을 자동으로 확인합니다.'), document.createTextNode(' 파일을 선택하면 필요한 구성만 안내합니다.'));
      card.hidden = true;
      return;
    }
    if (converter.routeChecking) {
      badge.className = 'engine-badge checking'; setEngineBadgeText(badge, '변환 경로 확인 중');
      notice.replaceChildren(element('strong', '', '선택한 원본과 결과 형식의 변환 환경을 확인하고 있습니다.'), document.createTextNode(' 확인이 끝날 때까지 파일과 형식 선택을 잠시 유지합니다.'));
      card.hidden = true;
      return;
    }
    if (conversionHasSourceMismatch()) {
      badge.className = 'engine-badge limited'; setEngineBadgeText(badge, '원본 형식 확인 필요');
      notice.replaceChildren(element('strong', '', '위에서 선택한 원본 형식과 목록의 파일 형식이 다릅니다.'), document.createTextNode(' 기존 목록은 지우지 않았습니다. 원본 형식을 자동 감지로 바꾸거나 맞지 않는 파일만 제외해주세요.'));
      card.hidden = true;
      return;
    }
    if (!converter.targetExtension) {
      badge.className = 'engine-badge limited'; setEngineBadgeText(badge, '결과 형식 선택 필요');
      notice.replaceChildren(element('strong', '', '결과 형식을 선택해주세요.'), document.createTextNode(' 선택한 모든 파일에서 사용할 수 있는 형식만 표시합니다.'));
      card.hidden = true;
      return;
    }
    if (conversionIsReady()) {
      badge.className = `engine-badge ${converter.requiresPreview ? 'limited' : 'ready'}`;
      setEngineBadgeText(badge, converter.requiresPreview ? `${label} 결과 확인 필요` : `${label} 준비 완료`);
      notice.replaceChildren(
        element('strong', '', converter.requiresPreview ? '원본 글꼴을 미리 읽을 수 없는 파일이 포함되어 있습니다.' : '원본 형식에 맞는 프로그램을 확인했습니다.'),
        document.createTextNode(converter.requiresPreview
          ? ' 원본 프로그램으로 엄격하게 변환하되, 완료 후 결과 미리보기에서 글꼴·줄바꿈·페이지를 반드시 확인하도록 표시합니다.'
          : ' 다른 엔진이나 대체 글꼴로 몰래 바꾸지 않습니다.')
      );
      card.hidden = true;
      return;
    }
    const missing = conversionMissingDependencies();
    const names = missing.map(conversionDependencyLabel).filter(Boolean);
    const plan = converter.preparationPlan || {};
    const kinds = dependencyPlanKinds(plan);
    const runningDependencies = conversionRunningDependencies();
    const preparationCopy = dependencyPreparationCopy(kinds, runningDependencies);
    badge.className = 'engine-badge limited';
    setEngineBadgeText(badge, converter.preparing ? '필요한 구성 준비 중' : preparationCopy.badge);
    notice.replaceChildren(
      element('strong', '', names.length ? `${names.join(' · ')} 준비가 필요합니다.` : '변환에 필요한 구성을 준비해야 합니다.'),
      document.createTextNode(runningDependencies.length
        ? ' 열려 있는 문서를 보호하기 위해 자동 처리를 기다리고 있습니다.'
        : ` ${preparationCopy.detail}`)
    );
    $('#documentDependencyTitle').textContent = preparationCopy.title;
    $('#documentDependencyDetail').textContent = preparationCopy.detail;
    prepareButton.textContent = converter.preparing ? '준비하는 중…' : preparationCopy.button;
    prepareButton.disabled = converter.preparing || converter.running || converter.routeChecking;
    renderDependencyFontItems('#documentDependencyItems', plan, converter.requiredFonts, 'conversion', converter.preparing || converter.running || converter.routeChecking);
    card.hidden = false;
  }

  async function refreshConversionTargets(options = {}) {
    const refreshSequence = ++conversionTargetRefreshSequence;
    const sourceSnapshot = normalizeDocumentExtension(converter.sourceExtension);
    const fileSnapshot = converter.files.map((file) => String(file.token || file.key || `${file.name}:${file.bytes}`)).join('\u001f');
    let targetSnapshot = normalizeDocumentExtension(converter.targetExtension);
    const stillCurrent = () => refreshSequence === conversionTargetRefreshSequence
      && sourceSnapshot === normalizeDocumentExtension(converter.sourceExtension)
      && targetSnapshot === normalizeDocumentExtension(converter.targetExtension)
      && fileSnapshot === converter.files.map((file) => String(file.token || file.key || `${file.name}:${file.bytes}`)).join('\u001f');
    if (!converter.files.length) {
      converter.routeChecking = false;
      syncLocalConversionTargets({ keepTarget: options.keepTarget !== false });
      converter.availability = null; converter.preparationPlan = null; converter.requiredFonts = []; converter.fontReports = []; converter.inspectionUnavailable = []; converter.requiresPreview = false; converter.routes = [];
      renderConversionTargets(); renderConversionAvailability(); renderConverterOutput(); updateConverterReady();
      return;
    }
    if (conversionHasSourceMismatch()) {
      converter.routeChecking = false;
      syncLocalConversionTargets({ keepTarget: options.keepTarget !== false });
      converter.availability = null; converter.preparationPlan = null; converter.requiredFonts = []; converter.fontReports = []; converter.inspectionUnavailable = []; converter.requiresPreview = false; converter.routes = [];
      renderConversionTargets(); renderConversionAvailability(); renderConverterOutput(); updateConverterReady();
      return;
    }
    syncLocalConversionTargets({ keepTarget: options.keepTarget !== false });
    const requestedTarget = converter.targetExtension;
    targetSnapshot = normalizeDocumentExtension(requestedTarget);
    converter.routeChecking = true;
    converter.availability = null; converter.preparationPlan = null; converter.requiredFonts = []; converter.fontReports = []; converter.inspectionUnavailable = []; converter.requiresPreview = false; converter.routes = [];
    renderConverterFiles();
    try {
      const result = await DOCUMENT_CONVERSION_BRIDGE.targets({
        fileTokens: converter.files.map((file) => file.token),
        targetExtension: options.keepTarget === false ? '' : requestedTarget
      });
      if (!stillCurrent()) return;
      if (result) {
        converter.targetExtensions = (result.targetExtensions || result.targets || []).map((item) => normalizeDocumentExtension(item?.extension || item)).filter(Boolean);
        converter.targetMetadata = Array.isArray(result.targets) ? result.targets : [];
        if (!converter.targetExtensions.includes(converter.targetExtension)) {
          converter.targetExtension = normalizeDocumentExtension(result.targetExtension)
            || (converter.targetExtensions.includes('pdf') ? 'pdf' : converter.targetExtensions[0] || '');
          targetSnapshot = normalizeDocumentExtension(converter.targetExtension);
        }
        converter.availability = result.availability || null;
        converter.preparationPlan = result.preparationPlan || null;
        converter.requiredFonts = Array.isArray(result.requiredFonts) ? result.requiredFonts.map(String) : [];
        converter.fontReports = Array.isArray(result.fontReports) ? result.fontReports : [];
        converter.inspectionUnavailable = Array.isArray(result.inspectionUnavailable) ? result.inspectionUnavailable : [];
        converter.requiresPreview = result.requiresPreview === true;
        converter.routes = Array.isArray(result.routes) ? result.routes : [];
      }
    } catch (error) {
      if (!stillCurrent()) return;
      converter.availability = { blocked: true, missingDependencies: [] };
      converter.preparationPlan = null;
      converter.inspectionUnavailable = [];
      converter.requiresPreview = false;
      notify(`변환 가능한 형식을 확인하지 못했습니다: ${error.message}`, 'error');
    } finally {
      if (stillCurrent()) {
        converter.routeChecking = false;
        renderConverterFiles(); renderConverterOutput();
      }
    }
  }

  async function prepareConversionDependencies() {
    if (converter.preparing || converter.running || converter.routeChecking) return;
    const actions = converter.preparationPlan?.actions || [];
    if (!actions.length) {
      await refreshCapabilities(true);
      await refreshConversionTargets();
      notify(conversionIsReady() ? '필요한 글꼴과 문서 프로그램을 확인했습니다.' : '아직 정확한 글꼴 또는 문서 프로그램을 찾지 못했습니다.', conversionIsReady() ? 'success' : 'normal');
      return;
    }
    converter.preparing = true; renderConverterFiles();
    try {
      const result = await DOCUMENT_CONVERSION_BRIDGE.prepare({
        approved: true,
        requestId: crypto.randomUUID(),
        requiredApplications: converter.availability?.requiredDependencies || converter.availability?.missingDependencies?.map((item) => item.dependencyId || item.id).filter(Boolean) || [],
        requiredDependencies: converter.availability?.requiredDependencies || [],
        requiredFonts: converter.requiredFonts,
        confirmedActionIds: actions.map((action) => action.id).filter(Boolean)
      });
      await refreshCapabilities(true);
      await refreshConversionTargets();
      const outcome = dependencyPreparationOutcome(result, actions, conversionIsReady());
      notify(outcome.message, outcome.tone);
    } catch (error) {
      notify(`필요한 구성을 준비하지 못했습니다: ${error.message}`, 'error');
      $('#documentDependencyDetail').textContent = error.message;
    } finally {
      converter.preparing = false; renderConverterFiles();
    }
  }

  function certificateMissingFonts() {
    const readiness = certificate.certificatePdfReadiness || certificate.template?.certificatePdfReadiness || {};
    const report = readiness.fontReport || certificate.template?.fontReport || {};
    const source = Array.isArray(readiness.requiredFonts) && readiness.requiredFonts.length
      ? readiness.requiredFonts
      : (Array.isArray(report.missingFonts) ? report.missingFonts : []);
    return [...new Set(source.map((family) => String(family || '').trim()).filter(Boolean))];
  }

  function currentCertificatePdfRequirements() {
    const pdfSelected = Boolean($('#certificateOutputPdf')?.checked);
    const guide = certificate.capabilities?.engine === 'guide';
    const powerPoint = guide || Boolean(certificate.capabilities?.certificatePdfAvailable
      || (certificate.capabilities?.powerPoint && !certificate.capabilities?.powerPointRunning));
    const running = pdfSelected && !guide && Boolean(certificate.capabilities?.powerPointRunning
      || certificate.capabilities?.certificatePdf?.running);
    const requiredFonts = guide ? [] : certificateMissingFonts();
    return {
      pdfSelected,
      powerPoint,
      running,
      requiredFonts,
      ready: !pdfSelected || (powerPoint && !running && requiredFonts.length === 0)
    };
  }

  function applyCertificateReadiness(result = {}) {
    const readiness = result.certificatePdfReadiness || result.readiness || result;
    if (readiness && typeof readiness === 'object') {
      certificate.certificatePdfReadiness = readiness;
      certificate.preparationPlan = readiness.preparationPlan || result.preparationPlan || null;
      if (certificate.template) {
        certificate.template.certificatePdfReadiness = readiness;
        const report = readiness.fontReport || result.fontReport;
        if (report) certificate.template.fontReport = report;
      }
    }
    renderCertificateFontNotice();
    renderCertificateDependency();
    updateCertificateReady();
  }

  function certificatePreparationActions(requirements = currentCertificatePdfRequirements()) {
    const plan = certificate.preparationPlan || certificate.certificatePdfReadiness?.preparationPlan || {};
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const needsPowerPoint = requirements.pdfSelected && !requirements.powerPoint;
    return actions.filter((action) => action.dependencyId !== 'officePowerPoint' || needsPowerPoint);
  }

  async function refreshCertificateRequirements(options = {}) {
    if (!certificate.template || guideDemo.active) return;
    if (options.refreshCapabilities !== false) await refreshCapabilities(true);
    const inspect = api()?.inspectCertificateReadiness || api()?.inspectCertificateRequirements || api()?.getCertificateRequirements;
    if (typeof inspect !== 'function') {
      renderCertificateDependency(); updateCertificateReady();
      return;
    }
    const result = await inspect(templatePayload({ refresh: true }));
    applyCertificateReadiness(result || {});
  }

  function renderCertificateDependency() {
    const card = $('#certificateDependencyCard'); const button = $('#prepareCertificateDependencies');
    const badge = $('#certificateEngineBadge');
    if (!card || !button || !badge) return;
    renderDependencyFontItems('#certificateDependencyItems', null, [], 'certificate', false);
    const requirements = currentCertificatePdfRequirements();
    if (!certificate.template) {
      badge.className = 'engine-badge checking'; setEngineBadgeText(badge, '양식 선택 후 자동 확인');
      card.hidden = true; return;
    }
    if (!requirements.pdfSelected && requirements.requiredFonts.length === 0) {
      badge.className = 'engine-badge ready'; setEngineBadgeText(badge, 'PPTX 출력 준비');
      card.hidden = true; return;
    }
    if (requirements.ready && requirements.requiredFonts.length === 0) {
      badge.className = 'engine-badge ready'; setEngineBadgeText(badge, requirements.pdfSelected ? 'PowerPoint 원본 출력 준비' : 'PPTX 출력 준비');
      card.hidden = true; return;
    }
    const plan = certificate.preparationPlan || certificate.certificatePdfReadiness?.preparationPlan || {};
    const actions = certificatePreparationActions(requirements);
    const unresolved = Array.isArray(plan.unresolved) ? plan.unresolved : [];
    const hasAutomatic = actions.some((action) => action.automatic === true);
    const hasOfficial = actions.some((action) => action.type === 'officialInstaller' || action.type === 'officialFontSource' || action.automatic === false);
    const fontSummary = requirements.requiredFonts.length
      ? `없는 글꼴 ${requirements.requiredFonts.length}개: ${requirements.requiredFonts.slice(0, 4).join(', ')}${requirements.requiredFonts.length > 4 ? ` 외 ${requirements.requiredFonts.length - 4}개` : ''}`
      : '';
    badge.className = 'engine-badge limited';
    setEngineBadgeText(badge, certificate.preparing ? '필요 구성 준비 중' : requirements.running ? 'PowerPoint 사용 중' : '필요 구성 자동 준비');
    $('#certificateDependencyTitle').textContent = certificate.preparing
      ? '원본 출력을 위한 구성을 준비하고 있습니다.'
      : requirements.running
      ? '열려 있는 PowerPoint를 먼저 닫아주세요.'
      : hasAutomatic && hasOfficial
      ? '자동 준비와 공식 설치를 이어서 진행합니다.'
      : hasAutomatic
      ? '필요한 구성은 한 번에 자동으로 준비합니다.'
      : hasOfficial
      ? '공식 설치 화면을 한 번만 거치면 됩니다.'
      : '원본과 같은 글꼴과 PowerPoint를 확인해주세요.';
    $('#certificateDependencyDetail').textContent = certificate.preparing
      ? '검증된 파일만 내려받으며 원본 PPTX는 수정하지 않습니다.'
      : requirements.running
      ? '작업 중인 파일을 저장하고 PowerPoint를 닫은 뒤 아래 버튼을 누르면 자동으로 다시 확인합니다.'
      : [
        requirements.pdfSelected && !requirements.powerPoint ? '최종 PDF는 Microsoft PowerPoint의 실제 출력으로 만듭니다.' : '',
        !requirements.pdfSelected && requirements.requiredFonts.length ? 'PPTX 생성은 가능하며, 정확한 미리보기를 위해 원본 글꼴만 준비할 수 있습니다.' : '',
        fontSummary,
        hasAutomatic ? '배포가 허용된 공개 글꼴과 도구는 출처·해시를 확인한 뒤 자동 설치합니다.' : '',
        hasOfficial ? '라이선스가 필요한 항목은 공식 공급처만 열고, 설치 후 앱이 자동 감지합니다.' : '',
        unresolved.length && !hasOfficial ? '출처가 확인되지 않은 글꼴은 임의 대체하지 않습니다.' : ''
      ].filter(Boolean).join(' ');
    button.textContent = certificate.preparing
      ? '준비하는 중…'
      : requirements.running
      ? 'PowerPoint 닫은 뒤 다시 확인'
      : hasAutomatic && hasOfficial
      ? '자동 준비하고 공식 화면 열기'
      : hasOfficial && !hasAutomatic
      ? '공식 설치·글꼴 받기'
      : '필요한 구성 자동 준비';
    button.disabled = certificate.preparing || certificate.running;
    renderDependencyFontItems('#certificateDependencyItems', plan, requirements.requiredFonts, 'certificate', certificate.preparing || certificate.running);
    card.hidden = false;
  }

  async function prepareCertificateDependencies() {
    if (certificate.preparing || certificate.running || !certificate.template || guideDemo.active) return;
    const requirements = currentCertificatePdfRequirements();
    if (requirements.running) {
      await refreshCertificateRequirements();
      notify(currentCertificatePdfRequirements().ready ? 'PowerPoint와 글꼴을 다시 확인했습니다.' : 'PowerPoint가 아직 열려 있습니다. 저장한 뒤 완전히 닫고 다시 확인해주세요.', currentCertificatePdfRequirements().ready ? 'success' : 'normal');
      return;
    }
    const plan = certificate.preparationPlan || certificate.certificatePdfReadiness?.preparationPlan || {};
    const actions = certificatePreparationActions(requirements);
    certificate.preparing = true; renderCertificateDependency(); updateCertificateReady();
    try {
      const result = await DOCUMENT_CONVERSION_BRIDGE.prepare({
        approved: true,
        requestId: crypto.randomUUID(),
        requiredApplications: requirements.pdfSelected && !requirements.powerPoint ? ['officePowerPoint'] : [],
        requiredDependencies: requirements.pdfSelected && !requirements.powerPoint ? ['officePowerPoint'] : [],
        requiredFonts: requirements.requiredFonts,
        ...(actions.length ? { confirmedActionIds: actions.map((action) => action.id).filter(Boolean) } : {})
      });
      await refreshCertificateRequirements();
      const refreshed = currentCertificatePdfRequirements();
      const preparationReady = refreshed.requiredFonts.length === 0 && (!refreshed.pdfSelected || (refreshed.powerPoint && !refreshed.running));
      const outcome = dependencyPreparationOutcome(result, actions, preparationReady);
      notify(outcome.message, outcome.tone);
    } catch (error) {
      notify(`PDF 출력 구성을 준비하지 못했습니다: ${error.message}`, 'error');
      $('#certificateDependencyDetail').textContent = error.message;
    } finally {
      certificate.preparing = false; renderCertificateDependency(); updateCertificateReady();
    }
  }

  async function prepareSingleDocumentFont(button) {
    const family = String(button?.dataset.documentFontFamily || '').trim();
    const actionId = String(button?.dataset.documentFontAction || '').trim();
    const chooseOwnedFile = button?.dataset.documentFontFile === 'true';
    const scope = String(button?.dataset.documentFontScope || 'conversion');
    if (!family || (!actionId && !chooseOwnedFile) || guideDemo.active) return;
    const isCertificate = scope === 'certificate';
    const state = isCertificate ? certificate : converter;
    if (state.preparing || state.running || (!isCertificate && converter.routeChecking)) return;
    state.preparing = true;
    if (isCertificate) renderCertificateDependency();
    else renderConverterFiles();
    try {
      const result = chooseOwnedFile
        ? await DOCUMENT_CONVERSION_BRIDGE.installFontFile({ approved: true, userConfirmed: true, expectedFamily: family })
        : await DOCUMENT_CONVERSION_BRIDGE.prepare({
          approved: true,
          requestId: crypto.randomUUID(),
          requiredApplications: [],
          requiredDependencies: [],
          requiredFonts: [family],
          confirmedActionIds: [actionId]
        });
      if (result?.canceled) {
        notify('글꼴 파일 선택을 취소했습니다. 기존 문서와 설정은 바뀌지 않았습니다.');
        return;
      }
      if (isCertificate) {
        await refreshCertificateRequirements();
      } else {
        await refreshCapabilities(true);
        await refreshConversionTargets();
      }
      const remaining = isCertificate ? currentCertificatePdfRequirements().requiredFonts : converter.requiredFonts;
      const resolved = !remaining.some((item) => String(item).trim() === family);
      const action = { id: actionId, type: result?.actions?.[0]?.type, automatic: button.dataset.automatic === 'true' };
      const outcome = chooseOwnedFile
        ? { tone: result?.applicationRestartRecommended ? 'normal' : 'success', message: result?.applicationRestartRecommended
          ? `${family} 글꼴을 설치했습니다. 문서 프로그램이나 Windows를 다시 열면 정확히 감지됩니다.`
          : `${family} 글꼴을 설치하고 다시 확인했습니다.` }
        : dependencyPreparationOutcome(result, [action], resolved);
      notify(resolved ? `${family} 글꼴을 설치하고 다시 확인했습니다.` : outcome.message, resolved ? 'success' : outcome.tone);
    } catch (error) {
      notify(`${family} 글꼴을 준비하지 못했습니다: ${error.message}`, 'error');
    } finally {
      state.preparing = false;
      if (isCertificate) { renderCertificateDependency(); updateCertificateReady(); }
      else renderConverterFiles();
    }
  }

  function applyEngineStatus(status) {
    const catalogChanged = applyConversionCatalog(status?.conversionCatalog);
    converter.capabilities = status;
    certificate.capabilities = status;
    const pdf = $('#certificateOutputPdf');
    if (pdf) {
      const pdfHint = status?.certificatePdfAvailable || status?.engine === 'guide'
        ? 'Microsoft PowerPoint의 실제 출력으로 PDF를 만듭니다.'
        : 'PDF를 선택해 두면 필요한 PowerPoint와 글꼴 준비 방법을 자동으로 안내합니다.';
      pdf.title = pdfHint; pdf.closest('label')?.setAttribute('title', pdfHint);
    }
    if (catalogChanged) {
      // Once files are selected, getDocumentConversionTargets is the authority:
      // it may aggregate route-specific warnings across several source formats.
      // A capability refresh must not replace that richer metadata with the
      // renderer fallback merely because it also returned the same catalog.
      if (!converter.files.length) syncLocalConversionTargets();
      renderConversionTargets();
      renderConverterOutput();
    }
    renderConversionAvailability(); updateConverterReady(); updateCertificateReady();
    renderCertificateDependency();
    if (activeMergeMeta()) { renderMergeCapability(activeMergeMeta()); updateMergeReady(); }
    if (documentMode === 'documentSplit') { renderSplitCapability(); updateSplitReady(); }
  }

  async function refreshCapabilities(refresh = false) {
    if (!api()?.documentToolCapabilities) return;
    try {
      const status = await api().documentToolCapabilities(refresh);
      // A capability probe can begin just before the interactive guide takes
      // its isolated snapshot. Never let that late real-PC result replace the
      // guide's deterministic, file-free engine while the guide is active.
      if (guideDemo.active) return;
      applyEngineStatus(status);
    }
    catch (error) {
      if (guideDemo.active) return;
      applyEngineStatus({ engine: '' });
      $('#pptxPdfEngineNotice').textContent = `변환 환경을 확인하지 못했습니다: ${error.message}`;
    }
  }

  async function refreshUnavailableCapabilities(pageId) {
    if (guideDemo.active || capabilityRefreshPending || !['pptxPdf', 'certificateMaker'].includes(pageId)) return;
    const status = pageId === 'pptxPdf' ? converter.capabilities : certificate.capabilities;
    if (pageId === 'pptxPdf' && converter.files.length && conversionIsReady()) return;
    capabilityRefreshPending = true;
    try {
      if (pageId === 'certificateMaker' && certificate.template) await refreshCertificateRequirements({ refreshCapabilities: true });
      else await refreshCapabilities(true);
      if (pageId === 'pptxPdf' && converter.files.length) await refreshConversionTargets();
      if (pageId === 'certificateMaker' && certificate.template && certificate.capabilities?.engine && $('#certificatePreviewStage').classList.contains('fallback-preview')) await renderTemplatePreview();
    } finally { capabilityRefreshPending = false; }
  }

  async function refreshFocusedDocumentCapabilities() {
    if (guideDemo.active || capabilityRefreshPending || !pageIsActive('documentEditor')) return;
    const focusedMode = documentMode;
    if (!['pptxPdf', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge'].includes(focusedMode) && !(focusedMode === 'documentSplit' && documentSplitKind === 'pptx')) return;
    capabilityRefreshPending = true;
    try {
      // A native Office/Hancom process can be opened after a previously-ready
      // check. Always probe again when the window regains focus so a stale
      // "ready" badge never lets the next operation collide with that process.
      await refreshCapabilities(true);
      if (focusedMode === 'pptxPdf' && documentMode === focusedMode && converter.files.length) {
        await refreshConversionTargets();
      }
      if (focusedMode === 'documentPdfMerge' && documentMode === focusedMode && mergeStates.documentPdfMerge.files.length) {
        await inspectMergeFiles(mergeStates.documentPdfMerge, DOCUMENT_MODE_META.documentPdfMerge, mergeStates.documentPdfMerge.files);
      }
      if (['wordMerge', 'excelMerge'].includes(focusedMode) && documentMode === focusedMode && mergeStates[focusedMode].files.length) {
        await inspectMergeFiles(mergeStates[focusedMode], DOCUMENT_MODE_META[focusedMode], mergeStates[focusedMode].files, { forceAll: true });
      }
    } finally { capabilityRefreshPending = false; }
  }

  function handleDocumentToolWindowFocus() {
    if (guideDemo.active) return;
    if (pageIsActive('certificateMaker')) void refreshUnavailableCapabilities('certificateMaker');
    else void refreshFocusedDocumentCapabilities();
  }

  function converterFileStatus(file) {
    if (file.status === 'working') return '변환 중';
    if (file.status === 'complete') {
      if (file.validation?.status === 'needsReview' || file.validation?.ok === false) return '완료 · 결과 확인 필요';
      return file.outputName ? `${file.outputName} 완료` : '완료';
    }
    if (file.status === 'failed') return file.error || '실패';
    if (file.status === 'cancelled') return '중단됨';
    return '대기';
  }

  function setConverterResultPending() {
    converter.files.forEach((file) => { file.status = 'pending'; file.error = ''; file.outputName = ''; file.outputFileToken = ''; file.validation = null; file.engine = ''; });
    $('#pptxPdfProgress').hidden = true; $('#pptxPdfProgress').value = 0; $('#openPptxPdfOutput').hidden = true;
  }

  function renderConverterFiles() {
    const container = $('#pptxPdfFileList'); container.replaceChildren();
    if (!converter.files.length) container.append(element('div', 'list-empty', '변환할 문서를 선택하세요.'));
    converter.files.forEach((file, index) => {
      const row = element('div', 'document-file-row document-file-row-with-format');
      const copy = element('div', 'document-file-copy');
      const extension = normalizeDocumentExtension(file.extension || file.name);
      const detail = [extension ? `.${extension.toUpperCase()}` : '', formatBytes(file.bytes), file.engine ? `${file.engine} 사용` : ''].filter(Boolean).join(' · ');
      copy.append(element('strong', '', file.name), element('small', '', detail));
      const statusText = converterFileStatus(file);
      const status = element('span', `document-file-status ${file.status || ''}`, statusText); status.title = statusText;
      const actions = element('div', 'document-file-actions');
      if (file.outputFileToken) {
        const preview = element('button', 'document-result-row-button', '결과 미리보기');
        preview.type = 'button'; preview.dataset.pptxResultPreview = String(index); preview.setAttribute('aria-label', `${file.outputName || file.name} 결과 미리보기`); preview.disabled = converter.running;
        actions.append(preview);
      }
      const remove = element('button', 'document-file-remove', '×');
      remove.type = 'button'; remove.dataset.pptxRemove = String(index); remove.setAttribute('aria-label', `${file.name} 목록에서 제거`); remove.disabled = converter.running || converter.preparing || converter.routeChecking;
      actions.append(remove); row.append(createDocumentFormatMark(extension, { className: 'document-format-mark-file' }), copy, status, actions); container.append(row);
    });
    $('#pptxPdfFileSummary').textContent = converter.files.length ? `${converter.files.length}개 파일 · ${formatBytes(converter.files.reduce((sum, item) => sum + Number(item.bytes || 0), 0))}` : '선택한 파일이 없습니다.';
    $('#choosePptxFiles').disabled = converter.running || converter.preparing || converter.routeChecking;
    $('#choosePptxPdfOutput').disabled = converter.running || converter.preparing || converter.routeChecking;
    renderConversionTargets(); renderConversionAvailability();
    updateConverterReady();
  }

  function updateConverterReady() {
    const hasEngine = conversionIsReady();
    const ready = converter.files.length && converter.targetExtension && converter.outputToken && hasEngine && !converter.running && !converter.preparing;
    const run = $('#runPptxPdf'); const cancel = $('#cancelPptxPdf');
    const sourceLabel = detectedConversionSourceLabel();
    const actionLabel = converter.files.length && converter.targetExtension
      ? `${sourceLabel} ${converter.files.length}개를 ${shortFormatLabel(converter.targetExtension)}로 변환`
      : '일괄 변환';
    run.disabled = !ready; run.textContent = converter.running ? '변환 중…' : actionLabel;
    cancel.hidden = !converter.running; cancel.disabled = converter.cancelling; cancel.textContent = converter.cancelling ? '중단 요청됨…' : '변환 중단';
    if (converter.running) {
      if (converter.cancelling) {
        $('#pptxPdfRunTitle').textContent = '변환을 안전하게 중단하는 중';
        $('#pptxPdfRunStatus').textContent = '현재 처리 중인 파일을 마친 뒤 멈춥니다. 원본 파일은 바뀌지 않습니다.';
      }
      return;
    }
    $('#pptxPdfRunTitle').textContent = converter.routeChecking ? '변환 경로 확인 중' : ready ? `${sourceLabel} ${converter.files.length}개 변환 준비됨` : '변환 준비';
    $('#pptxPdfRunStatus').textContent = !converter.files.length
      ? '먼저 변환할 문서를 선택해주세요.'
      : conversionHasSourceMismatch()
      ? '선택한 원본 형식과 맞지 않는 파일이 있습니다. 목록은 유지되며, 위 안내에서 해결 방법을 확인할 수 있습니다.'
      : converter.routeChecking
      ? '원본 프로그램·필요 글꼴·결과 형식의 사용 가능 여부를 확인하고 있습니다.'
      : !converter.targetExtension
      ? '선택한 파일에 적용할 결과 형식을 선택해주세요.'
      : !converter.outputToken
      ? '결과를 저장할 폴더를 선택해주세요.'
      : !hasEngine
      ? '위의 준비 버튼을 누르면 필요한 구성요소를 자동으로 준비하거나 공식 설치 화면으로 이어집니다.'
      : converter.requiresPreview
      ? `원본 글꼴 사전 검사가 불가능한 형식이 있어 변환 후 ${targetLabel(converter.targetExtension)} 결과 미리보기를 확인합니다.`
      : `원본 파일은 바뀌지 않으며 같은 이름의 ${targetLabel(converter.targetExtension)}도 덮어쓰지 않습니다.`;
  }

  async function chooseConverterFiles() {
    if (converter.running || converter.preparing || converter.routeChecking) return;
    try {
      const sourceExtensions = selectedConversionSourceExtensions();
      const requestedSource = sourceExtensions[0] || '';
      const result = await DOCUMENT_CONVERSION_BRIDGE.chooseFiles(sourceExtensions);
      if (result.canceled) return;
      const seen = new Set(converter.files.map((file) => file.key || `${file.name}:${file.bytes}`));
      let addedAny = false;
      let skippedMismatch = 0;
      for (const file of result.files || []) {
        const key = file.key || `${file.name}:${file.bytes}`;
        if (seen.has(key)) continue;
        const extension = normalizeDocumentExtension(file.extension || file.name);
        if (requestedSource && extension !== requestedSource) { skippedMismatch += 1; continue; }
        seen.add(key); addedAny = true; converter.files.push({ ...file, extension, key, status: 'pending', error: '', outputName: '', outputFileToken: '', validation: null, engine: '' });
      }
      if (skippedMismatch) {
        notify(`${shortFormatLabel(requestedSource)}가 아닌 파일 ${skippedMismatch}개는 추가하지 않았습니다. 기존 목록은 그대로 유지됩니다.`, 'normal');
      }
      if (addedAny) {
        setConverterResultPending();
        syncLocalConversionTargets();
        await refreshConversionTargets();
      } else if (skippedMismatch) {
        renderConversionRoute();
      }
      renderConverterFiles();
    } catch (error) { notify(`문서 파일을 가져오지 못했습니다: ${error.message}`, 'error'); }
  }

  async function chooseConverterOutput() {
    if (converter.running || converter.preparing || converter.routeChecking) return;
    try {
      const result = await api().chooseDocumentOutputDirectory();
      if (result.canceled) return;
      converter.outputToken = result.token; converter.outputName = result.name;
      setConverterResultPending();
      const summary = $('#pptxPdfOutputSummary'); summary.replaceChildren(element('strong', '', result.name), element('span', '', `선택한 폴더에 ${targetLabel(converter.targetExtension)} 결과를 저장합니다.`));
      updateConverterReady();
    } catch (error) { notify(`저장 폴더를 선택하지 못했습니다: ${error.message}`, 'error'); }
  }

  async function runConverter() {
    if ($('#runPptxPdf').disabled) return;
    let finalTitle = ''; let finalStatus = '';
    converter.running = true; converter.cancelling = false; converter.requestId = crypto.randomUUID();
    converter.files.forEach((file) => { file.status = 'pending'; file.error = ''; file.outputName = ''; file.outputFileToken = ''; });
    $('#pptxPdfProgress').hidden = false; $('#pptxPdfProgress').max = converter.files.length; $('#pptxPdfProgress').value = 0;
    $('#openPptxPdfOutput').hidden = true;
    const resultLabel = targetLabel(converter.targetExtension);
    $('#pptxPdfRunTitle').textContent = `${resultLabel}로 변환 중`; $('#pptxPdfRunStatus').textContent = '파일 형식에 맞는 원본 프로그램으로 차례로 변환하고 있습니다.';
    renderConverterFiles();
    try {
      const result = await DOCUMENT_CONVERSION_BRIDGE.convert({ requestId: converter.requestId, fileTokens: converter.files.map((file) => file.token), outputToken: converter.outputToken, targetExtension: converter.targetExtension });
      if (result?.blocked) {
        converter.availability = { ...(converter.availability || {}), blocked: true, available: false, ready: false, missingDependencies: result.missingDependencies || [] };
        converter.preparationPlan = result.preparationPlan || converter.preparationPlan;
        converter.requiredFonts = Array.isArray(result.requiredFonts) ? result.requiredFonts.map(String) : converter.requiredFonts;
        converter.fontReports = Array.isArray(result.fontReports) ? result.fontReports : converter.fontReports;
        converter.inspectionUnavailable = Array.isArray(result.inspectionUnavailable) ? result.inspectionUnavailable : converter.inspectionUnavailable;
        converter.requiresPreview = result.requiresPreview === true;
        const message = result.runningDependencies?.length
          ? '문서 프로그램에서 작업 중인 파일을 보호하고 있습니다. 해당 프로그램을 닫은 뒤 다시 시도해주세요.'
          : '변환에 필요한 구성을 먼저 준비해주세요.';
        throw Object.assign(new Error(message), { code: 'DOCUMENT_DEPENDENCY_REQUIRED' });
      }
      converter.inspectionUnavailable = Array.isArray(result.inspectionUnavailable) ? result.inspectionUnavailable : [];
      converter.requiresPreview = result.requiresPreview === true;
      const previewRequiredTokens = new Set(converter.inspectionUnavailable.map((item) => String(item?.token || '')).filter(Boolean));
      (result.results || []).forEach((item, index) => {
        const file = converter.files[index]; if (!file) return;
        const requiresPreview = previewRequiredTokens.has(String(file.token || ''));
        const validation = item.validation ? { ...item.validation } : null;
        if (item.ok && requiresPreview) {
          file.validation = { ...(validation || { ok: true }), status: 'needsReview', reason: '원본 글꼴 사전 검사를 지원하지 않는 형식이므로 결과 확인이 필요합니다.' };
        } else file.validation = validation;
        file.status = item.ok ? 'complete' : 'failed'; file.outputName = item.outputName || ''; file.outputFileToken = item.outputFileToken || ''; file.error = item.error || ''; file.engine = item.engine || '';
      });
      $('#pptxPdfProgress').value = converter.files.length;
      finalTitle = result.failed ? `${result.completed}개 완료 · ${result.failed}개 확인 필요` : `${result.completed}개 변환 완료`;
      const reviewCount = converter.files.filter((file) => file.validation?.status === 'needsReview' || file.validation?.ok === false).length;
      finalStatus = result.failed ? '실패한 파일의 메시지를 확인한 뒤 다시 선택해 시도할 수 있습니다.' : reviewCount ? `${resultLabel} 저장은 완료했습니다. ${reviewCount}개 파일은 결과 미리보기에서 형식 검증 내용을 확인해주세요.` : `모든 ${resultLabel} 결과를 선택한 폴더에 저장했습니다.`;
      $('#pptxPdfRunTitle').textContent = finalTitle; $('#pptxPdfRunStatus').textContent = finalStatus;
      $('#openPptxPdfOutput').hidden = result.completed === 0;
      notify(result.failed ? `${resultLabel} ${result.completed}개를 만들었고 ${result.failed}개는 확인이 필요합니다.` : reviewCount ? `${resultLabel} ${result.completed}개를 만들었습니다. 결과 미리보기를 확인해주세요.` : `${resultLabel} ${result.completed}개를 만들었습니다.`, result.failed || reviewCount ? 'normal' : 'success');
      reportWorkflowStatus('documentEditor', result.failed || reviewCount ? 'needsReview' : 'complete', finalTitle, { documentMode: 'pptxPdf' });
    } catch (error) {
      const cancelled = isDocumentToolCancellation(error);
      if (cancelled) converter.files.forEach((file) => { if (!['complete', 'failed'].includes(file.status)) file.status = 'cancelled'; });
      finalTitle = cancelled ? '문서 변환을 중단했습니다.' : '변환을 완료하지 못했습니다.';
      finalStatus = cancelled ? '중단 전에 임시로 변환된 내용은 정리했습니다. 원본 문서는 그대로입니다.' : error.message;
      $('#pptxPdfRunTitle').textContent = finalTitle; $('#pptxPdfRunStatus').textContent = finalStatus;
      notify(cancelled ? '문서 변환을 중단했습니다.' : `문서 변환 실패: ${error.message}`, cancelled ? 'normal' : 'error');
      if (!cancelled) reportWorkflowStatus('documentEditor', 'needsReview', '변환 오류를 확인해주세요.', { documentMode: 'pptxPdf' });
      if (!cancelled) await refreshCapabilities(true);
    } finally {
      converter.running = false; converter.cancelling = false; converter.requestId = ''; renderConverterFiles(); updateConverterReady();
      if (finalTitle) { $('#pptxPdfRunTitle').textContent = finalTitle; $('#pptxPdfRunStatus').textContent = finalStatus; }
    }
  }

  async function cancelConverter() {
    if (!converter.running || converter.cancelling) return;
    if (guideDemo.active) { notify('가이드에서는 실제 변환 작업을 중단하지 않습니다.'); return; }
    converter.cancelling = true; updateConverterReady();
    try {
      const result = await api().cancelDocumentToolJob(converter.requestId);
      if (!result?.ok) {
        converter.cancelling = false; updateConverterReady();
        $('#pptxPdfRunStatus').textContent = '작업이 이미 마무리 중입니다. 결과를 확인하고 있습니다.';
      }
    } catch (error) {
      converter.cancelling = false; updateConverterReady();
      $('#pptxPdfRunStatus').textContent = `중단 요청을 보내지 못했습니다: ${error.message}`;
      notify(`변환 중단 요청 실패: ${error.message}`, 'error');
    }
  }

  function activeMergeMeta() {
    return DOCUMENT_MODE_META[documentMode]?.kind ? DOCUMENT_MODE_META[documentMode] : null;
  }

  function activeMergeState() {
    return activeMergeMeta() ? mergeStates[documentMode] : null;
  }

  function activeSplitMeta() {
    return DOCUMENT_SPLIT_META[documentSplitKind] || DOCUMENT_SPLIT_META.pdf;
  }

  function activeSplitState() {
    return splitStates[documentSplitKind] || splitStates.pdf;
  }

  function splitFileCount(file, meta) {
    if (!file) return 0;
    const candidates = meta.kind === 'pptx'
      ? [file.slideCount, file.sourceUnitCount, file.slides, file.metadata?.slideCount, file.count]
      : [file.pageCount, file.sourceUnitCount, file.pages, file.metadata?.pageCount, file.count];
    const value = candidates.filter((candidate) => candidate !== null && candidate !== undefined && candidate !== '').map(Number).find((candidate) => Number.isFinite(candidate) && candidate >= 0);
    return value === undefined ? 0 : Math.floor(value);
  }

  function normalizeSplitFile(file, meta) {
    const count = splitFileCount(file, meta);
    return {
      ...file,
      token: String(file?.token || file?.fileToken || ''),
      name: String(file?.name || `선택한 ${meta.label} 파일`),
      bytes: Number(file?.bytes || 0),
      [meta.countKey]: count
    };
  }

  function splitSourceStem(state, meta) {
    const escaped = meta.extension.replace('.', '\\.');
    const source = String(state.file?.name || `${meta.label} 문서`).replace(new RegExp(`${escaped}$`, 'i'), '');
    return safeCertificateFilenameStem(source, `${meta.label} 문서`);
  }

  function cleanSplitResultName(value, fallback, meta) {
    const escaped = meta.extension.replace('.', '\\.');
    return safeCertificateFilenameStem(String(value || '').replace(new RegExp(`${escaped}$`, 'i'), ''), fallback);
  }

  function splitNameWithExtension(value, fallback, meta) {
    return `${cleanSplitResultName(value, fallback, meta)}${meta.extension}`;
  }

  function splitUnitWithParticle(unit, role) {
    const hasBatchim = unit === '쪽';
    const particle = role === 'object' ? (hasBatchim ? '을' : '를') : role === 'subject' ? (hasBatchim ? '이' : '가') : (hasBatchim ? '은' : '는');
    return `${unit}${particle}`;
  }

  function splitUnitLabel(meta) {
    return meta.kind === 'pdf' ? '페이지' : '슬라이드';
  }

  function parseSplitPageExpression(value, total, unit) {
    const source = String(value || '').trim();
    if (!source) return { ok: false, pages: [], error: `${unit} 번호를 입력해주세요.` };
    const tokens = source.split(/[,，]/).map((token) => token.trim());
    if (tokens.some((token) => !token)) return { ok: false, pages: [], error: '쉼표 앞뒤에 빈 항목이 있습니다.' };
    const pages = []; const seen = new Set();
    for (const token of tokens) {
      const match = token.match(/^(\d+)\s*(?:[-–—~]\s*(\d+))?$/);
      if (!match) return { ok: false, pages: [], error: `“${token}” 형식을 확인해주세요. 예: 1, 3, 5-6` };
      const start = Number(match[1]); const end = Number(match[2] || match[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) return { ok: false, pages: [], error: `${unit} 번호는 1 이상의 정수여야 합니다.` };
      if (end < start) return { ok: false, pages: [], error: `“${token}” 범위는 작은 번호부터 입력해주세요.` };
      if (start > total || end > total) return { ok: false, pages: [], error: `“${token}”에 전체 ${total}${splitUnitWithParticle(unit, 'object')} 벗어난 번호가 있습니다.` };
      for (let page = start; page <= end; page += 1) {
        if (seen.has(page)) return { ok: false, pages: [], error: `${page}${splitUnitWithParticle(unit, 'subject')} 같은 그룹에 두 번 들어 있습니다.` };
        seen.add(page); pages.push(page);
      }
    }
    return { ok: true, pages: pages.sort((left, right) => left - right), error: '' };
  }

  function compactSplitPages(pages, unit = '') {
    const values = (pages || []).map(Number).filter(Number.isFinite);
    if (!values.length) return '없음';
    const ranges = []; let start = values[0]; let previous = values[0];
    const flush = () => { ranges.push(start === previous ? String(start) : `${start}–${previous}`); };
    for (let index = 1; index < values.length; index += 1) {
      const current = values[index];
      if (current === previous + 1) { previous = current; continue; }
      flush(); start = current; previous = current;
    }
    flush();
    return `${ranges.join(', ')}${unit}`;
  }

  function buildSplitPlan(state = activeSplitState(), meta = activeSplitMeta()) {
    const total = splitFileCount(state.file, meta);
    const plan = { valid: false, total, groups: [], errors: [], warnings: [], groupErrors: new Map(), equalError: '', selectedPages: [], unassigned: [] };
    const addGroupError = (groupId, message) => {
      const messages = plan.groupErrors.get(groupId) || [];
      if (!messages.includes(message)) messages.push(message);
      plan.groupErrors.set(groupId, messages);
      if (!plan.errors.includes(message)) plan.errors.push(message);
    };
    if (!state.file?.token) { plan.errors.push(`나눌 ${meta.label} 파일을 선택해주세요.`); return plan; }
    if (total < 1) { plan.errors.push(`선택한 파일의 전체 ${meta.unit} 수를 확인하지 못했습니다.`); return plan; }
    const sourceStem = splitSourceStem(state, meta);
    if (state.method === 'equal') {
      const size = Number(state.equalSize);
      if (!Number.isInteger(size) || size < 1) {
        plan.equalError = `파일 하나당 ${meta.unit} 수는 1 이상의 정수여야 합니다.`;
        plan.errors.push(plan.equalError);
      } else if (Math.ceil(total / size) > 500) {
        plan.equalError = `결과 파일은 최대 500개까지 만들 수 있습니다. 파일 하나당 ${meta.unit} 수를 ${Math.ceil(total / 500)} 이상으로 입력해주세요.`;
        plan.errors.push(plan.equalError);
      } else {
        for (let first = 1, index = 0; first <= total; first += size, index += 1) {
          const last = Math.min(total, first + size - 1);
          const pages = Array.from({ length: last - first + 1 }, (_item, offset) => first + offset);
          const fallback = `${sourceStem}_${first}-${last}`;
          plan.groups.push({ id: `equal-${index + 1}`, pages, filename: splitNameWithExtension(fallback, fallback, meta), label: `${first}–${last}${meta.unit}` });
        }
      }
    } else {
      if (!state.groups.length) plan.errors.push(`${splitUnitLabel(meta)} 그룹을 하나 이상 추가해주세요.`);
      if (state.groups.length > 500) plan.errors.push(`${splitUnitLabel(meta)} 그룹은 최대 500개까지 만들 수 있습니다.`);
      state.groups.forEach((group, index) => {
        const parsed = parseSplitPageExpression(group.pages, total, meta.unit);
        if (!parsed.ok) { addGroupError(group.id, `${index + 1}번 그룹: ${parsed.error}`); return; }
        const fallback = `${sourceStem}_그룹-${String(index + 1).padStart(2, '0')}`;
        const filename = splitNameWithExtension(group.name, fallback, meta);
        plan.groups.push({ id: group.id, pages: parsed.pages, filename, label: compactSplitPages(parsed.pages, meta.unit) });
      });
      const pageOwners = new Map();
      plan.groups.forEach((group) => {
        group.pages.forEach((page) => {
          const owner = pageOwners.get(page);
          if (!owner) { pageOwners.set(page, group); return; }
          addGroupError(owner.id, `${page}${splitUnitWithParticle(meta.unit, 'subject')} 여러 그룹에 중복되었습니다.`);
          addGroupError(group.id, `${page}${splitUnitWithParticle(meta.unit, 'subject')} 여러 그룹에 중복되었습니다.`);
        });
      });
      const nameOwners = new Map();
      plan.groups.forEach((group) => {
        const key = group.filename.toLocaleLowerCase('ko-KR'); const owner = nameOwners.get(key);
        if (!owner) { nameOwners.set(key, group); return; }
        addGroupError(owner.id, `결과 파일 이름 “${group.filename}”이 중복됩니다.`);
        addGroupError(group.id, `결과 파일 이름 “${group.filename}”이 중복됩니다.`);
      });
    }
    const selected = new Set(plan.groups.flatMap((group) => group.pages));
    plan.selectedPages = [...selected].sort((left, right) => left - right);
    plan.unassigned = Array.from({ length: total }, (_item, index) => index + 1).filter((page) => !selected.has(page));
    if (state.method === 'custom' && plan.unassigned.length) plan.warnings.push(`선택하지 않은 ${splitUnitWithParticle(meta.unit, 'subject')} 있습니다: ${compactSplitPages(plan.unassigned)}. 결과 파일에는 포함되지 않습니다.`);
    plan.valid = plan.errors.length === 0 && plan.groups.length > 0;
    return plan;
  }

  function splitPlanSignature(state, plan, meta) {
    return JSON.stringify({
      kind: meta.kind, method: state.method, fileToken: state.file?.token || '', outputToken: state.outputToken || '',
      groups: plan.groups.map((group) => ({ name: group.filename, pages: group.pages }))
    });
  }

  function setSplitResultPending(state) {
    state.completed = false; state.outcome = ''; state.results = []; state.progressValue = 0; state.progressVisible = false;
    state.engine = ''; state.compatibilityFallback = false; state.requiresPreview = false; state.warnings = [];
    $('#documentSplitProgress').hidden = true; $('#documentSplitProgress').value = 0;
    $('#documentSplitResults').hidden = true; $('#documentSplitResults').replaceChildren();
    $('#openDocumentSplitOutput').hidden = true;
  }

  function splitCapabilityPolicy(meta = activeSplitMeta()) {
    if (guideDemo.active) return { available: true, engine: 'guide', compatibilityFallback: false, requiresPreview: false, reason: '' };
    if (meta.kind === 'pdf') return { available: true, engine: 'pdf-lib', compatibilityFallback: false, requiresPreview: false, reason: '' };
    const status = converter.capabilities || {};
    const powerPointReady = Boolean(status.powerPoint && !status.powerPointRunning);
    return {
      available: true,
      engine: powerPointReady ? 'powerpoint' : 'pptx-package',
      compatibilityFallback: !powerPointReady,
      requiresPreview: !powerPointReady,
      reason: status.powerPointRunning ? 'running' : powerPointReady ? '' : 'missing'
    };
  }

  function splitCapabilitySignature(meta = activeSplitMeta(), policy = splitCapabilityPolicy(meta)) {
    return JSON.stringify({ kind: meta.kind, engine: policy.engine, compatibilityFallback: policy.compatibilityFallback, reason: policy.reason });
  }

  function renderSplitFidelityNotice(meta, policy) {
    const notice = $('#documentSplitFidelityNotice');
    const badge = $('#documentSplitFormatBadge');
    const visible = !guideDemo.active && meta.kind === 'pptx' && policy.compatibilityFallback;
    notice.hidden = !visible;
    if (visible) badge.setAttribute('aria-describedby', notice.id);
    else badge.removeAttribute('aria-describedby');
    if (!visible) return;
    const title = policy.reason === 'running'
      ? 'PowerPoint가 열려 있어 내장 분할을 사용합니다.'
      : 'PowerPoint 없이 내장 분할을 사용합니다.';
    notice.replaceChildren(
      element('strong', '', title),
      element('span', '', '원본은 바뀌지 않지만 일부 글꼴·배치·애니메이션·미디어 동작은 달라질 수 있습니다. 슬라이드를 제외하는 결과에서는 숨은 제목 목록과 검토 댓글·댓글 작성자 정보도 함께 제거됩니다. 완료 후 결과를 확인해주세요.')
    );
  }

  function renderSplitCapability(meta = activeSplitMeta()) {
    const badge = $('#documentSplitFormatBadge');
    const policy = splitCapabilityPolicy(meta);
    if (guideDemo.active) {
      badge.className = 'engine-badge ready'; setEngineBadgeApplication(badge); setEngineBadgeText(badge, '가이드 분할 환경'); badge.title = '실제 파일을 열거나 저장하지 않고 나누기 흐름을 연습합니다.'; renderSplitFidelityNotice(meta, policy); return policy;
    }
    if (meta.kind === 'pdf') {
      badge.className = 'engine-badge ready'; setEngineBadgeApplication(badge); setEngineBadgeText(badge, '별도 프로그램 필요 없음'); badge.title = 'PDF 페이지를 새 PDF 파일로 안전하게 복사합니다.'; renderSplitFidelityNotice(meta, policy); return policy;
    }
    if (!policy.compatibilityFallback) {
      badge.className = 'engine-badge ready'; setEngineBadgeApplication(badge, 'powerpoint'); setEngineBadgeText(badge, 'Microsoft PowerPoint 우선'); badge.title = 'PowerPoint로 원본 슬라이드의 테마·글꼴·미디어를 유지해 먼저 나눕니다.'; renderSplitFidelityNotice(meta, policy); return policy;
    }
    badge.className = 'engine-badge limited'; setEngineBadgeApplication(badge); setEngineBadgeText(badge, '내장 분할 · 결과 확인 필요');
    badge.title = policy.reason === 'running'
      ? '열려 있는 PowerPoint 문서를 건드리지 않고 내장 방식으로 나눕니다. 완료 후 결과를 확인해주세요.'
      : 'PowerPoint가 없어 내장 방식으로 나눕니다. 완료 후 결과를 확인해주세요.';
    renderSplitFidelityNotice(meta, policy);
    return policy;
  }

  function renderSplitSource(state, meta) {
    $('#documentSplitChooseLabel').textContent = `${meta.label} 파일 선택`;
    const summary = $('#documentSplitSourceSummary');
    if (!state.file) {
      summary.replaceChildren(element('strong', '', '나눌 파일을 선택해주세요.'), element('span', '', `파일을 고르면 전체 ${meta.unit} 수가 표시됩니다.`));
      return;
    }
    const count = splitFileCount(state.file, meta);
    const detail = [count ? `전체 ${count}${meta.unit}` : `전체 ${meta.unit} 수 확인 필요`, state.file.bytes ? formatBytes(state.file.bytes) : '', '원본은 변경하지 않음'].filter(Boolean).join(' · ');
    summary.replaceChildren(element('strong', '', state.file.name), element('span', '', detail));
  }

  function renderSplitGroups(state, meta, plan = buildSplitPlan(state, meta)) {
    const container = $('#documentSplitGroups'); container.replaceChildren();
    state.groups.forEach((group, index) => {
      const row = element('div', 'document-split-group'); row.dataset.documentSplitGroup = group.id;
      const order = element('span', 'document-split-group-number', String(index + 1));
      const unitLabel = splitUnitLabel(meta);
      const pageLabel = element('label', 'form-field'); pageLabel.setAttribute('for', `documentSplitPages-${group.id}`); pageLabel.append(element('span', '', `${unitLabel} 번호`));
      const pages = element('input'); pages.id = `documentSplitPages-${group.id}`; pages.type = 'text'; pages.inputMode = 'numeric'; pages.maxLength = 2000; pages.autocomplete = 'off'; pages.spellcheck = false; pages.placeholder = '예: 1, 3, 5-6'; pages.value = group.pages; pages.dataset.documentSplitPages = group.id;
      const errorId = `documentSplitGroupError-${group.id}`; pages.setAttribute('aria-describedby', `${errorId} documentSplitValidationSummary`);
      pageLabel.append(pages);
      const nameLabel = element('label', 'form-field'); nameLabel.setAttribute('for', `documentSplitName-${group.id}`); nameLabel.append(element('span', '', '파일 이름 (선택)'));
      const name = element('input'); name.id = `documentSplitName-${group.id}`; name.type = 'text'; name.maxLength = 120; name.autocomplete = 'off'; name.spellcheck = false; name.placeholder = `${splitSourceStem(state, meta)}_그룹-${String(index + 1).padStart(2, '0')}`; name.value = group.name; name.dataset.documentSplitName = group.id; name.setAttribute('aria-describedby', `${errorId} documentSplitValidationSummary`);
      nameLabel.append(name);
      const locked = state.running || state.confirming;
      const remove = element('button', 'document-file-remove', '×'); remove.type = 'button'; remove.dataset.documentSplitRemove = group.id; remove.setAttribute('aria-label', `${index + 1}번 ${unitLabel} 그룹 삭제`); remove.disabled = locked || state.groups.length <= 1;
      const errors = plan.groupErrors.get(group.id) || [];
      const error = element('p', 'document-split-group-error', errors.join(' ')); error.id = errorId; error.hidden = !errors.length;
      pages.setAttribute('aria-invalid', String(errors.some((message) => !message.includes('파일 이름')))); name.setAttribute('aria-invalid', String(errors.some((message) => message.includes('파일 이름'))));
      pages.disabled = locked; name.disabled = locked;
      row.append(order, pageLabel, nameLabel, remove, error); container.append(row);
    });
  }

  function applySplitFieldErrors(state, plan) {
    $('#documentSplitEqualSize').setAttribute('aria-invalid', String(Boolean(plan.equalError)));
    state.groups.forEach((group) => {
      const messages = plan.groupErrors.get(group.id) || [];
      const pages = $(`[data-document-split-pages="${group.id}"]`); const name = $(`[data-document-split-name="${group.id}"]`); const error = $(`#documentSplitGroupError-${group.id}`);
      if (pages) pages.setAttribute('aria-invalid', String(messages.some((message) => !message.includes('파일 이름'))));
      if (name) name.setAttribute('aria-invalid', String(messages.some((message) => message.includes('파일 이름'))));
      if (error) { error.textContent = messages.join(' '); error.hidden = !messages.length; }
    });
  }

  function renderSplitPlanPreview(state, meta, plan = buildSplitPlan(state, meta)) {
    const preview = $('#documentSplitPlanPreview'); preview.replaceChildren();
    if (!state.file || !plan.groups.length) {
      const empty = element('div', 'document-merge-preview-empty');
      empty.append(element('strong', '', state.file ? '나눌 구성을 확인해주세요.' : '아직 확인할 구성이 없습니다.'), element('span', '', state.file ? `올바른 분량 또는 ${splitUnitLabel(meta)} 그룹을 입력하면 결과가 표시됩니다.` : '왼쪽에서 파일과 나누는 방법을 정해주세요.'));
      preview.append(empty);
    } else {
      plan.groups.forEach((group, index) => {
        const item = element('div', 'document-split-plan-item');
        const order = element('span', 'document-split-plan-order', String(index + 1));
        const copy = element('div', 'document-split-plan-copy');
        copy.append(element('strong', '', group.filename), element('small', '', `${group.pages.length}${meta.unit} · ${group.label}`));
        item.append(order, copy); preview.append(item);
      });
    }
    const metrics = $('#documentSplitTotals').children;
    metrics[0].querySelector('strong').textContent = String(plan.groups.length);
    metrics[1].querySelector('small').textContent = `선택한 ${meta.unit}`;
    metrics[1].querySelector('strong').textContent = String(plan.selectedPages.length);
    metrics[2].querySelector('small').textContent = `선택 안 한 ${meta.unit}`;
    metrics[2].querySelector('strong').textContent = state.file ? String(plan.unassigned.length) : '0';
  }

  function renderSplitValidation(state, meta, plan = buildSplitPlan(state, meta)) {
    const summary = $('#documentSplitValidationSummary');
    if (!state.file) {
      summary.className = 'notice info document-split-validation';
      summary.replaceChildren(element('strong', '', '파일을 선택하면 나눌 구성을 미리 보여드립니다.'));
      return;
    }
    if (plan.errors.length) {
      summary.className = 'notice error document-split-validation';
      const extra = plan.errors.length > 1 ? ` 외 ${plan.errors.length - 1}개 문제` : '';
      summary.replaceChildren(element('strong', '', `${plan.errors[0]}${extra}`));
      return;
    }
    if (plan.unassigned.length) {
      summary.className = 'notice warning document-split-validation';
      summary.replaceChildren(element('strong', '', `${compactSplitPages(plan.unassigned)}${splitUnitWithParticle(meta.unit, 'subject')} 선택되지 않았습니다.`), element('span', '', `계속 나누면 이 ${splitUnitWithParticle(meta.unit, 'topic')} 어떤 결과 파일에도 포함되지 않습니다.`));
      return;
    }
    summary.className = 'notice info document-split-validation';
    summary.replaceChildren(element('strong', '', `${plan.groups.length}개 파일에 전체 ${plan.total}${splitUnitWithParticle(meta.unit, 'subject')} 모두 포함됩니다.`));
  }

  function renderSplitOutputLocation(state) {
    const summary = $('#documentSplitOutputSummary');
    if (state.outputToken) summary.replaceChildren(element('strong', '', state.outputName || '선택한 폴더'), element('span', '', '나눈 파일을 모두 이 폴더에 저장합니다.'));
    else summary.replaceChildren(element('strong', '', '저장 폴더를 선택해주세요.'), element('span', '', '원본 파일은 변경하지 않습니다.'));
  }

  function renderSplitResults(state, meta) {
    const container = $('#documentSplitResults'); container.replaceChildren();
    state.results.forEach((result, index) => {
      const row = element('div', 'document-split-result-row');
      if (state.requiresPreview || result.requiresPreview) row.classList.add('needs-review');
      const copy = element('div', 'document-split-result-copy');
      const reviewLabel = state.requiresPreview || result.requiresPreview ? ' · 내장 분할 · 확인 권장' : '';
      copy.append(element('strong', '', result.outputName), element('small', '', `${result.pages.length}${meta.unit} · ${compactSplitPages(result.pages, meta.unit)}${reviewLabel}`));
      row.append(copy);
      if (result.outputFileToken) {
        const preview = element('button', 'document-result-row-button', '결과 미리보기'); preview.type = 'button'; preview.dataset.documentSplitPreview = String(index); preview.setAttribute('aria-label', `${result.outputName} 결과 미리보기`); preview.disabled = state.running || state.confirming; row.append(preview);
      }
      container.append(row);
    });
    container.hidden = !state.completed || !state.results.length;
  }

  function updateSplitReady(state = activeSplitState(), meta = activeSplitMeta(), plan = buildSplitPlan(state, meta)) {
    if (!state || !meta) return;
    const policy = renderSplitCapability(meta);
    const locked = state.running || state.confirming;
    const ready = Boolean(state.file?.token && state.outputToken && plan.valid && policy.available && !locked);
    const run = $('#runDocumentSplit'); const cancel = $('#cancelDocumentSplit');
    run.disabled = !ready; run.textContent = state.running ? '나누는 중…' : state.confirming ? '실행 확인 중…' : `${meta.label} 파일 나누기`;
    cancel.hidden = !state.running; cancel.disabled = state.cancelling; cancel.textContent = state.cancelling ? '중단 요청됨…' : '작업 중단';
    $('#chooseDocumentSplitFile').disabled = locked;
    $('#chooseDocumentSplitOutput').disabled = locked;
    $('#documentSplitMethodEqual').disabled = locked; $('#documentSplitMethodCustom').disabled = locked;
    $('#documentSplitEqualSize').disabled = locked; $('#addDocumentSplitGroup').disabled = locked || state.groups.length >= 500;
    $$('button[data-document-mode]', $('#page-documentEditor')).forEach((button) => { button.disabled = locked; });
    $$('[data-document-split-kind]', $('#documentSplitModeSwitch')).forEach((button) => { button.disabled = Object.values(splitStates).some((item) => item.running || item.confirming); });
    $$('[data-document-split-pages], [data-document-split-name]', $('#documentSplitGroups')).forEach((input) => { input.disabled = locked; });
    $$('[data-document-split-remove]', $('#documentSplitGroups')).forEach((button) => { button.disabled = locked || state.groups.length <= 1; });
    if (state.running) {
      state.runTitle = state.cancelling ? '안전하게 중단하는 중' : `${meta.label} 파일을 나누는 중`;
      state.runStatus = state.cancelling ? '현재 결과 파일 처리를 마친 뒤 멈춥니다. 원본 파일은 그대로입니다.' : `${plan.groups.length}개 결과 파일을 순서대로 만들고 있습니다.`;
    } else if (!state.outcome) {
      state.runTitle = ready ? `${plan.groups.length}개 결과 파일 준비됨` : '나누기 준비';
      state.runStatus = !state.file?.token
        ? `나눌 ${meta.label} 파일을 선택해주세요.`
        : !plan.valid
        ? plan.errors[0] || '나눌 구성을 확인해주세요.'
        : !state.outputToken
        ? '결과를 저장할 폴더를 선택해주세요.'
        : meta.kind === 'pptx' && policy.compatibilityFallback
        ? `${plan.groups.length}개 파일을 내장 분할로 만들 수 있습니다. 실행 전 형식 변화 가능성${plan.unassigned.length ? `과 선택하지 않은 ${plan.unassigned.length}개 슬라이드` : ''}을 한 번 더 확인합니다.`
        : plan.unassigned.length
        ? `${plan.groups.length}개 파일을 만들 수 있습니다. 선택하지 않은 ${plan.unassigned.length}${splitUnitWithParticle(meta.unit, 'topic')} 실행 전에 한 번 더 알려드립니다.`
        : `${plan.groups.length}개 ${meta.label} 파일을 만들 준비가 되었습니다.`;
    }
    $('#documentSplitRunTitle').textContent = state.runTitle; $('#documentSplitRunStatus').textContent = state.runStatus;
  }

  function renderSplitPlanning(state = activeSplitState(), meta = activeSplitMeta(), options = {}) {
    const plan = buildSplitPlan(state, meta);
    if (options.groups) renderSplitGroups(state, meta, plan); else applySplitFieldErrors(state, plan);
    renderSplitPlanPreview(state, meta, plan); renderSplitValidation(state, meta, plan); updateSplitReady(state, meta, plan);
    return plan;
  }

  function renderDocumentSplit() {
    const state = activeSplitState(); const meta = activeSplitMeta();
    $('#documentSplitTitle').textContent = `${meta.label} 나누기`;
    $('#documentSplitDescription').textContent = meta.kind === 'pdf'
      ? '한 PDF를 원하는 쪽으로 나눕니다. 페이지 화면은 유지되지만 문서 전체 목차·전자서명·양식·첨부는 결과에 이어지지 않을 수 있습니다.'
      : '한 PPTX를 일정한 슬라이드 수 또는 직접 정한 슬라이드 그룹으로 나눕니다.';
    $$('[data-document-split-kind]', $('#documentSplitModeSwitch')).forEach((button) => {
      const active = button.dataset.documentSplitKind === documentSplitKind;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    $('#documentSplitRuleTitle').textContent = `${splitUnitWithParticle(meta.unit, 'object')} 나누는 방법`;
    $('#documentSplitRuleTitle').nextElementSibling.textContent = `같은 분량으로 순서대로 나누거나 ${meta.unit} 그룹을 직접 정하세요.`;
    $('#documentSplitPreviewTitle').textContent = `나눌 ${meta.unit}와 결과 확인`;
    $('#documentSplitPreviewTitle').nextElementSibling.textContent = `만들 파일 이름과 각 파일에 들어갈 ${splitUnitWithParticle(meta.unit, 'object')} 확인하세요.`;
    $('label[for="documentSplitMethodCustom"] strong').textContent = `${splitUnitLabel(meta)} 그룹 직접 지정`;
    $('label[for="documentSplitMethodCustom"] small').textContent = `그룹마다 ${splitUnitLabel(meta)} 번호와 파일 이름 입력`;
    $('.document-split-custom-controls > .field-help').innerHTML = `쉼표와 범위를 함께 쓸 수 있습니다. 예: <strong>1, 3, 5-6</strong>`;
    $('#documentSplitMethodEqual').checked = state.method === 'equal'; $('#documentSplitMethodCustom').checked = state.method === 'custom';
    $('#documentSplitEqualControls').hidden = state.method !== 'equal'; $('#documentSplitCustomControls').hidden = state.method !== 'custom';
    $('#documentSplitEqualUnitLabel').textContent = `${meta.unit} 수`; $('#documentSplitEqualSize').value = String(state.equalSize);
    renderSplitSource(state, meta); renderSplitOutputLocation(state);
    $('#documentSplitProgress').max = Math.max(1, state.results.length || buildSplitPlan(state, meta).groups.length); $('#documentSplitProgress').value = state.progressValue || 0; $('#documentSplitProgress').hidden = !state.progressVisible;
    renderSplitResults(state, meta); renderSplitPlanning(state, meta, { groups: true });
    $('#openDocumentSplitOutput').hidden = !state.completed;
  }

  function setDocumentSplitKind(kind, options = {}) {
    if (!DOCUMENT_SPLIT_META[kind]) return false;
    if (!options.force && documentSplitKind !== kind && Object.values(splitStates).some((state) => state.running || state.confirming)) {
      notify('진행 중인 파일 나누기를 마치거나 중단한 뒤 형식을 바꿔주세요.'); return false;
    }
    documentSplitKind = kind; renderDocumentSplit();
    if (options.refresh !== false && !guideDemo.active && kind === 'pptx' && pageIsActive('documentSplit')) void refreshCapabilities(true);
    if (options.focus) $(`[data-document-split-kind="${kind}"]`)?.focus();
    return true;
  }

  async function chooseSplitFile() {
    const state = activeSplitState(); const meta = activeSplitMeta(); if (state.running || state.confirming) return;
    if (guideDemo.active) { notify('가이드의 파일 선택 단계에서 샘플 파일을 사용해주세요.'); return; }
    try {
      const result = await DOCUMENT_SPLIT_BRIDGE.chooseFile(meta.kind); if (result?.canceled) return;
      const rawFile = result?.file || result?.files?.[0] || (result?.token || result?.fileToken ? result : null);
      if (!rawFile) throw new Error('선택한 파일 정보를 받지 못했습니다.');
      const file = normalizeSplitFile(rawFile, meta);
      if (!file.token) throw new Error('선택한 파일을 안전하게 읽을 수 없습니다. 다시 선택해주세요.');
      state.file = file; setSplitResultPending(state); renderDocumentSplit();
      if (!splitFileCount(file, meta)) notify(`파일은 선택했지만 전체 ${meta.unit} 수를 확인하지 못했습니다. 파일을 다시 확인해주세요.`, 'error');
    } catch (error) { notify(`${meta.label} 파일을 가져오지 못했습니다: ${error.message}`, 'error'); }
  }

  async function chooseSplitOutput() {
    const state = activeSplitState(); const meta = activeSplitMeta(); if (state.running || state.confirming) return;
    if (guideDemo.active) { notify('가이드의 저장 위치 단계에서 모의 폴더를 사용해주세요.'); return; }
    try {
      const result = await DOCUMENT_SPLIT_BRIDGE.chooseOutput(); if (result?.canceled) return;
      state.outputToken = String(result?.token || result?.outputToken || ''); state.outputName = String(result?.name || result?.outputName || '선택한 폴더');
      if (!state.outputToken) throw new Error('선택한 저장 폴더 정보를 받지 못했습니다.');
      setSplitResultPending(state); renderDocumentSplit();
    } catch (error) { notify(`저장 폴더를 선택하지 못했습니다: ${error.message}`, 'error'); }
  }

  function splitConfirmationCopy(meta, plan, policy) {
    const paragraphs = [];
    if (meta.kind === 'pptx') {
      paragraphs.push(policy.compatibilityFallback
        ? policy.reason === 'running'
          ? '• PowerPoint가 열려 있어 작업 중인 문서를 건드리지 않고 내장 분할을 사용합니다.'
          : '• 이 PC에서 PowerPoint를 사용할 수 없어 내장 분할을 사용합니다.'
        : '• Microsoft PowerPoint로 먼저 나눕니다. 실행 중 PowerPoint를 사용할 수 없으면 내장 분할로 전환될 수 있습니다.');
      paragraphs.push('• 내장 분할 결과는 일부 글꼴·배치·애니메이션·미디어 동작이 달라질 수 있으므로 완료 후 결과를 확인해주세요.');
      paragraphs.push('• 슬라이드를 제외하는 결과에서는 빠진 슬라이드의 정보가 남지 않도록 숨은 제목 목록과 검토 댓글·댓글 작성자 정보를 함께 제거합니다.');
    }
    if (plan.unassigned.length) {
      const unitLabel = meta.kind === 'pdf' ? '페이지' : '슬라이드';
      paragraphs.push(`• 선택되지 않은 ${unitLabel} 번호 ${compactSplitPages(plan.unassigned)}는 어떤 결과 파일에도 포함되지 않습니다.`);
    }
    paragraphs.push('원본 파일은 변경하지 않고 새 파일만 만듭니다.');
    return paragraphs.join('\n\n');
  }

  async function runDocumentSplit() {
    const state = activeSplitState(); const meta = activeSplitMeta(); let plan = buildSplitPlan(state, meta); let policy = renderSplitCapability(meta);
    if (state.running || state.confirming || !plan.valid || !state.outputToken || !policy.available) return;
    if (guideDemo.active) { notify('가이드의 나누기 실행 단계에서 모의 완료를 사용해주세요.'); return; }
    const signature = splitPlanSignature(state, plan, meta); const capabilitySignature = splitCapabilitySignature(meta, policy);
    let omissionsConfirmed = false; let compatibilityFallbackApproved = false;
    const confirmationRequired = meta.kind === 'pptx' || (state.method === 'custom' && plan.unassigned.length > 0);
    if (confirmationRequired) {
      const unitLabel = meta.kind === 'pdf' ? '페이지' : '슬라이드';
      state.confirming = true; updateSplitReady(state, meta, plan);
      let confirmed = false; let confirmError = null;
      try {
        confirmed = await confirmAction(splitConfirmationCopy(meta, plan, policy), {
          title: meta.kind === 'pptx' ? 'PPTX 나누기 전 확인' : `선택되지 않은 ${unitLabel}가 있습니다`,
          action: '확인하고 나누기',
          danger: false
        });
      }
      catch (error) { confirmError = error; }
      finally { state.confirming = false; }
      if (confirmError) { updateSplitReady(state, meta, buildSplitPlan(state, meta)); notify(`나누기 확인창을 열지 못했습니다: ${confirmError.message}`, 'error'); return; }
      if (!confirmed) { updateSplitReady(state, meta, buildSplitPlan(state, meta)); return; }
      if (documentMode !== 'documentSplit' || activeSplitState() !== state || activeSplitMeta() !== meta) { renderDocumentSplit(); notify('확인하는 동안 나누기 화면이 바뀌었습니다. 내용을 다시 확인해주세요.'); return; }
      plan = buildSplitPlan(state, meta);
      if (!plan.valid || splitPlanSignature(state, plan, meta) !== signature) { notify('확인하는 동안 나누기 구성이 바뀌었습니다. 내용을 다시 확인해주세요.'); renderSplitPlanning(state, meta); return; }
      policy = splitCapabilityPolicy(meta);
      if (!policy.available || splitCapabilitySignature(meta, policy) !== capabilitySignature) { notify('확인하는 동안 나누기 환경이 바뀌었습니다. 안내를 다시 확인해주세요.'); renderDocumentSplit(); return; }
      omissionsConfirmed = state.method === 'custom' && plan.unassigned.length > 0;
      compatibilityFallbackApproved = meta.kind === 'pptx';
    }
    state.running = true; state.cancelling = false; state.completed = false; state.outcome = ''; state.results = []; state.progressValue = 0; state.progressVisible = true; state.requestId = crypto.randomUUID();
    state.engine = ''; state.compatibilityFallback = false; state.requiresPreview = false; state.warnings = [];
    $('#documentSplitProgress').hidden = false; $('#documentSplitProgress').max = plan.groups.length; $('#documentSplitProgress').value = 0; $('#documentSplitResults').hidden = true; $('#openDocumentSplitOutput').hidden = true;
    renderDocumentSplit();
    try {
      const result = await DOCUMENT_SPLIT_BRIDGE.splitFile({
        requestId: state.requestId, kind: meta.kind, method: state.method, fileToken: state.file.token, outputToken: state.outputToken,
        allowOmissions: state.method === 'custom' && plan.unassigned.length > 0 && omissionsConfirmed,
        allowCompatibilityFallback: compatibilityFallbackApproved,
        groups: plan.groups.map((group) => ({ name: group.filename, pages: group.pages.slice() }))
      });
      const rawResults = result?.results || result?.outputs || result?.files || [];
      if (result?.ok === false || !Array.isArray(rawResults) || rawResults.length !== plan.groups.length || rawResults.some((item) => !item?.outputFileToken)) {
        throw new Error('나눈 결과 파일 정보를 모두 확인하지 못했습니다. 저장 폴더를 확인한 뒤 다시 시도해주세요.');
      }
      state.engine = String(result?.engine || '');
      state.compatibilityFallback = result?.compatibilityFallback === true;
      state.requiresPreview = result?.requiresPreview === true || state.compatibilityFallback;
      state.warnings = Array.isArray(result?.warnings) ? result.warnings.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 20) : [];
      state.results = plan.groups.map((group, index) => {
        const item = rawResults[index] || {};
        const rawName = item.outputName || item.name || group.filename;
        return {
          outputName: splitNameWithExtension(rawName, group.filename.replace(new RegExp(`${meta.extension.replace('.', '\\.')}$`, 'i'), ''), meta),
          outputFileToken: String(item.outputFileToken),
          pages: Array.isArray(item.pages) && item.pages.length ? item.pages.map(Number).filter(Number.isFinite) : group.pages.slice(),
          requiresPreview: item.requiresPreview === true || state.requiresPreview
        };
      });
      state.progressValue = plan.groups.length; state.completed = true; state.outcome = 'success';
      state.runTitle = state.requiresPreview ? `${meta.label} 나누기 완료 · 결과 확인 필요` : `${meta.label} 나누기 완료`;
      const omissionStatus = plan.unassigned.length ? ` 선택하지 않은 ${plan.unassigned.length}${splitUnitWithParticle(meta.unit, 'topic')} 포함하지 않았습니다.` : '';
      const reviewStatus = state.requiresPreview
        ? ` 내장 분할 결과이므로 미리보기에서 글꼴·배치·애니메이션·미디어 동작과 필요한 검토 댓글이 유지되었는지 확인해주세요.${state.warnings.length ? ` ${state.warnings.join(' ')}` : ''}`
        : '';
      state.runStatus = `${state.results.length}개 결과 파일을 “${state.outputName || '선택한 폴더'}”에 저장했습니다.${omissionStatus}${reviewStatus}`;
      notify(state.requiresPreview ? `${meta.label} 파일을 ${state.results.length}개로 나눴습니다. 결과를 확인해주세요.` : `${meta.label} 파일을 ${state.results.length}개로 나눴습니다.`, state.requiresPreview ? 'normal' : 'success');
      reportWorkflowStatus('documentEditor', state.requiresPreview ? 'needsReview' : 'complete', state.runTitle, { documentMode: 'documentSplit', splitKind: meta.kind, resultCount: state.results.length, engine: state.engine, compatibilityFallback: state.compatibilityFallback });
    } catch (error) {
      const cancelled = isDocumentToolCancellation(error);
      state.outcome = cancelled ? 'cancelled' : 'error'; state.completed = false; state.results = [];
      state.runTitle = cancelled ? '파일 나누기를 중단했습니다.' : `${meta.label} 나누기를 완료하지 못했습니다.`;
      state.runStatus = cancelled ? '완성되지 않은 임시 결과는 정리했으며 원본 파일은 그대로입니다.' : error.message;
      notify(cancelled ? '파일 나누기를 중단했습니다.' : `${meta.label} 나누기 실패: ${error.message}`, cancelled ? 'normal' : 'error');
      if (!cancelled) reportWorkflowStatus('documentEditor', 'needsReview', `${meta.label} 나누기 오류 확인 필요`, { documentMode: 'documentSplit', splitKind: meta.kind });
    } finally {
      state.running = false; state.cancelling = false; state.requestId = ''; renderDocumentSplit();
    }
  }

  async function cancelDocumentSplit() {
    const state = activeSplitState(); if (!state.running || state.cancelling) return;
    if (guideDemo.active) { notify('가이드에서는 실제 파일 나누기 작업을 중단하지 않습니다.'); return; }
    state.cancelling = true; updateSplitReady();
    try {
      const result = await DOCUMENT_SPLIT_BRIDGE.cancel(state.requestId);
      if (!result?.ok) { state.cancelling = false; updateSplitReady(); $('#documentSplitRunStatus').textContent = '작업이 이미 마무리 중입니다. 결과를 확인하고 있습니다.'; }
    } catch (error) {
      state.cancelling = false; updateSplitReady(); notify(`작업 중단 요청 실패: ${error.message}`, 'error');
    }
  }

  function resetExcelDedupeResult() {
    excelDedupe.completed = false; excelDedupe.result = null; excelDedupe.outcome = '';
  }

  function resetExcelDedupeReview({ close = false } = {}) {
    excelDedupe.review = null; excelDedupe.reviewLoading = false; excelDedupe.reviewSheetIndex = -1; excelDedupe.activeReviewGroupId = '';
    excelDedupe.preferredRowsByGroup = {}; excelDedupe.cellSourceRowsByGroup = {}; excelDedupe.customValuesByGroup = {}; excelDedupe.reviewedGroupIds = []; excelDedupe.approvedGroupIds = [];
    if (close && $('#excelDedupeReviewDialog')?.open) $('#excelDedupeReviewDialog').close();
  }

  function excelDedupeReviewGroup() {
    const groups = excelDedupe.review?.groups || [];
    return groups.find((group) => group.id === excelDedupe.activeReviewGroupId) || groups[0] || null;
  }

  function excelDedupeReviewCell(row, columnIndex) {
    return row?.cells?.find((cell) => Number(cell.columnIndex) === Number(columnIndex)) || { text: '', hasValue: false };
  }

  function excelDedupeFinalValue(group, columnIndex, preferredRow) {
    const custom = excelDedupe.customValuesByGroup[group.id]; const key = String(columnIndex);
    if (custom && Object.hasOwn(custom, key)) return { value: String(custom[key] ?? ''), kind: 'custom' };
    const automatic = group.automaticValues?.[key];
    if (group.automaticMerge && automatic) return { value: String(automatic.text ?? ''), kind: automatic.kind || 'union' };
    const suggestion = group.conflictSuggestions?.find((item) => Number(item.columnIndex) === Number(columnIndex));
    if (suggestion && suggestion.kind !== 'manual') return { value: String(suggestion.value ?? ''), kind: suggestion.kind || 'manual' };
    const preferred = group.rows.find((row) => Number(row.rowNumber) === Number(preferredRow));
    const preferredCell = excelDedupeReviewCell(preferred, columnIndex);
    if (preferredCell.hasValue || !excelDedupe.mergeMissingValues) return { value: preferredCell.text || '', kind: suggestion ? 'manual' : preferredCell.hasValue ? 'preferred' : 'empty' };
    const available = group.rows.map((row) => excelDedupeReviewCell(row, columnIndex)).find((cell) => cell.hasValue);
    return { value: available?.text || '', kind: suggestion ? 'manual' : available ? 'fill' : 'empty' };
  }

  function excelDedupeManualGroups() {
    return (excelDedupe.review?.groups || []).filter((group) => group.automaticMerge !== true);
  }

  function moveExcelDedupeReviewGroup(offset) {
    const groups = excelDedupeManualGroups(); if (!groups.length) return;
    const current = groups.findIndex((group) => group.id === excelDedupe.activeReviewGroupId);
    const next = Math.max(0, Math.min(groups.length - 1, (current < 0 ? 0 : current) + Number(offset)));
    excelDedupe.activeReviewGroupId = groups[next].id; renderExcelDedupeReview();
  }

  function markExcelDedupeGroupReviewed(groupId) {
    excelDedupe.reviewedGroupIds = [...new Set([...excelDedupe.reviewedGroupIds, String(groupId)])];
  }

  function renderExcelDedupeReview() {
    const review = excelDedupe.review; const list = $('#excelDedupeReviewGroupList'); const table = $('#excelDedupeReviewTable'); const conflicts = $('#excelDedupeConflictChoices');
    if (!list || !table || !conflicts) return;
    list.replaceChildren(); table.replaceChildren(); conflicts.replaceChildren();
    const totals = $$('#excelDedupeReviewTotals strong');
    if (totals.length >= 4) {
      totals[0].textContent = String(review?.duplicateGroupCount || 0);
      totals[1].textContent = String(review?.duplicateRowCount || 0);
      totals[2].textContent = String(review?.conflictGroupCount || 0);
      totals[3].textContent = String(review?.fillableGroupCount || 0);
    }
    $('#excelDedupeMergeMissing').checked = excelDedupe.mergeMissingValues;
    if (!review?.groups?.length) {
      list.append(element('div', 'document-merge-preview-empty', '검토할 중복 묶음이 없습니다.'));
      table.append(element('div', 'document-merge-preview-empty', '기준 열을 다시 확인해주세요.'));
      return;
    }
    const reviewed = new Set(excelDedupe.reviewedGroupIds);
    const approved = new Set(excelDedupe.approvedGroupIds);
    const manualGroups = excelDedupeManualGroups();
    const activeManualIndex = manualGroups.findIndex((item) => item.id === excelDedupeReviewGroup()?.id);
    const progressPosition = activeManualIndex < 0 ? 0 : activeManualIndex + 1;
    $('#excelDedupeReviewProgressText').textContent = `${progressPosition} / ${manualGroups.length}`;
    $('#excelDedupeReviewProgress').max = Math.max(1, manualGroups.length); $('#excelDedupeReviewProgress').value = progressPosition;
    $('#previousExcelDedupeReviewGroup').disabled = activeManualIndex <= 0;
    $('#nextExcelDedupeReviewGroup').disabled = activeManualIndex < 0 || activeManualIndex >= manualGroups.length - 1;
    review.groups.forEach((group, index) => {
      const button = element('button', `excel-dedupe-review-group${group.id === excelDedupeReviewGroup()?.id ? ' active' : ''}`); button.type = 'button'; button.dataset.excelDedupeReviewGroup = group.id;
      const title = element('strong', '', group.keyText || `중복 묶음 ${index + 1}`);
      const meta = element('small', '', `${group.rowNumbers.length}개 행 · ${group.conflictColumnIndexes.length ? `다른 값 ${group.conflictColumnIndexes.length}열` : '충돌 없음'}${group.oversized ? ' · 대형 묶음 주의' : ''}`);
      const badge = group.automaticMerge
        ? element('span', 'safe', group.exactRowDuplicate ? '자동 정리' : '자동 합집합 통합')
        : approved.has(group.id)
          ? element('span', 'reviewed', '통합 선택')
          : element('span', group.conflictColumnIndexes.length ? 'conflict' : '', reviewed.has(group.id) ? '검토함 · 유지' : '기본 유지');
      button.append(title, meta, badge); list.append(button);
    });
    const group = excelDedupeReviewGroup(); if (!group) return;
    const preferredRow = Number(excelDedupe.preferredRowsByGroup[group.id]) || Number(group.suggestedRowNumber);
    const heading = $('#excelDedupeReviewGroupHeading'); heading.replaceChildren(
      element('div', '', ''),
      element('span', group.oversized ? 'warning' : '', group.exactRowDuplicate
        ? `${group.rowNumbers.join(', ')}행은 모든 셀 값이 같아 자동 정리됩니다.`
        : `${group.rowNumbers.join(', ')}행은 기준 열이 같아 자동 통합됩니다. 다른 값은 합집합으로 모두 보존됩니다.${group.crossColumnDuplicateCount ? ` 열이 달라도 같은 값 ${group.crossColumnDuplicateCount}건은 한 번만 남깁니다.` : ''}`)
    );
    heading.firstChild.append(element('strong', '', group.keyText || '선택한 기준값'), element('small', '', `추천 대표 행 ${group.suggestedRowNumber} · 정보가 가장 많은 행 기준`));
    const tableNode = element('table', 'data-table'); const thead = element('thead'); const headRow = element('tr');
    headRow.append(element('th', '', '시작값'));
    (review.columns || []).forEach((column) => headRow.append(element('th', group.conflictColumnIndexes.includes(Number(column.index)) ? 'conflict' : '', `${column.letter} · ${column.label}`)));
    thead.append(headRow); const tbody = element('tbody');
    group.rows.forEach((row) => {
      const tr = element('tr', Number(row.rowNumber) === preferredRow ? 'preferred' : ''); const first = element('td'); const label = element('label', 'excel-dedupe-preferred-row');
      const radio = element('input'); radio.type = 'radio'; radio.name = 'excelDedupePreferredRow'; radio.value = String(row.rowNumber); radio.dataset.excelDedupePreferredRow = group.id; radio.checked = Number(row.rowNumber) === preferredRow;
      label.append(radio, element('span', '', `${row.rowNumber}행`)); first.append(label); tr.append(first);
      (review.columns || []).forEach((column) => {
        const cell = excelDedupeReviewCell(row, column.index); const td = element('td', `${group.conflictColumnIndexes.includes(Number(column.index)) ? 'conflict ' : ''}${!cell.hasValue ? 'empty' : ''}`.trim(), cell.hasValue ? cell.text : '빈칸');
        td.title = cell.hasValue ? cell.text : '빈칸'; tr.append(td);
      });
      tbody.append(tr);
    });
    tableNode.append(thead, tbody); table.append(tableNode);
    const automaticGroup = group.automaticMerge === true;
    const approval = element('label', `document-merge-option excel-dedupe-approve-option${automaticGroup ? ' automatic' : ''}`);
    const approvalInput = element('input'); approvalInput.type = 'checkbox'; approvalInput.dataset.excelDedupeApproveGroup = group.id;
    approvalInput.checked = automaticGroup || approved.has(group.id); approvalInput.disabled = automaticGroup;
    const approvalCopy = element('span'); approvalCopy.append(
      element('strong', '', group.exactRowDuplicate ? '모든 셀 값이 같아 자동 정리됩니다.' : '기준 열이 같아 자동 합집합 통합됩니다.'),
      element('small', '', group.exactRowDuplicate ? '고유 정보가 없어 첫 행만 남겨도 값이 사라지지 않습니다.' : '서로 다른 값은 줄바꿈으로 모두 남기고, 통합 전 원본 행도 보존 시트에 남깁니다.')
    );
    approval.append(approvalInput, approvalCopy); conflicts.append(approval);
    const intro = element('div', 'excel-dedupe-conflict-heading'); intro.append(
      element('strong', '', automaticGroup ? '통합될 최종 행 미리보기' : '최종 한 행 직접 완성'),
      element('span', '', automaticGroup ? '대소문자·공백 차이는 같은 값으로 보고, 다른 값은 합집합으로 보존합니다.' : '초록색 기준 열은 잠겨 있습니다. 그 외 모든 열은 직접 입력할 수 있습니다.')
    ); conflicts.append(intro);
    (review.columns || []).forEach((column) => {
      const columnIndex = Number(column.index); const locked = (review.criteriaColumnIndexes || []).map(Number).includes(columnIndex);
      const resolution = locked
        ? { value: excelDedupeReviewCell(group.rows[0], columnIndex).text || '', kind: 'locked' }
        : excelDedupeFinalValue(group, columnIndex, preferredRow);
      const field = element('label', `form-field excel-dedupe-conflict-field${locked ? ' locked' : ''}`);
      field.append(element('span', '', `${column.letter} · ${column.label}${locked ? ' · 비교 기준(고정)' : ''}`));
      const input = locked ? element('input') : element('textarea'); input.value = resolution.value;
      if (locked || automaticGroup) { input.readOnly = true; input.setAttribute('aria-readonly', 'true'); }
      if (locked) input.disabled = true;
      if (!locked && !automaticGroup) {
        input.dataset.excelDedupeFinalValue = String(columnIndex); input.dataset.excelDedupeConflictGroup = group.id; input.maxLength = 32767;
      }
      const help = locked ? '중복을 판단한 기준값이라 수정할 수 없습니다.'
        : resolution.kind === 'moreDetailed' ? '공백을 제외한 포함 관계를 확인해 더 자세한 기존 원문을 제안했습니다.'
          : resolution.kind === 'equivalent' ? '띄어쓰기 차이뿐인 기존 값을 정리했습니다.'
            : resolution.kind === 'fill' ? '다른 행에만 있던 값을 빈칸에 보완했습니다.'
              : resolution.kind === 'union' ? '서로 다른 값을 줄바꿈으로 모두 보존합니다.'
                : resolution.kind === 'relocatedDuplicate' ? '다른 열에 있는 같은 값과 중복되어 한 번만 남깁니다.'
                  : resolution.kind === 'manual' ? '서로 완전히 다른 값입니다. 위 원본 행을 보고 직접 확정해주세요.'
                    : '시작값을 그대로 두거나 직접 수정할 수 있습니다.';
      field.append(input, element('small', '', help)); conflicts.append(field);
    });
    const automaticCount = review.groups.filter((item) => item.automaticMerge === true).length;
    $('#excelDedupeReviewFooterStatus').textContent = `자동 통합 ${automaticCount}개 · 다른 값은 합집합 보존 · 원본 행은 별도 시트에 보존`;
  }

  async function openExcelDedupeReview(sheetIndex) {
    if (excelDedupe.reviewLoading || excelDedupe.running || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty) return;
    const columns = excelDedupeColumnsForSheet(sheetIndex); if (!excelDedupe.file?.token || !columns.length) return;
    excelDedupe.reviewLoading = true; excelDedupe.reviewSheetIndex = Number(sheetIndex); renderExcelDeduplicate();
    try {
      const sheet = excelDedupe.file.sheets.find((item) => Number(item.index) === Number(sheetIndex));
      const review = await api().analyzeExcelDeduplicateReview({ fileToken: excelDedupe.file.token, sheetIndex, columnIndexes: columns, headerRow: Number(sheet?.headerRow) || 0 });
      excelDedupe.review = review; excelDedupe.reviewSheetIndex = Number(sheetIndex);
      excelDedupe.activeReviewGroupId = review.groups?.[0]?.id || '';
      review.groups?.forEach((group) => { if (!excelDedupe.preferredRowsByGroup[group.id]) excelDedupe.preferredRowsByGroup[group.id] = Number(group.suggestedRowNumber); });
      renderExcelDedupeReview(); $('#excelDedupeReviewDialog').showModal();
    } catch (error) { notify(`중복 묶음 검토 실패: ${error.message}`, 'error'); }
    finally { excelDedupe.reviewLoading = false; renderExcelDeduplicate(); }
  }

  function excelDedupeColumnsForSheet(index) {
    return [...new Set((excelDedupe.columnIndexesBySheet[String(index)] || []).map(Number))].filter(Number.isInteger).sort((left, right) => left - right);
  }

  function excelDedupeAvailableColumns(sheet) {
    const supplied = (Array.isArray(sheet?.columns) ? sheet.columns : []).filter((column) => Number.isInteger(Number(column?.index)) && Number(column.index) > 0);
    if (supplied.length) return supplied;
    return Array.from({ length: Math.max(0, Number(sheet?.columnCount) || 0) }, (_, offset) => {
      const index = offset + 1; const letter = columnName(index - 1);
      return { index, letter, label: `열 ${letter}` };
    });
  }

  function renderExcelDedupeColumnPicker() {
    const picker = $('#excelDedupeColumnPicker'); const select = $('#excelDedupeColumnSheetSelect'); const list = $('#excelDedupeColumnPickerList');
    if (!picker || !select || !list) return;
    const sheets = excelDedupe.file?.sheets || []; const visible = excelDedupe.criteriaMode === 'columns' && sheets.length > 0;
    picker.hidden = !visible; if (!visible) return;
    let active = sheets.find((sheet) => Number(sheet.index) === Number(excelDedupe.activeColumnSheetIndex));
    if (!active) { active = sheets[0]; excelDedupe.activeColumnSheetIndex = Number(active.index); }
    select.replaceChildren();
    sheets.forEach((sheet) => { const option = element('option', '', sheet.name); option.value = String(sheet.index); option.selected = Number(sheet.index) === Number(active.index); select.append(option); });
    select.disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing;
    const chosen = new Set(excelDedupeColumnsForSheet(active.index)); const columns = excelDedupeAvailableColumns(active); list.replaceChildren();
    columns.forEach((column) => {
      const chip = element('label', 'excel-dedupe-column-chip'); const input = element('input'); input.type = 'checkbox';
      input.dataset.excelDedupePickerColumn = String(column.index); input.checked = chosen.has(Number(column.index)); input.disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing;
      chip.title = `${column.letter}열 · ${column.label}`; chip.append(input, element('b', '', column.letter), element('em', '', column.label)); list.append(chip);
    });
    if (!columns.length) list.append(element('div', 'document-merge-preview-empty', '이 시트에서 선택할 수 있는 열을 찾지 못했습니다. 파일을 다시 확인해주세요.'));
    const headerNote = Number(active.headerRow) > 0 ? `${active.headerRow}행의 제목을 함께 표시했습니다.` : '제목 행이 없어 A·B·C 열 문자로 표시했습니다.';
    const resultNote = chosen.size && !excelDedupe.criteriaAnalyzing && !excelDedupe.criteriaDirty
      ? ` 자동 통합 ${Number(active.automaticGroupCount) || 0}묶음.` : '';
    $('#excelDedupeColumnPickerStatus').textContent = chosen.size ? `${active.name} · ${[...chosen].map((index) => columnName(index - 1)).join('+')} 선택.${resultNote} ${headerNote}` : `${active.name} · 열을 하나 이상 선택해주세요. ${headerNote}`;
    const applyAll = $('#applyExcelDedupeColumnsToAllSheets');
    applyAll.textContent = chosen.size ? `현재 ${[...chosen].map((index) => columnName(index - 1)).join('+')} 기준을 모든 시트에 적용` : '같은 열을 모든 시트에 적용';
    applyAll.title = '현재 선택한 열 위치를 해당 열이 존재하는 모든 시트에 복사한 뒤, 중복이 있는 시트를 모두 작업 대상으로 선택합니다.';
    applyAll.disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || !chosen.size || sheets.length < 2;
    $('#selectAllExcelDedupeColumns').disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || !columns.length || chosen.size === columns.length;
    $('#clearExcelDedupeColumns').disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || !chosen.size;
  }

  function excelDedupeSheetDuplicateCount(sheet) {
    if (excelDedupe.criteriaMode === 'columns' && !excelDedupeColumnsForSheet(sheet.index).length) return 0;
    return Math.max(0, Number(sheet.duplicateRowCount) || 0);
  }

  function excelDedupeSelectedSheets() {
    const selected = new Set(excelDedupe.selectedSheetIndexes.map(Number));
    return (excelDedupe.file?.sheets || []).filter((sheet) => selected.has(Number(sheet.index)) && excelDedupeSheetDuplicateCount(sheet) > 0);
  }

  async function analyzeExcelDedupeCriteria({ selectSheetIndex = null, selectAllAfterAnalysis = false } = {}) {
    if (!excelDedupe.file?.token || excelDedupe.running) return;
    const sequence = ++excelDedupe.criteriaSequence;
    excelDedupe.criteriaDirty = false; excelDedupe.criteriaAnalyzing = true; excelDedupe.criteriaError = ''; resetExcelDedupeResult(); renderExcelDeduplicate();
    try {
      const columnIndexesBySheet = excelDedupe.criteriaMode === 'columns' ? excelDedupe.columnIndexesBySheet : {};
      const result = await api().analyzeExcelDeduplicateCriteria({ fileToken: excelDedupe.file.token, columnIndexesBySheet });
      if (sequence !== excelDedupe.criteriaSequence) return;
      excelDedupe.file = { ...excelDedupe.file, ...result, token: excelDedupe.file.token, name: excelDedupe.file.name, bytes: excelDedupe.file.bytes, highRiskFeatures: excelDedupe.file.highRiskFeatures };
      const available = new Set(excelDedupe.file.sheets.filter((sheet) => excelDedupeSheetDuplicateCount(sheet) > 0).map((sheet) => Number(sheet.index)));
      excelDedupe.selectedSheetIndexes = selectAllAfterAnalysis
        ? [...available]
        : excelDedupe.selectedSheetIndexes.map(Number).filter((index) => available.has(index));
      if (!selectAllAfterAnalysis && Number.isInteger(selectSheetIndex) && available.has(selectSheetIndex)) excelDedupe.selectedSheetIndexes = [...new Set([...excelDedupe.selectedSheetIndexes, selectSheetIndex])];
    } catch (error) {
      if (sequence === excelDedupe.criteriaSequence) { excelDedupe.criteriaError = String(error.message || '기준 열을 분석하지 못했습니다.'); notify(`기준 열 분석 실패: ${excelDedupe.criteriaError}`, 'error'); }
    } finally {
      if (sequence === excelDedupe.criteriaSequence) { excelDedupe.criteriaAnalyzing = false; renderExcelDeduplicate(); }
    }
  }

  function queueExcelDedupeCriteriaAnalysis(selectSheetIndex = null, { selectAllAfterAnalysis = false } = {}) {
    clearTimeout(excelDedupeCriteriaTimer); excelDedupe.criteriaSequence += 1; excelDedupe.criteriaDirty = true; excelDedupe.criteriaAnalyzing = false; excelDedupe.criteriaError = ''; resetExcelDedupeResult(); resetExcelDedupeReview({ close: true }); renderExcelDeduplicate();
    excelDedupeCriteriaTimer = setTimeout(() => analyzeExcelDedupeCriteria({ selectSheetIndex, selectAllAfterAnalysis }), 300);
  }

  function renderExcelDeduplicate() {
    renderExcelCleanupTask();
    const file = excelDedupe.file;
    const hasAnyCriteriaColumns = Object.values(excelDedupe.columnIndexesBySheet).some((columns) => Array.isArray(columns) && columns.length > 0);
    const visibleDuplicateRowCount = excelDedupe.criteriaMode === 'columns'
      ? (file?.sheets || []).reduce((sum, sheet) => sum + excelDedupeSheetDuplicateCount(sheet), 0)
      : Number(file?.duplicateRowCount) || 0;
    const source = $('#excelDeduplicateSourceSummary');
    if (file) source.replaceChildren(
      element('strong', '', file.name),
      element('span', '', `${formatBytes(file.bytes)} · ${file.sheetCount}개 시트 · ${excelDedupe.criteriaMode === 'columns' && !hasAnyCriteriaColumns ? '아래에서 기준 열을 선택해주세요' : `현재 기준 중복 ${visibleDuplicateRowCount}행`}`)
    );
    else source.replaceChildren(element('strong', '', '정리할 파일을 선택해주세요.'), element('span', '', '시트별 중복 개수를 분석해 보여드립니다.'));
    renderExcelDedupeColumnPicker();

    const list = $('#excelDeduplicateSheetList'); list.replaceChildren();
    if (!file?.sheets?.length) {
      const empty = element('div', 'document-merge-preview-empty');
      empty.append(element('strong', '', '분석 결과가 없습니다.'), element('span', '', '먼저 Excel 파일을 선택해주세요.')); list.append(empty);
    } else {
      const selected = new Set(excelDedupe.selectedSheetIndexes.map(Number));
      file.sheets.forEach((sheet) => {
        const count = excelDedupeSheetDuplicateCount(sheet);
        const hasSheetCriteria = excelDedupe.criteriaMode !== 'columns' || excelDedupeColumnsForSheet(sheet.index).length > 0;
        const row = element('div', `excel-dedupe-sheet-item${count ? '' : ' no-duplicates'}`);
        row.setAttribute('role', 'group'); row.setAttribute('aria-label', `${sheet.name} 시트`);
        const main = element('label', 'excel-dedupe-sheet-main');
        const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.excelDedupeSheet = String(sheet.index);
        checkbox.checked = count > 0 && selected.has(Number(sheet.index)); checkbox.disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty || !count;
        const copy = element('span', 'excel-dedupe-sheet-copy');
        const examples = (sheet.duplicateExamples || []).slice(0, 2).map((rows) => `${rows.join('·')}행`).join(', ');
        copy.append(element('strong', '', sheet.name), element('small', '', `${sheet.rowCount}행 · ${sheet.columnCount}열${examples ? ` · 예: ${examples}` : ''}`));
        const countText = excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty ? '분석 중' : !hasSheetCriteria ? '열 선택 필요'
          : count && excelDedupe.criteriaMode === 'columns' ? `자동 통합 ${Number(sheet.automaticGroupCount) || 0}`
            : count ? `${Number(sheet.duplicateGroupCount) || 0}묶음 · ${count}행` : '중복 없음';
        main.append(checkbox, copy); row.append(main, element('span', `excel-dedupe-count${count ? '' : ' none'}`, countText));
        if (excelDedupe.criteriaMode === 'columns') {
          const columns = element('div', 'excel-dedupe-columns');
          const chosen = new Set(excelDedupeColumnsForSheet(sheet.index));
          const heading = element('span'); heading.append(element('b', '', chosen.size ? `선택 기준 · ${[...chosen].map((index) => columnName(index - 1)).join('+')}` : '아직 기준 열을 선택하지 않았습니다.'));
          const choose = element('button', 'excel-dedupe-open-column-picker', Number(excelDedupe.activeColumnSheetIndex) === Number(sheet.index) ? '위에서 이 시트의 열 선택 중' : '이 시트의 열 선택');
          choose.type = 'button'; choose.dataset.excelDedupeOpenColumnPicker = String(sheet.index); choose.disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing;
          columns.append(heading, choose);
          if (count > 0) {
            const reviewButton = element('button', 'excel-dedupe-review-button', excelDedupe.reviewLoading && Number(excelDedupe.reviewSheetIndex) === Number(sheet.index) ? '불러오는 중…' : `통합 결과 ${Number(sheet.duplicateGroupCount) || 0}묶음 미리보기`);
            reviewButton.type = 'button'; reviewButton.dataset.excelDedupeReview = String(sheet.index); reviewButton.disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty || excelDedupe.reviewLoading; columns.append(reviewButton);
          }
          row.append(columns);
        }
        list.append(row);
      });
    }
    const selectedSheets = excelDedupeSelectedSheets();
    const totals = $$('#excelDeduplicateTotals strong');
    if (totals.length >= 3) {
      totals[0].textContent = String(file?.sheetCount || 0);
      totals[1].textContent = String(selectedSheets.length);
      totals[2].textContent = excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty ? '…' : String(selectedSheets.reduce((sum, sheet) => sum + excelDedupeSheetDuplicateCount(sheet), 0));
    }
    $$('input[name="excelDeduplicateCriteriaMode"]').forEach((input) => { input.checked = input.value === excelDedupe.criteriaMode; input.disabled = excelDedupe.running || excelDedupe.analyzing || excelDedupe.criteriaAnalyzing; });
    const criteriaStatus = $('#excelDeduplicateCriteriaStatus');
    criteriaStatus.textContent = excelDedupe.criteriaError ? `기준 분석 실패 · ${excelDedupe.criteriaError} 기준을 다시 선택하거나 파일을 다시 열어주세요.` : excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty ? '선택한 모든 열의 값 조합으로 중복을 다시 분석하고 있습니다…' : excelDedupe.criteriaMode === 'columns' && !hasAnyCriteriaColumns ? '중복을 판단할 열을 시트에서 눌러주세요. B만 누르면 B열 값이 같은 행끼리 묶습니다.' : excelDedupe.criteriaMode === 'columns' ? '선택한 모든 열의 값이 같은 행끼리 묶습니다. 대소문자·모든 공백·보이지 않는 문자는 무시하고, 다른 열의 값은 합집합으로 보존합니다.' : '행 전체의 모든 셀 내용과 수식이 같은 경우만 중복으로 판단합니다.';
    $('#selectAllExcelDuplicateSheets').disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty || !file?.sheets?.some((sheet) => excelDedupeSheetDuplicateCount(sheet) > 0);
    $('#clearExcelDuplicateSheets').disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || !selectedSheets.length;
    $('#chooseExcelDeduplicateFile').disabled = excelDedupe.running || excelDedupe.analyzing || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty;
    $('#chooseExcelDeduplicateFile strong').textContent = excelDedupe.analyzing ? '시트를 분석하는 중…' : 'Excel 파일 선택';
    $('#excelDeduplicateOutputName').value = excelDedupe.resultName;
    $('#excelDeduplicateOutputName').disabled = excelDedupe.running;
    $('#chooseExcelDeduplicateOutput').disabled = excelDedupe.running || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty;
    const output = $('#excelDeduplicateOutputSummary');
    if (excelDedupe.outputToken) output.replaceChildren(element('strong', '', excelDedupe.outputName || '선택한 폴더'), element('span', '', '정리한 새 XLSX를 이 폴더에 저장합니다.'));
    else output.replaceChildren(element('strong', '', '저장 폴더를 선택해주세요.'), element('span', '', '원본 파일은 변경하지 않습니다.'));
    const warning = $('#excelDeduplicateWarning');
    const risky = file?.highRiskFeatures || [];
    warning.hidden = !risky.length;
    if (risky.length) warning.querySelector('span').textContent = `${risky.map((item) => item.label).join(' · ')} 포함 · 내부 저장 후 결과 파일에서 해당 개체를 확인해주세요.`;
    const ready = Boolean(file?.token && selectedSheets.length && excelDedupe.outputToken && String(excelDedupe.resultName || '').trim() && !excelDedupe.running && !excelDedupe.analyzing && !excelDedupe.criteriaAnalyzing && !excelDedupe.criteriaDirty && !excelDedupe.criteriaError);
    const run = $('#runExcelDeduplicate'); run.disabled = !ready; run.textContent = excelDedupe.running ? '정리하는 중…' : excelDedupe.criteriaMode === 'columns' ? '기준값별 자동 합집합 통합' : '선택 시트 정리';
    $('#excelDeduplicateRunTitle').textContent = excelDedupe.outcome === 'error' ? '정리하지 못했습니다' : excelDedupe.completed ? '중복 행 정리 완료' : ready ? `${selectedSheets.length}개 시트 준비됨` : '정리 준비';
    $('#excelDeduplicateRunStatus').textContent = excelDedupe.outcome === 'error'
      ? '표시된 오류를 확인한 뒤 파일을 다시 선택해주세요.'
      : excelDedupe.completed
      ? `${excelDedupe.result?.removedRowCount || 0}개 중복 행을 기준값별 합집합으로 통합하고 저장 후 다시 확인했습니다.`
      : !file ? '정리할 Excel 파일을 선택해주세요.' : excelDedupe.criteriaError ? '기준 열 분석 오류를 확인해주세요.' : excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty ? '선택한 기준 열의 중복을 분석하고 있습니다.' : !selectedSheets.length ? '현재 기준에서 중복이 있는 시트를 하나 이상 선택해주세요.' : !excelDedupe.outputToken ? '결과를 저장할 폴더를 선택해주세요.' : '선택한 시트만 새 파일로 정리할 수 있습니다.';
    const resultBox = $('#excelDeduplicateResult'); resultBox.replaceChildren();
    (excelDedupe.result?.sheets || []).forEach((sheet) => {
      const item = element('div', 'document-split-result-row');
      const copy = element('div', 'document-split-result-copy');
      copy.append(element('strong', '', sheet.name), element('small', '', `${sheet.beforeRowCount}행 → ${sheet.afterRowCount}행 · 중복 ${sheet.removedRowCount}행 통합 · ${sheet.mergedCellCount ? `${sheet.mergedCellCount}칸 값 반영` : '추가 값 반영 없음'}`)); item.append(copy); resultBox.append(item);
    });
    resultBox.hidden = !excelDedupe.completed;
    $('#previewExcelDeduplicateOutput').hidden = !excelDedupe.completed;
    $('#openExcelDeduplicateOutput').hidden = !excelDedupe.completed;
    $$('button[data-document-mode]', $('#page-documentEditor')).forEach((button) => { button.disabled = excelDedupe.running || excelDedupe.analyzing || excelDedupe.criteriaAnalyzing; });
  }

  async function chooseExcelDedupeFile() {
    if (excelDedupe.running || excelDedupe.analyzing || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty) return;
    clearTimeout(excelDedupeCriteriaTimer); excelDedupe.criteriaSequence += 1; excelDedupe.criteriaDirty = false; excelDedupe.criteriaAnalyzing = false;
    excelDedupe.analyzing = true; resetExcelDedupeResult(); renderExcelDeduplicate();
    try {
      const result = await api().chooseExcelDeduplicateFile();
      if (!result?.canceled && result?.file) {
        resetExcelDedupeReview({ close: true });
        excelDedupe.file = result.file;
        excelDedupe.criteriaMode = 'all'; excelDedupe.criteriaDirty = false; excelDedupe.criteriaAnalyzing = false; excelDedupe.criteriaError = '';
        excelDedupe.columnIndexesBySheet = {};
        excelDedupe.selectedSheetIndexes = result.file.sheets.filter((sheet) => Number(sheet.duplicateRowCount) > 0).map((sheet) => Number(sheet.index));
        excelDedupe.resultName = `${String(result.file.name || '').replace(/\.xlsx$/i, '')}_중복제거`;
        notify(result.file.duplicateRowCount ? `${result.file.duplicateSheetCount}개 시트에서 중복 ${result.file.duplicateRowCount}행을 찾았습니다.` : '완전히 같은 중복 행을 찾지 못했습니다.', result.file.duplicateRowCount ? 'success' : 'normal');
      }
    } catch (error) { notify(`Excel 파일 분석 실패: ${error.message}`, 'error'); }
    finally { excelDedupe.analyzing = false; renderExcelDeduplicate(); }
  }

  async function chooseExcelDedupeOutput() {
    if (excelDedupe.running || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty) return;
    try {
      const result = await api().chooseDocumentOutputDirectory();
      if (!result?.canceled) { excelDedupe.outputToken = result.token; excelDedupe.outputName = result.name; resetExcelDedupeResult(); renderExcelDeduplicate(); }
    } catch (error) { notify(`저장 폴더 선택 실패: ${error.message}`, 'error'); }
  }

  async function runExcelDedupe() {
    const selected = excelDedupeSelectedSheets();
    if (excelDedupe.running || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty || excelDedupe.criteriaError || !excelDedupe.file?.token || !excelDedupe.outputToken || !selected.length) return;
    excelDedupe.running = true; excelDedupe.requestId = crypto.randomUUID(); resetExcelDedupeResult();
    $('#excelDeduplicateProgress').hidden = false; $('#excelDeduplicateProgress').max = Math.max(1, selected.length); $('#excelDeduplicateProgress').value = 0; renderExcelDeduplicate();
    try {
      const result = await api().runExcelDeduplicate({
        requestId: excelDedupe.requestId, fileToken: excelDedupe.file.token, outputToken: excelDedupe.outputToken,
        outputName: excelDedupe.resultName, sheetIndexes: selected.map((sheet) => Number(sheet.index)),
        criteriaMode: excelDedupe.criteriaMode,
        columnIndexesBySheet: excelDedupe.criteriaMode === 'columns' ? excelDedupe.columnIndexesBySheet : {},
        mergeMissingValues: excelDedupe.mergeMissingValues,
        preferredRowsByGroup: excelDedupe.preferredRowsByGroup,
        cellSourceRowsByGroup: excelDedupe.cellSourceRowsByGroup,
        customValuesByGroup: excelDedupe.customValuesByGroup,
        approvedGroupIds: excelDedupe.approvedGroupIds
      });
      excelDedupe.result = result; excelDedupe.completed = true; excelDedupe.outcome = 'success';
      $('#excelDeduplicateProgress').value = selected.length;
      notify(`기준값이 같은 중복 ${result.removedRowCount}행을 합집합으로 통합한 새 Excel 파일을 만들었습니다.`, 'success');
      reportWorkflowStatus('documentEditor', 'needsReview', `Excel 중복 ${result.removedRowCount}행 정리 완료`, { documentMode: 'excelDeduplicate' });
    } catch (error) {
      excelDedupe.outcome = 'error'; notify(`Excel 중복 정리 실패: ${error.message}`, 'error');
      reportWorkflowStatus('documentEditor', 'needsReview', 'Excel 중복 행 정리 오류 확인 필요', { documentMode: 'excelDeduplicate' });
    } finally { excelDedupe.running = false; excelDedupe.requestId = ''; renderExcelDeduplicate(); }
  }

  function excelCompareSheet(side) {
    const file = excelCompare.files[side]; const index = Number(excelCompare.selections[side].sheetIndex);
    return file?.sheets?.find((sheet) => Number(sheet.index) === index) || file?.sheets?.[0] || null;
  }

  function excelCompareHeader(side) {
    const sheet = excelCompareSheet(side); const row = Number(excelCompare.selections[side].headerRow);
    return sheet?.headerCandidates?.find((candidate) => Number(candidate.row) === row) || sheet?.headerCandidates?.find((candidate) => Number(candidate.row) === Number(sheet.headerRow)) || null;
  }

  function excelCompareColumns(side) {
    return excelCompareHeader(side)?.columns || excelCompareSheet(side)?.columns || [];
  }

  function excelCompareConfig() {
    return {
      leftToken: excelCompare.files.a?.token || '', rightToken: excelCompare.files.b?.token || '',
      left: { ...excelCompare.selections.a }, right: { ...excelCompare.selections.b },
      rules: excelCompare.rules.map(({ source, columnIndex, contains, groupName }) => ({ source, columnIndex, contains: contains.trim(), groupName: groupName.trim() }))
    };
  }

  function excelCompareSignature() { return JSON.stringify(excelCompareConfig()); }

  function invalidateExcelComparePlan() {
    excelCompare.plan = null; excelCompare.planSignature = ''; excelCompare.result = null; excelCompare.completed = false; excelCompare.outcome = '';
  }

  function excelCompareConfigurationReady() {
    if (!excelCompare.files.a?.token || !excelCompare.files.b?.token) return false;
    for (const side of ['a', 'b']) {
      const columns = excelCompareColumns(side); const key = Number(excelCompare.selections[side].keyColumn);
      if (!columns.some((column) => Number(column.index) === key)) return false;
    }
    if (!excelCompare.rules.length) return false;
    for (const rule of excelCompare.rules) {
      const group = rule.groupName.trim().toLocaleLowerCase('ko-KR');
      if (!rule.contains.trim() || !group) return false;
      if (rule.source !== 'key' && !excelCompareColumns(rule.source).some((column) => Number(column.index) === Number(rule.columnIndex))) return false;
    }
    return true;
  }

  function renderExcelCleanupTask() {
    $$('[data-excel-cleanup-task]').forEach((button) => {
      const active = button.dataset.excelCleanupTask === excelCleanupTask; button.setAttribute('aria-selected', String(active));
      button.disabled = excelDedupe.running || excelDedupe.analyzing || excelDedupe.criteriaAnalyzing || excelCompare.running || excelCompare.analyzing;
    });
    $$('[data-excel-cleanup-panel]').forEach((panel) => { panel.hidden = panel.dataset.excelCleanupPanel !== excelCleanupTask; });
    $('#excelCleanupTitle').textContent = excelCleanupTask === 'compare' ? 'Excel 명단 비교·분류' : 'Excel 중복 행 정리';
    $('#excelCleanupDescription').textContent = excelCleanupTask === 'compare'
      ? '서로 다른 두 파일에서 같은 사람을 찾고, 문자 포함 규칙에 따라 그룹별 시트로 나눕니다.'
      : '완전히 같은 행과 빈칸만 다른 행은 자동 통합하고, 값이 충돌하는 후보는 사용자가 선택한 묶음만 통합합니다. 원본은 바꾸지 않습니다.';
  }

  function fillExcelCompareSelect(select, items, value, placeholder, valueOf, labelOf) {
    select.replaceChildren();
    if (!items.length) { const option = element('option', '', placeholder); option.value = ''; select.append(option); select.disabled = true; return; }
    items.forEach((item) => { const option = element('option', '', labelOf(item)); option.value = String(valueOf(item)); select.append(option); });
    select.value = String(value); if (!select.value && items.length) select.value = String(valueOf(items[0])); select.disabled = excelCompare.running || excelCompare.analyzing;
  }

  function renderExcelCompareSource(side) {
    const upper = side.toUpperCase(); const file = excelCompare.files[side]; const selection = excelCompare.selections[side]; const sheet = excelCompareSheet(side);
    const summary = $(`#excelCompare${upper}Summary`);
    if (file) summary.replaceChildren(element('strong', '', file.name), element('span', '', `${formatBytes(file.bytes)} · ${file.sheetCount}개 시트 · 열 이름 ${selection.headerRow}행`));
    else summary.replaceChildren(element('strong', '', '파일을 선택해주세요.'), element('span', '', '시트와 비교 열을 확인합니다.'));
    fillExcelCompareSelect($(`#excelCompare${upper}Sheet`), file?.sheets || [], selection.sheetIndex, '파일을 먼저 선택하세요', (item) => item.index, (item) => `${item.name} · ${item.rowCount}행`);
    fillExcelCompareSelect($(`#excelCompare${upper}Header`), sheet?.headerCandidates || [], selection.headerRow, '열 이름 행 없음', (item) => item.row, (item) => `${Number(item.row) === Number(sheet?.headerRow) ? '자동 · ' : ''}${item.label}`);
    fillExcelCompareSelect($(`#excelCompare${upper}Key`), excelCompareColumns(side), selection.keyColumn, '비교 열 없음', (item) => item.index, (item) => `${item.letter} · ${item.label}`);
    $(`#chooseExcelCompare${upper}`).disabled = excelCompare.running || excelCompare.analyzing;
    $(`#chooseExcelCompare${upper} strong`).textContent = excelCompare.analyzing ? '분석 중…' : `${upper} 파일 선택`;
  }

  function renderExcelCompareRules() {
    const list = $('#excelCompareRuleList'); list.replaceChildren();
    excelCompare.rules.forEach((rule, index) => {
      const row = element('div', 'excel-compare-rule'); row.dataset.excelCompareRule = rule.id;
      const sourceField = element('label', 'form-field'); sourceField.append(element('span', '', index === 0 ? '어디에서 찾을까요?' : `${index + 1}번째 확인 위치`));
      const source = element('select'); source.dataset.excelCompareRuleField = 'source';
      [['key', '비교값(이메일 등)'], ['a', 'A 파일의 열'], ['b', 'B 파일의 열']].forEach(([value, label]) => { const option = element('option', '', label); option.value = value; source.append(option); }); source.value = rule.source; sourceField.append(source);
      const columnField = element('label', 'form-field'); columnField.hidden = rule.source === 'key'; columnField.append(element('span', '', '확인할 열'));
      const column = element('select'); column.dataset.excelCompareRuleField = 'columnIndex';
      (rule.source === 'key' ? [] : excelCompareColumns(rule.source)).forEach((item) => { const option = element('option', '', `${item.letter} · ${item.label}`); option.value = String(item.index); column.append(option); });
      if (rule.source !== 'key' && !Number(rule.columnIndex) && column.options.length) rule.columnIndex = Number(column.options[0].value);
      column.value = String(rule.columnIndex || ''); columnField.append(column);
      const containsField = element('label', 'form-field'); containsField.append(element('span', '', '포함할 문자'));
      const contains = element('input'); contains.type = 'text'; contains.value = rule.contains; contains.placeholder = '.onsemi 또는 삼성'; contains.maxLength = 120; contains.dataset.excelCompareRuleField = 'contains'; containsField.append(contains);
      const groupField = element('label', 'form-field'); groupField.append(element('span', '', '만들 시트 이름'));
      const group = element('input'); group.type = 'text'; group.value = rule.groupName; group.placeholder = '온세미'; group.maxLength = 31; group.dataset.excelCompareRuleField = 'groupName'; groupField.append(group);
      const remove = element('button', 'excel-compare-rule-remove', '×'); remove.type = 'button'; remove.dataset.removeExcelCompareRule = rule.id; remove.title = '이 규칙 삭제'; remove.setAttribute('aria-label', `${index + 1}번째 분류 규칙 삭제`);
      [source, column, contains, group, remove].forEach((control) => { control.disabled = excelCompare.running || excelCompare.analyzing; });
      row.append(sourceField, columnField, containsField, groupField, remove); list.append(row);
    });
    $('#addExcelCompareRule').disabled = excelCompare.running || excelCompare.analyzing || excelCompare.rules.length >= 100;
  }

  function updateExcelCompareReady() {
    const configured = excelCompareConfigurationReady(); const planCurrent = Boolean(excelCompare.plan && excelCompare.planSignature === excelCompareSignature());
    $('#analyzeExcelCompare').disabled = !configured || excelCompare.running || excelCompare.analyzing;
    $('#analyzeExcelCompare').textContent = excelCompare.analyzing ? '비교 중…' : planCurrent ? '다시 확인' : '매칭 결과 확인';
    $('#excelCompareAnalysisTitle').textContent = excelCompare.outcome === 'analysisError' ? '비교하지 못했습니다' : planCurrent ? '매칭 결과 확인 완료' : configured ? '비교 준비 완료' : '비교 준비';
    $('#excelCompareAnalysisStatus').textContent = excelCompare.outcome === 'analysisError' ? '입력한 시트·열·규칙을 확인해주세요.' : planCurrent
      ? `동일 인물 ${excelCompare.plan.matchedCount}명 · 그룹 ${excelCompare.plan.classifiedCount}명 · 기타 ${excelCompare.plan.otherCount}명`
      : configured ? '매칭 결과 확인을 누르면 저장 전에 그룹별 인원수를 계산합니다.' : '두 파일과 비교 열, 분류 규칙을 준비해주세요.';
    const totals = $$('#excelCompareTotals strong'); const values = planCurrent ? [excelCompare.plan.matchedCount, excelCompare.plan.classifiedCount, excelCompare.plan.otherCount, excelCompare.plan.ambiguousRowCount] : [0, 0, 0, 0];
    totals.forEach((node, index) => { node.textContent = String(values[index] || 0); });
    const preview = $('#excelCompareGroupPreview'); preview.replaceChildren();
    if (planCurrent) {
      (excelCompare.plan.groupCounts || []).forEach((group) => { const chip = element('span'); chip.append(element('b', '', group.name), element('small', '', `${group.count}명`)); preview.append(chip); });
      for (const [name, count] of [['기타', excelCompare.plan.otherCount], ['중복 확인', excelCompare.plan.ambiguousRowCount], ['미매칭 A', excelCompare.plan.unmatchedACount], ['미매칭 B', excelCompare.plan.unmatchedBCount]]) if (count) { const chip = element('span'); chip.append(element('b', '', name), element('small', '', `${count}행`)); preview.append(chip); }
    }
    preview.hidden = !planCurrent;
    $('#excelCompareOutputName').value = excelCompare.resultName; $('#excelCompareOutputName').disabled = excelCompare.running;
    $('#chooseExcelCompareOutput').disabled = excelCompare.running || excelCompare.analyzing;
    const output = $('#excelCompareOutputSummary');
    if (excelCompare.outputToken) output.replaceChildren(element('strong', '', excelCompare.outputName || '선택한 폴더'), element('span', '', '그룹별 새 XLSX를 이 폴더에 저장합니다.'));
    else output.replaceChildren(element('strong', '', '저장 폴더를 선택해주세요.'), element('span', '', '두 원본 파일은 변경하지 않습니다.'));
    const ready = planCurrent && excelCompare.outputToken && excelCompare.resultName.trim() && !excelCompare.running && !excelCompare.analyzing;
    $('#runExcelCompare').disabled = !ready; $('#runExcelCompare').textContent = excelCompare.running ? '만드는 중…' : '그룹 시트 만들기';
    $('#excelCompareRunTitle').textContent = excelCompare.outcome === 'runError' ? '파일을 만들지 못했습니다' : excelCompare.completed ? '그룹 시트 생성 완료' : ready ? '저장 준비 완료' : '저장 준비';
    $('#excelCompareRunStatus').textContent = excelCompare.outcome === 'runError' ? '오류를 확인하고 매칭 결과를 다시 확인해주세요.' : excelCompare.completed
      ? `${excelCompare.result.sheetCount}개 시트 · 동일 인물 ${excelCompare.result.matchedCount}명 분류 결과를 다시 검증했습니다.`
      : !planCurrent ? '먼저 매칭 결과를 확인해주세요.' : !excelCompare.outputToken ? '결과를 저장할 폴더를 선택해주세요.' : '그룹별 시트가 포함된 새 Excel 파일을 만들 수 있습니다.';
    const result = $('#excelCompareResult'); result.replaceChildren();
    (excelCompare.result?.sheets || []).forEach((sheet) => { const item = element('div', 'document-split-result-row'); const copy = element('div', 'document-split-result-copy'); copy.append(element('strong', '', sheet.name), element('small', '', `${sheet.rowCount}행`)); item.append(copy); result.append(item); });
    result.hidden = !excelCompare.completed; $('#previewExcelCompareOutput').hidden = !excelCompare.completed; $('#openExcelCompareOutput').hidden = !excelCompare.completed;
  }

  function renderExcelCompare() {
    renderExcelCleanupTask(); renderExcelCompareSource('a'); renderExcelCompareSource('b'); renderExcelCompareRules(); updateExcelCompareReady();
    $$('button[data-document-mode]', $('#page-documentEditor')).forEach((button) => { button.disabled = excelCompare.running || excelCompare.analyzing; });
  }

  async function chooseExcelCompareFile(side) {
    if (excelCompare.running || excelCompare.analyzing) return;
    excelCompare.analyzing = true; invalidateExcelComparePlan(); renderExcelCompare();
    try {
      const result = await api().chooseExcelCompareFile({ slot: side });
      if (!result?.canceled && result?.file) {
        excelCompare.files[side] = result.file; const sheet = result.file.sheets[0]; const header = sheet?.headerCandidates?.find((item) => Number(item.row) === Number(sheet.headerRow));
        excelCompare.selections[side] = { sheetIndex: Number(sheet?.index) || 0, headerRow: Number(sheet?.headerRow) || 1, keyColumn: Number(header?.columns?.[0]?.index || sheet?.columns?.[0]?.index) || 0 };
        excelCompare.rules.forEach((rule) => { if (rule.source === side) rule.columnIndex = Number(excelCompareColumns(side)[0]?.index) || 0; });
        excelCompare.resultName = `${String(excelCompare.files.a?.name || 'A').replace(/\.xlsx$/i, '')}_${String(excelCompare.files.b?.name || 'B').replace(/\.xlsx$/i, '')}_분류`;
      }
    } catch (error) { notify(`${side.toUpperCase()} 파일 분석 실패: ${error.message}`, 'error'); }
    finally { excelCompare.analyzing = false; renderExcelCompare(); }
  }

  async function analyzeExcelCompare() {
    if (!excelCompareConfigurationReady() || excelCompare.running || excelCompare.analyzing) return;
    excelCompare.analyzing = true; excelCompare.outcome = ''; renderExcelCompare(); const signature = excelCompareSignature();
    try {
      const plan = await api().analyzeExcelComparePlan(excelCompareConfig());
      if (signature !== excelCompareSignature()) return;
      excelCompare.plan = plan; excelCompare.planSignature = signature; excelCompare.outcome = 'analyzed';
      notify(`동일 인물 ${plan.matchedCount}명 중 ${plan.classifiedCount}명을 그룹으로 분류했습니다.`, 'success');
    } catch (error) { excelCompare.outcome = 'analysisError'; notify(`Excel 명단 비교 실패: ${error.message}`, 'error'); }
    finally { excelCompare.analyzing = false; renderExcelCompare(); }
  }

  async function chooseExcelCompareOutput() {
    if (excelCompare.running || excelCompare.analyzing) return;
    try { const result = await api().chooseDocumentOutputDirectory(); if (!result?.canceled) { excelCompare.outputToken = result.token; excelCompare.outputName = result.name; excelCompare.completed = false; excelCompare.result = null; renderExcelCompare(); } }
    catch (error) { notify(`저장 폴더 선택 실패: ${error.message}`, 'error'); }
  }

  async function runExcelCompare() {
    if (!excelCompare.plan || excelCompare.planSignature !== excelCompareSignature() || !excelCompare.outputToken || excelCompare.running) return;
    excelCompare.running = true; excelCompare.requestId = crypto.randomUUID(); excelCompare.completed = false; excelCompare.result = null; excelCompare.outcome = '';
    $('#excelCompareProgress').hidden = false; $('#excelCompareProgress').value = 0; renderExcelCompare();
    try {
      const result = await api().runExcelCompareGroup({ ...excelCompareConfig(), requestId: excelCompare.requestId, outputToken: excelCompare.outputToken, outputName: excelCompare.resultName });
      excelCompare.result = result; excelCompare.completed = true; excelCompare.outcome = 'success'; $('#excelCompareProgress').value = 2;
      notify(`그룹별 ${result.sheetCount}개 시트가 포함된 Excel 파일을 만들었습니다.`, 'success');
      reportWorkflowStatus('documentEditor', 'needsReview', `Excel 동일 인물 ${result.matchedCount}명 비교·분류 완료`, { documentMode: 'excelDeduplicate' });
    } catch (error) { excelCompare.outcome = 'runError'; notify(`Excel 비교·분류 실패: ${error.message}`, 'error'); }
    finally { excelCompare.running = false; excelCompare.requestId = ''; renderExcelCompare(); }
  }

  function documentToolGuideReadiness() {
    const running = Boolean(converter.running || certificate.running || excelDedupe.running || excelCompare.running || Object.values(mergeStates).some((state) => state.running) || Object.values(splitStates).some((state) => state.running || state.confirming));
    const preparing = Boolean(converter.preparing || certificate.preparing || Object.values(mergeStates).some((state) => state.preparing));
    const inspecting = Boolean(excelDedupe.analyzing || excelDedupe.criteriaAnalyzing || excelDedupe.criteriaDirty || excelCompare.analyzing || Object.values(mergeStates).some((state) => state.inspecting));
    const routeChecking = Boolean(converter.routeChecking);
    const previewing = Boolean(certificate.previewing);
    const ready = !(running || preparing || inspecting || routeChecking || previewing);
    const message = running
      ? '문서 변환·합치기·나누기·일괄 만들기 작업이 진행 중입니다. 작업을 마치거나 중단한 뒤 가이드를 시작해주세요.'
      : preparing
      ? '문서 프로그램 또는 글꼴을 준비 중입니다. 준비가 끝난 뒤 가이드를 시작해주세요.'
      : inspecting
      ? '선택한 문서의 페이지·시트와 안전 상태를 확인 중입니다. 확인이 끝난 뒤 가이드를 시작해주세요.'
      : routeChecking
      ? '선택한 문서의 변환 경로를 확인 중입니다. 확인이 끝난 뒤 가이드를 시작해주세요.'
      : previewing
      ? '문서 미리보기를 만드는 중입니다. 완료된 뒤 가이드를 시작해주세요.'
      : '';
    return { ready, running, preparing, inspecting, routeChecking, previewing, message };
  }

  function anyDocumentOperationActive() {
    return !documentToolGuideReadiness().ready;
  }

  function dependencyPreparationOutcome(result, actions, ready) {
    const actionResults = Array.isArray(result?.actions) ? result.actions : [];
    const unresolved = Array.isArray(result?.unresolved) ? result.unresolved : [];
    const failed = !result || actionResults.some((item) => item?.ok === false)
      || (result.ok === false && unresolved.length === 0);
    const openedOfficial = Boolean(
      result?.openedOfficialSource || result?.openedOfficialInstaller || result?.requiresUserAction
      || actions.some((action) => action.type === 'officialInstaller' || action.type === 'officialFontSource'
        || action.type === 'officialHancomAutomationGuide')
    );
    const restartRequired = result?.restartRequired === true
      || actionResults.some((item) => item?.restartRequired === true);
    if (failed) return { tone: 'error', message: '일부 구성을 준비하지 못했습니다. 표시된 항목을 확인한 뒤 다시 시도해주세요.' };
    if (restartRequired) return { tone: 'normal', message: 'Windows 글꼴 설치를 마쳤습니다. Windows를 한 번 다시 시작하면 문서 프로그램에서도 정확한 글꼴을 사용할 수 있습니다.' };
    if (unresolved.length) return { tone: 'normal', message: `준비 가능한 항목은 처리했지만 자동으로 준비할 수 없는 구성 ${unresolved.length}개가 남았습니다. 정식 설치 후 다시 확인해주세요.` };
    if (openedOfficial) return { tone: 'success', message: '공식 설치·글꼴 안내 화면을 열었습니다. 설치를 마치고 앱으로 돌아오면 자동으로 다시 확인합니다.' };
    if (!ready) return { tone: 'normal', message: '준비 작업은 마쳤지만 필요한 구성이 아직 감지되지 않았습니다. 설치를 마친 뒤 다시 확인해주세요.' };
    return { tone: 'success', message: '필요한 구성을 준비하고 다시 확인했습니다.' };
  }

  function cleanMergeResultName(value, meta) {
    const escaped = meta.extension.replace('.', '\\.');
    const withoutExtension = String(value || '').replace(new RegExp(`${escaped}$`, 'i'), '');
    return safeCertificateFilenameStem(withoutExtension, meta.defaultName);
  }

  function mergeFileCount(file, meta) {
    const candidates = meta.kind === 'pptx'
      ? [file.slideCount, file.slides, file.metadata?.slideCount]
      : meta.kind === 'excel'
      ? [file.sheetCount, file.sheets?.length, file.sheetNames?.length, file.metadata?.sheetCount]
      : [file.pageCount, file.pages, file.metadata?.pageCount];
    const value = candidates.filter((candidate) => candidate !== null && candidate !== undefined && candidate !== '').map(Number).find((candidate) => Number.isFinite(candidate) && candidate >= 0);
    return value === undefined ? null : Math.floor(value);
  }

  function normalizeMergeSheets(file) {
    const source = Array.isArray(file?.sheets)
      ? file.sheets
      : Array.isArray(file?.metadata?.sheets)
      ? file.metadata.sheets
      : Array.isArray(file?.sheetNames)
      ? file.sheetNames.map((name, index) => ({ index: index + 1, name }))
      : [];
    return source.map((sheet, index) => ({
      index: Number(sheet?.index) > 0 ? Math.floor(Number(sheet.index)) : index + 1,
      name: String(typeof sheet === 'string' ? sheet : sheet?.name || `시트${index + 1}`),
      type: String(typeof sheet === 'object' ? sheet?.type || 'worksheet' : 'worksheet'),
      visibility: typeof sheet === 'object' ? sheet?.visibility : 'visible'
    }));
  }

  function safeExcelSheetBase(value, fallback = 'Sheet') {
    const cleaned = String(value || '').replace(/[\\/:?*\[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '');
    return (cleaned || fallback).slice(0, 31);
  }

  function excelMergeSheetPlan(state) {
    const addCombinedSheet = state?.addCombinedSheet === true;
    const reportedNames = Array.isArray(state?.resultSheetNames) ? state.resultSheetNames.map(String) : [];
    const used = new Set();
    const reportedOffset = addCombinedSheet ? 1 : 0;
    let resultIndex = 0;
    return state.files.map((file, fileIndex) => {
      const sourceSheets = normalizeMergeSheets(file);
      const useFileName = state?.useFileNameAsSheetName === true && sourceSheets.length === 1;
      const fileNameBase = String(file?.name || '').replace(/\.[^.]+$/, '');
      const sheets = sourceSheets.map((sheet, sheetIndex) => {
        const requestedName = useFileName ? fileNameBase : sheet.name;
        const base = safeExcelSheetBase(requestedName, `Sheet${resultIndex + 1}`);
        let outputName = base; let suffixIndex = 2;
        while (used.has(outputName.toLocaleLowerCase('en-US'))) {
          const suffix = ` (${suffixIndex})`; outputName = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`; suffixIndex += 1;
        }
        if (reportedNames[resultIndex + reportedOffset]) outputName = reportedNames[resultIndex + reportedOffset];
        used.add(outputName.toLocaleLowerCase('en-US')); resultIndex += 1;
        return { ...sheet, fileIndex, sheetIndex, resultIndex, outputName, renamed: outputName !== sheet.name, renamedByFileName: useFileName };
      });
      return { file, fileIndex, sheets };
    });
  }

  function excelCombinedSheetName(state, plan = excelMergeSheetPlan(state)) {
    if (state?.addCombinedSheet !== true) return '';
    const reportedName = Array.isArray(state.resultSheetNames) ? state.resultSheetNames[0] : '';
    if (reportedName) return safeExcelSheetBase(reportedName, '전체 통합');
    const used = new Set(plan.flatMap((entry) => entry.sheets).map((sheet) => String(sheet.outputName || '').toLocaleLowerCase('en-US')));
    const base = safeExcelSheetBase(state?.combinedSheetRequestedName, '전체 통합');
    let outputName = base; let suffixIndex = 2;
    while (used.has(outputName.toLocaleLowerCase('en-US'))) {
      const suffix = ` (${suffixIndex})`; outputName = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`; suffixIndex += 1;
    }
    return outputName;
  }

  function mergeFileHasIssue(file) {
    if (String(file?.status || '').toLowerCase() === 'internal-ready' && file?.internalFallbackAvailable === true) return false;
    return Boolean(file?.error || ['failed', 'blocked', 'invalid'].includes(String(file?.status || '').toLowerCase()));
  }

  function excelInternalFallbackHint(error) {
    const details = error?.details && typeof error.details === 'object' ? error.details : {};
    return [
      error?.code,
      error?.workerCode,
      details.workerCode,
      details.reasonCode,
      details.code,
      details.phase,
      details.stage,
      error?.message
    ].filter(Boolean).join(' ').toUpperCase();
  }

  function excelInternalFallbackEligible(error, state, meta) {
    if (meta?.kind !== 'excel' || !Array.isArray(state?.files) || !state.files.length) return false;
    if (!state.files.every((file) => normalizeDocumentExtension(file?.extension || file?.name) === 'xlsx')) return false;
    if (isDocumentToolCancellation(error)) return false;
    const hint = excelInternalFallbackHint(error);
    if (!hint) return false;
    if (/(?:INPUT|SOURCE)_(?:CHANGED|IDENTITY_CHANGED|NOT_FOUND)|CANCEL|ABORT|PASSWORD|ENCRYPT|IRM|PROTECTED|SIGNED|SIGNATURE|MACRO|SECURITY|ROW_LIMIT|SHEET_SIZE|FILE_SIZE|TOO_LARGE|MAX_(?:FILES|BYTES|SIZE)|(?:ROW|SIZE|BYTE|FILE|COUNT)_LIMIT|LIMIT_(?:EXCEEDED|REACHED)|LIMIT\s+EXCEEDED|OUTPUT_(?:DIRECTORY|NAME|EXISTS|EQUALS|NOT_CREATED|FORMAT)|INVALID_(?:OUTPUT|NAME)|SAVE_FAILED|PUBLISH|IN_USE|START_FAILED|WORKER_MISSING|EXECUTABLE_INVALID|DEPENDENC|TIMEOUT|시간이?\s*초과|암호|비밀번호|보호|서명|매크로|원본.*바뀌|파일.*없|저장\s*폴더|파일\s*이름|최대\s*(?:행|크기|용량)|용량.*넘|개수.*넘/.test(hint)) return false;
    if (error?.details?.internalFallbackEligible === true || error?.internalFallbackEligible === true) return true;
    return /INTERNAL_EXCEL_MERGE_CONFIRMATION_REQUIRED|INPUT_OPEN_FAILED|INPUT_INSPECTION_FAILED|INSPECTION_FAILED|SHEET_COPY_FAILED|COPY_FAILED|OUTPUT_VERIFY_FAILED|RESULT_INVALID|OUTPUT_CONTENT_CHANGED|STRUCTURE_UNSUPPORTED|STRUCTURE_INVALID|EXTERNAL_LINKS?_UNSUPPORTED|COMBINED_HEADER_(?:MISSING|MISMATCH)|FORMULA_REBIND_FAILED|MERGE_FAILED|OPEN_FAILED|VERIFY_FAILED|(?:원본|파일).*?(?:안전하게\s*)?열지\s*못|파일.*검사.*(?:실패|완료하지\s*못)|시트.*복사.*(?:실패|못)|결과.*(?:검증|확인).*못|구조.*(?:지원하지\s*않|확인하지\s*못)|헤더.*(?:다르|불일치|찾지\s*못)|외부\s*연결.*안전하게\s*합칠\s*수\s*없/i.test(hint);
  }

  function mergeStateInputSignature(state) {
    return JSON.stringify((state?.files || []).map((file) => [
      String(file?.token || ''),
      String(file?.key || ''),
      String(file?.name || ''),
      Number(file?.bytes || 0)
    ]));
  }

  function captureInternalFallbackContext(state) {
    return {
      state,
      inspectionGeneration: Number(state?.inspectionGeneration || 0),
      sourceSignature: mergeStateInputSignature(state),
      outputToken: String(state?.outputToken || ''),
      resultName: String($('#documentMergeOutputName')?.value || ''),
      addCombinedSheet: state?.addCombinedSheet === true,
      useFileNameAsSheetName: state?.useFileNameAsSheetName === true,
      combinedSheetRequestedName: String(state?.combinedSheetRequestedName || '')
    };
  }

  function internalFallbackContextMatches(context) {
    const state = context?.state;
    return Boolean(state
      && activeMergeState() === state
      && activeMergeMeta()?.kind === 'excel'
      && Number(state.inspectionGeneration || 0) === context.inspectionGeneration
      && mergeStateInputSignature(state) === context.sourceSignature
      && String(state.outputToken || '') === context.outputToken
      && String($('#documentMergeOutputName')?.value || '') === context.resultName
      && (state.addCombinedSheet === true) === context.addCombinedSheet
      && (state.useFileNameAsSheetName === true) === context.useFileNameAsSheetName
      && String(state.combinedSheetRequestedName || '') === context.combinedSheetRequestedName);
  }

  function markExcelInternalFallbackInspectionFailure(state, meta, files, error) {
    if (!excelInternalFallbackEligible(error, state, meta)) return false;
    const reason = safeMergeFailureMessage(error);
    let marked = 0;
    for (const file of files || []) {
      if (!state.files.includes(file) || normalizeDocumentExtension(file?.extension || file?.name) !== 'xlsx') continue;
      file.status = 'internal-ready';
      file.error = '';
      file.internalFallbackAvailable = true;
      file.internalFallbackReason = reason;
      marked += 1;
    }
    if (!marked) return false;
    state.internalFallbackSuggested = true;
    state.internalFallbackPrompted = false;
    state.internalFallbackReason = reason;
    state.internalFallback = false;
    state.requiresPreview = true;
    return true;
  }

  function clearExcelInternalFallbackSuggestion(state, { preservePrompted = false } = {}) {
    state.internalFallbackSuggested = false;
    if (!preservePrompted) state.internalFallbackPrompted = false;
    state.internalFallbackReason = '';
    for (const file of state.files || []) {
      delete file.internalFallbackAvailable;
      delete file.internalFallbackReason;
      if (file.status === 'internal-ready') file.status = 'ready';
    }
  }

  function mergeInputRequiresReview(file, meta) {
    const extension = normalizeDocumentExtension(file?.extension || file?.name);
    return (meta.kind === 'word' && extension !== 'docx') || (meta.kind === 'excel' && extension !== 'xlsx');
  }

  function mergeSourcesCompatible(state, meta) {
    if (meta.kind !== 'pptx') return true;
    const sizes = state.files.map((file) => file.slideSize || file.metadata?.slideSize).filter((size) => Number(size?.width) > 0 && Number(size?.height) > 0);
    if (sizes.length < 2) return true;
    const first = sizes[0];
    return sizes.every((size) => Math.abs(Number(size.width) - Number(first.width)) < 0.01 && Math.abs(Number(size.height) - Number(first.height)) < 0.01);
  }

  function mergeFileKey(file) {
    return String(file.key || file.token || `${file.name}:${file.bytes || 0}`);
  }

  function normalizeMergeFile(file) {
    const sheets = normalizeMergeSheets(file);
    return {
      ...file,
      itemId: String(file.itemId || crypto.randomUUID()),
      key: mergeFileKey(file),
      name: String(file.name || '이름 없는 파일'),
      bytes: Number(file.bytes || 0),
      ...(sheets.length ? { sheets, sheetCount: Number(file.sheetCount) || sheets.length } : {}),
      status: String(file.status || 'ready'),
      error: String(file.error || '')
    };
  }

  function setMergeResultPending(state) {
    state.completed = false; state.outcome = ''; state.outputFileToken = ''; state.progressValue = 0; state.progressVisible = false;
    state.contentVerified = false;
    state.internalFallback = false;
    state.internalFallbackPrompted = false;
    state.lastProgressEngine = ''; state.lastProgressPhase = ''; state.lastProgressIndex = -1;
    state.baseStrategy = ''; state.resultPageCount = 0; state.resultSectionCount = 0; state.headerFooterLinksDetached = 0; state.headerFooterLinkFailures = 0; state.resultSheetCount = 0; state.resultSheetNames = []; state.resultSheetTypes = []; state.resultSheetVisibility = []; state.sourcePageCounts = []; state.sourceSheetCounts = [];
    if (Object.prototype.hasOwnProperty.call(state, 'addCombinedSheet')) {
      state.combinedSheetAdded = false; state.combinedSheetName = ''; state.combinedRowCount = 0; state.combinedColumnCount = 0;
    }
    $('#documentMergeRunTitle')?.closest('.document-run-card')?.classList.remove('has-error');
    $('#openDocumentMergeOutput').hidden = true;
    $('#previewDocumentMergeOutput').hidden = true;
    $('#documentMergeProgress').hidden = true;
  }

  function renderMergeOutputLocation(state) {
    const summary = $('#documentMergeOutputSummary');
    if (state.outputToken) summary.replaceChildren(element('strong', '', state.outputName || '선택한 폴더'), element('span', '', '이 폴더에 합친 파일 하나를 저장합니다.'));
    else summary.replaceChildren(element('strong', '', '저장 폴더를 선택해주세요.'), element('span', '', '원본 파일은 변경하지 않습니다.'));
  }

  function renderMergePreview(state, meta) {
    const preview = $('#documentMergePreview'); preview.replaceChildren();
    if (!state.files.length) {
      const empty = element('div', 'document-merge-preview-empty');
      empty.append(element('strong', '', '아직 확인할 파일이 없습니다.'), element('span', '', '왼쪽에서 파일을 선택하면 합칠 순서가 표시됩니다.'));
      preview.append(empty);
    }
    const excelPlan = meta.kind === 'excel' ? excelMergeSheetPlan(state) : [];
    if (meta.kind === 'word' && state.files.length) {
      const revisionCount = state.files.reduce((sum, file) => sum + Math.max(0, Number(file.revisionCount) || 0), 0);
      const commentCount = state.files.reduce((sum, file) => sum + Math.max(0, Number(file.commentCount) || 0), 0);
      if (revisionCount || commentCount) {
        const notice = element('div', 'notice warning document-merge-sheet-notice');
        notice.append(
          element('strong', '', '변경 내용 또는 댓글이 있는 문서입니다.'),
          element('span', '', `변경 내용 ${revisionCount}개 · 댓글 ${commentCount}개 · 완료된 Word 파일에서 표시와 배치를 확인해주세요.`)
        );
        preview.append(notice);
      }
    }
    if (meta.kind === 'excel' && state.files.length) {
      const missingFonts = [...new Set((state.fontReports || []).flatMap((report) => (
        Array.isArray(report?.missingFonts) ? report.missingFonts : []
      )).map((family) => String(family || '').trim()).filter(Boolean))];
      if (missingFonts.length) {
        const names = `${missingFonts.slice(0, 4).join(', ')}${missingFonts.length > 4 ? ` 외 ${missingFonts.length - 4}개` : ''}`;
        const notice = element('div', 'notice warning document-merge-sheet-notice');
        notice.append(
          element('strong', '', '없는 글꼴이 있어도 Excel 합치기는 진행됩니다.'),
          element('span', '', `${names} · 시트의 글꼴 지정값은 유지되지만 이 PC의 화면·인쇄에서는 대체 글꼴로 보일 수 있으니 완료 파일을 확인해주세요.`)
        );
        preview.append(notice);
      }
      const renamed = excelPlan.flatMap((entry) => entry.sheets).filter((sheet) => sheet.renamed);
      if (renamed.length) {
        const example = renamed.slice(0, 3).map((sheet) => `“${sheet.name}” → “${sheet.outputName}”`).join(' · ');
        const notice = element('div', 'notice info document-merge-sheet-notice');
        const fileNamed = renamed.some((sheet) => sheet.renamedByFileName);
        notice.append(
          element('strong', '', fileNamed ? '단일 시트 파일은 파일명으로 표시합니다.' : '같은 시트 이름을 자동으로 구분합니다.'),
          element('span', '', `${example}${renamed.length > 3 ? ` 외 ${renamed.length - 3}개` : ''}`)
        );
        preview.append(notice);
      }
      const externalLinkCount = state.files.reduce((sum, file) => sum + Number(file.externalLinkCount || (file.externalLinksPresent ? 1 : 0)), 0);
      if (externalLinkCount) {
        const notice = element('div', 'notice warning document-merge-sheet-notice');
        notice.append(element('strong', '', '외부 파일 연결이 있는 시트입니다.'), element('span', '', '수식의 외부 연결 대상은 새 파일에서도 그대로 남을 수 있으니 결과 미리보기에서 확인해주세요.'));
        preview.append(notice);
      }
    }
    const addCombinedSheet = meta.kind === 'excel' && state.addCombinedSheet === true;
    if (addCombinedSheet && state.files.length) {
      const combinedName = excelCombinedSheetName(state, excelPlan);
      const item = element('div', 'document-merge-preview-item combined-sheet');
      const thumb = element('div', 'document-merge-preview-thumb', 'ALL');
      const copy = element('div', 'document-merge-preview-copy');
      copy.append(
        element('small', '', '결과 1번째 시트 · 새로 생성'),
        element('strong', '', combinedName),
        element('span', 'document-merge-sheet-flow', '첫 헤더 1회 · 이후 워크시트의 첫 행 제외 · 계산된 값 모음 · 원본 시트 유지')
      );
      item.append(thumb, copy); preview.append(item);
    }
    let runningCount = addCombinedSheet ? 1 : 0; let rangesKnown = true;
    state.files.forEach((file, index) => {
      const count = mergeFileCount(file, meta);
      let range = '분량 확인 중';
      if (meta.kind === 'word' && count !== null) range = `${count}${meta.unit} · 다음 문서는 새 페이지에서 시작`;
      else if (meta.kind === 'excel' && count !== null && rangesKnown) range = count ? `결과 ${runningCount + 1}${count > 1 ? `–${runningCount + count}` : ''}번째 시트` : '시트 없음';
      else if (count !== null && rangesKnown) range = count ? `${runningCount + 1}–${runningCount + count}${meta.unit}` : `0${meta.unit}`;
      else if (count !== null) range = `${count}${meta.unit}`;
      if (count === null) rangesKnown = false; else runningCount += count;
      const item = element('div', 'document-merge-preview-item');
      const thumb = element('div', 'document-merge-preview-thumb');
      if (file.previewUrl) {
        const image = element('img'); image.src = file.previewUrl; image.alt = `${file.name} 미리보기`; thumb.append(image);
      } else thumb.textContent = meta.kind === 'pptx'
        ? 'PPT'
        : meta.kind === 'word'
        ? 'WORD'
        : meta.kind === 'excel'
        ? 'XLS'
        : meta.kind === 'documents'
        ? normalizeDocumentExtension(file.extension || file.name).toUpperCase() || '문서'
        : 'PDF';
      const copy = element('div', 'document-merge-preview-copy');
      copy.append(element('small', '', `${index + 1}번째 · ${range}`), element('strong', '', file.name));
      if (meta.kind === 'excel') {
        const sheets = excelPlan[index]?.sheets || [];
        if (sheets.length) {
          const labels = sheets.map((sheet) => sheet.renamed ? `${sheet.name} → ${sheet.outputName}` : sheet.outputName);
          const visible = labels.slice(0, 3).join(' · ');
          const flow = element('span', 'document-merge-sheet-flow', `${visible}${labels.length > 3 ? ` · 외 ${labels.length - 3}개` : ''}`);
          flow.title = labels.join(' · '); flow.setAttribute('aria-label', `${file.name} 시트 순서: ${labels.join(', ')}`); copy.append(flow);
        }
      }
      item.append(thumb, copy); preview.append(item);
    });
    const knownCounts = state.files.map((file) => mergeFileCount(file, meta));
    const allKnown = knownCounts.every((count) => count !== null);
    const total = knownCounts.reduce((sum, count) => sum + Number(count || 0), 0) + (addCombinedSheet && state.files.length ? 1 : 0);
    const metrics = $('#documentMergeTotals').children;
    metrics[0].querySelector('strong').textContent = String(state.files.length);
    metrics[1].querySelector('small').textContent = meta.kind === 'word' ? '예상 전체 쪽' : meta.kind === 'excel' ? '결과 전체 시트' : `전체 ${meta.unit}`;
    metrics[1].querySelector('strong').textContent = allKnown ? String(total) : `${total || 0}+`;
  }

  function mergeRequiresPreparation(state, meta) {
    if (!['documents', 'word', 'excel'].includes(meta.kind)) return false;
    return Boolean(
      state.availability?.blocked
      || state.missingDependencies?.length
      || state.runningDependencies?.length
      || state.requiredFonts?.length
    );
  }

  function applyMergePreparationResult(state, result = {}) {
    if (result.availability !== undefined) state.availability = result.availability;
    if (result.preparationPlan !== undefined) state.preparationPlan = result.preparationPlan;
    if (Array.isArray(result.requiredDependencies)) state.requiredDependencies = result.requiredDependencies;
    if (Array.isArray(result.missingDependencies)) state.missingDependencies = result.missingDependencies;
    if (Array.isArray(result.runningDependencies)) state.runningDependencies = result.runningDependencies;
    if (Array.isArray(result.requiredFonts)) state.requiredFonts = result.requiredFonts.map(String);
    if (Array.isArray(result.fontReports)) state.fontReports = result.fontReports;
    if (Array.isArray(result.inspectionUnavailable)) state.inspectionUnavailable = result.inspectionUnavailable;
    if (Array.isArray(result.compatibilityInputs)) state.compatibilityInputs = result.compatibilityInputs;
    if (result.requiresPreview !== undefined) state.requiresPreview = result.requiresPreview === true;
    if (result.engine !== undefined) state.engine = String(result.engine || '').slice(0, 80);
    if (result.compatibilityFallback !== undefined) state.compatibilityFallback = result.compatibilityFallback === true;
    if (result.fallbackSupported !== undefined) state.fallbackSupported = result.fallbackSupported === true;
    if (Array.isArray(result.fallbackUnsupportedReasons)) state.fallbackUnsupportedReasons = result.fallbackUnsupportedReasons.map(String).slice(0, 20);
    if (Array.isArray(result.warnings)) state.warnings = result.warnings.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 20);
    if (result.contentVerified !== undefined) state.contentVerified = result.contentVerified === true;
  }

  function resetMergeInspectionState(state) {
    state.inspectionGeneration = Number(state.inspectionGeneration || 0) + 1;
    state.inspecting = false;
    state.availability = null; state.preparationPlan = null;
    state.requiredDependencies = []; state.missingDependencies = []; state.runningDependencies = [];
    state.requiredFonts = []; state.fontReports = []; state.inspectionUnavailable = [];
    state.compatibilityInputs = []; state.requiresPreview = false; state.engine = '';
    state.compatibilityFallback = false; state.fallbackSupported = false; state.fallbackUnsupportedReasons = [];
    state.warnings = []; state.contentVerified = false;
    state.internalFallback = false;
    clearExcelInternalFallbackSuggestion(state);
  }

  function renderMergeDependency(state, meta) {
    const card = $('#documentMergeDependencyCard');
    const button = $('#prepareDocumentMergeDependencies');
    if (!card || !button || !['documents', 'word', 'excel'].includes(meta.kind) || !mergeRequiresPreparation(state, meta)) {
      if (card) card.hidden = true;
      return;
    }
    const plan = state.preparationPlan || {};
    const kinds = dependencyPlanKinds(plan);
    const running = state.runningDependencies || [];
    const missingFonts = state.requiredFonts || [];
    const missingApps = (state.missingDependencies || []).map(conversionDependencyLabel).filter(Boolean);
    const names = [...missingApps, ...missingFonts.map((family) => `글꼴 ${family}`)];
    const preparationCopy = dependencyPreparationCopy(kinds, running);
    $('#documentMergeDependencyTitle').textContent = preparationCopy.title;
    $('#documentMergeDependencyDetail').textContent = `${names.join(' · ') || '필요한 구성요소'} · ${preparationCopy.detail}`;
    button.textContent = state.preparing ? '준비하는 중…' : preparationCopy.button;
    button.disabled = state.preparing || state.running;
    card.hidden = false;
  }

  function renderMergeCapability(meta) {
    const badge = $('#documentMergeFormatBadge');
    const state = activeMergeState();
    setEngineBadgeApplication(badge, meta.kind === 'word'
      ? 'word'
      : meta.kind === 'excel'
      ? 'excel'
      : meta.kind === 'pptx'
      ? 'powerpoint'
      : '');
    if (guideDemo.active) {
      badge.className = 'engine-badge ready'; setEngineBadgeText(badge, '가이드 병합 환경'); badge.title = '실제 파일을 열거나 저장하지 않고 순서와 완료 화면을 연습합니다.'; return true;
    }
    if (meta.kind === 'pdf') {
      badge.className = 'engine-badge ready'; setEngineBadgeText(badge, '별도 프로그램 필요 없음'); badge.title = 'PDF 파일만으로 안전하게 합칩니다.'; return true;
    }
    if (meta.kind === 'documents') {
      const blocked = state ? mergeRequiresPreparation(state, meta) : false;
      const running = Boolean(state?.runningDependencies?.length);
      const review = Boolean(state?.requiresPreview);
      badge.className = `engine-badge ${blocked || review ? 'limited' : 'ready'}`;
      setEngineBadgeText(badge, running ? '문서 프로그램 사용 중' : blocked ? '필요한 구성 준비' : review ? '완료 후 결과 확인' : '원본 형식 자동 확인');
      badge.title = blocked ? '원본 프로그램과 정확한 글꼴을 준비해야 합니다.' : review ? '글꼴 사전 검사가 불가능한 형식은 원본 프로그램으로 처리하고 최종 PDF를 확인해야 합니다.' : '각 문서를 원본 프로그램으로 PDF로 만든 뒤 목록 순서대로 합칩니다.';
      return !blocked;
    }
    const status = converter.capabilities || {};
    const blocked = state ? mergeRequiresPreparation(state, meta) : false;
    if (blocked) {
      const running = Boolean(state?.runningDependencies?.length);
      badge.className = 'engine-badge limited';
      setEngineBadgeText(badge, running ? '문서 프로그램 닫기 필요' : '필요한 구성 준비');
      badge.title = running
        ? '열려 있는 문서 프로그램을 닫고 다시 확인해주세요.'
        : '원본 구조와 글꼴을 보존하기 위한 준비 항목을 먼저 확인해주세요.';
      return false;
    }
    if (meta.kind === 'excel' && (state?.internalFallbackSuggested || state?.internalFallback || /internal-excel/i.test(String(state?.engine || '')))) {
      setEngineBadgeApplication(badge, '');
      badge.className = 'engine-badge limited';
      setEngineBadgeText(badge, 'CMOE 내부 병합 · 결과 확인');
      badge.title = '일반 방식으로 열지 못한 XLSX를 셀 값과 기본 서식 중심의 새 파일로 만듭니다. 실행 전에 변경 가능성을 확인합니다.';
      return true;
    }
    if (meta.kind === 'excel' && state?.compatibilityFallback) {
      setEngineBadgeApplication(badge, 'libreoffice');
      badge.className = 'engine-badge limited';
      setEngineBadgeText(badge, 'LibreOffice 호환 병합 · 결과 확인');
      badge.title = 'Microsoft Excel이 없는 PC에서 XLSX 시트를 파일 순서와 시트 순서대로 합칩니다. 저장 후 시트 순서와 셀·수식·도형 수를 다시 검사하지만 일부 Excel 고급 서식은 달라질 수 있어 결과 확인이 필요합니다.';
      return true;
    }
    const compatibilityReview = Boolean(state?.files?.some((file) => mergeInputRequiresReview(file, meta)));
    const resultReview = Boolean(state?.requiresPreview);
    const nativeOffice = meta.kind === 'word'
      ? { available: status.word, running: status.wordRunning, name: 'Word', readyTitle: '페이지·구역·머리글·바닥글을 유지해 문서를 순서대로 연결합니다.', missingTitle: '페이지·구역·머리글을 유지한 병합에는 Microsoft Word가 필요합니다.' }
      : meta.kind === 'excel'
      ? { available: status.excel, running: status.excelRunning, name: 'Excel', readyTitle: '시트·수식·차트·서식을 유지해 파일과 시트 순서대로 복사합니다.', missingTitle: '시트·수식·차트·서식을 유지한 병합에는 Microsoft Excel이 필요합니다.' }
      : { available: status.powerPoint, running: status.powerPointRunning, name: 'PowerPoint', readyTitle: '원본 슬라이드의 글꼴·테마·마스터·미디어를 유지해 합칩니다.', missingTitle: 'PPTX 디자인을 그대로 유지한 병합에는 Microsoft PowerPoint가 필요합니다.' };
    if (nativeOffice.available && !nativeOffice.running) {
      badge.className = `engine-badge ${resultReview ? 'limited' : 'ready'}`;
      setEngineBadgeText(badge, compatibilityReview ? '호환 입력 · 결과 확인' : resultReview ? '완료 후 결과 확인' : `Microsoft ${nativeOffice.name} 사용`);
      badge.title = compatibilityReview
        ? meta.kind === 'word'
          ? 'DOC·ODT·RTF를 Word 호환 방식으로 가져와 DOCX로 연결하므로 완료 후 페이지와 서식을 확인해야 합니다.'
          : 'XLS·ODS·CSV를 Excel 호환 방식으로 가져와 XLSX로 복사하므로 완료 후 수식·차트·서식을 확인해야 합니다.'
        : resultReview
        ? meta.kind === 'word'
          ? 'Word가 페이지·구역·필드를 다시 계산할 수 있으므로 완료된 DOCX를 한 번 확인합니다.'
          : '시트 밖의 통합문서 연결·이름·데이터 기능을 확인하기 위해 완료된 XLSX를 한 번 확인합니다.'
        : nativeOffice.readyTitle;
      return true;
    }
    if (nativeOffice.running) {
      badge.className = 'engine-badge limited'; setEngineBadgeText(badge, `${nativeOffice.name} 닫기 필요`); badge.title = `열려 있는 Microsoft ${nativeOffice.name} 문서를 보호하기 위해 먼저 닫아야 합니다.`; return false;
    }
    badge.className = 'engine-badge unavailable'; setEngineBadgeText(badge, `Microsoft ${nativeOffice.name} 필요`); badge.title = nativeOffice.missingTitle; return false;
  }

  function renderMergeFiles(state, meta) {
    if (['word', 'excel'].includes(meta.kind)) {
      state.compatibilityInputs = state.files.map((file, index) => ({ file, index })).filter(({ file }) => mergeInputRequiresReview(file, meta)).map(({ file, index }) => ({ index, name: file.name, extension: normalizeDocumentExtension(file.extension || file.name) }));
      const liveTokens = new Set(state.files.map((file) => String(file.token || '')).filter(Boolean));
      const hasLiveUnavailableInspection = (state.inspectionUnavailable || []).some((item) => !item?.token || liveTokens.has(String(item.token)));
      state.requiresPreview = state.files.length > 0 || state.compatibilityInputs.length > 0 || hasLiveUnavailableInspection;
    }
    const list = $('#documentMergeFileList'); list.replaceChildren();
    if (!state.files.length) list.append(element('li', 'list-empty', `합칠 ${meta.label} 파일을 선택하세요.`));
    state.files.forEach((file, index) => {
      const row = element('li', 'document-merge-file-row');
      row.dataset.documentMergeIndex = String(index); row.draggable = false;
      const order = element('span', 'document-merge-order', String(index + 1));
      const handle = element('span', 'document-merge-drag-handle');
      handle.dataset.documentMergeDragHandle = 'true'; handle.setAttribute('draggable', String(!state.running)); handle.title = '끌어서 순서 변경'; handle.setAttribute('aria-hidden', 'true');
      const copy = element('div', 'document-file-copy');
      const count = mergeFileCount(file, meta);
      const details = [formatBytes(file.bytes), count === null ? '분량 확인 중' : `${count}${meta.unit}`, mergeInputRequiresReview(file, meta) ? '호환 입력 · 결과 확인 필요' : ''].filter(Boolean).join(' · ');
      copy.append(element('strong', '', file.name), element('small', '', details));
      if (file.internalFallbackAvailable === true && file.status === 'internal-ready') {
        const fallbackStatus = '일반 방식으로 열지 못함 · 내부 병합 가능';
        const fallbackNode = element('span', 'document-file-status', fallbackStatus);
        fallbackNode.title = `${fallbackStatus}${file.internalFallbackReason ? ` · ${file.internalFallbackReason}` : ''}`;
        copy.append(fallbackNode);
      } else if (mergeFileHasIssue(file)) copy.append(element('span', 'document-file-status failed', file.error || '이 파일을 합칠 수 없습니다.'));
      const actions = element('div', 'document-merge-row-actions');
      const up = element('button', 'icon-button', '↑'); up.type = 'button'; up.dataset.documentMergeMove = 'up'; up.dataset.documentMergeIndex = String(index); up.title = '한 칸 위로'; up.setAttribute('aria-label', `${file.name} 한 칸 위로`); up.disabled = state.running || index === 0;
      const down = element('button', 'icon-button', '↓'); down.type = 'button'; down.dataset.documentMergeMove = 'down'; down.dataset.documentMergeIndex = String(index); down.title = '한 칸 아래로'; down.setAttribute('aria-label', `${file.name} 한 칸 아래로`); down.disabled = state.running || index === state.files.length - 1;
      const remove = element('button', 'document-file-remove', '×'); remove.type = 'button'; remove.dataset.documentMergeRemove = String(index); remove.setAttribute('aria-label', `${file.name} 목록에서 삭제`); remove.disabled = state.running;
      actions.append(up, down, remove); row.append(order, handle, copy, actions); list.append(row);
    });
    const totalBytes = state.files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
    const orderSummary = meta.kind === 'excel'
      ? '파일 순서 → 각 파일 안의 시트 순서'
      : meta.kind === 'word'
      ? '위에서 아래 순서 · 다음 파일은 새 페이지에서 시작'
      : '위에서 아래 순서로 합침';
    $('#documentMergeFileSummary').textContent = state.files.length ? `${state.files.length}개 파일 · ${formatBytes(totalBytes)} · ${orderSummary}` : '선택한 파일이 없습니다.';
    $('#reverseDocumentMergeFiles').disabled = state.running || state.files.length < 2;
    $('#clearDocumentMergeFiles').disabled = state.running || !state.files.length;
    $('#chooseDocumentMergeFiles').disabled = state.running;
    renderMergePreview(state, meta); renderMergeDependency(state, meta); updateMergeReady(state, meta);
  }

  function updateMergeReady(state = activeMergeState(), meta = activeMergeMeta()) {
    if (!state || !meta) return;
    const rawName = $('#documentMergeOutputName').value;
    const stem = cleanMergeResultName(rawName, meta);
    const invalidName = !String(rawName || '').trim();
    $('#documentMergeOutputName').setAttribute('aria-invalid', String(invalidName));
    state.resultName = stem;
    const nativeCapabilityReady = renderMergeCapability(meta);
    const hasInternalFallbackInput = meta.kind === 'excel'
      && state.internalFallbackSuggested === true
      && state.files.some((file) => file.internalFallbackAvailable === true);
    const hasRequiredApp = hasInternalFallbackInput || nativeCapabilityReady;
    const compatibleSources = mergeSourcesCompatible(state, meta);
    const issueFile = state.files.find(mergeFileHasIssue);
    const emptyFile = state.files.find((file) => mergeFileCount(file, meta) === 0);
    const metadataReady = !['word', 'excel'].includes(meta.kind) || state.files.every((file) => (
      mergeFileCount(file, meta) !== null
      || (meta.kind === 'excel' && file.internalFallbackAvailable === true && file.status === 'internal-ready')
    ));
    const ready = state.files.length >= 2 && state.outputToken && !invalidName && hasRequiredApp && compatibleSources && !issueFile && !emptyFile && metadataReady && !state.inspecting && !state.running;
    const run = $('#runDocumentMerge'); const cancel = $('#cancelDocumentMerge');
    run.disabled = !ready; run.textContent = state.running ? '합치는 중…' : `${meta.label} 하나로 합치기`;
    cancel.hidden = !state.running; cancel.disabled = state.cancelling; cancel.textContent = state.cancelling ? '중단 요청됨…' : '작업 중단';
    $('#chooseDocumentMergeOutput').disabled = state.running;
    $('#documentMergeOutputName').disabled = state.running;
    const combinedSheetToggle = $('#documentMergeAddCombinedSheet');
    if (combinedSheetToggle) combinedSheetToggle.disabled = state.running;
    const fileNameSheetToggle = $('#documentMergeUseFileNameAsSheetName');
    if (fileNameSheetToggle) fileNameSheetToggle.disabled = state.running;
    const combinedSheetNameInput = $('#documentMergeCombinedSheetName');
    if (combinedSheetNameInput) combinedSheetNameInput.disabled = state.running || state.addCombinedSheet !== true;
    $$('[data-document-merge-mode]', $('#documentMergeModeSwitch')).forEach((button) => { button.disabled = state.running; button.setAttribute('aria-disabled', String(state.running)); });
    if (state.running) {
      state.runTitle = state.cancelling ? '안전하게 중단하는 중' : `${meta.label} 파일을 합치는 중`;
      state.runStatus = state.cancelling
        ? '현재 파일 처리를 마친 뒤 멈춥니다. 원본 파일은 바뀌지 않습니다.'
        : meta.kind === 'excel' && state.addCombinedSheet
        ? `전체 시트의 헤더가 같은지 확인한 뒤, 원본 시트를 복사하고 맨 앞에 “${excelCombinedSheetName(state)}” 시트를 만들고 있습니다.`
        : `목록의 ${state.files.length}개 파일을 위에서 아래 순서로 처리하고 있습니다.`;
      $('#documentMergeRunTitle').textContent = state.runTitle;
      $('#documentMergeRunStatus').textContent = state.runStatus;
      return;
    }
    if (state.outcome) { $('#documentMergeRunTitle').textContent = state.runTitle; $('#documentMergeRunStatus').textContent = state.runStatus; return; }
    state.runTitle = ready ? `${state.files.length}개 파일 합치기 준비됨` : '합치기 준비';
    state.runStatus = state.files.length < 2
      ? `합칠 ${meta.label} 파일을 2개 이상 선택해주세요.`
      : !hasRequiredApp
      ? meta.kind === 'documents'
        ? state.runningDependencies?.length
          ? '작업 중인 문서 프로그램을 닫고 위 버튼으로 다시 확인해주세요.'
          : '위의 준비 버튼을 누르면 필요한 원본 프로그램과 정확한 글꼴을 준비할 수 있습니다.'
        : meta.kind === 'word'
        ? converter.capabilities?.wordRunning
          ? '열려 있는 Word를 모두 닫아주세요. 목록과 저장 위치는 그대로 유지됩니다.'
          : '페이지·구역·머리글을 유지한 채 합치려면 Microsoft Word가 필요합니다.'
        : meta.kind === 'excel'
        ? converter.capabilities?.excelRunning
          ? '열려 있는 Excel을 모두 닫아주세요. 목록과 저장 위치는 그대로 유지됩니다.'
          : '시트·수식·차트·서식을 그대로 복사하려면 Microsoft Excel이 필요합니다.'
        : converter.capabilities?.powerPointRunning
        ? '열려 있는 PowerPoint를 닫으면 원본 디자인을 유지해 합칠 수 있습니다.'
        : 'PPTX의 글꼴·테마·미디어를 그대로 유지해 합치려면 Microsoft PowerPoint가 필요합니다.'
      : issueFile
      ? `“${issueFile.name}”을 합칠 수 없습니다. ${issueFile.error || '파일을 확인하거나 목록에서 제거해주세요.'}`
      : hasInternalFallbackInput
      ? '일반 방식으로 열지 못한 XLSX가 있습니다. 합치기를 누르면 CMOE 내부 병합의 변경 가능성을 확인합니다.'
      : emptyFile
      ? `“${emptyFile.name}”에서 합칠 ${meta.kind === 'excel' ? '시트' : '내용'}를 찾지 못했습니다. 원본 파일을 확인해주세요.`
      : state.inspecting || !metadataReady
      ? `${meta.label} 파일의 ${meta.kind === 'excel' ? '시트' : '분량'}을 확인하고 있습니다.`
      : !compatibleSources
      ? '슬라이드 크기가 다른 PPTX가 섞여 있습니다. 같은 화면 비율·크기의 파일끼리 합쳐주세요.'
      : !state.outputToken
      ? '결과를 저장할 폴더를 선택해주세요.'
      : invalidName
      ? '결과 파일 이름을 입력해주세요.'
      : meta.kind === 'documents' && state.requiresPreview
      ? `“${stem}${meta.extension}” 파일을 만든 뒤 결과 미리보기에서 글꼴·줄바꿈·페이지를 확인합니다.`
      : meta.kind === 'excel' && state.addCombinedSheet
      ? `“${stem}${meta.extension}”에 원본 시트를 유지하고 맨 앞에 “${excelCombinedSheetName(state)}” 시트를 추가할 준비가 되었습니다.`
      : `“${stem}${meta.extension}” 파일 하나를 만들 준비가 되었습니다.`;
    $('#documentMergeRunTitle').textContent = state.runTitle; $('#documentMergeRunStatus').textContent = state.runStatus;
  }

  function renderDocumentMerge() {
    const state = activeMergeState(); const meta = activeMergeMeta();
    if (!state || !meta) return;
    $('#documentMergeTitle').textContent = `${meta.label} 합치기`;
    $('#documentMergeDescription').textContent = meta.kind === 'pdf'
      ? 'PDF의 모든 페이지를 목록 순서대로 이어 한 파일로 만듭니다.'
      : meta.kind === 'word'
      ? '각 파일을 목록 위에서 아래 순서대로 이어 하나의 Word 문서로 만듭니다. 다음 파일은 새 페이지에서 시작합니다.'
      : meta.kind === 'excel'
      ? '목록의 파일 순서에서 시작해 각 파일 안의 시트 순서대로 하나의 Excel 파일에 복사합니다.'
      : meta.kind === 'documents'
      ? 'PowerPoint·Word·한글·Excel·한셀·PDF를 원본 프로그램으로 PDF화한 뒤 목록 순서대로 한 파일에 잇습니다.'
      : 'PPTX의 모든 슬라이드를 목록 순서대로 이어 한 프레젠테이션으로 만듭니다.';
    const sourceHeading = $('#documentMergeFilesTitle')?.closest('.document-step-heading');
    const previewHeading = $('#documentMergePreviewTitle')?.closest('.document-step-heading');
    if (sourceHeading) sourceHeading.querySelector('p').textContent = meta.kind === 'excel'
      ? '위에서 아래 파일 순서대로, 각 파일 안에서는 기존 시트 순서대로 복사됩니다.'
      : meta.kind === 'word'
      ? '위에서 아래 순서대로 이어지며 다음 파일은 새 페이지에서 시작합니다.'
      : '파일을 고른 뒤 끌어 놓거나 화살표 버튼으로 순서를 정하세요.';
    if (previewHeading) previewHeading.querySelector('p').textContent = meta.kind === 'excel'
      ? '파일별 시트 순서와 결과에서 자동으로 구분될 같은 이름을 확인하세요.'
      : meta.kind === 'word'
      ? '문서가 이어질 순서와 예상 분량을 확인하세요. 실제 페이지는 완료 후 미리보기에서 확인합니다.'
      : '파일이 이어질 순서와 각 파일의 범위, 전체 분량을 확인하세요.';
    renderMergeCapability(meta);
    $('#documentMergeChooseLabel').textContent = `여러 ${meta.label} 파일 선택`;
    const chooseHint = $('#chooseDocumentMergeFiles span');
    if (chooseHint) chooseHint.textContent = meta.kind === 'word'
      ? 'DOCX는 직접 연결하며 DOC·ODT·RTF는 호환 입력이므로 완료 후 확인합니다.'
      : meta.kind === 'excel'
      ? 'XLSX는 시트를 직접 복사하며 XLS·ODS·CSV는 호환 입력이므로 완료 후 확인합니다.'
      : '추가로 선택한 파일은 현재 목록 뒤에 이어집니다.';
    $('#documentMergeOutputExtension').textContent = meta.extension;
    const excelOptions = $('#documentMergeExcelOptions');
    const combinedSheetToggle = $('#documentMergeAddCombinedSheet');
    const fileNameSheetToggle = $('#documentMergeUseFileNameAsSheetName');
    const combinedSheetNameField = $('#documentMergeCombinedSheetNameField');
    const combinedSheetNameInput = $('#documentMergeCombinedSheetName');
    if (excelOptions) excelOptions.hidden = meta.kind !== 'excel';
    if (fileNameSheetToggle) {
      fileNameSheetToggle.checked = meta.kind === 'excel' && state.useFileNameAsSheetName === true;
      fileNameSheetToggle.disabled = state.running;
    }
    if (combinedSheetToggle) {
      combinedSheetToggle.checked = meta.kind === 'excel' && state.addCombinedSheet === true;
      combinedSheetToggle.disabled = state.running;
    }
    if (combinedSheetNameField) combinedSheetNameField.hidden = meta.kind !== 'excel' || state.addCombinedSheet !== true;
    if (combinedSheetNameInput) {
      combinedSheetNameInput.value = state.combinedSheetRequestedName || '전체 통합';
      combinedSheetNameInput.disabled = state.running || state.addCombinedSheet !== true;
    }
    $('#documentMergeOutputName').value = state.resultName || meta.defaultName;
    $('#documentMergeProgress').max = Math.max(1, state.files.length); $('#documentMergeProgress').value = state.progressValue || 0; $('#documentMergeProgress').hidden = !state.progressVisible;
    $('#documentMergeRunTitle').textContent = state.runTitle; $('#documentMergeRunStatus').textContent = state.runStatus;
    $('#documentMergeRunTitle')?.closest('.document-run-card')?.classList.toggle('has-error', state.outcome === 'error');
    renderMergeOutputLocation(state); renderMergeFiles(state, meta);
    $('#openDocumentMergeOutput').hidden = !state.completed;
    $('#previewDocumentMergeOutput').hidden = !(state.completed && state.outputFileToken);
  }

  function setDocumentMode(mode, options = {}) {
    if (!DOCUMENT_MODE_META[mode]) return false;
    if (!options.force && documentMode !== mode && anyDocumentOperationActive()) {
      const readiness = documentToolGuideReadiness();
      notify(readiness.preparing
        ? '문서 프로그램 또는 글꼴 준비가 끝난 뒤 모드를 바꿔주세요.'
        : readiness.previewing
        ? '문서 미리보기가 완성된 뒤 모드를 바꿔주세요.'
        : '진행 중인 문서 작업을 마치거나 중단한 뒤 모드를 바꿔주세요.');
      return false;
    }
    documentMode = mode;
    const selectedPanel = DOCUMENT_MODE_META[mode].panel;
    $$('[data-document-mode-panel]', $('#page-documentEditor')).forEach((panel) => { panel.hidden = panel.dataset.documentModePanel !== selectedPanel; });
    $$('[data-document-mode]', $('#page-documentEditor')).forEach((button) => {
      const active = button.dataset.documentMode === mode || (selectedPanel === 'documentMerge' && button.dataset.documentMode === 'pdfMerge');
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    $$('[data-document-merge-mode]', $('#page-documentEditor')).forEach((button) => {
      const active = button.dataset.documentMergeMode === mode;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    $('#page-documentEditor').dataset.documentMode = mode;
    if (selectedPanel === 'documentMerge') renderDocumentMerge();
    if (mode === 'documentSplit') renderDocumentSplit();
    if (mode === 'excelDeduplicate') { renderExcelDeduplicate(); renderExcelCompare(); }
    if (mode === 'pptxPdf') { renderConverterFiles(); updateConverterReady(); }
    if (mode === 'certificateMaker') { renderCertificateFields(); renderCertificateGrid(); updateCertificateReady(); scheduleCertificateOverlayBounds(); }
    if ((mode === 'pptxPdf' || mode === 'certificateMaker') && pageIsActive(mode)) void refreshUnavailableCapabilities(mode);
    if (!guideDemo.active && ['pptxMerge', 'wordMerge', 'excelMerge'].includes(mode) && pageIsActive(mode)) void refreshCapabilities(true);
    if (!guideDemo.active && mode === 'documentSplit' && documentSplitKind === 'pptx' && pageIsActive(mode)) void refreshCapabilities(true);
    if (!guideDemo.active && mode === 'documentPdfMerge' && pageIsActive(mode) && mergeStates.documentPdfMerge.files.length) void inspectMergeFiles(mergeStates.documentPdfMerge, DOCUMENT_MODE_META.documentPdfMerge, mergeStates.documentPdfMerge.files);
    if (options.focus) $('[data-document-mode].active', $('#page-documentEditor'))?.focus();
    return true;
  }

  async function inspectMergeFiles(state, meta, files, options = {}) {
    const pending = (meta.kind === 'documents' || (options.forceAll && ['word', 'excel'].includes(meta.kind))
      ? files
      : files.filter((file) => mergeFileCount(file, meta) === null || (meta.kind === 'excel' && !normalizeMergeSheets(file).length))).filter((file) => file.token);
    if (!pending.length) return;
    const inspectionGeneration = Number(state.inspectionGeneration || 0) + 1;
    state.inspectionGeneration = inspectionGeneration;
    if (meta.kind === 'excel') clearExcelInternalFallbackSuggestion(state);
    state.inspecting = true;
    if (state === activeMergeState()) updateMergeReady(state, meta);
    try {
      const result = await DOCUMENT_MERGE_BRIDGE.inspectFiles(meta.kind, pending.map((file) => file.token));
      if (state.inspectionGeneration !== inspectionGeneration) return;
      const inspected = result?.files || result?.results || [];
      inspected.forEach((item, index) => {
        // The same source capability may intentionally appear more than once.
        // Preserve the request/response occurrence order instead of resolving
        // every duplicate token back to the first visible row.
        const requestedOccurrence = pending[index];
        const target = (requestedOccurrence && state.files.includes(requestedOccurrence) ? requestedOccurrence : null)
          || state.files.find((file) => item.itemId && file.itemId === item.itemId)
          || state.files.find((file) => item.token && file.token === item.token);
        if (!target) return;
        if (item.pageCount !== undefined) target.pageCount = item.pageCount;
        if (item.sectionCount !== undefined) target.sectionCount = item.sectionCount;
        if (item.revisionCount !== undefined) target.revisionCount = Math.max(0, Number(item.revisionCount) || 0);
        if (item.commentCount !== undefined) target.commentCount = Math.max(0, Number(item.commentCount) || 0);
        if (item.slideCount !== undefined) target.slideCount = item.slideCount;
        if (item.sheetCount !== undefined) target.sheetCount = item.sheetCount;
        if (Array.isArray(item.sheets) || Array.isArray(item.sheetNames)) target.sheets = normalizeMergeSheets(item);
        if (item.externalLinksPresent !== undefined) target.externalLinksPresent = item.externalLinksPresent === true;
        if (item.externalLinkCount !== undefined) target.externalLinkCount = Math.max(0, Number(item.externalLinkCount) || 0);
        if (item.requiresPreview !== undefined) target.requiresPreview = item.requiresPreview === true;
        if (item.internalFallbackRequired === true) {
          markExcelInternalFallbackInspectionFailure(state, meta, [target], {
            code: item.internalFallbackReasonCode || 'EXCEL_INTERNAL_FALLBACK_REQUIRED',
            message: String(item.internalFallbackReasonMessage || item.error || '일반 방식으로 이 XLSX를 안전하게 열지 못했습니다.'),
            internalFallbackEligible: true,
            details: item.details && typeof item.details === 'object' ? item.details : {}
          });
        } else if (item.ok === false || item.error) {
          const inspectionError = {
            code: item.code || item.reasonCode || '',
            workerCode: item.workerCode || '',
            message: String(item.error || item.message || '이 파일을 합칠 수 없습니다.'),
            internalFallbackEligible: item.internalFallbackEligible === true,
            details: item.details && typeof item.details === 'object' ? item.details : {}
          };
          if (!markExcelInternalFallbackInspectionFailure(state, meta, [target], inspectionError)) {
            target.status = 'failed';
            target.error = inspectionError.message;
            delete target.internalFallbackAvailable;
            delete target.internalFallbackReason;
          }
        } else {
          target.status = 'ready';
          target.error = '';
          delete target.internalFallbackAvailable;
          delete target.internalFallbackReason;
        }
        if (item.previewUrl) target.previewUrl = item.previewUrl;
      });
      applyMergePreparationResult(state, result || {});
      if (meta.kind === 'excel' && result?.internalFallbackRequired === true && !state.internalFallbackSuggested) {
        markExcelInternalFallbackInspectionFailure(state, meta, pending, {
          code: result.internalFallbackReasonCode || 'EXCEL_INTERNAL_FALLBACK_REQUIRED',
          message: String(result.internalFallbackReasonMessage || '일반 방식으로 선택한 XLSX를 안전하게 열지 못했습니다.'),
          internalFallbackEligible: true,
          details: result.details && typeof result.details === 'object' ? result.details : {}
        });
      }
      if (state.internalFallbackSuggested) state.requiresPreview = true;
    } catch (error) {
      if (state.inspectionGeneration === inspectionGeneration) {
        const internalFallbackAvailable = markExcelInternalFallbackInspectionFailure(state, meta, pending, error);
        if (!internalFallbackAvailable) {
          pending.forEach((file) => {
            if (!state.files.includes(file)) return;
            file.status = 'failed';
            file.error = String(error?.message || '파일을 확인하지 못했습니다.');
            delete file.internalFallbackAvailable;
            delete file.internalFallbackReason;
          });
        }
        if (state === activeMergeState()) notify(
          internalFallbackAvailable
            ? '일반 방식으로 안전하게 열지 못한 XLSX가 있습니다. 합치기를 누르면 CMOE 내부 병합 여부를 한 번 확인합니다.'
            : `파일을 확인하지 못했습니다: ${error.message}`,
          internalFallbackAvailable ? 'normal' : 'error'
        );
      }
    } finally {
      if (state.inspectionGeneration === inspectionGeneration) {
        state.inspecting = false;
        if (state === activeMergeState()) renderMergeFiles(state, meta);
      }
    }
  }

  async function prepareMergeDependencies() {
    const state = activeMergeState(); const meta = activeMergeMeta();
    if (!state || !['documents', 'word', 'excel'].includes(meta?.kind) || state.preparing || state.running) return;
    const actions = state.preparationPlan?.actions || [];
    if (!actions.length) {
      await refreshCapabilities(true);
      await inspectMergeFiles(state, meta, state.files, { forceAll: true });
      notify(mergeRequiresPreparation(state, meta) ? '아직 정확한 글꼴 또는 문서 프로그램을 찾지 못했습니다.' : '필요한 글꼴과 문서 프로그램을 확인했습니다.', mergeRequiresPreparation(state, meta) ? 'normal' : 'success');
      return;
    }
    state.preparing = true; renderMergeDependency(state, meta); updateMergeReady(state, meta);
    try {
      const requiredApplications = state.requiredDependencies?.length
        ? state.requiredDependencies
        : (state.missingDependencies || []).map((item) => typeof item === 'string' ? item : item.dependencyId || item.id).filter(Boolean);
      const result = await DOCUMENT_CONVERSION_BRIDGE.prepare({
        approved: true,
        requestId: crypto.randomUUID(),
        requiredApplications,
        requiredDependencies: requiredApplications,
        requiredFonts: state.requiredFonts || [],
        confirmedActionIds: actions.map((action) => action.id).filter(Boolean)
      });
      await refreshCapabilities(true);
      await inspectMergeFiles(state, meta, state.files, { forceAll: true });
      const outcome = dependencyPreparationOutcome(result, actions, !mergeRequiresPreparation(state, meta));
      notify(outcome.message, outcome.tone);
    } catch (error) {
      notify(`필요한 구성을 준비하지 못했습니다: ${error.message}`, 'error');
      if (state === activeMergeState()) $('#documentMergeDependencyDetail').textContent = error.message;
    } finally {
      state.preparing = false;
      if (state === activeMergeState() && meta === activeMergeMeta()) renderMergeFiles(state, meta);
    }
  }

  async function chooseMergeFiles() {
    const state = activeMergeState(); const meta = activeMergeMeta(); if (!state || !meta || state.running) return;
    try {
      const result = await DOCUMENT_MERGE_BRIDGE.chooseFiles(meta.kind);
      if (result?.canceled) return;
      if (meta.kind === 'excel') clearExcelInternalFallbackSuggestion(state);
      applyMergePreparationResult(state, result || {});
      const added = [];
      for (const rawFile of result?.files || []) {
        const file = normalizeMergeFile(rawFile); state.files.push(file); added.push(file);
      }
      setMergeResultPending(state);
      const inspectAll = ['documents', 'word', 'excel'].includes(meta.kind);
      void inspectMergeFiles(state, meta, inspectAll ? state.files : added, { forceAll: inspectAll && ['word', 'excel'].includes(meta.kind) });
      renderMergeFiles(state, meta);
    } catch (error) { notify(`${meta.label} 파일을 가져오지 못했습니다: ${error.message}`, 'error'); }
  }

  async function chooseMergeOutput() {
    const state = activeMergeState(); const meta = activeMergeMeta(); if (!state || !meta || state.running) return;
    try {
      const result = await DOCUMENT_MERGE_BRIDGE.chooseOutput(); if (result?.canceled) return;
      state.outputToken = result.token; state.outputName = result.name; setMergeResultPending(state); renderMergeOutputLocation(state); updateMergeReady(state, meta);
    } catch (error) { notify(`저장 폴더를 선택하지 못했습니다: ${error.message}`, 'error'); }
  }

  const MERGE_FAILURE_REASON_BY_CODE = Object.freeze({
    EXCEL_IN_USE: '열려 있는 Excel 통합문서를 보호하기 위해 작업을 시작하지 않았습니다.',
    WORD_IN_USE: '열려 있는 Word 문서를 보호하기 위해 작업을 시작하지 않았습니다.',
    EXCEL_START_FAILED: 'Excel 병합 프로그램을 실행하지 못했습니다.',
    WORD_START_FAILED: 'Word 병합 프로그램을 실행하지 못했습니다.',
    EXCEL_INPUT_OPEN_FAILED: '원본 Excel 파일을 안전하게 열지 못했습니다.',
    WORD_INPUT_OPEN_FAILED: '원본 Word 파일을 안전하게 열지 못했습니다.',
    EXCEL_SHEET_COPY_FAILED: '원본 시트를 선택한 순서대로 복사하지 못했습니다.',
    WORD_INSERT_FAILED: '원본 문서 내용을 선택한 순서대로 연결하지 못했습니다.',
    EXCEL_SHEET_NAME_FAILED: '결과 통합문서의 시트 이름을 안전하게 정리하지 못했습니다.',
    EXCEL_COMBINED_HEADER_MISSING: '전체 통합에 사용할 워크시트의 첫 행에서 헤더를 찾지 못해 파일을 저장하지 않았습니다.',
    EXCEL_COMBINED_HEADER_MISMATCH: '첫 행의 헤더가 기준 시트와 달라 완성 파일을 저장하기 전에 병합을 중단했습니다.',
    EXCEL_COMBINED_ROW_LIMIT_EXCEEDED: '전체 통합 데이터가 Excel 워크시트의 최대 행 수를 넘어 파일을 저장하지 않았습니다.',
    EXCEL_COMBINED_SHEET_FAILED: '헤더 확인을 마쳤지만 전체 통합 시트를 안전하게 만들지 못했습니다.',
    EXCEL_COMBINED_OUTPUT_VERIFY_FAILED: '전체 통합 시트를 포함한 결과를 다시 검사했을 때 내용이 일치하지 않아 파일을 저장하지 않았습니다.',
    EXCEL_SAVE_FAILED: '병합 결과를 XLSX 파일로 저장하지 못했습니다.',
    WORD_SAVE_FAILED: '병합 결과를 DOCX 파일로 저장하지 못했습니다.',
    EXCEL_OUTPUT_VERIFY_FAILED: '완성된 Excel 파일을 다시 열어 검증하지 못했습니다.',
    WORD_OUTPUT_VERIFY_FAILED: '완성된 Word 파일을 다시 열어 검증하지 못했습니다.',
    INTERNAL_EXCEL_MERGE_CONFIRMATION_REQUIRED: '이 XLSX는 CMOE 내부 Excel 병합 안내 확인이 필요합니다.',
    INTERNAL_EXCEL_INPUT_FORMAT_INVALID: 'CMOE 내부 Excel 병합은 XLSX 파일만 사용할 수 있습니다.',
    INTERNAL_EXCEL_INPUT_CHANGED: '선택한 XLSX 원본이 확인 중 바뀌었습니다.',
    INTERNAL_EXCEL_INPUT_UNREADABLE: 'CMOE 내부 Excel 병합이 원본 XLSX 내용을 읽지 못했습니다.',
    INTERNAL_EXCEL_WORKBOOK_OPEN_FAILED: 'CMOE 내부 Excel 병합이 원본 통합문서를 열지 못했습니다.',
    INTERNAL_EXCEL_ARCHIVE_INVALID: '원본 XLSX의 내부 파일 구성이 올바르지 않아 읽지 못했습니다.',
    INTERNAL_EXCEL_ARCHIVE_PATH_INVALID: '원본 XLSX 내부에 안전하지 않은 파일 경로가 있어 중단했습니다.',
    INTERNAL_EXCEL_ENCRYPTED_UNSUPPORTED: '암호화된 XLSX는 CMOE 내부 병합으로 처리할 수 없습니다.',
    INTERNAL_EXCEL_MACRO_REJECTED: '매크로가 포함된 통합문서는 CMOE 내부 병합으로 처리하지 않습니다.',
    INTERNAL_EXCEL_SIGNATURE_REJECTED: '디지털 서명이 있는 통합문서는 CMOE 내부 병합으로 처리하지 않습니다.',
    INTERNAL_EXCEL_WORKSHEET_MISSING: '원본 XLSX에서 합칠 워크시트를 찾지 못했습니다.',
    INTERNAL_EXCEL_MERGE_FAILED: 'CMOE 내부 Excel 병합이 새 XLSX를 완성하지 못했습니다.',
    INTERNAL_EXCEL_OUTPUT_VERIFICATION_FAILED: 'CMOE 내부 Excel 결과를 저장 후 다시 검증했을 때 내용이 일치하지 않았습니다.',
    INTERNAL_EXCEL_ROW_LIMIT_EXCEEDED: '워크시트의 최대 행 수를 넘어 내부 병합을 중단했습니다.',
    INTERNAL_EXCEL_COLUMN_LIMIT_EXCEEDED: '워크시트의 최대 열 수를 넘어 내부 병합을 중단했습니다.',
    INTERNAL_EXCEL_CELL_LIMIT_EXCEEDED: '안전하게 처리할 수 있는 셀 수를 넘어 내부 병합을 중단했습니다.',
    INTERNAL_EXCEL_TOTAL_SIZE_EXCEEDED: '안전하게 처리할 수 있는 전체 용량을 넘어 내부 병합을 중단했습니다.',
    LIBREOFFICE_EXCEL_MERGE_CONFIRMATION_REQUIRED: 'LibreOffice 호환 방식의 결과 확인 안내가 아직 승인되지 않았습니다.',
    LIBREOFFICE_EXCEL_MERGE_EXECUTABLE_INVALID: '설치된 LibreOffice 실행 파일을 확인하지 못했습니다.',
    LIBREOFFICE_EXCEL_MERGE_WORKER_MISSING: 'Excel 호환 병합 구성요소가 설치본에서 누락되었습니다.',
    LIBREOFFICE_EXCEL_MERGE_TIMEOUT: 'LibreOffice Excel 병합 시간이 초과되었습니다.',
    LIBREOFFICE_EXCEL_MERGE_INPUT_UNSUPPORTED: 'Excel이 없는 PC에서는 안전 검사를 통과한 XLSX 파일만 합칠 수 있습니다.',
    LIBREOFFICE_EXCEL_MERGE_INPUT_CHANGED: '선택한 Excel 원본이 확인 중 바뀌었습니다.',
    LIBREOFFICE_EXCEL_MERGE_STRUCTURE_UNSUPPORTED: '이 Excel 파일의 시트 구조는 LibreOffice 호환 방식으로 안전하게 합칠 수 없습니다.',
    LIBREOFFICE_EXCEL_MERGE_EXTERNAL_LINKS_UNSUPPORTED: '외부 연결이 있는 Excel 파일은 Microsoft Excel 방식이 필요합니다.',
    LIBREOFFICE_EXCEL_MERGE_SHEET_TYPE_UNSUPPORTED: '차트·대화상자·매크로 시트가 있는 파일은 Microsoft Excel 방식이 필요합니다.',
    LIBREOFFICE_EXCEL_MERGE_VISIBILITY_UNSUPPORTED: '매우 숨김 시트가 있는 파일은 Microsoft Excel 방식이 필요합니다.',
    LIBREOFFICE_EXCEL_MERGE_RESULT_INVALID: '저장 후 시트 수·순서·내용 검증이 일치하지 않았습니다.',
    LIBREOFFICE_START_FAILED: 'LibreOffice를 안전한 Excel 병합 모드로 실행하지 못했습니다.',
    LIBREOFFICE_INPUT_OPEN_FAILED: 'LibreOffice가 Excel 원본을 안전하게 열지 못했습니다.',
    LIBREOFFICE_SHEET_COPY_FAILED: 'LibreOffice가 Excel 시트를 선택한 순서대로 복사하지 못했습니다.',
    LIBREOFFICE_COMBINED_HEADER_MISSING: '전체 통합에 사용할 워크시트의 첫 행에서 헤더를 찾지 못해 파일을 저장하지 않았습니다.',
    LIBREOFFICE_COMBINED_HEADER_MISMATCH: '첫 행의 헤더가 기준 시트와 달라 완성 파일을 저장하기 전에 병합을 중단했습니다.',
    LIBREOFFICE_COMBINED_SHEET_CREATE_FAILED: '헤더 확인을 마쳤지만 전체 통합 시트를 안전하게 만들지 못했습니다.',
    LIBREOFFICE_COMBINED_SHEET_SIZE_INVALID: '전체 통합 데이터가 안전한 워크시트 처리 한도를 넘어 파일을 저장하지 않았습니다.',
    LIBREOFFICE_COMBINED_OUTPUT_CHANGED: '저장 후 전체 통합 시트의 헤더·행·열·내용이 달라 결과 파일을 게시하지 않았습니다.',
    LIBREOFFICE_EXCEL_COMBINED_HEADER_MISMATCH: '첫 행의 헤더가 기준 시트와 달라 완성 파일을 저장하기 전에 병합을 중단했습니다.',
    LIBREOFFICE_COMBINED_HEADER_MISMATCH: '첫 행의 헤더가 기준 시트와 달라 완성 파일을 저장하기 전에 병합을 중단했습니다.',
    LIBREOFFICE_EXCEL_COMBINED_SHEET_FAILED: '헤더 확인을 마쳤지만 전체 통합 시트를 안전하게 만들지 못했습니다.',
    LIBREOFFICE_COMBINED_SHEET_FAILED: '헤더 확인을 마쳤지만 전체 통합 시트를 안전하게 만들지 못했습니다.',
    LIBREOFFICE_EXCEL_COMBINED_OUTPUT_VERIFY_FAILED: '전체 통합 시트를 포함한 결과를 다시 검사했을 때 내용이 일치하지 않아 파일을 저장하지 않았습니다.',
    LIBREOFFICE_COMBINED_OUTPUT_VERIFY_FAILED: '전체 통합 시트를 포함한 결과를 다시 검사했을 때 내용이 일치하지 않아 파일을 저장하지 않았습니다.',
    LIBREOFFICE_FORMULA_REBIND_FAILED: '복사된 시트의 내부 수식 연결을 결과 파일에 다시 묶지 못했습니다.',
    LIBREOFFICE_SAVE_FAILED: 'LibreOffice가 병합 결과를 XLSX로 저장하지 못했습니다.',
    LIBREOFFICE_OUTPUT_CONTENT_CHANGED: '저장 후 다시 검사한 셀·수식·도형 정보가 원본과 달랐습니다.',
    LIBREOFFICE_OUTPUT_VERIFY_FAILED: '완성된 Excel 파일의 시트 순서와 내용을 다시 확인하지 못했습니다.'
  });

  function safeMergeDiagnosticFileName(value) {
    const parts = String(value || '').replace(/\0/g, '').split(/[\\/]/);
    return String(parts.at(-1) || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"|?*]/g, '')
      .trim()
      .slice(0, 160);
  }

  function safeMergeFailureMessage(error) {
    const details = error?.details && typeof error.details === 'object' ? error.details : {};
    const workerCode = String(details.workerCode || details.reasonCode || '').trim().toUpperCase();
    if (MERGE_FAILURE_REASON_BY_CODE[workerCode]) return MERGE_FAILURE_REASON_BY_CODE[workerCode];
    const directWorkerCode = String(error?.workerCode || '').trim().toUpperCase();
    if (MERGE_FAILURE_REASON_BY_CODE[directWorkerCode]) return MERGE_FAILURE_REASON_BY_CODE[directWorkerCode];
    const directCode = String(error?.code || '').trim().toUpperCase();
    if (MERGE_FAILURE_REASON_BY_CODE[directCode]) return MERGE_FAILURE_REASON_BY_CODE[directCode];
    const raw = String(error?.message || '')
      .replace(/^(?:(?:error invoking remote method\s+["'][^"']+["']\s*:\s*)|(?:uncaught exception\s*:\s*)|(?:error\s*:\s*))+/i, '')
      .replace(/(?:file:\/\/\/)?(?:[A-Z]:[\\/]|\\\\)[^\r\n]*?(?=\s(?:파일|문서|통합문서|시트|결과|병합)|[.!?]|$)/gi, '[로컬 경로]')
      .replace(/https?:\/\/\S+/gi, '[외부 주소]')
      .replace(/\b(?:NATIVE_OFFICE_MERGE_|LIBREOFFICE_|INTERNAL_EXCEL_|EXCEL_|WORD_)[A-Z0-9_]+\b/g, '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 420);
    return raw || '문서 병합 엔진이 작업을 완료하지 못했습니다.';
  }

  function mergeFailureStage(error, state) {
    const details = error?.details && typeof error.details === 'object' ? error.details : {};
    const code = `${String(error?.code || '')} ${String(error?.workerCode || '')} ${String(details.workerCode || details.reasonCode || '')}`.toUpperCase();
    const message = String(error?.message || '');
    const hint = `${code} ${message}`;
    if (/COMBINED_HEADER|HEADER_(?:MISMATCH|MISSING)|첫 행.*헤더|헤더.*(?:다르|불일치|찾지 못)/i.test(hint)) return { key: 'inspect', label: '첫 행 헤더 확인' };
    if (/INPUT|MACRO|PASSWORD|IRM|PROTECTED|SIGNED|SECURITY|EXTERNAL_LINK|INSPECTION|원본.*(?:열|검사|확인)/i.test(hint)) return { key: 'inspect', label: '원본 파일 검사' };
    if (/START|CLASSNOTREG|WORKER_MISSING|DEPENDENC|실행하지 못|설치되어 있지/i.test(hint)) return { key: 'engine', label: '병합 프로그램 시작' };
    if (/SHEET_NAME|시트 이름/i.test(hint)) return { key: 'naming', label: '결과 이름 정리' };
    if (/COMBINED_(?:SHEET|ROW_LIMIT)|SHEET_COPY|INSERT|MERGE_FAILED|복사하지 못|연결하지 못|합치지 못|처리 한도|최대 행/i.test(hint)) return { key: 'merge', label: '내용 합치기' };
    if (/SAVE|OUTPUT_NOT_CREATED|파일로 저장|결과를 만들/i.test(hint)) return { key: 'save', label: '결과 파일 만들기' };
    if (/COMBINED_OUTPUT|VERIFY|RESULT_INVALID|OUTPUT_INVALID|검증|다시 열어/i.test(hint)) return { key: 'verify', label: '결과 검증' };
    if (/PUBLISH|OUTPUT_DIRECTORY|OUTPUT_EXISTS|OUTPUT_EQUALS|최종 위치|저장 폴더/i.test(hint)) return { key: 'publish', label: '최종 저장' };
    const rawStage = String(details.phase || details.stage || state?.lastProgressPhase || '').toLowerCase();
    if (/inspect|preflight|read|snapshot/.test(rawStage)) return { key: 'inspect', label: '원본 파일 검사' };
    if (/start|engine|prepare/.test(rawStage)) return { key: 'engine', label: '병합 프로그램 시작' };
    if (/merge|copy|insert/.test(rawStage)) return { key: 'merge', label: '내용 합치기' };
    if (/save|write/.test(rawStage)) return { key: 'save', label: '결과 파일 만들기' };
    if (/verify|validate/.test(rawStage)) return { key: 'verify', label: '결과 검증' };
    if (/publish|commit/.test(rawStage)) return { key: 'publish', label: '최종 저장' };
    return { key: 'process', label: '병합 처리' };
  }

  function mergeFailureEngineLabel(error, state, meta) {
    const details = error?.details && typeof error.details === 'object' ? error.details : {};
    const raw = `${String(details.engine || '')} ${String(state?.lastProgressEngine || '')} ${String(state?.engine || '')} ${String(error?.message || '')}`.toLowerCase();
    if (/libreoffice|soffice/.test(raw)) return 'LibreOffice';
    if (/microsoft[- ]?excel|excel\.application|excel-com/.test(raw)) return 'Microsoft Excel';
    if (/microsoft[- ]?word|word\.application|word-com/.test(raw)) return 'Microsoft Word';
    if (/ooxml|internal|built-in|cmoe/.test(raw)) return 'CMOE 내장 병합';
    if (meta?.kind === 'excel') return 'Excel 병합 엔진';
    if (meta?.kind === 'word') return 'Word 병합 엔진';
    return `${String(meta?.label || '문서')} 병합 엔진`;
  }

  function mergeFailureTarget(error, state, stage) {
    const details = error?.details && typeof error.details === 'object' ? error.details : {};
    const combinedHint = `${String(error?.code || '')} ${String(error?.workerCode || '')} ${String(details.workerCode || details.reasonCode || '')} ${String(error?.message || '')}`;
    if (/COMBINED_HEADER|HEADER_(?:MISMATCH|MISSING)|첫 행.*헤더|헤더.*(?:다르|불일치|찾지 못)/i.test(combinedHint)) return '통합 대상 워크시트 전체';
    const detailIndex = [details.fileIndex, details.sourceIndex, details.index]
      .map(Number)
      .find((value) => Number.isInteger(value) && value >= 0 && value < Number(state?.files?.length || 0));
    const message = String(error?.message || '');
    const messageIndex = Array.isArray(state?.files)
      ? state.files.findIndex((file) => {
        const name = safeMergeDiagnosticFileName(file?.name);
        return name.length > 2 && message.includes(name);
      })
      : -1;
    const progressIndex = stage.key === 'inspect' && Number.isInteger(Number(state?.lastProgressIndex))
      ? Number(state.lastProgressIndex)
      : -1;
    const index = detailIndex ?? (messageIndex >= 0
      ? messageIndex
      : progressIndex >= 0 && progressIndex < Number(state?.files?.length || 0) ? progressIndex : -1);
    const detailName = safeMergeDiagnosticFileName(details.fileName || details.sourceName || '');
    const fileName = safeMergeDiagnosticFileName(index >= 0 ? state.files[index]?.name : detailName);
    if (index >= 0 && fileName) return `${index + 1}번째 “${fileName}”`;
    if (detailName) return `“${detailName}”`;
    return stage.key === 'inspect' ? '확인 중이던 원본 파일' : '목록 전체';
  }

  function mergeFailureAction(error, stage) {
    const details = error?.details && typeof error.details === 'object' ? error.details : {};
    const hint = `${String(error?.code || '')} ${String(error?.workerCode || '')} ${String(details.workerCode || details.reasonCode || '')} ${String(error?.message || '')}`;
    if (/COMBINED_HEADER_MISSING|HEADER_MISSING|헤더를 찾지 못/i.test(hint)) return '데이터가 있는 모든 워크시트의 1행에 열 이름을 넣거나 전체 통합 시트 옵션을 끄고 다시 시도해주세요.';
    if (/COMBINED_HEADER|HEADER_MISMATCH|첫 행.*헤더|헤더.*(?:다르|불일치)/i.test(hint)) return '전체 통합 시트 옵션을 끄거나 모든 워크시트의 열 이름과 순서를 같게 맞춘 뒤 다시 시도해주세요.';
    if (/COMBINED_(?:ROW_LIMIT|SHEET_SIZE)|최대 행|처리 한도/i.test(hint)) return '전체 통합 시트 옵션을 끄거나 원본 파일을 여러 묶음으로 나누어 합쳐주세요.';
    if (/IN_USE|사용 중|열려 있는/i.test(hint)) return '문서 프로그램을 닫고 다시 시도해주세요.';
    if (/START|CLASSNOTREG|WORKER_MISSING|설치되어 있지|실행하지 못/i.test(hint)) return '필요한 문서 프로그램을 준비하거나 복구한 뒤 다시 시도해주세요.';
    if (/INPUT_(?:NOT_FOUND|IDENTITY_CHANGED)|파일이.*바뀌|찾을 수 없/i.test(hint)) return '해당 파일을 목록에서 다시 선택해주세요.';
    if (/PASSWORD|ENCRYPTED|IRM|PROTECTED|SIGNED|MACRO/i.test(hint)) return '보호·암호·매크로를 제거한 복사본으로 다시 시도해주세요.';
    if (/OUTPUT_EXISTS|OUTPUT_DIRECTORY|OUTPUT_EQUALS|저장 폴더|이미 있/i.test(hint)) return '다른 결과 이름이나 저장 폴더를 선택해주세요.';
    if (/TIMEOUT|시간이 초과/i.test(hint)) return '파일 수를 줄여 나누어 합쳐주세요.';
    if (stage.key === 'inspect') return '표시된 원본을 문서 프로그램에서 다시 저장한 뒤 다시 선택해주세요.';
    if (stage.key === 'verify') return '완성되지 않은 결과는 저장하지 않았습니다. 원본 파일을 확인한 뒤 다시 시도해주세요.';
    return '원본은 변경되지 않았습니다. 표시된 단계와 대상을 확인한 뒤 다시 시도해주세요.';
  }

  function mergeFailurePresentation(error, state, meta) {
    const stage = mergeFailureStage(error, state);
    const engine = mergeFailureEngineLabel(error, state, meta);
    const target = mergeFailureTarget(error, state, stage);
    const reason = safeMergeFailureMessage(error);
    const action = mergeFailureAction(error, stage);
    return {
      title: `${String(meta?.label || '문서')} 합치기 실패 · ${stage.label}`,
      status: `사용: ${engine} · 단계: ${stage.label} · 대상: ${target} · 원인: ${reason} · 해결: ${action}`,
      reason,
      engine,
      stage: stage.key,
      target
    };
  }

  function finishDeclinedExcelInternalFallback(state) {
    // Declining ends only this click. Keep the safe inspection result so a later
    // explicit click can ask again, without an automatic retry loop.
    state.internalFallbackPrompted = false;
    state.internalFallback = false;
  }

  function finishExcelInternalFallbackAttempt(state) {
    // A confirmed internal run owns only one attempt. Whether it fails, is
    // cancelled, is blocked, or succeeds, a later explicit click may ask again.
    state.internalFallbackPrompted = false;
  }

  async function requestExcelInternalFallbackConfirmation(state, meta) {
    if (state.internalFallbackPrompted) return { confirmed: false, repeated: true };
    const context = captureInternalFallbackContext(state);
    state.internalFallbackPrompted = true;
    const confirmed = await confirmAction(
      '일반 Excel 방식으로 모든 원본을 안전하게 열거나 복사하지 못했습니다. CMOE 내부 Excel 병합으로 새 XLSX 파일을 만들어 계속할 수 있습니다.\n\n내부 방식은 화면에 보이는 셀 값·기본 셀 서식·병합 셀·행 높이·열 너비를 중심으로 복원합니다. 수식은 현재 계산된 값으로 고정됩니다. 차트·피벗·매크로·외부 연결·일부 조건부 서식·인쇄 설정은 제외되거나 달라질 수 있습니다. 전체 통합 시트를 선택했다면 서로 다른 헤더도 열 위치대로 이어져 항목이 어긋날 수 있습니다.\n\n원본 파일은 변경하지 않습니다. 완료 후 반드시 결과 파일을 확인해주세요.\n\n이 방식으로 강제 병합할까요?',
      { title: 'CMOE 내부 Excel 병합', action: '이해하고 내부 병합', danger: false }
    );
    if (!confirmed) {
      finishDeclinedExcelInternalFallback(state);
      return { confirmed: false, declined: true };
    }
    if (!internalFallbackContextMatches(context)) {
      state.internalFallbackPrompted = false;
      notify('확인하는 동안 파일 목록·저장 위치·결과 이름 또는 옵션이 바뀌어 내부 병합을 시작하지 않았습니다. 현재 상태를 다시 확인해주세요.');
      return { confirmed: false, changed: true };
    }
    return { confirmed: true };
  }

  function moveMergeFile(from, to, focusAction = '') {
    const state = activeMergeState(); const meta = activeMergeMeta(); if (!state || !meta || state.running || from === to || from < 0 || to < 0 || from >= state.files.length || to >= state.files.length) return;
    const [file] = state.files.splice(from, 1); state.files.splice(to, 0, file); setMergeResultPending(state); renderMergeFiles(state, meta);
    if (focusAction) $(`[data-document-merge-move="${focusAction}"][data-document-merge-index="${to}"]`)?.focus();
    notify(`“${file.name}”을 ${to + 1}번째로 이동했습니다.`);
  }

  async function runDocumentMerge(options = {}) {
    const state = activeMergeState(); const meta = activeMergeMeta();
    const requestedInternalFallback = options.confirmedInternalExcelFallback === true;
    const suggestedInternalFallback = meta?.kind === 'excel' && state?.internalFallbackSuggested === true;
    if (!state || !meta || state.running || ($('#runDocumentMerge').disabled && !suggestedInternalFallback)) return;
    if (suggestedInternalFallback && !requestedInternalFallback && !guideDemo.active) {
      const decision = await requestExcelInternalFallbackConfirmation(state, meta);
      if (!decision.confirmed) {
        renderMergeFiles(state, meta);
        return;
      }
      return runDocumentMerge({ confirmedInternalExcelFallback: true, standardConfirmationCompleted: true });
    }
    const fallbackConfirmationRequired = meta.kind === 'excel' && state.compatibilityFallback === true;
    const addCombinedSheet = meta.kind === 'excel' && state.addCombinedSheet === true;
    const useFileNameAsSheetName = meta.kind === 'excel' && state.useFileNameAsSheetName === true;
    const combinedSheetName = addCombinedSheet ? excelCombinedSheetName(state) : '';
    const confirmationRequired = !requestedInternalFallback && options.standardConfirmationCompleted !== true && (fallbackConfirmationRequired || addCombinedSheet);
    if (confirmationRequired && !guideDemo.active) {
      const fileSequence = state.files.map((file) => String(file.token || '')).join('\u0000');
      const outputToken = state.outputToken;
      const inspectionGeneration = state.inspectionGeneration;
      const confirmationParts = [];
      if (addCombinedSheet) confirmationParts.push(`원본 시트는 모두 그대로 유지하고, 맨 처음 데이터가 있는 워크시트의 1행만 헤더로 사용해 맨 앞에 “${combinedSheetName}” 시트를 추가합니다. 이후 데이터가 있는 워크시트는 첫 행을 제외하고 이어 붙입니다. 통합 시트에는 계산된 값과 셀 서식을 모으며 수식은 원본 시트에 그대로 유지됩니다. 헤더가 하나라도 다르면 결과 파일을 만들기 전에 중단합니다.`);
      if (fallbackConfirmationRequired) confirmationParts.push('이 PC에는 Microsoft Excel이 없어 LibreOffice 호환 방식으로 합칩니다. 시트 순서와 셀 값·수식·도형 수는 저장 후 다시 검사하지만, 일부 Excel 고급 서식·조건부 서식·피벗·통합문서 범위 이름은 달라질 수 있습니다. 원본은 바뀌지 않으며 완료 후 결과 파일을 직접 확인해야 합니다.');
      const confirmed = await confirmAction(
        `${confirmationParts.join('\n\n')}\n\n계속할까요?`,
        { title: addCombinedSheet ? '전체 통합 시트 확인' : '호환 방식으로 Excel 합치기', action: '확인하고 합치기', danger: false }
      );
      if (!confirmed) return;
      const currentState = activeMergeState();
      if (currentState !== state
        || state.inspectionGeneration !== inspectionGeneration
        || state.outputToken !== outputToken
        || (state.addCombinedSheet === true) !== addCombinedSheet
        || (state.useFileNameAsSheetName === true) !== useFileNameAsSheetName
        || (addCombinedSheet && excelCombinedSheetName(state) !== combinedSheetName)
        || state.files.map((file) => String(file.token || '')).join('\u0000') !== fileSequence
        || mergeRequiresPreparation(state, meta)) {
        notify('확인하는 동안 파일이나 준비 상태가 바뀌었습니다. 현재 목록을 다시 확인해주세요.');
        renderMergeFiles(state, meta);
        return;
      }
    }
    state.running = true; state.cancelling = false; state.completed = false; state.outcome = ''; state.outputFileToken = ''; state.progressValue = 0; state.progressVisible = true; state.requestId = crypto.randomUUID(); state.internalFallback = false;
    state.lastProgressEngine = ''; state.lastProgressPhase = ''; state.lastProgressIndex = -1;
    $('#documentMergeRunTitle')?.closest('.document-run-card')?.classList.remove('has-error');
    const resultName = `${cleanMergeResultName($('#documentMergeOutputName').value, meta)}${meta.extension}`;
    $('#documentMergeProgress').hidden = false; $('#documentMergeProgress').max = state.files.length; $('#documentMergeProgress').value = 0; $('#openDocumentMergeOutput').hidden = true; $('#previewDocumentMergeOutput').hidden = true;
    renderMergeFiles(state, meta);
    let retryWithInternalFallback = false;
    try {
      const result = await DOCUMENT_MERGE_BRIDGE.mergeFiles({
        requestId: state.requestId,
        kind: meta.kind,
        mode: documentMode,
        fileTokens: state.files.map((file) => file.token),
        outputToken: state.outputToken,
        outputName: resultName,
        addCombinedSheet,
        combinedSheetName,
        useFileNameAsSheetName,
        confirmedCompatibilityFallback: fallbackConfirmationRequired,
        confirmedInternalExcelFallback: requestedInternalFallback
      });
      if (result?.blocked) {
        applyMergePreparationResult(state, result);
        state.outcome = ''; state.progressVisible = false; state.progressValue = 0; $('#documentMergeProgress').hidden = true;
        state.runTitle = '합치기 전에 준비가 필요합니다.';
        state.runStatus = result.runningDependencies?.length
          ? '작업 중인 문서 프로그램을 닫은 뒤 다시 확인해주세요.'
          : '위의 준비 버튼을 누르면 목록과 저장 위치를 유지한 채 필요한 구성을 준비합니다.';
        $('#documentMergeRunTitle').textContent = state.runTitle;
        $('#documentMergeRunStatus').textContent = state.runStatus;
        notify('원본 문서를 그대로 처리하기 위한 준비 항목을 확인해주세요.');
        return;
      }
      applyMergePreparationResult(state, result || {});
      state.internalFallback = meta.kind === 'excel' && (result?.internalFallback === true || requestedInternalFallback);
      if (state.internalFallback) {
        state.engine = String(result?.engine || 'cmoe-internal-excel').slice(0, 80);
        state.requiresPreview = true;
        clearExcelInternalFallbackSuggestion(state);
      }
      $('#documentMergeProgress').value = state.files.length; state.progressValue = state.files.length; state.completed = true; state.outcome = 'success'; state.outputFileToken = result?.outputFileToken || '';
      state.resultPageCount = Number(result?.pageCount) || 0;
      state.resultSectionCount = Number(result?.sectionCount) || 0;
      state.headerFooterLinksDetached = Math.max(0, Number(result?.headerFooterLinksDetached) || 0);
      state.headerFooterLinkFailures = Math.max(0, Number(result?.headerFooterLinkFailures) || 0);
      state.resultSheetCount = Number(result?.sheetCount) || 0;
      state.resultSheetNames = Array.isArray(result?.sheetNames) ? result.sheetNames.map(String) : [];
      state.resultSheetTypes = Array.isArray(result?.sheetTypes) ? result.sheetTypes.map(String) : [];
      state.resultSheetVisibility = Array.isArray(result?.sheetVisibility) ? result.sheetVisibility.slice() : [];
      if (meta.kind === 'excel') {
        state.combinedSheetAdded = result?.combinedSheetAdded === true;
        state.combinedSheetName = state.combinedSheetAdded ? String(result?.combinedSheetName || state.resultSheetNames[0] || '').slice(0, 31) : '';
        state.combinedRowCount = state.combinedSheetAdded ? Math.max(0, Number(result?.combinedRowCount) || 0) : 0;
        state.combinedColumnCount = state.combinedSheetAdded ? Math.max(0, Number(result?.combinedColumnCount) || 0) : 0;
      }
      state.baseStrategy = String(result?.baseStrategy || '');
      state.sourcePageCounts = Array.isArray(result?.sourcePageCounts) ? result.sourcePageCounts.map(Number) : [];
      state.sourceSheetCounts = Array.isArray(result?.sourceSheetCounts) ? result.sourceSheetCounts.map(Number) : [];
      if (meta.kind === 'word' && state.sourcePageCounts.length === state.files.length) state.files.forEach((file, index) => { file.pageCount = Math.max(0, Number(state.sourcePageCounts[index]) || 0); });
      if (meta.kind === 'excel' && state.sourceSheetCounts.length === state.files.length) state.files.forEach((file, index) => { file.sheetCount = Math.max(0, Number(state.sourceSheetCounts[index]) || 0); });
      const savedName = result?.outputName || resultName;
      state.runTitle = state.requiresPreview ? `${meta.label} 합치기 완료 · 결과 확인 필요` : `${meta.label} 합치기 완료`;
      state.runStatus = meta.kind === 'word'
        ? `목록 순서대로 이어 붙인 “${savedName}”을 저장했습니다. ${state.resultPageCount ? `${state.resultPageCount}쪽 · ` : ''}${state.resultSectionCount ? `${state.resultSectionCount}개 구역 · ` : ''}${state.headerFooterLinkFailures ? `머리글·바닥글 경계 ${state.headerFooterLinkFailures}곳은 자동 확인이 불완전합니다. ` : ''}결과 미리보기에서 페이지 나눔·머리글·바닥글을 확인해주세요.`
        : meta.kind === 'excel'
        ? state.internalFallback
          ? `CMOE 내부 Excel 병합으로 화면에 보이는 셀 값과 기본 서식을 중심으로 “${savedName}”을 새로 만들어 저장했습니다.${state.resultSheetCount ? ` 전체 ${state.resultSheetCount}개 시트입니다.` : ''}${state.combinedSheetAdded ? ` 맨 앞에 “${state.combinedSheetName || '전체 통합'}” 시트를 추가했습니다.` : ''} 수식은 계산된 값으로 고정되며 차트·피벗·매크로·외부 연결·일부 조건부 서식·인쇄 설정은 제외되거나 달라질 수 있습니다. 원본은 변경하지 않았습니다. 결과 파일을 반드시 확인해주세요.${state.warnings.length ? ` ${state.warnings.join(' ')}` : ''}`
          : state.compatibilityFallback
          ? `LibreOffice 호환 방식으로 파일 순서와 각 파일의 시트 순서대로 “${savedName}”을 저장했습니다.${state.resultSheetCount ? ` 전체 ${state.resultSheetCount}개 시트입니다.` : ''}${state.combinedSheetAdded ? ` 원본 시트는 유지하고 맨 앞에 “${state.combinedSheetName || '전체 통합'}” 시트${state.combinedRowCount && state.combinedColumnCount ? `(헤더 포함 ${state.combinedRowCount}행 × ${state.combinedColumnCount}열)` : ''}를 추가했습니다.` : ''}${state.contentVerified ? ' 저장 후 시트 순서와 셀·수식·도형 수 검증을 통과했습니다.' : ''} 결과 미리보기에서 서식·조건부 서식·피벗·수식 표시를 확인해주세요.${state.warnings.length ? ` ${state.warnings.join(' ')}` : ''}`
          : `파일 순서와 각 파일의 시트 순서대로 “${savedName}”을 저장했습니다.${state.resultSheetCount ? ` 전체 ${state.resultSheetCount}개 시트입니다.` : ''}${state.combinedSheetAdded ? ` 원본 시트는 유지하고 맨 앞에 “${state.combinedSheetName || '전체 통합'}” 시트${state.combinedRowCount && state.combinedColumnCount ? `(헤더 포함 ${state.combinedRowCount}행 × ${state.combinedColumnCount}열)` : ''}를 추가했습니다. 통합 시트는 계산된 값과 셀 서식을 모았고 첫 헤더는 한 번만 남겼습니다.` : ''} 결과 미리보기에서 시트 순서·수식·차트·외부 연결을 확인해주세요.`
        : state.requiresPreview
        ? `“${savedName}”을 저장했습니다. 글꼴 사전 검사를 지원하지 않는 원본이 있어 결과 미리보기에서 글꼴·줄바꿈·페이지를 확인해주세요.`
        : `목록 순서대로 합친 “${savedName}”을 저장했습니다.`;
      $('#documentMergeRunTitle').textContent = state.runTitle;
      $('#documentMergeRunStatus').textContent = state.runStatus;
      $('#openDocumentMergeOutput').hidden = false;
      $('#previewDocumentMergeOutput').hidden = !state.outputFileToken;
      notify(state.requiresPreview ? `${meta.label} 파일 ${state.files.length}개를 합쳤습니다. 결과 미리보기를 확인해주세요.` : `${meta.label} 파일 ${state.files.length}개를 하나로 합쳤습니다.`, state.requiresPreview ? 'normal' : 'success');
      reportWorkflowStatus('documentEditor', state.requiresPreview ? 'needsReview' : 'complete', state.runTitle, { documentMode });
    } catch (error) {
      const cancelled = isDocumentToolCancellation(error);
      const canOfferInternalFallback = !cancelled && !requestedInternalFallback && !guideDemo.active && excelInternalFallbackEligible(error, state, meta);
      if (canOfferInternalFallback) {
        state.internalFallbackReason = safeMergeFailureMessage(error);
        const decision = await requestExcelInternalFallbackConfirmation(state, meta);
        retryWithInternalFallback = decision.confirmed === true;
      }
      if (!retryWithInternalFallback) {
        const failure = cancelled ? null : mergeFailurePresentation(error, state, meta);
        state.outcome = cancelled ? 'cancelled' : 'error'; state.runTitle = cancelled ? '파일 합치기를 중단했습니다.' : failure.title; state.runStatus = cancelled ? '완성되지 않은 임시 결과는 정리했으며 원본 파일은 그대로입니다.' : failure.status;
        $('#documentMergeRunTitle').textContent = state.runTitle;
        $('#documentMergeRunStatus').textContent = state.runStatus;
        $('#documentMergeRunTitle')?.closest('.document-run-card')?.classList.toggle('has-error', !cancelled);
        notify(cancelled ? '파일 합치기를 중단했습니다.' : `${failure.title}: ${failure.reason}`, cancelled ? 'normal' : 'error');
        if (!cancelled) reportWorkflowStatus('documentEditor', 'needsReview', `${meta.label} 합치기 오류 확인 필요`, { documentMode });
      }
    } finally {
      if (requestedInternalFallback) finishExcelInternalFallbackAttempt(state);
      state.running = false; state.cancelling = false; state.requestId = ''; renderMergeFiles(state, meta);
    }
    if (retryWithInternalFallback) return runDocumentMerge({ confirmedInternalExcelFallback: true, standardConfirmationCompleted: true });
  }

  async function cancelDocumentMerge() {
    const state = activeMergeState(); if (!state?.running || state.cancelling) return;
    state.cancelling = true; updateMergeReady();
    try {
      const result = await DOCUMENT_MERGE_BRIDGE.cancel(state.requestId);
      if (!result?.ok) { state.cancelling = false; updateMergeReady(); $('#documentMergeRunStatus').textContent = '작업이 이미 마무리 중입니다. 결과를 확인하고 있습니다.'; }
    } catch (error) {
      state.cancelling = false; updateMergeReady(); notify(`작업 중단 요청 실패: ${error.message}`, 'error');
    }
  }

  function selectedSlide() {
    return certificate.template?.slides?.find((slide) => slide.number === certificate.slideNumber) || null;
  }

  function saveCertificateSlideDraft() {
    if (!certificate.template || !certificate.slideNumber) return;
    certificate.slideDrafts[String(certificate.slideNumber)] = {
      fields: certificate.fields.map((field) => ({ ...field })),
      rows: certificate.rows.map((row) => ({ values: row.values.slice() })),
      currentRow: certificate.currentRow,
      filenameTemplate: certificate.filenameTemplate,
      rosterImport: certificate.rosterImport ? { ...certificate.rosterImport } : null,
      selection: { ...certificate.selection },
      history: certificate.history.slice(),
      redo: certificate.redo.slice()
    };
  }

  function restoreCertificateSlideDraft(slideNumber) {
    const draft = certificate.slideDrafts[String(slideNumber)];
    if (!draft) {
      certificate.fields = [];
      certificate.filenameTemplate = '{A}';
      certificate.rosterImport = null;
      emptyCertificateRows(3);
      return;
    }
    certificate.fields = (draft.fields || []).map((field) => ({ ...field }));
    certificate.rows = (draft.rows || []).map((row) => ({ values: (row.values || []).slice() }));
    if (!certificate.rows.length) certificate.rows = Array.from({ length: 3 }, () => ({ values: Array(certificate.fields.length).fill('') }));
    certificate.currentRow = Math.max(0, Math.min(certificate.rows.length - 1, Number(draft.currentRow) || 0));
    certificate.filenameTemplate = String(draft.filenameTemplate ?? '{A}').slice(0, 160);
    certificate.rosterImport = draft.rosterImport ? { ...draft.rosterImport } : null;
    certificate.selection = { ...(draft.selection || { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 }) };
    certificate.history = (draft.history || []).slice(); certificate.redo = (draft.redo || []).slice();
    certificate.editBaseline = null; certificate.preserveSelectionOnFocus = false;
  }

  async function switchCertificateSlide(slideNumber, options = {}) {
    const next = Number(slideNumber);
    if (certificate.running || !certificate.template?.slides?.some((slide) => slide.number === next)) return;
    if (next !== certificate.slideNumber) {
      saveCertificateSlideDraft();
      certificate.slideNumber = next;
      restoreCertificateSlideDraft(next);
      certificate.rowPreviewSequence += 1; certificate.previewing = false; certificate.showHiddenBlocks = false;
    }
    const select = $('#certificateSlideSelect'); if (select) select.value = String(next);
    certificate.templatePreviewUrl = certificate.previewCache[String(next)]?.imageUrl || '';
    renderCertificateFields(); renderCertificateGrid(); updateCertificateReady(); renderCertificateSlideRail(); updateCertificateSlideNavigation();
    if (options.focusViewport) $('#certificatePreviewViewport')?.focus({ preventScroll: true });
    await renderTemplatePreview();
  }

  function hasCertificateData() {
    return certificate.rows.some((row) => row.values.some((value) => String(value || '').trim()));
  }

  function certificateSelectionIsRange() {
    const bounds = selectionBounds();
    return bounds.top !== bounds.bottom || bounds.left !== bounds.right;
  }

  function certificatePointInsideSelection(row, col) {
    const bounds = selectionBounds();
    return row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right;
  }

  function invalidateActualCertificatePreview() {
    if ($('#certificatePreviewStage')?.classList.contains('actual-preview')) restoreTemplatePreview();
  }

  function updateCertificateFlow() {
    const steps = $$('.certificate-flow-strip span'); if (!steps.length) return;
    const active = !certificate.template ? 0 : !certificate.fields.length ? 1 : !certificateRowsForOutput().length ? 2 : 3;
    steps.forEach((step, index) => {
      step.classList.toggle('active', index === active);
      step.classList.toggle('complete', index < active);
      if (index === active) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    });
  }

  function emptyCertificateRows(count = 3) {
    certificate.rows = Array.from({ length: count }, () => ({ values: Array(certificate.fields.length).fill('') }));
    certificate.currentRow = 0;
    resetCertificateSelection();
    certificate.history = []; certificate.redo = [];
  }

  function normalizeFieldLabel(block, index) {
    const shapeName = String(block.name || '').trim();
    const text = String(block.text || '').replace(/\s+/g, ' ').trim();
    if (shapeName && !/^(?:TextBox|Rectangle|Placeholder|텍스트 상자|직사각형|개체)\s*\d*$/i.test(shapeName)) return shapeName.slice(0, 40);
    if (text && text.length <= 24) return text;
    return `항목 ${index + 1}`;
  }

  function templatePayload(extra = {}) {
    return {
      templateToken: certificate.template?.token || '',
      profileId: certificate.template?.profileId || '',
      slideNumber: certificate.slideNumber,
      fields: certificate.fields.map((field) => ({
        blockId: field.blockId,
        label: field.label,
        ...(Number.isInteger(field.rangeStart) && Number.isInteger(field.rangeEnd) ? {
          rangeStart: field.rangeStart,
          rangeEnd: field.rangeEnd,
          selectedText: field.selectedText
        } : {})
      })),
      ...extra
    };
  }

  function fallbackBlockLabel(block) {
    const text = String(block?.text || '').replace(/\s+/g, ' ').trim();
    return (text || String(block?.name || '').trim() || '빈 텍스트 상자').slice(0, 36);
  }

  function certificateSlideRatio() {
    const cached = certificate.previewCache[String(certificate.slideNumber)] || {};
    const width = Number(cached.imageWidth || cached.slideWidth || certificate.template?.slideSize?.width || 16);
    const height = Number(cached.imageHeight || cached.slideHeight || certificate.template?.slideSize?.height || 9);
    return width > 0 && height > 0 ? width / height : 16 / 9;
  }

  function syncCertificateOverlayBounds() {
    const viewport = $('#certificatePreviewViewport');
    const stage = $('#certificatePreviewStage');
    const overlay = $('#certificateBlockOverlay');
    if (!viewport || !stage || !overlay) return;
    const style = getComputedStyle(viewport);
    const availableWidth = Math.max(1, viewport.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0));
    const availableHeight = Math.max(1, viewport.clientHeight - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0));
    const ratio = certificateSlideRatio();
    let width = availableWidth;
    let height = width / ratio;
    if (height > availableHeight) { height = availableHeight; width = height * ratio; }
    stage.style.width = `${Math.max(1, width)}px`;
    stage.style.height = `${Math.max(1, height)}px`;
    stage.style.aspectRatio = `${ratio}`;
    overlay.style.inset = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.dataset.boundsReady = 'true';
  }

  function scheduleCertificateOverlayBounds() {
    if (certificateOverlayResizeFrame) cancelAnimationFrame(certificateOverlayResizeFrame);
    certificateOverlayResizeFrame = requestAnimationFrame(() => {
      certificateOverlayResizeFrame = 0;
      syncCertificateOverlayBounds();
    });
  }

  function rememberCertificatePreview(slideNumber, result) {
    const key = String(slideNumber);
    certificate.previewCache[key] = {
      imageUrl: result.imageUrl,
      imageWidth: Number(result.imageWidth) || 0,
      imageHeight: Number(result.imageHeight) || 0,
      slideWidth: Number(result.slideWidth) || Number(certificate.template?.slideSize?.width) || 0,
      slideHeight: Number(result.slideHeight) || Number(certificate.template?.slideSize?.height) || 0,
      engine: String(result.engine || ''),
      renderer: String(result.renderer || ''),
      fidelity: String(result.fidelity || (result.engine === 'powerpoint' ? 'native' : 'compatible')),
      cacheHit: Boolean(result.cacheHit)
    };
    certificate.previewCacheOrder = certificate.previewCacheOrder.filter((item) => item !== key);
    certificate.previewCacheOrder.push(key);
    while (certificate.previewCacheOrder.length > 12) {
      const oldest = certificate.previewCacheOrder.shift();
      if (oldest !== key) delete certificate.previewCache[oldest];
    }
    return certificate.previewCache[key];
  }

  function renderCertificateSlideRail() {
    const rail = $('#certificateSlideRail'); if (!rail) return;
    const slides = certificate.template?.slides || [];
    rail.hidden = slides.length <= 1;
    rail.replaceChildren();
    slides.forEach((slide) => {
      const button = element('button', 'certificate-slide-thumb'); button.type = 'button'; button.dataset.certificateSlide = String(slide.number);
      button.classList.toggle('active', slide.number === certificate.slideNumber);
      button.setAttribute('aria-current', slide.number === certificate.slideNumber ? 'page' : 'false');
      button.setAttribute('aria-label', `${slide.number}페이지 · 선택 가능한 글자 ${slide.visibleBlockCount ?? slide.blockCount ?? slide.blocks?.length ?? 0}개`);
      button.disabled = certificate.running;
      const preview = element('span', 'certificate-slide-thumb-preview');
      const cached = certificate.previewCache[String(slide.number)];
      if (cached?.imageUrl) { const image = element('img'); image.src = cached.imageUrl; image.alt = ''; preview.append(image); }
      else preview.append(element('span', '', String(slide.number)));
      button.append(preview, element('small', '', `${slide.number}페이지`)); rail.append(button);
    });
    requestAnimationFrame(() => rail.querySelector('.certificate-slide-thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  function updateCertificateSlideNavigation() {
    const slides = certificate.template?.slides || [];
    const index = slides.findIndex((slide) => slide.number === certificate.slideNumber);
    const position = $('#certificateSlidePosition'); if (position) position.textContent = `${Math.max(0, index) + 1} / ${Math.max(1, slides.length)}`;
    const previous = $('#previousCertificateSlide'); const next = $('#nextCertificateSlide');
    if (previous) previous.disabled = certificate.running || index <= 0;
    if (next) next.disabled = certificate.running || index < 0 || index >= slides.length - 1;
    const slide = selectedSlide();
    const hiddenCount = (slide?.blocks || []).filter((block) => block.occluded).length;
    const hiddenToggle = $('#toggleCertificateHiddenBlocks');
    if (hiddenToggle) {
      hiddenToggle.hidden = hiddenCount === 0;
      hiddenToggle.textContent = certificate.showHiddenBlocks ? `가려진 글자 ${hiddenCount}개 숨기기` : `가려진 글자 ${hiddenCount}개 보기`;
      hiddenToggle.setAttribute('aria-pressed', String(certificate.showHiddenBlocks));
      hiddenToggle.disabled = certificate.running;
    }
  }

  function renderCertificateFontNotice(entry = certificate.previewCache[String(certificate.slideNumber)] || {}) {
    const notice = $('#certificateFontNotice'); if (!notice) return;
    const report = certificate.template?.fontReport || {};
    const missing = Array.isArray(report.missingFonts) ? report.missingFonts : [];
    if (missing.length) {
      notice.hidden = false; notice.className = 'certificate-font-notice';
      notice.textContent = `이 PC에 없는 글꼴 ${missing.length}개: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` 외 ${missing.length - 4}개` : ''}. 위의 “필요한 구성 자동 준비”에서 배포 가능한 글꼴은 바로 설치하고, 라이선스가 필요한 글꼴은 공식 공급처로 연결합니다.`;
      return;
    }
    if (entry.fidelity === 'compatible' || entry.engine === 'libreoffice') {
      notice.hidden = false; notice.className = 'certificate-font-notice';
      notice.textContent = 'LibreOffice 호환 미리보기입니다. 원본 글꼴이 설치되어 있으면 디자인과 글자 배치를 최대한 유지하지만, 일부 효과는 PowerPoint와 다를 수 있어 첫 결과를 한 번 확인해주세요.';
      return;
    }
    if ((report.usedFonts || []).length) {
      notice.hidden = false; notice.className = 'certificate-font-notice ready';
      notice.textContent = `원본 글꼴 ${report.usedFonts.length}개를 확인했습니다. PowerPoint의 실제 슬라이드 렌더를 사용합니다.`;
      return;
    }
    notice.hidden = true; notice.textContent = '';
  }

  function applyCertificateTemplatePreview(entry) {
    const stage = $('#certificatePreviewStage');
    certificate.templatePreviewUrl = entry.imageUrl || '';
    stage.classList.remove('actual-preview', 'fallback-preview');
    const image = $('#certificatePreviewImage'); image.src = entry.imageUrl; image.hidden = false;
    $('#certificatePreviewPlaceholder').hidden = true; $('#showCertificateTemplatePreview').hidden = true;
    renderCertificateSlideRail(); updateCertificateSlideNavigation(); renderCertificateFontNotice(entry); renderCertificateOverlay(); scheduleCertificateOverlayBounds();
  }

  function renderTemplateFallback(detail = '') {
    const stage = $('#certificatePreviewStage');
    stage.classList.remove('actual-preview'); stage.classList.add('fallback-preview');
    $('#certificatePreviewImage').hidden = true;
    const slide = selectedSlide(); const blockCount = (slide?.blocks || []).filter((block) => certificate.showHiddenBlocks || !block.occluded).length;
    const placeholder = $('#certificatePreviewPlaceholder'); placeholder.hidden = false;
    placeholder.replaceChildren(
      element('strong', '', blockCount ? '텍스트 위치로 항목을 선택할 수 있습니다.' : '선택할 수 있는 일반 텍스트 상자가 없습니다.'),
      element('span', '', blockCount
        ? '변환 프로그램이 없어 디자인 대신 텍스트 위치와 내용을 표시합니다. PPTX 출력은 계속 사용할 수 있습니다.'
        : '차트·SmartArt·이미지 자체의 글자는 자동 교체 대상이 아닙니다.')
    );
    if (detail) placeholder.title = detail; else placeholder.removeAttribute('title');
    $('#showCertificateTemplatePreview').hidden = true;
    renderCertificateSlideRail(); updateCertificateSlideNavigation(); renderCertificateFontNotice(); renderCertificateOverlay(); scheduleCertificateOverlayBounds();
    $('#certificatePreviewMode').textContent = blockCount
      ? '간이 선택 화면 · 표시된 텍스트 상자를 순서대로 클릭하세요.'
      : '교체 가능한 텍스트가 있는 PPTX 양식을 선택해주세요.';
  }

  async function renderTemplatePreview() {
    if (!certificate.template) return;
    const sequence = ++certificate.templatePreviewSequence;
    const expectedToken = certificate.template.token; const expectedSlide = certificate.slideNumber;
    const stage = $('#certificatePreviewStage'); stage.classList.remove('actual-preview', 'fallback-preview');
    const cached = certificate.previewCache[String(expectedSlide)];
    if (cached?.imageUrl) {
      applyCertificateTemplatePreview(cached);
      $('#certificatePreviewMode').textContent = '실제 슬라이드 위의 바꿀 글자만 선택합니다. 페이지를 바꿔도 입력 내용은 보관됩니다.';
      return;
    }
    $('#certificatePreviewImage').hidden = true; $('#certificateBlockOverlay').replaceChildren();
    $('#certificatePreviewPlaceholder').hidden = false; $('#certificatePreviewPlaceholder').replaceChildren(element('strong', '', '양식 미리보기를 만드는 중입니다.'), element('span', '', '원본 파일은 수정하지 않습니다.'));
    $('#showCertificateTemplatePreview').hidden = true;
    renderCertificateSlideRail(); updateCertificateSlideNavigation(); scheduleCertificateOverlayBounds();
    if (certificate.capabilities && !certificate.capabilities.engine) {
      renderTemplateFallback(engineCopy(certificate.capabilities).detail);
      return;
    }
    try {
      const result = await api().previewCertificate(templatePayload({ fields: [], values: [] }));
      if (sequence !== certificate.templatePreviewSequence || certificate.template?.token !== expectedToken || certificate.slideNumber !== expectedSlide) return;
      const entry = rememberCertificatePreview(expectedSlide, result);
      applyCertificateTemplatePreview(entry);
      $('#certificatePreviewMode').textContent = entry.engine === 'powerpoint'
        ? 'PowerPoint 실제 슬라이드 · 바꿀 글자를 순서대로 선택하세요.'
        : '호환 미리보기 · 바꿀 글자를 순서대로 선택하세요. 원본 글꼴이 없으면 글자 모양이 달라질 수 있습니다.';
    } catch (error) {
      if (sequence !== certificate.templatePreviewSequence || certificate.template?.token !== expectedToken || certificate.slideNumber !== expectedSlide) return;
      renderTemplateFallback(error.message);
      notify(`디자인 미리보기 대신 텍스트 위치를 표시합니다: ${error.message}`, 'normal');
      await refreshCapabilities(true);
    }
  }

  function renderCertificateOverlay() {
    const overlay = $('#certificateBlockOverlay'); overlay.replaceChildren();
    const slide = selectedSlide(); const size = certificate.template?.slideSize;
    if (!slide || !size?.width || !size?.height || $('#certificatePreviewStage').classList.contains('actual-preview')) return;
    slide.blocks.filter((block) => certificate.showHiddenBlocks || !block.occluded).forEach((block) => {
      const button = element('button', 'certificate-block'); button.type = 'button'; button.dataset.certificateBlock = block.id;
      if (block.occluded) button.classList.add('occluded');
      const selectedFields = certificate.fields.map((field, index) => ({ field, index })).filter((item) => item.field.blockId === block.id);
      const selectedIndex = selectedFields[0]?.index ?? -1;
      if (selectedIndex >= 0) {
        button.classList.add('selected');
        const order = selectedFields.length > 1 ? `${selectedIndex + 1}+${selectedFields.length - 1}` : String(selectedIndex + 1);
        button.append(element('span', 'certificate-block-order', order));
      }
      const left = Number(block.x) / size.width * 100;
      const top = Number(block.y) / size.height * 100;
      const width = Number(block.width) / size.width * 100;
      const height = Number(block.height) / size.height * 100;
      if (![left, top, width, height].every(Number.isFinite) || width < 0 || height < 0) return;
      button.style.left = `${left}%`; button.style.top = `${top}%`; button.style.width = `${width}%`; button.style.height = `${height}%`;
      const layerOrder = { master: 0, layout: 100000, slide: 200000 }[block.sourceLayer] ?? 200000;
      const zOrder = Math.max(0, Math.min(99999, Math.trunc(Number(block.zOrder) || 0)));
      button.style.zIndex = String(layerOrder + zOrder);
      button.title = `${([block.name, block.text].filter(Boolean).join(' · ') || '빈 텍스트 상자').slice(0, 220)} · 눌러서 바꿀 글자를 드래그 선택`;
      button.setAttribute('aria-label', `${selectedIndex >= 0 ? `${selectedFields.length}개 글자 범위 연결됨` : '글자 선택'}: ${button.title}`);
      button.setAttribute('aria-pressed', String(selectedIndex >= 0));
      button.disabled = certificate.running;
      button.append(element('span', 'certificate-block-label', fallbackBlockLabel(block)));
      overlay.append(button);
    });
    updateCertificateSlideNavigation(); syncCertificateOverlayBounds();
  }

  function certificateFieldKey(field) {
    return Number.isInteger(field?.rangeStart) && Number.isInteger(field?.rangeEnd)
      ? `${field.blockId}:${field.rangeStart}:${field.rangeEnd}`
      : `${field?.blockId || ''}:*`;
  }

  function updateRowsForFieldChange(previousFields) {
    const oldIndexByBlock = new Map(previousFields.map((field, index) => [certificateFieldKey(field), index]));
    certificate.rows = (certificate.rows.length ? certificate.rows : [{ values: [] }]).map((row) => ({
      values: certificate.fields.map((field) => {
        const oldIndex = oldIndexByBlock.get(certificateFieldKey(field));
        return oldIndex == null ? '' : String(row.values[oldIndex] ?? '');
      })
    }));
    resetCertificateSelection(); certificate.editBaseline = null; certificate.history = []; certificate.redo = [];
  }

  function toggleCertificateBlock(blockId) {
    if (certificate.running) return;
    const slide = selectedSlide(); const block = slide?.blocks.find((item) => item.id === blockId); if (!block) return;
    const previous = certificate.fields.map((field) => ({ ...field }));
    const index = certificate.fields.findIndex((field) => field.blockId === blockId && !Number.isInteger(field.rangeStart));
    if (index >= 0) certificate.fields.splice(index, 1);
    else {
      if (certificate.fields.length >= 80) { notify('한 양식에서는 바꿀 글자를 최대 80개까지 선택할 수 있습니다.', 'error'); return; }
      certificate.fields.push({ blockId, label: normalizeFieldLabel(block, certificate.fields.length), sourceText: block.text, sourceName: block.name });
    }
    updateRowsForFieldChange(previous);
    if (!certificate.fields.length) certificate.rosterImport = null;
    restoreTemplatePreview();
    renderCertificateFields(); renderCertificateOverlay(); renderCertificateGrid(); updateCertificateReady();
  }

  function updateCertificateTextRangeSelection() {
    const input = $('#certificateTextRangeSource'); const status = $('#certificateTextRangeStatus'); const apply = $('#applyCertificateTextRange');
    if (!input || !status || !apply) return;
    const start = Math.min(input.selectionStart || 0, input.selectionEnd || 0);
    const end = Math.max(input.selectionStart || 0, input.selectionEnd || 0);
    const selected = input.value.slice(start, end);
    certificate.textRangeSelection.start = start; certificate.textRangeSelection.end = end;
    const valid = end > start && selected.trim() && !selected.includes('\n');
    status.textContent = !selected
      ? '바꿀 글자를 마우스로 드래그하세요.'
      : selected.includes('\n')
        ? '여러 줄을 한 번에 연결할 수 없습니다. 줄마다 따로 선택해주세요.'
        : `선택: “${selected.replace(/\s+/g, ' ').slice(0, 80)}” · ${selected.length}글자`;
    status.classList.toggle('error', Boolean(selected && !valid));
    apply.disabled = !valid || certificate.running;
  }

  function openCertificateTextRange(blockId) {
    if (certificate.running) return;
    const block = selectedSlide()?.blocks.find((item) => item.id === blockId); if (!block) return;
    const dialog = $('#certificateTextRangeDialog'); const input = $('#certificateTextRangeSource');
    certificate.textRangeSelection = { blockId, start: 0, end: 0 };
    $('#certificateTextRangeTitle').textContent = block.name || '텍스트 상자의 바꿀 글자 선택';
    $('#certificateTextRangeDescription').textContent = '원문에서 실제로 바뀔 글자만 드래그하세요. 앞뒤 문구와 글꼴·색상·크기는 그대로 유지됩니다.';
    input.value = String(block.text || ''); input.readOnly = true;
    $('#applyCertificateWholeBlock').disabled = certificate.running || !input.value;
    updateCertificateTextRangeSelection();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    requestAnimationFrame(() => { input.focus({ preventScroll: true }); input.setSelectionRange(0, 0); });
  }

  function addCertificateTextRange({ whole = false } = {}) {
    const blockId = certificate.textRangeSelection.blockId;
    const block = selectedSlide()?.blocks.find((item) => item.id === blockId); if (!block || certificate.running) return;
    const start = whole ? null : certificate.textRangeSelection.start;
    const end = whole ? null : certificate.textRangeSelection.end;
    const selectedText = whole ? String(block.text || '') : String(block.text || '').slice(start, end);
    if (!selectedText || (!whole && (!selectedText.trim() || selectedText.includes('\n')))) { updateCertificateTextRangeSelection(); return; }
    const conflicts = certificate.fields.filter((field) => field.blockId === blockId);
    const overlaps = whole
      ? conflicts.length > 0
      : conflicts.some((field) => !Number.isInteger(field.rangeStart) || (start < field.rangeEnd && end > field.rangeStart));
    if (overlaps) { notify('이미 연결한 글자와 범위가 겹칩니다. 겹치지 않는 글자를 선택해주세요.', 'error'); return; }
    if (certificate.fields.length >= 80) { notify('한 양식에서는 바꿀 글자를 최대 80개까지 선택할 수 있습니다.', 'error'); return; }
    const previous = certificate.fields.map((field) => ({ ...field }));
    const labelSource = selectedText.replace(/\s+/g, ' ').trim();
    certificate.fields.push({
      blockId,
      label: labelSource && labelSource.length <= 24 ? labelSource : normalizeFieldLabel(block, certificate.fields.length),
      sourceText: selectedText,
      sourceName: block.name,
      ...(whole ? {} : { rangeStart: start, rangeEnd: end, selectedText })
    });
    updateRowsForFieldChange(previous); restoreTemplatePreview(); renderCertificateFields(); renderCertificateOverlay(); renderCertificateGrid(); updateCertificateReady();
    $('#certificateTextRangeDialog').close?.();
  }

  function removeCertificateField(index) {
    if (certificate.running || !certificate.fields[index]) return;
    const previous = certificate.fields.map((field) => ({ ...field }));
    certificate.fields.splice(index, 1);
    updateRowsForFieldChange(previous);
    if (!certificate.fields.length) certificate.rosterImport = null;
    restoreTemplatePreview(); renderCertificateFields(); renderCertificateOverlay(); renderCertificateGrid(); updateCertificateReady();
  }

  function renderCertificateFields() {
    const container = $('#certificateFieldList'); container.replaceChildren();
    if (!certificate.fields.length) container.append(element('div', 'list-empty', '미리보기에서 텍스트 상자를 누른 뒤 바꿀 글자만 드래그하세요.'));
    certificate.fields.forEach((field, index) => {
      const row = element('div', 'certificate-field-row');
      row.append(element('span', 'certificate-field-order', String(index + 1)));
      const input = element('input'); input.type = 'text'; input.maxLength = 80; input.value = field.label; input.dataset.certificateFieldLabel = String(index); input.setAttribute('aria-label', `${index + 1}번 열 이름`); input.disabled = certificate.running;
      const remove = element('button', '', '×'); remove.type = 'button'; remove.dataset.certificateFieldRemove = String(index); remove.setAttribute('aria-label', `${field.label} 선택 해제`); remove.disabled = certificate.running;
      const rangeLabel = Number.isInteger(field.rangeStart) ? `선택 글자 “${String(field.selectedText || field.sourceText || '').replace(/\s+/g, ' ').slice(0, 80)}”` : '텍스트 상자 전체';
      const source = element('span', 'certificate-field-source', [field.sourceName, rangeLabel].filter(Boolean).join(' · ') || '빈 텍스트 상자');
      row.append(input, remove, source); container.append(row);
    });
    $('#clearCertificateFields').disabled = certificate.running || !certificate.fields.length;
    const filenameReady = certificate.fields.length ? evaluateCertificateFilenameTemplate(certificate.filenameTemplate, certificate.rows[certificate.currentRow] || { values: [] }, 1) : { ok: false };
    $('#saveCertificateProfile').disabled = guideDemo.active || certificate.running || !certificate.template || !certificate.fields.length || !filenameReady.ok;
    $('#certificateDataPanel').hidden = !certificate.fields.length;
    $('#certificateOutputPanel').hidden = !certificate.fields.length;
    renderFilenameFields();
  }

  function renderCertificateFilenamePreview() {
    const input = $('#certificateFilenameTemplate'); const feedback = $('#certificateFilenameFeedback'); const preview = $('#certificateFilenamePreview');
    if (!input || !feedback || !preview) return { ok: false, error: '파일 이름 입력 화면을 찾지 못했습니다.' };
    const row = certificate.rows[certificate.currentRow] || { values: [] };
    const rowNumber = Math.max(1, certificate.rows.slice(0, certificate.currentRow + 1).filter((item) => item.values.some((value) => String(value || '').trim())).length);
    const result = certificate.fields.length
      ? evaluateCertificateFilenameTemplate(certificate.filenameTemplate, row, rowNumber)
      : { ok: false, error: '바꿀 글자를 선택하면 사용할 수 있는 열이 표시됩니다.', stem: '' };
    input.setAttribute('aria-invalid', String(!result.ok));
    feedback.classList.toggle('error', !result.ok);
    if (!result.ok) preview.textContent = result.error;
    else {
      const extensions = [$('#certificateOutputPdf')?.checked ? 'pdf' : '', $('#certificateOutputPptx')?.checked ? 'pptx' : ''].filter(Boolean);
      preview.textContent = extensions.length ? extensions.map((extension) => `${result.stem}.${extension}`).join(' · ') : result.stem;
    }
    return result;
  }

  function insertCertificateFilenameToken(token) {
    const input = $('#certificateFilenameTemplate'); if (!input || input.disabled) return;
    const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
    input.setRangeText(token, start, end, 'end');
    certificate.filenameTemplate = input.value.slice(0, 160);
    input.focus({ preventScroll: true }); renderCertificateFilenamePreview(); updateCertificateReady();
  }

  function renderFilenameFields() {
    const input = $('#certificateFilenameTemplate'); const variables = $('#certificateFilenameVariables');
    if (!input || !variables) return;
    if (document.activeElement !== input) input.value = certificate.filenameTemplate ?? '{A}';
    input.disabled = certificate.running;
    variables.replaceChildren();
    const labels = certificateFilenameLabels();
    certificate.fields.forEach((field, index) => {
      const label = String(field.label || '').trim() || `항목 ${index + 1}`; const letter = columnName(index);
      const group = element('div', 'certificate-filename-variable'); group.append(element('span', '', `${letter} · ${label}`));
      const letterButton = element('button', 'certificate-filename-token', `{${letter}}`); letterButton.type = 'button'; letterButton.dataset.certificateFilenameToken = `{${letter}}`; letterButton.dataset.filenameUnavailable = 'false'; letterButton.disabled = certificate.running; letterButton.title = `${letter}열 값을 파일 이름에 넣기`;
      const ambiguousName = labels.get(label) > 1 || /^[A-Z]+$/i.test(label) || /[{}\r\n]/.test(label);
      const nameButton = element('button', 'certificate-filename-token', `{${label}}`); nameButton.type = 'button'; nameButton.dataset.certificateFilenameToken = `{${label}}`; nameButton.dataset.filenameUnavailable = String(ambiguousName); nameButton.disabled = certificate.running || ambiguousName;
      nameButton.title = ambiguousName ? '이 열 이름은 중복되거나 열 문자와 겹칩니다. A, B 열 문자를 사용해주세요.' : `“${label}” 열 값을 파일 이름에 넣기`;
      group.append(letterButton, nameButton); variables.append(group);
    });
    renderCertificateFilenamePreview();
  }

  function resetCertificateSelection(row = 0, col = 0) {
    const maxRow = Math.max(0, certificate.rows.length - 1); const maxCol = Math.max(0, certificate.fields.length - 1);
    const nextRow = Math.max(0, Math.min(maxRow, Number(row) || 0)); const nextCol = Math.max(0, Math.min(maxCol, Number(col) || 0));
    certificate.selection = { anchorRow: nextRow, anchorCol: nextCol, focusRow: nextRow, focusCol: nextCol };
  }

  function selectionBounds() {
    const selection = certificate.selection;
    return {
      top: Math.min(selection.anchorRow, selection.focusRow),
      bottom: Math.max(selection.anchorRow, selection.focusRow),
      left: Math.min(selection.anchorCol, selection.focusCol),
      right: Math.max(selection.anchorCol, selection.focusCol)
    };
  }

  function updateCertificateSelection() {
    const bounds = selectionBounds();
    $$('#certificateDataTable td[data-certificate-row]').forEach((cell) => {
      const row = Number(cell.dataset.certificateRow); const col = Number(cell.dataset.certificateCol);
      cell.classList.toggle('sheet-selected', row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right);
      cell.classList.toggle('sheet-active', row === certificate.selection.focusRow && col === certificate.selection.focusCol);
    });
    const address = bounds.top === bounds.bottom && bounds.left === bounds.right
      ? `${columnName(bounds.left)}${bounds.top + 2}`
      : `${columnName(bounds.left)}${bounds.top + 2}:${columnName(bounds.right)}${bounds.bottom + 2}`;
    $('#certificateSelectionAddress').textContent = address;
    const activeValue = certificate.rows[certificate.selection.focusRow]?.values?.[certificate.selection.focusCol] ?? '';
    if (document.activeElement !== $('#certificateCellValue')) $('#certificateCellValue').value = activeValue;
    const previousRow = certificate.currentRow;
    certificate.currentRow = certificate.selection.focusRow;
    if (previousRow !== certificate.currentRow) invalidateActualCertificatePreview();
    updateCertificateRowNavigation(); renderCertificateFilenamePreview();
  }

  function restoreCertificateGridFocus() {
    const { focusRow, focusCol } = certificate.selection;
    const input = $(`#certificateDataTable input[data-certificate-row="${focusRow}"][data-certificate-col="${focusCol}"]`);
    if (!input) return;
    certificate.preserveSelectionOnFocus = true;
    input.focus({ preventScroll: true });
    certificate.preserveSelectionOnFocus = false;
  }

  function renderCertificateRosterImportStatus() {
    const status = $('#certificateRosterImportStatus'); if (!status) return;
    if (!certificate.rosterImport) { status.hidden = true; status.replaceChildren(); return; }
    status.hidden = false;
    const kind = certificate.rosterImport.kind === 'project' ? '프로젝트' : certificate.rosterImport.kind === 'saved' ? '저장 명단' : '가져온 자료';
    status.replaceChildren(
      element('strong', '', `${kind} · ${certificate.rosterImport.name}`),
      element('span', '', `${certificate.rosterImport.count}명 복사됨 · 원본 명단이 바뀌어도 이 표는 자동으로 덮어쓰지 않습니다.`)
    );
  }

  function renderCertificateGrid({ restoreFocus = false } = {}) {
    const table = $('#certificateDataTable'); const head = $('thead', table); const body = $('tbody', table); head.replaceChildren(); body.replaceChildren();
    renderCertificateRosterImportStatus();
    if (!certificate.fields.length) return;
    if (!certificate.rows.length) emptyCertificateRows(1);
    certificate.rows.forEach((row) => { while (row.values.length < certificate.fields.length) row.values.push(''); row.values.length = certificate.fields.length; });
    const headerRow = element('tr'); const selectAll = element('th', 'certificate-row-number', '전체'); selectAll.scope = 'col'; selectAll.dataset.certificateSelectAll = 'true'; selectAll.tabIndex = certificate.running ? -1 : 0; selectAll.setAttribute('role', 'button'); selectAll.setAttribute('aria-label', '문서 정보 표 전체 선택'); headerRow.append(selectAll);
    certificate.fields.forEach((field, index) => {
      const th = element('th', '', `${columnName(index)} · ${field.label}`); th.scope = 'col'; th.dataset.certificateColumnSelect = String(index); th.tabIndex = certificate.running ? -1 : 0; th.setAttribute('role', 'button'); th.setAttribute('aria-label', `${columnName(index)}열 ${field.label} 전체 선택`); headerRow.append(th);
    }); head.append(headerRow);
    certificate.rows.forEach((row, rowIndex) => {
      const tr = element('tr'); const number = element('th', 'certificate-row-number', String(rowIndex + 1)); number.scope = 'row'; number.dataset.certificateRowSelect = String(rowIndex); number.tabIndex = certificate.running ? -1 : 0; number.setAttribute('role', 'button'); number.setAttribute('aria-label', `${rowIndex + 1}행 전체 선택`); tr.append(number);
      certificate.fields.forEach((field, colIndex) => {
        const td = element('td'); td.dataset.certificateRow = String(rowIndex); td.dataset.certificateCol = String(colIndex);
        const input = element('input'); input.type = 'text'; input.value = row.values[colIndex] || ''; input.maxLength = 4000; input.dataset.certificateCell = '1'; input.dataset.certificateRow = String(rowIndex); input.dataset.certificateCol = String(colIndex); input.setAttribute('aria-label', `${rowIndex + 1}행 ${field.label}`); input.readOnly = certificate.running;
        td.append(input); tr.append(td);
      }); body.append(tr);
    });
    updateCertificateRowSummary();
    $('#certificateCellValue').readOnly = certificate.running;
    $('#importCertificateData').disabled = certificate.running;
    $('#importCertificateRoster').disabled = certificate.running || !certificate.fields.length;
    $('#addCertificateRow').disabled = certificate.running || certificate.rows.length >= 2000;
    updateCertificateSelection(); updateHistoryButtons(); updateCertificateReady();
    if (restoreFocus) restoreCertificateGridFocus();
  }

  function updateCertificateRowSummary() {
    $('#certificateRowSummary').textContent = `${certificate.rows.filter((row) => row.values.some((value) => String(value).trim())).length}개 문서 · 전체 ${certificate.rows.length}행`;
    $('#addCertificateRow').disabled = certificate.running || certificate.rows.length >= 2000;
  }

  function snapshotRows() { return certificate.rows.map((row) => ({ values: row.values.slice() })); }

  function rowsEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

  function pushHistory(snapshot = snapshotRows()) {
    certificate.history.push(snapshot); if (certificate.history.length > 50) certificate.history.shift(); certificate.redo = []; updateHistoryButtons();
  }

  function updateHistoryButtons() {
    $('#certificateUndo').disabled = certificate.running || !certificate.history.length; $('#certificateRedo').disabled = certificate.running || !certificate.redo.length;
  }

  function commitCertificateEditBaseline() {
    if (!certificate.editBaseline) return;
    if (!rowsEqual(certificate.editBaseline, certificate.rows)) pushHistory(certificate.editBaseline);
    certificate.editBaseline = null;
  }

  function undoCertificateGrid() {
    if (certificate.running) return;
    commitCertificateEditBaseline();
    if (!certificate.history.length) return;
    certificate.redo.push(snapshotRows()); certificate.rows = certificate.history.pop(); invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true });
  }

  function redoCertificateGrid() {
    if (certificate.running) return;
    commitCertificateEditBaseline();
    if (!certificate.redo.length) return;
    certificate.history.push(snapshotRows()); certificate.rows = certificate.redo.pop(); invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true });
  }

  function setSelection(row, col, extend = false) {
    const maxRow = Math.max(0, certificate.rows.length - 1); const maxCol = Math.max(0, certificate.fields.length - 1);
    const nextRow = Math.max(0, Math.min(maxRow, row)); const nextCol = Math.max(0, Math.min(maxCol, col));
    if (!extend) { certificate.selection.anchorRow = nextRow; certificate.selection.anchorCol = nextCol; }
    certificate.selection.focusRow = nextRow; certificate.selection.focusCol = nextCol;
    updateCertificateSelection();
  }

  function focusCertificateCell(row, col, extend = false) {
    const maxRow = Math.max(0, certificate.rows.length - 1); const maxCol = Math.max(0, certificate.fields.length - 1);
    const nextRow = Math.max(0, Math.min(maxRow, row)); const nextCol = Math.max(0, Math.min(maxCol, col));
    certificate.preserveSelectionOnFocus = extend;
    setSelection(nextRow, nextCol, extend);
    const input = $(`#certificateDataTable input[data-certificate-row="${nextRow}"][data-certificate-col="${nextCol}"]`);
    if (input) { input.focus({ preventScroll: true }); if (!extend) input.select(); }
    certificate.preserveSelectionOnFocus = false;
  }

  function certificatePointerTarget(event, table) {
    const hasPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0);
    if (!hasPoint || typeof document.elementFromPoint !== 'function') return event.target;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    return hit && table.contains(hit) ? hit : null;
  }

  function certificateShouldUseNativeClipboard(event) {
    const input = event.target.closest?.('#certificateDataTable input, #certificateCellValue'); if (!input) return false;
    if (certificateSelectionIsRange()) return false;
    return typeof input.selectionStart === 'number' && input.selectionStart !== input.selectionEnd;
  }

  function certificateShouldUseNativePaste(event, text) {
    if (/\t|\r|\n/.test(text) || certificateSelectionIsRange()) return false;
    return Boolean(event.target.closest?.('#certificateDataTable input, #certificateCellValue'));
  }

  function parseClipboard(text) {
    const rows = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((row) => row.split('\t'));
    if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)[0] === '') rows.pop();
    return rows;
  }

  function pasteCertificateCells(text) {
    if (certificate.running || !certificate.fields.length) return;
    commitCertificateEditBaseline();
    const matrix = parseClipboard(text); if (!matrix.length) return;
    const bounds = selectionBounds(); const startRow = bounds.top; const startCol = bounds.left;
    const previous = snapshotRows();
    if (matrix.length === 1 && matrix[0].length === 1 && certificateSelectionIsRange()) {
      const value = String(matrix[0][0] || '').slice(0, 4000);
      for (let row = bounds.top; row <= bounds.bottom; row += 1) for (let col = bounds.left; col <= bounds.right; col += 1) certificate.rows[row].values[col] = value;
      if (!rowsEqual(previous, certificate.rows)) pushHistory(previous);
      invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true }); return;
    }
    const requiredRows = Math.min(2000, startRow + matrix.length);
    while (certificate.rows.length < requiredRows) certificate.rows.push({ values: Array(certificate.fields.length).fill('') });
    matrix.slice(0, Math.max(0, 2000 - startRow)).forEach((values, rowOffset) => {
      values.slice(0, Math.max(0, certificate.fields.length - startCol)).forEach((value, colOffset) => {
        certificate.rows[startRow + rowOffset].values[startCol + colOffset] = String(value || '').slice(0, 4000);
      });
    });
    if (!rowsEqual(previous, certificate.rows)) pushHistory(previous);
    invalidateActualCertificatePreview();
    setSelection(startRow, startCol, false);
    certificate.selection.focusRow = Math.min(certificate.rows.length - 1, startRow + matrix.length - 1);
    certificate.selection.focusCol = Math.min(certificate.fields.length - 1, startCol + Math.max(...matrix.map((row) => row.length), 1) - 1);
    renderCertificateGrid({ restoreFocus: true });
  }

  function copyCertificateSelection(cut = false) {
    if (cut && certificate.running) return '';
    if (cut) commitCertificateEditBaseline();
    const bounds = selectionBounds(); const rows = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      rows.push(certificate.rows[row].values.slice(bounds.left, bounds.right + 1).join('\t'));
    }
    if (cut) {
      const previous = snapshotRows();
      for (let row = bounds.top; row <= bounds.bottom; row += 1) for (let col = bounds.left; col <= bounds.right; col += 1) certificate.rows[row].values[col] = '';
      if (!rowsEqual(previous, certificate.rows)) { pushHistory(previous); invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true }); }
    }
    return rows.join('\r\n');
  }

  function insertCertificateRow(index) {
    if (certificate.running) return;
    if (certificate.rows.length >= 2000) { notify('문서 정보는 최대 2,000행까지 입력할 수 있습니다.', 'error'); return; }
    commitCertificateEditBaseline();
    pushHistory(); certificate.rows.splice(Math.max(0, Math.min(certificate.rows.length, index)), 0, { values: Array(certificate.fields.length).fill('') });
    invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true });
  }

  function deleteCertificateRows() {
    if (certificate.running) return;
    commitCertificateEditBaseline();
    const bounds = selectionBounds(); pushHistory(); certificate.rows.splice(bounds.top, bounds.bottom - bounds.top + 1);
    if (!certificate.rows.length) certificate.rows.push({ values: Array(certificate.fields.length).fill('') });
    resetCertificateSelection(Math.min(bounds.top, certificate.rows.length - 1), bounds.left); invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true });
  }

  function clearCertificateSelection() {
    if (certificate.running) return;
    commitCertificateEditBaseline();
    const bounds = selectionBounds(); const previous = snapshotRows();
    for (let row = bounds.top; row <= bounds.bottom; row += 1) for (let col = bounds.left; col <= bounds.right; col += 1) certificate.rows[row].values[col] = '';
    if (rowsEqual(previous, certificate.rows)) return;
    pushHistory(previous); invalidateActualCertificatePreview();
    renderCertificateGrid({ restoreFocus: true });
  }

  function fillCertificateDown() {
    if (certificate.running) return;
    commitCertificateEditBaseline();
    const bounds = selectionBounds(); if (bounds.bottom <= bounds.top) return;
    const previous = snapshotRows();
    for (let row = bounds.top + 1; row <= bounds.bottom; row += 1) for (let col = bounds.left; col <= bounds.right; col += 1) certificate.rows[row].values[col] = certificate.rows[bounds.top].values[col];
    if (rowsEqual(previous, certificate.rows)) return;
    pushHistory(previous); invalidateActualCertificatePreview();
    renderCertificateGrid({ restoreFocus: true });
  }

  function openCertificateContextMenu(event, row, col) {
    if (certificate.running) return;
    event.preventDefault(); event.stopPropagation();
    closeCertificateContextMenu();
    if (!certificatePointInsideSelection(row, col)) setSelection(row, col, false);
    certificateContextOrigin = event.target;
    const menu = $('#certificateContextMenu'); const bounds = selectionBounds();
    $('[data-certificate-context="fill-down"]', menu).disabled = bounds.bottom <= bounds.top;
    $$('[data-certificate-context="insert-above"], [data-certificate-context="insert-below"]', menu).forEach((button) => { button.disabled = certificate.rows.length >= 2000; });
    menu.hidden = false;
    const originRect = event.target.getBoundingClientRect(); const menuRect = menu.getBoundingClientRect();
    const requestedX = event.clientX || originRect.left + Math.min(originRect.width, 24); const requestedY = event.clientY || originRect.bottom;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menuRect.width - 8, requestedX))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - menuRect.height - 8, requestedY))}px`;
    $('button:not(:disabled)', menu)?.focus({ preventScroll: true });
  }

  function closeCertificateContextMenu({ restoreFocus = false } = {}) {
    const menu = $('#certificateContextMenu'); if (menu.hidden) return;
    const origin = certificateContextOrigin; menu.hidden = true; certificateContextOrigin = null;
    if (restoreFocus && origin?.isConnected) {
      certificate.preserveSelectionOnFocus = true; origin.focus?.({ preventScroll: true }); certificate.preserveSelectionOnFocus = false;
    }
  }

  function updateCertificateRowNavigation() {
    const count = certificate.rows.length; certificate.currentRow = Math.max(0, Math.min(count - 1, certificate.currentRow));
    $('#certificatePreviewRowLabel').textContent = `${certificate.currentRow + 1}행 / ${count}행`;
    $('#previousCertificateRow').disabled = certificate.running || certificate.previewing || certificate.currentRow <= 0;
    $('#nextCertificateRow').disabled = certificate.running || certificate.previewing || certificate.currentRow >= count - 1;
    const preview = $('#previewCertificateRow'); preview.disabled = certificate.running || certificate.previewing || !certificate.capabilities?.engine || !certificate.fields.length;
    preview.title = certificate.capabilities?.engine ? '선택한 행의 실제 출력 모습을 확인합니다.' : '실제 미리보기에는 Microsoft PowerPoint 또는 LibreOffice가 필요합니다.';
  }

  async function previewCurrentCertificateRow() {
    const rowIndex = certificate.currentRow; const row = certificate.rows[rowIndex];
    if (!row || !certificate.fields.length || certificate.running || certificate.previewing || !certificate.capabilities?.engine) return;
    const sequence = ++certificate.rowPreviewSequence; const expectedToken = certificate.template?.token; const expectedSlide = certificate.slideNumber;
    certificate.previewing = true;
    const button = $('#previewCertificateRow'); button.disabled = true; button.textContent = '미리보기 만드는 중…';
    updateCertificateRowNavigation(); updateCertificateReady();
    $('#certificatePreviewMode').textContent = `${rowIndex + 1}행의 실제 결과를 만드는 중입니다.`;
    try {
      const result = await api().previewCertificate(templatePayload({ values: row.values.slice() }));
      if (sequence !== certificate.rowPreviewSequence || certificate.template?.token !== expectedToken || certificate.slideNumber !== expectedSlide) return;
      const image = $('#certificatePreviewImage'); image.src = result.imageUrl; image.hidden = false; $('#certificatePreviewPlaceholder').hidden = true;
      $('#certificatePreviewStage').classList.remove('fallback-preview'); $('#certificatePreviewStage').classList.add('actual-preview'); $('#showCertificateTemplatePreview').hidden = false;
      scheduleCertificateOverlayBounds(); renderCertificateFontNotice({ ...result, fidelity: result.fidelity || (result.engine === 'powerpoint' ? 'native' : 'compatible') });
      $('#certificatePreviewMode').textContent = `${rowIndex + 1}행 실제 결과 · 출력 전에 글자 크기와 줄바꿈을 확인하세요.`;
    } catch (error) { notify(`템플릿 문서 미리보기 실패: ${error.message}`, 'error'); await refreshCapabilities(true); }
    finally {
      if (sequence === certificate.rowPreviewSequence) certificate.previewing = false;
      button.textContent = '현재 문서 결과 미리보기'; updateCertificateRowNavigation(); updateCertificateReady();
    }
  }

  function restoreTemplatePreview() {
    const entry = certificate.previewCache[String(certificate.slideNumber)];
    if (!entry?.imageUrl) { void renderTemplatePreview(); return; }
    applyCertificateTemplatePreview(entry);
    $('#certificatePreviewMode').textContent = '미리보기의 텍스트 상자를 누른 뒤 실제로 바꿀 글자만 드래그해 연결하세요.';
  }

  async function loadCertificateTemplate(result, profile = null) {
    certificate.rowPreviewSequence += 1; certificate.previewing = false;
    certificate.template = {
      token: result.token,
      profileId: profile?.id || '',
      name: result.name,
      slideSize: result.slideSize,
      slides: result.slides || [],
      fontReport: result.fontReport || { usedFonts: result.usedFonts || [], embeddedFonts: result.embeddedFonts || [], missingFonts: result.missingFonts || [] },
      certificatePdfReadiness: result.certificatePdfReadiness || null
    };
    certificate.certificatePdfReadiness = result.certificatePdfReadiness || null;
    certificate.preparationPlan = result.preparationPlan || result.certificatePdfReadiness?.preparationPlan || null;
    certificate.preparing = false;
    certificate.previewCache = {}; certificate.previewCacheOrder = []; certificate.slideDrafts = {}; certificate.showHiddenBlocks = false;
    certificate.rosterImport = null;
    certificate.slideNumber = Number(profile?.slideNumber || result.slides?.[0]?.number || 1);
    const slide = selectedSlide(); const available = new Map((slide?.blocks || []).map((block) => [block.id, block]));
    certificate.fields = (profile?.fields || []).filter((field) => available.has(field.blockId)).map((field, index) => {
      const block = available.get(field.blockId);
      const declaresRange = field.rangeStart !== undefined || field.rangeEnd !== undefined || field.selectedText !== undefined;
      const hasRange = Number.isInteger(field.rangeStart) && Number.isInteger(field.rangeEnd)
        && field.rangeStart >= 0 && field.rangeEnd <= String(block.text || '').length && field.rangeEnd > field.rangeStart;
      if (declaresRange && !hasRange) return null;
      const selectedText = hasRange ? String(block.text || '').slice(field.rangeStart, field.rangeEnd) : String(block.text || '');
      if (hasRange && field.selectedText && field.selectedText !== selectedText) return null;
      return {
        blockId: field.blockId,
        label: field.label || `항목 ${index + 1}`,
        sourceText: selectedText,
        sourceName: block.name,
        ...(hasRange ? { rangeStart: field.rangeStart, rangeEnd: field.rangeEnd, selectedText } : {})
      };
    }).filter(Boolean);
    certificate.filenameTemplate = String(profile?.filenameTemplate ?? '{A}').slice(0, 160);
    emptyCertificateRows(3); certificate.templatePreviewUrl = ''; saveCertificateSlideDraft();
    $('#certificateEditor').hidden = false;
    $('#certificateTemplateStatus').textContent = profile ? `저장한 양식 “${profile.name}”을 불러왔습니다.` : `${result.name} · ${result.slideCount}개 슬라이드`;
    const slideField = $('#certificateSlideField'); const select = $('#certificateSlideSelect'); select.replaceChildren();
    (result.slides || []).forEach((item) => { const option = element('option', '', `${item.number}페이지 · 글자 ${item.visibleBlockCount ?? item.blockCount}개`); option.value = String(item.number); select.append(option); });
    select.value = String(certificate.slideNumber); slideField.hidden = (result.slides || []).length <= 1;
    const stage = $('#certificatePreviewStage'); stage.style.aspectRatio = `${result.slideSize?.width || 16} / ${result.slideSize?.height || 9}`;
    renderCertificateSlideRail(); updateCertificateSlideNavigation(); renderCertificateFontNotice(); renderCertificateFields(); renderCertificateGrid(); renderCertificateDependency(); updateCertificateReady(); scheduleCertificateOverlayBounds();
    await renderTemplatePreview();
  }

  async function chooseCertificateTemplate() {
    if (certificate.running) return;
    if (hasCertificateData() && !await confirmAction('다른 양식을 선택하면 현재 표에 입력한 정보가 지워집니다. 계속할까요?', { title: '양식 바꾸기', action: '새 양식 선택', danger: false })) return;
    try {
      const result = await api().chooseCertificateTemplate(); if (result.canceled) return;
      await loadCertificateTemplate(result);
    } catch (error) { notify(`PPTX 양식을 불러오지 못했습니다: ${error.message}`, 'error'); }
  }

  async function renderProfiles() {
    const container = $('#certificateProfileList'); container.replaceChildren();
    try { certificate.profiles = await api().listCertificateProfiles(); }
    catch (error) { certificate.profiles = []; notify(`저장된 양식 목록을 읽지 못했습니다: ${error.message}`, 'error'); }
    if (!certificate.profiles.length) { container.append(element('div', 'list-empty', '저장한 양식이 없습니다. PPTX 양식을 한 번 선택해보세요.')); return; }
    certificate.profiles.forEach((profile) => {
      const card = element('article', 'certificate-profile-card');
      const open = element('button'); open.type = 'button'; open.dataset.certificateProfileOpen = profile.id; open.disabled = certificate.running; open.setAttribute('aria-label', `${profile.name} 양식 열기`); open.append(element('strong', '', profile.name), element('small', '', `${profile.fields.length}개 항목 · ${profile.sourceName}`));
      const remove = element('button', 'text-button danger-text', '삭제'); remove.type = 'button'; remove.dataset.certificateProfileDelete = profile.id; remove.disabled = certificate.running; remove.setAttribute('aria-label', `${profile.name} 저장 양식 삭제`);
      card.append(open, remove); container.append(card);
    });
  }

  async function openCertificateProfile(profileId) {
    if (certificate.running) return;
    if (hasCertificateData() && !await confirmAction('저장한 다른 양식을 열면 현재 표에 입력한 정보가 지워집니다. 계속할까요?', { title: '저장한 양식 열기', action: '양식 열기', danger: false })) return;
    try { const result = await api().openCertificateProfile(profileId); await loadCertificateTemplate(result, result.profile); }
    catch (error) { notify(`저장한 양식을 열지 못했습니다: ${error.message}`, 'error'); }
  }

  async function saveCertificateProfile() {
    if (certificate.running || !certificate.template || !certificate.fields.length) return;
    const filenameReady = renderCertificateFilenamePreview();
    if (!filenameReady.ok) { notify(filenameReady.error, 'error'); $('#certificateFilenameTemplate').focus({ preventScroll: true }); return; }
    const name = await requestName('저장할 양식 이름', certificate.template.name.replace(/\.pptx$/i, ''));
    if (!String(name || '').trim()) return;
    try {
      const profile = await api().saveCertificateProfile(templatePayload({ name, filenameTemplate: certificate.filenameTemplate }));
      $('#certificateTemplateStatus').textContent = `“${profile.name}” 양식으로 저장했습니다.`;
      await renderProfiles(); notify('양식과 글자 선택 순서를 저장했습니다.', 'success');
    } catch (error) { notify(`양식을 저장하지 못했습니다: ${error.message}`, 'error'); }
  }

  async function deleteCertificateProfile(profileId) {
    if (certificate.running) return;
    const profile = certificate.profiles.find((item) => item.id === profileId); if (!profile) return;
    if (!await confirmAction(`“${profile.name}” 저장 양식을 삭제할까요? 템플릿 파일은 휴지통으로 이동합니다.`, { title: '저장한 양식 삭제', action: '삭제' })) return;
    try {
      await api().deleteCertificateProfile(profileId);
      if (certificate.template?.profileId === profileId) {
        certificate.template = null; certificate.fields = []; certificate.rows = []; certificate.templatePreviewUrl = ''; certificate.rosterImport = null;
        certificate.previewCache = {}; certificate.previewCacheOrder = []; certificate.slideDrafts = {}; certificate.showHiddenBlocks = false; certificate.filenameTemplate = '{A}';
        certificate.certificatePdfReadiness = null; certificate.preparationPlan = null; certificate.preparing = false;
        $('#certificateEditor').hidden = true; $('#certificateDataPanel').hidden = true; $('#certificateOutputPanel').hidden = true;
      }
      await renderProfiles(); notify('저장한 양식을 휴지통으로 이동했습니다.');
    }
    catch (error) { notify(`저장한 양식을 삭제하지 못했습니다: ${error.message}`, 'error'); }
  }

  async function importCertificateData() {
    if (certificate.running || !certificate.fields.length) return;
    commitCertificateEditBaseline();
    try {
      const result = await api().chooseCertificateData(); if (result.canceled) return;
      const sheet = (result.sheets || []).find((item) => item.matrix?.length) || result.sheets?.[0];
      if (!sheet) throw new Error('가져올 데이터가 없습니다.');
      let matrix = sheet.matrix.map((row) => row.slice(0, certificate.fields.length));
      const normalizedLabels = certificate.fields.map((field) => field.label.trim().toLocaleLowerCase('ko-KR'));
      const first = matrix[0]?.map((value) => String(value).trim().toLocaleLowerCase('ko-KR')) || [];
      const headerMatched = normalizedLabels.length && normalizedLabels.every((label, index) => label && first[index] === label);
      if (headerMatched) matrix = matrix.slice(1);
      const previous = snapshotRows();
      certificate.rows = matrix.slice(0, 2000).map((values) => ({ values: certificate.fields.map((_field, index) => String(values[index] ?? '').slice(0, 4000)) }));
      if (!certificate.rows.length) certificate.rows.push({ values: Array(certificate.fields.length).fill('') });
      certificate.rosterImport = { kind: 'file', name: sheet.name || 'Excel·CSV', count: certificate.rows.length };
      certificate.history = [previous]; certificate.redo = []; resetCertificateSelection(); invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true });
      notify(`${sheet.name}에서 ${certificate.rows.length}행을 가져왔습니다.${Number(result.sheetCount || (result.sheets || []).length) > 1 ? ' 첫 번째 데이터 시트를 사용했습니다.' : ''}`, 'success');
    } catch (error) { notify(`문서 데이터를 가져오지 못했습니다: ${error.message}`, 'error'); }
  }

  function rosterDate(value) {
    const date = new Date(value || 0); if (Number.isNaN(date.getTime())) return '수정 시각 없음';
    return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function rosterSourceDetail(source) {
    if (source.kind === 'project') {
      const roster = source.rosterName || '프로젝트 원본 명단';
      return [source.client, roster, `사용 중 ${source.activeCount}명 / 전체 ${source.totalCount}명`, `${source.columns.length}개 열`].filter(Boolean).join(' · ');
    }
    return [`사용 중 ${source.activeCount}명 / 전체 ${source.totalCount}명`, `${source.columns.length}개 열`, `저장 ${rosterDate(source.updatedAt)}`].join(' · ');
  }

  function renderRosterSourceGroup(container, title, sources, emptyText) {
    const section = element('section', 'certificate-roster-source-group'); section.append(element('h4', '', title));
    const grid = element('div', 'certificate-roster-source-grid');
    if (!sources.length) grid.append(element('div', 'list-empty', emptyText));
    sources.forEach((source) => {
      const button = element('button', `certificate-roster-source-card ${source.current ? 'current' : ''}`); button.type = 'button'; button.dataset.certificateRosterSource = source.key;
      button.disabled = source.activeCount === 0 || source.columns.length === 0;
      const top = element('span', 'certificate-roster-source-top');
      top.append(element('strong', '', `${source.kind === 'project' ? '프로젝트' : '저장 명단'} · ${source.name}`));
      const badges = element('span', 'certificate-roster-source-badges');
      if (source.current) badges.append(element('span', 'source-badge current', '현재 프로젝트'));
      badges.append(element('span', `source-badge ${source.status}`, source.statusLabel)); top.append(badges);
      button.append(top, element('span', 'certificate-roster-source-detail', rosterSourceDetail(source)), element('small', '', source.activeCount ? `최근 수정 ${rosterDate(source.updatedAt)}` : '사용 중인 사람이 없어 가져올 수 없습니다.'));
      grid.append(button);
    });
    section.append(grid); container.append(section);
  }

  function renderCertificateRosterSources() {
    const list = $('#certificateRosterSourceList'); list.replaceChildren();
    const catalog = rosterPicker.catalog || { projects: [], saved: [] };
    const current = catalog.projects.filter((source) => source.current);
    const other = catalog.projects.filter((source) => !source.current && source.status !== 'archived');
    const archived = catalog.projects.filter((source) => !source.current && source.status === 'archived');
    renderRosterSourceGroup(list, '현재 프로젝트', current, '현재 선택된 프로젝트가 없습니다. 아래의 다른 프로젝트나 저장 명단을 선택하세요.');
    renderRosterSourceGroup(list, '다른 프로젝트', other, '명단이 있는 다른 진행 프로젝트가 없습니다.');
    renderRosterSourceGroup(list, 'Workspace에 저장한 명단', catalog.saved, '따로 저장한 명단이 없습니다. 프로젝트 명단은 위에서 바로 가져올 수 있습니다.');
    if (archived.length) renderRosterSourceGroup(list, '보관된 프로젝트', archived, '');
  }

  function renderCertificateRosterPreview() {
    const container = $('#certificateRosterMappingPreview'); container.replaceChildren();
    if (rosterPicker.loading) { container.append(element('div', 'list-empty', '선택한 열의 내용을 안전하게 불러오는 중입니다.')); return; }
    const mapped = RosterCore.mapRows(certificate.fields, rosterPicker.mappings, rosterPicker.rows).slice(0, 3);
    if (!mapped.length) { container.append(element('div', 'list-empty', rosterPicker.mappings.some(Boolean) ? '미리볼 명단 행이 없습니다.' : '한 개 이상의 명단 열을 연결해주세요.')); return; }
    const table = element('table', 'data-table certificate-roster-preview-table'); const head = element('thead'); const header = element('tr');
    certificate.fields.forEach((field, index) => header.append(element('th', '', `${columnName(index)} · ${field.label}`))); head.append(header);
    const body = element('tbody'); mapped.forEach((row) => { const tr = element('tr'); row.values.forEach((value) => tr.append(element('td', '', value || '—'))); body.append(tr); });
    table.append(head, body); container.append(table);
  }

  function updateCertificateRosterMappingMeta() {
    const source = rosterPicker.selected; if (!source) return;
    const selectedColumnIds = new Set(rosterPicker.mappings.filter(Boolean));
    const sensitive = source.columns.some((column) => selectedColumnIds.has(column.id) && ['email', 'phone'].includes(column.type));
    $('#certificateRosterPrivacyNote').hidden = !sensitive;
    const apply = $('#applyCertificateRoster'); apply.hidden = false; apply.disabled = rosterPicker.loading || !selectedColumnIds.size;
    apply.textContent = `${source.activeCount}명 가져오기`;
  }

  async function loadCertificateRosterPreview() {
    const source = rosterPicker.selected; if (!source) return;
    const columnIds = [...new Set(rosterPicker.mappings.filter(Boolean))]; const sequence = ++rosterPicker.sequence;
    rosterPicker.rows = [];
    if (!columnIds.length) { rosterPicker.loading = false; renderCertificateRosterPreview(); updateCertificateRosterMappingMeta(); return; }
    rosterPicker.loading = true; renderCertificateRosterPreview(); updateCertificateRosterMappingMeta();
    try {
      const result = await api().readCertificateRosterSource({ kind: source.kind, id: source.id, columnIds, expectedVersion: source.version });
      if (sequence !== rosterPicker.sequence) return;
      rosterPicker.rows = result.rows || []; rosterPicker.loading = false; renderCertificateRosterPreview(); updateCertificateRosterMappingMeta();
    } catch (error) {
      if (sequence !== rosterPicker.sequence) return;
      rosterPicker.loading = false; rosterPicker.rows = []; renderCertificateRosterPreview(); updateCertificateRosterMappingMeta(); notify(`명단 미리보기를 불러오지 못했습니다: ${error.message}`, 'error');
    }
  }

  function selectCertificateRosterSource(sourceKey) {
    const source = [...(rosterPicker.catalog?.projects || []), ...(rosterPicker.catalog?.saved || [])].find((item) => item.key === sourceKey); if (!source || !source.activeCount) return;
    rosterPicker.selected = source; rosterPicker.mappings = RosterCore.suggestMappings(certificate.fields, source.columns); rosterPicker.rows = [];
    $('#certificateRosterSourceStep').hidden = true; $('#certificateRosterMappingStep').hidden = false;
    const summary = $('#certificateRosterSelectedSummary'); summary.replaceChildren(
      element('strong', '', `${source.kind === 'project' ? '프로젝트' : '저장 명단'} · ${source.name}`),
      element('span', '', rosterSourceDetail(source))
    );
    const list = $('#certificateRosterMappingList'); list.replaceChildren();
    certificate.fields.forEach((field, index) => {
      const row = element('label', 'certificate-roster-mapping-row');
      row.append(element('span', 'certificate-roster-target-field', `${columnName(index)} · ${field.label}`));
      const select = element('select'); select.dataset.certificateRosterMapping = String(index); select.setAttribute('aria-label', `${field.label}에 연결할 명단 열`);
      const empty = element('option', '', '빈칸으로 두기'); empty.value = ''; select.append(empty);
      source.columns.forEach((column) => { const option = element('option', '', `${column.name}${column.type !== 'text' ? ` · ${column.type}` : ''}`); option.value = column.id; option.selected = rosterPicker.mappings[index] === column.id; select.append(option); });
      row.append(select); list.append(row);
    });
    updateCertificateRosterMappingMeta(); renderCertificateRosterPreview(); void loadCertificateRosterPreview();
  }

  async function openCertificateRosterPicker() {
    if (certificate.running || !certificate.fields.length) return;
    if (!RosterCore || !api()?.listCertificateRosterSources || !api()?.readCertificateRosterSource) { notify('이 설치본에서는 명단 가져오기를 사용할 수 없습니다. 최신 설치본으로 다시 설치해주세요.', 'error'); return; }
    rosterPicker.catalog = null; rosterPicker.selected = null; rosterPicker.mappings = []; rosterPicker.rows = []; rosterPicker.loading = true; rosterPicker.sequence += 1;
    $('#certificateRosterSourceStep').hidden = false; $('#certificateRosterMappingStep').hidden = true; $('#applyCertificateRoster').hidden = true;
    $('#certificateRosterSourceList').replaceChildren(element('div', 'list-empty', '프로젝트와 저장 명단을 불러오는 중입니다.'));
    const dialog = $('#certificateRosterDialog'); if (!dialog.open) dialog.showModal();
    try { rosterPicker.catalog = await api().listCertificateRosterSources(); rosterPicker.loading = false; renderCertificateRosterSources(); }
    catch (error) { rosterPicker.loading = false; $('#certificateRosterSourceList').replaceChildren(element('div', 'list-empty', '명단 목록을 불러오지 못했습니다.')); notify(`명단 목록을 불러오지 못했습니다: ${error.message}`, 'error'); }
  }

  async function applyCertificateRoster() {
    const source = rosterPicker.selected; const columnIds = [...new Set(rosterPicker.mappings.filter(Boolean))];
    if (!source || !columnIds.length || rosterPicker.loading) return;
    if (hasCertificateData() && !await confirmAction('현재 표의 내용을 선택한 명단으로 바꿀까요? 기존 셀 내용은 실행 취소로 한 번 되돌릴 수 있습니다.', { title: '문서 정보 교체', action: '명단으로 교체', danger: false })) return;
    const button = $('#applyCertificateRoster'); button.disabled = true; button.textContent = '가져오는 중…';
    try {
      const result = await api().readCertificateRosterSource({ kind: source.kind, id: source.id, columnIds, expectedVersion: source.version });
      const rows = RosterCore.mapRows(certificate.fields, rosterPicker.mappings, result.rows || []); if (!rows.length) throw new Error('가져올 사용 중인 사람이 없습니다.');
      const previous = snapshotRows(); certificate.rows = rows; certificate.rosterImport = { kind: source.kind, name: source.name, count: rows.length, importedAt: new Date().toISOString() };
      certificate.history = [previous]; certificate.redo = []; resetCertificateSelection(); invalidateActualCertificatePreview(); renderCertificateGrid({ restoreFocus: true });
      $('#certificateRosterDialog').close(); notify(`${source.name}에서 ${rows.length}명을 문서 표로 가져왔습니다.`, 'success');
    } catch (error) {
      notify(`명단을 가져오지 못했습니다: ${error.message}`, 'error');
      if (error?.code === 'ROSTER_SOURCE_CHANGED' || /방금 변경/.test(error?.message || '')) { $('#certificateRosterDialog').close(); void openCertificateRosterPicker(); }
    } finally { button.disabled = false; button.textContent = `${source.activeCount}명 가져오기`; }
  }

  async function chooseCertificateOutput() {
    if (certificate.running) return;
    try {
      const result = await api().chooseDocumentOutputDirectory(); if (result.canceled) return;
      certificate.outputToken = result.token; certificate.outputName = result.name; $('#certificateOutputSummary').textContent = `${result.name}에 행별 파일을 저장합니다.`; updateCertificateReady();
    } catch (error) { notify(`저장 폴더를 선택하지 못했습니다: ${error.message}`, 'error'); }
  }

  function certificateRowsForOutput() {
    return certificate.rows.filter((row) => row.values.some((value) => String(value || '').trim()));
  }

  function updateCertificateReady() {
    if (!$('#generateCertificates')) return;
    const outputRows = certificateRowsForOutput(); const pdf = $('#certificateOutputPdf').checked; const pptx = $('#certificateOutputPptx').checked;
    const requirements = currentCertificatePdfRequirements();
    const pdfReady = requirements.ready;
    const filenameReady = renderCertificateFilenamePreview();
    const ready = certificate.template && certificate.fields.length && outputRows.length && filenameReady.ok && certificate.outputToken && (pdf || pptx) && pdfReady && !certificate.running && !certificate.preparing && !certificate.previewing;
    const busy = certificate.running || certificate.preparing;
    $('#chooseCertificateTemplate').disabled = busy;
    $('#certificateSlideSelect').disabled = busy;
    $('#clearCertificateFields').disabled = busy || !certificate.fields.length;
    $('#saveCertificateProfile').disabled = guideDemo.active || busy || !certificate.template || !certificate.fields.length || !filenameReady.ok;
    $('#importCertificateRoster').disabled = busy || !certificate.fields.length;
    $('#importCertificateData').disabled = busy;
    $('#addCertificateRow').disabled = busy || certificate.rows.length >= 2000;
    $('#certificateFilenameTemplate').disabled = busy;
    $$('#certificateFilenameVariables button').forEach((button) => { button.disabled = busy || button.dataset.filenameUnavailable === 'true'; });
    $('#chooseCertificateOutput').disabled = busy;
    $('#certificateOutputPdf').disabled = busy;
    $('#certificateOutputPptx').disabled = busy;
    $('#showCertificateTemplatePreview').disabled = busy;
    $$('#certificateProfileList button, #certificateFieldList input, #certificateFieldList button, #certificateBlockOverlay button, #certificateSlideRail button').forEach((control) => { control.disabled = busy; });
    $$('#certificateDataTable input').forEach((input) => { input.readOnly = busy; });
    $('#certificateCellValue').readOnly = busy;
    updateHistoryButtons(); updateCertificateRowNavigation(); updateCertificateSlideNavigation(); updateCertificateFlow();
    const generate = $('#generateCertificates'); const cancel = $('#cancelCertificates');
    generate.disabled = !ready; generate.textContent = certificate.running ? '생성 중…' : '문서 일괄 생성';
    cancel.hidden = !certificate.running; cancel.disabled = certificate.cancelling; cancel.textContent = certificate.cancelling ? '중단 요청됨…' : '생성 중단';
    if (certificate.running) {
      if (certificate.cancelling) $('#certificateRunStatus').textContent = '현재 처리 중인 문서 묶음을 안전하게 마친 뒤 중단합니다. 이미 저장된 파일은 유지됩니다.';
      return;
    }
    $('#certificateRunStatus').textContent = !certificate.template
      ? '먼저 PPTX 양식을 선택해주세요.'
      : !certificate.fields.length
      ? '미리보기에서 바꿀 글자를 선택해주세요.'
      : !outputRows.length
      ? '표에 문서 정보를 한 행 이상 입력해주세요.'
      : !filenameReady.ok
      ? filenameReady.error
      : !certificate.outputToken
      ? '결과를 저장할 폴더를 선택해주세요.'
      : !pdfReady
      ? requirements.running
        ? '작업 중인 PowerPoint를 저장하고 닫은 뒤 위의 다시 확인 버튼을 눌러주세요.'
        : requirements.requiredFonts.length
        ? `위의 자동 준비 버튼으로 원본 글꼴 ${requirements.requiredFonts.length}개를 먼저 준비해주세요.`
        : '위의 자동 준비 버튼으로 최종 PDF에 필요한 Microsoft PowerPoint를 준비해주세요.'
      : !(pdf || pptx)
      ? '출력 형식을 하나 이상 선택해주세요.'
      : certificate.previewing
      ? '현재 행 미리보기가 끝나면 일괄 생성할 수 있습니다.'
      : `${outputRows.length}개 문서를 만들 준비가 됐습니다.`;
    renderCertificateDependency();
  }

  async function generateCertificates() {
    if ($('#generateCertificates').disabled) return;
    let finalStatus = '';
    const rows = certificateRowsForOutput(); certificate.running = true; certificate.cancelling = false; certificate.successfulIndexes = []; certificate.requestId = crypto.randomUUID();
    const progress = $('#certificateProgress'); progress.hidden = false; progress.max = rows.length; progress.value = 0;
    $('#openCertificateOutput').hidden = true; $('#certificateRunStatus').textContent = `${rows.length}개 문서를 차례로 만드는 중입니다.`; updateCertificateReady();
    try {
      const result = await api().generateCertificates(templatePayload({
        requestId: certificate.requestId,
        rows,
        outputToken: certificate.outputToken,
        filenameTemplate: certificate.filenameTemplate,
        formats: { pdf: $('#certificateOutputPdf').checked, pptx: $('#certificateOutputPptx').checked }
      }));
      progress.value = rows.length; $('#openCertificateOutput').hidden = result.completed === 0;
      finalStatus = result.failed ? `${result.completed}개 완료 · ${result.failed}개는 만들지 못했습니다.` : `${result.completed}개 문서를 모두 만들었습니다.`;
      $('#certificateRunStatus').textContent = finalStatus;
      notify(result.failed ? `${result.completed}개 문서를 만들었고 ${result.failed}개는 확인이 필요합니다.` : `${result.completed}개 문서를 만들었습니다.`, result.failed ? 'normal' : 'success');
      reportWorkflowStatus('documentEditor', result.failed ? 'needsReview' : 'complete', finalStatus, { documentMode: 'certificateMaker' });
    } catch (error) {
      const cancelled = isDocumentToolCancellation(error);
      if (cancelled) {
        const completed = certificate.successfulIndexes.length;
        $('#openCertificateOutput').hidden = completed === 0;
        finalStatus = completed
          ? `생성을 중단했습니다. 중단 전에 완료된 ${completed}개 문서의 결과 파일은 선택한 폴더에 그대로 남아 있습니다.`
          : '문서 생성을 중단했습니다. 아직 저장된 결과 파일은 없습니다.';
        notify('문서 일괄 생성을 중단했습니다.', 'normal');
      } else {
        finalStatus = error.message; notify(`문서 일괄 생성 실패: ${error.message}`, 'error'); reportWorkflowStatus('documentEditor', 'needsReview', '문서 생성 오류를 확인해주세요.', { documentMode: 'certificateMaker' });
        try { await refreshCertificateRequirements({ refreshCapabilities: true }); } catch (_) { await refreshCapabilities(true); }
      }
      $('#certificateRunStatus').textContent = finalStatus;
    } finally {
      certificate.running = false; certificate.cancelling = false; certificate.successfulIndexes = []; certificate.requestId = '';
      renderCertificateFields(); renderCertificateGrid(); updateCertificateReady();
      if (finalStatus) $('#certificateRunStatus').textContent = finalStatus;
    }
  }

  async function cancelCertificateGeneration() {
    if (!certificate.running || certificate.cancelling) return;
    if (guideDemo.active) { notify('가이드에서는 실제 문서 생성 작업을 중단하지 않습니다.'); return; }
    certificate.cancelling = true; updateCertificateReady();
    try {
      const result = await api().cancelDocumentToolJob(certificate.requestId);
      if (!result?.ok) {
        certificate.cancelling = false; updateCertificateReady();
        $('#certificateRunStatus').textContent = '작업이 이미 마무리 중입니다. 결과를 확인하고 있습니다.';
      }
    } catch (error) {
      certificate.cancelling = false; updateCertificateReady();
      $('#certificateRunStatus').textContent = `중단 요청을 보내지 못했습니다: ${error.message}`;
      notify(`문서 생성 중단 요청 실패: ${error.message}`, 'error');
    }
  }

  function handleProgress(progress) {
    if (['pptxPdf', 'documentConversion', 'conversion'].includes(progress.kind) && progress.requestId === converter.requestId) {
      if (['convert', 'conversion', 'complete'].includes(progress.phase) && Number.isInteger(Number(progress.index))) {
        const index = Number(progress.index); const file = converter.files[index];
        if (file) { file.status = progress.ok === false ? 'failed' : progress.phase === 'complete' && progress.ok === true ? 'complete' : 'working'; file.error = progress.error || ''; file.engine = progress.engine || file.engine || ''; renderConverterFiles(); }
        $('#pptxPdfProgress').value = Math.max(Number($('#pptxPdfProgress').value), index + 1);
      }
    }
    if (progress.kind === 'certificateMaker' && progress.requestId === certificate.requestId && progress.phase === 'generate') {
      const index = Number(progress.index);
      $('#certificateProgress').value = Math.max(Number($('#certificateProgress').value), index + 1);
      if (progress.ok === true && Number.isInteger(index) && !certificate.successfulIndexes.includes(index)) certificate.successfulIndexes.push(index);
      if (!certificate.cancelling) $('#certificateRunStatus').textContent = `${Math.min(index + 1, Number(progress.total))} / ${progress.total} 처리 중${progress.ok === false ? ' · 한 행 확인 필요' : ''}`;
    }
    const mergeEntry = Object.entries(mergeStates).find(([, state]) => state.requestId && state.requestId === progress.requestId);
    if (mergeEntry && ['documentMerge', 'pdfMerge', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge', 'pdf', 'pptx', 'word', 'excel', 'documents'].includes(progress.kind)) {
      const [mode, state] = mergeEntry; const index = Number(progress.index); const total = Number(progress.total || state.files.length);
      state.progressVisible = true;
      state.lastProgressPhase = String(progress.phase || '').slice(0, 80);
      if (Number.isInteger(index) && index >= 0) state.lastProgressIndex = index;
      if (progress.engine) state.lastProgressEngine = String(progress.engine).slice(0, 80);
      const completed = Number.isFinite(Number(progress.completed)) ? Number(progress.completed) : Number.isInteger(index) ? index + 1 : 0;
      if (completed > 0) state.progressValue = Math.max(Number(state.progressValue || 0), Math.min(total, completed));
      const nativeOfficeFinishing = ['wordMerge', 'excelMerge'].includes(mode) && progress.phase === 'merge';
      if (!state.cancelling && nativeOfficeFinishing) {
        state.runStatus = mode === 'wordMerge'
          ? '선택한 순서대로 페이지·구역을 연결해 최종 Word 파일을 만드는 중입니다.'
          : '파일 순서와 각 파일의 시트 순서대로 최종 Excel 파일을 만드는 중입니다.';
      } else if (!state.cancelling && completed > 0) state.runStatus = `${Math.min(total, completed)} / ${total} 파일 처리 중`;
      if (state === activeMergeState()) {
        $('#documentMergeProgress').max = Math.max(1, total); $('#documentMergeProgress').value = state.progressValue;
        if (!state.cancelling) $('#documentMergeRunStatus').textContent = state.runStatus;
      }
    }
    const splitEntry = Object.entries(splitStates).find(([, state]) => state.requestId && state.requestId === progress.requestId);
    if (splitEntry && ['documentSplit', 'pdfSplit', 'pptxSplit', 'pdf', 'pptx'].includes(progress.kind)) {
      const [kind, state] = splitEntry; const meta = DOCUMENT_SPLIT_META[kind]; const index = Number(progress.index);
      const plannedTotal = buildSplitPlan(state, meta).groups.length; const total = Number(progress.total || plannedTotal || 1);
      const completed = Number.isFinite(Number(progress.completed)) ? Number(progress.completed) : Number.isInteger(index) ? index + 1 : 0;
      state.progressVisible = true;
      if (completed > 0) state.progressValue = Math.max(Number(state.progressValue || 0), Math.min(total, completed));
      if (!state.cancelling && completed > 0) state.runStatus = `${Math.min(total, completed)} / ${total} 결과 파일 처리 중`;
      if (documentMode === 'documentSplit' && state === activeSplitState()) {
        $('#documentSplitProgress').max = Math.max(1, total); $('#documentSplitProgress').value = state.progressValue;
        if (!state.cancelling) $('#documentSplitRunStatus').textContent = state.runStatus;
      }
    }
    if (excelDedupe.requestId && excelDedupe.requestId === progress.requestId && progress.kind === 'excelDeduplicate') {
      const total = Math.max(1, Number(progress.total) || excelDedupeSelectedSheets().length || 1);
      const completed = Math.max(0, Number(progress.completed) || 0);
      $('#excelDeduplicateProgress').hidden = false; $('#excelDeduplicateProgress').max = total; $('#excelDeduplicateProgress').value = Math.min(total, completed);
      $('#excelDeduplicateRunStatus').textContent = progress.phase === 'verify' ? '저장된 결과를 다시 검사하고 있습니다.' : '선택한 시트의 중복 행을 정리하고 있습니다.';
    }
    if (excelCompare.requestId && excelCompare.requestId === progress.requestId && progress.kind === 'excelCompareGroup') {
      const completed = Math.max(0, Number(progress.completed) || 0); $('#excelCompareProgress').hidden = false; $('#excelCompareProgress').value = Math.min(2, completed);
      $('#excelCompareRunStatus').textContent = progress.phase === 'verify' ? '생성한 그룹 시트를 다시 검사하고 있습니다.' : '두 파일의 동일 인물을 연결하고 그룹별 시트를 만들고 있습니다.';
    }
  }

  function pageIsActive(pageId) {
    const editorActive = $('#page-documentEditor')?.classList.contains('active');
    if (pageId === 'documentEditor') return editorActive;
    if (DOCUMENT_MODE_META[pageId]) return editorActive && documentMode === pageId;
    return $(`#page-${pageId}`)?.classList.contains('active');
  }

  function certificateClipboardActive() {
    return Boolean(document.activeElement?.closest?.('#certificateDataTable, #certificateCellValue'));
  }

  function bindConverterEvents() {
    $('#choosePptxFiles').addEventListener('click', chooseConverterFiles);
    $('#choosePptxPdfOutput').addEventListener('click', chooseConverterOutput);
    $('#runPptxPdf').addEventListener('click', runConverter);
    $('#cancelPptxPdf').addEventListener('click', cancelConverter);
    $('#prepareDocumentDependencies')?.addEventListener('click', prepareConversionDependencies);
    $('#documentDependencyItems')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-document-font-action], [data-document-font-file]');
      if (button) void prepareSingleDocumentFont(button);
    });
    $('#prepareDocumentMergeDependencies')?.addEventListener('click', prepareMergeDependencies);
    $('#documentConversionSource')?.addEventListener('change', async (event) => {
      if (converter.running || converter.preparing || converter.routeChecking) { event.target.value = converter.sourceExtension; return; }
      const extension = normalizeDocumentExtension(event.target.value);
      const nextSource = extension && conversionSourceTargets[extension] ? extension : '';
      if (nextSource === converter.sourceExtension) return;
      converter.sourceExtension = nextSource;
      setConverterResultPending();
      syncLocalConversionTargets();
      renderConverterFiles(); renderConverterOutput();
      await refreshConversionTargets();
      const mismatches = conversionSourceMismatchFiles();
      if (mismatches.length) notify(`기존 목록은 유지했습니다. ${shortFormatLabel(nextSource)}가 아닌 파일 ${mismatches.length}개를 제외하거나 자동 감지로 바꿔주세요.`, 'normal');
    });
    const chooseTarget = async (button, focusAfter = false) => {
      if (!button || converter.running || converter.preparing || converter.routeChecking) return;
      const extension = normalizeDocumentExtension(button.dataset.documentTarget);
      if (!converter.targetExtensions.includes(extension) || converter.targetExtension === extension) return;
      converter.targetExtension = extension; setConverterResultPending();
      await refreshConversionTargets();
      renderConverterOutput(); renderConversionRoute();
      if (focusAfter) $(`#documentConversionTargets [data-document-target="${extension}"]`)?.focus();
    };
    $('#documentConversionTargets')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-document-target]');
      void chooseTarget(button, document.activeElement === button);
    });
    $('#documentConversionTargets')?.addEventListener('keydown', (event) => {
      const current = event.target.closest('[data-document-target]');
      if (!current || converter.running || converter.preparing || converter.routeChecking) return;
      const buttons = $$('[data-document-target]:not(:disabled)', $('#documentConversionTargets'));
      const currentIndex = buttons.indexOf(current);
      let nextIndex = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % buttons.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = buttons.length - 1;
      if (nextIndex < 0 || !buttons[nextIndex]) return;
      event.preventDefault();
      void chooseTarget(buttons[nextIndex], true);
    });
    $('#openPptxPdfOutput').addEventListener('click', () => api().openDocumentOutputDirectory(converter.outputToken).catch((error) => notify(`폴더를 열지 못했습니다: ${error.message}`, 'error')));
    $('#pptxPdfFileList').addEventListener('click', (event) => {
      const preview = event.target.closest('[data-pptx-result-preview]');
      if (preview && !converter.running) {
        if (guideDemo.active) { notify('가이드에서는 실제 결과 파일을 열지 않습니다.'); return; }
        const file = converter.files[Number(preview.dataset.pptxResultPreview)];
        if (!file?.outputFileToken) return;
        api().openDocumentOutputFile(file.outputFileToken).catch((error) => notify(`결과를 열지 못했습니다: ${error.message}`, 'error'));
        return;
      }
      const button = event.target.closest('[data-pptx-remove]'); if (!button || converter.running || converter.preparing || converter.routeChecking) return;
      converter.files.splice(Number(button.dataset.pptxRemove), 1); setConverterResultPending(); renderConverterFiles(); void refreshConversionTargets();
    });
  }

  function bindDocumentModeEvents() {
    $('#page-documentEditor').addEventListener('click', (event) => {
      // The page itself stores the active mode in data-document-mode. Restrict
      // this lookup to the actual picker buttons so clicks on list controls do
      // not get mistaken for another mode-selection click.
      const splitKindButton = event.target.closest('button[data-document-split-kind]');
      if (splitKindButton) { setDocumentSplitKind(splitKindButton.dataset.documentSplitKind); return; }
      const mergeModeButton = event.target.closest('button[data-document-merge-mode]');
      if (mergeModeButton) { setDocumentMode(mergeModeButton.dataset.documentMergeMode); return; }
      const modeButton = event.target.closest('button[data-document-mode]');
      if (modeButton) { setDocumentMode(modeButton.dataset.documentMode); return; }
      const move = event.target.closest('[data-document-merge-move]');
      if (move) {
        const index = Number(move.dataset.documentMergeIndex); moveMergeFile(index, index + (move.dataset.documentMergeMove === 'up' ? -1 : 1), move.dataset.documentMergeMove); return;
      }
      const remove = event.target.closest('[data-document-merge-remove]');
      if (remove) {
        const state = activeMergeState(); const meta = activeMergeMeta(); if (!state || !meta || state.running) return;
        state.files.splice(Number(remove.dataset.documentMergeRemove), 1); setMergeResultPending(state); resetMergeInspectionState(state);
        if (state.files.length && ['documents', 'word', 'excel'].includes(meta.kind)) {
          void inspectMergeFiles(state, meta, state.files, { forceAll: ['word', 'excel'].includes(meta.kind) });
        }
        renderMergeFiles(state, meta); return;
      }
      const splitRemove = event.target.closest('[data-document-split-remove]');
      if (splitRemove) {
        const state = activeSplitState(); const meta = activeSplitMeta();
        if (state.running || state.confirming || state.groups.length <= 1) return;
        const index = state.groups.findIndex((group) => group.id === splitRemove.dataset.documentSplitRemove);
        if (index < 0) return;
        state.groups.splice(index, 1); setSplitResultPending(state); renderSplitPlanning(state, meta, { groups: true });
        const target = state.groups[Math.min(index, state.groups.length - 1)]; if (target) $(`[data-document-split-pages="${target.id}"]`)?.focus();
      }
    });
    $('#chooseDocumentMergeFiles').addEventListener('click', chooseMergeFiles);
    $('#reverseDocumentMergeFiles').addEventListener('click', () => {
      const state = activeMergeState(); const meta = activeMergeMeta();
      if (!state || !meta || state.running || state.files.length < 2) return;
      state.files.reverse(); state.dragIndex = -1; setMergeResultPending(state); renderMergeFiles(state, meta);
      notify(meta.kind === 'excel'
        ? '파일 순서를 반대로 뒤집었습니다. 각 파일 안의 시트 순서는 유지됩니다.'
        : '파일 순서를 반대로 뒤집었습니다. 위에서 아래 순서를 확인해주세요.');
    });
    $('#clearDocumentMergeFiles').addEventListener('click', () => {
      const state = activeMergeState(); const meta = activeMergeMeta(); if (!state || !meta || state.running) return;
      state.files = [];
      if (meta.kind === 'excel') {
        state.useFileNameAsSheetName = false;
        state.addCombinedSheet = false;
        state.combinedSheetRequestedName = '전체 통합';
      }
      setMergeResultPending(state); resetMergeInspectionState(state); renderDocumentMerge();
    });
    $('#chooseDocumentMergeOutput').addEventListener('click', chooseMergeOutput);
    $('#documentMergeOutputName').addEventListener('input', () => {
      const state = activeMergeState(); const meta = activeMergeMeta(); if (!state || !meta || state.running) return;
      state.resultName = $('#documentMergeOutputName').value; setMergeResultPending(state); updateMergeReady(state, meta);
    });
    $('#documentMergeAddCombinedSheet').addEventListener('change', (event) => {
      const state = activeMergeState(); const meta = activeMergeMeta();
      if (!state || meta?.kind !== 'excel' || state.running) return;
      state.addCombinedSheet = event.currentTarget.checked === true;
      setMergeResultPending(state); renderDocumentMerge();
      notify(state.addCombinedSheet ? '결과 맨 앞에 전체 통합 시트를 추가합니다. 헤더가 다르면 시작 전에 알려드립니다.' : '전체 통합 시트 추가를 해제했습니다.');
    });
    $('#documentMergeUseFileNameAsSheetName').addEventListener('change', (event) => {
      const state = activeMergeState(); const meta = activeMergeMeta();
      if (!state || meta?.kind !== 'excel' || state.running) return;
      state.useFileNameAsSheetName = event.currentTarget.checked === true;
      setMergeResultPending(state); renderDocumentMerge();
      notify(state.useFileNameAsSheetName ? '시트가 하나뿐인 파일은 파일명으로 시트 이름을 표시합니다.' : '원본 시트 이름을 그대로 사용합니다.');
    });
    $('#documentMergeCombinedSheetName').addEventListener('input', (event) => {
      const state = activeMergeState(); const meta = activeMergeMeta();
      if (!state || meta?.kind !== 'excel' || state.running || state.addCombinedSheet !== true) return;
      state.combinedSheetRequestedName = String(event.currentTarget.value || '').slice(0, 31);
      setMergeResultPending(state); renderMergeFiles(state, meta);
    });
    $('#documentMergeCombinedSheetName').addEventListener('blur', (event) => {
      const state = activeMergeState(); const meta = activeMergeMeta();
      if (!state || meta?.kind !== 'excel' || state.running || state.addCombinedSheet !== true || String(event.currentTarget.value || '').trim()) return;
      state.combinedSheetRequestedName = '전체 통합';
      event.currentTarget.value = state.combinedSheetRequestedName;
      setMergeResultPending(state); renderMergeFiles(state, meta);
    });
    $('#runDocumentMerge').addEventListener('click', runDocumentMerge);
    $('#cancelDocumentMerge').addEventListener('click', cancelDocumentMerge);
    $('#openDocumentMergeOutput').addEventListener('click', () => {
      if (guideDemo.active) { notify('가이드에서는 실제 폴더를 열지 않습니다.'); return; }
      const state = activeMergeState(); if (!state?.outputToken) return;
      DOCUMENT_MERGE_BRIDGE.openOutput(state.outputToken).catch((error) => notify(`폴더를 열지 못했습니다: ${error.message}`, 'error'));
    });
    $('#previewDocumentMergeOutput').addEventListener('click', () => {
      if (guideDemo.active) { notify('가이드에서는 실제 결과 파일을 열지 않습니다.'); return; }
      const state = activeMergeState(); if (!state?.outputFileToken) return;
      DOCUMENT_MERGE_BRIDGE.openFile(state.outputFileToken).catch((error) => notify(`결과를 열지 못했습니다: ${error.message}`, 'error'));
    });
    $('#chooseDocumentSplitFile').addEventListener('click', chooseSplitFile);
    $('#chooseDocumentSplitOutput').addEventListener('click', chooseSplitOutput);
    $('#documentSplitMethodField').addEventListener('change', (event) => {
      const method = event.target.closest('input[name="documentSplitMethod"]')?.value;
      const state = activeSplitState(); if (!['equal', 'custom'].includes(method) || state.running || state.confirming || state.method === method) return;
      state.method = method; setSplitResultPending(state); renderDocumentSplit();
      if (method === 'custom') $(`[data-document-split-pages="${state.groups[0]?.id || ''}"]`)?.focus();
      else $('#documentSplitEqualSize').focus();
    });
    $('#documentSplitEqualSize').addEventListener('input', (event) => {
      const state = activeSplitState(); const meta = activeSplitMeta(); if (state.running || state.confirming) return;
      state.equalSize = event.target.value; setSplitResultPending(state); renderSplitPlanning(state, meta);
    });
    $('#documentSplitGroups').addEventListener('input', (event) => {
      const pageInput = event.target.closest('[data-document-split-pages]'); const nameInput = event.target.closest('[data-document-split-name]');
      const id = pageInput?.dataset.documentSplitPages || nameInput?.dataset.documentSplitName; const state = activeSplitState(); const meta = activeSplitMeta();
      if (!id || state.running || state.confirming) return;
      const group = state.groups.find((item) => item.id === id); if (!group) return;
      if (pageInput) group.pages = pageInput.value.slice(0, 2000); else group.name = nameInput.value.slice(0, 120);
      setSplitResultPending(state); renderSplitPlanning(state, meta);
    });
    $('#addDocumentSplitGroup').addEventListener('click', () => {
      const state = activeSplitState(); const meta = activeSplitMeta(); if (state.running || state.confirming) return;
      if (state.groups.length >= 500) { notify(`${splitUnitLabel(meta)} 그룹은 최대 500개까지 추가할 수 있습니다.`); return; }
      const group = createSplitGroup(); state.groups.push(group); setSplitResultPending(state); renderSplitPlanning(state, meta, { groups: true });
      $(`[data-document-split-pages="${group.id}"]`)?.focus();
    });
    $('#runDocumentSplit').addEventListener('click', runDocumentSplit);
    $('#cancelDocumentSplit').addEventListener('click', cancelDocumentSplit);
    $('#openDocumentSplitOutput').addEventListener('click', () => {
      if (guideDemo.active) { notify('가이드에서는 실제 폴더를 열지 않습니다.'); return; }
      const state = activeSplitState(); if (!state.outputToken) return;
      DOCUMENT_SPLIT_BRIDGE.openOutput(state.outputToken).catch((error) => notify(`폴더를 열지 못했습니다: ${error.message}`, 'error'));
    });
    $('#documentSplitResults').addEventListener('click', (event) => {
      const button = event.target.closest('[data-document-split-preview]'); const state = activeSplitState();
      if (!button || state.running || state.confirming) return;
      if (guideDemo.active) { notify('가이드에서는 실제 결과 파일을 열지 않습니다.'); return; }
      const result = state.results[Number(button.dataset.documentSplitPreview)]; if (!result?.outputFileToken) return;
      DOCUMENT_SPLIT_BRIDGE.openFile(result.outputFileToken).catch((error) => notify(`결과를 열지 못했습니다: ${error.message}`, 'error'));
    });
    $('#chooseExcelDeduplicateFile').addEventListener('click', chooseExcelDedupeFile);
    $('#chooseExcelDeduplicateOutput').addEventListener('click', chooseExcelDedupeOutput);
    $('#excelDeduplicateOutputName').addEventListener('input', (event) => {
      if (excelDedupe.running) return;
      excelDedupe.resultName = String(event.target.value || '').slice(0, 120); resetExcelDedupeResult(); renderExcelDeduplicate();
      event.target.focus(); event.target.setSelectionRange(event.target.value.length, event.target.value.length);
    });
    $('#excelDeduplicateCriteriaMode').addEventListener('change', (event) => {
      const input = event.target.closest('input[name="excelDeduplicateCriteriaMode"]');
      if (!input || excelDedupe.running || excelDedupe.analyzing || excelDedupe.criteriaAnalyzing) return;
      excelDedupe.criteriaMode = input.value === 'columns' ? 'columns' : 'all';
      if (excelDedupe.criteriaMode === 'columns') { excelDedupe.columnIndexesBySheet = {}; excelDedupe.selectedSheetIndexes = []; }
      resetExcelDedupeReview({ close: true });
      queueExcelDedupeCriteriaAnalysis();
    });
    $('#excelDedupeColumnSheetSelect').addEventListener('change', (event) => {
      if (excelDedupe.running || excelDedupe.criteriaAnalyzing) return;
      excelDedupe.activeColumnSheetIndex = Number(event.target.value); renderExcelDeduplicate();
    });
    $('#excelDedupeColumnPickerList').addEventListener('change', (event) => {
      const input = event.target.closest('[data-excel-dedupe-picker-column]'); if (!input || excelDedupe.running || excelDedupe.criteriaAnalyzing) return;
      const sheetIndex = Number(excelDedupe.activeColumnSheetIndex); const columnIndex = Number(input.dataset.excelDedupePickerColumn); const chosen = new Set(excelDedupeColumnsForSheet(sheetIndex));
      if (input.checked) chosen.add(columnIndex); else chosen.delete(columnIndex);
      excelDedupe.columnIndexesBySheet[String(sheetIndex)] = [...chosen].sort((left, right) => left - right);
      if (!chosen.size) excelDedupe.selectedSheetIndexes = excelDedupe.selectedSheetIndexes.map(Number).filter((index) => index !== sheetIndex);
      resetExcelDedupeReview({ close: true }); excelDedupe.activeColumnSheetIndex = sheetIndex; queueExcelDedupeCriteriaAnalysis(sheetIndex);
    });
    $('#selectAllExcelDedupeColumns').addEventListener('click', () => {
      if (excelDedupe.running || excelDedupe.criteriaAnalyzing) return;
      const sheetIndex = Number(excelDedupe.activeColumnSheetIndex); const sheet = excelDedupe.file?.sheets?.find((item) => Number(item.index) === sheetIndex);
      excelDedupe.columnIndexesBySheet[String(sheetIndex)] = excelDedupeAvailableColumns(sheet).map((column) => Number(column.index));
      resetExcelDedupeReview({ close: true }); excelDedupe.activeColumnSheetIndex = sheetIndex; queueExcelDedupeCriteriaAnalysis(sheetIndex);
    });
    $('#applyExcelDedupeColumnsToAllSheets').addEventListener('click', () => {
      if (excelDedupe.running || excelDedupe.criteriaAnalyzing) return;
      const sheetIndex = Number(excelDedupe.activeColumnSheetIndex); const chosen = excelDedupeColumnsForSheet(sheetIndex);
      if (!chosen.length) return;
      const sheets = excelDedupe.file?.sheets || []; let applied = 0; let skipped = 0;
      sheets.forEach((sheet) => {
        const available = new Set(excelDedupeAvailableColumns(sheet).map((column) => Number(column.index)));
        if (chosen.every((columnIndex) => available.has(columnIndex))) {
          excelDedupe.columnIndexesBySheet[String(sheet.index)] = chosen.slice(); applied += 1;
        } else skipped += 1;
      });
      resetExcelDedupeReview({ close: true }); excelDedupe.activeColumnSheetIndex = sheetIndex;
      queueExcelDedupeCriteriaAnalysis(null, { selectAllAfterAnalysis: true });
      notify(`${applied}개 시트에 ${chosen.map((index) => columnName(index - 1)).join('+')} 기준을 적용해 분석합니다.${skipped ? ` 해당 열이 없는 ${skipped}개 시트는 제외했습니다.` : ''}`);
    });
    $('#clearExcelDedupeColumns').addEventListener('click', () => {
      if (excelDedupe.running || excelDedupe.criteriaAnalyzing) return;
      const sheetIndex = Number(excelDedupe.activeColumnSheetIndex); excelDedupe.columnIndexesBySheet[String(sheetIndex)] = [];
      excelDedupe.selectedSheetIndexes = excelDedupe.selectedSheetIndexes.map(Number).filter((index) => index !== sheetIndex);
      resetExcelDedupeReview({ close: true }); excelDedupe.activeColumnSheetIndex = sheetIndex; queueExcelDedupeCriteriaAnalysis();
    });
    $('#excelDeduplicateSheetList').addEventListener('change', (event) => {
      const column = event.target.closest('[data-excel-dedupe-column]');
      if (column && !excelDedupe.running && !excelDedupe.criteriaAnalyzing) {
        const sheetIndex = Number(column.dataset.excelDedupeColumnSheet); const columnIndex = Number(column.dataset.excelDedupeColumn);
        const chosen = new Set(excelDedupeColumnsForSheet(sheetIndex));
        if (column.checked) chosen.add(columnIndex); else chosen.delete(columnIndex);
        excelDedupe.columnIndexesBySheet[String(sheetIndex)] = [...chosen].sort((left, right) => left - right);
        if (!chosen.size) excelDedupe.selectedSheetIndexes = excelDedupe.selectedSheetIndexes.map(Number).filter((index) => index !== sheetIndex);
        resetExcelDedupeReview({ close: true });
        queueExcelDedupeCriteriaAnalysis(sheetIndex); return;
      }
      const checkbox = event.target.closest('[data-excel-dedupe-sheet]'); if (!checkbox || excelDedupe.running) return;
      const index = Number(checkbox.dataset.excelDedupeSheet); const selected = new Set(excelDedupe.selectedSheetIndexes.map(Number));
      if (checkbox.checked) selected.add(index); else selected.delete(index);
      excelDedupe.selectedSheetIndexes = [...selected]; resetExcelDedupeResult(); renderExcelDeduplicate();
    });
    $('#excelDeduplicateSheetList').addEventListener('click', (event) => {
      const openPicker = event.target.closest('[data-excel-dedupe-open-column-picker]');
      if (openPicker && !excelDedupe.running && !excelDedupe.criteriaAnalyzing) {
        excelDedupe.activeColumnSheetIndex = Number(openPicker.dataset.excelDedupeOpenColumnPicker); renderExcelDeduplicate(); $('#excelDedupeColumnPicker')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return;
      }
      const review = event.target.closest('[data-excel-dedupe-review]');
      if (review && !excelDedupe.running && !excelDedupe.criteriaAnalyzing && !excelDedupe.criteriaDirty) { openExcelDedupeReview(Number(review.dataset.excelDedupeReview)); return; }
      const all = event.target.closest('[data-excel-dedupe-columns-all]'); const clear = event.target.closest('[data-excel-dedupe-columns-clear]');
      if ((!all && !clear) || excelDedupe.running || excelDedupe.criteriaAnalyzing) return;
      const sheetIndex = Number((all || clear).dataset[all ? 'excelDedupeColumnsAll' : 'excelDedupeColumnsClear']);
      const sheet = excelDedupe.file?.sheets?.find((item) => Number(item.index) === sheetIndex);
      excelDedupe.columnIndexesBySheet[String(sheetIndex)] = all ? (sheet?.columns || []).map((column) => Number(column.index)) : [];
      if (clear) excelDedupe.selectedSheetIndexes = excelDedupe.selectedSheetIndexes.map(Number).filter((index) => index !== sheetIndex);
      resetExcelDedupeReview({ close: true });
      queueExcelDedupeCriteriaAnalysis(all ? sheetIndex : null);
    });
    $('#selectAllExcelDuplicateSheets').addEventListener('click', () => {
      if (excelDedupe.running) return;
      excelDedupe.selectedSheetIndexes = (excelDedupe.file?.sheets || []).filter((sheet) => excelDedupeSheetDuplicateCount(sheet) > 0).map((sheet) => Number(sheet.index)); resetExcelDedupeResult(); renderExcelDeduplicate();
    });
    $('#clearExcelDuplicateSheets').addEventListener('click', () => { if (!excelDedupe.running) { excelDedupe.selectedSheetIndexes = []; resetExcelDedupeResult(); renderExcelDeduplicate(); } });
    $('#runExcelDeduplicate').addEventListener('click', runExcelDedupe);
    $('#closeExcelDedupeReview').addEventListener('click', () => $('#excelDedupeReviewDialog').close());
    $('#finishExcelDedupeReview').addEventListener('click', () => $('#excelDedupeReviewDialog').close());
    $('#previousExcelDedupeReviewGroup').addEventListener('click', () => moveExcelDedupeReviewGroup(-1));
    $('#nextExcelDedupeReviewGroup').addEventListener('click', () => moveExcelDedupeReviewGroup(1));
    $('#excelDedupeMergeMissing').addEventListener('change', (event) => { excelDedupe.mergeMissingValues = Boolean(event.target.checked); renderExcelDedupeReview(); });
    $('#excelDedupeReviewGroupList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-excel-dedupe-review-group]'); if (!button) return;
      excelDedupe.activeReviewGroupId = button.dataset.excelDedupeReviewGroup; renderExcelDedupeReview();
    });
    $('#excelDedupeReviewTable').addEventListener('change', (event) => {
      const radio = event.target.closest('[data-excel-dedupe-preferred-row]'); if (!radio) return;
      const groupId = radio.dataset.excelDedupePreferredRow; excelDedupe.preferredRowsByGroup[groupId] = Number(radio.value); markExcelDedupeGroupReviewed(groupId); renderExcelDedupeReview();
    });
    $('#excelDedupeConflictChoices').addEventListener('change', (event) => {
      const approval = event.target.closest('[data-excel-dedupe-approve-group]');
      if (approval) {
        const groupId = String(approval.dataset.excelDedupeApproveGroup || ''); const approved = new Set(excelDedupe.approvedGroupIds);
        if (approval.checked) approved.add(groupId); else approved.delete(groupId);
        excelDedupe.approvedGroupIds = [...approved]; markExcelDedupeGroupReviewed(groupId); renderExcelDedupeReview(); return;
      }
      const input = event.target.closest('[data-excel-dedupe-final-value]'); if (!input) return;
      const groupId = String(input.dataset.excelDedupeConflictGroup || ''); const columnIndex = String(input.dataset.excelDedupeFinalValue || '');
      excelDedupe.customValuesByGroup[groupId] = { ...(excelDedupe.customValuesByGroup[groupId] || {}), [columnIndex]: String(input.value ?? '') };
      markExcelDedupeGroupReviewed(groupId);
    });
    $('#previewExcelDeduplicateOutput').addEventListener('click', () => {
      if (excelDedupe.result?.outputFileToken) api().openDocumentOutputFile(excelDedupe.result.outputFileToken).catch((error) => notify(`결과 파일을 열지 못했습니다: ${error.message}`, 'error'));
    });
    $('#openExcelDeduplicateOutput').addEventListener('click', () => {
      if (excelDedupe.outputToken) api().openDocumentOutputDirectory(excelDedupe.outputToken).catch((error) => notify(`폴더를 열지 못했습니다: ${error.message}`, 'error'));
    });
    $('.excel-cleanup-task-switch').addEventListener('click', (event) => {
      const button = event.target.closest('[data-excel-cleanup-task]'); if (!button || anyDocumentOperationActive()) return;
      excelCleanupTask = button.dataset.excelCleanupTask === 'compare' ? 'compare' : 'deduplicate';
      if (excelCleanupTask === 'compare') renderExcelCompare(); else renderExcelDeduplicate();
    });
    $('#chooseExcelCompareA').addEventListener('click', () => chooseExcelCompareFile('a'));
    $('#chooseExcelCompareB').addEventListener('click', () => chooseExcelCompareFile('b'));
    for (const side of ['a', 'b']) {
      const upper = side.toUpperCase();
      $(`#excelCompare${upper}Sheet`).addEventListener('change', (event) => {
        if (excelCompare.running || excelCompare.analyzing) return;
        const sheet = excelCompare.files[side]?.sheets?.find((item) => Number(item.index) === Number(event.target.value)); if (!sheet) return;
        const header = sheet.headerCandidates?.find((item) => Number(item.row) === Number(sheet.headerRow));
        excelCompare.selections[side] = { sheetIndex: Number(sheet.index), headerRow: Number(sheet.headerRow) || 1, keyColumn: Number(header?.columns?.[0]?.index || sheet.columns?.[0]?.index) || 0 };
        excelCompare.rules.forEach((rule) => { if (rule.source === side) rule.columnIndex = Number(excelCompareColumns(side)[0]?.index) || 0; });
        invalidateExcelComparePlan(); renderExcelCompare();
      });
      $(`#excelCompare${upper}Header`).addEventListener('change', (event) => {
        if (excelCompare.running || excelCompare.analyzing) return;
        excelCompare.selections[side].headerRow = Number(event.target.value); const columns = excelCompareColumns(side);
        if (!columns.some((item) => Number(item.index) === Number(excelCompare.selections[side].keyColumn))) excelCompare.selections[side].keyColumn = Number(columns[0]?.index) || 0;
        excelCompare.rules.forEach((rule) => { if (rule.source === side && !columns.some((item) => Number(item.index) === Number(rule.columnIndex))) rule.columnIndex = Number(columns[0]?.index) || 0; });
        invalidateExcelComparePlan(); renderExcelCompare();
      });
      $(`#excelCompare${upper}Key`).addEventListener('change', (event) => { if (!excelCompare.running && !excelCompare.analyzing) { excelCompare.selections[side].keyColumn = Number(event.target.value); invalidateExcelComparePlan(); updateExcelCompareReady(); } });
    }
    $('#excelCompareRuleList').addEventListener('input', (event) => {
      const field = event.target.closest('[data-excel-compare-rule-field]'); const row = field?.closest('[data-excel-compare-rule]'); if (!field || !row || excelCompare.running || excelCompare.analyzing) return;
      const rule = excelCompare.rules.find((item) => item.id === row.dataset.excelCompareRule); if (!rule) return;
      const name = field.dataset.excelCompareRuleField; rule[name] = name === 'columnIndex' ? Number(field.value) : String(field.value || ''); invalidateExcelComparePlan(); updateExcelCompareReady();
    });
    $('#excelCompareRuleList').addEventListener('change', (event) => {
      const field = event.target.closest('[data-excel-compare-rule-field]'); const row = field?.closest('[data-excel-compare-rule]'); if (!field || !row || excelCompare.running || excelCompare.analyzing) return;
      const rule = excelCompare.rules.find((item) => item.id === row.dataset.excelCompareRule); if (!rule) return;
      const name = field.dataset.excelCompareRuleField; rule[name] = name === 'columnIndex' ? Number(field.value) : String(field.value || '');
      if (name === 'source' && rule.source !== 'key') rule.columnIndex = Number(excelCompareColumns(rule.source)[0]?.index) || 0;
      invalidateExcelComparePlan(); renderExcelCompareRules(); updateExcelCompareReady();
    });
    $('#excelCompareRuleList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-excel-compare-rule]'); if (!button || excelCompare.running || excelCompare.analyzing) return;
      excelCompare.rules = excelCompare.rules.filter((rule) => rule.id !== button.dataset.removeExcelCompareRule); invalidateExcelComparePlan(); renderExcelCompare();
    });
    $('#addExcelCompareRule').addEventListener('click', () => { if (!excelCompare.running && !excelCompare.analyzing && excelCompare.rules.length < 100) { excelCompare.rules.push(createExcelCompareRule()); invalidateExcelComparePlan(); renderExcelCompare(); } });
    $('#analyzeExcelCompare').addEventListener('click', analyzeExcelCompare);
    $('#chooseExcelCompareOutput').addEventListener('click', chooseExcelCompareOutput);
    $('#excelCompareOutputName').addEventListener('input', (event) => { if (!excelCompare.running) { excelCompare.resultName = String(event.target.value || '').slice(0, 120); excelCompare.completed = false; excelCompare.result = null; updateExcelCompareReady(); } });
    $('#runExcelCompare').addEventListener('click', runExcelCompare);
    $('#previewExcelCompareOutput').addEventListener('click', () => { if (excelCompare.result?.outputFileToken) api().openDocumentOutputFile(excelCompare.result.outputFileToken).catch((error) => notify(`결과 파일을 열지 못했습니다: ${error.message}`, 'error')); });
    $('#openExcelCompareOutput').addEventListener('click', () => { if (excelCompare.outputToken) api().openDocumentOutputDirectory(excelCompare.outputToken).catch((error) => notify(`폴더를 열지 못했습니다: ${error.message}`, 'error')); });
    const bindTablistKeyboard = (container, selector, activate) => {
      container.addEventListener('keydown', (event) => {
        const current = event.target.closest(selector); if (!current) return;
        const buttons = $$(selector, container).filter((button) => !button.disabled); const index = buttons.indexOf(current); let next = -1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        if (next < 0 || !buttons[next]) return;
        event.preventDefault(); const activated = activate(buttons[next]); (activated === false ? current : buttons[next]).focus();
      });
    };
    bindTablistKeyboard($('.document-mode-picker'), 'button[data-document-mode]', (button) => setDocumentMode(button.dataset.documentMode));
    bindTablistKeyboard($('#documentMergeModeSwitch'), 'button[data-document-merge-mode]', (button) => setDocumentMode(button.dataset.documentMergeMode));
    bindTablistKeyboard($('#documentSplitModeSwitch'), 'button[data-document-split-kind]', (button) => setDocumentSplitKind(button.dataset.documentSplitKind));
    bindTablistKeyboard($('.excel-cleanup-task-switch'), 'button[data-excel-cleanup-task]', (button) => { if (anyDocumentOperationActive()) return false; excelCleanupTask = button.dataset.excelCleanupTask === 'compare' ? 'compare' : 'deduplicate'; if (excelCleanupTask === 'compare') renderExcelCompare(); else renderExcelDeduplicate(); return true; });
    const list = $('#documentMergeFileList');
    list.addEventListener('dragstart', (event) => {
      const handle = event.target.closest('[data-document-merge-drag-handle]');
      const row = handle?.closest('li[data-document-merge-index]'); const state = activeMergeState();
      if (!handle || !row || !state || state.running) { event.preventDefault(); return; }
      state.dragIndex = Number(row.dataset.documentMergeIndex); row.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(state.dragIndex));
    });
    list.addEventListener('dragover', (event) => {
      const row = event.target.closest('li[data-document-merge-index]'); const state = activeMergeState(); if (!row || !state || state.dragIndex < 0) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      $$('.drag-over', list).forEach((item) => item.classList.remove('drag-over')); row.classList.add('drag-over');
    });
    list.addEventListener('drop', (event) => {
      const row = event.target.closest('li[data-document-merge-index]'); const state = activeMergeState(); if (!row || !state) return;
      event.preventDefault(); const from = state.dragIndex >= 0 ? state.dragIndex : Number(event.dataTransfer.getData('text/plain')); const to = Number(row.dataset.documentMergeIndex);
      state.dragIndex = -1; moveMergeFile(from, to);
    });
    list.addEventListener('dragend', () => {
      const state = activeMergeState(); if (state) state.dragIndex = -1;
      $$('.dragging, .drag-over', list).forEach((item) => item.classList.remove('dragging', 'drag-over'));
    });
  }

  function bindCertificateGridEvents() {
    const table = $('#certificateDataTable');
    table.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || certificate.running) return;
      const cell = event.target.closest('td[data-certificate-row]'); if (!cell) return;
      const row = Number(cell.dataset.certificateRow); const col = Number(cell.dataset.certificateCol);
      certificate.dragging = true; certificate.preserveSelectionOnFocus = event.shiftKey; setSelection(row, col, event.shiftKey);
      if (event.shiftKey) {
        event.preventDefault();
        const input = $('input', cell); input?.focus({ preventScroll: true }); certificate.preserveSelectionOnFocus = false;
      }
    });
    globalThis.addEventListener('mousemove', (event) => {
      if (!certificate.dragging || !(event.buttons & 1)) return;
      const target = certificatePointerTarget(event, table); const cell = target?.closest?.('td[data-certificate-row]'); if (!cell) return;
      const row = Number(cell.dataset.certificateRow); const col = Number(cell.dataset.certificateCol);
      if (row === certificate.selection.focusRow && col === certificate.selection.focusCol) return;
      table.classList.add('range-selecting'); event.preventDefault(); setSelection(row, col, true);
    }, true);
    table.addEventListener('dragstart', (event) => { if (certificate.dragging && event.target.closest('input')) event.preventDefault(); });
    table.addEventListener('contextmenu', (event) => {
      const rowHeader = event.target.closest('[data-certificate-row-select]');
      if (rowHeader) {
        const row = Number(rowHeader.dataset.certificateRowSelect);
        certificate.selection = { anchorRow: row, focusRow: row, anchorCol: 0, focusCol: Math.max(0, certificate.fields.length - 1) }; updateCertificateSelection();
        openCertificateContextMenu(event, row, 0); return;
      }
      const cell = event.target.closest('td[data-certificate-row]'); if (!cell) return;
      openCertificateContextMenu(event, Number(cell.dataset.certificateRow), Number(cell.dataset.certificateCol));
    });
    table.addEventListener('focusin', (event) => {
      const input = event.target.closest('[data-certificate-cell]'); if (!input) return;
      if (!certificate.preserveSelectionOnFocus) setSelection(Number(input.dataset.certificateRow), Number(input.dataset.certificateCol), false);
      certificate.preserveSelectionOnFocus = false; certificate.editBaseline = snapshotRows();
    });
    table.addEventListener('input', (event) => {
      const input = event.target.closest('[data-certificate-cell]'); if (!input) return;
      const row = Number(input.dataset.certificateRow); const col = Number(input.dataset.certificateCol); const value = input.value.slice(0, 4000); if (input.value !== value) input.value = value; certificate.rows[row].values[col] = value;
      $('#certificateCellValue').value = value; invalidateActualCertificatePreview(); updateCertificateRowSummary(); updateCertificateReady();
    });
    table.addEventListener('focusout', (event) => {
      if (!event.target.matches('[data-certificate-cell]') || !certificate.editBaseline) return;
      commitCertificateEditBaseline(); updateCertificateRowSummary(); updateCertificateReady();
    });
    table.addEventListener('click', (event) => {
      const selectAll = event.target.closest('[data-certificate-select-all]');
      if (selectAll) {
        certificate.selection = { anchorRow: 0, focusRow: Math.max(0, certificate.rows.length - 1), anchorCol: 0, focusCol: Math.max(0, certificate.fields.length - 1) }; updateCertificateSelection(); selectAll.focus({ preventScroll: true }); return;
      }
      const columnHeader = event.target.closest('[data-certificate-column-select]');
      if (columnHeader) {
        const col = Number(columnHeader.dataset.certificateColumnSelect); const anchorCol = event.shiftKey ? certificate.selection.anchorCol : col;
        certificate.selection = { anchorRow: 0, focusRow: Math.max(0, certificate.rows.length - 1), anchorCol, focusCol: col }; updateCertificateSelection(); columnHeader.focus({ preventScroll: true }); return;
      }
      const rowHeader = event.target.closest('[data-certificate-row-select]'); if (!rowHeader) return;
      const row = Number(rowHeader.dataset.certificateRowSelect); const anchorRow = event.shiftKey ? certificate.selection.anchorRow : row;
      certificate.selection = { anchorRow, focusRow: row, anchorCol: 0, focusCol: Math.max(0, certificate.fields.length - 1) }; updateCertificateSelection(); rowHeader.focus({ preventScroll: true });
    });
    table.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.target.matches('input')) {
        event.preventDefault(); certificate.selection = { anchorRow: 0, focusRow: Math.max(0, certificate.rows.length - 1), anchorCol: 0, focusCol: Math.max(0, certificate.fields.length - 1) }; updateCertificateSelection(); return;
      }
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation(); if (event.key.toLowerCase() === 'z' && !event.shiftKey) undoCertificateGrid(); else redoCertificateGrid(); return;
      }
      const selectAll = event.target.closest('[data-certificate-select-all]');
      if (selectAll && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); certificate.selection = { anchorRow: 0, focusRow: Math.max(0, certificate.rows.length - 1), anchorCol: 0, focusCol: Math.max(0, certificate.fields.length - 1) }; updateCertificateSelection(); return;
      }
      const columnHeader = event.target.closest('[data-certificate-column-select]');
      if (columnHeader && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); const col = Number(columnHeader.dataset.certificateColumnSelect); certificate.selection = { anchorRow: 0, focusRow: Math.max(0, certificate.rows.length - 1), anchorCol: col, focusCol: col }; updateCertificateSelection(); return;
      }
      const rowHeader = event.target.closest('[data-certificate-row-select]');
      if (rowHeader && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); const row = Number(rowHeader.dataset.certificateRowSelect); certificate.selection = { anchorRow: row, focusRow: row, anchorCol: 0, focusCol: Math.max(0, certificate.fields.length - 1) }; updateCertificateSelection(); return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.target.matches('input')) { event.preventDefault(); commitCertificateEditBaseline(); clearCertificateSelection(); return; }
      const cell = event.target.closest('td[data-certificate-row]'); if (!cell) return;
      const movement = { Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
      if (movement && (event.key === 'Enter' || event.key === 'Tab' || event.altKey)) {
        event.preventDefault(); let row = certificate.selection.focusRow + movement[0]; let col = certificate.selection.focusCol + movement[1];
        if (event.key === 'Tab' && col >= certificate.fields.length) { col = 0; row += 1; }
        if (event.key === 'Tab' && col < 0) { col = certificate.fields.length - 1; row -= 1; }
        focusCertificateCell(row, col, event.altKey && event.shiftKey); return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const input = event.target.matches('input') ? event.target : null;
        const hasTextSelection = input && typeof input.selectionStart === 'number' && input.selectionStart !== input.selectionEnd;
        const clearWholeSelection = certificateSelectionIsRange() || !input || (event.key === 'Delete' && !hasTextSelection);
        if (clearWholeSelection) { event.preventDefault(); commitCertificateEditBaseline(); clearCertificateSelection(); }
      }
    });
    globalThis.addEventListener('mouseup', () => { certificate.dragging = false; table.classList.remove('range-selecting'); });
    globalThis.addEventListener('blur', () => { certificate.dragging = false; table.classList.remove('range-selecting'); });
    document.addEventListener('copy', (event) => {
      if (!pageIsActive('certificateMaker') || !certificateClipboardActive() || !certificate.fields.length || !event.clipboardData || certificateShouldUseNativeClipboard(event)) return;
      event.preventDefault(); event.clipboardData.setData('text/plain', copyCertificateSelection(false));
    });
    document.addEventListener('cut', (event) => {
      if (certificate.running || !pageIsActive('certificateMaker') || !certificateClipboardActive() || !certificate.fields.length || !event.clipboardData || certificateShouldUseNativeClipboard(event)) return;
      event.preventDefault(); event.clipboardData.setData('text/plain', copyCertificateSelection(true));
    });
    document.addEventListener('paste', (event) => {
      if (certificate.running || !pageIsActive('certificateMaker') || !certificateClipboardActive() || !certificate.fields.length || !event.clipboardData) return;
      const text = event.clipboardData.getData('text/plain'); if (text === '') return;
      if (certificateShouldUseNativePaste(event, text)) return;
      event.preventDefault(); pasteCertificateCells(text);
    });
    $('#certificateCellValue').addEventListener('focus', () => { certificate.editBaseline = snapshotRows(); });
    $('#certificateCellValue').addEventListener('input', (event) => {
      const { focusRow, focusCol } = certificate.selection; const value = event.target.value.slice(0, 4000); if (event.target.value !== value) event.target.value = value; certificate.rows[focusRow].values[focusCol] = value;
      const input = $(`#certificateDataTable input[data-certificate-row="${focusRow}"][data-certificate-col="${focusCol}"]`); if (input) input.value = value; invalidateActualCertificatePreview(); updateCertificateRowSummary(); updateCertificateReady();
    });
    $('#certificateCellValue').addEventListener('blur', () => {
      commitCertificateEditBaseline(); updateCertificateRowSummary(); updateCertificateReady();
    });
  }

  function bindCertificateEvents() {
    const contextMenu = $('#certificateContextMenu');
    const previewStage = $('#certificatePreviewStage');
    const previewViewport = $('#certificatePreviewViewport');
    const previewImage = $('#certificatePreviewImage');
    if (!contextMenu.querySelector('[data-certificate-context="copy"]')) {
      const copy = element('button'); copy.type = 'button'; copy.dataset.certificateContext = 'copy'; copy.setAttribute('role', 'menuitem'); copy.append(element('span', '', '선택 범위 복사'), element('kbd', '', 'Ctrl+C'));
      const cut = element('button'); cut.type = 'button'; cut.dataset.certificateContext = 'cut'; cut.setAttribute('role', 'menuitem'); cut.append(element('span', '', '선택 범위 잘라내기'), element('kbd', '', 'Ctrl+X'));
      const separator = element('div', 'sheet-context-separator'); separator.setAttribute('role', 'separator'); contextMenu.prepend(copy, cut, separator);
    }
    $('#chooseCertificateTemplate').addEventListener('click', chooseCertificateTemplate);
    $('#prepareCertificateDependencies')?.addEventListener('click', prepareCertificateDependencies);
    $('#certificateDependencyItems')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-document-font-action], [data-document-font-file]');
      if (button) void prepareSingleDocumentFont(button);
    });
    $('#certificateProfileList').addEventListener('click', (event) => {
      const open = event.target.closest('[data-certificate-profile-open]'); if (open) { void openCertificateProfile(open.dataset.certificateProfileOpen); return; }
      const remove = event.target.closest('[data-certificate-profile-delete]'); if (remove) void deleteCertificateProfile(remove.dataset.certificateProfileDelete);
    });
    $('#certificateSlideRail').addEventListener('click', (event) => {
      const page = event.target.closest('[data-certificate-slide]'); if (page) void switchCertificateSlide(Number(page.dataset.certificateSlide), { focusViewport: true });
    });
    $('#certificateBlockOverlay').addEventListener('click', (event) => {
      const block = event.target.closest('[data-certificate-block]'); if (!block) return;
      if (guideDemo.active) toggleCertificateBlock(block.dataset.certificateBlock);
      else openCertificateTextRange(block.dataset.certificateBlock);
    });
    previewImage.addEventListener('load', scheduleCertificateOverlayBounds);
    previewImage.addEventListener('error', () => { $('#certificateBlockOverlay').dataset.boundsReady = 'false'; });
    if (typeof ResizeObserver === 'function') {
      certificateOverlayResizeObserver = new ResizeObserver(scheduleCertificateOverlayBounds);
      certificateOverlayResizeObserver.observe(previewViewport);
    }
    $('#certificateFieldList').addEventListener('input', (event) => {
      const input = event.target.closest('[data-certificate-field-label]'); if (!input) return;
      const index = Number(input.dataset.certificateFieldLabel); certificate.fields[index].label = input.value.slice(0, 80) || `항목 ${index + 1}`; renderFilenameFields(); renderCertificateGrid();
    });
    $('#certificateFieldList').addEventListener('click', (event) => {
      const remove = event.target.closest('[data-certificate-field-remove]'); if (!remove) return;
      removeCertificateField(Number(remove.dataset.certificateFieldRemove));
    });
    const rangeSource = $('#certificateTextRangeSource');
    ['select', 'mouseup', 'keyup'].forEach((eventName) => rangeSource.addEventListener(eventName, updateCertificateTextRangeSelection));
    $('#applyCertificateTextRange').addEventListener('click', () => addCertificateTextRange());
    $('#applyCertificateWholeBlock').addEventListener('click', () => addCertificateTextRange({ whole: true }));
    $$('[data-close-certificate-text-range]').forEach((button) => button.addEventListener('click', () => $('#certificateTextRangeDialog').close?.()));
    $('#clearCertificateFields').addEventListener('click', async () => {
      if (certificate.running || !certificate.fields.length) return;
      if (hasCertificateData() && !await confirmAction('선택한 글자를 모두 지우면 현재 표의 정보도 사라집니다. 계속할까요?', { title: '글자 선택 지우기', action: '모두 지우기' })) return;
      const previous = certificate.fields; certificate.fields = []; certificate.rosterImport = null; updateRowsForFieldChange(previous); restoreTemplatePreview(); renderCertificateFields(); renderCertificateOverlay(); renderCertificateGrid(); updateCertificateReady();
    });
    $('#certificateSlideSelect').addEventListener('change', (event) => { void switchCertificateSlide(Number(event.target.value)); });
    const moveCertificateSlide = (offset) => {
      const slides = certificate.template?.slides || []; const index = slides.findIndex((slide) => slide.number === certificate.slideNumber);
      const target = slides[index + offset]; if (target) void switchCertificateSlide(target.number, { focusViewport: true });
    };
    $('#previousCertificateSlide').addEventListener('click', () => moveCertificateSlide(-1));
    $('#nextCertificateSlide').addEventListener('click', () => moveCertificateSlide(1));
    $('#toggleCertificateHiddenBlocks').addEventListener('click', () => {
      certificate.showHiddenBlocks = !certificate.showHiddenBlocks; renderCertificateOverlay(); updateCertificateSlideNavigation();
    });
    previewViewport.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); moveCertificateSlide(-1); }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); moveCertificateSlide(1); }
    });
    $('#saveCertificateProfile').addEventListener('click', saveCertificateProfile);
    $('#showCertificateTemplatePreview').addEventListener('click', restoreTemplatePreview);
    $('#importCertificateRoster').addEventListener('click', openCertificateRosterPicker);
    $('#importCertificateData').addEventListener('click', importCertificateData);
    $('#certificateRosterSourceList').addEventListener('click', (event) => { const source = event.target.closest('[data-certificate-roster-source]'); if (source && !source.disabled) selectCertificateRosterSource(source.dataset.certificateRosterSource); });
    $('#certificateRosterMappingList').addEventListener('change', (event) => {
      const select = event.target.closest('[data-certificate-roster-mapping]'); if (!select) return;
      rosterPicker.mappings[Number(select.dataset.certificateRosterMapping)] = select.value; updateCertificateRosterMappingMeta(); void loadCertificateRosterPreview();
    });
    $('#backToCertificateRosterSources').addEventListener('click', () => { rosterPicker.sequence += 1; rosterPicker.selected = null; rosterPicker.rows = []; $('#certificateRosterSourceStep').hidden = false; $('#certificateRosterMappingStep').hidden = true; $('#applyCertificateRoster').hidden = true; });
    $('#applyCertificateRoster').addEventListener('click', applyCertificateRoster);
    $('#addCertificateRow').addEventListener('click', () => insertCertificateRow(certificate.rows.length));
    $('#certificateUndo').addEventListener('click', undoCertificateGrid); $('#certificateRedo').addEventListener('click', redoCertificateGrid);
    $('#previousCertificateRow').addEventListener('click', () => { setSelection(Math.max(0, certificate.currentRow - 1), 0); });
    $('#nextCertificateRow').addEventListener('click', () => { setSelection(Math.min(certificate.rows.length - 1, certificate.currentRow + 1), 0); });
    $('#previewCertificateRow').addEventListener('click', previewCurrentCertificateRow);
    $('#chooseCertificateOutput').addEventListener('click', chooseCertificateOutput);
    $('#certificateFilenameTemplate').addEventListener('input', (event) => {
      certificate.filenameTemplate = event.target.value.slice(0, 160); renderCertificateFilenamePreview(); updateCertificateReady();
    });
    $('#certificateFilenameVariables').addEventListener('click', (event) => {
      const button = event.target.closest('[data-certificate-filename-token]'); if (button && !button.disabled) insertCertificateFilenameToken(button.dataset.certificateFilenameToken);
    });
    $('#certificateOutputPdf').addEventListener('change', updateCertificateReady); $('#certificateOutputPptx').addEventListener('change', updateCertificateReady);
    $('#generateCertificates').addEventListener('click', generateCertificates);
    $('#cancelCertificates').addEventListener('click', cancelCertificateGeneration);
    $('#openCertificateOutput').addEventListener('click', () => api().openDocumentOutputDirectory(certificate.outputToken).catch((error) => notify(`폴더를 열지 못했습니다: ${error.message}`, 'error')));
    $('#certificateContextMenu').addEventListener('click', (event) => {
      const control = event.target.closest('[data-certificate-context]'); const action = control?.dataset.certificateContext; if (!action || control.disabled) return;
      const bounds = selectionBounds(); closeCertificateContextMenu({ restoreFocus: true });
      if (action === 'copy' || action === 'cut') { document.execCommand(action); return; }
      if (action === 'insert-above') insertCertificateRow(bounds.top);
      if (action === 'insert-below') insertCertificateRow(bounds.bottom + 1);
      if (action === 'clear') clearCertificateSelection();
      if (action === 'fill-down') fillCertificateDown();
      if (action === 'delete-row') deleteCertificateRows();
    });
    $('#certificateContextMenu').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeCertificateContextMenu({ restoreFocus: true }); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = $$('button:not(:disabled)', $('#certificateContextMenu')); if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement); let index = current;
      if (event.key === 'Home') index = 0; else if (event.key === 'End') index = buttons.length - 1; else index = (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[index].focus();
    });
    $('#certificateCellValue').addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); if (event.key.toLowerCase() === 'z' && !event.shiftKey) undoCertificateGrid(); else redoCertificateGrid(); }
      else if (event.key === 'Enter') { event.preventDefault(); focusCertificateCell(certificate.selection.focusRow + 1, certificate.selection.focusCol); }
    });
    document.addEventListener('mousedown', (event) => { if (!event.target.closest('#certificateContextMenu')) closeCertificateContextMenu(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#certificateContextMenu').hidden) { event.preventDefault(); closeCertificateContextMenu({ restoreFocus: true }); } }, true);
    document.addEventListener('scroll', () => closeCertificateContextMenu(), true);
    globalThis.addEventListener('resize', () => { closeCertificateContextMenu(); scheduleCertificateOverlayBounds(); });
    bindCertificateGridEvents();
  }

  function cloneGuideValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function captureGuideView() {
    return {
      converterRunTitle: $('#pptxPdfRunTitle').textContent,
      converterRunStatus: $('#pptxPdfRunStatus').textContent,
      converterProgress: { hidden: $('#pptxPdfProgress').hidden, max: $('#pptxPdfProgress').max, value: $('#pptxPdfProgress').value },
      converterOpenHidden: $('#openPptxPdfOutput').hidden,
      certificateTemplateStatus: $('#certificateTemplateStatus').textContent,
      certificatePreviewMode: $('#certificatePreviewMode').textContent,
      certificatePreview: {
        src: $('#certificatePreviewImage').getAttribute('src') || '',
        hidden: $('#certificatePreviewImage').hidden,
        placeholderHidden: $('#certificatePreviewPlaceholder').hidden,
        stageClass: $('#certificatePreviewStage').className,
        showTemplateHidden: $('#showCertificateTemplatePreview').hidden
      },
      certificateOutputSummary: $('#certificateOutputSummary').textContent,
      certificateRunStatus: $('#certificateRunStatus').textContent,
      certificateProgress: { hidden: $('#certificateProgress').hidden, max: $('#certificateProgress').max, value: $('#certificateProgress').value },
      certificateOpenHidden: $('#openCertificateOutput').hidden,
      certificatePdf: $('#certificateOutputPdf').checked,
      certificatePptx: $('#certificateOutputPptx').checked,
      certificateFilenameTemplate: certificate.filenameTemplate,
      mergeOutputName: $('#documentMergeOutputName').value,
      mergeRunTitle: $('#documentMergeRunTitle').textContent,
      mergeRunStatus: $('#documentMergeRunStatus').textContent,
      mergeProgress: { hidden: $('#documentMergeProgress').hidden, max: $('#documentMergeProgress').max, value: $('#documentMergeProgress').value },
      mergeOpenHidden: $('#openDocumentMergeOutput').hidden,
      mergePreviewHidden: $('#previewDocumentMergeOutput').hidden
    };
  }

  function snapshotGuideState() {
    return {
      documentMode,
      documentSplitKind,
      converter: cloneGuideValue({
        files: converter.files,
        outputToken: converter.outputToken,
        outputName: converter.outputName,
        requestId: '',
        running: false,
        cancelling: false,
        preparing: false,
        routeChecking: false,
        capabilities: converter.capabilities,
        sourceExtension: converter.sourceExtension,
        targetExtension: converter.targetExtension,
        targetExtensions: converter.targetExtensions,
        targetMetadata: converter.targetMetadata,
        availability: converter.availability,
        preparationPlan: converter.preparationPlan,
        requiredFonts: converter.requiredFonts,
        fontReports: converter.fontReports,
        inspectionUnavailable: converter.inspectionUnavailable,
        requiresPreview: converter.requiresPreview,
        routes: converter.routes
      }),
      certificate: cloneGuideValue({
        template: certificate.template,
        fields: certificate.fields,
        rows: certificate.rows,
        slideNumber: certificate.slideNumber,
        templatePreviewUrl: certificate.templatePreviewUrl,
        previewCache: certificate.previewCache,
        previewCacheOrder: certificate.previewCacheOrder,
        slideDrafts: certificate.slideDrafts,
        showHiddenBlocks: certificate.showHiddenBlocks,
        currentRow: certificate.currentRow,
        filenameTemplate: certificate.filenameTemplate,
        outputToken: certificate.outputToken,
        outputName: certificate.outputName,
        running: false,
        cancelling: false,
        successfulIndexes: certificate.successfulIndexes,
        requestId: '',
        capabilities: certificate.capabilities,
        certificatePdfReadiness: certificate.certificatePdfReadiness,
        preparationPlan: certificate.preparationPlan,
        preparing: false,
        profiles: certificate.profiles,
        selection: certificate.selection,
        dragging: false,
        history: certificate.history,
        redo: certificate.redo,
        editBaseline: null,
        previewing: false,
        templatePreviewSequence: certificate.templatePreviewSequence,
        rowPreviewSequence: certificate.rowPreviewSequence,
        preserveSelectionOnFocus: false,
        rosterImport: certificate.rosterImport
      }),
      mergeStates: Object.fromEntries(Object.entries(mergeStates).map(([mode, state]) => [mode, cloneGuideValue({
        ...state,
        requestId: '',
        running: false,
        cancelling: false,
        preparing: false,
        inspecting: false,
        inspectionGeneration: Number(state.inspectionGeneration || 0) + 1,
        dragIndex: -1
      })])),
      splitStates: Object.fromEntries(Object.entries(splitStates).map(([kind, state]) => [kind, cloneGuideValue({
        ...state,
        requestId: '',
        running: false,
        cancelling: false,
        confirming: false
      })])),
      excelDedupe: cloneGuideValue({ ...excelDedupe, requestId: '', analyzing: false, running: false }),
      excelCompare: cloneGuideValue({ ...excelCompare, requestId: '', analyzing: false, running: false }),
      excelCleanupTask,
      view: captureGuideView()
    };
  }

  function renderConverterOutput() {
    const summary = $('#pptxPdfOutputSummary');
    if (converter.outputToken) summary.replaceChildren(element('strong', '', converter.outputName || '선택한 폴더'), element('span', '', `선택한 폴더에 ${targetLabel(converter.targetExtension)} 결과를 저장합니다.`));
    else summary.replaceChildren(element('strong', '', '저장 폴더를 선택해주세요.'), element('span', '', '원본 문서는 그대로 보호합니다.'));
  }

  function renderCertificateTemplateState() {
    const hasTemplate = Boolean(certificate.template);
    $('#certificateEditor').hidden = !hasTemplate;
    const select = $('#certificateSlideSelect'); select.replaceChildren();
    (certificate.template?.slides || []).forEach((item) => {
      const option = element('option', '', `${item.number}페이지 · 글자 ${item.visibleBlockCount ?? item.blockCount ?? item.blocks?.length ?? 0}개`);
      option.value = String(item.number); select.append(option);
    });
    if (hasTemplate) {
      select.value = String(certificate.slideNumber);
      $('#certificateSlideField').hidden = certificate.template.slides.length <= 1;
      $('#certificatePreviewStage').style.aspectRatio = `${certificate.template.slideSize?.width || 16} / ${certificate.template.slideSize?.height || 9}`;
    }
    renderCertificateSlideRail(); updateCertificateSlideNavigation(); renderCertificateFontNotice(); renderCertificateFields(); renderCertificateGrid(); renderCertificateDependency(); scheduleCertificateOverlayBounds();
    const previewEntry = certificate.previewCache?.[String(certificate.slideNumber)] || (certificate.templatePreviewUrl ? { imageUrl: certificate.templatePreviewUrl } : null);
    if (hasTemplate && previewEntry?.imageUrl) {
      applyCertificateTemplatePreview(previewEntry);
    } else {
      $('#certificatePreviewImage').hidden = true; $('#certificatePreviewPlaceholder').hidden = !hasTemplate;
      $('#certificateBlockOverlay').replaceChildren();
    }
  }

  function restoreGuideView(view) {
    if (!view) return;
    $('#pptxPdfRunTitle').textContent = view.converterRunTitle;
    $('#pptxPdfRunStatus').textContent = view.converterRunStatus;
    Object.assign($('#pptxPdfProgress'), view.converterProgress);
    $('#openPptxPdfOutput').hidden = view.converterOpenHidden;
    $('#certificateTemplateStatus').textContent = view.certificateTemplateStatus;
    $('#certificatePreviewMode').textContent = view.certificatePreviewMode;
    $('#certificatePreviewStage').className = view.certificatePreview.stageClass;
    const image = $('#certificatePreviewImage');
    if (view.certificatePreview.src) image.src = view.certificatePreview.src; else image.removeAttribute('src');
    image.hidden = view.certificatePreview.hidden;
    $('#certificatePreviewPlaceholder').hidden = view.certificatePreview.placeholderHidden;
    $('#showCertificateTemplatePreview').hidden = view.certificatePreview.showTemplateHidden;
    $('#certificateOutputSummary').textContent = view.certificateOutputSummary;
    $('#certificateRunStatus').textContent = view.certificateRunStatus;
    Object.assign($('#certificateProgress'), view.certificateProgress);
    $('#openCertificateOutput').hidden = view.certificateOpenHidden;
    $('#certificateOutputPdf').checked = view.certificatePdf;
    $('#certificateOutputPptx').checked = view.certificatePptx;
    certificate.filenameTemplate = String(view.certificateFilenameTemplate ?? certificate.filenameTemplate ?? '{A}').slice(0, 160);
    $('#certificateFilenameTemplate').value = certificate.filenameTemplate; renderFilenameFields();
    $('#documentMergeOutputName').value = view.mergeOutputName ?? $('#documentMergeOutputName').value;
    $('#documentMergeRunTitle').textContent = view.mergeRunTitle ?? $('#documentMergeRunTitle').textContent;
    $('#documentMergeRunStatus').textContent = view.mergeRunStatus ?? $('#documentMergeRunStatus').textContent;
    if (view.mergeProgress) Object.assign($('#documentMergeProgress'), view.mergeProgress);
    $('#openDocumentMergeOutput').hidden = view.mergeOpenHidden ?? $('#openDocumentMergeOutput').hidden;
    $('#previewDocumentMergeOutput').hidden = view.mergePreviewHidden ?? $('#previewDocumentMergeOutput').hidden;
    if (!$('#certificatePreviewStage').classList.contains('actual-preview')) renderCertificateOverlay();
  }

  function guideCertificateSvg(values = {}) {
    const safe = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const name = safe(values.name || '성 명');
    const session = safe(values.session || '과정명');
    const date = safe(values.date || '수료일');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#fdfcf7"/><rect x="34" y="34" width="1212" height="652" rx="4" fill="none" stroke="#2f756b" stroke-width="6"/><rect x="55" y="55" width="1170" height="610" fill="none" stroke="#b8a66c" stroke-width="2"/><text x="640" y="155" text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="66" font-weight="700" fill="#243c3a">수 료 증</text><text x="640" y="295" text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="48" font-weight="700" fill="#172b2a">${name}</text><text x="640" y="390" text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="27" fill="#354b49">위 사람은 <tspan font-weight="700">${session}</tspan>을 성실히 수료하였기에</text><text x="640" y="436" text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="27" fill="#354b49">이 증서를 수여합니다.</text><text x="640" y="535" text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="24" fill="#53635f">${date}</text><text x="640" y="610" text-anchor="middle" font-family="Malgun Gothic, sans-serif" font-size="24" font-weight="700" fill="#2f756b">CMOE Workspace 가이드</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function showGuideCertificateTemplate() {
    const blocks = [
      { id: 'guide-certificate-title', name: '제목', text: '수료증', x: 390, y: 88, width: 500, height: 82 },
      { id: 'guide-certificate-name', name: '이름', text: '성 명', x: 405, y: 230, width: 470, height: 82 },
      { id: 'guide-certificate-session', name: '과정명', text: '과정명', x: 445, y: 350, width: 390, height: 58 },
      { id: 'guide-certificate-date', name: '수료일', text: '수료일', x: 470, y: 490, width: 340, height: 55 }
    ];
    certificate.template = {
      token: 'guide-template', profileId: '', name: '가이드 수료증 양식.pptx',
      slideSize: { width: 1280, height: 720 },
      slides: [{ number: 1, blockCount: blocks.length, blocks }]
    };
    certificate.slideNumber = 1; certificate.fields = []; certificate.filenameTemplate = '{A}'; certificate.templatePreviewUrl = guideCertificateSvg();
    certificate.previewCache = { '1': { imageUrl: certificate.templatePreviewUrl, imageWidth: 1280, imageHeight: 720, slideWidth: 1280, slideHeight: 720, engine: 'guide', fidelity: 'native' } };
    certificate.previewCacheOrder = ['1']; certificate.slideDrafts = {}; certificate.showHiddenBlocks = false;
    certificate.outputToken = ''; certificate.outputName = ''; certificate.currentRow = 0; certificate.history = []; certificate.redo = [];
    emptyCertificateRows(3); renderCertificateTemplateState();
    $('#certificateTemplateStatus').textContent = '가이드 수료증 양식.pptx · 1개 슬라이드 · 실제 파일 없음';
    $('#certificatePreviewMode').textContent = '미리보기의 글자 상자를 누른 순서대로 표의 열이 만들어집니다.';
    $('#showCertificateTemplatePreview').hidden = true;
    $('#certificateOutputPdf').checked = true; $('#certificateOutputPptx').checked = false;
    $('#certificateOutputSummary').textContent = '저장 폴더를 선택해주세요.';
    updateCertificateReady();
  }

  function guideCertificateValues() {
    const samples = [
      { name: '김가람', session: '리더십 워크숍', date: '2026년 8월 28일' },
      { name: '이누리', session: '리더십 워크숍', date: '2026년 8월 28일' },
      { name: '박다온', session: '프로젝트 실무 과정', date: '2026년 8월 29일' }
    ];
    const keyByBlock = { 'guide-certificate-name': 'name', 'guide-certificate-session': 'session', 'guide-certificate-date': 'date' };
    return samples.map((sample) => ({ values: certificate.fields.map((field) => sample[keyByBlock[field.blockId]] || '') }));
  }

  function resetGuideMergeState(mode) {
    const state = mergeStates[mode]; const meta = DOCUMENT_MODE_META[mode];
    if (!state || !meta?.kind) return;
    Object.assign(state, {
      files: [], outputToken: '', outputName: '', outputFileToken: '', resultName: meta.defaultName,
      requestId: '', running: false, cancelling: false, inspecting: false, inspectionGeneration: Number(state.inspectionGeneration || 0) + 1, completed: false, outcome: '',
      runTitle: '합치기 준비', runStatus: `합칠 ${meta.label} 파일을 2개 이상 선택해주세요.`,
      progressValue: 0, progressVisible: false, dragIndex: -1, preparing: false,
      availability: null, preparationPlan: null, requiredDependencies: [], missingDependencies: [], runningDependencies: [], requiredFonts: [], fontReports: [],
      inspectionUnavailable: [], compatibilityInputs: [], requiresPreview: false, engine: '', compatibilityFallback: false, fallbackSupported: false, fallbackUnsupportedReasons: [], warnings: [], contentVerified: false,
      internalFallbackSuggested: false, internalFallbackPrompted: false, internalFallbackReason: '', internalFallback: false,
      lastProgressEngine: '', lastProgressPhase: '', lastProgressIndex: -1,
      baseStrategy: '', resultPageCount: 0, resultSectionCount: 0, headerFooterLinksDetached: 0, headerFooterLinkFailures: 0, resultSheetCount: 0, resultSheetNames: [], resultSheetTypes: [], resultSheetVisibility: [], sourcePageCounts: [], sourceSheetCounts: []
    });
    if (mode === 'excelMerge') Object.assign(state, {
      useFileNameAsSheetName: false,
      addCombinedSheet: false,
      combinedSheetRequestedName: '전체 통합',
      combinedSheetAdded: false,
      combinedSheetName: '',
      combinedRowCount: 0,
      combinedColumnCount: 0
    });
  }

  function resetGuideSplitState(kind) {
    const state = splitStates[kind]; const meta = DOCUMENT_SPLIT_META[kind];
    if (!state || !meta) return;
    Object.assign(state, {
      file: null, method: 'equal', equalSize: 2,
      groups: [createSplitGroup(), createSplitGroup()], outputToken: '', outputName: '', requestId: '', running: false, cancelling: false, confirming: false,
      completed: false, outcome: '', results: [], runTitle: '나누기 준비', runStatus: `나눌 ${meta.label} 파일을 선택해주세요.`, progressValue: 0, progressVisible: false,
      engine: '', compatibilityFallback: false, requiresPreview: false, warnings: []
    });
  }

  function enterGuideDemo(kind) {
    if (!['documentEditor', 'pptxPdf', 'certificateMaker', 'documentSplit', 'excelDeduplicate', 'pdfMerge', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge'].includes(kind)) return false;
    if (!guideDemo.active) {
      const readiness = documentToolGuideReadiness();
      if (!readiness.ready) {
        notify(readiness.message);
        return false;
      }
    }
    if (!guideDemo.active) guideDemo.snapshot = snapshotGuideState();
    const resetAll = kind === 'documentEditor'; const initialMode = resetAll ? 'pptxPdf' : kind;
    guideDemo.active = true; guideDemo.kind = kind; setDocumentMode(initialMode, { force: true }); applyEngineStatus({ engine: 'guide', powerPoint: true, powerPointRunning: false, word: true, wordRunning: false, excel: true, excelRunning: false });
    if (resetAll || kind === 'pptxPdf') {
      converter.files = []; converter.outputToken = ''; converter.outputName = ''; converter.requestId = ''; converter.running = false; converter.cancelling = false; converter.preparing = false; converter.routeChecking = false;
      converter.sourceExtension = ''; converter.targetExtension = 'pdf'; converter.targetExtensions = ['pdf']; converter.targetMetadata = []; converter.availability = null; converter.preparationPlan = null; converter.requiredFonts = []; converter.fontReports = []; converter.inspectionUnavailable = []; converter.requiresPreview = false; converter.routes = [];
      renderConverterFiles(); renderConverterOutput();
      $('#pptxPdfProgress').hidden = true; $('#pptxPdfProgress').max = 1; $('#pptxPdfProgress').value = 0;
      $('#openPptxPdfOutput').hidden = true;
      $('#pptxPdfRunTitle').textContent = '변환 준비'; $('#pptxPdfRunStatus').textContent = '파일과 저장 폴더를 선택하면 시작할 수 있습니다.';
    }
    if (resetAll || kind === 'certificateMaker') {
      certificate.template = null; certificate.fields = []; certificate.rows = []; certificate.slideNumber = 1; certificate.templatePreviewUrl = ''; certificate.rosterImport = null;
      certificate.previewCache = {}; certificate.previewCacheOrder = []; certificate.slideDrafts = {}; certificate.showHiddenBlocks = false;
      certificate.currentRow = 0; certificate.filenameTemplate = '{A}'; certificate.outputToken = ''; certificate.outputName = ''; certificate.running = false; certificate.cancelling = false; certificate.successfulIndexes = []; certificate.requestId = '';
      certificate.certificatePdfReadiness = null; certificate.preparationPlan = null; certificate.preparing = false;
      certificate.selection = { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 }; certificate.history = []; certificate.redo = []; certificate.editBaseline = null;
      certificate.previewing = false; certificate.templatePreviewSequence += 1; certificate.rowPreviewSequence += 1; certificate.preserveSelectionOnFocus = false;
      $('#certificateEditor').hidden = true; $('#certificateDataPanel').hidden = true; $('#certificateOutputPanel').hidden = true;
      $('#certificateTemplateStatus').textContent = ''; $('#certificateProgress').hidden = true; $('#openCertificateOutput').hidden = true;
      $('#certificateRunStatus').textContent = '양식·정보·저장 폴더가 준비되면 생성할 수 있습니다.';
      renderCertificateFields(); renderCertificateGrid();
    }
    if (resetAll || kind === 'pdfMerge') resetGuideMergeState('pdfMerge');
    if (resetAll || kind === 'pptxMerge') resetGuideMergeState('pptxMerge');
    if (resetAll || kind === 'wordMerge') resetGuideMergeState('wordMerge');
    if (resetAll || kind === 'excelMerge') resetGuideMergeState('excelMerge');
    if (resetAll || kind === 'documentPdfMerge') resetGuideMergeState('documentPdfMerge');
    if (resetAll || kind === 'documentSplit') {
      resetGuideSplitState('pdf'); resetGuideSplitState('pptx'); documentSplitKind = 'pdf'; renderDocumentSplit();
    }
    if (resetAll || kind === 'excelDeduplicate') {
      clearTimeout(excelDedupeCriteriaTimer);
      Object.assign(excelDedupe, { file: null, selectedSheetIndexes: [], outputToken: '', outputName: '', resultName: '중복 제거 결과', criteriaMode: 'all', columnIndexesBySheet: {}, criteriaDirty: false, criteriaAnalyzing: false, criteriaError: '', criteriaSequence: 0, requestId: '', analyzing: false, running: false, completed: false, result: null, outcome: '', review: null, reviewLoading: false, reviewSheetIndex: -1, activeReviewGroupId: '', mergeMissingValues: true, preferredRowsByGroup: {}, cellSourceRowsByGroup: {}, customValuesByGroup: {}, reviewedGroupIds: [], approvedGroupIds: [], activeColumnSheetIndex: 0 });
      Object.assign(excelCompare, { files: { a: null, b: null }, selections: { a: { sheetIndex: 0, headerRow: 1, keyColumn: 0 }, b: { sheetIndex: 0, headerRow: 1, keyColumn: 0 } }, rules: [createExcelCompareRule()], outputToken: '', outputName: '', resultName: 'Excel 비교 분류 결과', analyzing: false, running: false, requestId: '', plan: null, planSignature: '', result: null, completed: false, outcome: '' });
      excelCleanupTask = 'deduplicate';
      renderExcelDeduplicate();
    }
    setDocumentMode(initialMode, { force: true });
    return true;
  }

  function exitGuideDemo() {
    if (!guideDemo.active) return false;
    const snapshot = guideDemo.snapshot; guideDemo.active = false; guideDemo.kind = ''; guideDemo.snapshot = null;
    if (!snapshot) return true;
    Object.assign(converter, cloneGuideValue(snapshot.converter));
    Object.assign(certificate, cloneGuideValue(snapshot.certificate));
    Object.entries(snapshot.mergeStates || {}).forEach(([mode, saved]) => { if (mergeStates[mode]) Object.assign(mergeStates[mode], cloneGuideValue(saved)); });
    Object.entries(snapshot.splitStates || {}).forEach(([kind, saved]) => { if (splitStates[kind]) Object.assign(splitStates[kind], cloneGuideValue(saved)); });
    if (snapshot.excelDedupe) Object.assign(excelDedupe, cloneGuideValue(snapshot.excelDedupe));
    if (snapshot.excelCompare) Object.assign(excelCompare, cloneGuideValue(snapshot.excelCompare));
    excelCleanupTask = snapshot.excelCleanupTask === 'compare' ? 'compare' : 'deduplicate';
    documentSplitKind = DOCUMENT_SPLIT_META[snapshot.documentSplitKind] ? snapshot.documentSplitKind : 'pdf';
    applyEngineStatus(converter.capabilities || certificate.capabilities || {});
    converter.capabilities = cloneGuideValue(snapshot.converter.capabilities);
    certificate.capabilities = cloneGuideValue(snapshot.certificate.capabilities);
    renderConverterFiles(); renderConverterOutput(); renderCertificateTemplateState(); renderDocumentSplit(); renderExcelDeduplicate(); renderExcelCompare();
    restoreGuideView(snapshot.view); updateConverterReady(); updateCertificateReady(); restoreGuideView(snapshot.view);
    setDocumentMode(snapshot.documentMode || 'pptxPdf', { force: true }); restoreGuideView(snapshot.view);
    return true;
  }

  function guideMergeSamples(mode) {
    if (mode === 'pdfMerge') return [
      { token: 'guide-merge-pdf-1', itemId: 'guide-merge-pdf-item-1', key: 'guide-merge-pdf-key-1', name: '교육 운영 안내.pdf', bytes: 842000, pageCount: 6 },
      { token: 'guide-merge-pdf-2', itemId: 'guide-merge-pdf-item-2', key: 'guide-merge-pdf-key-2', name: '참가자 활동지.pdf', bytes: 1264000, pageCount: 12 },
      { token: 'guide-merge-pdf-3', itemId: 'guide-merge-pdf-item-3', key: 'guide-merge-pdf-key-3', name: '만족도 결과.pdf', bytes: 518000, pageCount: 4 }
    ];
    if (mode === 'documentPdfMerge') return [
      { token: 'guide-merge-document-1', itemId: 'guide-merge-document-item-1', key: 'guide-merge-document-key-1', name: '과정 소개.pptx', extension: 'pptx', bytes: 2384000, pageCount: 8 },
      { token: 'guide-merge-document-2', itemId: 'guide-merge-document-item-2', key: 'guide-merge-document-key-2', name: '운영 안내.hwpx', extension: 'hwpx', bytes: 921000, pageCount: 5 },
      { token: 'guide-merge-document-3', itemId: 'guide-merge-document-item-3', key: 'guide-merge-document-key-3', name: '참가 현황.xlsx', extension: 'xlsx', bytes: 642000, pageCount: 3 }
    ];
    if (mode === 'wordMerge') return [
      { token: 'guide-merge-word-1', itemId: 'guide-merge-word-item-1', key: 'guide-merge-word-key-1', name: '과정 운영 계획.docx', extension: 'docx', bytes: 928000, pageCount: 4 },
      { token: 'guide-merge-word-2', itemId: 'guide-merge-word-item-2', key: 'guide-merge-word-key-2', name: '참가자 안내.doc', extension: 'doc', bytes: 516000, pageCount: 2 },
      { token: 'guide-merge-word-3', itemId: 'guide-merge-word-item-3', key: 'guide-merge-word-key-3', name: '결과 보고서.odt', extension: 'odt', bytes: 1184000, pageCount: 5 }
    ];
    if (mode === 'excelMerge') return [
      { token: 'guide-merge-excel-1', itemId: 'guide-merge-excel-item-1', key: 'guide-merge-excel-key-1', name: '참가자.xlsx', extension: 'xlsx', bytes: 642000, sheetCount: 2, sheets: [{ index: 1, name: '명단', type: 'worksheet', visibility: 'visible' }, { index: 2, name: '일정', type: 'worksheet', visibility: 'visible' }] },
      { token: 'guide-merge-excel-2', itemId: 'guide-merge-excel-item-2', key: 'guide-merge-excel-key-2', name: '운영 현황.xls', extension: 'xls', bytes: 884000, sheetCount: 2, sheets: [{ index: 1, name: '요약', type: 'worksheet', visibility: 'visible' }, { index: 2, name: '명단', type: 'worksheet', visibility: 'visible' }] },
      { token: 'guide-merge-excel-3', itemId: 'guide-merge-excel-item-3', key: 'guide-merge-excel-key-3', name: '설문 결과.ods', extension: 'ods', bytes: 418000, sheetCount: 2, sheets: [{ index: 1, name: '응답', type: 'worksheet', visibility: 'visible' }, { index: 2, name: '차트', type: 'chart', visibility: 'visible' }] }
    ];
    return [
      { token: 'guide-merge-pptx-1', itemId: 'guide-merge-pptx-item-1', key: 'guide-merge-pptx-key-1', name: '과정 오리엔테이션.pptx', bytes: 2384000, slideCount: 8, slideSize: { width: 1280, height: 720 } },
      { token: 'guide-merge-pptx-2', itemId: 'guide-merge-pptx-item-2', key: 'guide-merge-pptx-key-2', name: '실습 세션 자료.pptx', bytes: 5421000, slideCount: 16, slideSize: { width: 1280, height: 720 } },
      { token: 'guide-merge-pptx-3', itemId: 'guide-merge-pptx-item-3', key: 'guide-merge-pptx-key-3', name: '마무리 안내.pptx', bytes: 1746000, slideCount: 5, slideSize: { width: 1280, height: 720 } }
    ];
  }

  function simulateGuideMergeFiles(mode) {
    setDocumentMode(mode, { force: true }); resetGuideMergeState(mode);
    const state = mergeStates[mode]; state.files = guideMergeSamples(mode).map((file) => ({ ...file, status: 'ready', error: '' }));
    renderDocumentMerge();
    return state;
  }

  function simulateGuideMergeOutput(mode) {
    setDocumentMode(mode, { force: true }); const state = mergeStates[mode]; const meta = DOCUMENT_MODE_META[mode];
    state.outputToken = `guide-${meta.kind}-merge-output`; state.outputName = '가이드 문서 결과';
    state.resultName = mode === 'pdfMerge'
      ? '교육자료 통합본'
      : mode === 'wordMerge'
      ? '운영 문서 통합본'
      : mode === 'excelMerge'
      ? '운영 자료 통합본'
      : mode === 'documentPdfMerge'
      ? '전체 문서 통합본'
      : '통합 발표자료';
    setMergeResultPending(state); renderDocumentMerge();
    return state;
  }

  function simulateGuideMergeRun(mode) {
    setDocumentMode(mode, { force: true }); let state = mergeStates[mode]; const meta = DOCUMENT_MODE_META[mode];
    if (state.files.length < 2) state = simulateGuideMergeFiles(mode);
    if (!state.outputToken) state = simulateGuideMergeOutput(mode);
    const total = state.files.reduce((sum, file) => sum + Number(mergeFileCount(file, meta) || 0), 0);
    const addCombinedSheet = meta.kind === 'excel' && state.addCombinedSheet === true;
    const excelPlan = meta.kind === 'excel' ? excelMergeSheetPlan(state) : [];
    const combinedSheetName = addCombinedSheet ? excelCombinedSheetName(state, excelPlan) : '';
    const resultTotal = total + (addCombinedSheet ? 1 : 0);
    const resultName = `${cleanMergeResultName(state.resultName, meta)}${meta.extension}`;
    Object.assign(state, {
      running: false, cancelling: false, completed: true, outcome: 'success',
      outputFileToken: `guide-${meta.kind}-merged-result`,
      runTitle: `${meta.label} 합치기 완료`,
      runStatus: meta.kind === 'word'
        ? `${state.files.length}개 문서를 목록 순서대로 새 페이지에서 이은 “${resultName}” 저장 완료를 연습했습니다. 실제 파일은 만들지 않았습니다.`
        : meta.kind === 'excel'
        ? `${state.files.length}개 파일 · ${resultTotal}개 시트${addCombinedSheet ? ` · 맨 앞에 “${combinedSheetName}” 통합 시트` : ''}를 포함한 “${resultName}” 저장 완료를 연습했습니다. 실제 파일은 만들지 않았습니다.`
        : `${state.files.length}개 파일 · ${total}${meta.unit}를 목록 순서대로 합친 “${resultName}” 저장 완료를 연습했습니다. 실제 파일은 만들지 않았습니다.`,
      progressValue: state.files.length, progressVisible: true, requestId: ''
    });
    if (meta.kind === 'word') {
      state.sourcePageCounts = state.files.map((file) => Number(file.pageCount) || 0); state.resultPageCount = total;
    }
    if (meta.kind === 'excel') {
      state.sourceSheetCounts = excelPlan.map((entry) => entry.sheets.length);
      const originalNames = excelPlan.flatMap((entry) => entry.sheets.map((sheet) => sheet.outputName));
      state.resultSheetNames = addCombinedSheet ? [combinedSheetName, ...originalNames] : originalNames;
      state.resultSheetCount = state.resultSheetNames.length;
      state.combinedSheetAdded = addCombinedSheet; state.combinedSheetName = combinedSheetName;
      state.combinedRowCount = addCombinedSheet ? 12 : 0; state.combinedColumnCount = addCombinedSheet ? 4 : 0;
    }
    renderDocumentMerge(); $('#openDocumentMergeOutput').hidden = false; $('#previewDocumentMergeOutput').hidden = false;
    return { state, total: resultTotal, resultName };
  }

  function guideSplitGroups() {
    return [
      createSplitGroup({ id: 'guide-split-group-1', pages: '1, 3, 5-6', name: '활동 자료' }),
      createSplitGroup({ id: 'guide-split-group-2', pages: '4, 7-9', name: '운영 자료' }),
      createSplitGroup({ id: 'guide-split-group-3', pages: '2', name: '' })
    ];
  }

  function simulateGuideSplitFile() {
    setDocumentMode('documentSplit', { force: true }); setDocumentSplitKind('pdf', { force: true });
    const state = splitStates.pdf;
    Object.assign(state, {
      file: { token: 'guide-split-pdf', name: '교육 운영 자료.pdf', bytes: 1842000, pageCount: 10 }, method: 'equal', equalSize: 2,
      groups: guideSplitGroups(), confirming: false, completed: false, outcome: '', results: [], progressValue: 0, progressVisible: false,
      runTitle: '나누기 준비', runStatus: '나누는 방법과 저장 폴더를 준비해주세요.'
    });
    renderDocumentSplit(); return state;
  }

  function simulateGuideSplitOutput() {
    setDocumentMode('documentSplit', { force: true }); setDocumentSplitKind('pdf', { force: true });
    const state = splitStates.pdf; if (!state.file) simulateGuideSplitFile();
    state.outputToken = 'guide-split-output'; state.outputName = '가이드 나누기 결과'; setSplitResultPending(state); renderDocumentSplit(); return state;
  }

  function simulateGuideSplitRun() {
    setDocumentMode('documentSplit', { force: true }); setDocumentSplitKind('pdf', { force: true });
    let state = splitStates.pdf; if (!state.file) state = simulateGuideSplitFile(); if (!state.outputToken) state = simulateGuideSplitOutput();
    let plan = buildSplitPlan(state, DOCUMENT_SPLIT_META.pdf);
    if (!plan.valid) { state.method = 'custom'; state.groups = guideSplitGroups(); plan = buildSplitPlan(state, DOCUMENT_SPLIT_META.pdf); }
    state.results = plan.groups.map((group, index) => ({ outputName: group.filename, outputFileToken: `guide-split-result-${index + 1}`, pages: group.pages.slice() }));
    state.running = false; state.cancelling = false; state.confirming = false; state.completed = true; state.outcome = 'success'; state.progressValue = plan.groups.length; state.progressVisible = true; state.requestId = '';
    state.engine = 'guide'; state.compatibilityFallback = false; state.requiresPreview = false; state.warnings = [];
    state.runTitle = 'PDF 나누기 완료';
    state.runStatus = `${state.results.length}개 결과 파일 저장 완료를 연습했습니다.${plan.unassigned.length ? ` 선택하지 않은 ${compactSplitPages(plan.unassigned)}쪽은 결과에서 제외했습니다.` : ''} 실제 파일은 만들지 않았습니다.`;
    renderDocumentSplit(); return { state, plan };
  }

  function simulateGuideExcelDedupeFile() {
    setDocumentMode('excelDeduplicate', { force: true });
    resetExcelDedupeReview({ close: true });
    excelDedupe.file = {
      token: 'guide-excel-dedupe', name: '참가자 명단.xlsx', bytes: 482000, sheetCount: 3,
      duplicateRowCount: 7, duplicateSheetCount: 2, highRiskFeatures: [],
      sheets: [
        { index: 0, name: '참가자', rowCount: 128, columnCount: 8, duplicateRowCount: 5, duplicateGroupCount: 3, duplicateExamples: [[12, 27], [44, 45, 62]], columns: [{ index: 1, letter: 'A', label: '이름' }, { index: 2, letter: 'B', label: '이메일' }, { index: 3, letter: 'C', label: '전화번호' }] },
        { index: 1, name: '코치', rowCount: 34, columnCount: 6, duplicateRowCount: 2, duplicateGroupCount: 2, duplicateExamples: [[8, 19], [21, 22]], columns: [{ index: 1, letter: 'A', label: '이름' }, { index: 2, letter: 'B', label: '역할' }] },
        { index: 2, name: '안내', rowCount: 15, columnCount: 4, duplicateRowCount: 0, duplicateGroupCount: 0, duplicateExamples: [], columns: [{ index: 1, letter: 'A', label: '안내' }] }
      ]
    };
    excelDedupe.criteriaMode = 'all'; excelDedupe.columnIndexesBySheet = { '0': [1, 2, 3], '1': [1, 2], '2': [1] };
    excelDedupe.criteriaDirty = false; excelDedupe.criteriaAnalyzing = false; excelDedupe.criteriaError = ''; excelDedupe.selectedSheetIndexes = [0, 1]; excelDedupe.resultName = '참가자 명단_중복제거'; resetExcelDedupeResult(); renderExcelDeduplicate(); return excelDedupe;
  }

  function simulateGuideExcelDedupeOutput() {
    setDocumentMode('excelDeduplicate', { force: true }); if (!excelDedupe.file) simulateGuideExcelDedupeFile();
    excelDedupe.outputToken = 'guide-excel-dedupe-output'; excelDedupe.outputName = '가이드 정리 결과'; resetExcelDedupeResult(); renderExcelDeduplicate(); return excelDedupe;
  }

  function simulateGuideExcelDedupeColumns() {
    setDocumentMode('excelDeduplicate', { force: true }); if (!excelDedupe.file) simulateGuideExcelDedupeFile();
    excelDedupe.criteriaMode = 'columns'; excelDedupe.columnIndexesBySheet = { '0': [1, 3], '1': [1, 2], '2': [1] };
    excelDedupe.criteriaDirty = false; excelDedupe.criteriaAnalyzing = false; resetExcelDedupeResult(); renderExcelDeduplicate(); return excelDedupe;
  }

  function simulateGuideExcelDedupeRun() {
    setDocumentMode('excelDeduplicate', { force: true }); if (!excelDedupe.file) simulateGuideExcelDedupeFile(); if (!excelDedupe.outputToken) simulateGuideExcelDedupeOutput();
    excelDedupe.result = {
      outputFileToken: 'guide-excel-dedupe-result', removedRowCount: 7,
      sheets: [{ index: 0, name: '참가자', beforeRowCount: 128, removedRowCount: 5, afterRowCount: 123 }, { index: 1, name: '코치', beforeRowCount: 34, removedRowCount: 2, afterRowCount: 32 }]
    };
    excelDedupe.completed = true; excelDedupe.outcome = 'success'; renderExcelDeduplicate(); return excelDedupe;
  }

  function guideExcelCompareFile(side) {
    const isA = side === 'a'; const columns = isA
      ? [{ index: 1, letter: 'A', label: '이름' }, { index: 2, letter: 'B', label: '회사명' }, { index: 3, letter: 'C', label: '이메일' }]
      : [{ index: 1, letter: 'A', label: '메일 주소' }, { index: 2, letter: 'B', label: '소속' }, { index: 3, letter: 'C', label: '수료 여부' }];
    return {
      token: `guide-excel-compare-${side}`, name: isA ? '교육 신청 명단.xlsx' : '참석 결과.xlsx', bytes: isA ? 382000 : 294000, sheetCount: 1,
      sheets: [{ index: 0, name: isA ? '신청자' : '참석', rowCount: isA ? 34 : 32, headerRow: 2, columns, headerCandidates: [{ row: 1, label: `1행 · A ${isA ? '교육 신청 명단' : '참석 결과'}`, columns: columns.map((column) => ({ ...column, label: `열 ${column.letter}` })) }, { row: 2, label: `2행 · ${columns.map((column) => `${column.letter} ${column.label}`).join(' · ')}`, columns }] }]
    };
  }

  function simulateGuideExcelCompareFile(side) {
    setDocumentMode('excelDeduplicate', { force: true }); excelCleanupTask = 'compare'; excelCompare.files[side] = guideExcelCompareFile(side);
    excelCompare.selections[side] = { sheetIndex: 0, headerRow: 2, keyColumn: side === 'a' ? 3 : 1 };
    invalidateExcelComparePlan(); renderExcelCompare(); return excelCompare;
  }

  function simulateGuideExcelCompareRules() {
    if (!excelCompare.files.a) simulateGuideExcelCompareFile('a'); if (!excelCompare.files.b) simulateGuideExcelCompareFile('b');
    excelCompare.rules = [createExcelCompareRule({ source: 'key', contains: '.onsemi', groupName: '온세미' }), createExcelCompareRule({ source: 'b', columnIndex: 2, contains: '삼성', groupName: '삼성전자' })];
    invalidateExcelComparePlan(); renderExcelCompare(); return excelCompare;
  }

  function simulateGuideExcelCompareAnalysis() {
    if (!excelCompare.rules.some((rule) => rule.contains)) simulateGuideExcelCompareRules();
    excelCompare.plan = { matchedCount: 24, classifiedCount: 18, otherCount: 6, ambiguousRowCount: 2, unmatchedACount: 3, unmatchedBCount: 1, groupCounts: [{ name: '온세미', count: 11 }, { name: '삼성전자', count: 7 }] };
    excelCompare.planSignature = excelCompareSignature(); excelCompare.outcome = 'analyzed'; renderExcelCompare(); return excelCompare;
  }

  function simulateGuideExcelCompareOutput() {
    if (!excelCompare.plan) simulateGuideExcelCompareAnalysis(); excelCompare.outputToken = 'guide-excel-compare-output'; excelCompare.outputName = '가이드 비교 결과'; renderExcelCompare(); return excelCompare;
  }

  function simulateGuideExcelCompareRun() {
    if (!excelCompare.outputToken) simulateGuideExcelCompareOutput();
    excelCompare.result = { outputFileToken: 'guide-excel-compare-result', sheetCount: 6, matchedCount: 24, sheets: [{ name: '온세미', rowCount: 11 }, { name: '삼성전자', rowCount: 7 }, { name: '기타', rowCount: 6 }, { name: '중복 확인', rowCount: 2 }, { name: '미매칭 A', rowCount: 3 }, { name: '미매칭 B', rowCount: 1 }] };
    excelCompare.completed = true; excelCompare.outcome = 'success'; renderExcelCompare(); return excelCompare;
  }

  function simulateGuideAction(name) {
    if (!guideDemo.active) throw new Error('문서 도구 가이드 모드가 아닙니다.');
    if (name === 'document-pptx-files') {
      converter.sourceExtension = '';
      converter.files = [
        { token: 'guide-pptx-1', key: 'guide-pptx-1', name: '오리엔테이션.pptx', extension: 'pptx', bytes: 1482000, status: 'pending', error: '', outputName: '' },
        { token: 'guide-docx-1', key: 'guide-docx-1', name: '과정 안내서.docx', extension: 'docx', bytes: 2394000, status: 'pending', error: '', outputName: '' },
        { token: 'guide-hwpx-1', key: 'guide-hwpx-1', name: '결과 보고서.hwpx', extension: 'hwpx', bytes: 3128000, status: 'pending', error: '', outputName: '' }
      ];
      converter.targetExtension = 'pdf'; converter.targetExtensions = ['pdf']; converter.targetMetadata = [{ extension: 'pdf', label: 'PDF 문서' }];
      converter.availability = { ready: true, available: true, blocked: false }; converter.preparationPlan = { actions: [] }; converter.requiredFonts = []; converter.fontReports = []; converter.routes = [];
      renderConverterFiles();
      return { completed: true, message: '서로 다른 형식의 샘플 문서 3개를 목록에 추가했습니다. 실제 파일은 열지 않았습니다.' };
    }
    if (name === 'document-pptx-output') {
      converter.outputToken = 'guide-output'; converter.outputName = '가이드 변환 결과'; renderConverterOutput(); updateConverterReady();
      return { completed: true, message: '가이드 결과 폴더를 모의로 선택했습니다. 실제 폴더는 바뀌지 않습니다.' };
    }
    if (name === 'document-pptx-convert') {
      converter.files.forEach((file, index) => { file.status = 'complete'; file.outputName = file.name.replace(/\.[^.]+$/i, '.pdf'); file.outputFileToken = `guide-document-result-${index + 1}`; file.engine = '원본 프로그램'; file.validation = { ok: true, status: 'passed' }; });
      renderConverterFiles();
      $('#pptxPdfProgress').hidden = false; $('#pptxPdfProgress').max = converter.files.length; $('#pptxPdfProgress').value = converter.files.length;
      $('#pptxPdfRunTitle').textContent = `${converter.files.length}개 변환 완료`;
      $('#pptxPdfRunStatus').textContent = '모든 파일을 선택한 폴더에 저장한 상태를 연습했습니다. 실제 PDF는 만들지 않았습니다.';
      return { completed: true, message: `문서 ${converter.files.length}개의 PDF 변환 상태를 모의로 완료했습니다.` };
    }
    if (name === 'document-merge-pdf-files') {
      const state = simulateGuideMergeFiles('pdfMerge');
      return { completed: true, message: `한국어 PDF 샘플 ${state.files.length}개를 목록 순서대로 추가했습니다. 실제 파일은 열지 않았습니다.` };
    }
    if (name === 'document-merge-pdf-output') {
      simulateGuideMergeOutput('pdfMerge');
      return { completed: true, message: 'PDF 합치기용 가이드 결과 폴더와 파일 이름을 모의로 선택했습니다.' };
    }
    if (name === 'document-merge-pdf-run') {
      const result = simulateGuideMergeRun('pdfMerge');
      return { completed: true, message: `PDF ${result.state.files.length}개 · ${result.total}쪽 합치기 완료 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-merge-pptx-files') {
      const state = simulateGuideMergeFiles('pptxMerge');
      return { completed: true, message: `한국어 PPTX 샘플 ${state.files.length}개를 목록 순서대로 추가했습니다. 실제 파일은 열지 않았습니다.` };
    }
    if (name === 'document-merge-pptx-output') {
      simulateGuideMergeOutput('pptxMerge');
      return { completed: true, message: 'PPTX 합치기용 가이드 결과 폴더와 파일 이름을 모의로 선택했습니다.' };
    }
    if (name === 'document-merge-pptx-run') {
      const result = simulateGuideMergeRun('pptxMerge');
      return { completed: true, message: `PPTX ${result.state.files.length}개 · ${result.total}슬라이드 합치기 완료 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-merge-word-files') {
      const state = simulateGuideMergeFiles('wordMerge');
      return { completed: true, message: `Word 문서 샘플 ${state.files.length}개를 페이지가 이어질 순서대로 추가했습니다. 실제 파일은 열지 않았습니다.` };
    }
    if (name === 'document-merge-word-output') {
      simulateGuideMergeOutput('wordMerge');
      return { completed: true, message: 'Word 합치기용 가이드 결과 폴더와 DOCX 파일 이름을 모의로 선택했습니다.' };
    }
    if (name === 'document-merge-word-run') {
      const result = simulateGuideMergeRun('wordMerge');
      return { completed: true, message: `Word 문서 ${result.state.files.length}개를 목록 순서대로 새 페이지에서 이은 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-merge-excel-files') {
      const state = simulateGuideMergeFiles('excelMerge');
      return { completed: true, message: `Excel 파일 샘플 ${state.files.length}개를 파일과 시트 순서대로 추가했습니다. 같은 시트 이름 자동 구분도 함께 표시했습니다.` };
    }
    if (name === 'document-merge-excel-output') {
      simulateGuideMergeOutput('excelMerge');
      return { completed: true, message: 'Excel 합치기용 가이드 결과 폴더와 XLSX 파일 이름을 모의로 선택했습니다.' };
    }
    if (name === 'document-merge-excel-run') {
      const result = simulateGuideMergeRun('excelMerge');
      return { completed: true, message: `Excel ${result.state.files.length}개 · 결과 ${result.total}개 시트${result.state.combinedSheetAdded ? '와 맨 앞 전체 통합 시트' : ''}를 만든 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-merge-documents-files') {
      const state = simulateGuideMergeFiles('documentPdfMerge');
      state.availability = { ready: true, available: true, blocked: false };
      return { completed: true, message: `서로 다른 형식의 샘플 문서 ${state.files.length}개를 목록 순서대로 추가했습니다. 실제 파일은 열지 않았습니다.` };
    }
    if (name === 'document-merge-documents-output') {
      simulateGuideMergeOutput('documentPdfMerge');
      return { completed: true, message: '여러 문서를 PDF로 합칠 가이드 결과 폴더와 파일 이름을 모의로 선택했습니다.' };
    }
    if (name === 'document-merge-documents-run') {
      const result = simulateGuideMergeRun('documentPdfMerge');
      return { completed: true, message: `서로 다른 문서 ${result.state.files.length}개 · ${result.total}쪽을 PDF 하나로 합친 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-split-file') {
      const state = simulateGuideSplitFile();
      return { completed: true, message: `10쪽짜리 “${state.file.name}”을 가이드에 추가했습니다. 실제 파일은 열지 않았습니다.` };
    }
    if (name === 'document-split-output') {
      simulateGuideSplitOutput();
      return { completed: true, message: '나눈 파일을 받을 가이드 결과 폴더를 모의로 선택했습니다.' };
    }
    if (name === 'document-split-run') {
      const result = simulateGuideSplitRun();
      return { completed: true, message: `PDF를 ${result.state.results.length}개 파일로 나눈 완료 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-excel-dedupe-file') {
      const state = simulateGuideExcelDedupeFile();
      return { completed: true, message: `${state.file.sheetCount}개 시트에서 중복 ${state.file.duplicateRowCount}행을 찾은 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-excel-dedupe-columns') {
      simulateGuideExcelDedupeColumns();
      return { completed: true, message: '참가자 시트의 A 이름 열과 C 전화번호 열을 함께 비교하는 상태를 모의로 표시했습니다.' };
    }
    if (name === 'document-excel-dedupe-output') {
      simulateGuideExcelDedupeOutput();
      return { completed: true, message: '원본과 분리된 가이드 결과 폴더와 XLSX 이름을 모의로 선택했습니다.' };
    }
    if (name === 'document-excel-dedupe-run') {
      const state = simulateGuideExcelDedupeRun();
      return { completed: true, message: `선택한 시트에서 중복 ${state.result.removedRowCount}행을 제거한 상태를 모의로 표시했습니다.` };
    }
    if (name === 'document-excel-compare-a') { simulateGuideExcelCompareFile('a'); return { completed: true, message: '가이드용 A 신청 명단과 이메일 열을 선택했습니다.' }; }
    if (name === 'document-excel-compare-b') { simulateGuideExcelCompareFile('b'); return { completed: true, message: '열 순서가 다른 가이드용 B 참석 결과와 메일 주소 열을 선택했습니다.' }; }
    if (name === 'document-excel-compare-rules') { simulateGuideExcelCompareRules(); return { completed: true, message: '.onsemi 이메일과 삼성 회사명에 대한 두 그룹 규칙을 입력했습니다.' }; }
    if (name === 'document-excel-compare-analysis') { const state = simulateGuideExcelCompareAnalysis(); return { completed: true, message: `동일 인물 ${state.plan.matchedCount}명의 그룹별 인원수를 계산했습니다.` }; }
    if (name === 'document-excel-compare-output') { simulateGuideExcelCompareOutput(); return { completed: true, message: '두 원본과 분리된 결과 폴더를 모의로 선택했습니다.' }; }
    if (name === 'document-excel-compare-run') { const state = simulateGuideExcelCompareRun(); return { completed: true, message: `그룹·기타·중복·미매칭을 포함한 ${state.result.sheetCount}개 결과 시트를 만들었습니다.` }; }
    if (name === 'document-certificate-template') {
      showGuideCertificateTemplate();
      return { completed: true, message: '가이드용 수료증 양식을 불러왔습니다. 실제 PPTX는 열지 않았습니다.' };
    }
    if (name === 'document-certificate-data') {
      certificate.rows = guideCertificateValues(); certificate.history = []; certificate.redo = []; resetCertificateSelection(); renderCertificateGrid();
      return { completed: true, message: `가이드용 문서 정보 ${certificate.rows.length}행을 표에 불러왔습니다. 실제 Excel·CSV는 열지 않았습니다.` };
    }
    if (name === 'document-certificate-preview') {
      const row = certificate.rows[certificate.currentRow] || certificate.rows[0];
      const byBlock = Object.fromEntries(certificate.fields.map((field, index) => [field.blockId, row?.values[index] || '']));
      const image = $('#certificatePreviewImage'); image.src = guideCertificateSvg({ name: byBlock['guide-certificate-name'], session: byBlock['guide-certificate-session'], date: byBlock['guide-certificate-date'] }); image.hidden = false;
      $('#certificatePreviewPlaceholder').hidden = true; $('#certificatePreviewStage').classList.add('actual-preview'); $('#showCertificateTemplatePreview').hidden = false;
      $('#certificatePreviewMode').textContent = `${certificate.currentRow + 1}행 실제 결과 가이드 미리보기 · 파일은 만들지 않음`;
      return { completed: true, message: `${certificate.currentRow + 1}행의 정보를 반영한 가이드 미리보기를 만들었습니다.` };
    }
    if (name === 'document-certificate-output') {
      certificate.outputToken = 'guide-certificate-output'; certificate.outputName = '가이드 문서 결과';
      $('#certificateOutputSummary').textContent = '가이드 문서 결과에 행별 파일을 저장할 예정입니다. 실제 폴더는 사용하지 않습니다.'; updateCertificateReady();
      return { completed: true, message: '가이드 결과 폴더를 모의로 선택했습니다.' };
    }
    if (name === 'document-certificate-generate') {
      const count = certificateRowsForOutput().length;
      $('#certificateProgress').hidden = false; $('#certificateProgress').max = Math.max(1, count); $('#certificateProgress').value = count;
      $('#certificateRunStatus').textContent = `${count}개 문서의 일괄 생성 상태를 모의로 완료했습니다. 실제 파일은 만들지 않았습니다.`;
      $('#openCertificateOutput').hidden = true;
      return { completed: true, message: `행별 문서 ${count}개의 생성 상태를 모의로 완료했습니다.` };
    }
    throw new Error('알 수 없는 문서 도구 가이드 동작입니다.');
  }

  async function initialize(options = {}) {
    if (certificate.initialized) return;
    certificate.initialized = true; callbacks = options;
    $('#pptxPdfEngineBadge').setAttribute('role', 'status'); $('#certificateEngineBadge').setAttribute('role', 'status');
    $('#documentMergeFormatBadge').setAttribute('role', 'status'); $('#documentSplitFormatBadge').setAttribute('role', 'status');
    $('#pptxPdfRunStatus').setAttribute('aria-live', 'polite'); $('#certificateRunStatus').setAttribute('aria-live', 'polite'); $('#certificatePreviewMode').setAttribute('aria-live', 'polite'); $('#documentMergeRunStatus').setAttribute('aria-live', 'polite'); $('#documentSplitRunStatus').setAttribute('aria-live', 'polite'); $('#excelDeduplicateRunStatus').setAttribute('aria-live', 'polite');
    $('#pptxPdfProgress').setAttribute('aria-label', '문서 변환 진행률'); $('#certificateProgress').setAttribute('aria-label', '문서 일괄 생성 진행률'); $('#documentMergeProgress').setAttribute('aria-label', '문서 합치기 진행률'); $('#documentSplitProgress').setAttribute('aria-label', '문서 나누기 진행률'); $('#excelDeduplicateProgress').setAttribute('aria-label', 'Excel 중복 행 정리 진행률');
    $('#certificateDataTable').setAttribute('aria-label', '문서마다 바뀔 정보 입력 표');
    bindConverterEvents(); bindCertificateEvents(); bindDocumentModeEvents();
    globalThis.addEventListener('focus', handleDocumentToolWindowFocus);
    progressUnsubscribe = api()?.onDocumentToolProgress?.(handleProgress) || null;
    renderConverterFiles(); renderCertificateFields(); emptyCertificateRows(3); renderCertificateGrid(); renderDocumentSplit(); renderExcelDeduplicate(); renderExcelCompare(); setDocumentMode('pptxPdf', { force: true });
    await Promise.all([refreshCapabilities(), renderProfiles()]);
  }

  function show(pageId, options = {}) {
    const optionMode = String(options?.mode || '');
    const requestedMode = ['pptxPdf', 'certificateMaker', 'documentSplit', 'excelDeduplicate', 'pdfMerge', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge'].includes(optionMode)
      ? optionMode
      : ['pptxPdf', 'certificateMaker', 'documentSplit', 'excelDeduplicate', 'pdfMerge', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge'].includes(pageId)
      ? pageId
      : documentMode;
    const modeAccepted = setDocumentMode(requestedMode);
    if (documentMode === 'pptxPdf') void refreshUnavailableCapabilities('pptxPdf');
    if (documentMode === 'certificateMaker') void refreshUnavailableCapabilities('certificateMaker');
    return modeAccepted;
  }

  root.CMOEDocumentToolsUI = {
    initialize,
    show,
    refreshCapabilities,
    documentToolGuideReadiness,
    enterGuideDemo,
    exitGuideDemo,
    simulateGuideAction,
    refreshCertificateOverlay: renderCertificateOverlay,
    refreshCertificateViewer: renderCertificateTemplateState,
    switchCertificateSlide,
    setDocumentMode,
    setDocumentSplitKind,
    converter,
    certificate,
    mergeStates,
    mergeFailurePresentation,
    splitStates,
    excelDedupe,
    excelCompare,
    get documentMode() { return documentMode; },
    get documentSplitKind() { return documentSplitKind; },
    get guideDemoActive() { return guideDemo.active; },
    destroy() {
      progressUnsubscribe?.(); progressUnsubscribe = null;
      certificateOverlayResizeObserver?.disconnect(); certificateOverlayResizeObserver = null;
      if (certificateOverlayResizeFrame) cancelAnimationFrame(certificateOverlayResizeFrame); certificateOverlayResizeFrame = 0;
      globalThis.removeEventListener('focus', handleDocumentToolWindowFocus);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
