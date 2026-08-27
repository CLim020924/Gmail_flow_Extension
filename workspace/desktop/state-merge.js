const { threeWayMerge } = require('../workspace-core');

function newest(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(right.updatedAt || right.savedAt || '').localeCompare(String(left.updatedAt || left.savedAt || '')) >= 0 ? right : left;
}

function mergeById(current = [], incoming = []) {
  const result = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => result.set(item.id, newest(result.get(item.id), item)));
  return [...result.values()];
}

function scheduleArtifactKey(item, index = 0) {
  if (item?.externalId) return `${item.kind || 'artifact'}:external:${item.externalId}`;
  return `${item?.kind || 'artifact'}:${item?.slotId || item?.personId || ''}:${item?.createdAt || index}`;
}

function mergeScheduleArtifacts(current = [], incoming = [], impact = null) {
  const merged = new Map(current.map((item, index) => [scheduleArtifactKey(item, index), item]));
  const zoomSlots = new Set([...(impact?.changedSlotIds || []), ...(impact?.zoomReviewSlotIds || [])]);
  const mailPeople = new Set(impact?.affectedPersonIds || []);
  incoming.forEach((item, index) => {
    const key = scheduleArtifactKey(item, index);
    const existing = merged.get(key) || {};
    const affected = (item.kind === 'zoom' && zoomSlots.has(item.slotId)) || (item.kind === 'gmailDraft' && mailPeople.has(item.personId));
    const next = affected ? { ...existing, ...item } : { ...item, ...existing };
    if (existing.status === 'superseded' || item.status === 'superseded') {
      next.status = 'superseded';
      next.replacedAt = existing.replacedAt || item.replacedAt;
    }
    merged.set(key, next);
  });
  return [...merged.values()].map((item) => {
    if (item.status === 'superseded') return item;
    if ((item.kind === 'zoom' && zoomSlots.has(item.slotId)) || (item.kind === 'gmailDraft' && mailPeople.has(item.personId))) return { ...item, status: 'stale' };
    return item;
  });
}

