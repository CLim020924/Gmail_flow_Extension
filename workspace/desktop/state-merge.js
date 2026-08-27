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
    const currentProject = impact.scheduleOnly && currentState ? (currentState.projects || []).find((item) => item.id === incomingProject.id) || Object.values(currentState.quickWorkspaces || {}).find((item) => item.id === incomingProject.id) : null;
    const projectBase = currentProject || baseProject;
    const data = { ...projectBase.data };
    scheduleKeys.forEach((key) => { data[key] = incomingProject.data?.[key]; });
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
    }
    data.externalArtifacts = mergeScheduleArtifacts(projectBase.data?.externalArtifacts, incomingProject.data?.externalArtifacts, impact);
    const moduleState = { ...projectBase.moduleState, schedule: incomingProject.moduleState?.schedule || projectBase.moduleState?.schedule };
    ['zoom', 'gmailFlow'].forEach((moduleId) => { if (incomingProject.moduleState?.[moduleId]?.status === 'stale') moduleState[moduleId] = incomingProject.moduleState[moduleId]; });
    const incomingSteps = new Map((incomingProject.workflow || []).map((step) => [step.id, step]));
    const workflow = (projectBase.workflow || []).map((step) => {
      const incomingStep = incomingSteps.get(step.id);
      if (!incomingStep) return step;
      return step.moduleId === 'schedule' || (['zoom', 'gmailFlow'].includes(step.moduleId) && incomingStep.status === 'stale') ? incomingStep : step;
    });
    return {
      ...projectBase,
      data,
      moduleState,
      workflow,
      counts: { ...projectBase.counts, sessions: incomingProject.counts?.sessions ?? projectBase.counts?.sessions, unresolved: incomingProject.counts?.unresolved ?? projectBase.counts?.unresolved },
      updatedAt: String(incomingProject.updatedAt || '') > String(projectBase.updatedAt || '') ? incomingProject.updatedAt : projectBase.updatedAt
    };
  };
  const projects = (baseState.projects || []).map((project) => overlay(project, (incomingState.projects || []).find((item) => item.id === project.id)));
  const quickWorkspaces = { ...(baseState.quickWorkspaces || {}) };
  Object.keys(quickWorkspaces).forEach((key) => { quickWorkspaces[key] = overlay(quickWorkspaces[key], incomingState.quickWorkspaces?.[key]); });
  return { ...baseState, projects, quickWorkspaces };
}

function mergeWorkspaceState(current = {}, incoming = {}) {
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
  return {
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
  };
}

module.exports = { mergeWorkspaceState, mergeScheduleArtifacts, overlayScheduleProjects };
