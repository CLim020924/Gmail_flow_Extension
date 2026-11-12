/*
 * ProjectSessionSchedulerUI contract
 * ---------------------------------
 * UMD global: ProjectSessionSchedulerUI
 * Runtime globals: ProjectSessionSchedulerCore, ProjectCalendarCore
 *
 * create({ mount, getProject, dispatch, confirm, toast, onOpenLegacy }) returns:
 *   { render(options), openSession(id), showOverview(), destroy(), selectedSessionId() }
 *
 * Storage read by this UI (it never creates a parallel placement array):
 *   project.data.extensionData.projectCalendar.sessions
 *   project.data.extensionData.projectCalendar.groups
 *   project.data.slots[] where calendarSessionId + scheduleGroupId identify a placement
 *
 * Actions sent to dispatch(action):
 *   session.add       { session }
 *   session.update    { sessionId, patch }
 *   session.remove    { sessionId }
 *   group.add         { sessionId, group }
 *   group.update      { sessionId, groupId, patch }
 *   group.remove      { sessionId, groupId }
 *   placement.add     { sessionId, groupId, date, startTime, endTime, label, status }
 *   placement.move    { sessionId, groupId, slotId, date, startTime, endTime, label, status }
 *   placement.remove  { sessionId, groupId, slotId }
 *   session.settings  { sessionId, viewSettings:{dayStart,dayEnd,stepMinutes,view} }
 *
 * adaptAction() deliberately emits both flat fields and payload so an embedding adapter can
 * consume either shape. dispatch is async and should apply the core result to the host project
 * before its Promise resolves. A result shaped as { ok:false, blockers, message } is treated as
 * rejected; { selection:{sessionId} } may direct the UI after a successful create.
 */