function overlayScheduleProjects(baseState, incomingState, scheduleProjects = [], currentState = null) {
  const scheduleKeys = ['roles', 'slots', 'availability', 'assignments', 'conflicts', 'scheduleRules', 'scheduleSheetInitialized', 'scheduleSheetColumns', 'scheduleCustomValues', 'versions'];
  const hints = new Map(scheduleProjects.map((item) => [item.projectId, item]));
  const overlay = (baseProject, incomingProject) => {
    if (!baseProject || !incomingProject || !hints.has(incomingProject.id)) return baseProject;
    const impact = hints.get(incomingProject.id);
    const currentProject = currentState ? (currentState.projects || []).find((item) => item.id === incomingProject.id) || Object.values(currentState.quickWorkspaces || {}).find((item) => item.id === incomingProject.id) : null;
    const projectBase = baseProject;
    const data = { ...projectBase.data };
    const changedSlotIds = new Set(impact.changedSlotIds || []);
    if (currentProject && impact.scheduleOnly && changedSlotIds.size) {
      const incomingSlots = new Map((incomingProject.data?.slots || []).map((slot) => [slot.id, slot]));
      data.slots = (currentProject.data?.slots || []).filter((slot) => !changedSlotIds.has(slot.id) || incomingSlots.has(slot.id)).map((slot) => changedSlotIds.has(slot.id) ? incomingSlots.get(slot.id) : slot);
      (incomingProject.data?.slots || []).filter((slot) => changedSlotIds.has(slot.id) && !data.slots.some((item) => item.id === slot.id)).forEach((slot) => data.slots.push(slot));
      data.assignments = [...(currentProject.data?.assignments || []).filter((item) => !changedSlotIds.has(item.slotId)), ...(incomingProject.data?.assignments || []).filter((item) => changedSlotIds.has(item.slotId))];
      const personIds = new Set([...Object.keys(currentProject.data?.availability || {}), ...Object.keys(incomingProject.data?.availability || {})]);
      data.availability = Object.fromEntries([...personIds].map((personId) => {
        const kept = (currentProject.data?.availability?.[personId] || []).filter((slotId) => !changedSlotIds.has(slotId));
        const changed = (incomingProject.data?.availability?.[personId] || []).filter((slotId) => changedSlotIds.has(slotId));
        return [personId, [...new Set([...kept, ...changed])]];
      }));
      data.scheduleCustomValues = { ...(currentProject.data?.scheduleCustomValues || {}) };
      changedSlotIds.forEach((slotId) => { if (incomingProject.data?.scheduleCustomValues?.[slotId]) data.scheduleCustomValues[slotId] = incomingProject.data.scheduleCustomValues[slotId]; else delete data.scheduleCustomValues[slotId]; });
    } else if (!currentProject) {
      scheduleKeys.forEach((key) => { data[key] = incomingProject.data?.[key]; });
    }
    data.externalArtifacts = mergeScheduleArtifacts(currentProject?.data?.externalArtifacts || projectBase.data?.externalArtifacts, incomingProject.data?.externalArtifacts, impact);
    const useIncomingScheduleState = impact.scheduleOnly !== false;
    const moduleState = { ...projectBase.moduleState, schedule: useIncomingScheduleState ? (incomingProject.moduleState?.schedule || projectBase.moduleState?.schedule) : projectBase.moduleState?.schedule };
    ['zoom', 'gmailFlow'].forEach((moduleId) => { if (incomingProject.moduleState?.[moduleId]?.status === 'stale') moduleState[moduleId] = incomingProject.moduleState[moduleId]; });
    const incomingSteps = new Map((incomingProject.workflow || []).map((step) => [step.id, step]));
    const workflow = (projectBase.workflow || []).map((step) => {
      const incomingStep = incomingSteps.get(step.id);
      if (!incomingStep) return step;
      return (step.moduleId === 'schedule' && useIncomingScheduleState) || (['zoom', 'gmailFlow'].includes(step.moduleId) && incomingStep.status === 'stale') ? incomingStep : step;
    });
    return {
      ...projectBase,
      data,
      moduleState,
      workflow,
      counts: useIncomingScheduleState ? { ...projectBase.counts, sessions: incomingProject.counts?.sessions ?? projectBase.counts?.sessions, unresolved: incomingProject.counts?.unresolved ?? projectBase.counts?.unresolved } : projectBase.counts,
      updatedAt: String(incomingProject.updatedAt || '') > String(projectBase.updatedAt || '') ? incomingProject.updatedAt : projectBase.updatedAt
    };
  };
  const projects = (baseState.projects || []).map((project) => overlay(project, (incomingState.projects || []).find((item) => item.id === project.id)));
  const quickWorkspaces = { ...(baseState.quickWorkspaces || {}) };
  Object.keys(quickWorkspaces).forEach((key) => { quickWorkspaces[key] = overlay(quickWorkspaces[key], incomingState.quickWorkspaces?.[key]); });
  return { ...baseState, projects, quickWorkspaces };
}

function applyDeletionTombstones(state = {}, current = {}, incoming = {}) {
  const deletedConnectionIds = [...new Set([...(current.deletedConnectionIds || []), ...(incoming.deletedConnectionIds || [])])];
  const deletedLibraryIds = [...new Set([...(current.deletedLibraryIds || []), ...(incoming.deletedLibraryIds || [])])];
  const library = { ...(state.library || {}) };
  ['rosters', 'mailTemplates', 'layoutTemplates', 'workflowTemplates'].forEach((key) => {
    library[key] = (library[key] || []).filter((item) => !deletedLibraryIds.includes(item.id));
  });
  return {
    ...state,
    connections: (state.connections || []).filter((item) => !deletedConnectionIds.includes(item.id)),
    library,
    deletedConnectionIds,
    deletedLibraryIds
  };
}

