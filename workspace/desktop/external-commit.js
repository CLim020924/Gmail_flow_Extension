const WorkspaceCore = require('../workspace-core');
const OperationsCore = require('../operations-core');
const { mergeWorkspaceState, overlayScheduleProjects } = require('./state-merge');

const PROJECT_KINDS = new Set(['googleForm', 'zoom', 'gmailDraft']);

function projectById(state, projectId) {
  return (state.projects || []).find((project) => project.id === projectId)
    || Object.values(state.quickWorkspaces || {}).find((project) => project?.id === projectId)
    || null;
}

function activeReservationMatches(reservations, token, ownerId, projectId, kind, expectedKeys, now = Date.now()) {
  const keys = [...new Set((Array.isArray(expectedKeys) ? expectedKeys : []).map((key) => String(key || '').trim()).filter(Boolean))];
  if (!token || !keys.length) return false;
  const prefix = `${projectId}:${kind}:`;
  const activeKeys = [];
  for (const [key, reservation] of reservations || []) {
    if (reservation?.token !== token) continue;
    if (!key.startsWith(prefix)
      || reservation?.ownerId !== ownerId
      || Number(reservation?.expiresAt || 0) <= now) return false;
    activeKeys.push(key.slice(prefix.length));
  }
  return activeKeys.length === keys.length && keys.every((key) => activeKeys.includes(key));
}

function validateExternalCommit(currentState, guard = {}, reservations = new Map(), ownerId = null, now = Date.now()) {
  const projectId = String(guard.projectId || '').trim();
  const kind = String(guard.kind || '').trim();
  if (!projectId || !PROJECT_KINDS.has(kind)) return { ok: false, reason: '외부 결과 저장 정보가 올바르지 않습니다.' };
  if (!activeReservationMatches(reservations, String(guard.token || ''), ownerId, projectId, kind, guard.reservationKeys, now)) {
    return { ok: false, reason: '외부 작업 예약이 만료되었거나 다른 창의 작업으로 바뀌었습니다.' };
  }
  const project = projectById(currentState, projectId);
  if (!project) return { ok: false, reason: '외부 결과를 연결할 프로젝트를 찾지 못했습니다.' };
  for (const expectedIdentity of Array.isArray(guard.expectedConnections) ? guard.expectedConnections : []) {
    const connection = (currentState.connections || []).find((item) => item.id === expectedIdentity?.id);
    if (!connection || !WorkspaceCore.connectionIdentityMatches(connection, expectedIdentity)) {
      return { ok: false, reason: '외부 작업 중 연결된 계정이 다른 창에서 변경되었습니다.' };
    }
  }
  const actualFingerprint = OperationsCore.externalOperationFingerprint(project, kind, currentState.connections || []);
  if (actualFingerprint !== String(guard.expectedFingerprint || '')) {
    return { ok: false, reason: '외부 작업 중 프로젝트의 관련 내용이 다른 창에서 변경되었습니다.' };
  }
  return { ok: true, reason: '' };
}

function resolveExternalCommit(currentState, incomingState, guard, reservations, ownerId, now = Date.now()) {
  const validation = validateExternalCommit(currentState, guard, reservations, ownerId, now);
  if (validation.ok) return { ...validation, state: incomingState };
  if (!guard?.conflictState || typeof guard.conflictState !== 'object') {
    return { ...validation, state: currentState };
  }
  return { ...validation, state: guard.conflictState };
}

function mergeSelectedWorkspaceState(currentState, incomingState, mergeHints = {}) {
  const current = currentState || {};
  const currentRevision = Number(current?._revision || 0);
  const baseRevision = Number(incomingState?._baseRevision ?? currentRevision);
  const merged = baseRevision !== currentRevision;
  let state = merged ? mergeWorkspaceState(current, incomingState, mergeHints.baseState || null) : incomingState;
  if (merged && Array.isArray(mergeHints.scheduleProjects)) state = overlayScheduleProjects(state, incomingState, mergeHints.scheduleProjects, current);
  return { state, merged, currentRevision };
}

module.exports = { mergeSelectedWorkspaceState, resolveExternalCommit, validateExternalCommit };
