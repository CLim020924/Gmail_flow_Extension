(function exposeProjectSessionSchedulerCore(root, factory) {
  const api = factory(root?.OperationsCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProjectSessionSchedulerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (defaultOperations) => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_VIEW_SETTINGS = Object.freeze({ view: 'week', dayStart: '08:00', dayEnd: '20:00', stepMinutes: 30 });
  const SESSION_STATUSES = new Set(['draft', 'active', 'confirmed', 'completed', 'cancelled', 'archived']);
  const PLACEMENT_STATUSES = new Set(['draft', 'confirmed', 'changed', 'cancelled']);
  const VIEW_TYPES = new Set(['day', 'week', 'month']);

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function clean(value) { return String(value ?? '').trim(); }
  function cleanId(value) {
    const id = clean(value);
    return id && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id) ? id : '';
  }

  function uniqueIds(values = []) { return [...new Set((Array.isArray(values) ? values : values instanceof Set ? [...values] : []).map(cleanId).filter(Boolean))]; }
  function normalizedIdSet(values) { return new Set(uniqueIds(values)); }
  function normalizeUsedIdSet(values) {
    const target = values instanceof Set ? values : new Set();
    const normalized = uniqueIds(target);
    target.clear(); normalized.forEach((id) => target.add(id));
    return target;
  }
  function firstCleanId(...values) {
    for (const value of values) {
      const id = cleanId(value);
      if (id) return id;
    }
    return '';
  }

  function mergedLegacyViewSettings(...sources) {
    const merged = Object.assign({}, ...sources.filter((source) => source && typeof source === 'object' && !Array.isArray(source)));
    return {
      ...(merged.view || merged.defaultView ? { view: merged.view || merged.defaultView } : {}),
      ...(merged.dayStart || merged.displayStartTime || merged.startTime ? { dayStart: merged.dayStart || merged.displayStartTime || merged.startTime } : {}),
      ...(merged.dayEnd || merged.displayEndTime || merged.endTime ? { dayEnd: merged.dayEnd || merged.displayEndTime || merged.endTime } : {}),
      ...(merged.stepMinutes || merged.intervalMinutes ? { stepMinutes: Number(merged.stepMinutes || merged.intervalMinutes) } : {})
    };
  }

  function timeToMinutes(value) {
    const match = clean(value).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function minutesToTime(value) {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function daysInMonth(year, month) {
    if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function dateParts(value) {
    const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : null;
  }

  function isValidDate(value) { return Boolean(dateParts(value)); }
  function dateMs(value) { const parts = dateParts(value); return parts ? Date.UTC(parts.year, parts.month - 1, parts.day) : null; }
  function formatDate(date) { return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`; }

  function addDays(value, amount) {
    const start = dateMs(value); const offset = Number(amount);
    return start == null || !Number.isInteger(offset) ? null : formatDate(new Date(start + offset * DAY_MS));
  }

  function dateRange(startDate, endDate = startDate, options = {}) {
    const start = clean(startDate); const end = clean(endDate); const limit = Math.max(1, Math.min(10000, Number(options.limit) || 3660));
    if (!isValidDate(start) || !isValidDate(end) || end < start) return [];
    const result = []; let cursor = start;
    while (cursor && cursor <= end && result.length < limit) { result.push(cursor); cursor = addDays(cursor, 1); }
    return result.at(-1) === end ? result : [];
  }

  function nowIso(value) {
    const resolved = typeof value === 'function' ? value() : value;
    const date = resolved instanceof Date ? resolved : new Date(resolved || Date.now());
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  function generatedId(prefix, idFactory, used = new Set()) {
    used = normalizeUsedIdSet(used);
    let id = cleanId(typeof idFactory === 'function' ? idFactory(prefix) : '');
    if (!id) id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id)) { used.add(id); return id; }
    let index = 2; while (used.has(`${id}-${index}`)) index += 1;
    id = `${id}-${index}`; used.add(id); return id;
  }

  function normalizeViewSettings(input = {}, fallback = DEFAULT_VIEW_SETTINGS) {
    const base = { ...DEFAULT_VIEW_SETTINGS, ...(fallback || {}) }; const source = input && typeof input === 'object' ? input : {};
    const view = VIEW_TYPES.has(source.view) ? source.view : (VIEW_TYPES.has(base.view) ? base.view : DEFAULT_VIEW_SETTINGS.view);
    let dayStart = timeToMinutes(source.dayStart) == null ? base.dayStart : clean(source.dayStart);
    let dayEnd = timeToMinutes(source.dayEnd) == null ? base.dayEnd : clean(source.dayEnd);
    if (timeToMinutes(dayStart) == null) dayStart = DEFAULT_VIEW_SETTINGS.dayStart;
    if (timeToMinutes(dayEnd) == null || timeToMinutes(dayEnd) <= timeToMinutes(dayStart)) {
      dayStart = DEFAULT_VIEW_SETTINGS.dayStart; dayEnd = DEFAULT_VIEW_SETTINGS.dayEnd;
    }
    const requestedStep = Number(source.stepMinutes); const fallbackStep = Number(base.stepMinutes);
    const stepMinutes = Number.isInteger(requestedStep) && requestedStep >= 5 && requestedStep <= 240
      ? requestedStep
      : Number.isInteger(fallbackStep) && fallbackStep >= 5 && fallbackStep <= 240 ? fallbackStep : DEFAULT_VIEW_SETTINGS.stepMinutes;
    return { view, dayStart, dayEnd, stepMinutes };
  }

  function viewSettingsBlockers(input = {}) {
    const blockers = [];
    if (input.view != null && !VIEW_TYPES.has(input.view)) blockers.push({ code: 'invalidView', message: '보기 방식은 일·주·월 중에서 선택해주세요.' });
    const start = input.dayStart == null ? null : timeToMinutes(input.dayStart); const end = input.dayEnd == null ? null : timeToMinutes(input.dayEnd);
    if (input.dayStart != null && start == null) blockers.push({ code: 'invalidDayStart', message: '하루 시작 시간을 다시 선택해주세요.' });
    if (input.dayEnd != null && end == null) blockers.push({ code: 'invalidDayEnd', message: '하루 종료 시간을 다시 선택해주세요.' });
    if (start != null && end != null && end <= start) blockers.push({ code: 'invalidDayRange', message: '하루 종료 시간은 시작 시간보다 늦어야 합니다.' });
    if (input.stepMinutes != null && (!Number.isInteger(Number(input.stepMinutes)) || Number(input.stepMinutes) < 5 || Number(input.stepMinutes) > 240)) blockers.push({ code: 'invalidStepMinutes', message: '시간 간격은 5분부터 240분 사이로 설정해주세요.' });
    return blockers;
  }

  function timeTicks(settings = DEFAULT_VIEW_SETTINGS) {
    const normalized = normalizeViewSettings(settings); const start = timeToMinutes(normalized.dayStart); const end = timeToMinutes(normalized.dayEnd); const result = [];
    for (let value = start, index = 0; value < end; value += normalized.stepMinutes, index += 1) result.push({ index, minutes: value, time: minutesToTime(value), isEnd: false });
    if (!result.length || result.at(-1).minutes !== end) result.push({ index: result.length, minutes: end, time: minutesToTime(end), isEnd: true });
    else result.at(-1).isEnd = true;
    return result;
  }

  function normalizeSession(input = {}, context = {}) {
    const source = input && typeof input === 'object' ? input : {}; const startDate = clean(source.startDate); const endDate = clean(source.endDate || startDate);
    if (!isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) return null;
    const usedIds = normalizeUsedIdSet(context.usedIds); const fallbackId = context.index == null ? '' : `calendar-session-${Number(context.index) + 1}`;
    let id = cleanId(source.id) || cleanId(fallbackId) || generatedId('calendar-session', context.idFactory, usedIds);
    if (usedIds.has(id)) id = generatedId(id, () => id, usedIds); else usedIds.add(id);
    const stamp = nowIso(context.now); const createdAt = clean(source.createdAt) || stamp;
    return {
      ...clone(source),
      id,
      title: clean(source.title) || '이름 없는 세션',
      startDate,
      endDate,
      status: SESSION_STATUSES.has(source.status) ? source.status : 'active',
      color: clean(source.color) || '#2879b8',
      description: clean(source.description),
      viewSettings: normalizeViewSettings(source.viewSettings),
      createdAt,
      updatedAt: clean(source.updatedAt) || createdAt
    };
  }

  function normalizeGroup(input = {}, context = {}) {
    const source = input && typeof input === 'object' ? input : {}; const sessionId = cleanId(source.sessionId); const sessionIds = context.sessionIds instanceof Set ? normalizedIdSet(context.sessionIds) : context.sessionIds;
    if (!sessionId || (sessionIds instanceof Set && !sessionIds.has(sessionId))) return null;
    const usedIds = normalizeUsedIdSet(context.usedIds); const fallbackId = context.index == null ? '' : `schedule-group-${Number(context.index) + 1}`;
    let id = cleanId(source.id) || cleanId(fallbackId) || generatedId('schedule-group', context.idFactory, usedIds);
    if (usedIds.has(id)) id = generatedId(id, () => id, usedIds); else usedIds.add(id);
    const personIds = context.personIds instanceof Set ? normalizedIdSet(context.personIds) : context.personIds; const roleIds = context.roleIds instanceof Set ? normalizedIdSet(context.roleIds) : context.roleIds; const seenPeople = new Set(); const members = []; const deletedMemberIds = new Set(uniqueIds(source.deletedMemberIds));
    const legacyMembers = (Array.isArray(source.memberIds) ? source.memberIds : []).map((personId) => ({ personId, roleId: source.roleByPersonId?.[personId] }));
    const memberSource = Array.isArray(source.members) && source.members.length ? source.members : legacyMembers;
    memberSource.forEach((member) => {
      const personId = cleanId(member?.personId); const roleId = cleanId(member?.roleId);
      if (!personId || !roleId || deletedMemberIds.has(personId) || seenPeople.has(personId)) return;
      if (personIds instanceof Set && !personIds.has(personId)) return;
      if (roleIds instanceof Set && !roleIds.has(roleId)) return;
      seenPeople.add(personId); members.push({ ...(member && typeof member === 'object' ? clone(member) : {}), id: personId, personId, roleId });
    });
    const stamp = nowIso(context.now); const createdAt = clean(source.createdAt) || stamp;
    return { ...clone(source), id, sessionId, name: clean(source.name) || '이름 없는 그룹', color: clean(source.color) || '#66717e', description: clean(source.description), members, deletedMemberIds: [...deletedMemberIds], createdAt, updatedAt: clean(source.updatedAt) || createdAt };
  }

  function projectFromContext(context = {}) { return context?.project && typeof context.project === 'object' ? context.project : context; }
  function modelSource(context = {}) {
    const project = projectFromContext(context); return context?.model || project?.data?.extensionData?.projectCalendar || {};
  }

  function normalizeModel(context = {}) {
    const project = projectFromContext(context); const source = modelSource(context); const people = Array.isArray(context.people) ? context.people : (project?.data?.people || []); const roles = Array.isArray(context.roles) ? context.roles : (project?.data?.roles || []);
    const personIds = new Set(people.filter((person) => person?.active !== false).map((person) => cleanId(person?.id)).filter(Boolean));
    const roleIds = new Set(roles.filter((role) => role?.active !== false).map((role) => cleanId(role?.id)).filter(Boolean));
    const deletedSessionIds = uniqueIds(source.deletedSessionIds); const deletedGroupIds = uniqueIds(source.deletedGroupIds);
    const deletedSessionSet = new Set(deletedSessionIds); const deletedGroupSet = new Set(deletedGroupIds); const sessionUsedIds = new Set();
    const sessions = (Array.isArray(source.sessions) ? source.sessions : []).map((session, index) => {
      const legacySettings = mergedLegacyViewSettings(source.settings, source.settingsBySession?.[cleanId(session?.id)], session?.settings, session?.viewSettings);
      return normalizeSession({ ...session, viewSettings: legacySettings }, { index, usedIds: sessionUsedIds, now: context.now, idFactory: context.idFactory });
    }).filter((session) => session && !deletedSessionSet.has(session.id));
    const sessionIds = new Set(sessions.map((session) => session.id)); const groupUsedIds = new Set();
    const groups = (Array.isArray(source.groups) ? source.groups : []).map((group, index) => normalizeGroup(group, { index, usedIds: groupUsedIds, sessionIds, personIds, roleIds, now: context.now, idFactory: context.idFactory })).filter((group) => group && !deletedGroupSet.has(group.id));
    return { ...(source && typeof source === 'object' && !Array.isArray(source) ? clone(source) : {}), schemaVersion: SCHEMA_VERSION, deletedSessionIds, deletedGroupIds, sessions, groups };
  }

  function sessionDateRange(session, options = {}) { return session ? dateRange(session.startDate, session.endDate, options) : []; }

  function contextSlots(context = {}) { const project = projectFromContext(context); return Array.isArray(context.slots) ? context.slots : (project?.data?.slots || []); }
  function sessionSlots(context = {}, sessionId) {
    const id = cleanId(typeof sessionId === 'object' ? sessionId?.sessionId : sessionId);
    const project = projectFromContext(context); const model = normalizeModel({ project, model: context.model, people: context.people, roles: context.roles, now: context.now }); const groups = new Map(model.groups.map((group) => [group.id, group]));
    return contextSlots(context).filter((slot) => { const group = groups.get(cleanId(slot?.scheduleGroupId)); return cleanId(slot?.calendarSessionId) === id && group?.sessionId === id; }).slice().sort((left, right) => [left.date || '', left.startTime || '', left.endTime || '', left.id || ''].join('|').localeCompare([right.date || '', right.startTime || '', right.endTime || '', right.id || ''].join('|')));
  }

  function unassignedGroups(context = {}, sessionId) {
    const project = projectFromContext(context); const model = normalizeModel({ project, model: context.model, people: context.people, roles: context.roles, now: context.now }); const id = cleanId(sessionId);
    const placed = new Set(sessionSlots({ project, slots: context.slots }, id).filter((slot) => slot.status !== 'cancelled').map((slot) => cleanId(slot.scheduleGroupId)).filter(Boolean));
    return model.groups.filter((group) => group.sessionId === id && !placed.has(group.id));
  }

  function slotSegmentsForDate(slot, date) {
    const startDate = clean(slot.date); const endDate = clean(slot.endDate || startDate); if (!isValidDate(startDate) || !isValidDate(endDate) || date < startDate || date > endDate) return null;
    const start = date === startDate ? timeToMinutes(slot.startTime) : 0; const end = date === endDate ? timeToMinutes(slot.endTime) : 24 * 60;
    return start == null || end == null || end <= start ? null : { start, end };
  }

  function sameTimeLanes(context = {}, options = {}) {
    const sessionId = cleanId(options && typeof options === 'object' ? options.sessionId : options); const requestedDate = options && typeof options === 'object' ? clean(options.date) : '';
    const source = sessionSlots(context, sessionId).filter((slot) => slot.status !== 'cancelled'); const dates = requestedDate ? [requestedDate] : [...new Set(source.flatMap((slot) => dateRange(slot.date, slot.endDate || slot.date, { limit: 370 })))]; const output = [];
    dates.sort().forEach((date) => {
      const entries = source.map((slot) => ({ slot, range: slotSegmentsForDate(slot, date) })).filter((item) => item.range).sort((left, right) => left.range.start - right.range.start || left.range.end - right.range.end || clean(left.slot.id).localeCompare(clean(right.slot.id)));
      let cluster = []; let clusterEnd = -1; let laneEnds = [];
      const flush = () => { const laneCount = Math.max(1, ...cluster.map((entry) => entry.lane + 1)); cluster.forEach((entry) => output.push({ ...entry, laneCount })); cluster = []; clusterEnd = -1; laneEnds = []; };
      entries.forEach(({ slot, range }) => {
        if (cluster.length && range.start >= clusterEnd) flush();
        let lane = laneEnds.findIndex((end) => end <= range.start); if (lane < 0) { lane = laneEnds.length; laneEnds.push(range.end); } else laneEnds[lane] = range.end;
        clusterEnd = Math.max(clusterEnd, range.end); cluster.push({ slotId: cleanId(slot.id), sessionId: cleanId(slot.calendarSessionId), groupId: cleanId(slot.scheduleGroupId), date, startMinutes: range.start, endMinutes: range.end, lane, slot });
      });
      if (cluster.length) flush();
    });
    return output;
  }

  function actionType(value) {
    const aliases = {
      'session/create': 'session:add', 'session/add': 'session:add', 'session.add': 'session:add', addSession: 'session:add',
      'session/update': 'session:update', 'session.update': 'session:update', updateSession: 'session:update',
      'session/remove': 'session:remove', 'session/delete': 'session:remove', 'session.remove': 'session:remove', removeSession: 'session:remove',
      'session/settings': 'session:settings', 'session/update-settings': 'session:settings', 'session.settings': 'session:settings', updateSessionSettings: 'session:settings',
      'group/create': 'group:add', 'group/add': 'group:add', 'group.add': 'group:add', addGroup: 'group:add',
      'group/update': 'group:update', 'group.update': 'group:update', updateGroup: 'group:update',
      'group/remove': 'group:remove', 'group/delete': 'group:remove', 'group.remove': 'group:remove', removeGroup: 'group:remove',
      'placement/create': 'placement:add', 'placement/add': 'placement:add', 'placement.add': 'placement:add', addPlacement: 'placement:add',
      'placement/update': 'placement:move', 'placement/move': 'placement:move', 'placement.update': 'placement:move', 'placement.move': 'placement:move', movePlacement: 'placement:move',
      'placement/remove': 'placement:remove', 'placement/delete': 'placement:remove', 'placement.remove': 'placement:remove', removePlacement: 'placement:remove'
    };
    const raw = clean(value); return aliases[raw] || raw;
  }

  function emptyImpact(extra = {}) { return { changedSlotIds: [], zoomReviewSlotIds: [], affectedPersonIds: [], changedSessionIds: [], changedGroupIds: [], removedSlotIds: [], removedAssignmentIds: [], removedActivityIds: [], removedActivityAssignmentIds: [], ...extra }; }
  function selection(sessionId = null, groupId = null, slotId = null) { return { sessionId: cleanId(sessionId) || null, groupId: cleanId(groupId) || null, slotId: cleanId(slotId) || null }; }

  function ensureData(project) {
    const data = clone(project?.data || {}); data.people = Array.isArray(data.people) ? data.people : []; data.roles = Array.isArray(data.roles) ? data.roles : []; data.slots = Array.isArray(data.slots) ? data.slots : []; data.assignments = Array.isArray(data.assignments) ? data.assignments : []; data.activities = Array.isArray(data.activities) ? data.activities : []; data.activityAssignments = Array.isArray(data.activityAssignments) ? data.activityAssignments : []; data.availability = data.availability && typeof data.availability === 'object' ? data.availability : {}; data.scheduleCustomValues = data.scheduleCustomValues && typeof data.scheduleCustomValues === 'object' ? data.scheduleCustomValues : {}; data.externalArtifacts = Array.isArray(data.externalArtifacts) ? data.externalArtifacts : []; data.extensionData = data.extensionData && typeof data.extensionData === 'object' ? data.extensionData : {}; return data;
  }

  function putModel(data, model) { data.extensionData = { ...data.extensionData, projectCalendar: model }; }
  function projectWithData(project, data) { return { ...(project || {}), data }; }

  function repairPlacementReferences(data, model) {
    const groups = new Map(model.groups.map((group) => [group.id, group]));
    const repairedSlots = new Map();
    data.slots = data.slots.map((slot) => {
      const groupId = cleanId(slot?.scheduleGroupId); const sessionId = cleanId(slot?.calendarSessionId); const group = groups.get(groupId);
      if (group) {
        const next = { ...slot, scheduleGroupId: group.id, calendarSessionId: group.sessionId };
        repairedSlots.set(cleanId(next.id), group);
        return next;
      }
      if (!groupId && !sessionId) return slot;
      const next = { ...slot }; delete next.scheduleGroupId; delete next.calendarSessionId; return next;
    });
    data.assignments = data.assignments.map((assignment) => {
      const group = repairedSlots.get(cleanId(assignment?.slotId));
      if (group && (cleanId(assignment?.scheduleGroupId) === group.id || cleanId(assignment?.calendarSessionId) === group.sessionId)) return { ...assignment, scheduleGroupId: group.id, calendarSessionId: group.sessionId };
      if (!group && (assignment?.scheduleGroupId != null || assignment?.calendarSessionId != null)) { const next = { ...assignment }; delete next.scheduleGroupId; delete next.calendarSessionId; return next; }
      return assignment;
    });
  }

  function finish(project, before, data, model, meta, operations) {
    putModel(data, model);
    if (operations?.collectScheduleConflicts) data.conflicts = operations.collectScheduleConflicts(projectWithData(project, data));
    const dependencyImpact = operations?.diffScheduleDependencies ? operations.diffScheduleDependencies({ beforeSlots: before.slots, beforeAssignments: before.assignments, afterSlots: data.slots, afterAssignments: data.assignments }) : emptyImpact();
    const impact = emptyImpact({ ...dependencyImpact, ...(meta.impact || {}) });
    ['changedSlotIds', 'zoomReviewSlotIds', 'affectedPersonIds', 'changedSessionIds', 'changedGroupIds', 'removedSlotIds', 'removedAssignmentIds', 'removedActivityIds', 'removedActivityAssignmentIds'].forEach((key) => { impact[key] = uniqueIds([...(dependencyImpact[key] || []), ...(meta.impact?.[key] || [])]); });
    return { ok: true, data, model, impact, selection: meta.selection || selection(), blockers: [], message: meta.message || '변경 내용을 반영했습니다.' };
  }

  function failed(data, model, blockers, message, selected = selection()) { return { ok: false, data, model, impact: emptyImpact(), selection: selected, blockers, message: message || blockers[0]?.message || '변경 내용을 적용하지 못했습니다.' }; }

  function operationBlocker() { return { code: 'operationsUnavailable', message: '일정 안전 검사를 실행할 수 없습니다. 프로그램을 다시 시작해주세요.' }; }
  function planInput(project, data, changeSet) { return { people: data.people, roles: data.roles, slots: data.slots, assignments: data.assignments, activities: data.activities, availability: data.availability, rules: data.scheduleRules || {}, timeZone: project?.settings?.timezone || 'Asia/Seoul', changeSet }; }

  function placementBlockers(session, candidate, operations) {
    const blockers = [];
    if (!isValidDate(candidate.date) || !isValidDate(candidate.endDate || candidate.date) || (candidate.endDate || candidate.date) < candidate.date) blockers.push({ code: 'invalidPlacementDate', message: '배치 날짜 범위를 다시 선택해주세요.' });
    else if (candidate.date < session.startDate || (candidate.endDate || candidate.date) > session.endDate) blockers.push({ code: 'placementOutsideSession', message: '그룹 일정은 선택한 세션 기간 안에 배치해주세요.' });
    const start = timeToMinutes(candidate.startTime); const end = timeToMinutes(candidate.endTime);
    if (start == null || end == null || ((candidate.endDate || candidate.date) === candidate.date && end <= start)) blockers.push({ code: 'invalidPlacementTime', message: '그룹의 시작·종료 시간을 다시 선택해주세요.' });
    if (!candidate.endDate || candidate.endDate === candidate.date) {
      const settings = normalizeViewSettings(session.viewSettings); const visibleStart = timeToMinutes(settings.dayStart); const visibleEnd = timeToMinutes(settings.dayEnd);
      if (start != null && end != null && (start < visibleStart || end > visibleEnd)) blockers.push({ code: 'placementOutsideViewTime', message: `${settings.dayStart}–${settings.dayEnd} 안에서 그룹 시간을 선택해주세요.` });
    }
    if (operations?.validateScheduleSlot) operations.validateScheduleSlot(candidate).forEach((issue) => blockers.push({ code: issue.code || 'invalidPlacement', message: issue.message, field: issue.field }));
    if (operations?.calendarEventInstants && !operations.calendarEventInstants(candidate, 'UTC').valid) blockers.push({ code: 'invalidPlacementInstant', message: '계산할 수 없는 날짜·시간입니다. 다른 시간을 선택해주세요.' });
    return [...new Map(blockers.map((item) => [`${item.code}|${item.message}`, item])).values()];
  }

  function groupMemberBlockers(source, data) {
    const members = Array.isArray(source?.members) ? source.members : (Array.isArray(source?.memberIds) ? source.memberIds.map((personId) => ({ personId, roleId: source.roleByPersonId?.[personId] })) : []);
    const people = new Set(data.people.filter((person) => person.active !== false).map((person) => cleanId(person.id)));
    const roles = new Set(data.roles.filter((role) => role.active !== false).map((role) => cleanId(role.id)));
    const blockers = [];
    members.forEach((member) => {
      const personId = cleanId(member?.personId); const roleId = cleanId(member?.roleId);
      if (!personId || !people.has(personId)) blockers.push({ code: 'invalidGroupPerson', message: '그룹에 포함할 사람을 명단에서 다시 선택해주세요.' });
      else if (!roleId || !roles.has(roleId)) blockers.push({ code: 'missingMemberRole', personId, message: '선택한 사람마다 역할을 하나 지정해주세요.' });
    });
    return [...new Map(blockers.map((item) => [`${item.code}|${item.personId || ''}`, item])).values()];
  }

  function lockedCascadeBlockers(data, slotIds) {
    const ids = new Set(uniqueIds(slotIds)); const activityIds = new Set(data.activities.filter((activity) => ids.has(firstCleanId(activity.eventId, activity.slotId))).map((activity) => cleanId(activity.id)).filter(Boolean));
    const assignmentIds = new Set(data.assignments.filter((assignment) => ids.has(cleanId(assignment.slotId))).map((assignment) => cleanId(assignment.id)).filter(Boolean)); const blockers = [];
    data.slots.filter((slot) => ids.has(cleanId(slot.id)) && slot.locked).forEach((slot) => blockers.push({ code: 'lockedSlot', slotId: cleanId(slot.id), message: `“${slot.label || '일정'}”이 잠겨 있어 먼저 잠금을 풀어야 합니다.` }));
    data.assignments.filter((item) => assignmentIds.has(cleanId(item.id)) && item.locked).forEach((item) => blockers.push({ code: 'lockedAssignment', assignmentId: cleanId(item.id), message: '잠긴 배정이 있어 먼저 잠금을 풀어야 합니다.' }));
    data.activities.filter((item) => activityIds.has(cleanId(item.id)) && item.locked).forEach((item) => blockers.push({ code: 'lockedActivity', activityId: cleanId(item.id), message: '잠긴 진행 항목이 있어 먼저 잠금을 풀어야 합니다.' }));
    data.activityAssignments.filter((item) => (activityIds.has(cleanId(item.activityId)) || assignmentIds.has(cleanId(item.assignmentId))) && item.locked).forEach((item) => blockers.push({ code: 'lockedActivityAssignment', activityAssignmentId: cleanId(item.id), message: '잠긴 진행 담당 배정이 있어 먼저 잠금을 풀어야 합니다.' }));
    return blockers;
  }

  function cascadeSlots(data, slotIds) {
    const ids = new Set(uniqueIds(slotIds)); const removedAssignments = data.assignments.filter((item) => ids.has(cleanId(item.slotId))); const assignmentIds = new Set(removedAssignments.map((item) => cleanId(item.id)).filter(Boolean)); const removedActivities = data.activities.filter((item) => ids.has(firstCleanId(item.eventId, item.slotId))); const activityIds = new Set(removedActivities.map((item) => cleanId(item.id)).filter(Boolean));
    const removedActivityAssignments = data.activityAssignments.filter((item) => activityIds.has(cleanId(item.activityId)) || assignmentIds.has(cleanId(item.assignmentId)) || ids.has(firstCleanId(item.eventId, item.slotId)));
    data.slots = data.slots.filter((item) => !ids.has(cleanId(item.id))); data.assignments = data.assignments.filter((item) => !assignmentIds.has(cleanId(item.id))); data.activities = data.activities.filter((item) => !activityIds.has(cleanId(item.id))); data.activityAssignments = data.activityAssignments.filter((item) => !removedActivityAssignments.includes(item));
    Object.keys(data.availability).forEach((personId) => { if (Array.isArray(data.availability[personId])) data.availability[personId] = data.availability[personId].filter((slotId) => !ids.has(cleanId(slotId))); });
    ids.forEach((slotId) => { delete data.scheduleCustomValues[slotId]; });
    data.externalArtifacts = data.externalArtifacts.map((artifact) => ids.has(cleanId(artifact.slotId)) && artifact.status !== 'superseded' ? { ...artifact, status: 'stale', reviewReason: '연결된 그룹 일정이 제거되어 외부 서비스 정리가 필요합니다.' } : artifact);
    return { removedSlotIds: [...ids], removedAssignmentIds: [...assignmentIds], removedActivityIds: [...activityIds], removedActivityAssignmentIds: uniqueIds(removedActivityAssignments.map((item) => item.id)), affectedPersonIds: uniqueIds(removedAssignments.map((item) => item.personId)) };
  }

  function planRemovals(project, data, slotIds, operations) {
    if (!operations?.planScheduleBatchChange) return { canApply: false, blockers: [operationBlocker()] };
    const ids = new Set(uniqueIds(slotIds)); const changes = data.assignments.filter((item) => ids.has(cleanId(item.slotId))).map((item) => ({ action: 'remove', assignmentId: cleanId(item.id) }));
    return operations.planScheduleBatchChange(planInput(project, data, { slotChanges: [], assignmentChanges: changes }));
  }

  function updateGroupPlacements(project, data, currentGroup, nextGroup, operations, idFactory) {
    const slots = data.slots.filter((slot) => cleanId(slot.scheduleGroupId) === currentGroup.id); if (!slots.length) return { canApply: true, nextSlots: data.slots, nextAssignments: data.assignments, blockers: [] };
    if (!operations?.planScheduleBatchChange) return { canApply: false, blockers: [operationBlocker()] };
    const desired = new Map(nextGroup.members.map((member) => [member.personId, member])); const previous = new Map(currentGroup.members.map((member) => [member.personId, member])); const changes = []; const usedIds = new Set(data.assignments.map((item) => cleanId(item.id))); const managedAssignmentIds = new Set();
    slots.forEach((slot) => {
      const existing = data.assignments.filter((item) => cleanId(item.slotId) === cleanId(slot.id) && (cleanId(item.scheduleGroupId) === currentGroup.id || (!cleanId(item.scheduleGroupId) && previous.get(cleanId(item.personId))?.roleId === cleanId(item.roleId)))); const seen = new Set();
      existing.forEach((assignment) => {
        managedAssignmentIds.add(cleanId(assignment.id));
        const personId = cleanId(assignment.personId); const member = desired.get(personId);
        if (!member || seen.has(personId)) changes.push({ action: 'remove', assignmentId: cleanId(assignment.id) });
        else { seen.add(personId); if (cleanId(assignment.roleId) !== member.roleId) changes.push({ action: 'move', assignmentId: cleanId(assignment.id), toSlotId: cleanId(slot.id), roleId: member.roleId }); }
      });
      nextGroup.members.filter((member) => !seen.has(member.personId)).forEach((member) => { const nextAssignmentId = generatedId('assignment', idFactory, usedIds); managedAssignmentIds.add(nextAssignmentId); changes.push({ action: 'add', nextAssignmentId, personId: member.personId, roleId: member.roleId, toSlotId: cleanId(slot.id) }); });
    });
    const plan = operations.planScheduleBatchChange(planInput(project, data, { slotChanges: [], assignmentChanges: changes }));
    if (plan.canApply) plan.nextAssignments = plan.nextAssignments.map((assignment) => managedAssignmentIds.has(cleanId(assignment.id)) && desired.has(cleanId(assignment.personId)) ? { ...assignment, calendarSessionId: nextGroup.sessionId, scheduleGroupId: nextGroup.id } : assignment);
    return plan;
  }

  function applyAction(projectInput, actionInput = {}, options = {}) {
    const project = projectInput && typeof projectInput === 'object' ? projectInput : {}; const operations = options.operations || defaultOperations; const stamp = nowIso(options.now); const data = ensureData(project); const before = clone(data); let model = normalizeModel({ project: projectWithData(project, data), now: stamp, idFactory: options.idFactory }); putModel(data, model); repairPlacementReferences(data, model);
    const type = actionType(actionInput.type || actionInput.action); const payload = { ...actionInput, ...(actionInput.payload && typeof actionInput.payload === 'object' ? actionInput.payload : {}) }; delete payload.type; delete payload.action; delete payload.payload;
    const sessions = model.sessions; const groups = model.groups; const sessionById = (id) => sessions.find((item) => item.id === cleanId(id)); const groupById = (id) => groups.find((item) => item.id === cleanId(id));
    const usedSessionIds = new Set(sessions.map((item) => item.id)); const usedGroupIds = new Set(groups.map((item) => item.id)); const usedSlotIds = new Set(data.slots.map((item) => cleanId(item.id))); const usedAssignmentIds = new Set(data.assignments.map((item) => cleanId(item.id)));

    if (type === 'session:add') {
      const raw = { ...(payload.session || payload), id: firstCleanId(payload.session?.id, payload.id) || generatedId('calendar-session', options.idFactory, usedSessionIds), createdAt: payload.session?.createdAt || stamp, updatedAt: stamp }; const blockers = [];
      if (!clean(raw.title)) blockers.push({ code: 'missingSessionTitle', message: '세션 이름을 입력해주세요.' }); if (!isValidDate(raw.startDate) || !isValidDate(raw.endDate || raw.startDate) || clean(raw.endDate || raw.startDate) < clean(raw.startDate)) blockers.push({ code: 'invalidSessionRange', message: '세션 시작일과 종료일을 다시 선택해주세요.' }); blockers.push(...viewSettingsBlockers(raw.viewSettings || {}));
      if (sessions.some((item) => item.id === raw.id)) blockers.push({ code: 'duplicateSessionId', message: '같은 세션 ID가 이미 존재합니다.' });
      if (model.deletedSessionIds.includes(raw.id)) blockers.push({ code: 'deletedSessionId', message: '이전에 삭제한 세션 ID는 다시 사용할 수 없습니다.' });
      if (blockers.length) return failed(data, model, blockers, '', selection(raw.id));
      const next = normalizeSession(raw, { now: stamp, usedIds: new Set(), idFactory: options.idFactory }); sessions.push(next); model = { ...model, sessions }; return finish(project, before, data, model, { selection: selection(next.id), impact: { changedSessionIds: [next.id] }, message: `“${next.title}” 세션을 추가했습니다.` }, operations);
    }

    if (type === 'session:update' || type === 'session:settings') {
      const id = firstCleanId(payload.sessionId, payload.id); const current = sessionById(id); if (!current) return failed(data, model, [{ code: 'missingSession', message: '변경할 세션을 찾지 못했습니다.' }], '', selection(id));
      const patch = type === 'session:settings' ? { viewSettings: payload.viewSettings || payload.settings || payload.patch || {} } : (payload.patch || payload.session || payload); const blockers = [];
      if (patch.title != null && !clean(patch.title)) blockers.push({ code: 'missingSessionTitle', message: '세션 이름을 비워둘 수 없습니다.' }); if (patch.viewSettings) blockers.push(...viewSettingsBlockers({ ...current.viewSettings, ...patch.viewSettings }));
      const raw = { ...current, ...patch, id: current.id, createdAt: current.createdAt, viewSettings: { ...current.viewSettings, ...(patch.viewSettings || {}) }, updatedAt: stamp }; const next = normalizeSession(raw, { now: stamp, usedIds: new Set(), idFactory: options.idFactory }); if (!next) blockers.push({ code: 'invalidSessionRange', message: '세션 시작일과 종료일을 다시 선택해주세요.' });
      if (next) sessionSlots({ project: projectWithData(project, data) }, id).filter((slot) => slot.date < next.startDate || (slot.endDate || slot.date) > next.endDate).forEach((slot) => blockers.push({ code: 'placementOutsideSession', slotId: cleanId(slot.id), message: `“${slot.label || '그룹 일정'}”이 변경할 세션 기간 밖에 있습니다.` }));
      if (next && patch.viewSettings) sessionSlots({ project: projectWithData(project, data) }, id).filter((slot) => !slot.endDate || slot.endDate === slot.date).forEach((slot) => { const start = timeToMinutes(slot.startTime); const end = timeToMinutes(slot.endTime); if (start != null && end != null && (start < timeToMinutes(next.viewSettings.dayStart) || end > timeToMinutes(next.viewSettings.dayEnd))) blockers.push({ code: 'placementOutsideViewTime', slotId: cleanId(slot.id), message: `“${slot.label || '그룹 일정'}”이 변경할 표시 시간 밖에 있습니다.` }); });
      if (blockers.length) return failed(data, model, blockers, '', selection(id)); model.sessions = sessions.map((item) => item.id === id ? next : item); return finish(project, before, data, model, { selection: selection(id), impact: { changedSessionIds: [id] }, message: type === 'session:settings' ? '세션 캘린더 보기 설정을 저장했습니다.' : `“${next.title}” 세션을 수정했습니다.` }, operations);
    }

    if (type === 'session:remove') {
      const id = firstCleanId(payload.sessionId, payload.id); const current = sessionById(id); if (!current) return failed(data, model, [{ code: 'missingSession', message: '삭제할 세션을 찾지 못했습니다.' }], '', selection(id)); const removedGroupIds = groups.filter((group) => group.sessionId === id).map((group) => group.id); const removedGroupSet = new Set(removedGroupIds); const slotIds = data.slots.filter((slot) => cleanId(slot.calendarSessionId) === id || removedGroupSet.has(cleanId(slot.scheduleGroupId))).map((slot) => slot.id); const lockBlockers = lockedCascadeBlockers(data, slotIds); if (lockBlockers.length) return failed(data, model, lockBlockers, '', selection(id)); const plan = planRemovals(project, data, slotIds, operations); if (!plan.canApply) return failed(data, model, plan.blockers, '', selection(id)); const cascade = cascadeSlots(data, slotIds); model = { ...model, deletedSessionIds: uniqueIds([...model.deletedSessionIds, id]), deletedGroupIds: uniqueIds([...model.deletedGroupIds, ...removedGroupIds]), sessions: sessions.filter((item) => item.id !== id), groups: groups.filter((group) => group.sessionId !== id) }; return finish(project, before, data, model, { impact: { ...cascade, changedSessionIds: [id], changedGroupIds: removedGroupIds }, message: `“${current.title}” 세션과 연결된 그룹 일정을 삭제했습니다.` }, operations);
    }

    if (type === 'group:add') {
      const raw = { ...(payload.group || payload), id: firstCleanId(payload.group?.id, payload.id) || generatedId('schedule-group', options.idFactory, usedGroupIds), sessionId: firstCleanId(payload.group?.sessionId, payload.sessionId), createdAt: payload.group?.createdAt || stamp, updatedAt: stamp }; const blockers = [];
      if (!sessionById(raw.sessionId)) blockers.push({ code: 'missingSession', message: '그룹을 넣을 세션을 찾지 못했습니다.' }); if (!clean(raw.name)) blockers.push({ code: 'missingGroupName', message: '그룹 이름을 입력해주세요.' }); if (groups.some((item) => item.id === raw.id)) blockers.push({ code: 'duplicateGroupId', message: '같은 그룹 ID가 이미 존재합니다.' }); if (model.deletedGroupIds.includes(raw.id)) blockers.push({ code: 'deletedGroupId', message: '이전에 삭제한 그룹 ID는 다시 사용할 수 없습니다.' }); blockers.push(...groupMemberBlockers(raw, data)); if (blockers.length) return failed(data, model, blockers, '', selection(raw.sessionId, raw.id));
      const next = normalizeGroup(raw, { sessionIds: new Set(sessions.map((item) => cleanId(item.id)).filter(Boolean)), personIds: new Set(data.people.filter((item) => item.active !== false).map((item) => cleanId(item.id)).filter(Boolean)), roleIds: new Set(data.roles.filter((item) => item.active !== false).map((item) => cleanId(item.id)).filter(Boolean)), usedIds: new Set(), now: stamp, idFactory: options.idFactory }); groups.push(next); model = { ...model, groups }; return finish(project, before, data, model, { selection: selection(next.sessionId, next.id), impact: { changedGroupIds: [next.id] }, message: `“${next.name}” 그룹을 추가했습니다.` }, operations);
    }

    if (type === 'group:update') {
      const id = firstCleanId(payload.groupId, payload.id); const current = groupById(id); if (!current) return failed(data, model, [{ code: 'missingGroup', message: '변경할 그룹을 찾지 못했습니다.' }], '', selection(null, id)); const patch = payload.patch || payload.group || payload; if (patch.name != null && !clean(patch.name)) return failed(data, model, [{ code: 'missingGroupName', message: '그룹 이름을 비워둘 수 없습니다.' }], '', selection(current.sessionId, id));
      const patchMembers = Array.isArray(patch.members) ? patch.members : Array.isArray(patch.memberIds) ? patch.memberIds.map((personId) => ({ personId, roleId: patch.roleByPersonId?.[personId] })) : null; const requestedMemberIds = patchMembers ? new Set(patchMembers.map((member) => cleanId(member?.personId)).filter(Boolean)) : new Set(current.members.map((member) => member.personId)); const deletedMemberIds = uniqueIds([...(current.deletedMemberIds || []), ...current.members.map((member) => member.personId).filter((personId) => !requestedMemberIds.has(personId))]).filter((personId) => !requestedMemberIds.has(personId));
      const raw = { ...current, ...patch, ...(patchMembers ? { members: patchMembers } : {}), deletedMemberIds, id: current.id, createdAt: current.createdAt, updatedAt: stamp }; const memberBlockers = groupMemberBlockers(raw, data); if (memberBlockers.length) return failed(data, model, memberBlockers, '', selection(current.sessionId, id)); if (cleanId(raw.sessionId) !== current.sessionId && data.slots.some((slot) => cleanId(slot.scheduleGroupId) === id)) return failed(data, model, [{ code: 'placedGroupSessionChange', message: '배치된 그룹은 먼저 일정에서 빼낸 뒤 다른 세션으로 옮겨주세요.' }], '', selection(current.sessionId, id));
      const next = normalizeGroup(raw, { sessionIds: new Set(sessions.map((item) => cleanId(item.id)).filter(Boolean)), personIds: new Set(data.people.filter((item) => item.active !== false).map((item) => cleanId(item.id)).filter(Boolean)), roleIds: new Set(data.roles.filter((item) => item.active !== false).map((item) => cleanId(item.id)).filter(Boolean)), usedIds: new Set(), now: stamp, idFactory: options.idFactory }); if (!next) return failed(data, model, [{ code: 'missingSession', message: '그룹을 넣을 세션을 찾지 못했습니다.' }], '', selection(current.sessionId, id)); const plan = updateGroupPlacements(project, data, current, next, operations, options.idFactory); if (!plan.canApply) return failed(data, model, plan.blockers, '', selection(current.sessionId, id)); data.slots = plan.nextSlots; data.assignments = plan.nextAssignments; model.groups = groups.map((item) => item.id === id ? next : item); return finish(project, before, data, model, { selection: selection(next.sessionId, id), impact: { changedGroupIds: [id] }, message: `“${next.name}” 그룹을 수정했습니다.` }, operations);
    }

    if (type === 'group:remove') {
      const id = firstCleanId(payload.groupId, payload.id); const current = groupById(id); if (!current) return failed(data, model, [{ code: 'missingGroup', message: '삭제할 그룹을 찾지 못했습니다.' }], '', selection(null, id)); const slotIds = data.slots.filter((slot) => cleanId(slot.scheduleGroupId) === id).map((slot) => slot.id); const lockBlockers = lockedCascadeBlockers(data, slotIds); if (lockBlockers.length) return failed(data, model, lockBlockers, '', selection(current.sessionId, id)); const plan = planRemovals(project, data, slotIds, operations); if (!plan.canApply) return failed(data, model, plan.blockers, '', selection(current.sessionId, id)); const cascade = cascadeSlots(data, slotIds); model.groups = groups.filter((item) => item.id !== id); model.deletedGroupIds = uniqueIds([...model.deletedGroupIds, id]); return finish(project, before, data, model, { selection: selection(current.sessionId), impact: { ...cascade, changedGroupIds: [id] }, message: `“${current.name}” 그룹과 연결된 일정을 삭제했습니다.` }, operations);
    }

    if (type === 'placement:add') {
      const group = groupById(firstCleanId(payload.groupId, payload.scheduleGroupId)); const session = sessionById(firstCleanId(payload.sessionId, payload.calendarSessionId, group?.sessionId)); if (!group) return failed(data, model, [{ code: 'missingGroup', message: '배치할 그룹을 찾지 못했습니다.' }], '', selection(session?.id, firstCleanId(payload.groupId, payload.scheduleGroupId))); if (!session || group.sessionId !== session.id) return failed(data, model, [{ code: 'groupSessionMismatch', message: '선택한 세션에 속한 그룹만 배치할 수 있습니다.' }], '', selection(session?.id, group.id)); if (!group.members.length) return failed(data, model, [{ code: 'emptyGroup', message: '그룹에 인원을 먼저 선택한 뒤 일정에 배치해주세요.' }], '', selection(session.id, group.id)); if (!operations?.planScheduleBatchChange) return failed(data, model, [operationBlocker()], '', selection(session.id, group.id));
      const slotId = firstCleanId(payload.slotId, payload.id) || generatedId('slot', options.idFactory, usedSlotIds); if (data.slots.some((slot) => cleanId(slot.id) === slotId)) return failed(data, model, [{ code: 'duplicateSlotId', message: '같은 일정 ID가 이미 존재합니다.' }], '', selection(session.id, group.id, slotId)); const date = clean(payload.date); const endDate = clean(payload.endDate || date); const requestedStatus = clean(payload.status) || 'draft'; if (!PLACEMENT_STATUSES.has(requestedStatus)) return failed(data, model, [{ code: 'invalidPlacementStatus', message: '그룹 일정 상태를 다시 선택해주세요.' }], '', selection(session.id, group.id, slotId)); const slot = { id: slotId, calendarSessionId: session.id, scheduleGroupId: group.id, date, startTime: clean(payload.startTime), endTime: clean(payload.endTime), label: clean(payload.label) || group.name, status: requestedStatus, locked: false }; if (endDate && endDate !== date) slot.endDate = endDate;
      const blockers = placementBlockers(session, slot, operations); if (blockers.length) return failed(data, model, blockers, '', selection(session.id, group.id, slot.id)); data.slots.push(slot); const assignmentChanges = group.members.map((member) => ({ action: 'add', nextAssignmentId: generatedId('assignment', options.idFactory, usedAssignmentIds), personId: member.personId, roleId: member.roleId, toSlotId: slot.id })); const plan = operations.planScheduleBatchChange(planInput(project, data, { slotChanges: [], assignmentChanges })); if (!plan.canApply) { data.slots = data.slots.filter((item) => cleanId(item.id) !== slot.id); return failed(data, model, plan.blockers, '', selection(session.id, group.id)); } data.assignments = plan.nextAssignments.map((assignment) => cleanId(assignment.slotId) === slot.id ? { ...assignment, calendarSessionId: session.id, scheduleGroupId: group.id } : assignment); return finish(project, before, data, model, { selection: selection(session.id, group.id, slot.id), impact: { changedGroupIds: [group.id] }, message: `“${group.name}” 그룹을 ${date} ${slot.startTime}에 배치했습니다.` }, operations);
    }

    if (type === 'placement:move') {
      const slotId = firstCleanId(payload.slotId, payload.id); const current = data.slots.find((slot) => cleanId(slot.id) === slotId); if (!current) return failed(data, model, [{ code: 'missingPlacement', message: '옮길 그룹 일정을 찾지 못했습니다.' }], '', selection(null, null, slotId)); const session = sessionById(current.calendarSessionId); const group = groupById(current.scheduleGroupId); if (!session || !group) return failed(data, model, [{ code: 'orphanPlacement', message: '일정에 연결된 세션 또는 그룹을 찾지 못했습니다.' }], '', selection(current.calendarSessionId, current.scheduleGroupId, slotId)); if (!operations?.planScheduleBatchChange) return failed(data, model, [operationBlocker()], '', selection(session.id, group.id, slotId));
      const date = clean(payload.date ?? payload.patch?.date ?? current.date); const endDate = clean(payload.endDate ?? payload.patch?.endDate ?? current.endDate ?? date); const startTime = clean(payload.startTime ?? payload.patch?.startTime ?? current.startTime); const endTime = clean(payload.endTime ?? payload.patch?.endTime ?? current.endTime); const requestedStatus = clean(payload.status ?? payload.patch?.status ?? current.status) || 'draft'; if (!PLACEMENT_STATUSES.has(requestedStatus)) return failed(data, model, [{ code: 'invalidPlacementStatus', message: '그룹 일정 상태를 다시 선택해주세요.' }], '', selection(session.id, group.id, slotId)); const candidate = { ...current, date, startTime, endTime, status: requestedStatus }; if (endDate && endDate !== date) candidate.endDate = endDate; else delete candidate.endDate; const blockers = placementBlockers(session, candidate, operations); if (blockers.length) return failed(data, model, blockers, '', selection(session.id, group.id, slotId)); const plan = operations.planScheduleBatchChange(planInput(project, data, { slotChanges: [{ action: 'move', slotId, date, endDate, startTime, endTime }], assignmentChanges: [] })); if (!plan.canApply) return failed(data, model, plan.blockers, '', selection(session.id, group.id, slotId)); data.slots = plan.nextSlots.map((slot) => cleanId(slot.id) === slotId ? { ...slot, label: clean(payload.label ?? payload.patch?.label) || slot.label, status: requestedStatus } : slot); data.assignments = plan.nextAssignments; return finish(project, before, data, model, { selection: selection(session.id, group.id, slotId), impact: { changedGroupIds: [group.id] }, message: `“${group.name}” 그룹 일정을 옮겼습니다.` }, operations);
    }

    if (type === 'placement:remove') {
      const slotId = firstCleanId(payload.slotId, payload.id); const slot = data.slots.find((item) => cleanId(item.id) === slotId); if (!slot) return failed(data, model, [{ code: 'missingPlacement', message: '일정에서 뺄 그룹을 찾지 못했습니다.' }], '', selection(null, null, slotId)); const group = groupById(slot.scheduleGroupId); const session = sessionById(slot.calendarSessionId); const lockBlockers = lockedCascadeBlockers(data, [slotId]); if (lockBlockers.length) return failed(data, model, lockBlockers, '', selection(session?.id, group?.id, slotId)); const plan = planRemovals(project, data, [slotId], operations); if (!plan.canApply) return failed(data, model, plan.blockers, '', selection(session?.id, group?.id, slotId)); const cascade = cascadeSlots(data, [slotId]); return finish(project, before, data, model, { selection: selection(session?.id, group?.id), impact: { ...cascade, changedGroupIds: group ? [group.id] : [] }, message: `“${group?.name || slot.label || '그룹'}”을 미배치로 되돌렸습니다.` }, operations);
    }

    return failed(data, model, [{ code: 'unsupportedAction', message: '지원하지 않는 세션 캘린더 작업입니다.' }]);
  }

  return { SCHEMA_VERSION, DEFAULT_VIEW_SETTINGS, isValidDate, timeToMinutes, minutesToTime, addDays, dateRange, sessionDateRange, normalizeViewSettings, timeTicks, normalizeSession, normalizeGroup, normalizeModel, sessionSlots, unassignedGroups, sameTimeLanes, applyAction };
});