function preserveLocalConnectionContext(pulledState = {}, currentState = {}) {
  const next = JSON.parse(JSON.stringify(pulledState || {}));
  const pulledConnections = Array.isArray(next.connections) ? next.connections : [];
  const localConnections = JSON.parse(JSON.stringify(currentState.connections || []));
  const localById = new Map(localConnections.map((connection) => [connection.id, connection]));
  const pulledById = new Map(pulledConnections.map((connection) => [connection.id, connection]));
  const normalizedAccount = (connection) => String(connection?.account || '').trim().toLowerCase();
  const resolveLocalConnectionId = (pulledId, expectedType) => {
    if (!pulledId) return null;
    const pulledConnection = pulledById.get(pulledId);
    const direct = localById.get(pulledId);
    const pulledAccount = normalizedAccount(pulledConnection);
    if (direct && (!expectedType || direct.type === expectedType)
      && (!pulledConnection || !pulledAccount || normalizedAccount(direct) === pulledAccount)) return direct.id;
    if (!pulledConnection || (expectedType && pulledConnection.type !== expectedType) || !pulledAccount) return null;
    const candidates = localConnections.filter((connection) => connection.type === pulledConnection.type && normalizedAccount(connection) === pulledAccount);
    if (!candidates.length) return null;
    return (candidates.find((connection) => connection.status === 'connected' && connection.label === pulledConnection.label)
      || candidates.find((connection) => connection.status === 'connected')
      || candidates[0]).id;
  };
  const validLocalConnectionId = (connectionId, type) => {
    const connection = localById.get(connectionId);
    return connection && (!type || connection.type === type) ? connection.id : null;
  };
  const pulledWorkspaceDriveId = next.preferences?.workspaceDriveConnectionId || null;
  const localWorkspaceDriveId = currentState.preferences?.workspaceDriveConnectionId || null;
  const workspaceDriveConnectionId = pulledWorkspaceDriveId
    ? (resolveLocalConnectionId(pulledWorkspaceDriveId, 'drive') || validLocalConnectionId(localWorkspaceDriveId, 'drive') || null)
    : (validLocalConnectionId(localWorkspaceDriveId, 'drive') || null);
  next.preferences = { ...(next.preferences || {}), workspaceDriveConnectionId };
  next.connections = localConnections;
  next.deletedConnectionIds = JSON.parse(JSON.stringify(currentState.deletedConnectionIds || []));

  const localProjects = new Map([
    ...(currentState.projects || []),
    ...Object.values(currentState.quickWorkspaces || {})
  ].filter(Boolean).map((project) => [project.id, project]));
  const reviewProjectModule = (project, moduleId, reason) => {
    const reviewedAt = new Date().toISOString();
    project.moduleState = { ...(project.moduleState || {}) };
    project.moduleState[moduleId] = { ...(project.moduleState[moduleId] || {}), status: 'needsReview', summary: reason, updatedAt: reviewedAt };
    if (Array.isArray(project.workflow)) {
      project.workflow = project.workflow.map((step) => (step.moduleId === moduleId || step.type === moduleId)
        ? { ...step, status: 'needsReview', updatedAt: reviewedAt }
        : step);
    }
  };
  const preserveBindings = (project) => {
    if (!project || typeof project !== 'object') return project;
    const localProject = localProjects.get(project.id);
    const pulledDefaults = project.settings?.defaultConnectionIds || {};
    const localDefaults = localProject?.settings?.defaultConnectionIds || {};
    const types = new Set(['forms', 'drive', 'gmail', 'zoom', ...Object.keys(pulledDefaults), ...Object.keys(localDefaults)]);
    const defaultConnectionIds = {};
    types.forEach((type) => {
      const localId = localDefaults[type];
      const pulledId = pulledDefaults[type];
      defaultConnectionIds[type] = pulledId
        ? (resolveLocalConnectionId(pulledId, type) || null)
        : (validLocalConnectionId(localId, type) || null);
    });
    const preserved = { ...project, settings: { ...(project.settings || {}), defaultConnectionIds } };
    if (!preserved.data || typeof preserved.data !== 'object') return preserved;

    let gmailNeedsReview = false;
    let zoomNeedsReview = false;
    let formsNeedsReview = false;
    preserved.data.externalArtifacts = (preserved.data.externalArtifacts || []).map((artifact) => {
      const type = artifact.kind === 'gmailDraft' ? 'gmail' : artifact.kind === 'zoom' ? 'zoom' : null;
      if (!type) return artifact;
      const mappedId = resolveLocalConnectionId(artifact.connectionId, type);
      if (mappedId) return { ...artifact, connectionId: mappedId };
      if (artifact.status === 'superseded') return { ...artifact, connectionId: null };
      const reason = '다른 PC의 계정 연결을 이 PC에서 확인할 수 없어 외부 항목 재확인 필요';
      if (type === 'gmail') {
        gmailNeedsReview = true;
        return { ...artifact, connectionId: null, status: 'superseded', replacedAt: artifact.replacedAt || new Date().toISOString(), replacementReason: reason };
      }
      zoomNeedsReview = true;
      return { ...artifact, connectionId: null, status: 'stale', replacementReason: reason };
    });
    preserved.data.slots = (preserved.data.slots || []).map((slot) => {
      if (!slot.zoomConnectionId) return slot;
      const mappedId = resolveLocalConnectionId(slot.zoomConnectionId, 'zoom');
      if (mappedId) return { ...slot, zoomConnectionId: mappedId };
      zoomNeedsReview = true;
      return { ...slot, zoomConnectionId: null };
    });
    if (preserved.data.forms && typeof preserved.data.forms === 'object') {
      preserved.data.forms.linkedForms = (preserved.data.forms.linkedForms || []).map((linked) => {
        if (!linked.connectionId) return linked;
        const mappedId = resolveLocalConnectionId(linked.connectionId, 'forms');
        if (mappedId) return { ...linked, connectionId: mappedId };
        formsNeedsReview = true;
        return { ...linked, connectionId: null, needsReview: true, reviewReason: '다른 PC의 Google Forms 계정 연결을 이 PC에서 확인해주세요.' };
      });
    }
    if (gmailNeedsReview) reviewProjectModule(preserved, 'gmailFlow', '다른 PC의 Gmail 연결 항목 재확인 필요');
    if (zoomNeedsReview) reviewProjectModule(preserved, 'zoom', '다른 PC의 Zoom 연결 항목 재확인 필요');
    if (formsNeedsReview) reviewProjectModule(preserved, 'forms', '다른 PC의 Google Forms 연결 재확인 필요');
    return preserved;
  };

  next.projects = (next.projects || []).map(preserveBindings);
  next.quickWorkspaces = Object.fromEntries(Object.entries(next.quickWorkspaces || {})
    .map(([key, project]) => [key, preserveBindings(project)]));
  return next;
}

