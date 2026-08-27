(function exposeOperationsCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OperationsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function makeId(prefix = 'item') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function clean(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').trim();
  }

  function classifyValue(value) {
    const text = clean(value);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'email';
    if (/^\+?[\d\s()-]{7,}$/.test(text)) return 'phone';
    if (/^https?:\/\//i.test(text)) return 'url';
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(text)) return 'date';
    if (/^-?[\d,.]+$/.test(text)) return 'number';
    return 'text';
  }

  function inferVerticalRecords(rows) {
    if (rows.length < 4 || !rows.every((row) => row.length === 1 && clean(row[0]))) return rows;
    const values = rows.map((row) => clean(row[0]));
    let best = null;
    for (let width = 2; width <= Math.min(16, Math.floor(values.length / 2)); width += 1) {
      if (values.length % width !== 0) continue;
      const recordCount = values.length / width;
      if (recordCount < 2) continue;
      let matches = 0;
      for (let column = 0; column < width; column += 1) {
        const kinds = Array.from({ length: recordCount }, (_, row) => classifyValue(values[row * width + column]));
        const majority = Math.max(...[...new Set(kinds)].map((kind) => kinds.filter((value) => value === kind).length));
        matches += majority;
      }
      const consistency = matches / values.length;
      const score = consistency + Math.min(recordCount, 6) * 0.01 - width * 0.0001;
      if (consistency >= 0.8 && (!best || score > best.score)) best = { width, recordCount, score };
    }
    if (!best) return rows;
    const records = Array.from({ length: best.recordCount }, (_, index) => values.slice(index * best.width, (index + 1) * best.width));
    let textCount = 0;
    let emailCount = 0;
    const headers = Array.from({ length: best.width }, (_, columnIndex) => {
      const columnValues = records.map((record) => record[columnIndex]);
      const kinds = columnValues.map(classifyValue);
      const kind = [...new Set(kinds)].sort((a, b) => kinds.filter((v) => v === b).length - kinds.filter((v) => v === a).length)[0];
      if (kind === 'email') {
        emailCount += 1;
        const duplicate = Array.from({ length: columnIndex }, (_, index) => index)
          .some((earlier) => records.every((record) => record[earlier] === record[columnIndex] && classifyValue(record[earlier]) === 'email'));
        return duplicate ? '아이디' : (emailCount === 1 ? '이메일' : `이메일${emailCount}`);
      }
      if (kind === 'phone') return '전화번호';
      if (kind === 'date') return '날짜';
      if (kind === 'url') return '링크';
      if (kind === 'number') return '숫자';
      textCount += 1;
      return textCount === 1 ? '이름' : `텍스트${textCount}`;
    });
    return [headers, ...records];
  }

  function parseDelimited(text) {
    let normalized = String(text || '').replace(/\r\n?/g, '\n').trimEnd();
    if (!normalized) return [];
    if (!normalized.includes('\t') && !normalized.includes(',') && /\S[ ]{2,}\S/.test(normalized)) {
      normalized = normalized.split('\n').map((line) => line.trim().split(/[ ]{2,}/).join('\t')).join('\n');
    }
    const delimiter = normalized.includes('\t') ? '\t' : ',';
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (char === '"') {
        if (quoted && normalized[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) { row.push(cell); cell = ''; }
      else if (char === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += char;
    }
    row.push(cell);
    rows.push(row);
    return inferVerticalRecords(rows.filter((candidate) => candidate.some((value) => clean(value))));
  }

  function inferColumnType(name, values) {
    const header = clean(name).toLowerCase();
    if (/^(이름|성함|성명|name)$/.test(header)) return 'name';
    if (/(이메일|메일|e-mail|email)/.test(header)) return /아이디/.test(header) ? 'id' : 'email';
    if (/(전화|휴대폰|핸드폰|연락처|phone|mobile)/.test(header)) return 'phone';
    if (/(소속|회사|부서|그룹|분류|유형|group|category)/.test(header)) return 'group';
    if (/(아이디|id)$/.test(header)) return 'id';
    const kinds = values.filter((value) => clean(value)).map(classifyValue);
    if (kinds.length) {
      const dominant = [...new Set(kinds)].sort((a, b) => kinds.filter((v) => v === b).length - kinds.filter((v) => v === a).length)[0];
      if (kinds.filter((kind) => kind === dominant).length >= Math.ceil(kinds.length * 0.7)) {
        if (dominant === 'email' || dominant === 'phone') return dominant;
      }
    }
    return 'text';
  }

  function matrixToRoster(matrix) {
    if (!Array.isArray(matrix) || !matrix.length) return { columns: [], people: [], warnings: ['가져올 데이터가 없습니다.'] };
    const width = Math.max(...matrix.map((row) => row.length));
    const first = Array.from({ length: width }, (_, index) => clean(matrix[0]?.[index]));
    const dataLike = (value) => ['email', 'phone', 'url', 'date', 'number'].includes(classifyValue(value));
    const looksLikeHeader = first.filter(Boolean).length >= Math.ceil(width * 0.6)
      && new Set(first.map((value) => value.toLowerCase())).size === first.length
      && first.filter(dataLike).length === 0;
    const headers = looksLikeHeader ? first : Array.from({ length: width }, (_, index) => `컬럼${index + 1}`);
    const dataRows = (looksLikeHeader ? matrix.slice(1) : matrix)
      .filter((row) => row.some((value) => clean(value)))
      .map((row) => Array.from({ length: width }, (_, index) => clean(row[index])));
    const columns = headers.map((name, index) => ({
      id: makeId('column'),
      name: name || `컬럼${index + 1}`,
      type: inferColumnType(name, dataRows.map((row) => row[index]))
    }));
    if (!columns.some((column) => column.type === 'name') && columns.length) {
      const textIndex = columns.findIndex((column) => column.type === 'text');
      columns[textIndex < 0 ? 0 : textIndex].type = 'name';
      if (!looksLikeHeader) columns[textIndex < 0 ? 0 : textIndex].name = '이름';
    }
    const primaryEmail = columns.find((column) => column.type === 'email');
    const primaryPhone = columns.find((column) => column.type === 'phone');
    const primaryName = columns.find((column) => column.type === 'name');
    const primaryGroup = columns.find((column) => column.type === 'group');
    const people = dataRows.map((row, rowIndex) => {
      const values = Object.fromEntries(columns.map((column, index) => [column.id, row[index] || '']));
      return {
        id: makeId('person'),
        sourceOrder: rowIndex,
        values,
        name: primaryName ? values[primaryName.id] : '',
        email: primaryEmail ? values[primaryEmail.id] : '',
        phone: primaryPhone ? values[primaryPhone.id] : '',
        group: primaryGroup ? values[primaryGroup.id] : '',
        roleIds: ['participant'],
        active: true
      };
    });
    const warnings = [];
    const emailSeen = new Map();
    people.forEach((person, index) => {
      if (!person.name) warnings.push(`${index + 1}행: 이름이 비어 있습니다.`);
      const email = person.email.toLowerCase();
      if (email) {
        if (emailSeen.has(email)) warnings.push(`${index + 1}행: 이메일이 ${emailSeen.get(email) + 1}행과 중복됩니다.`);
        else emailSeen.set(email, index);
      }
    });
    return { columns, people, warnings };
  }

  function isValidCalendarDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
  }

  function timeToMinutes(value) {
    const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function validateScheduleSlot(slot = {}) {
    const issues = [];
    if (!isValidCalendarDate(slot.date)) issues.push({ type: 'sheet', code: 'invalidDate', field: 'date', message: '날짜를 YYYY-MM-DD 형식의 실제 날짜로 입력해주세요.' });
    const startMinutes = timeToMinutes(slot.startTime);
    const endMinutes = timeToMinutes(slot.endTime);
    if (startMinutes == null) issues.push({ type: 'sheet', code: 'invalidStartTime', field: 'startTime', message: '시작 시간을 00:00–23:59 범위의 HH:MM 형식으로 입력해주세요.' });
    if (endMinutes == null) issues.push({ type: 'sheet', code: 'invalidEndTime', field: 'endTime', message: '종료 시간을 00:00–23:59 범위의 HH:MM 형식으로 입력해주세요.' });
    if (startMinutes != null && endMinutes != null && endMinutes <= startMinutes) issues.push({ type: 'sheet', code: 'invalidTimeRange', field: 'timeRange', message: '종료 시간은 시작 시간보다 늦어야 합니다.' });
    return issues;
  }

  function parseSlots(text) {
    const slots = [];
    const errors = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
      const value = clean(line);
      if (!value) return;
      const match = value.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{2}:\d{2})\s*[-~]\s*(\d{2}:\d{2})(?:\s+(.+))?$/);
      if (!match) { errors.push(`${index + 1}줄 형식을 확인해주세요: ${value}`); return; }
      const date = match[1].replace(/[/.]/g, '-').split('-').map((part, partIndex) => partIndex ? part.padStart(2, '0') : part).join('-');
      const slot = { id: makeId('slot'), date, startTime: match[2], endTime: match[3], label: clean(match[4]), locked: false, status: 'draft' };
      const issues = validateScheduleSlot(slot);
      if (issues.length) { issues.forEach((issue) => errors.push(`${index + 1}줄: ${issue.message}`)); return; }
      slots.push(slot);
    });
    return { slots, errors };
  }

  function slotKey(slot) {
    return `${slot.date} ${slot.startTime}-${slot.endTime}`;
  }

  function overlaps(a, b) {
    return a.date === b.date && a.startTime < b.endTime && b.startTime < a.endTime;
  }

  function generateSchedule({ people, roles, slots, availability, existingAssignments = [], historyPairs = [], rules = {} }) {
    const activePeople = (people || []).filter((person) => person.active !== false);
    const orderedSlots = (slots || []).filter((slot) => slot.status !== 'cancelled').sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
    const orderedSlotMap = new Map(orderedSlots.map((slot) => [slot.id, slot]));
    const orderedRoles = (roles || []).filter((role) => role.active !== false);
    const assignments = existingAssignments.filter((assignment) => {
      const slot = orderedSlotMap.get(assignment.slotId);
      return Boolean(slot && (assignment.locked || slot.locked));
    }).map((item) => ({ ...item }));
    const assignmentCounts = new Map();
    const pairCounts = new Map();
    const assignedByPerson = new Map();
    const history = new Set(historyPairs.map((pair) => pair.slice().sort().join('|')));

    for (const assignment of assignments) {
      assignmentCounts.set(`${assignment.personId}|${assignment.roleId}`, (assignmentCounts.get(`${assignment.personId}|${assignment.roleId}`) || 0) + 1);
      if (!assignedByPerson.has(assignment.personId)) assignedByPerson.set(assignment.personId, []);
      assignedByPerson.get(assignment.personId).push(assignment.slotId);
    }

    function isAvailable(personId, slotId) {
      const selected = availability?.[personId];
      if (!Array.isArray(selected)) return Boolean(rules.unmarkedMeansAvailable);
      return selected.includes(slotId);
    }

    function hasConflict(personId, slot) {
      const assignedSlots = assignedByPerson.get(personId) || [];
      return assignedSlots.some((slotId) => {
        const other = orderedSlots.find((candidate) => candidate.id === slotId);
        return other && overlaps(slot, other);
      });
    }

    function peopleAlreadyInSlot(slotId) {
      return assignments.filter((assignment) => assignment.slotId === slotId).map((assignment) => assignment.personId);
    }

    function candidateScore(person, role, slot) {
      const count = assignmentCounts.get(`${person.id}|${role.id}`) || 0;
      let score = count * 1000 + (person.sourceOrder || 0);
      const currentPeople = peopleAlreadyInSlot(slot.id);
      for (const currentId of currentPeople) {
        const pair = [person.id, currentId].sort().join('|');
        score += (pairCounts.get(pair) || 0) * (rules.avoidRepeatPairing === false ? 0 : 300);
        if (history.has(pair) && rules.avoidPastPairing !== false) score += 500;
        const current = activePeople.find((item) => item.id === currentId);
        if (current && person.group && current.group) {
          if (rules.groupPreference === 'same' && current.group !== person.group) score += 80;
          if (rules.groupPreference === 'different' && current.group === person.group) score += 80;
        }
      }
      return score;
    }

    for (const slot of orderedSlots) {
      for (const role of orderedRoles) {
        const existingCount = assignments.filter((assignment) => assignment.slotId === slot.id && assignment.roleId === role.id).length;
        const maximum = Math.max(Number(role.maxPerSession) || 0, Number(role.minPerSession) || 0);
        for (let position = existingCount; position < maximum; position += 1) {
          const candidates = activePeople.filter((person) => {
            if (!(person.roleIds || []).includes(role.id)) return false;
            if (!isAvailable(person.id, slot.id)) return false;
            if (hasConflict(person.id, slot)) return false;
            if (assignments.some((assignment) => assignment.slotId === slot.id && assignment.personId === person.id)) return false;
            const target = Number(role.targetSessions) || 0;
            const count = assignmentCounts.get(`${person.id}|${role.id}`) || 0;
            if (target > 0 && count >= target) return false;
            return true;
          }).sort((a, b) => candidateScore(a, role, slot) - candidateScore(b, role, slot) || a.id.localeCompare(b.id));
          if (!candidates.length) break;
          const selected = candidates[0];
          const assignment = { id: makeId('assignment'), slotId: slot.id, personId: selected.id, roleId: role.id, locked: false, source: 'generated' };
          const currentPeople = peopleAlreadyInSlot(slot.id);
          currentPeople.forEach((currentId) => {
            const pair = [selected.id, currentId].sort().join('|');
            pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
          });
          assignments.push(assignment);
          assignmentCounts.set(`${selected.id}|${role.id}`, (assignmentCounts.get(`${selected.id}|${role.id}`) || 0) + 1);
          if (!assignedByPerson.has(selected.id)) assignedByPerson.set(selected.id, []);
          assignedByPerson.get(selected.id).push(slot.id);
        }
      }
    }

    const conflicts = [];
    for (const slot of orderedSlots) {
      for (const role of orderedRoles) {
        const count = assignments.filter((assignment) => assignment.slotId === slot.id && assignment.roleId === role.id).length;
        if (count < Number(role.minPerSession || 0)) conflicts.push({ type: 'slotMinimum', slotId: slot.id, roleId: role.id, message: `${slotKey(slot)} · ${role.name} ${Number(role.minPerSession) - count}명 부족` });
      }
    }
    for (const person of activePeople) {
      for (const role of orderedRoles.filter((candidate) => (person.roleIds || []).includes(candidate.id) && Number(candidate.targetSessions) > 0)) {
        const count = assignmentCounts.get(`${person.id}|${role.id}`) || 0;
        if (count < Number(role.targetSessions)) conflicts.push({ type: 'personTarget', personId: person.id, roleId: role.id, message: `${person.name || '이름 없음'} · ${role.name} ${Number(role.targetSessions) - count}회 부족` });
      }
    }
    return { assignments, conflicts, generatedAt: new Date().toISOString() };
  }

  function validateAssignments({ assignments, people, roles, slots }) {
    const errors = [];
    const slotMap = new Map(slots.map((slot) => [slot.id, slot]));
    const personMap = new Map(people.map((person) => [person.id, person]));
    const roleMap = new Map(roles.map((role) => [role.id, role]));
    for (const assignment of assignments) {
      if (!slotMap.has(assignment.slotId)) errors.push(`없는 시간대에 연결된 배정 ${assignment.id}`);
      if (!personMap.has(assignment.personId)) errors.push(`없는 사람에 연결된 배정 ${assignment.id}`);
      if (!roleMap.has(assignment.roleId)) errors.push(`없는 역할에 연결된 배정 ${assignment.id}`);
    }
    for (const person of people) {
      const personAssignments = assignments.filter((assignment) => assignment.personId === person.id && slotMap.get(assignment.slotId)?.status !== 'cancelled');
      for (let index = 0; index < personAssignments.length; index += 1) {
        for (let other = index + 1; other < personAssignments.length; other += 1) {
          const a = slotMap.get(personAssignments[index].slotId);
          const b = slotMap.get(personAssignments[other].slotId);
          if (a && b && overlaps(a, b)) errors.push(`${person.name || '이름 없음'}의 일정이 ${slotKey(a)}와 ${slotKey(b)}에 중복됩니다.`);
        }
      }
    }
    return [...new Set(errors)];
  }

  function roleAllowsPerson(role, person) {
    const filter = role?.candidateFilter || 'manual';
    if (filter === 'all') return true;
    if (filter.startsWith('column:')) {
      const [, columnId, encoded = ''] = filter.split(':');
      let expected = encoded;
      try { expected = decodeURIComponent(encoded); } catch (_) { /* Keep malformed legacy values readable. */ }
      return String(person?.values?.[columnId] || '').trim() === expected;
    }
    return (person?.roleIds || []).includes(role?.id);
  }

  function validateScheduleConstraints({ assignments = [], people = [], roles = [], slots = [], availability = {}, rules = {}, targetPersonIds = null }) {
    const issues = [];
    const personMap = new Map(people.map((person) => [person.id, person]));
    const roleMap = new Map(roles.map((role) => [role.id, role]));
    const slotMap = new Map(slots.map((slot) => [slot.id, slot]));
    const activeAssignments = assignments.filter((assignment) => {
      const slot = slotMap.get(assignment.slotId);
      const person = personMap.get(assignment.personId);
      const role = roleMap.get(assignment.roleId);
      return Boolean(slot && person && role && slot.status !== 'cancelled' && person.active !== false && role.active !== false);
    });

    assignments.forEach((assignment) => {
      const person = personMap.get(assignment.personId);
      const role = roleMap.get(assignment.roleId);
      const slot = slotMap.get(assignment.slotId);
      if (!person || !role || !slot) return;
      if (slot.status === 'cancelled') { issues.push({ type: 'cancelledSlot', personId: person.id, slotId: slot.id, roleId: role.id, message: `${slot.label || slotKey(slot)}은 취소된 일정이지만 ${person.name || '이름 없음'} 고객이 배정되어 있습니다.` }); return; }
      if (person.active === false) issues.push({ type: 'inactivePerson', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'} 고객은 현재 명단에서 제외되어 있지만 일정에 배정되어 있습니다.` });
      if (role.active === false) issues.push({ type: 'inactiveRole', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'} 고객이 사용 중지된 역할 “${role.name}”에 배정되어 있습니다.` });
      if (!roleAllowsPerson(role, person)) issues.push({ type: 'roleEligibility', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'} 고객은 ${role.name} 배정 대상으로 설정되어 있지 않습니다.` });
      const selected = availability?.[person.id];
      const available = Array.isArray(selected) ? selected.includes(slot.id) : Boolean(rules.unmarkedMeansAvailable);
      if (!available) issues.push({ type: 'unavailable', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'} 고객이 가능한 시간으로 표시하지 않은 ${slot.label || slotKey(slot)}에 배정되어 있습니다.` });
    });

    slots.filter((slot) => slot.status !== 'cancelled').forEach((slot) => {
      roles.filter((role) => role.active !== false).forEach((role) => {
        const count = activeAssignments.filter((assignment) => assignment.slotId === slot.id && assignment.roleId === role.id).length;
        const minimum = Number(role.minPerSession) || 0;
        const maximum = Math.max(Number(role.maxPerSession) || 0, minimum);
        if (count < minimum) issues.push({ type: 'slotMinimum', slotId: slot.id, roleId: role.id, amount: minimum - count, message: `${slot.label || slotKey(slot)} · ${role.name} 최소 인원보다 ${minimum - count}명 부족` });
        if (maximum && count > maximum) issues.push({ type: 'slotMaximum', slotId: slot.id, roleId: role.id, amount: count - maximum, message: `${slot.label || slotKey(slot)} · ${role.name} 정원을 ${count - maximum}명 초과` });
      });
    });

    const targetPeople = Array.isArray(targetPersonIds) ? new Set(targetPersonIds) : null;
    people.filter((person) => person.active !== false && (!targetPeople || targetPeople.has(person.id))).forEach((person) => {
      roles.filter((role) => role.active !== false && roleAllowsPerson(role, person) && Number(role.targetSessions) > 0).forEach((role) => {
        const count = activeAssignments.filter((assignment) => assignment.personId === person.id && assignment.roleId === role.id).length;
        const target = Number(role.targetSessions) || 0;
        if (count < target) issues.push({ type: 'personTarget', personId: person.id, roleId: role.id, amount: target - count, message: `${person.name || '이름 없음'} 고객 · ${role.name} 목표보다 ${target - count}회 부족` });
        if (count > target) issues.push({ type: 'personTargetMaximum', personId: person.id, roleId: role.id, amount: count - target, message: `${person.name || '이름 없음'} 고객 · ${role.name} 목표보다 ${count - target}회 많음` });
      });
    });

    const unique = new Map();
    issues.forEach((issue) => unique.set([issue.type, issue.personId || '', issue.slotId || '', issue.roleId || '', issue.message].join('|'), issue));
    return [...unique.values()];
  }

  function rosterViewIncludedIds(view, project) {
    const people = Array.isArray(project?.data?.people) ? project.data.people : [];
    const source = Array.isArray(view?.personIds) ? view.personIds : people.map((person) => person.id);
    const excluded = new Set(Array.isArray(view?.excludedPersonIds) ? view.excludedPersonIds : []);
    return source.filter((id) => !excluded.has(id) && people.some((person) => person.id === id && person.active !== false));
  }

  function scheduleSheetConflicts(project) {
    const data = project?.data || {};
    const slots = Array.isArray(data.slots) ? data.slots : [];
    const assignments = Array.isArray(data.assignments) ? data.assignments : [];
    const columns = Array.isArray(data.scheduleSheetColumns) ? data.scheduleSheetColumns : [];
    const keys = data.scheduleSheetInitialized ? new Set(columns.map((column) => column.key)) : new Set(['date', 'startTime', 'endTime']);
    const messages = [];
    if (!keys.has('date') || !keys.has('startTime') || !keys.has('endTime')) messages.push({ type: 'sheet', code: 'missingScheduleColumns', message: 'Zoom·메일 일정 연결을 사용하려면 날짜·시작·종료 컬럼을 추가하거나 해당 헤더가 있는 표를 붙여넣어주세요.' });
    slots.forEach((slot, index) => {
      const issues = validateScheduleSlot(slot).filter((issue) => {
        if (issue.field === 'date') return keys.has('date');
        if (issue.field === 'startTime') return keys.has('startTime');
        if (issue.field === 'endTime') return keys.has('endTime');
        if (issue.field === 'timeRange') return keys.has('startTime') && keys.has('endTime');
        return true;
      });
      const hasInvalidTime = issues.some((issue) => issue.code === 'invalidStartTime' || issue.code === 'invalidEndTime');
      issues.forEach((issue) => {
        if (hasInvalidTime && issue.code === 'invalidEndTime' && issues.some((candidate) => candidate.code === 'invalidStartTime')) return;
        const message = (issue.code === 'invalidStartTime' || issue.code === 'invalidEndTime')
          ? '시작·종료 시간을 00:00–23:59 범위의 HH:MM 형식으로 입력해주세요.'
          : issue.message;
        messages.push({ ...issue, message: `${index + 2}행: ${message}` });
      });
    });
    assignments.forEach((assignment) => {
      if (!assignment.personId) messages.push({ type: 'sheet', code: 'unknownPerson', assignmentId: assignment.id, message: `명단에 없는 사람 “${assignment.personName || '이름 없음'}”이 일정표에 있습니다.` });
    });
    return messages;
  }

  function collectScheduleConflicts(project) {
    const data = project?.data || {};
    const assignments = Array.isArray(data.assignments) ? data.assignments : [];
    const people = Array.isArray(data.people) ? data.people : [];
    const roles = Array.isArray(data.roles) ? data.roles : [];
    const slots = Array.isArray(data.slots) ? data.slots : [];
    const availability = data.availability && typeof data.availability === 'object' ? data.availability : {};
    const rules = data.scheduleRules && typeof data.scheduleRules === 'object' ? data.scheduleRules : {};
    const rosterViews = Array.isArray(data.rosterViews) ? data.rosterViews : [];
    const scheduleView = rosterViews.find((view) => view.id === rules.rosterViewId) || null;
    const conflicts = [
      ...scheduleSheetConflicts(project),
      ...validateAssignments({ assignments, people, roles, slots }).map((message) => ({ type: 'validation', message })),
      ...validateScheduleConstraints({ assignments, people, roles, slots, availability, rules, targetPersonIds: rosterViewIncludedIds(scheduleView, project) })
    ];
    const unique = new Map();
    conflicts.forEach((conflict) => unique.set([conflict.type || '', conflict.personId || '', conflict.slotId || '', conflict.roleId || '', conflict.message].join('|'), conflict));
    return [...unique.values()];
  }

  function scheduleConstraintIssueKey(issue) {
    return [issue.type, issue.personId || '', issue.slotId || '', issue.roleId || ''].join('|');
  }

  function scheduleConstraintIssueAmount(issue) {
    return Number.isFinite(Number(issue.amount)) ? Number(issue.amount) : 1;
  }

  function diffScheduleDependencies({ beforeSlots = [], beforeAssignments = [], afterSlots = [], afterAssignments = [] } = {}) {
    const beforeById = new Map(beforeSlots.map((slot) => [slot.id, slot]));
    const afterById = new Map(afterSlots.map((slot) => [slot.id, slot]));
    const slotIds = [...new Set([...beforeById.keys(), ...afterById.keys()])];
    const assignmentSignature = (items, slotId) => items.filter((item) => item.slotId === slotId).map((item) => `${item.personId || item.personName || ''}|${item.roleId || item.roleName || ''}`).sort().join(',');
    const scheduleSignature = (slot) => slot ? [slot.date || '', slot.startTime || '', slot.endTime || '', slot.label || '', slot.status === 'cancelled'].join('|') : '__missing__';
    const changedSlotIds = slotIds.filter((slotId) => scheduleSignature(beforeById.get(slotId)) !== scheduleSignature(afterById.get(slotId)) || assignmentSignature(beforeAssignments, slotId) !== assignmentSignature(afterAssignments, slotId));
    const zoomReviewSlotIds = changedSlotIds.filter((slotId) => {
      if (scheduleSignature(beforeById.get(slotId)) !== scheduleSignature(afterById.get(slotId))) return true;
      return beforeAssignments.some((item) => item.slotId === slotId) !== afterAssignments.some((item) => item.slotId === slotId);
    });
    const affectedPersonIds = [...new Set([...beforeAssignments, ...afterAssignments].filter((item) => changedSlotIds.includes(item.slotId)).map((item) => item.personId).filter(Boolean))];
    return { changedSlotIds, zoomReviewSlotIds, affectedPersonIds };
  }

  function planScheduleChange({ assignments = [], people = [], roles = [], slots = [], availability = {}, rules = {}, targetPersonIds = null, change = {} }) {
    const action = ['add', 'move', 'remove'].includes(change.action) ? change.action : 'move';
    const nextAssignments = assignments.map((assignment) => ({ ...assignment }));
    const assignment = change.assignmentId ? nextAssignments.find((item) => item.id === change.assignmentId) : null;
    const personId = assignment?.personId || change.personId || '';
    const roleId = assignment?.roleId || change.roleId || '';
    const person = people.find((item) => item.id === personId);
    const role = roles.find((item) => item.id === roleId);
    const fromSlot = assignment ? slots.find((item) => item.id === assignment.slotId) : null;
    const toSlot = change.toSlotId ? slots.find((item) => item.id === change.toSlotId) : null;
    const blockers = [];
    const warningMap = new Map();
    const addWarning = (warning) => {
      const key = [warning.code || '', warning.personId || '', warning.slotId || '', warning.roleId || '', warning.message || ''].join('|');
      if (!warningMap.has(key)) warningMap.set(key, warning);
    };

    if (!person) blockers.push({ code: 'missingPerson', message: '변경할 사람을 명단에서 찾지 못했습니다.' });
    else if (action !== 'remove' && person.active === false) blockers.push({ code: 'inactivePerson', message: '현재 명단에서 제외된 고객입니다.' });
    if (action !== 'add' && !assignment) blockers.push({ code: 'missingAssignment', message: '변경할 기존 일정을 찾지 못했습니다.' });
    if (assignment && !fromSlot) blockers.push({ code: 'missingSource', message: '기존 일정 정보를 찾지 못했습니다.' });
    if (action !== 'remove' && !toSlot) blockers.push({ code: 'missingTarget', message: '옮길 일정을 선택해주세요.' });
    if (!role) blockers.push({ code: 'missingRole', message: '배정 역할을 확인해주세요.' });
    else if (action !== 'remove' && role.active === false) blockers.push({ code: 'inactiveRole', message: '사용 중지된 역할에는 새로 배정할 수 없습니다.' });
    if (assignment?.locked || fromSlot?.locked) blockers.push({ code: 'lockedSource', message: '기존 일정이 잠겨 있어 먼저 잠금을 풀어야 합니다.' });
    if (action !== 'remove' && toSlot?.locked) blockers.push({ code: 'lockedTarget', message: '선택한 일정이 잠겨 있어 배정할 수 없습니다.' });
    if (action !== 'remove' && toSlot?.status === 'cancelled') blockers.push({ code: 'cancelledTarget', message: '취소된 일정에는 배정할 수 없습니다.' });
    if (action === 'move' && fromSlot?.id === toSlot?.id) blockers.push({ code: 'sameSlot', message: '현재 일정과 다른 일정을 선택해주세요.' });
    if (action !== 'remove' && assignments.some((item) => item.id !== assignment?.id && item.personId === personId && item.slotId === toSlot?.id)) {
      blockers.push({ code: 'duplicateTarget', message: '이미 이 일정에 배정된 고객입니다.' });
    }

    if (!blockers.length) {
      if (action === 'remove') nextAssignments.splice(nextAssignments.findIndex((item) => item.id === assignment.id), 1);
      else if (action === 'move') assignment.slotId = toSlot.id;
      else nextAssignments.push({
        id: change.nextAssignmentId || makeId('assignment'),
        slotId: toSlot.id,
        personId,
        roleId,
        roleName: role.name,
        locked: false,
        source: 'session-board'
      });

      const beforeErrors = new Set(validateAssignments({ assignments, people, roles, slots }));
      validateAssignments({ assignments: nextAssignments, people, roles, slots }).forEach((message) => {
        if (!beforeErrors.has(message)) addWarning({ code: 'newConflict', message });
      });

      const constraintInput = { people, roles, slots, availability, rules, targetPersonIds };
      const beforeConstraints = new Map(validateScheduleConstraints({ ...constraintInput, assignments }).map((issue) => [scheduleConstraintIssueKey(issue), issue]));
      validateScheduleConstraints({ ...constraintInput, assignments: nextAssignments }).forEach((issue) => {
        const beforeIssue = beforeConstraints.get(scheduleConstraintIssueKey(issue));
        if (!beforeIssue || scheduleConstraintIssueAmount(issue) > scheduleConstraintIssueAmount(beforeIssue)) addWarning({ ...issue, code: issue.type });
      });
    }

    const changedSlotIds = [...new Set([fromSlot?.id, toSlot?.id].filter(Boolean))];
    const zoomReviewSlotIds = changedSlotIds.filter((slotId) => {
      const beforeCount = assignments.filter((item) => item.slotId === slotId).length;
      const afterCount = nextAssignments.filter((item) => item.slotId === slotId).length;
      return (beforeCount === 0) !== (afterCount === 0);
    });
    const affectedPersonIds = [...new Set([
      personId,
      ...assignments.filter((item) => changedSlotIds.includes(item.slotId)).map((item) => item.personId),
      ...nextAssignments.filter((item) => changedSlotIds.includes(item.slotId)).map((item) => item.personId)
    ].filter(Boolean))];

    return {
      action,
      canApply: blockers.length === 0,
      blockers,
      warnings: [...warningMap.values()],
      nextAssignments,
      impact: {
        personId,
        roleId,
        assignmentId: assignment?.id || null,
        fromSlotId: fromSlot?.id || null,
        toSlotId: toSlot?.id || null,
        changedSlotIds,
        zoomReviewSlotIds,
        affectedPersonIds
      }
    };
  }

  function escapeCsv(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function scheduleRows(project) {
    const data = project.data;
    const personMap = new Map(data.people.map((person) => [person.id, person]));
    const roleMap = new Map(data.roles.map((role) => [role.id, role]));
    return data.slots.slice().sort((a, b) => slotKey(a).localeCompare(slotKey(b))).flatMap((slot) => {
      const slotAssignments = data.assignments.filter((assignment) => assignment.slotId === slot.id);
      if (!slotAssignments.length) return [[slot.date, slot.startTime, slot.endTime, slot.label, '', '', slot.status]];
      return slotAssignments.map((assignment) => [
        slot.date,
        slot.startTime,
        slot.endTime,
        slot.label,
        roleMap.get(assignment.roleId)?.name || assignment.roleId,
        personMap.get(assignment.personId)?.name || assignment.personName || assignment.personId,
        slot.status
      ]);
    });
  }

  function scheduleToCsv(project) {
    const rows = [['날짜', '시작', '종료', '세션명', '역할', '이름', '상태'], ...scheduleRows(project)];
    return `\ufeff${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`;
  }

  function escapeXml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function scheduleToExcelXml(project) {
    const rows = [['날짜', '시작', '종료', '세션명', '역할', '이름', '상태'], ...scheduleRows(project)];
    const body = rows.map((row, index) => `<Row>${row.map((value) => `<Cell${index === 0 ? ' ss:StyleID="Header"' : ''}><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`).join('')}</Row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DCE6F1" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="일정"><Table>${body}</Table></Worksheet></Workbook>`;
  }

  function buildGoogleFormDefinition(project, type = 'availability') {
    const id = makeId('form-definition');
    if (type === 'registration') {
      const questions = [
        { key: 'name', title: '성함', kind: 'text', required: true },
        { key: 'phone', title: '휴대폰 번호', kind: 'text', required: true },
        { key: 'email', title: '이메일 주소', kind: 'text', required: true },
        { key: 'group', title: '소속·분류', kind: 'text', required: false }
      ];
      return { id, type, title: `${project.name} 신청자 정보`, description: '일정 운영에 필요한 기본 정보를 입력해주세요.', collectEmail: 'RESPONDER_INPUT', questions, createdAt: new Date().toISOString() };
    }
    const options = project.data.slots.slice().sort((a, b) => slotKey(a).localeCompare(slotKey(b))).map((slot) => ({ value: `[${slot.id}] ${slot.date} ${slot.startTime}-${slot.endTime}${slot.label ? ` · ${slot.label}` : ''}`, slotId: slot.id }));
    return {
      id,
      type: 'availability',
      title: `${project.name} 가능 시간 조사`,
      description: '실제로 참여 가능한 시간을 모두 선택해주세요. 최종 일정은 전체 응답을 검토한 뒤 확정됩니다.',
      collectEmail: 'RESPONDER_INPUT',
      questions: [
        { key: 'participantId', title: '참여자 고유번호', kind: 'text', required: true },
        { key: 'name', title: '성함', kind: 'text', required: true },
        { key: 'slots', title: '참여 가능한 시간', kind: 'checkbox', required: true, options },
        { key: 'notes', title: '상세 요청사항', kind: 'paragraph', required: false }
      ],
      createdAt: new Date().toISOString()
    };
  }

  function googleFormsApiRequests(definition) {
    const requests = [
      { updateFormInfo: { info: { description: definition.description }, updateMask: 'description' } },
      { updateSettings: { settings: { emailCollectionType: definition.collectEmail || 'RESPONDER_INPUT' }, updateMask: 'emailCollectionType' } }
    ];
    definition.questions.forEach((question, index) => {
      let questionBody;
      if (question.kind === 'checkbox') {
        questionBody = { choiceQuestion: { type: 'CHECKBOX', options: question.options.map((option) => ({ value: option.value })) } };
      } else {
        questionBody = { textQuestion: { paragraph: question.kind === 'paragraph' } };
      }
      requests.push({ createItem: { item: { title: question.title, questionItem: { question: { required: Boolean(question.required), ...questionBody } } }, location: { index } } });
    });
    return requests;
  }

  function buildMailPackage(project) {
    const personMap = new Map(project.data.people.map((person) => [person.id, person]));
    const roleMap = new Map(project.data.roles.map((role) => [role.id, role]));
    const slotMap = new Map(project.data.slots.map((slot) => [slot.id, slot]));
    const entries = project.data.people.filter((person) => person.active !== false && person.email).map((person) => {
      const assignments = project.data.assignments.filter((assignment) => assignment.personId === person.id && slotMap.has(assignment.slotId) && slotMap.get(assignment.slotId).status !== 'cancelled').map((assignment) => {
        const slot = slotMap.get(assignment.slotId);
        const peers = project.data.assignments.filter((candidate) => candidate.slotId === assignment.slotId && candidate.personId !== person.id).map((candidate) => personMap.get(candidate.personId)?.name).filter(Boolean);
        const artifact = project.data.externalArtifacts.find((candidate) => candidate.kind === 'zoom' && candidate.slotId === assignment.slotId && candidate.status === 'created');
        return { date: slot?.date || '', startTime: slot?.startTime || '', endTime: slot?.endTime || '', label: slot?.label || '', role: roleMap.get(assignment.roleId)?.name || '', peers, zoomJoinUrl: artifact?.joinUrl || '' };
      }).sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
      const personalSchedule = assignments.map((item) => `${item.date} ${item.startTime}-${item.endTime}${item.label ? ` · ${item.label}` : ''}${item.peers.length ? ` · 함께: ${item.peers.join(', ')}` : ''}${item.zoomJoinUrl ? `\n${item.zoomJoinUrl}` : ''}`).join('\n\n');
      const columnVariables = Object.fromEntries((project.data.columns || []).map((column) => [column.name, person.values?.[column.id] ?? '']));
      const variables = { ...columnVariables, 프로젝트: project.name, 이름: person.name, 이메일: person.email, 개인일정: personalSchedule };
      const replace = (template) => String(template || '').replace(/\{([^{}]+)\}/g, (_match, key) => variables[key] ?? '');
      const edit = project.data.communication.mailEdits?.[person.id] || {};
      const defaultHtml = project.data.communication.bodyHtmlTemplate || String(project.data.communication.bodyTemplate || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const bodyHtml = replace(edit.bodyHtml || defaultHtml);
      const body = replace(edit.body || project.data.communication.bodyTemplate || '').trim() || bodyHtml.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      return { personId: person.id, email: person.email, name: person.name, subject: replace(edit.subject || project.data.communication.subjectTemplate), body, bodyHtml, variables, assignments, edited: Boolean(edit.updatedAt) };
    });
    return { format: 'cmoe-workspace-mail-package', version: 1, projectId: project.id, projectName: project.name, createdAt: new Date().toISOString(), entries };
  }

  function mailPackageToCsv(pkg) {
    const rows = [['이름', '이메일', '개인일정', '메일제목', '메일본문'], ...pkg.entries.map((entry) => [entry.name, entry.email, entry.variables.개인일정, entry.subject, entry.body])];
    return `\ufeff${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`;
  }

  return {
    classifyValue,
    parseDelimited,
    matrixToRoster,
    isValidCalendarDate,
    timeToMinutes,
    validateScheduleSlot,
    parseSlots,
    slotKey,
    generateSchedule,
    validateAssignments,
    validateScheduleConstraints,
    rosterViewIncludedIds,
    scheduleSheetConflicts,
    collectScheduleConflicts,
    diffScheduleDependencies,
    planScheduleChange,
    scheduleToCsv,
    scheduleToExcelXml,
    buildGoogleFormDefinition,
    googleFormsApiRequests,
    buildMailPackage,
    mailPackageToCsv
  };
});
