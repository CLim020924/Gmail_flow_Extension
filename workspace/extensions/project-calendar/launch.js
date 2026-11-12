'use strict';

const PROJECT_CALENDAR_ID = 'projectCalendar';
const DOCUMENT_EDITOR_ID = 'documentEditor';
const DOCUMENT_EDITOR_MODES = new Set(['pptxPdf', 'certificateMaker', 'pdfMerge', 'pptxMerge', 'wordMerge', 'excelMerge', 'documentPdfMerge', 'documentSplit']);
const LEGACY_PROGRAM_ALIASES = Object.freeze({
  pptxPdf: { programId: DOCUMENT_EDITOR_ID, documentMode: 'pptxPdf' },
  certificateMaker: { programId: DOCUMENT_EDITOR_ID, documentMode: 'certificateMaker' }
});
const MAX_PROJECT_ID_LENGTH = 200;

function normalizeProjectId(value) {
  const projectId = String(value || '').trim();
  if (!projectId) return '';
  if (projectId.length > MAX_PROJECT_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(projectId)) {
    throw new Error('프로젝트 연결 정보가 올바르지 않습니다.');
  }
  return projectId;
}

function programWindowKey(programId, options = {}) {
  if (programId !== PROJECT_CALENDAR_ID) return programId;
  const projectId = normalizeProjectId(options.projectId);
  return projectId ? `${PROJECT_CALENDAR_ID}:${encodeURIComponent(projectId)}` : PROJECT_CALENDAR_ID;
}

function standaloneLaunchQuery(programId, options = {}) {
  const query = { mode: 'standalone', app: programId };
  if (programId === DOCUMENT_EDITOR_ID && DOCUMENT_EDITOR_MODES.has(String(options.documentMode || ''))) query.documentMode = String(options.documentMode);
  if (programId !== PROJECT_CALENDAR_ID) return query;
  const projectId = normalizeProjectId(options.projectId);
  query.dataMode = 'project';
  if (projectId) query.projectId = projectId;
  return query;
}

function resolveProgramLaunch(rawProgramId, options = {}) {
  const rawId = String(rawProgramId || '').trim();
  const alias = LEGACY_PROGRAM_ALIASES[rawId];
  const programId = alias?.programId || rawId;
  const requestedMode = String(options.documentMode || alias?.documentMode || '');
  const documentMode = programId === DOCUMENT_EDITOR_ID && DOCUMENT_EDITOR_MODES.has(requestedMode) ? requestedMode : '';
  return { programId, options: { ...options, ...(documentMode ? { documentMode } : {}) }, documentMode, legacyProgramId: alias ? rawId : '' };
}

function requestedProjectId(argv = process.argv) {
  const encoded = argv.find((item) => item.startsWith('--project='))?.slice('--project='.length);
  if (!encoded) return '';
  try { return normalizeProjectId(decodeURIComponent(encoded)); }
  catch (_) { return ''; }
}

function requestedDocumentMode(argv = process.argv) {
  const value = argv.find((item) => item.startsWith('--document-mode='))?.slice('--document-mode='.length) || '';
  return DOCUMENT_EDITOR_MODES.has(value) ? value : '';
}

function programShortcutArgs(programId, options = {}) {
  const resolved = resolveProgramLaunch(programId, options); programId = resolved.programId; options = resolved.options;
  const base = `--app=${programId}`;
  if (programId === DOCUMENT_EDITOR_ID && options.documentMode) return `${base} --document-mode=${options.documentMode}`;
  if (programId !== PROJECT_CALENDAR_ID) return base;
  const projectId = normalizeProjectId(options.projectId);
  return projectId ? `${base} --project=${encodeURIComponent(projectId)}` : base;
}

module.exports = {
  PROJECT_CALENDAR_ID,
  DOCUMENT_EDITOR_ID,
  LEGACY_PROGRAM_ALIASES,
  normalizeProjectId,
  resolveProgramLaunch,
  programWindowKey,
  standaloneLaunchQuery,
  requestedProjectId,
  requestedDocumentMode,
  programShortcutArgs
};