function driveSnapshotIdentityMatches(expected = {}, current = {}) {
  const expectedFileId = String(expected.fileId || '');
  const expectedModifiedTime = String(expected.modifiedTime || '');
  const expectedEtag = String(expected.etag || '');
  const expectedVersion = String(expected.version || '');
  return Boolean(expectedFileId
    && expectedModifiedTime
    && !current.trashed
    && String(current.id || '') === expectedFileId
    && String(current.modifiedTime || '') === expectedModifiedTime
    && (!expectedEtag || String(current.etag || '') === expectedEtag)
    && (!expectedVersion || String(current.version || '') === expectedVersion));
}

function mergeWorkspaceState(current = {}, incoming = {}, baseState = null) {
  // baseState is the full state last acknowledged to the saving renderer.
  if (baseState && typeof baseState === 'object') {
    return applyDeletionTombstones(threeWayMerge(baseState, current, incoming), current, incoming);
  }
  const deletedConnectionIds = [...new Set([...(current.deletedConnectionIds || []), ...(incoming.deletedConnectionIds || [])])];
  const deletedLibraryIds = [...new Set([...(current.deletedLibraryIds || []), ...(incoming.deletedLibraryIds || [])])];
  const scalarSource = newest(current, incoming) || incoming;
  const projects = mergeById(current.projects, incoming.projects);
  const connections = mergeById(current.connections, incoming.connections).filter((item) => !deletedConnectionIds.includes(item.id));
  const quickWorkspaces = { ...(current.quickWorkspaces || {}) };
  Object.entries(incoming.quickWorkspaces || {}).forEach(([key, value]) => { quickWorkspaces[key] = newest(quickWorkspaces[key], value); });
  const quickTasks = { ...(current.quickTasks || {}) };
  Object.entries(incoming.quickTasks || {}).forEach(([key, list]) => { quickTasks[key] = mergeById(quickTasks[key], list); });
  const library = {};
  ['rosters', 'mailTemplates', 'layoutTemplates', 'workflowTemplates'].forEach((key) => { library[key] = mergeById(current.library?.[key], incoming.library?.[key]).filter((item) => !deletedLibraryIds.includes(item.id)); });
  return applyDeletionTombstones({
    ...current,
    ...incoming,
    ...scalarSource,
    projects,
    connections,
    quickWorkspaces,
    quickTasks,
    library,
    deletedConnectionIds,
    deletedLibraryIds
  }, current, incoming);
}

module.exports = { driveSnapshotIdentityMatches, mergeWorkspaceState, mergeScheduleArtifacts, overlayScheduleProjects, preserveLocalConnectionContext };
