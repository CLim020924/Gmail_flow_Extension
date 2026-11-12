const { threeWayMerge } = require('../workspace-core');

const LIBRARY_COLLECTION_KEYS = ['rosters', 'mailTemplates', 'layoutTemplates', 'workflowTemplates', 'formTemplates'];

function newest(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(right.updatedAt || right.savedAt || '').localeCompare(String(left.updatedAt || left.savedAt || '')) >= 0 ? right : left;
}

function hasStoredId(value) {
  return value !== null && value !== undefined && String(value) !== '';
}

function storedId(value) {
  return hasStoredId(value) ? String(value) : '';
}

function storedIds(values = []) {
  return (Array.isArray(values) ? values : []).map(storedId).filter(Boolean);
}

function libraryItemIds(state = {}) {
  return new Set(LIBRARY_COLLECTION_KEYS.flatMap((key) => (Array.isArray(state.library?.[key]) ? state.library[key] : [])
    .filter((item) => item?.builtin !== true)
    .map((item) => storedId(item?.id)).filter(Boolean)));
}

function inferredLibraryDeletionIds(state = {}) {
  const liveIds = libraryItemIds(state);
  return storedIds(state.knownLibraryIds).filter((id) => !liveIds.has(id));
}

function libraryDeletionIdsSinceAncestor(ancestor = {}, current = {}, incoming = {}) {
  const currentIds = libraryItemIds(current);
  const incomingIds = libraryItemIds(incoming);
  return [...libraryItemIds(ancestor)].filter((id) => !currentIds.has(id) || !incomingIds.has(id));
}

function referencedSlotId(item) {
  return hasStoredId(item?.eventId) ? item.eventId : item?.slotId;
}

function mergeById(current = [], incoming = []) {
  const result = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => result.set(item.id, newest(result.get(item.id), item)));
  return [...result.values()];
}

function scheduleArtifactKey(item, index = 0) {
  if (item?.externalId) return `${item.kind || 'artifact'}:external:${item.externalId}`;
  const ownerId = hasStoredId(item?.slotId) ? item.slotId : hasStoredId(item?.personId) ? item.personId : '';
  return `${item?.kind || 'artifact'}:${ownerId}:${item?.createdAt || index}`;
}

function projectFromState(state, projectId) {
  const key = storedId(projectId);
  return (state?.projects || []).find((item) => storedId(item?.id) === key)
    || Object.values(state?.quickWorkspaces || {}).find((item) => storedId(item?.id) === key)
    || null;
}

function uniqueItemsById(items = []) {
  const result = [];
  const indexes = new Map();
  items.forEach((item) => {
    const id = storedId(item?.id);
    if (!id) { result.push(item); return; }
    if (indexes.has(id)) result[indexes.get(id)] = item;
    else { indexes.set(id, result.length); result.push(item); }
  });
  return result;
}

function mergeWithDeletionTombstones(merged = [], current = [], incoming = [], ancestor = []) {
  const currentIds = new Set(current.map((item) => storedId(item?.id)).filter(Boolean));
  const incomingIds = new Set(incoming.map((item) => storedId(item?.id)).filter(Boolean));
  const deletedIds = new Set(ancestor.map((item) => storedId(item?.id)).filter((id) => id && (!currentIds.has(id) || !incomingIds.has(id))));
  return uniqueItemsById(merged).filter((item) => !deletedIds.has(storedId(item?.id)));
}