(function exposeProjectSessionSchedulerUI(root, factory) {
  const api = factory(
    root && root.ProjectSessionSchedulerCore,
    root && root.ProjectCalendarCore
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProjectSessionSchedulerUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (SchedulerCore, CalendarCore) => {
  'use strict';

  const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];
  const VIEW_LABELS = { day: '일', week: '주', month: '월' };
  const DEFAULT_GROUP_COLORS = ['#2879b8', '#26805f', '#b77821', '#6b55aa', '#257e95', '#b34b4b', '#4e63a8', '#28796f'];
  const DRAG_GROUP = 'application/x-cmoe-schedule-group';
  const DRAG_PLACEMENT = 'application/x-cmoe-group-placement';
  const ACTION_ALIASES = Object.freeze({
    'session/create': 'session.add',
    'group/create': 'group.add',
    'placement/create': 'placement.add',
    'placement/update': 'placement.move',
    'session/settings': 'session.settings',
    'session:settings': 'session.settings',
    'settings.update': 'session.settings',
    'preferences/update': 'session.settings'
  });

  function create(options = {}) {
    const mount = options.mount;
    const getProject = options.getProject;
    const dispatch = options.dispatch;
    if (!mount || typeof mount.replaceChildren !== 'function') throw new TypeError('ProjectSessionSchedulerUI: mount 요소가 필요합니다.');
    if (typeof getProject !== 'function') throw new TypeError('ProjectSessionSchedulerUI: getProject 함수가 필요합니다.');
    if (typeof dispatch !== 'function') throw new TypeError('ProjectSessionSchedulerUI: dispatch 함수가 필요합니다.');

    const runtime = {
      mount,
      getProject,
      dispatch,
      confirm: typeof options.confirm === 'function' ? options.confirm : null,
      toast: typeof options.toast === 'function' ? options.toast : null,
      onOpenLegacy: typeof options.onOpenLegacy === 'function' ? options.onOpenLegacy : null
    };
    const state = {
      destroyed: false,
      busy: false,
      mode: 'overview',
      selectedSessionId: null,
      sessionView: 'week',
      overviewAnchor: '',
      sessionAnchor: '',
      rangeDrag: null,
      dragPayload: null,
      pendingFocus: null
    };
    const rootElement = document.createElement('section');
    rootElement.className = 'pss';
    rootElement.setAttribute('aria-label', '세션 일정과 그룹 편성');
    runtime.mount.replaceChildren(rootElement);
    const listenerOptions = typeof AbortController === 'function' ? new AbortController() : null;

    bindEvents();

    function project() {
      const value = runtime.getProject();
      return value && typeof value === 'object' ? value : null;
    }

    function extensionData(sourceProject = project()) {
      const data = sourceProject?.data?.extensionData?.projectCalendar;
      return data && typeof data === 'object' ? data : {};
    }

    function sessions(sourceProject = project()) {
      const value = extensionData(sourceProject).sessions;
      return Array.isArray(value) ? value.filter(Boolean).slice().sort((left, right) => (
        sessionStart(left).localeCompare(sessionStart(right))
        || sessionEnd(left).localeCompare(sessionEnd(right))
        || sessionTitle(left).localeCompare(sessionTitle(right), 'ko')
      )) : [];
    }

    function allGroups(sourceProject = project()) {
      const value = extensionData(sourceProject).groups;
      return Array.isArray(value) ? value.filter(Boolean) : [];
    }

    function groupsForSession(sourceProject, sessionId) {
      const context = schedulerContext(sourceProject);
      const all = allGroups(sourceProject).filter((group) => !group.sessionId || group.sessionId === sessionId);
      if (SchedulerCore && typeof SchedulerCore.groupsForSession === 'function') {
        const selected = safeCoreCall(() => SchedulerCore.groupsForSession(context, sessionId));
        if (Array.isArray(selected)) return selected;
      }
      return all;
    }

    function placementsForSession(sourceProject, sessionId) {
      const context = schedulerContext(sourceProject);
      if (SchedulerCore && typeof SchedulerCore.sessionSlots === 'function') {
        const selected = safeCoreCall(() => SchedulerCore.sessionSlots(context, sessionId));
        if (Array.isArray(selected)) return selected;
        const selectedFromProject = safeCoreCall(() => SchedulerCore.sessionSlots(sourceProject, sessionId));
        if (Array.isArray(selectedFromProject)) return selectedFromProject;
      }
      const slots = Array.isArray(sourceProject?.data?.slots) ? sourceProject.data.slots : [];
      const wantedSessionId = String(sessionId ?? '');
      return slots.filter((slot) => String(slot?.calendarSessionId ?? '') === wantedSessionId && slot?.scheduleGroupId != null);
    }

    function schedulerContext(sourceProject = project()) {
      return {
        project: sourceProject,
        data: extensionData(sourceProject),
        sessions: sessions(sourceProject),
        groups: allGroups(sourceProject),
        slots: Array.isArray(sourceProject?.data?.slots) ? sourceProject.data.slots : [],
        people: Array.isArray(sourceProject?.data?.people) ? sourceProject.data.people : [],
        roles: Array.isArray(sourceProject?.data?.roles) ? sourceProject.data.roles : []
      };
    }

    function selectedSession(sourceProject = project()) {
      return sessions(sourceProject).find((session) => session.id === state.selectedSessionId) || null;
    }

    function sessionStart(session) {
      return String(session?.startDate || session?.date || '').trim();
    }

    function sessionEnd(session) {
      return String(session?.endDate || session?.startDate || session?.date || '').trim();
    }

    function sessionTitle(session) {
      return String(session?.title || session?.name || session?.label || '이름 없는 세션').trim();
    }

    function groupTitle(group) {
      return String(group?.name || group?.title || group?.label || '이름 없는 그룹').trim();
    }

    function groupColor(group, index = 0) {
      return validColor(group?.color) ? group.color : DEFAULT_GROUP_COLORS[index % DEFAULT_GROUP_COLORS.length];
    }

    function groupMemberIds(group) {
      if (Array.isArray(group?.memberIds)) return [...new Set(group.memberIds.filter(Boolean))];
      if (Array.isArray(group?.members)) return [...new Set(group.members.map((member) => typeof member === 'string' ? member : member?.personId).filter(Boolean))];
      return [];
    }

    function groupRoleMap(group) {
      const map = { ...(group?.roleByPersonId && typeof group.roleByPersonId === 'object' ? group.roleByPersonId : {}) };
      if (Array.isArray(group?.members)) group.members.forEach((member) => {
        if (member && typeof member === 'object' && member.personId && member.roleId) map[member.personId] = member.roleId;
      });
      return map;
    }

    function groupForSlot(sourceProject, slot) {
      return allGroups(sourceProject).find((group) => group.id === slot?.scheduleGroupId) || null;
    }

    function sessionRange(session) {
      if (SchedulerCore && typeof SchedulerCore.sessionDateRange === 'function') {
        const range = safeCoreCall(() => SchedulerCore.sessionDateRange(session));
        if (range?.start && range?.end) return range;
        if (Array.isArray(range) && range.length) return { start: range[0], end: range.at(-1) };
      }
      const start = sessionStart(session);
      const end = sessionEnd(session) || start;
      if (!isDate(start) || !isDate(end)) return null;
      return start <= end ? { start, end } : { start: end, end: start };
    }

    function sessionSettings(session) {
      const ext = extensionData();
      const source = {
        ...(ext.settings && typeof ext.settings === 'object' ? ext.settings : {}),
        ...(ext.settingsBySession?.[session?.id] && typeof ext.settingsBySession[session.id] === 'object' ? ext.settingsBySession[session.id] : {}),
        ...(session?.settings && typeof session.settings === 'object' ? session.settings : {}),
        ...(session?.viewSettings && typeof session.viewSettings === 'object' ? session.viewSettings : {})
      };
      let displayStartTime = validTime(source.dayStart || source.displayStartTime || source.startTime) ? (source.dayStart || source.displayStartTime || source.startTime) : '08:00';
      let displayEndTime = validTime(source.dayEnd || source.displayEndTime || source.endTime) ? (source.dayEnd || source.displayEndTime || source.endTime) : '20:00';
      if (timeMinutes(displayEndTime) <= timeMinutes(displayStartTime)) {
        displayStartTime = '08:00';
        displayEndTime = '20:00';
      }
      const requestedStep = Number(source.stepMinutes || source.intervalMinutes);
      const stepMinutes = Number.isInteger(requestedStep) && requestedStep >= 5 && requestedStep <= 240 ? requestedStep : 30;
      return { displayStartTime, displayEndTime, stepMinutes, view: ['day', 'week', 'month'].includes(source.view) ? source.view : null };
    }

    function timeTicks(settings) {
      if (SchedulerCore && typeof SchedulerCore.timeTicks === 'function') {
        const ticks = safeCoreCall(() => SchedulerCore.timeTicks({ dayStart: settings.displayStartTime, dayEnd: settings.displayEndTime, stepMinutes: settings.stepMinutes }));
        if (Array.isArray(ticks) && ticks.length > 1) return ticks.map((tick) => typeof tick === 'string' ? tick : tick.time).filter(validTime);
      }
      const start = timeMinutes(settings.displayStartTime);
      const end = timeMinutes(settings.displayEndTime);
      const result = [];
      for (let minute = start; minute <= end; minute += settings.stepMinutes) result.push(timeText(minute));
      if (result.at(-1) !== settings.displayEndTime) result.push(settings.displayEndTime);
      return result;
    }

    function todayKey(sourceProject = project()) {
      const zone = sourceProject?.settings?.timezone || 'Asia/Seoul';
      if (CalendarCore && typeof CalendarCore.dateKeyInTimeZone === 'function') {
        return CalendarCore.dateKeyInTimeZone(new Date(), zone) || localDateKey(new Date());
      }
      return localDateKey(new Date());
    }

    function monthGrid(anchor) {
      if (CalendarCore && typeof CalendarCore.monthGrid === 'function') {
        const range = CalendarCore.monthGrid(anchor);
        if (range?.days?.length) return range;
      }
      return fallbackMonthGrid(anchor);
    }

    function weekRange(anchor) {
      if (CalendarCore && typeof CalendarCore.weekRange === 'function') {
        const range = CalendarCore.weekRange(anchor);
        if (range?.days?.length) return range;
      }
      const date = parseDate(anchor);
      if (!date) return null;
      const mondayOffset = (date.getUTCDay() + 6) % 7;
      const start = addDays(anchor, -mondayOffset);
      const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
      return { start, end: days[6], days };
    }

    function render(renderOptions = {}) {
      if (state.destroyed) return api;
      if (renderOptions.mode === 'overview' || renderOptions.mode === 'session') state.mode = renderOptions.mode;
      if (renderOptions.selectedSessionId !== undefined) state.selectedSessionId = renderOptions.selectedSessionId || null;
      if (['day', 'week', 'month'].includes(renderOptions.view)) state.sessionView = renderOptions.view;
      if (isDate(renderOptions.anchorDate)) state.sessionAnchor = renderOptions.anchorDate;
      if (isDate(renderOptions.overviewAnchor)) state.overviewAnchor = monthStart(renderOptions.overviewAnchor);
      const sourceProject = project();
      rootElement.setAttribute('aria-busy', String(state.busy));
      rootElement.replaceChildren();
      if (!sourceProject) {
        rootElement.append(renderNoProject());
        return api;
      }
      if (!CalendarCore) {
        rootElement.append(renderDependencyError());
        return api;
      }
      const availableSessions = sessions(sourceProject);
      if (state.selectedSessionId && !availableSessions.some((session) => session.id === state.selectedSessionId)) {
        state.selectedSessionId = null;
        state.mode = 'overview';
      }
      if (state.mode === 'session' && state.selectedSessionId) renderSessionWorkspace(sourceProject);
      else renderOverview(sourceProject);
      if (state.pendingFocus) {
        const selector = state.pendingFocus;
        state.pendingFocus = null;
        queueMicrotask(() => rootElement.querySelector(selector)?.focus?.());
      }
      return api;
    }

    function renderNoProject() {
      return emptyState('프로젝트를 먼저 선택해주세요.', '세션 일정과 그룹은 선택한 프로젝트 안에 안전하게 저장됩니다.');
    }

    function renderDependencyError() {
      return emptyState('캘린더 구성 요소를 불러오지 못했습니다.', 'ProjectCalendarCore를 먼저 로드한 뒤 다시 열어주세요.');
    }

    function renderOverview(sourceProject) {
      const availableSessions = sessions(sourceProject);
      const today = todayKey(sourceProject);
      if (!isDate(state.overviewAnchor)) {
        const preferred = availableSessions.find((session) => sessionEnd(session) >= today) || availableSessions.at(-1);
        state.overviewAnchor = monthStart(sessionStart(preferred) || today);
      }
      const header = el('header', 'pss-overview-header');
      const copy = el('div', 'pss-heading-copy');
      copy.append(el('span', 'pss-eyebrow', '전체 일정'), el('h1', '', '프로젝트 세션 캘린더'), el('p', '', '큰 세션 구간만 한눈에 보고, 구간을 열어 그룹을 시간대에 배치하세요.'));
      const actions = el('div', 'pss-heading-actions');
      const legacy = button('개별 일정 관리', 'secondary-button', 'open-legacy');
      legacy.setAttribute('data-session-open-legacy', 'true');
      legacy.disabled = !runtime.onOpenLegacy;
      if (legacy.disabled) legacy.title = '기존 일정 관리 화면이 연결되지 않았습니다.';
      actions.append(legacy);
      actions.append(button('＋ 세션 추가', 'primary-button', 'add-session'));
      header.append(copy, actions);

      const toolbar = el('div', 'pss-overview-toolbar');
      const navigation = el('div', 'pss-navigation');
      navigation.append(iconButton('‹', 'overview-previous', '이전 달'), el('h2', '', monthLabel(state.overviewAnchor)), iconButton('›', 'overview-next', '다음 달'), button('오늘', 'secondary-button compact', 'overview-today'));
      const hint = el('div', 'pss-range-hint');
      hint.append(el('span', 'pss-range-icon', '↔'), el('span', '', '빈 날짜를 누른 채 끌면 세션 기간을 바로 만들 수 있습니다.'));
      toolbar.append(navigation, hint);

      const calendar = el('section', 'pss-overview-calendar');
      calendar.setAttribute('data-session-overview', 'true');
      calendar.setAttribute('aria-label', '전체 세션 월간 캘린더');
      const weekdays = el('div', 'pss-overview-weekdays');
      DAY_NAMES.forEach((name) => weekdays.append(el('span', '', name)));
      const grid = el('div', 'pss-overview-grid');
      grid.setAttribute('role', 'grid');
      grid.setAttribute('aria-colcount', '7');
      const range = monthGrid(state.overviewAnchor);
      const days = range.days || [];
      let row = null;
      days.forEach((entry, index) => {
        const date = typeof entry === 'string' ? entry : entry.date;
        const inMonth = typeof entry === 'string' ? date.slice(0, 7) === state.overviewAnchor.slice(0, 7) : entry.inMonth;
        if (index % 7 === 0) {
          row = el('div', 'pss-overview-week');
          row.setAttribute('role', 'row');
          grid.append(row);
        }
        row.append(renderOverviewDay(sourceProject, date, inMonth, today, availableSessions));
      });
      calendar.append(weekdays, grid);
      if (!availableSessions.length) {
        const empty = emptyState('아직 세션 구간이 없습니다.', '날짜를 드래그하거나 “세션 추가”를 눌러 첫 구간을 만드세요.');
        empty.classList.add('pss-overview-empty');
        empty.append(button('첫 세션 만들기', 'primary-button', 'add-session'));
        calendar.append(empty);
      }
      rootElement.append(header, toolbar, calendar, renderDialogs(sourceProject));
      updateRangeHighlight();
    }

    function renderOverviewDay(sourceProject, date, inMonth, today, availableSessions) {
      const cell = el('section', `pss-overview-day${inMonth ? '' : ' outside'}${date === today ? ' today' : ''}`);
      cell.dataset.overviewDate = date;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', dateLabel(date, true));
      const head = el('div', 'pss-day-heading');
      const number = button(String(Number(date.slice(8, 10))), 'pss-day-number', 'open-date-session');
      number.dataset.date = date;
      number.setAttribute('aria-label', `${dateLabel(date, true)}에 세션 추가`);
      const add = button('＋', 'pss-day-add', 'open-date-session');
      add.dataset.date = date;
      add.setAttribute('aria-label', `${dateLabel(date, true)}에 세션 추가`);
      head.append(number, add);
      const list = el('div', 'pss-session-list');
      const visible = availableSessions.filter((session) => {
        const range = sessionRange(session);
        return range && range.start <= date && date <= range.end;
      });
      visible.slice(0, 4).forEach((session) => {
        const range = sessionRange(session);
        const phase = sessionPhase(session, sourceProject);
        const chip = button('', `pss-session-chip phase-${phase}`, 'open-session');
        chip.dataset.sessionId = session.id;
        chip.setAttribute('data-session-card', session.id);
        chip.style.setProperty('--session-color', validColor(session.color) ? session.color : '#1769aa');
        chip.classList.toggle('segment-start', date === range.start);
        chip.classList.toggle('segment-end', date === range.end);
        chip.classList.toggle('segment-middle', date !== range.start && date !== range.end);
        chip.append(el('strong', '', date === range.start || date.endsWith('-01') ? sessionTitle(session) : '계속'));
        const groupCount = groupsForSession(sourceProject, session.id).length;
        chip.append(el('small', '', date === range.start ? `${dateRangeLabel(range)} · 그룹 ${groupCount}` : sessionTitle(session)));
        chip.title = `${sessionTitle(session)} · ${dateRangeLabel(range)}`;
        list.append(chip);
      });
      if (visible.length > 4) list.append(el('span', 'pss-more-count', `＋${visible.length - 4}개`));
      cell.append(head, list);
      return cell;
    }

    function renderSessionWorkspace(sourceProject) {
      const session = selectedSession(sourceProject);
      if (!session) {
        state.mode = 'overview';
        renderOverview(sourceProject);
        return;
      }
      const range = sessionRange(session);
      const today = todayKey(sourceProject);
      if (!isDate(state.sessionAnchor)) {
        state.sessionAnchor = range && range.start <= today && today <= range.end ? today : range?.start || today;
      }
      const header = el('header', 'pss-session-header');
      header.setAttribute('data-session-detail', session.id);
      const back = button('← 전체 일정', 'pss-back-button', 'show-overview');
      const identity = el('div', 'pss-session-identity');
      identity.append(el('span', `pss-session-status phase-${sessionPhase(session, sourceProject)}`, sessionPhaseLabel(sessionPhase(session, sourceProject))), el('h1', '', sessionTitle(session)), el('p', '', dateRangeLabel(range)));
      const headerActions = el('div', 'pss-heading-actions');
      const legacy = button('개별 일정 관리', 'secondary-button', 'open-legacy');
      legacy.setAttribute('data-session-open-legacy', 'true');
      legacy.disabled = !runtime.onOpenLegacy;
      if (legacy.disabled) legacy.title = '기존 일정 관리 화면이 연결되지 않았습니다.';
      headerActions.append(legacy, button('세션 정보 수정', 'secondary-button', 'edit-session'), button('인쇄', 'secondary-button pss-print-button', 'print'));
      header.append(back, identity, headerActions);

      const toolbar = el('section', 'pss-session-toolbar');
      const viewSwitch = el('div', 'pss-view-switch');
      viewSwitch.setAttribute('role', 'group');
      viewSwitch.setAttribute('aria-label', '세션 일정 보기 방식');
      ['day', 'week', 'month'].forEach((view) => {
        const control = button(VIEW_LABELS[view], state.sessionView === view ? 'active' : '', 'set-view');
        control.dataset.view = view;
        control.setAttribute('data-session-view', view);
        control.setAttribute('aria-pressed', String(state.sessionView === view));
        viewSwitch.append(control);
      });
      const navigation = el('div', 'pss-navigation');
      navigation.append(iconButton('‹', 'session-previous', '이전 기간'), el('h2', '', sessionPeriodLabel()), iconButton('›', 'session-next', '다음 기간'), button('오늘', 'secondary-button compact', 'session-today'));
      const tools = el('div', 'pss-toolbar-actions');
      tools.append(button('＋ 그룹', 'primary-button compact', 'add-group'));
      toolbar.append(viewSwitch, navigation, tools);

      const settings = renderSettings(session);
      const content = el('div', 'pss-session-content');
      content.append(renderGroupPool(sourceProject, session));
      const board = el('main', 'pss-placement-workspace');
      board.setAttribute('aria-label', `${sessionTitle(session)} 그룹 배치 캘린더`);
      if (state.sessionView === 'month') board.append(renderPlacementMonth(sourceProject, session));
      else board.append(renderTimeBoard(sourceProject, session));
      content.append(board);
      rootElement.append(header, toolbar, settings, content, renderDialogs(sourceProject));
    }

    function renderSettings(session) {
      const settings = sessionSettings(session);
      const form = el('form', 'pss-display-settings');
      form.dataset.form = 'settings';
      form.append(el('strong', '', '표시 시간'));
      form.append(labeledInput('시작', 'time', 'displayStartTime', settings.displayStartTime));
      form.append(labeledInput('종료', 'time', 'displayEndTime', settings.displayEndTime));
      const intervalLabel = el('label', 'pss-compact-field');
      intervalLabel.append(el('span', '', '눈금'));
      const select = el('select');
      select.name = 'stepMinutes';
      select.setAttribute('aria-label', '시간 눈금 간격');
      [...new Set([5, 10, 15, 20, 30, 45, 60, 90, 120, settings.stepMinutes])].sort((left, right) => left - right).forEach((minutes) => {
        const option = el('option', '', `${minutes}분`);
        option.value = String(minutes);
        option.selected = settings.stepMinutes === minutes;
        select.append(option);
      });
      intervalLabel.append(select);
      form.append(intervalLabel, button('적용', 'secondary-button compact', '', 'submit'));
      form.append(el('span', 'pss-settings-help', '배치 블록은 눈금에 맞춰 이동합니다.'));
      return form;
    }

    function renderGroupPool(sourceProject, session) {
      const groups = groupsForSession(sourceProject, session.id);
      const placements = placementsForSession(sourceProject, session.id);
      const counts = new Map();
      placements.filter((slot) => slot.status !== 'cancelled').forEach((slot) => counts.set(slot.scheduleGroupId, (counts.get(slot.scheduleGroupId) || 0) + 1));
      const aside = el('aside', 'pss-group-pool');
      aside.setAttribute('data-session-unassigned-pool', 'true');
      const heading = el('div', 'pss-group-pool-heading');
      const copy = el('div');
      copy.append(el('span', 'pss-eyebrow', '그룹 풀'), el('h2', '', '배치할 그룹'), el('p', '', '카드를 시간표로 끌거나 “배치”를 누르세요.'));
      heading.append(copy, button('＋', 'pss-square-button', 'add-group'));
      const drop = el('div', 'pss-unassign-drop');
      drop.dataset.unassignDrop = 'true';
      drop.tabIndex = 0;
      drop.setAttribute('role', 'region');
      drop.setAttribute('aria-label', '배치 해제 영역');
      drop.append(el('strong', '', '배치에서 빼기'), el('span', '', '시간표 블록을 여기로 놓으세요.'));
      const list = el('div', 'pss-group-card-list');
      groups.slice().sort((left, right) => (counts.get(left.id) || 0) - (counts.get(right.id) || 0) || groupTitle(left).localeCompare(groupTitle(right), 'ko')).forEach((group, index) => {
        list.append(renderGroupCard(sourceProject, group, index, counts.get(group.id) || 0));
      });
      if (!groups.length) {
        const empty = emptyState('아직 그룹이 없습니다.', '명단에서 사람과 역할을 골라 첫 그룹을 만드세요.');
        empty.append(button('그룹 만들기', 'primary-button compact', 'add-group'));
        list.append(empty);
      }
      aside.append(heading, drop, list);
      return aside;
    }

    function renderGroupCard(sourceProject, group, index, placementCount) {
      const card = el('article', `pss-group-card${placementCount ? ' placed' : ' unplaced'}`);
      card.style.setProperty('--group-color', groupColor(group, index));
      card.dataset.groupId = group.id;
      const drag = button('', 'pss-group-drag', 'place-group');
      drag.type = 'button';
      drag.draggable = true;
      drag.dataset.dragGroup = group.id;
      drag.dataset.groupId = group.id;
      const copy = el('span', 'pss-group-copy');
      copy.append(el('strong', '', groupTitle(group)), el('small', '', `${groupMemberIds(group).length}명 · ${placementCount ? `${placementCount}개 일정 배치됨` : '미배치'}`));
      drag.append(el('i', 'pss-group-color'), copy);
      drag.setAttribute('aria-label', `${groupTitle(group)}, ${groupMemberIds(group).length}명. 배치 대화상자 열기`);
      const edit = button('편집', 'pss-card-edit', 'edit-group');
      edit.dataset.groupId = group.id;
      edit.setAttribute('aria-label', `${groupTitle(group)} 편집`);
      card.append(drag, edit);
      return card;
    }

    function renderTimeBoard(sourceProject, session) {
      const settings = sessionSettings(session);
      const ticks = timeTicks(settings);
      const dates = state.sessionView === 'day' ? [state.sessionAnchor] : weekRange(state.sessionAnchor)?.days || [state.sessionAnchor];
      const placements = placementsForSession(sourceProject, session.id);
      const groups = groupsForSession(sourceProject, session.id);
      const groupMap = new Map(groups.map((group, index) => [group.id, { group, index }]));
      const rowHeight = settings.stepMinutes <= 10 ? 24 : settings.stepMinutes === 15 ? 28 : settings.stepMinutes === 20 ? 32 : settings.stepMinutes === 30 ? 38 : settings.stepMinutes === 45 ? 46 : 54;
      const displayStartMinutes = timeMinutes(settings.displayStartTime);
      const displayEndMinutes = timeMinutes(settings.displayEndTime);
      const height = Math.max(rowHeight, ((displayEndMinutes - displayStartMinutes) / settings.stepMinutes) * rowHeight);
      const board = el('section', `pss-time-board ${state.sessionView}-view`);
      board.style.setProperty('--pss-row-height', `${rowHeight}px`);
      board.style.setProperty('--pss-board-height', `${height}px`);
      board.style.setProperty('--pss-day-count', String(dates.length));

      const head = el('div', 'pss-time-board-head');
      head.style.setProperty('--pss-day-count', String(dates.length));
      head.append(el('span', 'pss-time-corner', '시간'));
      dates.forEach((date) => {
        const day = el('button', `pss-time-day-heading${date === todayKey(sourceProject) ? ' today' : ''}`);
        day.type = 'button';
        day.dataset.action = 'open-day';
        day.dataset.date = date;
        day.append(el('strong', '', dayName(date)), el('span', '', shortDateLabel(date)));
        head.append(day);
      });

      const body = el('div', 'pss-time-board-body');
      body.style.setProperty('--pss-day-count', String(dates.length));
      const axis = el('div', 'pss-time-axis');
      axis.style.height = `${height}px`;
      ticks.slice(0, -1).forEach((tick) => {
        const label = el('span', '', tick);
        label.style.top = `${((timeMinutes(tick) - displayStartMinutes) / settings.stepMinutes) * rowHeight}px`;
        axis.append(label);
      });
      const days = el('div', 'pss-time-days');
      days.style.setProperty('--pss-day-count', String(dates.length));
      dates.forEach((date) => {
        const range = sessionRange(session); const outsideSession = Boolean(range && (date < range.start || date > range.end));
        const column = el('section', `pss-time-day${outsideSession ? ' outside-session' : ''}`);
        column.dataset.timeDate = date;
        column.dataset.outsideSession = String(outsideSession);
        column.style.height = `${height}px`;
        column.setAttribute('aria-label', `${dateLabel(date, true)} 시간표`);
        ticks.slice(0, -1).forEach((tick, index) => {
          const line = el('div', 'pss-time-line');
          line.dataset.dropTime = tick;
          line.dataset.date = date;
          line.setAttribute('data-session-time-cell', `${date}|${tick}`);
          const tickStart = timeMinutes(tick); const tickEnd = timeMinutes(ticks[index + 1] || settings.displayEndTime);
          line.style.top = `${((tickStart - displayStartMinutes) / settings.stepMinutes) * rowHeight}px`;
          line.style.height = `${Math.max(1, ((tickEnd - tickStart) / settings.stepMinutes) * rowHeight)}px`;
          column.append(line);
        });
        const dayPlacements = placements.filter((slot) => slot.date <= date && (slot.endDate || slot.date) >= date && slot.status !== 'cancelled').map((slot) => ({
          ...slot,
          startTime: date === slot.date ? slot.startTime : settings.displayStartTime,
          endTime: date === (slot.endDate || slot.date) ? slot.endTime : settings.displayEndTime
        }));
        const coreLanes = SchedulerCore && typeof SchedulerCore.sameTimeLanes === 'function'
          ? safeCoreCall(() => SchedulerCore.sameTimeLanes(schedulerContext(sourceProject), { sessionId: session.id, date }))
          : null;
        const lanes = Array.isArray(coreLanes)
          ? coreLanes.map((entry) => ({ slot: entry.slot || dayPlacements.find((slot) => String(slot.id ?? '') === String(entry.slotId ?? '')), lane: Number(entry.lane) || 0, laneCount: Math.max(1, Number(entry.laneCount) || 1) })).filter((entry) => entry.slot)
          : assignLanes(dayPlacements, settings);
        lanes.forEach(({ slot, lane, laneCount }) => {
          const groupEntry = groupMap.get(slot.scheduleGroupId);
          column.append(renderPlacementBlock(sourceProject, slot, groupEntry?.group, groupEntry?.index || 0, settings, rowHeight, lane, laneCount));
        });
        days.append(column);
      });
      body.append(axis, days);
      board.append(head, body);
      if (!placements.length) {
        const hint = el('div', 'pss-board-empty-hint');
        hint.append(el('strong', '', '아직 배치가 없습니다.'), el('span', '', '왼쪽 그룹 카드를 원하는 날짜와 시간으로 끌어보세요.'));
        board.append(hint);
      }
      return board;
    }

    function renderPlacementBlock(sourceProject, slot, group, groupIndex, settings, rowHeight, lane, laneCount) {
      const displayStart = timeMinutes(settings.displayStartTime);
      const start = timeMinutes(slot.startTime);
      const end = timeMinutes(slot.endTime);
      if (start == null || end == null || end <= start) return el('span');
      const top = ((start - displayStart) / settings.stepMinutes) * rowHeight;
      const height = Math.max(30, ((end - start) / settings.stepMinutes) * rowHeight - 2);
      const width = 100 / Math.max(1, laneCount);
      const block = button('', `pss-placement-block phase-${placementPhase(slot, sourceProject)}`, 'edit-placement');
      block.draggable = true;
      block.dataset.dragPlacement = slot.id;
      block.dataset.slotId = slot.id;
      block.dataset.groupId = slot.scheduleGroupId || '';
      block.setAttribute('data-session-placement', slot.id);
      block.style.setProperty('--group-color', groupColor(group, groupIndex));
      block.style.top = `${Math.max(0, top)}px`;
      block.style.height = `${height}px`;
      block.style.left = `calc(${lane * width}% + 2px)`;
      block.style.width = `calc(${width}% - 4px)`;
      block.append(el('strong', '', group ? groupTitle(group) : slot.label || '그룹'), el('span', '', `${slot.startTime || '--:--'}–${slot.endTime || '--:--'}`));
      if (slot.label && (!group || slot.label !== groupTitle(group))) block.append(el('small', '', slot.label));
      block.setAttribute('aria-label', `${group ? groupTitle(group) : '그룹'} ${slot.startTime}부터 ${slot.endTime}. 편집하려면 누르세요.`);
      return block;
    }

    function renderPlacementMonth(sourceProject, session) {
      const anchor = monthStart(state.sessionAnchor);
      const range = monthGrid(anchor);
      const placements = placementsForSession(sourceProject, session.id);
      const groups = groupsForSession(sourceProject, session.id);
      const groupMap = new Map(groups.map((group, index) => [group.id, { group, index }]));
      const calendar = el('section', 'pss-placement-month');
      const weekdays = el('div', 'pss-overview-weekdays');
      DAY_NAMES.forEach((name) => weekdays.append(el('span', '', name)));
      const grid = el('div', 'pss-placement-month-grid');
      let row = null;
      (range.days || []).forEach((entry, index) => {
        const date = typeof entry === 'string' ? entry : entry.date;
        const inMonth = typeof entry === 'string' ? date.slice(0, 7) === anchor.slice(0, 7) : entry.inMonth;
        if (index % 7 === 0) {
          row = el('div', 'pss-placement-month-week');
          grid.append(row);
        }
        const sessionDates = sessionRange(session); const outsideSession = Boolean(sessionDates && (date < sessionDates.start || date > sessionDates.end));
        const day = el('section', `pss-placement-month-day${inMonth ? '' : ' outside'}${date === todayKey(sourceProject) ? ' today' : ''}${outsideSession ? ' outside-session' : ''}`);
        const dayButton = button(String(Number(date.slice(8, 10))), 'pss-month-day-button', 'open-day');
        dayButton.dataset.date = date;
        dayButton.setAttribute('aria-label', `${dateLabel(date, true)} 일간 보기`);
        const list = el('div', 'pss-month-placement-list');
        const daySlots = placements.filter((slot) => slot.date <= date && (slot.endDate || slot.date) >= date && slot.status !== 'cancelled').sort((left, right) => String(left.startTime).localeCompare(String(right.startTime)));
        daySlots.slice(0, 5).forEach((slot) => {
          const entry = groupMap.get(slot.scheduleGroupId);
          const item = button('', `pss-month-placement phase-${placementPhase(slot, sourceProject)}`, 'edit-placement');
          item.dataset.slotId = slot.id;
          item.setAttribute('data-session-placement', slot.id);
          item.style.setProperty('--group-color', groupColor(entry?.group, entry?.index || 0));
          const segmentTime = date === slot.date ? slot.startTime || '--:--' : '계속';
          item.append(el('strong', '', `${segmentTime} ${entry?.group ? groupTitle(entry.group) : slot.label || '그룹'}`));
          item.setAttribute('aria-label', `${slot.startTime} ${entry?.group ? groupTitle(entry.group) : '그룹'} 편집`);
          list.append(item);
        });
        if (daySlots.length > 5) list.append(el('span', 'pss-more-count', `＋${daySlots.length - 5}개`));
        day.append(dayButton, list);
        row.append(day);
      });
      calendar.append(weekdays, grid);
      if (!placements.length) calendar.append(emptyState('이 달에 배치된 그룹이 없습니다.', '일 또는 주 보기에서 그룹을 시간표로 끌어 배치하세요.'));
      return calendar;
    }

    function renderDialogs(sourceProject) {
      const holder = el('div', 'pss-dialog-holder');
      holder.append(renderSessionDialog(sourceProject), renderGroupDialog(sourceProject), renderPlacementDialog(sourceProject));
      return holder;
    }

    function renderSessionDialog(sourceProject) {
      const dialog = el('dialog', 'pss-dialog');
      dialog.id = 'pssSessionDialog';
      dialog.setAttribute('aria-labelledby', 'pssSessionDialogTitle');
      const form = el('form', 'pss-dialog-form');
      form.dataset.form = 'session';
      const header = dialogHeader('pssSessionDialogTitle', '세션 구간', '전체 일정에 표시할 큰 기간을 정합니다.', 'session');
      const body = el('div', 'pss-dialog-body');
      const id = hiddenInput('sessionId');
      const title = labeledInput('세션 이름', 'text', 'title', '', { required: true, placeholder: '예: 트랙 2 실습 세션' });
      title.classList.add('pss-field-wide');
      const dates = el('div', 'pss-field-grid two');
      dates.append(labeledInput('시작 날짜', 'date', 'startDate', '', { required: true }), labeledInput('종료 날짜', 'date', 'endDate', '', { required: true }));
      const details = el('div', 'pss-field-grid two');
      details.append(labeledInput('구분 색상', 'color', 'color', '#1769aa'));
      const status = labeledSelect('상태', 'status', [['draft', '편성 중'], ['confirmed', '확정'], ['cancelled', '취소']]);
      details.append(status);
      body.append(id, title, dates, details);
      const footer = el('footer', 'pss-dialog-footer');
      const remove = button('세션 삭제', 'pss-danger-link', 'delete-session');
      remove.dataset.dialogDelete = 'session';
      remove.hidden = true;
      footer.append(remove, el('span', 'pss-dialog-spacer'), button('취소', 'secondary-button', 'close-dialog'), button('저장', 'primary-button', '', 'submit'));
      form.append(header, body, footer);
      dialog.append(form);
      return dialog;
    }

    function renderGroupDialog(sourceProject) {
      const dialog = el('dialog', 'pss-dialog pss-group-dialog');
      dialog.id = 'pssGroupDialog';
      dialog.setAttribute('aria-labelledby', 'pssGroupDialogTitle');
      const form = el('form', 'pss-dialog-form');
      form.dataset.form = 'group';
      const header = dialogHeader('pssGroupDialogTitle', '그룹 구성', '명단에서 사람을 고르고 필요한 역할을 지정합니다.', 'group');
      const body = el('div', 'pss-dialog-body');
      body.append(hiddenInput('groupId'));
      const top = el('div', 'pss-field-grid group-heading-fields');
      top.append(labeledInput('그룹 이름', 'text', 'name', '', { required: true, placeholder: '예: A조' }), labeledInput('그룹 색상', 'color', 'color', DEFAULT_GROUP_COLORS[0]));
      const search = labeledInput('명단 찾기', 'search', 'memberSearch', '', { placeholder: '이름·소속 검색' });
      search.querySelector('input').dataset.memberSearch = 'true';
      const roster = el('div', 'pss-member-picker');
      roster.setAttribute('role', 'group');
      roster.setAttribute('aria-label', '그룹에 포함할 사람과 역할');
      const people = Array.isArray(sourceProject?.data?.people) ? sourceProject.data.people.filter((person) => person.active !== false) : [];
      const roles = Array.isArray(sourceProject?.data?.roles) ? sourceProject.data.roles.filter((role) => role.active !== false) : [];
      people.slice().sort((left, right) => String(left.name).localeCompare(String(right.name), 'ko')).forEach((person) => roster.append(renderMemberRow(person, roles)));
      if (!people.length) roster.append(emptyState('선택할 명단이 없습니다.', '먼저 프로젝트 명단에 사람을 추가해주세요.'));
      body.append(top, search, roster);
      const footer = el('footer', 'pss-dialog-footer');
      const remove = button('그룹 삭제', 'pss-danger-link', 'delete-group');
      remove.dataset.dialogDelete = 'group';
      remove.hidden = true;
      footer.append(remove, el('span', 'pss-dialog-spacer'), button('취소', 'secondary-button', 'close-dialog'), button('그룹 저장', 'primary-button', '', 'submit'));
      form.append(header, body, footer);
      dialog.append(form);
      return dialog;
    }

    function renderMemberRow(person, roles) {
      const label = el('label', 'pss-member-row');
      label.dataset.memberRow = person.id;
      label.dataset.searchText = [person.name, person.email, person.group, ...Object.values(person.values || {})].filter(Boolean).join(' ').toLocaleLowerCase('ko-KR');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'memberId';
      checkbox.value = person.id;
      checkbox.dataset.memberToggle = person.id;
      const copy = el('span', 'pss-member-copy');
      copy.append(el('strong', '', person.name || '이름 없음'), el('small', '', [person.group, person.email].filter(Boolean).join(' · ') || '추가 정보 없음'));
      const select = el('select');
      select.name = `role:${person.id}`;
      select.disabled = true;
      select.setAttribute('aria-label', `${person.name || '사람'} 역할`);
      const none = el('option', '', '역할 없음');
      none.value = '';
      select.append(none);
      roles.forEach((role) => {
        const option = el('option', '', role.name || '역할');
        option.value = role.id;
        select.append(option);
      });
      label.append(checkbox, copy, select);
      return label;
    }

    function renderPlacementDialog(sourceProject) {
      const dialog = el('dialog', 'pss-dialog');
      dialog.id = 'pssPlacementDialog';
      dialog.setAttribute('aria-labelledby', 'pssPlacementDialogTitle');
      const form = el('form', 'pss-dialog-form');
      form.dataset.form = 'placement';
      const header = dialogHeader('pssPlacementDialogTitle', '그룹 일정 배치', '날짜와 시간을 바꾸면 캘린더에 즉시 반영됩니다.', 'placement');
      const body = el('div', 'pss-dialog-body');
      body.append(hiddenInput('slotId'));
      const group = labeledSelect('그룹', 'groupId', []);
      group.classList.add('pss-field-wide');
      const date = labeledInput('날짜', 'date', 'date', '', { required: true });
      const times = el('div', 'pss-field-grid two');
      times.append(labeledInput('시작 시간', 'time', 'startTime', '', { required: true }), labeledInput('종료 시간', 'time', 'endTime', '', { required: true }));
      const label = labeledInput('표시 이름', 'text', 'label', '', { placeholder: '비워두면 그룹 이름 사용' });
      label.classList.add('pss-field-wide');
      const status = labeledSelect('상태', 'status', [['draft', '편성 중'], ['confirmed', '확정'], ['changed', '변경됨']]);
      body.append(group, date, times, label, status);
      const footer = el('footer', 'pss-dialog-footer');
      const remove = button('배치에서 빼기', 'pss-danger-link', 'delete-placement');
      remove.dataset.dialogDelete = 'placement';
      remove.hidden = true;
      footer.append(remove, el('span', 'pss-dialog-spacer'), button('취소', 'secondary-button', 'close-dialog'), button('배치 저장', 'primary-button', '', 'submit'));
      form.append(header, body, footer);
      dialog.append(form);
      return dialog;
    }

    function bindEvents() {
      const eventOptions = listenerOptions ? { signal: listenerOptions.signal } : undefined;
      rootElement.addEventListener('click', handleClick, eventOptions);
      rootElement.addEventListener('submit', handleSubmit, eventOptions);
      rootElement.addEventListener('input', handleInput, eventOptions);
      rootElement.addEventListener('change', handleChange, eventOptions);
      rootElement.addEventListener('dragstart', handleDragStart, eventOptions);
      rootElement.addEventListener('dragend', clearDragState, eventOptions);
      rootElement.addEventListener('dragover', handleDragOver, eventOptions);
      rootElement.addEventListener('dragleave', handleDragLeave, eventOptions);
      rootElement.addEventListener('drop', handleDrop, eventOptions);
      rootElement.addEventListener('pointerdown', handlePointerDown, eventOptions);
      rootElement.addEventListener('pointermove', handlePointerMove, eventOptions);
      rootElement.addEventListener('pointerup', (event) => finishRangeDrag(event, false), eventOptions);
      rootElement.addEventListener('pointercancel', (event) => finishRangeDrag(event, true), eventOptions);
      rootElement.addEventListener('keydown', handleKeyDown, eventOptions);
    }

    async function handleClick(event) {
      const control = event.target.closest('[data-action]');
      if (!control || !rootElement.contains(control)) return;
      const action = control.dataset.action;
      if (!action) return;
      if (action === 'show-overview') { showOverview(); return; }
      if (action === 'open-session') { openSession(control.dataset.sessionId); return; }
      if (action === 'add-session') { openSessionDialog(null, todayKey(), todayKey()); return; }
      if (action === 'open-date-session') { openSessionDialog(null, control.dataset.date, control.dataset.date); return; }
      if (action === 'edit-session') { openSessionDialog(selectedSession()); return; }
      if (action === 'overview-previous') { state.overviewAnchor = shiftMonth(state.overviewAnchor, -1); render(); return; }
      if (action === 'overview-next') { state.overviewAnchor = shiftMonth(state.overviewAnchor, 1); render(); return; }
      if (action === 'overview-today') { state.overviewAnchor = monthStart(todayKey()); render(); return; }
      if (action === 'set-view') {
        const previousView = state.sessionView; const session = selectedSession(); const settings = sessionSettings(session);
        state.sessionView = control.dataset.view;
        const result = session ? await runAction('session.settings', { sessionId: session.id, viewSettings: { dayStart: settings.displayStartTime, dayEnd: settings.displayEndTime, stepMinutes: settings.stepMinutes, view: state.sessionView } }, { renderAfter: false }) : { ok: true };
        if (result?.ok === false) state.sessionView = previousView;
        render(); return;
      }
      if (action === 'session-previous') { shiftSessionAnchor(-1); render(); return; }
      if (action === 'session-next') { shiftSessionAnchor(1); render(); return; }
      if (action === 'session-today') { state.sessionAnchor = todayKey(); render(); return; }
      if (action === 'open-day') { state.sessionView = 'day'; state.sessionAnchor = control.dataset.date; render(); return; }
      if (action === 'add-group') { openGroupDialog(); return; }
      if (action === 'edit-group') { openGroupDialog(allGroups().find((group) => group.id === control.dataset.groupId)); return; }
      if (action === 'place-group') { openPlacementDialog(null, control.dataset.groupId, state.sessionAnchor); return; }
      if (action === 'edit-placement') { openPlacementDialog(findSlot(control.dataset.slotId)); return; }
      if (action === 'close-dialog') { event.preventDefault(); closeDialog(control.closest('dialog')); return; }
      if (action === 'delete-session') { event.preventDefault(); await removeSessionFromDialog(); return; }
      if (action === 'delete-group') { event.preventDefault(); await removeGroupFromDialog(); return; }
      if (action === 'delete-placement') { event.preventDefault(); await removePlacementFromDialog(); return; }
      if (action === 'print') { printScheduler(); return; }
      if (action === 'open-legacy') { await Promise.resolve(runtime.onOpenLegacy?.()); }
    }

    function handleInput(event) {
      if (event.target.matches('[data-member-search]')) {
        const query = event.target.value.trim().toLocaleLowerCase('ko-KR');
        rootElement.querySelectorAll('[data-member-row]').forEach((row) => { row.hidden = Boolean(query && !row.dataset.searchText.includes(query)); });
      }
    }

    function handleChange(event) {
      const toggle = event.target.closest('[data-member-toggle]');
      if (toggle) {
        const row = toggle.closest('[data-member-row]');
        const role = row?.querySelector('select');
        if (role) {
          role.disabled = !toggle.checked;
          if (toggle.checked && !role.value) role.value = [...role.options].find((option) => option.value)?.value || '';
        }
        row?.classList.toggle('selected', toggle.checked);
      }
    }

    async function handleSubmit(event) {
      const form = event.target.closest('[data-form]');
      if (!form) return;
      event.preventDefault();
      if (form.dataset.form === 'session') await submitSession(form);
      if (form.dataset.form === 'group') await submitGroup(form);
      if (form.dataset.form === 'placement') await submitPlacement(form);
      if (form.dataset.form === 'settings') await submitSettings(form);
    }

    function handleDragStart(event) {
      const groupCard = event.target.closest('[data-drag-group]');
      const placement = event.target.closest('[data-drag-placement]');
      if (placement) {
        state.dragPayload = { kind: 'placement', slotId: placement.dataset.dragPlacement, groupId: placement.dataset.groupId };
        event.dataTransfer?.setData(DRAG_PLACEMENT, placement.dataset.dragPlacement);
        event.dataTransfer?.setData(DRAG_GROUP, placement.dataset.groupId || '');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        placement.classList.add('dragging');
      } else if (groupCard) {
        state.dragPayload = { kind: 'group', groupId: groupCard.dataset.dragGroup };
        event.dataTransfer?.setData(DRAG_GROUP, groupCard.dataset.dragGroup);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
        groupCard.closest('.pss-group-card')?.classList.add('dragging');
      }
    }

    function clearDragState() {
      state.dragPayload = null;
      rootElement.querySelectorAll('.dragging, .drag-over').forEach((item) => item.classList.remove('dragging', 'drag-over'));
    }

    function handleDragOver(event) {
      const target = event.target.closest('[data-time-date], [data-unassign-drop]');
      if (!target || !state.dragPayload || target.dataset.outsideSession === 'true') return;
      if (target.matches('[data-unassign-drop]') && state.dragPayload.kind !== 'placement') return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = target.matches('[data-unassign-drop]') ? 'move' : state.dragPayload.kind === 'placement' ? 'move' : 'copy';
      rootElement.querySelectorAll('.drag-over').forEach((item) => { if (item !== target) item.classList.remove('drag-over'); });
      target.classList.add('drag-over');
    }

    function handleDragLeave(event) {
      const target = event.target.closest('[data-time-date], [data-unassign-drop]');
      if (target && !target.contains(event.relatedTarget)) target.classList.remove('drag-over');
    }

    async function handleDrop(event) {
      const target = event.target.closest('[data-time-date], [data-unassign-drop]');
      const payload = state.dragPayload;
      if (!target || !payload || target.dataset.outsideSession === 'true') return;
      event.preventDefault();
      target.classList.remove('drag-over');
      if (target.matches('[data-unassign-drop]')) {
        if (payload.kind === 'placement') await removePlacement(payload.slotId, { confirm: false });
        clearDragState();
        return;
      }
      const session = selectedSession();
      if (!session) return;
      const settings = sessionSettings(session);
      const date = target.dataset.timeDate;
      const rect = target.getBoundingClientRect();
      const ratio = rect.height ? Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) : 0;
      const startLimit = timeMinutes(settings.displayStartTime);
      const endLimit = timeMinutes(settings.displayEndTime);
      let start = startLimit + Math.round((ratio * (endLimit - startLimit)) / settings.stepMinutes) * settings.stepMinutes;
      const existing = payload.slotId ? findSlot(payload.slotId) : null;
      const duration = existing && timeMinutes(existing.endTime) > timeMinutes(existing.startTime)
        ? timeMinutes(existing.endTime) - timeMinutes(existing.startTime)
        : Math.max(settings.stepMinutes, Number(project()?.settings?.sessionDurationMinutes) || 60);
      if (start + duration > endLimit) start = Math.max(startLimit, endLimit - duration);
      const fields = {
        sessionId: session.id,
        groupId: payload.groupId || existing?.scheduleGroupId,
        date,
        startTime: timeText(start),
        endTime: timeText(Math.min(endLimit, start + duration)),
        label: existing?.label || groupTitle(allGroups().find((group) => group.id === (payload.groupId || existing?.scheduleGroupId))),
        status: existing?.status || 'draft'
      };
      if (existing) await runAction('placement.move', { ...fields, slotId: existing.id }, { success: '그룹 일정을 옮겼습니다.' });
      else await runAction('placement.add', fields, { success: '그룹을 일정에 배치했습니다.' });
      clearDragState();
    }

    function handlePointerDown(event) {
      if (state.mode !== 'overview' || event.button !== 0 || event.target.closest('button, input, select, textarea, a')) return;
      const day = event.target.closest('[data-overview-date]');
      if (!day) return;
      state.rangeDrag = { pointerId: event.pointerId, start: day.dataset.overviewDate, end: day.dataset.overviewDate, moved: false };
      rootElement.setPointerCapture?.(event.pointerId);
      updateRangeHighlight();
      event.preventDefault();
    }

    function handlePointerMove(event) {
      if (!state.rangeDrag || state.rangeDrag.pointerId !== event.pointerId) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-overview-date]');
      if (!hit || !rootElement.contains(hit)) return;
      if (state.rangeDrag.end !== hit.dataset.overviewDate) {
        state.rangeDrag.end = hit.dataset.overviewDate;
        state.rangeDrag.moved = true;
        updateRangeHighlight();
      }
    }

    function finishRangeDrag(event, cancelled) {
      if (!state.rangeDrag || state.rangeDrag.pointerId !== event.pointerId) return;
      const selection = state.rangeDrag;
      state.rangeDrag = null;
      try { rootElement.releasePointerCapture?.(event.pointerId); } catch (_) {}
      updateRangeHighlight();
      if (!cancelled && selection.moved) {
        const range = orderedRange(selection.start, selection.end);
        if (range) openSessionDialog(null, range.start, range.end);
      }
    }

    function updateRangeHighlight() {
      const range = state.rangeDrag ? orderedRange(state.rangeDrag.start, state.rangeDrag.end) : null;
      rootElement.querySelectorAll('[data-overview-date]').forEach((cell) => {
        const date = cell.dataset.overviewDate;
        cell.classList.toggle('range-selecting', Boolean(range && range.start <= date && date <= range.end));
        cell.classList.toggle('range-start', Boolean(range && date === range.start));
        cell.classList.toggle('range-end', Boolean(range && date === range.end));
      });
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape' && state.rangeDrag) {
        state.rangeDrag = null;
        updateRangeHighlight();
        return;
      }
      const dayControl = event.target.closest('[data-action="open-date-session"], [data-action="open-day"]');
      if (!dayControl || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const all = [...rootElement.querySelectorAll(`[data-action="${dayControl.dataset.action}"]`)];
      const current = all.indexOf(dayControl);
      const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -7 : 7;
      const target = all[current + offset];
      if (target) { event.preventDefault(); target.focus(); }
    }

    function openSessionDialog(session = null, startDate = '', endDate = '') {
      const dialog = rootElement.querySelector('#pssSessionDialog');
      if (!dialog) return;
      const form = dialog.querySelector('form');
      form.elements.sessionId.value = session?.id || '';
      form.elements.title.value = session ? sessionTitle(session) : '';
      form.elements.startDate.value = session ? sessionStart(session) : startDate || todayKey();
      form.elements.endDate.value = session ? sessionEnd(session) : endDate || startDate || todayKey();
      form.elements.color.value = validColor(session?.color) ? session.color : '#1769aa';
      form.elements.status.value = session?.status || 'draft';
      dialog.querySelector('[data-dialog-delete="session"]').hidden = !session;
      dialog.querySelector('#pssSessionDialogTitle').textContent = session ? '세션 구간 수정' : '새 세션 구간';
      showDialog(dialog, form.elements.title);
    }

    function openGroupDialog(group = null) {
      const dialog = rootElement.querySelector('#pssGroupDialog');
      const session = selectedSession();
      if (!dialog || !session) return;
      const form = dialog.querySelector('form');
      form.reset();
      form.elements.groupId.value = group?.id || '';
      form.elements.name.value = group ? groupTitle(group) : '';
      form.elements.color.value = validColor(group?.color) ? group.color : DEFAULT_GROUP_COLORS[groupsForSession(project(), session.id).length % DEFAULT_GROUP_COLORS.length];
      form.elements.memberSearch.value = '';
      const members = new Set(groupMemberIds(group));
      const roles = groupRoleMap(group);
      dialog.querySelectorAll('[data-member-row]').forEach((row) => {
        row.hidden = false;
        const checkbox = row.querySelector('input[type="checkbox"]');
        const role = row.querySelector('select');
        checkbox.checked = members.has(checkbox.value);
        role.disabled = !checkbox.checked;
        role.value = roles[checkbox.value] || '';
        row.classList.toggle('selected', checkbox.checked);
      });
      dialog.querySelector('[data-dialog-delete="group"]').hidden = !group;
      dialog.querySelector('#pssGroupDialogTitle').textContent = group ? '그룹 구성 수정' : '새 그룹 만들기';
      showDialog(dialog, form.elements.name);
    }

    function openPlacementDialog(slot = null, groupId = '', date = '') {
      const dialog = rootElement.querySelector('#pssPlacementDialog');
      const session = selectedSession();
      if (!dialog || !session) return;
      const form = dialog.querySelector('form');
      const groups = groupsForSession(project(), session.id);
      const select = form.elements.groupId;
      select.replaceChildren();
      groups.forEach((group) => {
        const option = el('option', '', groupTitle(group));
        option.value = group.id;
        select.append(option);
      });
      const settings = sessionSettings(session);
      const selectedDate = slot?.date || (isDate(date) ? date : state.sessionAnchor || sessionStart(session));
      const startTime = slot?.startTime || nearestTime('09:00', settings.stepMinutes);
      const duration = Math.max(settings.stepMinutes, Number(project()?.settings?.sessionDurationMinutes) || 60);
      const endTime = slot?.endTime || timeText(Math.min(timeMinutes(settings.displayEndTime), timeMinutes(startTime) + duration));
      form.elements.slotId.value = slot?.id || '';
      select.disabled = Boolean(slot);
      select.title = slot ? '배치된 그룹 자체는 바뀌지 않습니다. 다른 그룹을 배치하려면 새 배치를 추가하세요.' : '';
      select.value = slot?.scheduleGroupId || groupId || groups[0]?.id || '';
      form.elements.date.value = selectedDate;
      form.elements.date.min = sessionStart(session);
      form.elements.date.max = sessionEnd(session);
      form.elements.startTime.value = startTime;
      form.elements.endTime.value = endTime;
      form.elements.startTime.step = String(settings.stepMinutes * 60);
      form.elements.endTime.step = String(settings.stepMinutes * 60);
      form.elements.label.value = slot?.label || '';
      form.elements.status.value = slot?.status || 'draft';
      form.elements.status.disabled = false;
      form.elements.status.title = '';
      dialog.querySelector('[data-dialog-delete="placement"]').hidden = !slot;
      dialog.querySelector('#pssPlacementDialogTitle').textContent = slot ? '그룹 일정 수정' : '그룹 일정 배치';
      showDialog(dialog, form.elements.date);
    }

    async function submitSession(form) {
      const values = new FormData(form);
      const startDate = String(values.get('startDate') || '');
      const endDate = String(values.get('endDate') || '');
      if (!isDate(startDate) || !isDate(endDate) || endDate < startDate) {
        notify('종료 날짜는 시작 날짜와 같거나 늦어야 합니다.', 'error');
        form.elements.endDate.focus();
        return;
      }
      const sessionId = String(values.get('sessionId') || '');
      const session = { title: String(values.get('title') || '').trim(), startDate, endDate, color: String(values.get('color') || '#1769aa'), status: String(values.get('status') || 'draft') };
      if (!session.title) { form.elements.title.focus(); return; }
      const beforeIds = new Set(sessions().map((item) => item.id));
      const result = sessionId
        ? await runAction('session.update', { sessionId, patch: session }, { success: '세션 구간을 수정했습니다.', renderAfter: false })
        : await runAction('session.add', { session }, { success: '세션 구간을 추가했습니다.', renderAfter: false });
      if (!result?.ok && result?.ok !== undefined) return;
      closeDialog(form.closest('dialog'));
      const nextId = sessionId || result?.selection?.sessionId || sessions().find((item) => !beforeIds.has(item.id))?.id;
      if (nextId) openSession(nextId);
      else render();
    }

    async function submitGroup(form) {
      const values = new FormData(form);
      const session = selectedSession();
      if (!session) return;
      const groupId = String(values.get('groupId') || '');
      const memberIds = values.getAll('memberId').map(String);
      const roleByPersonId = {};
      const members = memberIds.map((personId) => {
        const roleSelect = form.elements[`role:${personId}`];
        const roleId = String(values.get(`role:${personId}`) || [...(roleSelect?.options || [])].find((option) => option.value)?.value || '');
        if (roleId) roleByPersonId[personId] = roleId;
        return { personId, roleId: roleId || null };
      });
      const missingRole = members.find((member) => !member.roleId);
      if (missingRole) {
        notify('선택한 사람마다 역할을 하나 지정해주세요.', 'error');
        form.elements[`role:${missingRole.personId}`]?.focus?.();
        return;
      }
      const group = { name: String(values.get('name') || '').trim(), color: String(values.get('color') || DEFAULT_GROUP_COLORS[0]), memberIds, roleByPersonId, members };
      if (!group.name) { form.elements.name.focus(); return; }
      const result = groupId
        ? await runAction('group.update', { sessionId: session.id, groupId, patch: group }, { success: '그룹 구성을 수정했습니다.', renderAfter: false })
        : await runAction('group.add', { sessionId: session.id, group: { ...group, sessionId: session.id } }, { success: '새 그룹을 만들었습니다.', renderAfter: false });
      if (!result?.ok && result?.ok !== undefined) return;
      closeDialog(form.closest('dialog'));
      render();
    }

    async function submitPlacement(form) {
      const values = new FormData(form);
      const session = selectedSession();
      if (!session) return;
      const startTime = String(values.get('startTime') || '');
      const endTime = String(values.get('endTime') || '');
      if (!validTime(startTime) || !validTime(endTime) || timeMinutes(endTime) <= timeMinutes(startTime)) {
        notify('종료 시간은 시작 시간보다 늦어야 합니다.', 'error');
        form.elements.endTime.focus();
        return;
      }
      const slotId = String(values.get('slotId') || '');
      const existingSlot = slotId ? findSlot(slotId) : null;
      const payload = {
        sessionId: session.id,
        groupId: String(values.get('groupId') || existingSlot?.scheduleGroupId || ''),
        date: String(values.get('date') || ''),
        startTime,
        endTime,
        label: String(values.get('label') || '').trim(),
        status: String(values.get('status') || existingSlot?.status || 'draft')
      };
      if (!payload.groupId) { notify('배치할 그룹을 선택해주세요.', 'error'); return; }
      const result = slotId
        ? await runAction('placement.move', { ...payload, slotId }, { success: '그룹 일정을 수정했습니다.', renderAfter: false })
        : await runAction('placement.add', payload, { success: '그룹을 일정에 배치했습니다.', renderAfter: false });
      if (!result?.ok && result?.ok !== undefined) return;
      closeDialog(form.closest('dialog'));
      state.sessionAnchor = payload.date;
      render();
    }

    async function submitSettings(form) {
      const values = new FormData(form);
      const session = selectedSession();
      if (!session) return;
      const settings = {
        displayStartTime: String(values.get('displayStartTime') || ''),
        displayEndTime: String(values.get('displayEndTime') || ''),
        stepMinutes: Number(values.get('stepMinutes'))
      };
      if (!validTime(settings.displayStartTime) || !validTime(settings.displayEndTime) || timeMinutes(settings.displayEndTime) <= timeMinutes(settings.displayStartTime)) {
        notify('표시 종료 시간은 시작 시간보다 늦어야 합니다.', 'error');
        return;
      }
      await runAction('session.settings', {
        sessionId: session.id,
        viewSettings: {
          dayStart: settings.displayStartTime,
          dayEnd: settings.displayEndTime,
          stepMinutes: settings.stepMinutes,
          view: state.sessionView
        }
      }, { success: '표시 시간을 저장했습니다.' });
    }

    async function removeSessionFromDialog() {
      const form = rootElement.querySelector('#pssSessionDialog form');
      const sessionId = form?.elements.sessionId.value;
      const session = sessions().find((item) => item.id === sessionId);
      if (!session || !await ask(`“${sessionTitle(session)}” 세션과 그 안의 그룹 배치를 삭제할까요?`, { title: '세션 삭제', action: '삭제' })) return;
      const result = await runAction('session.remove', { sessionId }, { success: '세션을 삭제했습니다.', renderAfter: false });
      if (!result?.ok && result?.ok !== undefined) return;
      closeDialog(form.closest('dialog'));
      showOverview();
    }

    async function removeGroupFromDialog() {
      const form = rootElement.querySelector('#pssGroupDialog form');
      const groupId = form?.elements.groupId.value;
      const group = allGroups().find((item) => item.id === groupId);
      const session = selectedSession();
      if (!group || !session || !await ask(`“${groupTitle(group)}” 그룹을 삭제할까요? 배치된 일정도 함께 정리됩니다.`, { title: '그룹 삭제', action: '삭제' })) return;
      const result = await runAction('group.remove', { sessionId: session.id, groupId }, { success: '그룹을 삭제했습니다.', renderAfter: false });
      if (!result?.ok && result?.ok !== undefined) return;
      closeDialog(form.closest('dialog'));
      render();
    }

    async function removePlacementFromDialog() {
      const form = rootElement.querySelector('#pssPlacementDialog form');
      const slotId = form?.elements.slotId.value;
      if (!slotId || !await removePlacement(slotId, { confirm: true, renderAfter: false })) return;
      closeDialog(form.closest('dialog'));
      render();
    }

    async function removePlacement(slotId, options = {}) {
      const slot = findSlot(slotId);
      const session = selectedSession();
      if (!slot || !session) return false;
      if (options.confirm !== false && !await ask('이 그룹을 현재 시간대에서 뺄까요? 그룹 자체는 왼쪽 그룹 풀에 남습니다.', { title: '배치에서 빼기', action: '배치 해제' })) return false;
      const result = await runAction('placement.remove', { sessionId: session.id, groupId: slot.scheduleGroupId, slotId }, { success: '그룹을 배치에서 뺐습니다.', renderAfter: options.renderAfter !== false });
      return result?.ok !== false;
    }

    function adaptAction(type, payload = {}) {
      const normalizedType = ACTION_ALIASES[type] || type;
      return { type: normalizedType, payload: { ...payload }, ...payload };
    }

    async function runAction(type, payload, behavior = {}) {
      if (state.busy) return { ok: false, message: '다른 변경을 저장하는 중입니다.' };
      state.busy = true;
      rootElement.setAttribute('aria-busy', 'true');
      try {
        const result = await runtime.dispatch(adaptAction(type, payload));
        if (result && result.ok === false) {
          const message = result.message || result.blockers?.[0]?.message || '변경 내용을 적용하지 못했습니다.';
          notify(message, 'error');
          return result;
        }
        if (behavior.success) notify(behavior.success, 'success');
        if (behavior.renderAfter !== false) render();
        return result || { ok: true };
      } catch (error) {
        notify(error?.message || '변경 내용을 저장하지 못했습니다.', 'error');
        return { ok: false, error, message: error?.message };
      } finally {
        state.busy = false;
        rootElement.setAttribute('aria-busy', 'false');
      }
    }

    function openSession(id) {
      const sourceProject = project();
      const session = sessions(sourceProject).find((item) => item.id === id);
      if (!session) {
        notify('선택한 세션을 찾을 수 없습니다.', 'error');
        return api;
      }
      state.selectedSessionId = id;
      state.mode = 'session';
      const range = sessionRange(session);
      const today = todayKey(sourceProject);
      state.sessionAnchor = range && range.start <= today && today <= range.end ? today : range?.start || today;
      const preferredView = session.viewSettings?.view || session.settings?.defaultView;
      if (['day', 'week', 'month'].includes(preferredView)) state.sessionView = preferredView;
      state.pendingFocus = '[data-action="show-overview"]';
      render();
      return api;
    }

    function showOverview() {
      state.mode = 'overview';
      state.selectedSessionId = null;
      state.rangeDrag = null;
      state.pendingFocus = '.pss-overview-header [data-action="add-session"]';
      render();
      return api;
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      listenerOptions?.abort();
      rootElement.querySelectorAll('dialog[open]').forEach((dialog) => closeDialog(dialog));
      rootElement.remove();
    }

    function selectedSessionId() {
      return state.selectedSessionId;
    }

    function shiftSessionAnchor(amount) {
      if (state.sessionView === 'day') state.sessionAnchor = addDays(state.sessionAnchor, amount);
      else if (state.sessionView === 'week') state.sessionAnchor = addDays(state.sessionAnchor, amount * 7);
      else state.sessionAnchor = shiftMonth(state.sessionAnchor, amount);
    }

    function sessionPeriodLabel() {
      if (state.sessionView === 'day') return dateLabel(state.sessionAnchor, true);
      if (state.sessionView === 'week') {
        const range = weekRange(state.sessionAnchor);
        return range ? `${shortDateLabel(range.start)} – ${shortDateLabel(range.end)}` : '';
      }
      return monthLabel(state.sessionAnchor);
    }

    function assignLanes(slots, settings) {
      const startLimit = timeMinutes(settings.displayStartTime);
      const endLimit = timeMinutes(settings.displayEndTime);
      const sorted = slots.map((slot) => ({ slot, start: timeMinutes(slot.startTime), end: timeMinutes(slot.endTime) }))
        .filter((item) => item.start != null && item.end != null && item.end > item.start && item.end > startLimit && item.start < endLimit)
        .sort((left, right) => left.start - right.start || left.end - right.end);
      const rows = [];
      let cluster = [];
      let clusterEnd = -1;
      const flush = () => {
        if (!cluster.length) return;
        const laneEnds = [];
        const placed = cluster.map((item) => {
          let lane = laneEnds.findIndex((end) => end <= item.start);
          if (lane < 0) lane = laneEnds.length;
          laneEnds[lane] = item.end;
          return { ...item, lane };
        });
        const laneCount = Math.max(1, laneEnds.length);
        placed.forEach((row) => rows.push({ slot: row.slot, lane: row.lane, laneCount }));
        cluster = [];
        clusterEnd = -1;
      };
      sorted.forEach((item) => {
        if (cluster.length && item.start >= clusterEnd) flush();
        cluster.push(item);
        clusterEnd = Math.max(clusterEnd, item.end);
      });
      flush();
      return rows;
    }

    function findSlot(slotId) {
      return (Array.isArray(project()?.data?.slots) ? project().data.slots : []).find((slot) => String(slot.id ?? '') === String(slotId ?? '')) || null;
    }

    function placementPhase(slot, sourceProject) {
      if (slot?.status === 'cancelled') return 'cancelled';
      if (CalendarCore && typeof CalendarCore.classifySlot === 'function') {
        return CalendarCore.classifySlot(slot, { project: sourceProject })?.status || 'upcoming';
      }
      return slot?.date < todayKey(sourceProject) ? 'past' : 'upcoming';
    }

    function sessionPhase(session, sourceProject) {
      const range = sessionRange(session);
      const today = todayKey(sourceProject);
      if (session?.status === 'cancelled') return 'cancelled';
      if (!range) return 'invalid';
      if (range.end < today) return 'past';
      if (range.start <= today && today <= range.end) return 'live';
      return 'upcoming';
    }

    function sessionPhaseLabel(phase) {
      return ({ past: '종료', live: '진행 중', upcoming: '예정', cancelled: '취소', invalid: '날짜 확인' })[phase] || '예정';
    }

    function printScheduler() {
      const sourceProject = project();
      if (!sourceProject) return;
      const html = buildPrintDocument(sourceProject);
      const smokeMode = new URLSearchParams(globalThis.location?.search || '').get('smoke') === '1';
      if (smokeMode) {
        globalThis.__sessionSchedulerLastPrintHtml = html;
        return;
      }
      const frame = document.createElement('iframe');
      frame.className = 'pss-print-frame';
      frame.title = '세션 일정 인쇄 준비';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
      const cleanup = () => { if (frame.isConnected) frame.remove(); };
      frame.addEventListener('load', async () => {
        try {
          await frame.contentDocument?.fonts?.ready;
          frame.contentWindow?.addEventListener?.('afterprint', cleanup, { once: true });
          frame.contentWindow?.focus?.();
          frame.contentWindow?.print?.();
          setTimeout(cleanup, 60_000);
        } catch (error) {
          cleanup();
          notify(error?.message || '인쇄 화면을 열지 못했습니다.', 'error');
        }
      }, { once: true });
      frame.srcdoc = html;
      document.body.append(frame);
    }

    function buildPrintDocument(sourceProject) {
      const generatedAt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date());
      const style = `
        @page { size: A4 landscape; margin: 10mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #17202b; background: #fff; font: 10pt/1.45 "Malgun Gothic", "Segoe UI", sans-serif; }
        header { display: flex; align-items: flex-end; justify-content: space-between; gap: 12mm; margin-bottom: 7mm; border-bottom: 2px solid #2f678f; padding-bottom: 4mm; }
        h1 { margin: 0; font-size: 19pt; letter-spacing: -.03em; } h2 { margin: 7mm 0 3mm; font-size: 13pt; } h3 { margin: 0 0 2mm; font-size: 11pt; }
        p { margin: 1mm 0; } .muted { color: #687581; font-size: 8.5pt; } .badge { display: inline-block; border: 1px solid #8aa7bc; padding: 1mm 2mm; color: #285b80; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 0 0 5mm; }
        thead { display: table-header-group; } tr { break-inside: avoid; } th, td { border: 1px solid #aeb8c1; padding: 2.2mm 2.5mm; vertical-align: top; overflow-wrap: anywhere; }
        th { background: #edf2f5; text-align: left; font-size: 8.5pt; } td { font-size: 8.7pt; } .time { width: 26mm; font-variant-numeric: tabular-nums; } .date { width: 35mm; } .status { width: 20mm; }
        .section { break-inside: avoid-page; margin-bottom: 5mm; } .group-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3mm; }
        .group { break-inside: avoid; border: 1px solid #aeb8c1; border-left: 4px solid var(--group-color, #477b9e); padding: 3mm; }
        .group ul { margin: 2mm 0 0; padding-left: 5mm; } .empty { border: 1px dashed #aeb8c1; padding: 4mm; color: #687581; }
        footer { margin-top: 5mm; border-top: 1px solid #c5ccd2; padding-top: 2mm; color: #7a858e; font-size: 7.5pt; }
      `;
      const head = `<header><div><span class="badge">CMOE Workspace</span><h1>${escapePrint(sourceProject.name || '프로젝트')} · 세션 일정</h1></div><div class="muted">${escapePrint(generatedAt)} 출력</div></header>`;
      if (state.mode !== 'session' || !selectedSession(sourceProject)) {
        const rows = sessions(sourceProject).map((session) => {
          const range = sessionRange(session); const groupCount = groupsForSession(sourceProject, session.id).length; const placementCount = placementsForSession(sourceProject, session.id).filter((slot) => slot.status !== 'cancelled').length;
          return `<tr><td>${escapePrint(sessionTitle(session))}</td><td>${escapePrint(dateRangeLabel(range))}</td><td>${groupCount}</td><td>${placementCount}</td><td>${escapePrint(sessionPhaseLabel(sessionPhase(session, sourceProject)))}</td></tr>`;
        }).join('');
        const content = rows ? `<table><thead><tr><th>세션</th><th>기간</th><th>그룹</th><th>배치</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">등록된 세션이 없습니다.</div>';
        return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapePrint(sourceProject.name)} 전체 세션</title><style>${style}</style></head><body>${head}<h2>전체 세션</h2>${content}<footer>화면의 축약 표시와 관계없이 등록된 세션을 모두 출력했습니다.</footer></body></html>`;
      }
      const session = selectedSession(sourceProject); const range = sessionRange(session); const settings = sessionSettings(session); const groups = groupsForSession(sourceProject, session.id); const placements = placementsForSession(sourceProject, session.id);
      let periodStart = range.start; let periodEnd = range.end;
      if (state.sessionView === 'day') periodStart = periodEnd = state.sessionAnchor;
      else if (state.sessionView === 'week') { const week = weekRange(state.sessionAnchor); periodStart = week?.start || periodStart; periodEnd = week?.end || periodEnd; }
      else {
        const month = monthGrid(monthStart(state.sessionAnchor)); const inMonthDates = (month?.days || []).map((entry) => typeof entry === 'string' ? entry : entry.date).filter((date) => date?.slice(0, 7) === state.sessionAnchor.slice(0, 7));
        periodStart = month?.monthStart || monthStart(state.sessionAnchor); periodEnd = month?.monthEnd || inMonthDates.at(-1) || range.end;
      }
      periodStart = periodStart < range.start ? range.start : periodStart; periodEnd = periodEnd > range.end ? range.end : periodEnd;
      const visiblePlacements = placements.filter((slot) => slot.date <= periodEnd && (slot.endDate || slot.date) >= periodStart).sort((left, right) => `${left.date}|${left.startTime}|${left.id}`.localeCompare(`${right.date}|${right.startTime}|${right.id}`));
      const groupMap = new Map(groups.map((group) => [String(group.id), group])); const people = new Map((sourceProject.data.people || []).map((person) => [String(person.id), person])); const roles = new Map((sourceProject.data.roles || []).map((role) => [String(role.id), role]));
      const memberText = (group) => (group?.members || []).map((member) => `${people.get(String(member.personId))?.name || '이름 없음'} · ${roles.get(String(member.roleId))?.name || '역할 없음'}`).join(', ') || '구성원 없음';
      const placementRows = visiblePlacements.map((slot) => { const group = groupMap.get(String(slot.scheduleGroupId)); const date = slot.endDate && slot.endDate !== slot.date ? `${slot.date}–${slot.endDate}` : slot.date; return `<tr><td class="date">${escapePrint(date)}</td><td class="time">${escapePrint(`${slot.startTime || '--:--'}–${slot.endTime || '--:--'}`)}</td><td>${escapePrint(group?.name || slot.label || '그룹')}</td><td>${escapePrint(memberText(group))}</td><td class="status">${escapePrint(({ draft: '편성 중', confirmed: '확정', changed: '변경됨', cancelled: '취소' })[slot.status] || slot.status || '편성 중')}</td></tr>`; }).join('');
      const activePlaced = new Set(placements.filter((slot) => slot.status !== 'cancelled').map((slot) => String(slot.scheduleGroupId))); const unassigned = groups.filter((group) => !activePlaced.has(String(group.id)));
      const groupCards = groups.map((group) => `<article class="group" style="--group-color:${validColor(group.color) ? group.color : '#477b9e'}"><h3>${escapePrint(groupTitle(group))}</h3><p>${escapePrint(memberText(group))}</p><p class="muted">${activePlaced.has(String(group.id)) ? '일정 배치됨' : '미배치'}</p></article>`).join('');
      const content = placementRows ? `<table><thead><tr><th class="date">날짜</th><th class="time">시간</th><th>그룹</th><th>구성원 · 역할</th><th class="status">상태</th></tr></thead><tbody>${placementRows}</tbody></table>` : '<div class="empty">선택한 보기 구간에 배치된 그룹이 없습니다.</div>';
      return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapePrint(sessionTitle(session))} 일정</title><style>${style}</style></head><body>${head}<section class="section"><h2>${escapePrint(sessionTitle(session))}</h2><p>${escapePrint(dateRangeLabel(range))} · ${escapePrint(VIEW_LABELS[state.sessionView] || '')} 보기 · 표시 ${escapePrint(settings.displayStartTime)}–${escapePrint(settings.displayEndTime)} · ${settings.stepMinutes}분 간격</p><p class="muted">출력 범위 ${escapePrint(periodStart)}–${escapePrint(periodEnd)} · 미배치 그룹 ${unassigned.length}개</p></section><section><h2>그룹 배치</h2>${content}</section><section><h2>그룹 구성</h2><div class="group-grid">${groupCards || '<div class="empty">등록된 그룹이 없습니다.</div>'}</div></section><footer>화면에서 접힌 항목까지 모두 펼쳐 출력했습니다. 같은 시간의 여러 그룹은 각각 한 행으로 표시됩니다.</footer></body></html>`;
    }

    function notify(message, kind = 'normal') {
      if (!message) return;
      if (runtime.toast) runtime.toast(message, kind);
    }

    async function ask(message, details = {}) {
      if (runtime.confirm) return Boolean(await runtime.confirm(message, details));
      return Boolean(globalThis.confirm?.(message));
    }

    function showDialog(dialog, focusTarget) {
      if (!dialog) return;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      queueMicrotask(() => focusTarget?.focus?.());
    }

    function closeDialog(dialog) {
      if (!dialog) return;
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
    }

    function safeCoreCall(callback) {
      try { return callback(); } catch (_) { return null; }
    }

    const api = { render, openSession, showOverview, destroy, selectedSessionId };
    return api;
  }

  function el(tag, className = '', text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function button(label, className = '', action = '', type = 'button') {
    const control = el('button', className, label);
    control.type = type;
    if (action) control.dataset.action = action;
    return control;
  }

  function iconButton(label, action, ariaLabel) {
    const control = button(label, 'pss-icon-button', action);
    control.setAttribute('aria-label', ariaLabel);
    return control;
  }

  function emptyState(title, description) {
    const node = el('div', 'pss-empty');
    node.append(el('strong', '', title), el('p', '', description));
    return node;
  }

  function dialogHeader(id, title, description, kind) {
    const header = el('header', 'pss-dialog-header');
    const copy = el('div');
    copy.append(el('span', 'pss-eyebrow', kind === 'group' ? '그룹 편성' : kind === 'placement' ? '시간 배치' : '세션 일정'), el('h2', '', title), el('p', '', description));
    copy.querySelector('h2').id = id;
    const close = button('×', 'pss-dialog-close', 'close-dialog');
    close.setAttribute('aria-label', '닫기');
    header.append(copy, close);
    return header;
  }

  function labeledInput(labelText, type, name, value = '', options = {}) {
    const label = el('label', 'pss-field');
    label.append(el('span', '', labelText));
    const input = el('input');
    input.type = type;
    input.name = name;
    input.value = value;
    if (options.required) input.required = true;
    if (options.placeholder) input.placeholder = options.placeholder;
    label.append(input);
    return label;
  }

  function labeledSelect(labelText, name, choices) {
    const label = el('label', 'pss-field');
    label.append(el('span', '', labelText));
    const select = el('select');
    select.name = name;
    choices.forEach(([value, text]) => {
      const option = el('option', '', text);
      option.value = value;
      select.append(option);
    });
    label.append(select);
    return label;
  }

  function hiddenInput(name) {
    const input = el('input');
    input.type = 'hidden';
    input.name = name;
    return input;
  }

  function validColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ''));
  }

  function validTime(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
  }

  function timeMinutes(value) {
    if (CalendarCore && typeof CalendarCore.timeToMinutes === 'function') return CalendarCore.timeToMinutes(value);
    if (!validTime(value)) return null;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  }

  function timeText(value) {
    if (CalendarCore && typeof CalendarCore.minutesToTime === 'function') return CalendarCore.minutesToTime(Math.max(0, Math.min(1439, Math.round(value))));
    const minutes = Math.max(0, Math.min(1439, Math.round(value)));
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function nearestTime(value, step) {
    const minutes = timeMinutes(value);
    return minutes == null ? '09:00' : timeText(Math.round(minutes / step) * step);
  }

  function isDate(value) {
    if (CalendarCore && typeof CalendarCore.isValidDateKey === 'function') return CalendarCore.isValidDateKey(value);
    return Boolean(parseDate(value));
  }

  function parseDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    return Number.isFinite(date.getTime()) && localDateKey(date) === value ? date : null;
  }

  function localDateKey(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function addDays(date, amount) {
    if (CalendarCore && typeof CalendarCore.addDays === 'function') return CalendarCore.addDays(date, amount);
    const parsed = parseDate(date);
    if (!parsed) return date;
    parsed.setUTCDate(parsed.getUTCDate() + amount);
    return localDateKey(parsed);
  }

  function orderedRange(first, second) {
    if (CalendarCore && typeof CalendarCore.orderedDateRange === 'function') return CalendarCore.orderedDateRange(first, second);
    if (!isDate(first) || !isDate(second)) return null;
    return first <= second ? { start: first, end: second } : { start: second, end: first };
  }

  function monthStart(value) {
    return isDate(value) ? `${value.slice(0, 7)}-01` : '';
  }

  function shiftMonth(value, amount) {
    const parsed = parseDate(monthStart(value));
    if (!parsed) return value;
    parsed.setUTCMonth(parsed.getUTCMonth() + amount, 1);
    return localDateKey(parsed);
  }

  function fallbackMonthGrid(anchor) {
    const first = parseDate(monthStart(anchor));
    if (!first) return { monthStart: anchor, days: [] };
    const mondayOffset = (first.getUTCDay() + 6) % 7;
    const start = addDays(localDateKey(first), -mondayOffset);
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
    const endOffset = 6 - ((last.getUTCDay() + 6) % 7);
    const end = addDays(localDateKey(last), endOffset);
    const days = [];
    for (let date = start; date <= end; date = addDays(date, 1)) days.push({ date, inMonth: date.slice(0, 7) === anchor.slice(0, 7) });
    return { monthStart: monthStart(anchor), days };
  }

  function dateLabel(value, weekday = false) {
    const date = parseDate(value);
    if (!date) return value || '날짜 미정';
    return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: weekday ? 'short' : undefined, timeZone: 'UTC' }).format(date);
  }

  function shortDateLabel(value) {
    const date = parseDate(value);
    if (!date) return value || '';
    return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function monthLabel(value) {
    const date = parseDate(monthStart(value));
    if (!date) return '';
    return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
  }

  function dayName(value) {
    const date = parseDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('ko-KR', { weekday: 'short', timeZone: 'UTC' }).format(date);
  }

  function dateRangeLabel(range) {
    if (!range) return '기간 미정';
    if (range.start === range.end) return dateLabel(range.start, true);
    return `${dateLabel(range.start, true)} – ${dateLabel(range.end, true)}`;
  }

  function escapePrint(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return { create };
});