function timeToMinutes(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function integerMinutes(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function dateKeyEpoch(value) {
  const key = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const parsed = new Date(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) return null;
  return parsed.getTime();
}

function slotWallDurationMinutes(slot = {}) {
  const start = timeToMinutes(slot.startTime); const end = timeToMinutes(slot.endTime); const endDate = String(slot.endDate || slot.date || '');
  if (start == null || end == null) return null;
  const startDay = dateKeyEpoch(slot.date); const endDay = dateKeyEpoch(endDate);
  if (startDay == null || endDay == null) return null;
  const duration = Math.round((endDay - startDay) / 60000) + end - start;
  return duration > 0 ? duration : null;
}

function hasUnsafeChangedSlotActivity(data = {}, changedSlotIds = new Set()) {
  const slotsById = new Map((Array.isArray(data.slots) ? data.slots : []).map((slot) => [storedId(slot?.id), slot]));
  return (Array.isArray(data.activities) ? data.activities : []).some((activity) => {
    const slotId = storedId(referencedSlotId(activity));
    if (!slotId || !changedSlotIds.has(slotId)) return false;
    const slot = slotsById.get(slotId);
    if (!slot) return false;
    const slotDuration = slotWallDurationMinutes(slot);
    if (slotDuration == null) return true;
    const rawOffset = activity?.startOffsetMinutes ?? activity?.offsetMinutes;
    const rawDuration = activity?.durationMinutes;
    const offset = integerMinutes(rawOffset); const duration = integerMinutes(rawDuration);
    return rawOffset == null || rawOffset === '' || rawDuration == null || rawDuration === ''
      || offset == null || duration == null || offset < 0 || duration <= 0 || offset + duration > slotDuration;
  });
}

function timingChangedSlotIds(data = {}, currentData = {}, hintedSlotIds = new Set()) {
  const currentSlots = new Map((Array.isArray(currentData.slots) ? currentData.slots : []).map((slot) => [storedId(slot?.id), slot]));
  return new Set((Array.isArray(data.slots) ? data.slots : []).filter((slot) => {
    const id = storedId(slot?.id); const current = currentSlots.get(id);
    const slotEndDate = slot.endDate && slot.endDate !== slot.date ? slot.endDate : '';
    const currentEndDate = current?.endDate && current.endDate !== current.date ? current.endDate : '';
    return hintedSlotIds.has(id) && current && [slot.date, slotEndDate, slot.startTime, slot.endTime].some((value, index) => value !== [current.date, currentEndDate, current.startTime, current.endTime][index]);
  }).map((slot) => storedId(slot.id)));
}

function mergeChangedCalendarCollections(mergedData = {}, currentData = {}, incomingData = {}, changedSlotIds = new Set(), finalData = {}, ancestorData = null) {
  const currentActivities = Array.isArray(currentData.activities) ? currentData.activities : [];
  const mergedActivities = Array.isArray(mergedData.activities) ? mergedData.activities : [];
  const incomingActivities = Array.isArray(incomingData.activities) ? incomingData.activities : [];
  const referencesChangedSlot = (item) => changedSlotIds.has(storedId(referencedSlotId(item)));
  const survivingSlotIds = new Set((Array.isArray(finalData.slots) ? finalData.slots : []).map((slot) => storedId(slot?.id)).filter(Boolean));
  const referencesDeletedSlot = (item) => {
    const slotId = storedId(referencedSlotId(item));
    return Boolean(slotId && !survivingSlotIds.has(slotId));
  };
  let affectedActivityIds;
  let activities;
  if (ancestorData) {
    const ancestorActivities = Array.isArray(ancestorData.activities) ? ancestorData.activities : [];
    activities = mergeWithDeletionTombstones(mergedActivities, currentActivities, incomingActivities, ancestorActivities)
      .filter((item) => !referencesDeletedSlot(item));
    affectedActivityIds = new Set(activities.map((item) => storedId(item?.id)).filter(Boolean));
  } else {
    const mergedActivityIds = new Set(mergedActivities.map((item) => storedId(item?.id)).filter(Boolean));
    const currentActivityIds = new Set(currentActivities.map((item) => storedId(item?.id)).filter(Boolean));
    affectedActivityIds = new Set([...currentActivities, ...mergedActivities, ...incomingActivities]
      .filter(referencesChangedSlot)
      .map((item) => storedId(item?.id))
      .filter(Boolean));
    currentActivities.forEach((item) => {
      const id = storedId(item?.id);
      if (id && !mergedActivityIds.has(id)) affectedActivityIds.add(id);
    });
    const activityIsAffected = (item) => referencesChangedSlot(item) || affectedActivityIds.has(storedId(item?.id));
    activities = uniqueItemsById([
      ...currentActivities.filter((item) => !activityIsAffected(item)),
      ...mergedActivities.filter((item) => activityIsAffected(item) || (storedId(item?.id) && !currentActivityIds.has(storedId(item.id))))
    ]).filter((item) => !referencesDeletedSlot(item));
  }

  const activityMap = (items) => new Map(items.filter((item) => hasStoredId(item?.id)).map((item) => [storedId(item.id), item]));
  const assignmentMap = (items) => new Map(items.filter((item) => hasStoredId(item?.id)).map((item) => [storedId(item.id), item]));
  const currentActivityMap = activityMap(currentActivities);
  const mergedActivityMap = activityMap(mergedActivities);
  const incomingActivityMap = activityMap(incomingActivities);
  const currentAssignmentMap = assignmentMap(Array.isArray(currentData.assignments) ? currentData.assignments : []);
  const mergedAssignmentMap = assignmentMap(Array.isArray(mergedData.assignments) ? mergedData.assignments : []);
  const incomingAssignmentMap = assignmentMap(Array.isArray(incomingData.assignments) ? incomingData.assignments : []);
  const referencesAffectedCalendarItem = (item, activitiesById, assignmentsById) => {
    if (referencesChangedSlot(item) || affectedActivityIds.has(storedId(item?.activityId))) return true;
    const activity = activitiesById.get(storedId(item?.activityId));
    if (activity && referencesChangedSlot(activity)) return true;
    const assignment = assignmentsById.get(storedId(item?.assignmentId));
    return Boolean(assignment && changedSlotIds.has(storedId(assignment.slotId)));
  };
  const currentActivityAssignments = Array.isArray(currentData.activityAssignments) ? currentData.activityAssignments : [];
  const mergedActivityAssignments = Array.isArray(mergedData.activityAssignments) ? mergedData.activityAssignments : [];
  const incomingActivityAssignments = Array.isArray(incomingData.activityAssignments) ? incomingData.activityAssignments : [];
  const finalActivityMap = activityMap(activities);
  const finalAssignmentMap = assignmentMap(Array.isArray(finalData.assignments) ? finalData.assignments : []);
  let selectedActivityAssignments;
  if (ancestorData) {
    selectedActivityAssignments = mergeWithDeletionTombstones(
      mergedActivityAssignments,
      currentActivityAssignments,
      incomingActivityAssignments,
      Array.isArray(ancestorData.activityAssignments) ? ancestorData.activityAssignments : []
    );
  } else {
    const mergedActivityAssignmentIds = new Set(mergedActivityAssignments.map((item) => storedId(item?.id)).filter(Boolean));
    const currentActivityAssignmentIds = new Set(currentActivityAssignments.map((item) => storedId(item?.id)).filter(Boolean));
    const directlyAffectedActivityAssignmentIds = new Set([
      ...currentActivityAssignments.filter((item) => referencesAffectedCalendarItem(item, currentActivityMap, currentAssignmentMap)),
      ...mergedActivityAssignments.filter((item) => referencesAffectedCalendarItem(item, mergedActivityMap, mergedAssignmentMap)),
      ...incomingActivityAssignments.filter((item) => referencesAffectedCalendarItem(item, incomingActivityMap, incomingAssignmentMap))
    ].map((item) => storedId(item?.id)).filter(Boolean));
    currentActivityAssignments.forEach((item) => {
      const id = storedId(item?.id);
      if (id && !mergedActivityAssignmentIds.has(id)) directlyAffectedActivityAssignmentIds.add(id);
    });
    const activityAssignmentIsAffected = (item, activitiesById, assignmentsById) => directlyAffectedActivityAssignmentIds.has(storedId(item?.id))
      || referencesAffectedCalendarItem(item, activitiesById, assignmentsById);
    selectedActivityAssignments = uniqueItemsById([
      ...currentActivityAssignments.filter((item) => !activityAssignmentIsAffected(item, currentActivityMap, currentAssignmentMap)),
      ...mergedActivityAssignments.filter((item) => activityAssignmentIsAffected(item, mergedActivityMap, mergedAssignmentMap) || (storedId(item?.id) && !currentActivityAssignmentIds.has(storedId(item.id))))
    ]);
  }
  const activityAssignments = selectedActivityAssignments.filter((item) => {
    const hasActivity = hasStoredId(item?.activityId); const hasAssignment = hasStoredId(item?.assignmentId);
    const activity = hasActivity ? finalActivityMap.get(storedId(item.activityId)) : null;
    const assignment = hasAssignment ? finalAssignmentMap.get(storedId(item.assignmentId)) : null;
    if (hasActivity && !activity) return false;
    if (hasAssignment && !assignment) return false;
    const referencedSlotIds = [referencedSlotId(item), referencedSlotId(activity), assignment?.slotId].map(storedId).filter(Boolean);
    return referencedSlotIds.every((slotId) => survivingSlotIds.has(slotId));
  });
  return { activities, activityAssignments };
}

function mergeScheduleArtifacts(current = [], incoming = [], impact = null) {
  const merged = new Map(current.map((item, index) => [scheduleArtifactKey(item, index), item]));
  const zoomSlots = new Set([...(impact?.changedSlotIds || []), ...(impact?.zoomReviewSlotIds || [])].map(storedId).filter(Boolean));
  const mailPeople = new Set((impact?.affectedPersonIds || []).map(storedId).filter(Boolean));
  incoming.forEach((item, index) => {
    const key = scheduleArtifactKey(item, index);
    const existing = merged.get(key) || {};
    const affected = (item.kind === 'zoom' && zoomSlots.has(storedId(item.slotId))) || (item.kind === 'gmailDraft' && mailPeople.has(storedId(item.personId)));
    const next = affected ? { ...existing, ...item } : { ...item, ...existing };
    if (existing.status === 'superseded' || item.status === 'superseded') {
      next.status = 'superseded';
      next.replacedAt = existing.replacedAt || item.replacedAt;
    }
    merged.set(key, next);
  });
  return [...merged.values()].map((item) => {
    if (item.status === 'superseded') return item;
    if ((item.kind === 'zoom' && zoomSlots.has(storedId(item.slotId))) || (item.kind === 'gmailDraft' && mailPeople.has(storedId(item.personId)))) return { ...item, status: 'stale' };
    return item;
  });
}

function overlayScheduleProjects(baseState, incomingState, scheduleProjects = [], currentState = null, ancestorState = null) {
  const scheduleKeys = ['roles', 'slots', 'activities', 'availability', 'assignments', 'activityAssignments', 'conflicts', 'scheduleRules', 'scheduleSheetInitialized', 'scheduleSheetColumns', 'scheduleCustomValues', 'versions'];
  const hints = new Map(scheduleProjects.map((item) => [storedId(item.projectId), item]));
  const overlay = (baseProject, incomingProject) => {
    const projectId = storedId(incomingProject?.id);
    if (!baseProject || !incomingProject || !hints.has(projectId)) return baseProject;
    const impact = hints.get(projectId);
    const currentProject = projectFromState(currentState, incomingProject.id);
    const ancestorProject = projectFromState(ancestorState, incomingProject.id);
    const projectBase = baseProject;
    const data = { ...projectBase.data };
    const changedSlotIds = new Set((impact.changedSlotIds || []).map(storedId).filter(Boolean));
    let scheduleOverlayRejected = false;
    if (currentProject && impact.scheduleOnly && changedSlotIds.size) {
      if (ancestorProject) {
        data.slots = mergeWithDeletionTombstones(
          Array.isArray(projectBase.data?.slots) ? projectBase.data.slots : [],
          Array.isArray(currentProject.data?.slots) ? currentProject.data.slots : [],
          Array.isArray(incomingProject.data?.slots) ? incomingProject.data.slots : [],
          Array.isArray(ancestorProject.data?.slots) ? ancestorProject.data.slots : []
        );
        const survivingSlotIds = new Set(data.slots.map((slot) => storedId(slot?.id)).filter(Boolean));
        data.assignments = mergeWithDeletionTombstones(
          Array.isArray(projectBase.data?.assignments) ? projectBase.data.assignments : [],
          Array.isArray(currentProject.data?.assignments) ? currentProject.data.assignments : [],
          Array.isArray(incomingProject.data?.assignments) ? incomingProject.data.assignments : [],
          Array.isArray(ancestorProject.data?.assignments) ? ancestorProject.data.assignments : []
        ).filter((assignment) => survivingSlotIds.has(storedId(assignment?.slotId)));
      } else {
        const incomingSlots = new Map((incomingProject.data?.slots || []).map((slot) => [storedId(slot.id), slot]));
        data.slots = (currentProject.data?.slots || []).filter((slot) => !changedSlotIds.has(storedId(slot.id)) || incomingSlots.has(storedId(slot.id))).map((slot) => changedSlotIds.has(storedId(slot.id)) ? incomingSlots.get(storedId(slot.id)) : slot);
        (incomingProject.data?.slots || []).filter((slot) => changedSlotIds.has(storedId(slot.id)) && !data.slots.some((item) => storedId(item.id) === storedId(slot.id))).forEach((slot) => data.slots.push(slot));
        data.assignments = uniqueItemsById([...(currentProject.data?.assignments || []).filter((item) => !changedSlotIds.has(storedId(item.slotId))), ...(incomingProject.data?.assignments || []).filter((item) => changedSlotIds.has(storedId(item.slotId)))]);
      }
      const calendarCollections = mergeChangedCalendarCollections(projectBase.data, currentProject.data, incomingProject.data, changedSlotIds, data, ancestorProject?.data || null);
      data.activities = calendarCollections.activities;
      data.activityAssignments = calendarCollections.activityAssignments;
      const personIds = new Set([...Object.keys(currentProject.data?.availability || {}), ...Object.keys(incomingProject.data?.availability || {})]);
      const survivingSlotIds = new Set((data.slots || []).map((slot) => storedId(slot?.id)).filter(Boolean));
      data.availability = Object.fromEntries([...personIds].map((personId) => {
        const kept = (currentProject.data?.availability?.[personId] || []).filter((slotId) => !changedSlotIds.has(storedId(slotId)));
        const changed = (incomingProject.data?.availability?.[personId] || []).filter((slotId) => changedSlotIds.has(storedId(slotId)));
        return [personId, [...new Map([...kept, ...changed].map((slotId) => [storedId(slotId), slotId])).values()].filter((slotId) => survivingSlotIds.has(storedId(slotId)))];
      }));
      data.scheduleCustomValues = { ...(currentProject.data?.scheduleCustomValues || {}) };
      changedSlotIds.forEach((slotId) => { if (incomingProject.data?.scheduleCustomValues?.[slotId]) data.scheduleCustomValues[slotId] = incomingProject.data.scheduleCustomValues[slotId]; else delete data.scheduleCustomValues[slotId]; });
      Object.keys(data.scheduleCustomValues).forEach((slotId) => { if (!survivingSlotIds.has(storedId(slotId))) delete data.scheduleCustomValues[slotId]; });
      if (hasUnsafeChangedSlotActivity(data, timingChangedSlotIds(data, currentProject.data, changedSlotIds))) {
        scheduleKeys.forEach((key) => { data[key] = currentProject.data?.[key]; });
        scheduleOverlayRejected = true;
      }
    } else if (currentProject && ancestorProject) {
      data.slots = mergeWithDeletionTombstones(
        Array.isArray(projectBase.data?.slots) ? projectBase.data.slots : [],
        Array.isArray(currentProject.data?.slots) ? currentProject.data.slots : [],
        Array.isArray(incomingProject.data?.slots) ? incomingProject.data.slots : [],
        Array.isArray(ancestorProject.data?.slots) ? ancestorProject.data.slots : []
      );
      const survivingSlotIds = new Set(data.slots.map((slot) => storedId(slot?.id)).filter(Boolean));
      data.assignments = mergeWithDeletionTombstones(
        Array.isArray(projectBase.data?.assignments) ? projectBase.data.assignments : [],
        Array.isArray(currentProject.data?.assignments) ? currentProject.data.assignments : [],
        Array.isArray(incomingProject.data?.assignments) ? incomingProject.data.assignments : [],
        Array.isArray(ancestorProject.data?.assignments) ? ancestorProject.data.assignments : []
      ).filter((assignment) => survivingSlotIds.has(storedId(assignment?.slotId)));
      const calendarCollections = mergeChangedCalendarCollections(projectBase.data, currentProject.data, incomingProject.data, changedSlotIds, data, ancestorProject.data);
      data.activities = calendarCollections.activities;
      data.activityAssignments = calendarCollections.activityAssignments;
      if (changedSlotIds.size && hasUnsafeChangedSlotActivity(data, timingChangedSlotIds(data, currentProject.data, changedSlotIds))) {
        scheduleKeys.forEach((key) => { data[key] = currentProject.data?.[key]; });
        scheduleOverlayRejected = true;
      }
    } else if (!currentProject) {
      scheduleKeys.forEach((key) => { data[key] = incomingProject.data?.[key]; });
    }
    data.externalArtifacts = scheduleOverlayRejected
      ? (currentProject.data?.externalArtifacts || projectBase.data?.externalArtifacts || [])
      : mergeScheduleArtifacts(currentProject?.data?.externalArtifacts || projectBase.data?.externalArtifacts, incomingProject.data?.externalArtifacts, impact);
    const useIncomingScheduleState = !scheduleOverlayRejected && impact.scheduleOnly !== false;
    const moduleState = {
      ...projectBase.moduleState,
      schedule: scheduleOverlayRejected
        ? (currentProject.moduleState?.schedule || projectBase.moduleState?.schedule)
        : useIncomingScheduleState ? (incomingProject.moduleState?.schedule || projectBase.moduleState?.schedule) : projectBase.moduleState?.schedule
    };
    if (scheduleOverlayRejected && currentProject.moduleState?.projectCalendar) moduleState.projectCalendar = currentProject.moduleState.projectCalendar;
    ['zoom', 'gmailFlow'].forEach((moduleId) => { if (!scheduleOverlayRejected && incomingProject.moduleState?.[moduleId]?.status === 'stale') moduleState[moduleId] = incomingProject.moduleState[moduleId]; });
    const incomingSteps = new Map((incomingProject.workflow || []).map((step) => [step.id, step]));
    const workflow = (projectBase.workflow || []).map((step) => {
      const incomingStep = incomingSteps.get(step.id);
      if (!incomingStep) return step;
      if (scheduleOverlayRejected && ['schedule', 'projectCalendar'].includes(step.moduleId)) return (currentProject.workflow || []).find((item) => item.id === step.id) || step;
      return (step.moduleId === 'schedule' && useIncomingScheduleState) || (!scheduleOverlayRejected && ['zoom', 'gmailFlow'].includes(step.moduleId) && incomingStep.status === 'stale') ? incomingStep : step;
    });
    return {
      ...projectBase,
      data,
      moduleState,
      workflow,
      counts: scheduleOverlayRejected
        ? (currentProject.counts || projectBase.counts)
        : useIncomingScheduleState ? { ...projectBase.counts, sessions: incomingProject.counts?.sessions ?? projectBase.counts?.sessions, unresolved: incomingProject.counts?.unresolved ?? projectBase.counts?.unresolved } : projectBase.counts,
      updatedAt: scheduleOverlayRejected
        ? (currentProject.updatedAt || projectBase.updatedAt)
        : String(incomingProject.updatedAt || '') > String(projectBase.updatedAt || '') ? incomingProject.updatedAt : projectBase.updatedAt
    };
  };
  const projects = (baseState.projects || []).map((project) => overlay(project, (incomingState.projects || []).find((item) => storedId(item.id) === storedId(project.id))));
  const quickWorkspaces = { ...(baseState.quickWorkspaces || {}) };
  Object.keys(quickWorkspaces).forEach((key) => { quickWorkspaces[key] = overlay(quickWorkspaces[key], incomingState.quickWorkspaces?.[key]); });
  return { ...baseState, projects, quickWorkspaces };
}

function applyDeletionTombstones(state = {}, current = {}, incoming = {}, additionalDeletedLibraryIds = []) {
  const deletedConnectionIds = [...new Set([...(state.deletedConnectionIds || []), ...(current.deletedConnectionIds || []), ...(incoming.deletedConnectionIds || [])])];
  const deletedConnectionIdSet = new Set(deletedConnectionIds);
  const deletedLibraryIds = [...new Set([
    ...storedIds(state.deletedLibraryIds),
    ...storedIds(current.deletedLibraryIds),
    ...storedIds(incoming.deletedLibraryIds),
    ...storedIds(additionalDeletedLibraryIds),
    ...inferredLibraryDeletionIds(state),
    ...inferredLibraryDeletionIds(current),
    ...inferredLibraryDeletionIds(incoming)
  ])];
  const knownLibraryIds = [...new Set([
    ...storedIds(state.knownLibraryIds),
    ...storedIds(current.knownLibraryIds),
    ...storedIds(incoming.knownLibraryIds),
    ...deletedLibraryIds,
    ...libraryItemIds(state),
    ...libraryItemIds(current),
    ...libraryItemIds(incoming)
  ])];
  const deletedLibraryIdSet = new Set(deletedLibraryIds);
  const library = { ...(state.library || {}) };
  LIBRARY_COLLECTION_KEYS.forEach((key) => {
    library[key] = (library[key] || []).filter((item) => item?.builtin === true || !deletedLibraryIdSet.has(storedId(item?.id)));
  });
  const originalPreferences = state.preferences || {};
  const originalGlobalDefaults = originalPreferences.globalDefaultConnectionIds || {};
  const globalDefaultConnectionIds = Object.fromEntries(Object.entries(originalGlobalDefaults)
    .map(([type, connectionId]) => [type, deletedConnectionIdSet.has(connectionId) ? null : connectionId]));
  const removedWorkspaceDrive = deletedConnectionIdSet.has(originalPreferences.workspaceDriveConnectionId);
  const preferences = {
    ...originalPreferences,
    workspaceDriveConnectionId: removedWorkspaceDrive ? null : (originalPreferences.workspaceDriveConnectionId || null),
    globalDefaultConnectionIds
  };
  if (removedWorkspaceDrive && preferences.storageMode === 'drive') preferences.storageMode = 'local';

  const reviewedAt = state.updatedAt || incoming.updatedAt || current.updatedAt || new Date().toISOString();
  const markModuleForReview = (project, moduleId, reason) => {
    project.moduleState = { ...(project.moduleState || {}) };
    project.moduleState[moduleId] = { ...(project.moduleState[moduleId] || {}), status: 'needsReview', summary: reason, updatedAt: reviewedAt };
    if (Array.isArray(project.workflow)) {
      project.workflow = project.workflow.map((step) => (step.moduleId === moduleId || step.type === moduleId)
        ? { ...step, status: 'needsReview', updatedAt: reviewedAt }
        : step);
    }
  };
  const removeDeletedProjectBindings = (sourceProject) => {
    if (!sourceProject || typeof sourceProject !== 'object') return sourceProject;
    const project = { ...sourceProject };
    const originalProjectDefaults = sourceProject.settings?.defaultConnectionIds || {};
    const effectiveConnectionId = (type) => originalProjectDefaults[type] || originalGlobalDefaults[type] || null;
    const deletedEffectiveFormsId = effectiveConnectionId('forms');
    const deletedEffectiveZoomId = effectiveConnectionId('zoom');
    const defaultConnectionIds = Object.fromEntries(Object.entries(originalProjectDefaults)
      .map(([type, connectionId]) => [type, deletedConnectionIdSet.has(connectionId) ? null : connectionId]));
    project.settings = { ...(sourceProject.settings || {}), defaultConnectionIds };
    if (!sourceProject.data || typeof sourceProject.data !== 'object') return project;

    project.data = { ...sourceProject.data };
    let gmailNeedsReview = false;
    let zoomNeedsReview = false;
    let formsNeedsReview = false;
    const affectedZoomSlotIds = new Set();
    project.data.slots = (sourceProject.data.slots || []).map((slot) => {
      const routedConnectionId = slot.zoomConnectionId || deletedEffectiveZoomId;
      if (!deletedConnectionIdSet.has(routedConnectionId)) return slot;
      affectedZoomSlotIds.add(slot.id);
      zoomNeedsReview = true;
      return slot.zoomConnectionId ? { ...slot, zoomConnectionId: null } : slot;
    });
    project.data.externalArtifacts = (sourceProject.data.externalArtifacts || []).map((artifact) => {
      const directConnectionDeleted = deletedConnectionIdSet.has(artifact.connectionId);
      const replacementConnectionDeleted = deletedConnectionIdSet.has(artifact.replacementConnectionId);
      if (!directConnectionDeleted && !replacementConnectionDeleted) return artifact;
      const cleanedArtifact = replacementConnectionDeleted ? { ...artifact, replacementConnectionId: null } : artifact;
      if (!directConnectionDeleted) return cleanedArtifact;
      if (artifact.kind === 'gmailDraft') {
        gmailNeedsReview = true;
        if (artifact.status === 'superseded') return { ...cleanedArtifact, connectionId: null };
        return {
          ...cleanedArtifact,
          connectionId: null,
          status: 'superseded',
          replacedAt: artifact.replacedAt || reviewedAt,
          replacementReason: '삭제된 Gmail 계정 연결의 초안이므로 새 계정에서 다시 확인해주세요.'
        };
      }
      if (artifact.kind === 'zoom') {
        zoomNeedsReview = true;
        if (artifact.slotId) affectedZoomSlotIds.add(artifact.slotId);
        return {
          ...cleanedArtifact,
          connectionId: null,
          status: 'superseded',
          replacedAt: artifact.replacedAt || reviewedAt,
          replacementReason: artifact.replacementReason || '삭제된 Zoom 계정 연결의 일정이므로 새 계정에서 다시 확인해주세요.'
        };
      }
      return { ...cleanedArtifact, connectionId: null };
    });
    if (affectedZoomSlotIds.size) {
      const affectedPersonIds = new Set((sourceProject.data.assignments || [])
        .filter((assignment) => affectedZoomSlotIds.has(assignment.slotId))
        .map((assignment) => assignment.personId)
        .filter(Boolean));
      project.data.externalArtifacts = project.data.externalArtifacts.map((artifact) => {
        if (artifact.kind !== 'gmailDraft' || artifact.status === 'superseded' || !affectedPersonIds.has(artifact.personId)) return artifact;
        gmailNeedsReview = true;
        return { ...artifact, status: 'stale', replacementReason: 'Zoom 계정 연결 삭제 후 안내 메일의 회의 링크 재확인 필요' };
      });
    }
    if (sourceProject.data.forms && typeof sourceProject.data.forms === 'object') {
      const inheritedFormsConnectionDeleted = deletedConnectionIdSet.has(deletedEffectiveFormsId);
      const linkedForms = (sourceProject.data.forms.linkedForms || []).map((linked) => {
        if (!deletedConnectionIdSet.has(linked.connectionId) && !(inheritedFormsConnectionDeleted && !linked.connectionId)) return linked;
        formsNeedsReview = true;
        return {
          ...linked,
          connectionId: null,
          needsReview: true,
          reviewReason: '삭제된 Google Forms 계정 연결을 새 계정에서 다시 확인해주세요.',
          connectionReviewRequired: true,
          connectionReviewReason: '삭제된 Google Forms 계정 연결을 새 계정에서 다시 확인해주세요.'
        };
      });
      project.data.forms = { ...sourceProject.data.forms, linkedForms };
    }
    if (gmailNeedsReview) markModuleForReview(project, 'gmailFlow', '삭제된 Gmail 계정 연결 항목 재확인 필요');
    if (zoomNeedsReview) markModuleForReview(project, 'zoom', '삭제된 Zoom 계정 연결 항목 재확인 필요');
    if (formsNeedsReview) markModuleForReview(project, 'forms', '삭제된 Google Forms 계정 연결 재확인 필요');
    return project;
  };
  return {
    ...state,
    connections: (state.connections || []).filter((item) => !deletedConnectionIds.includes(item.id)),
    preferences,
    projects: (state.projects || []).map(removeDeletedProjectBindings),
    quickWorkspaces: Object.fromEntries(Object.entries(state.quickWorkspaces || {})
      .map(([key, project]) => [key, removeDeletedProjectBindings(project)])),
    library,
    deletedConnectionIds,
    knownLibraryIds,
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
  const pulledGlobalDefaults = next.preferences?.globalDefaultConnectionIds || {};
  const localGlobalDefaults = currentState.preferences?.globalDefaultConnectionIds || {};
  const globalDefaultConnectionIds = {};
  ['forms', 'gmail', 'zoom'].forEach((type) => {
    const pulledId = pulledGlobalDefaults[type] || null;
    const localId = localGlobalDefaults[type] || null;
    globalDefaultConnectionIds[type] = pulledId
      ? (resolveLocalConnectionId(pulledId, type) || validLocalConnectionId(localId, type) || null)
      : (validLocalConnectionId(localId, type) || null);
  });
  next.preferences = { ...(next.preferences || {}), workspaceDriveConnectionId, globalDefaultConnectionIds };
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
    const pulledFormsConnections = pulledConnections.filter((connection) => connection.type === 'forms');
    const pulledInheritedFormsId = pulledDefaults.forms || pulledGlobalDefaults.forms || (pulledFormsConnections.length === 1 ? pulledFormsConnections[0].id : null);
    const mappedPulledInheritedFormsId = pulledInheritedFormsId ? resolveLocalConnectionId(pulledInheritedFormsId, 'forms') : null;
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
        if (!linked.connectionId) {
          if (mappedPulledInheritedFormsId) return { ...linked, connectionId: mappedPulledInheritedFormsId };
          formsNeedsReview = true;
          return { ...linked, connectionId: null, needsReview: true, reviewReason: '다른 PC에서 상속한 Google Forms 계정을 이 PC에서 확인해주세요.', connectionReviewRequired: true, connectionReviewReason: '다른 PC에서 상속한 Google Forms 계정을 이 PC에서 확인해주세요.' };
        }
        const mappedId = resolveLocalConnectionId(linked.connectionId, 'forms');
        if (mappedId) return { ...linked, connectionId: mappedId };
        formsNeedsReview = true;
        return { ...linked, connectionId: null, needsReview: true, reviewReason: '다른 PC의 Google Forms 계정 연결을 이 PC에서 확인해주세요.', connectionReviewRequired: true, connectionReviewReason: '다른 PC의 Google Forms 계정 연결을 이 PC에서 확인해주세요.' };
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
    const deletedLibraryIds = libraryDeletionIdsSinceAncestor(baseState, current, incoming);
    return applyDeletionTombstones(threeWayMerge(baseState, current, incoming), current, incoming, deletedLibraryIds);
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
  LIBRARY_COLLECTION_KEYS.forEach((key) => { library[key] = mergeById(current.library?.[key], incoming.library?.[key]).filter((item) => !deletedLibraryIds.includes(item.id)); });
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
