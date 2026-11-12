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

  function likelyRosterName(value) {
    const text = clean(value);
    if (!text || classifyValue(text) !== 'text') return false;
    if (/^(이름|성함|성명|name|이메일|메일|email|전화|전화번호|연락처|phone|휴대폰|핸드폰|소속|회사|부서)$/i.test(text)) return false;
    if (/\d/.test(text) || text.length > 40) return false;
    return /^[가-힣A-Za-z][가-힣A-Za-z .'-]*$/.test(text);
  }

  function rosterFieldKey(value, counters) {
    const kind = classifyValue(value);
    if (kind === 'text') {
      const index = counters.text || 0;
      counters.text = index + 1;
      return `text:${index}`;
    }
    const index = counters[kind] || 0;
    counters[kind] = index + 1;
    return `${kind}:${index}`;
  }

  function semanticRecordsToMatrix(records) {
    if (!records.length) return [];
    const keyedRecords = records.map((record) => {
      const counters = {};
      return record.map((value) => ({ key: rosterFieldKey(value, counters), value: clean(value) }));
    });
    const keys = [];
    keyedRecords.forEach((record) => record.forEach(({ key }) => { if (!keys.includes(key)) keys.push(key); }));
    const duplicateEmailKey = (key) => {
      if (!key.startsWith('email:') || key === 'email:0') return false;
      let comparable = 0;
      let equal = 0;
      keyedRecords.forEach((record) => {
        const first = record.find((field) => field.key === 'email:0')?.value;
        const candidate = record.find((field) => field.key === key)?.value;
        if (!first || !candidate) return;
        comparable += 1;
        if (first.toLowerCase() === candidate.toLowerCase()) equal += 1;
      });
      return comparable > 0 && equal / comparable >= 0.7;
    };
    const headers = keys.map((key) => {
      const [kind, rawIndex] = key.split(':');
      const index = Number(rawIndex);
      if (kind === 'text') return index === 0 ? '이름' : `텍스트${index + 1}`;
      if (kind === 'email') return index === 0 ? '이메일' : duplicateEmailKey(key) ? '아이디' : `이메일${index + 1}`;
      if (kind === 'phone') return index === 0 ? '전화번호' : `전화번호${index + 1}`;
      if (kind === 'url') return index === 0 ? '링크' : `링크${index + 1}`;
      if (kind === 'date') return index === 0 ? '날짜' : `날짜${index + 1}`;
      if (kind === 'number') return index === 0 ? '숫자' : `숫자${index + 1}`;
      return `컬럼${index + 1}`;
    });
    return [headers, ...keyedRecords.map((record) => {
      const values = new Map(record.map((field) => [field.key, field.value]));
      return keys.map((key) => values.get(key) || '');
    })];
  }

  function inferVariableVerticalRecords(values) {
    const records = [];
    let current = [];
    const hasIdentity = (record) => record.some((value) => ['email', 'phone'].includes(classifyValue(value)));
    const nextIdentityDistance = (start) => {
      for (let index = start + 1; index < Math.min(values.length, start + 6); index += 1) {
        if (['email', 'phone'].includes(classifyValue(values[index]))) return index - start;
        if (likelyRosterName(values[index])) return Infinity;
      }
      return Infinity;
    };
    values.forEach((value, index) => {
      const startsNextRecord = likelyRosterName(value)
        && current.length > 0
        && hasIdentity(current)
        && nextIdentityDistance(index) < Infinity;
      if (startsNextRecord) { records.push(current); current = []; }
      current.push(value);
    });
    if (current.length) records.push(current);
    if (records.length < 2) return null;
    const credible = records.filter((record) => likelyRosterName(record[0]) && hasIdentity(record)).length;
    if (credible / records.length < 0.75) return null;
    return semanticRecordsToMatrix(records);
  }

  function splitInlineRosterLine(line) {
    const value = clean(line);
    if (!value || !/\s/.test(value)) return [value];
    const matches = [];
    const typedPattern = /https?:\/\/[^\s]+|[^\s@]+@[^\s@]+\.[^\s@]+|\+?\d(?:[\d()\s-]{5,}\d)/gi;
    let match;
    while ((match = typedPattern.exec(value))) matches.push({ index: match.index, end: match.index + match[0].length, value: clean(match[0]) });
    if (!matches.length) return [value];
    const fields = [];
    let cursor = 0;
    matches.forEach((item) => {
      const before = clean(value.slice(cursor, item.index));
      if (before) fields.push(before);
      fields.push(item.value);
      cursor = item.end;
    });
    const after = clean(value.slice(cursor));
    if (after) fields.push(after);
    return fields;
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
    if (!best) return inferVariableVerticalRecords(values) || rows;
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

  function analyzeRosterInput(text) {
    const source = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!source) return { matrix: [], format: 'empty', inferred: false, warnings: [] };
    const hasTableDelimiter = source.includes('\t') || source.includes(',') || /\S[ ]{2,}\S/.test(source);
    if (hasTableDelimiter) return { matrix: parseDelimited(source), format: 'table', inferred: false, warnings: [] };
    const lines = source.split('\n').map(clean).filter(Boolean);
    const inlineRecords = lines.map(splitInlineRosterLine);
    const inlineCandidates = inlineRecords.filter((record) => record.length > 1 && record.some((value) => ['email', 'phone'].includes(classifyValue(value))));
    if (inlineCandidates.length >= Math.max(1, Math.ceil(lines.length * 0.6))) {
      const records = inlineRecords.filter((record) => record.some(Boolean));
      return {
        matrix: semanticRecordsToMatrix(records),
        format: 'inline',
        inferred: true,
        warnings: ['공백과 값의 종류를 기준으로 열을 자동 구분했습니다. 적용 전에 미리보기를 확인해주세요.']
      };
    }
    const rawRows = lines.map((value) => [value]);
    const matrix = inferVerticalRecords(rawRows);
    const inferred = matrix.length > 0 && matrix[0].length > 1;
    return {
      matrix,
      format: inferred ? 'vertical' : 'single-column',
      inferred,
      warnings: inferred
        ? ['줄마다 이어진 값을 이름·이메일·전화번호 등의 반복 패턴으로 자동 구분했습니다. 빈 항목과 열 위치를 확인해주세요.']
        : ['입력 구조를 확실하게 나누지 못해 한 열로 표시했습니다. Excel 표로 붙여넣거나 원문 구분을 확인해주세요.']
    };
  }

  function parseDelimited(text, options = {}) {
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
    const populatedRows = rows.filter((candidate) => candidate.some((value) => clean(value)));
    return options.inferVertical === false ? populatedRows : inferVerticalRecords(populatedRows);
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

  function normalizePersonRoleIds(roleIds, roles = []) {
    const stored = [...new Set((Array.isArray(roleIds) ? roleIds : []).map((id) => clean(id)).filter(Boolean))];
    if (!Array.isArray(roles) || !roles.length) return stored.length ? stored : ['participant'];
    const activeRoleIds = roles.filter((role) => role?.active !== false).map((role) => clean(role?.id)).filter(Boolean);
    const allowed = new Set(activeRoleIds);
    const selected = stored.filter((id) => allowed.has(id));
    return selected.length ? selected : activeRoleIds.slice(0, 1);
  }

  function matrixToRoster(matrix, options = {}) {
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
        roleIds: normalizePersonRoleIds([], options.roles),
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
    const endDate = clean(slot.endDate) || clean(slot.date);
    if (!isValidCalendarDate(endDate)) issues.push({ type: 'sheet', code: 'invalidEndDate', field: 'endDate', message: '종료 날짜를 실제 날짜로 선택해주세요.' });
    else if (isValidCalendarDate(slot.date) && endDate < slot.date) issues.push({ type: 'sheet', code: 'invalidDateRange', field: 'endDate', message: '종료 날짜는 시작 날짜보다 빠를 수 없습니다.' });
    const startMinutes = timeToMinutes(slot.startTime);
    const endMinutes = timeToMinutes(slot.endTime);
    if (startMinutes == null) issues.push({ type: 'sheet', code: 'invalidStartTime', field: 'startTime', message: '시작 시간을 00:00–23:59 범위의 HH:MM 형식으로 입력해주세요.' });
    if (endMinutes == null) issues.push({ type: 'sheet', code: 'invalidEndTime', field: 'endTime', message: '종료 시간을 00:00–23:59 범위의 HH:MM 형식으로 입력해주세요.' });
    if (startMinutes != null && endMinutes != null && endDate === slot.date && endMinutes <= startMinutes) issues.push({ type: 'sheet', code: 'invalidTimeRange', field: 'timeRange', message: '같은 날 일정의 종료 시간은 시작 시간보다 늦어야 합니다.' });
    return issues;
  }

  function parseSlots(text) {
    const slots = [];
    const errors = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
      const value = clean(line);
      if (!value) return;
      const match = value.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s*~\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}))?\s+(\d{2}:\d{2})\s*[-~]\s*(\d{2}:\d{2})(?:\s+(.+))?$/);
      if (!match) { errors.push(`${index + 1}줄 형식을 확인해주세요: ${value}`); return; }
      const date = match[1].replace(/[/.]/g, '-').split('-').map((part, partIndex) => partIndex ? part.padStart(2, '0') : part).join('-');
      const parsedEndDate = match[2] ? match[2].replace(/[/.]/g, '-').split('-').map((part, partIndex) => partIndex ? part.padStart(2, '0') : part).join('-') : date;
      const slot = { id: makeId('slot'), date, ...(parsedEndDate !== date ? { endDate: parsedEndDate } : {}), startTime: match[3], endTime: match[4], label: clean(match[5]), locked: false, status: 'draft' };
      const issues = validateScheduleSlot(slot);
      if (issues.length) { issues.forEach((issue) => errors.push(`${index + 1}줄: ${issue.message}`)); return; }
      slots.push(slot);
    });
    return { slots, errors };
  }

  function slotKey(slot) {
    const range = clean(slot?.endDate) && slot.endDate !== slot.date ? `${slot.date}~${slot.endDate}` : slot?.date;
    return `${range} ${slot?.startTime}-${slot?.endTime}`;
  }

  function compareCalendarDates(left, right) {
    const leftDate = clean(left);
    const rightDate = clean(right);
    if (!isValidCalendarDate(leftDate) || !isValidCalendarDate(rightDate)) return null;
    return leftDate === rightDate ? 0 : leftDate < rightDate ? -1 : 1;
  }

  function utcMillisFromCalendarParts({ year, month, day, hour = 0, minute = 0 }) {
    const value = new Date(0);
    value.setUTCFullYear(year, month - 1, day);
    value.setUTCHours(hour, minute, 0, 0);
    return value.getTime();
  }

  function zonedCalendarInstant(dateValue, timeValue, timeZone) {
    const dateMatch = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = String(timeValue || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!dateMatch || !timeMatch) return null;
    const wanted = {
      year: Number(dateMatch[1]),
      month: Number(dateMatch[2]),
      day: Number(dateMatch[3]),
      hour: Number(timeMatch[1]),
      minute: Number(timeMatch[2])
    };
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn-hc-h23', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      });
    } catch (_) { return null; }
    const targetWallTime = utcMillisFromCalendarParts(wanted);
    const partsAt = (instant) => {
      const values = {};
      formatter.formatToParts(new Date(instant)).forEach((part) => {
        if (['year', 'month', 'day', 'hour', 'minute'].includes(part.type)) values[part.type] = Number(part.value);
      });
      return values;
    };
    const offsets = new Set();
    [-48, -36, -24, -12, 0, 12, 24, 36, 48].forEach((hours) => {
      const sample = targetWallTime + hours * 60 * 60 * 1000;
      const rendered = partsAt(sample);
      if (!['year', 'month', 'day', 'hour', 'minute'].every((key) => Number.isFinite(rendered[key]))) return;
      offsets.add(Math.round((utcMillisFromCalendarParts(rendered) - sample) / 60000));
    });
    const alternatives = [...new Set([...offsets].map((offsetMinutes) => targetWallTime - offsetMinutes * 60000).filter((instant) => {
      const rendered = partsAt(instant);
      return ['year', 'month', 'day', 'hour', 'minute'].every((key) => rendered[key] === wanted[key]);
    }))].sort((left, right) => left - right);
    return alternatives.length ? { instantMs: alternatives[0], ambiguous: alternatives.length > 1, alternatives } : null;
  }

  function calendarEventInstants(slot = {}, timeZone = 'Asia/Seoul') {
    const zone = clean(timeZone) || 'Asia/Seoul';
    const issues = validateScheduleSlot(slot);
    if (issues.length) return { valid: false, timeZone: zone, issues };
    const start = zonedCalendarInstant(slot.date, slot.startTime, zone);
    const end = zonedCalendarInstant(clean(slot.endDate) || slot.date, slot.endTime, zone);
    const startMs = start?.instantMs;
    const endMs = end?.instantMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { valid: false, timeZone: zone, issues: [{ type: 'calendar', code: 'invalidInstant', message: '해당 시간대에서 일정 시각을 계산할 수 없습니다.' }] };
    }
    return {
      valid: true,
      timeZone: zone,
      startMs,
      endMs,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      durationMinutes: Math.round((endMs - startMs) / 60000),
      ambiguous: Boolean(start.ambiguous || end.ambiguous),
      startAlternatives: start.alternatives.map((instant) => new Date(instant).toISOString()),
      endAlternatives: end.alternatives.map((instant) => new Date(instant).toISOString())
    };
  }

  function calendarAutomationTimeReadiness(slot = {}, timeZone = 'Asia/Seoul') {
    const zone = clean(timeZone) || 'Asia/Seoul';
    const interval = calendarEventInstants(slot, zone);
    if (!interval.valid) {
      const structuralIssue = (interval.issues || []).find((issue) => issue.code !== 'invalidInstant');
      return {
        ready: false,
        code: structuralIssue?.code || 'nonexistentLocalTime',
        message: structuralIssue?.message || `이 날짜·시간은 ${zone} 시간대에 존재하지 않습니다. 일광절약시간 전환 구간을 피해 다른 시각을 선택해주세요.`,
        interval
      };
    }
    if (interval.ambiguous) {
      return {
        ready: false,
        code: 'ambiguousLocalTime',
        message: `이 날짜·시간은 ${zone} 시간대에서 두 번 발생해 자동화 기준이 모호합니다. 일광절약시간 전환 구간을 피해 다른 시각을 선택해주세요.`,
        interval
      };
    }
    return { ready: true, code: '', message: '', interval };
  }

  function zoomMeetingSlotReadiness(slot = {}, timeZone = 'Asia/Seoul') {
    const timeReadiness = calendarAutomationTimeReadiness(slot, timeZone);
    if (!timeReadiness.ready) return timeReadiness;
    const endDate = clean(slot.endDate) || clean(slot.date);
    if (endDate !== clean(slot.date)) {
      return {
        ready: false,
        code: 'multiDayZoomUnsupported',
        message: '여러 날 전체 범위를 하나의 장시간 Zoom 회의로 만들지 않습니다. Zoom이 필요한 진행 항목을 하루짜리 세부 일정으로 나눈 뒤 각 일정에서 회의를 만들어주세요.',
        interval: timeReadiness.interval
      };
    }
    return timeReadiness;
  }

  function availabilityFormScheduleReadiness(project = {}) {
    const timeZone = clean(project?.settings?.timezone) || 'Asia/Seoul';
    const slots = Array.isArray(project?.data?.slots)
      ? project.data.slots.filter((slot) => clean(slot?.status).toLowerCase() !== 'cancelled')
      : [];
    if (!slots.length) return {
      ready: false,
      timeZone,
      blockers: [{ slotId: '', code: 'noActiveSlots', message: '가능 시간 설문에 넣을 프로젝트 일정이 없습니다. 일정을 먼저 추가해주세요.' }]
    };
    const blockers = slots.flatMap((slot) => {
      const readiness = calendarAutomationTimeReadiness(slot, timeZone);
      return readiness.ready ? [] : [{
        slotId: clean(slot.id),
        code: readiness.code,
        message: `${slot.label || slotKey(slot) || '이름 없는 일정'} · ${readiness.message}`
      }];
    });
    return { ready: blockers.length === 0, timeZone, blockers };
  }

  function calendarEventPhase(slot = {}, now = Date.now(), timeZone = 'Asia/Seoul') {
    const instants = calendarEventInstants(slot, timeZone);
    const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(String(now || ''));
    if (!instants.valid || !Number.isFinite(nowMs)) return 'invalid';
    if (nowMs >= instants.endMs) return 'past';
    if (nowMs >= instants.startMs) return 'live';
    return instants.startMs - nowMs <= 24 * 60 * 60 * 1000 ? 'imminent' : 'upcoming';
  }

  function overlaps(a, b) {
    const aStart = `${a.date || ''}T${a.startTime || ''}`;
    const aEnd = `${clean(a.endDate) || a.date || ''}T${a.endTime || ''}`;
    const bStart = `${b.date || ''}T${b.startTime || ''}`;
    const bEnd = `${clean(b.endDate) || b.date || ''}T${b.endTime || ''}`;
    return aStart < bEnd && bStart < aEnd;
  }

  function generateSchedule({ people, roles, slots, availability, existingAssignments = [], historyPairs = [], rules = {}, timeZone = 'Asia/Seoul' }) {
    const activePeople = (people || []).filter((person) => person.active !== false);
    const activeSlots = (slots || []).filter((slot) => slot.status !== 'cancelled');
    const slotValidation = activeSlots.map((slot) => {
      const issues = validateScheduleSlot(slot);
      const instants = issues.length ? null : calendarEventInstants(slot, clean(timeZone) || 'Asia/Seoul');
      return { slot, issues: issues.length ? issues : instants.valid ? [] : instants.issues };
    });
    const orderedSlots = slotValidation.filter((item) => !item.issues.length).map((item) => item.slot).sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
    const activeSlotMap = new Map(activeSlots.map((slot) => [slot.id, slot]));
    const conflicts = slotValidation.flatMap(({ slot, issues }) => issues.map((issue) => ({ type: 'invalidSlot', code: issue.code || 'invalidSlot', slotId: slot.id, field: issue.field, message: `${slot.label || slotKey(slot) || '이름 없는 일정'} · ${issue.message}` })));
    const orderedRoles = (roles || []).filter((role) => role.active !== false);
    const assignments = existingAssignments.filter((assignment) => {
      const slot = activeSlotMap.get(assignment.slotId);
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
      if (slot.locked) continue;
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
      if (slot.status === 'cancelled') { issues.push({ type: 'cancelledSlot', personId: person.id, slotId: slot.id, roleId: role.id, message: `${slot.label || slotKey(slot)}은 취소된 일정이지만 ${person.name || '이름 없음'}님이 배정되어 있습니다.` }); return; }
      if (person.active === false) issues.push({ type: 'inactivePerson', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'}님은 현재 명단에서 제외되어 있지만 일정에 배정되어 있습니다.` });
      if (role.active === false) issues.push({ type: 'inactiveRole', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'}님이 사용 중지된 역할 “${role.name}”에 배정되어 있습니다.` });
      if (!roleAllowsPerson(role, person)) issues.push({ type: 'roleEligibility', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'}님은 ${role.name} 배정 대상으로 설정되어 있지 않습니다.` });
      const selected = availability?.[person.id];
      const available = Array.isArray(selected) ? selected.includes(slot.id) : Boolean(rules.unmarkedMeansAvailable);
      if (!available) issues.push({ type: 'unavailable', personId: person.id, slotId: slot.id, roleId: role.id, message: `${person.name || '이름 없음'}님이 가능한 시간으로 표시하지 않은 ${slot.label || slotKey(slot)}에 배정되어 있습니다.` });
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
        if (count < target) issues.push({ type: 'personTarget', personId: person.id, roleId: role.id, amount: target - count, message: `${person.name || '이름 없음'} · ${role.name} 목표보다 ${target - count}회 부족` });
        if (count > target) issues.push({ type: 'personTargetMaximum', personId: person.id, roleId: role.id, amount: count - target, message: `${person.name || '이름 없음'} · ${role.name} 목표보다 ${count - target}회 많음` });
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
      if (!issues.length && keys.has('date') && keys.has('startTime') && keys.has('endTime')) {
        const interval = calendarEventInstants(slot, project?.settings?.timezone || 'Asia/Seoul');
        if (!interval.valid) messages.push({ type: 'sheet', code: 'invalidCalendarInstant', slotId: slot.id, message: `${index + 2}행: 선택한 날짜·시간이 프로젝트 시간대에서 존재하지 않습니다. 다른 시각을 선택해주세요.` });
      }
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
    const scheduleSignature = (slot) => slot ? [slot.date || '', clean(slot.endDate) && slot.endDate !== slot.date ? slot.endDate : '', slot.startTime || '', slot.endTime || '', slot.label || '', slot.status === 'cancelled'].join('|') : '__missing__';
    const changedSlotIds = slotIds.filter((slotId) => scheduleSignature(beforeById.get(slotId)) !== scheduleSignature(afterById.get(slotId)) || assignmentSignature(beforeAssignments, slotId) !== assignmentSignature(afterAssignments, slotId));
    const zoomReviewSlotIds = changedSlotIds.filter((slotId) => {
      if (scheduleSignature(beforeById.get(slotId)) !== scheduleSignature(afterById.get(slotId))) return true;
      return beforeAssignments.some((item) => item.slotId === slotId) !== afterAssignments.some((item) => item.slotId === slotId);
    });
    const affectedPersonIds = [...new Set([...beforeAssignments, ...afterAssignments].filter((item) => changedSlotIds.includes(item.slotId)).map((item) => item.personId).filter(Boolean))];
    return { changedSlotIds, zoomReviewSlotIds, affectedPersonIds };
  }

  function planScheduleChange({ assignments = [], people = [], roles = [], slots = [], availability = {}, rules = {}, targetPersonIds = null, timeZone = 'Asia/Seoul', change = {} }) {
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
    else if (action !== 'remove' && person.active === false) blockers.push({ code: 'inactivePerson', message: '현재 명단에서 제외된 사람입니다.' });
    if (action !== 'add' && !assignment) blockers.push({ code: 'missingAssignment', message: '변경할 기존 일정을 찾지 못했습니다.' });
    if (assignment && !fromSlot) blockers.push({ code: 'missingSource', message: '기존 일정 정보를 찾지 못했습니다.' });
    if (action !== 'remove' && !toSlot) blockers.push({ code: 'missingTarget', message: '옮길 일정을 선택해주세요.' });
    if (!role) blockers.push({ code: 'missingRole', message: '배정 역할을 확인해주세요.' });
    else if (action !== 'remove' && role.active === false) blockers.push({ code: 'inactiveRole', message: '사용 중지된 역할에는 새로 배정할 수 없습니다.' });
    if (assignment?.locked || fromSlot?.locked) blockers.push({ code: 'lockedSource', message: '기존 일정이 잠겨 있어 먼저 잠금을 풀어야 합니다.' });
    if (action !== 'remove' && toSlot?.locked) blockers.push({ code: 'lockedTarget', message: '선택한 일정이 잠겨 있어 배정할 수 없습니다.' });
    if (action !== 'remove' && toSlot?.status === 'cancelled') blockers.push({ code: 'cancelledTarget', message: '취소된 일정에는 배정할 수 없습니다.' });
    if (action !== 'remove' && toSlot && !calendarEventInstants(toSlot, clean(timeZone) || 'Asia/Seoul').valid) blockers.push({ code: 'invalidTargetTime', message: '선택한 일정의 날짜·시간이 프로젝트 시간대에서 유효하지 않습니다. 일정 시간을 먼저 고쳐주세요.' });
    if (action === 'move' && fromSlot?.id === toSlot?.id) blockers.push({ code: 'sameSlot', message: '현재 일정과 다른 일정을 선택해주세요.' });
    if (action !== 'remove' && assignments.some((item) => item.id !== assignment?.id && item.personId === personId && item.slotId === toSlot?.id)) {
      blockers.push({ code: 'duplicateTarget', message: '이미 이 일정에 배정된 사람입니다.' });
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

  function planScheduleBatchChange(input = {}) {
    const people = Array.isArray(input.people) ? input.people : [];
    const roles = Array.isArray(input.roles) ? input.roles : [];
    const slots = Array.isArray(input.slots) ? input.slots : [];
    const assignments = Array.isArray(input.assignments) ? input.assignments : [];
    const activities = Array.isArray(input.activities) ? input.activities : [];
    const availability = input.availability && typeof input.availability === 'object' ? input.availability : {};
    const rules = input.rules && typeof input.rules === 'object' ? input.rules : {};
    const timeZone = clean(input.timeZone) || 'Asia/Seoul';
    const targetPersonIds = Array.isArray(input.targetPersonIds) ? input.targetPersonIds : null;
    const changeSet = input.changeSet && typeof input.changeSet === 'object' ? input.changeSet : {};
    const slotChanges = Array.isArray(input.slotChanges) ? input.slotChanges : Array.isArray(changeSet.slotChanges) ? changeSet.slotChanges : [];
    const assignmentChanges = Array.isArray(input.assignmentChanges) ? input.assignmentChanges : Array.isArray(changeSet.assignmentChanges) ? changeSet.assignmentChanges : [];
    const originalSlots = slots.map((slot) => ({ ...slot }));
    const originalAssignments = assignments.map((assignment) => ({ ...assignment }));
    const idOf = (value) => String(value ?? '');
    const blockers = [];
    const blockerKeys = new Set();
    const addBlocker = (code, message, details = {}) => {
      const key = [code, details.slotId, details.activityId, details.assignmentId, details.otherAssignmentId, details.personId, details.roleId, message].map(idOf).join('|');
      if (blockerKeys.has(key)) return;
      blockerKeys.add(key); blockers.push({ code, message, ...details });
    };
    const duplicateIds = (items) => {
      const seen = new Set(); const duplicates = new Set();
      items.forEach((item) => { const id = idOf(item?.id); if (!id || seen.has(id)) duplicates.add(id); else seen.add(id); });
      return [...duplicates];
    };
    duplicateIds(people).forEach((id) => addBlocker('duplicatePersonId', id ? `사람 ID “${id}”가 중복되어 변경 대상을 확정할 수 없습니다.` : 'ID가 없는 사람이 있어 변경 대상을 확정할 수 없습니다.'));
    duplicateIds(roles).forEach((id) => addBlocker('duplicateRoleId', id ? `역할 ID “${id}”가 중복되어 변경 대상을 확정할 수 없습니다.` : 'ID가 없는 역할이 있어 변경 대상을 확정할 수 없습니다.'));
    duplicateIds(slots).forEach((id) => addBlocker('duplicateSlotId', id ? `일정 ID “${id}”가 중복되어 변경 대상을 확정할 수 없습니다.` : 'ID가 없는 일정이 있어 변경 대상을 확정할 수 없습니다.'));
    duplicateIds(assignments).forEach((id) => addBlocker('duplicateAssignmentId', id ? `배정 ID “${id}”가 중복되어 변경 대상을 확정할 수 없습니다.` : 'ID가 없는 배정이 있어 변경 대상을 확정할 수 없습니다.'));

    const peopleById = new Map(people.map((person) => [idOf(person.id), person]));
    const rolesById = new Map(roles.map((role) => [idOf(role.id), role]));
    const slotsById = new Map(slots.map((slot) => [idOf(slot.id), slot]));
    const assignmentsById = new Map(assignments.map((assignment) => [idOf(assignment.id), assignment]));
    const assignmentReferences = (assignment, details = {}) => {
      const assignmentId = idOf(assignment?.id);
      const slotId = idOf(assignment?.slotId);
      const personId = idOf(assignment?.personId);
      const roleId = idOf(assignment?.roleId);
      const slot = slotsById.get(slotId);
      const person = peopleById.get(personId);
      const role = rolesById.get(roleId);
      if (!slot) addBlocker('missingSource', '기존 배정이 참조하는 일정을 찾지 못했습니다.', { assignmentId, slotId, ...details });
      if (!person) addBlocker('missingPerson', '기존 배정이 참조하는 사람을 명단에서 찾지 못했습니다.', { assignmentId, personId, ...details });
      if (!role) addBlocker('missingRole', '기존 배정이 참조하는 역할을 찾지 못했습니다.', { assignmentId, roleId, ...details });
      return { valid: Boolean(slot && person && role), slot, person, role };
    };
    const rowLocked = (slotId) => Boolean(slotsById.get(idOf(slotId))?.locked || assignments.some((assignment) => idOf(assignment.slotId) === idOf(slotId) && assignment.locked));
    const preparedSlotChanges = [];
    const preparedAssignmentChanges = [];
    const touchedSlotIds = new Set();
    const touchedAssignmentIds = new Set();
    const newAssignmentIds = new Set();
    const registerAssignmentTouch = (assignmentId, index, extra = {}) => {
      const id = idOf(assignmentId);
      if (touchedAssignmentIds.has(id)) { addBlocker('duplicateAssignmentChange', `배정 “${id}”에 여러 변경이 겹쳐 있습니다. 하나의 최종 변경으로 합쳐주세요.`, { assignmentId: id, changeIndex: index, ...extra }); return false; }
      touchedAssignmentIds.add(id); return true;
    };

    slotChanges.forEach((change, changeIndex) => {
      const action = change?.action || 'move';
      const slotId = idOf(change?.slotId);
      const slot = slotsById.get(slotId);
      if (action !== 'move') { addBlocker('unsupportedSlotChange', `지원하지 않는 일정 변경 “${action}”입니다.`, { slotId, changeIndex }); return; }
      if (!slot) { addBlocker('missingSlot', '이동할 일정을 찾지 못했습니다.', { slotId, changeIndex }); return; }
      if (touchedSlotIds.has(slotId)) { addBlocker('duplicateSlotChange', `일정 “${slot.label || slotId}”에 여러 시간 변경이 겹쳐 있습니다.`, { slotId, changeIndex }); return; }
      touchedSlotIds.add(slotId);
      if (rowLocked(slotId)) { addBlocker('lockedSlot', `“${slot.label || slotKey(slot)}” 일정 또는 배정이 잠겨 있습니다.`, { slotId, changeIndex }); return; }
      if (slot.status === 'cancelled') { addBlocker('cancelledSlot', '취소된 일정은 다른 날짜나 시간으로 이동할 수 없습니다.', { slotId, changeIndex }); return; }
      const referencesValid = assignments.filter((assignment) => idOf(assignment.slotId) === slotId).every((assignment) => assignmentReferences(assignment, { changeIndex }).valid);
      if (!referencesValid) return;
      const date = clean(change.date ?? change.toDate ?? slot.date);
      const requestedEndDate = clean(change.endDate ?? change.toEndDate ?? slot.endDate ?? date);
      const endDate = requestedEndDate === date ? '' : requestedEndDate;
      const startTime = clean(change.startTime ?? change.toStartTime ?? slot.startTime);
      const explicitEndTime = change.endTime != null || change.toEndTime != null;
      let endTime = clean(change.endTime ?? change.toEndTime ?? slot.endTime);
      if (!explicitEndTime && startTime !== slot.startTime) {
        const originalStart = timeToMinutes(slot.startTime); const originalEnd = timeToMinutes(slot.endTime); const nextStart = timeToMinutes(startTime);
        if (originalStart != null && originalEnd != null && nextStart != null) {
          const nextEnd = nextStart + (originalEnd - originalStart);
          endTime = nextEnd < 24 * 60 ? `${String(Math.floor(nextEnd / 60)).padStart(2, '0')}:${String(nextEnd % 60).padStart(2, '0')}` : '';
        }
      }
      const previousEndDate = clean(slot.endDate) || slot.date;
      const changed = date !== slot.date || (endDate || date) !== previousEndDate || startTime !== slot.startTime || endTime !== slot.endTime;
      const nextSlot = { ...slot, date, startTime, endTime, status: changed && slot.status === 'confirmed' ? 'changed' : slot.status };
      if (endDate) nextSlot.endDate = endDate; else delete nextSlot.endDate;
      const issues = validateScheduleSlot(nextSlot);
      if (issues.length) { issues.forEach((issue) => addBlocker(issue.code || 'invalidSlot', issue.message, { slotId, field: issue.field, changeIndex })); return; }
      const localInterval = calendarEventInstants(nextSlot, timeZone);
      if (!localInterval.valid) { addBlocker('invalidCalendarInstant', '선택한 날짜·시간이 프로젝트 시간대에서 존재하지 않습니다. 다른 시각을 선택해주세요.', { slotId, changeIndex, timeZone }); return; }
      if (changed) {
        const interval = calendarEventInstants(nextSlot, 'UTC');
        const slotDurationMinutes = interval.valid ? interval.durationMinutes : 0;
        const activitySlotId = (activity) => activity?.eventId == null || activity.eventId === '' ? activity?.slotId : activity.eventId;
        const integerMinutes = (rawValue) => {
          if (typeof rawValue === 'number') return Number.isSafeInteger(rawValue) ? rawValue : null;
          if (typeof rawValue !== 'string' || !/^[+-]?\d+$/.test(rawValue.trim())) return null;
          const value = Number(rawValue.trim());
          return Number.isSafeInteger(value) ? value : null;
        };
        activities.filter((activity) => idOf(activitySlotId(activity)) === slotId).forEach((activity) => {
          const rawOffsetMinutes = activity?.startOffsetMinutes ?? activity?.offsetMinutes;
          const rawDurationMinutes = activity?.durationMinutes;
          const offsetMinutes = integerMinutes(rawOffsetMinutes);
          const durationMinutes = integerMinutes(rawDurationMinutes);
          const timingInvalid = offsetMinutes == null || durationMinutes == null || offsetMinutes < 0 || durationMinutes <= 0;
          const activityId = idOf(activity?.id);
          const activityName = clean(activity?.title) || activityId || '이름 없는 진행 항목';
          if (timingInvalid) {
            addBlocker('activityOutsideSlot', `“${activityName}” 진행 항목의 시작 위치 또는 소요 시간이 올바르지 않습니다. 진행 항목 시간을 먼저 확인해주세요.`, {
              activityId, slotId, changeIndex, reason: 'invalidTiming', offsetMinutes: rawOffsetMinutes, durationMinutes: rawDurationMinutes, slotDurationMinutes
            });
          } else if (offsetMinutes + durationMinutes > slotDurationMinutes) {
            addBlocker('activityOutsideSlot', `“${activityName}” 진행 항목이 변경 후 일정 종료 시간을 넘습니다. 일정 길이나 진행 항목 시간을 먼저 조정해주세요.`, {
              activityId, slotId, changeIndex, reason: 'exceedsDuration', offsetMinutes, durationMinutes, slotDurationMinutes
            });
          }
        });
        if (blockers.length) return;
      }
      preparedSlotChanges.push({ action, slotId, nextSlot, changeIndex });
    });

    assignmentChanges.forEach((change, changeIndex) => {
      const action = change?.action;
      if (!['add', 'move', 'remove', 'swap'].includes(action)) { addBlocker('unsupportedAssignmentChange', `지원하지 않는 배정 변경 “${action || ''}”입니다.`, { changeIndex }); return; }
      if (action === 'swap') {
        const assignmentId = idOf(change.assignmentId ?? change.firstAssignmentId);
        const otherAssignmentId = idOf(change.otherAssignmentId ?? change.secondAssignmentId);
        const assignment = assignmentsById.get(assignmentId); const other = assignmentsById.get(otherAssignmentId);
        if (!assignment || !other) { addBlocker('missingAssignment', '교환할 두 배정을 모두 찾지 못했습니다.', { assignmentId, otherAssignmentId, changeIndex }); return; }
        if (assignmentId === otherAssignmentId) { addBlocker('sameSwapAssignment', '같은 배정끼리는 교환할 수 없습니다.', { assignmentId, changeIndex }); return; }
        const firstRegistered = registerAssignmentTouch(assignmentId, changeIndex, { otherAssignmentId });
        const secondRegistered = registerAssignmentTouch(otherAssignmentId, changeIndex, { assignmentId });
        if (!firstRegistered || !secondRegistered) return;
        const firstReferences = assignmentReferences(assignment, { otherAssignmentId, changeIndex });
        const secondReferences = assignmentReferences(other, { otherAssignmentId: assignmentId, changeIndex });
        if (!firstReferences.valid || !secondReferences.valid) return;
        if (rowLocked(assignment.slotId) || rowLocked(other.slotId)) { addBlocker('lockedAssignment', '교환할 배정 또는 일정이 잠겨 있습니다.', { assignmentId, otherAssignmentId, changeIndex }); return; }
        if (firstReferences.slot.status === 'cancelled' || secondReferences.slot.status === 'cancelled') { addBlocker('cancelledTarget', '취소된 일정의 배정은 다른 사람과 교환할 수 없습니다.', { assignmentId, otherAssignmentId, changeIndex }); return; }
        const firstTargetSlot = preparedSlotChanges.find((item) => item.slotId === idOf(secondReferences.slot.id))?.nextSlot || secondReferences.slot;
        const secondTargetSlot = preparedSlotChanges.find((item) => item.slotId === idOf(firstReferences.slot.id))?.nextSlot || firstReferences.slot;
        if (!calendarEventInstants(firstTargetSlot, timeZone).valid || !calendarEventInstants(secondTargetSlot, timeZone).valid) { addBlocker('invalidTargetTime', '교환할 일정의 날짜·시간이 프로젝트 시간대에서 유효하지 않습니다. 일정 시간을 먼저 고쳐주세요.', { assignmentId, otherAssignmentId, changeIndex, timeZone }); return; }
        const firstPerson = firstReferences.person; const secondPerson = secondReferences.person;
        if (firstPerson.active === false || secondPerson.active === false) { addBlocker('inactivePerson', '현재 명단에서 제외된 사람은 새 일정으로 교환할 수 없습니다.', { assignmentId, otherAssignmentId, changeIndex }); return; }
        if (idOf(firstPerson.id) === idOf(secondPerson.id)) { addBlocker('sameSwapPerson', '같은 사람의 배정끼리는 교환할 수 없습니다.', { assignmentId, otherAssignmentId, changeIndex }); return; }
        if (firstReferences.role.active === false || secondReferences.role.active === false) { addBlocker('inactiveRole', '사용 중지된 역할의 배정은 다른 사람과 교환할 수 없습니다.', { assignmentId, otherAssignmentId, changeIndex }); return; }
        preparedAssignmentChanges.push({ action, assignmentId, otherAssignmentId, changeIndex });
        return;
      }

      const nextAssignmentId = action === 'add' ? (change.nextAssignmentId ?? makeId('assignment')) : null;
      const assignmentId = action === 'add' ? idOf(nextAssignmentId) : idOf(change.assignmentId);
      const assignment = action === 'add' ? null : assignmentsById.get(assignmentId);
      if (action !== 'add' && !assignment) { addBlocker('missingAssignment', '변경할 배정을 찾지 못했습니다.', { assignmentId, changeIndex }); return; }
      if (action !== 'add' && !registerAssignmentTouch(assignmentId, changeIndex)) return;
      const sourceReferences = assignment ? assignmentReferences(assignment, { changeIndex }) : null;
      if (sourceReferences && !sourceReferences.valid) return;
      if (action === 'add') {
        if (assignmentsById.has(assignmentId) || newAssignmentIds.has(assignmentId)) { addBlocker('duplicateAssignmentId', `새 배정 ID “${assignmentId}”가 이미 사용 중입니다.`, { assignmentId, changeIndex }); return; }
        newAssignmentIds.add(assignmentId);
      }
      if (action === 'remove') {
        if (rowLocked(assignment.slotId)) { addBlocker('lockedAssignment', '삭제할 배정 또는 일정이 잠겨 있습니다.', { assignmentId, slotId: assignment.slotId, changeIndex }); return; }
        preparedAssignmentChanges.push({ action, assignmentId, changeIndex }); return;
      }
      const requestedPersonId = idOf(action === 'add' ? change.personId : sourceReferences.person.id);
      const requestedRoleId = idOf(change.roleId ?? assignment?.roleId);
      const requestedSlotId = idOf(change.toSlotId ?? change.slotId ?? assignment?.slotId);
      const person = peopleById.get(requestedPersonId); const role = rolesById.get(requestedRoleId); const targetSlot = slotsById.get(requestedSlotId); const effectiveTargetSlot = preparedSlotChanges.find((item) => item.slotId === requestedSlotId)?.nextSlot || targetSlot;
      if (!person) { addBlocker('missingPerson', '배정할 사람을 명단에서 찾지 못했습니다.', { assignmentId, personId: requestedPersonId, changeIndex }); return; }
      if (person.active === false) { addBlocker('inactivePerson', '현재 명단에서 제외된 사람은 새로 배정할 수 없습니다.', { assignmentId, personId: requestedPersonId, changeIndex }); return; }
      if (!role) { addBlocker('missingRole', '배정할 역할을 찾지 못했습니다.', { assignmentId, roleId: requestedRoleId, changeIndex }); return; }
      if (role.active === false) { addBlocker('inactiveRole', '사용 중지된 역할에는 새로 배정할 수 없습니다.', { assignmentId, roleId: requestedRoleId, changeIndex }); return; }
      if (!targetSlot) { addBlocker('missingSlot', '배정할 일정을 찾지 못했습니다.', { assignmentId, slotId: requestedSlotId, changeIndex }); return; }
      if (targetSlot.status === 'cancelled') { addBlocker('cancelledTarget', '취소된 일정에는 배정할 수 없습니다.', { assignmentId, slotId: requestedSlotId, changeIndex }); return; }
      if (!calendarEventInstants(effectiveTargetSlot, timeZone).valid) { addBlocker('invalidTargetTime', '배정할 일정의 날짜·시간이 프로젝트 시간대에서 유효하지 않습니다. 일정 시간을 먼저 고쳐주세요.', { assignmentId, slotId: requestedSlotId, changeIndex, timeZone }); return; }
      if (rowLocked(requestedSlotId) || (assignment && rowLocked(assignment.slotId))) { addBlocker('lockedAssignment', '변경할 배정 또는 일정이 잠겨 있습니다.', { assignmentId, slotId: requestedSlotId, changeIndex }); return; }
      preparedAssignmentChanges.push({ action, assignmentId, nextAssignmentId, personId: person.id, roleId: role.id, toSlotId: targetSlot.id, changeIndex });
    });

    const emptyImpact = diffScheduleDependencies({ beforeSlots: originalSlots, beforeAssignments: originalAssignments, afterSlots: originalSlots, afterAssignments: originalAssignments });
    const blockedBeforeMutation = () => ({
      atomic: true,
      canApply: false,
      blockers,
      warnings: [],
      nextSlots: originalSlots.map((slot) => ({ ...slot })),
      nextAssignments: originalAssignments.map((assignment) => ({ ...assignment })),
      candidateSlots: originalSlots.map((slot) => ({ ...slot })),
      candidateAssignments: originalAssignments.map((assignment) => ({ ...assignment })),
      impact: emptyImpact,
      metadata: {
        requestedChangeCount: slotChanges.length + assignmentChanges.length,
        movedSlotIds: [], addedAssignmentIds: [], removedAssignmentIds: [], changedAssignmentIds: [], swappedAssignmentIds: [], availabilityRecheckPersonIds: [],
        artifactImpact: { zoom: { reviewSlotIds: [] }, gmailDraft: { reviewPersonIds: [] } }
      },
      validation: { assignmentErrors: [], constraintIssues: [] }
    });
    if (blockers.length) return blockedBeforeMutation();

    const candidateSlots = originalSlots.map((slot) => ({ ...slot }));
    const candidateAssignments = originalAssignments.map((assignment) => ({ ...assignment }));
    preparedSlotChanges.forEach(({ slotId, nextSlot }) => {
      const index = candidateSlots.findIndex((slot) => idOf(slot.id) === slotId);
      candidateSlots[index] = { ...nextSlot };
    });
    preparedAssignmentChanges.forEach((change) => {
      if (change.action === 'add') {
        const role = rolesById.get(idOf(change.roleId));
        candidateAssignments.push({ id: change.nextAssignmentId, slotId: change.toSlotId, personId: change.personId, roleId: change.roleId, roleName: role?.name || '', locked: false, source: 'calendar-batch' });
        return;
      }
      const assignmentIndex = candidateAssignments.findIndex((assignment) => idOf(assignment.id) === change.assignmentId);
      if (change.action === 'remove') { candidateAssignments.splice(assignmentIndex, 1); return; }
      if (change.action === 'move') {
        const role = rolesById.get(idOf(change.roleId));
        candidateAssignments[assignmentIndex] = { ...candidateAssignments[assignmentIndex], slotId: change.toSlotId, roleId: change.roleId };
        if ('roleName' in candidateAssignments[assignmentIndex]) candidateAssignments[assignmentIndex].roleName = role?.name || '';
        return;
      }
      const otherIndex = candidateAssignments.findIndex((assignment) => idOf(assignment.id) === change.otherAssignmentId);
      const firstPersonId = candidateAssignments[assignmentIndex].personId;
      candidateAssignments[assignmentIndex].personId = candidateAssignments[otherIndex].personId;
      candidateAssignments[otherIndex].personId = firstPersonId;
      if ('personName' in candidateAssignments[assignmentIndex]) candidateAssignments[assignmentIndex].personName = peopleById.get(idOf(candidateAssignments[assignmentIndex].personId))?.name || '';
      if ('personName' in candidateAssignments[otherIndex]) candidateAssignments[otherIndex].personName = peopleById.get(idOf(candidateAssignments[otherIndex].personId))?.name || '';
    });

    const duplicatePersonSlots = (items) => {
      const counts = new Map();
      items.forEach((assignment) => { const key = `${idOf(assignment.personId)}|${idOf(assignment.slotId)}`; counts.set(key, (counts.get(key) || 0) + 1); });
      return counts;
    };
    const beforeDuplicateCounts = duplicatePersonSlots(originalAssignments); const afterDuplicateCounts = duplicatePersonSlots(candidateAssignments);
    afterDuplicateCounts.forEach((count, key) => {
      if (count <= 1 || count <= (beforeDuplicateCounts.get(key) || 0)) return;
      const [personId, slotId] = key.split('|'); const person = peopleById.get(personId); const slot = candidateSlots.find((item) => idOf(item.id) === slotId);
      addBlocker('duplicateTarget', `${person?.name || '같은 사람'}이 “${slot?.label || slotId}” 일정에 중복 배정됩니다.`, { personId, slotId });
    });

    const assignmentOverlapPairs = (items, slotItems) => {
      const slotMap = new Map(slotItems.map((slot) => [idOf(slot.id), slot]));
      const grouped = new Map();
      items.forEach((assignment) => {
        const slot = slotMap.get(idOf(assignment.slotId));
        if (!slot || slot.status === 'cancelled') return;
        const personId = idOf(assignment.personId);
        if (!grouped.has(personId)) grouped.set(personId, []);
        grouped.get(personId).push({ assignment, slot });
      });
      const pairs = new Map();
      grouped.forEach((entries, personId) => {
        for (let index = 0; index < entries.length; index += 1) {
          for (let other = index + 1; other < entries.length; other += 1) {
            const left = entries[index]; const right = entries[other];
            if (!overlaps(left.slot, right.slot)) continue;
            const assignmentIds = [idOf(left.assignment.id), idOf(right.assignment.id)].sort();
            const key = JSON.stringify([personId, ...assignmentIds]);
            const person = peopleById.get(personId);
            pairs.set(key, {
              personId,
              assignmentId: assignmentIds[0],
              otherAssignmentId: assignmentIds[1],
              slotIds: [left.slot.id, right.slot.id],
              message: `${person?.name || '이름 없음'}의 일정이 ${slotKey(left.slot)}와 ${slotKey(right.slot)}에 중복됩니다.`
            });
          }
        }
      });
      return pairs;
    };
    const beforeOverlapPairs = assignmentOverlapPairs(originalAssignments, originalSlots);
    const newOverlapPairs = [...assignmentOverlapPairs(candidateAssignments, candidateSlots)].filter(([key]) => !beforeOverlapPairs.has(key)).map(([, conflict]) => conflict);
    newOverlapPairs.forEach((conflict) => addBlocker('assignmentConflict', conflict.message, conflict));
    const beforeAssignmentErrors = new Set(validateAssignments({ assignments: originalAssignments, people, roles, slots: originalSlots }));
    const textualAssignmentErrors = validateAssignments({ assignments: candidateAssignments, people, roles, slots: candidateSlots }).filter((message) => !beforeAssignmentErrors.has(message));
    const assignmentErrors = [...new Set([...textualAssignmentErrors, ...newOverlapPairs.map((conflict) => conflict.message)])];
    const movedSlotIds = preparedSlotChanges.filter(({ slotId, nextSlot }) => {
      const before = slotsById.get(slotId); return before.date !== nextSlot.date || (clean(before.endDate) || before.date) !== (clean(nextSlot.endDate) || nextSlot.date) || before.startTime !== nextSlot.startTime || before.endTime !== nextSlot.endTime;
    }).map((item) => item.slotId);
    const constraintInput = { people, roles, availability, rules, targetPersonIds };
    const beforeConstraints = new Map(validateScheduleConstraints({ ...constraintInput, assignments: originalAssignments, slots: originalSlots }).map((issue) => [scheduleConstraintIssueKey(issue), issue]));
    const afterConstraints = validateScheduleConstraints({ ...constraintInput, assignments: candidateAssignments, slots: candidateSlots });
    const warnings = [];
    const warningKeys = new Set();
    const addWarning = (warning) => {
      const key = [warning.code || warning.type || '', warning.personId, warning.slotId, warning.roleId, warning.message].map(idOf).join('|');
      if (!warningKeys.has(key)) { warningKeys.add(key); warnings.push(warning); }
    };
    afterConstraints.forEach((issue) => {
      const beforeIssue = beforeConstraints.get(scheduleConstraintIssueKey(issue));
      if (beforeIssue && scheduleConstraintIssueAmount(issue) <= scheduleConstraintIssueAmount(beforeIssue)) return;
      addWarning({ ...issue, code: issue.type });
    });
    const availabilityRecheckKeys = new Set();
    const availabilityRecheckPersonIds = new Set();
    const movedSlotIdSet = new Set(movedSlotIds);
    candidateAssignments.filter((assignment) => movedSlotIdSet.has(idOf(assignment.slotId))).forEach((assignment) => {
      const personId = idOf(assignment.personId);
      const slotId = idOf(assignment.slotId);
      const recheckKey = `${personId}|${slotId}`;
      if (availabilityRecheckKeys.has(recheckKey)) return;
      availabilityRecheckKeys.add(recheckKey);
      availabilityRecheckPersonIds.add(assignment.personId);
      const person = peopleById.get(personId);
      const slot = candidateSlots.find((item) => idOf(item.id) === slotId);
      addWarning({ type: 'availabilityRecheck', code: 'availabilityRecheck', personId: assignment.personId, slotId: assignment.slotId, message: `${person?.name || '이름 없음'}의 가능 시간 응답은 이동 전 일정을 기준으로 하므로 ${slot?.label || slotKey(slot)} 일정을 다시 확인해주세요.` });
    });

    const impact = diffScheduleDependencies({ beforeSlots: originalSlots, beforeAssignments: originalAssignments, afterSlots: candidateSlots, afterAssignments: candidateAssignments });
    const beforeByAssignmentId = new Map(originalAssignments.map((assignment) => [idOf(assignment.id), assignment]));
    const afterByAssignmentId = new Map(candidateAssignments.map((assignment) => [idOf(assignment.id), assignment]));
    const assignmentSignature = (assignment) => assignment ? [idOf(assignment.slotId), idOf(assignment.personId), idOf(assignment.roleId), Boolean(assignment.locked)].join('|') : '';
    const addedAssignmentIds = [...afterByAssignmentId.keys()].filter((id) => !beforeByAssignmentId.has(id));
    const removedAssignmentIds = [...beforeByAssignmentId.keys()].filter((id) => !afterByAssignmentId.has(id));
    const changedAssignmentIds = [...afterByAssignmentId.keys()].filter((id) => beforeByAssignmentId.has(id) && assignmentSignature(beforeByAssignmentId.get(id)) !== assignmentSignature(afterByAssignmentId.get(id)));
    const swappedAssignmentIds = [...new Set(preparedAssignmentChanges.filter((change) => change.action === 'swap').flatMap((change) => [change.assignmentId, change.otherAssignmentId]))];
    const canApply = blockers.length === 0;
    return {
      atomic: true,
      canApply,
      blockers,
      warnings,
      nextSlots: (canApply ? candidateSlots : originalSlots).map((slot) => ({ ...slot })),
      nextAssignments: (canApply ? candidateAssignments : originalAssignments).map((assignment) => ({ ...assignment })),
      candidateSlots: candidateSlots.map((slot) => ({ ...slot })),
      candidateAssignments: candidateAssignments.map((assignment) => ({ ...assignment })),
      impact,
      metadata: {
        requestedChangeCount: slotChanges.length + assignmentChanges.length,
        movedSlotIds,
        addedAssignmentIds,
        removedAssignmentIds,
        changedAssignmentIds,
        swappedAssignmentIds,
        availabilityRecheckPersonIds: [...availabilityRecheckPersonIds],
        artifactImpact: {
          zoom: { reviewSlotIds: [...impact.zoomReviewSlotIds] },
          gmailDraft: { reviewPersonIds: [...impact.affectedPersonIds] }
        }
      },
      validation: { assignmentErrors, constraintIssues: afterConstraints }
    };
  }

  function escapeCsv(value) {
    const raw = String(value ?? '');
    const text = /^[\t\r\n]/.test(raw) || /^[\s\uFEFF]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function scheduleStatusLabel(status) {
    return ({ draft: '편성 중', confirmed: '확정', changed: '변경됨', cancelled: '취소' })[status] || status || '편성 중';
  }

  function assignmentName(assignment, personMap) {
    return personMap.get(assignment?.personId)?.name || assignment?.personName || assignment?.personId || '';
  }

  function isCoachRole(role) {
    const name = clean(role?.name).toLowerCase().replace(/[\s_.·-]/g, '');
    return role?.id === 'coach' || name.includes('코치') || name.includes('coach') || name.includes('진행자') || name.includes('강사');
  }

  function latestCreatedZoomArtifact(data, slotId) {
    const latest = (data.externalArtifacts || []).slice().reverse().find((artifact) => artifact.kind === 'zoom' && artifact.slotId === slotId && artifact.status !== 'superseded');
    return latest?.status === 'created' ? latest : null;
  }

  function scheduleListOutput(project, sortedSlots, personMap, roleMap) {
    const data = project?.data || {};
    const hasMultiDay = sortedSlots.some((slot) => clean(slot.endDate) && slot.endDate !== slot.date);
    let columns = data.scheduleSheetInitialized && Array.isArray(data.scheduleSheetColumns) ? data.scheduleSheetColumns : [];
    if (hasMultiDay && columns.length && !columns.some((column) => column.key === 'endDate')) {
      columns = columns.slice(); const dateIndex = columns.findIndex((column) => column.key === 'date'); columns.splice(dateIndex >= 0 ? dateIndex + 1 : 0, 0, { id: 'schedule-end-date', key: 'endDate', name: '종료 날짜', kind: 'system' });
    }
    if (columns.length) {
      const rows = sortedSlots.map((slot) => columns.map((column) => {
        if (column.kind === 'role') return (data.assignments || []).filter((assignment) => assignment.slotId === slot.id && assignment.roleId === column.roleId).map((assignment) => assignmentName(assignment, personMap)).filter(Boolean).join(', ');
        if (column.kind === 'custom') return data.scheduleCustomValues?.[slot.id]?.[column.id] || '';
        if (column.key === 'locked') return slot.locked || (data.assignments || []).some((assignment) => assignment.slotId === slot.id && assignment.locked) ? '예' : '';
        if (column.key === 'status') return scheduleStatusLabel(slot.status);
        if (column.key === 'endDate') return slot.endDate || slot.date || '';
        return slot[column.key] || '';
      }));
      return { type: 'list', sheetName: '일정 목록', headers: columns.map((column, index) => column.name || `컬럼${index + 1}`), rows };
    }
    const rows = sortedSlots.flatMap((slot) => {
      const slotAssignments = (data.assignments || []).filter((assignment) => assignment.slotId === slot.id);
      const zoom = latestCreatedZoomArtifact(data, slot.id);
      if (!slotAssignments.length) return [[slot.date, ...(hasMultiDay ? [slot.endDate || slot.date] : []), slot.startTime, slot.endTime, slot.label || '', '', '', scheduleStatusLabel(slot.status), zoom?.joinUrl || '']];
      return slotAssignments.map((assignment) => [
        slot.date,
        ...(hasMultiDay ? [slot.endDate || slot.date] : []),
        slot.startTime,
        slot.endTime,
        slot.label || '',
        roleMap.get(assignment.roleId)?.name || assignment.roleName || assignment.roleId || '',
        assignmentName(assignment, personMap),
        scheduleStatusLabel(slot.status),
        zoom?.joinUrl || ''
      ]);
    });
    return { type: 'list', sheetName: '일정 목록', headers: ['날짜', ...(hasMultiDay ? ['종료 날짜'] : []), '시작', '종료', '세션명', '역할', '이름', '상태', 'Zoom 링크'], rows };
  }

  function scheduleOutputTable(project, requestedType = project?.data?.layout?.type || 'list') {
    const data = project?.data || {};
    const type = ['list', 'calendarCoach', 'calendarZoom'].includes(requestedType) ? requestedType : 'list';
    const people = Array.isArray(data.people) ? data.people : [];
    const roles = Array.isArray(data.roles) ? data.roles : [];
    const assignments = Array.isArray(data.assignments) ? data.assignments : [];
    const sortedSlots = (Array.isArray(data.slots) ? data.slots : []).slice().sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
    const personMap = new Map(people.map((person) => [person.id, person]));
    const roleMap = new Map(roles.map((role) => [role.id, role]));
    if (type === 'list') return scheduleListOutput(project, sortedSlots, personMap, roleMap);

    if (type === 'calendarCoach') {
      const hasMultiDay = sortedSlots.some((slot) => clean(slot.endDate) && slot.endDate !== slot.date);
      const outputRoles = roles.filter((role) => role && role.id);
      const knownRoleIds = new Set(outputRoles.map((role) => role.id));
      const includeUnassigned = !outputRoles.length || assignments.some((assignment) => !knownRoleIds.has(assignment.roleId));
      const rows = sortedSlots.map((slot) => {
        const slotAssignments = assignments.filter((assignment) => assignment.slotId === slot.id);
        const roleColumns = outputRoles.map((role) => slotAssignments.filter((assignment) => assignment.roleId === role.id).map((assignment) => assignmentName(assignment, personMap)).filter(Boolean).join(', '));
        const unassigned = includeUnassigned
          ? [slotAssignments.filter((assignment) => !knownRoleIds.has(assignment.roleId)).map((assignment) => assignmentName(assignment, personMap)).filter(Boolean).join(', ')]
          : [];
        return [slot.date, ...(hasMultiDay ? [slot.endDate || slot.date] : []), slot.startTime, slot.endTime, slot.label || '', ...roleColumns, ...unassigned, scheduleStatusLabel(slot.status)];
      });
      return {
        type,
        sheetName: '날짜별 일정 · 역할',
        headers: ['날짜', ...(hasMultiDay ? ['종료 날짜'] : []), '시작', '종료', '세션명', ...outputRoles.map((role) => role.name || '역할'), ...(includeUnassigned ? ['배정 인원'] : []), '상태'],
        rows
      };
    }

    const hasMultiDay = sortedSlots.some((slot) => clean(slot.endDate) && slot.endDate !== slot.date);
    const rows = sortedSlots.map((slot) => {
      const names = assignments.filter((assignment) => assignment.slotId === slot.id).map((assignment) => assignmentName(assignment, personMap)).filter(Boolean);
      const zoom = latestCreatedZoomArtifact(data, slot.id);
      return [slot.date, ...(hasMultiDay ? [slot.endDate || slot.date] : []), slot.startTime, slot.endTime, slot.label || '', names.join(', '), zoom?.joinUrl || '', scheduleStatusLabel(slot.status)];
    });
    return { type, sheetName: '날짜별 일정 · Zoom', headers: ['날짜', ...(hasMultiDay ? ['종료 날짜'] : []), '시작', '종료', '세션명', '배정 인원', 'Zoom 참가 링크', '상태'], rows };
  }

  function scheduleToCsv(project, requestedType) {
    const output = scheduleOutputTable(project, requestedType);
    const rows = [output.headers, ...output.rows];
    return `\ufeff${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`;
  }

  function escapeXml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function scheduleToExcelXml(project, requestedType) {
    const output = scheduleOutputTable(project, requestedType);
    const rows = [output.headers, ...output.rows];
    const body = rows.map((row, index) => `<Row>${row.map((value) => `<Cell${index === 0 ? ' ss:StyleID="Header"' : ''}><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`).join('')}</Row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DCE6F1" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="${escapeXml(output.sheetName)}"><Table>${body}</Table></Worksheet></Workbook>`;
  }

  function addMinutesToTime(time, durationMinutes) {
    const start = timeToMinutes(time);
    const duration = Math.max(1, Number(durationMinutes) || 60);
    if (start == null) return '';
    const end = Math.min((23 * 60) + 59, start + duration);
    return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  }

  function externalChangeApprovalRequired(project) {
    return project?.settings?.changeApprovalRequired !== false;
  }

  const GOOGLE_FORM_DEFINITION_SCHEMA_VERSION = 2;
  const GOOGLE_FORM_ITEM_KINDS = new Set([
    'shortText', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'date', 'time',
    'rating', 'radioGrid', 'checkboxGrid', 'section', 'textBlock', 'image', 'video',
    'fileUpload', 'unknown'
  ]);
  const GOOGLE_FORM_QUESTION_KINDS = new Set([
    'shortText', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'date', 'time',
    'rating', 'radioGrid', 'checkboxGrid', 'fileUpload', 'unknown'
  ]);
  const GOOGLE_FORM_GRADED_KINDS = new Set(['shortText', 'radio', 'checkbox', 'dropdown']);

  function cloneJson(value, fallback = null) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return fallback; }
  }

  function integerInRange(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
  }

  function canonicalGoogleFormItemKind(kindInput) {
    const original = clean(kindInput);
    const aliases = {
      text: 'shortText', short: 'shortText', shortAnswer: 'shortText', textQuestion: 'shortText',
      longText: 'paragraph', multipleChoice: 'radio', choice: 'radio', select: 'dropdown',
      linearScale: 'scale', pageBreak: 'section', title: 'textBlock', description: 'textBlock',
      multipleChoiceGrid: 'radioGrid', checkboxQuestion: 'checkbox', checkboxGridQuestion: 'checkboxGrid'
    };
    const kind = aliases[original] || original || 'shortText';
    return GOOGLE_FORM_ITEM_KINDS.has(kind) ? kind : 'unknown';
  }

  function normalizeGoogleFormMedia(mediaInput = {}) {
    const media = mediaInput && typeof mediaInput === 'object' && !Array.isArray(mediaInput) ? mediaInput : {};
    const properties = media.properties && typeof media.properties === 'object' ? media.properties : {};
    const alignment = ['LEFT', 'CENTER', 'RIGHT'].includes(clean(media.alignment || properties.alignment).toUpperCase())
      ? clean(media.alignment || properties.alignment).toUpperCase()
      : 'CENTER';
    const width = integerInRange(media.width ?? properties.width, 0, 0, 740);
    return {
      sourceUri: clean(media.sourceUri),
      contentUri: clean(media.contentUri),
      altText: clean(media.altText),
      alignment,
      width
    };
  }

  function normalizeGoogleFormOptions(optionsInput) {
    const options = Array.isArray(optionsInput) ? optionsInput : [];
    const usedIds = new Set();
    return options.map((option, index) => {
      const source = option && typeof option === 'object' && !Array.isArray(option) ? option : { value: option };
      const value = clean(source.value) || (source.isOther ? '기타' : '');
      const requestedId = clean(source.id) || `option-${index + 1}`;
      let id = requestedId;
      let suffix = 1;
      while (usedIds.has(id)) id = `${requestedId}-${suffix += 1}`;
      usedIds.add(id);
      const normalized = {
        id,
        value,
        isOther: Boolean(source.isOther)
      };
      if (source.image) normalized.image = normalizeGoogleFormMedia(source.image);
      if (clean(source.goToAction)) normalized.goToAction = clean(source.goToAction).toUpperCase();
      if (clean(source.goToSectionId)) normalized.goToSectionId = clean(source.goToSectionId);
      if (source.slotId != null) normalized.slotId = source.slotId;
      return normalized;
    }).filter((option) => option.value || option.isOther);
  }

  function normalizeGoogleFormGrading(gradingInput, kind) {
    if (!GOOGLE_FORM_GRADED_KINDS.has(kind) || !gradingInput || typeof gradingInput !== 'object' || Array.isArray(gradingInput)) return null;
    const rawAnswers = Array.isArray(gradingInput.correctAnswers)
      ? gradingInput.correctAnswers
      : Array.isArray(gradingInput.correctAnswers?.answers)
        ? gradingInput.correctAnswers.answers
        : Array.isArray(gradingInput.answers) ? gradingInput.answers : [];
    const correctAnswers = rawAnswers.map((answer) => clean(answer?.value ?? answer)).filter(Boolean);
    if (!correctAnswers.length) return null;
    const grading = {
      pointValue: integerInRange(gradingInput.pointValue, 1, 0, 1_000_000),
      correctAnswers
    };
    const feedbackKeys = kind === 'shortText' ? ['generalFeedback'] : ['whenRight', 'whenWrong'];
    feedbackKeys.forEach((key) => {
      if (clean(gradingInput[key])) grading[key] = typeof gradingInput[key] === 'object' ? cloneJson(gradingInput[key], undefined) : { text: clean(gradingInput[key]) };
    });
    return grading;
  }

  function createGoogleFormItem(kindInput = 'shortText', overridesInput = {}) {
    const overrides = overridesInput && typeof overridesInput === 'object' && !Array.isArray(overridesInput) ? overridesInput : {};
    const requestedKind = clean(kindInput || overrides.kind || overrides.type);
    const kind = canonicalGoogleFormItemKind(requestedKind);
    const key = clean(overrides.key);
    const item = {
      id: clean(overrides.id || overrides.localItemId) || (key ? `form-item-${key.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'question'}` : makeId('form-item')),
      kind,
      title: clean(overrides.title) || (GOOGLE_FORM_QUESTION_KINDS.has(kind) ? '질문' : ''),
      description: clean(overrides.description),
      required: Boolean(overrides.required)
    };
    if (key) item.key = key;
    if (clean(overrides.googleItemId || overrides.itemId)) item.googleItemId = clean(overrides.googleItemId || overrides.itemId);
    if (clean(overrides.questionId)) item.questionId = clean(overrides.questionId);
    if (overrides.sourceBinding && typeof overrides.sourceBinding === 'object') item.sourceBinding = cloneJson(overrides.sourceBinding, {});
    if (overrides.questionImage) item.questionImage = normalizeGoogleFormMedia(overrides.questionImage);

    if (['radio', 'checkbox', 'dropdown'].includes(kind)) {
      item.options = normalizeGoogleFormOptions(overrides.options);
      if (!item.options.length) item.options = normalizeGoogleFormOptions(['옵션 1', '옵션 2']);
      item.shuffle = Boolean(overrides.shuffle);
    }
    if (kind === 'scale') {
      item.low = integerInRange(overrides.low, 1, 0, 1);
      item.high = integerInRange(overrides.high, 5, 2, 10);
      item.lowLabel = clean(overrides.lowLabel);
      item.highLabel = clean(overrides.highLabel);
    }
    if (kind === 'date') {
      item.includeYear = (overrides.includeYear ?? overrides.date?.includeYear) !== false;
      item.includeTime = Boolean(overrides.includeTime ?? overrides.date?.includeTime);
    }
    if (kind === 'time') item.duration = Boolean(overrides.duration ?? overrides.time?.duration);
    if (kind === 'rating') {
      item.ratingScaleLevel = integerInRange(overrides.ratingScaleLevel ?? overrides.rating?.ratingScaleLevel ?? overrides.level, 5, 3, 10);
      const icon = clean(overrides.ratingIconType || overrides.rating?.ratingIconType || overrides.iconType).toUpperCase();
      item.ratingIconType = ['STAR', 'HEART', 'THUMB_UP'].includes(icon) ? icon : 'STAR';
    }
    if (kind === 'radioGrid' || kind === 'checkboxGrid') {
      const rows = Array.isArray(overrides.rows) ? overrides.rows : [];
      const usedRowIds = new Set();
      item.rows = rows.map((row, index) => {
        const source = row && typeof row === 'object' && !Array.isArray(row) ? row : { title: row };
        const requestedId = clean(source.id) || `row-${index + 1}`;
        let id = requestedId;
        let suffix = 1;
        while (usedRowIds.has(id)) id = `${requestedId}-${suffix += 1}`;
        usedRowIds.add(id);
        return {
          id,
          title: clean(source.title ?? source.value),
          required: source.required == null ? Boolean(overrides.required) : Boolean(source.required),
          ...(clean(source.questionId) ? { questionId: clean(source.questionId) } : {})
        };
      }).filter((row) => row.title);
      if (!item.rows.length) item.rows = [{ id: 'row-1', title: '행 1', required: Boolean(overrides.required) }];
      item.options = normalizeGoogleFormOptions(overrides.options);
      if (!item.options.length) item.options = normalizeGoogleFormOptions(['열 1', '열 2']);
      item.shuffleRows = Boolean(overrides.shuffleRows ?? overrides.shuffleQuestions);
    }
    if (kind === 'image') item.image = normalizeGoogleFormMedia(overrides.image || overrides.media || overrides);
    if (kind === 'video') {
      item.youtubeUri = clean(overrides.youtubeUri || overrides.video?.youtubeUri);
      item.caption = clean(overrides.caption);
      const media = normalizeGoogleFormMedia(overrides.video?.properties || overrides.media || overrides);
      item.alignment = media.alignment;
      item.width = media.width;
    }
    if (kind === 'fileUpload') {
      item.fileUpload = cloneJson(overrides.fileUpload || overrides, {});
      if (overrides.rawApiItem) item.rawApiItem = cloneJson(overrides.rawApiItem, {});
      item.readOnly = true;
      item.unsupportedReason = 'Google Forms API는 파일 업로드 질문 생성을 지원하지 않습니다.';
    }
    if (kind === 'unknown') {
      item.originalKind = clean(overrides.originalKind) || requestedKind || 'unknown';
      item.readOnly = true;
      item.unsupportedReason = clean(overrides.unsupportedReason) || '이 항목 유형은 CMOE에서 안전하게 생성할 수 없습니다.';
      if (overrides.rawApiItem) item.rawApiItem = cloneJson(overrides.rawApiItem, {});
    }
    const grading = normalizeGoogleFormGrading(overrides.grading, kind);
    if (grading) item.grading = grading;
    return item;
  }

  function createBlankGoogleFormDefinition(projectOrName = '') {
    const projectName = clean(typeof projectOrName === 'object' ? projectOrName?.name : projectOrName);
    const now = new Date().toISOString();
    return {
      id: makeId('form-definition'),
      schemaVersion: GOOGLE_FORM_DEFINITION_SCHEMA_VERSION,
      type: 'custom',
      title: projectName ? `${projectName} 설문` : '제목 없는 설문지',
      description: '',
      collectEmail: 'DO_NOT_COLLECT',
      settings: { emailCollectionType: 'DO_NOT_COLLECT', isQuiz: false },
      items: [createGoogleFormItem('shortText', { title: '질문' })],
      createdAt: now,
      updatedAt: now
    };
  }

  function normalizeGoogleFormDefinition(definitionInput, options = {}) {
    const source = definitionInput && typeof definitionInput === 'object' && !Array.isArray(definitionInput) ? definitionInput : {};
    const legacyQuestions = Array.isArray(source.questions) ? source.questions : [];
    const itemSources = Array.isArray(source.items) ? source.items : legacyQuestions;
    const usedIds = new Set();
    const items = itemSources.map((itemInput, index) => {
      const itemSource = itemInput && typeof itemInput === 'object' && !Array.isArray(itemInput) ? itemInput : {};
      const item = createGoogleFormItem(itemSource.kind || itemSource.type || 'shortText', itemSource);
      let id = item.id || `form-item-${index + 1}`;
      const requestedId = id;
      let suffix = 1;
      while (usedIds.has(id)) id = `${requestedId}-${suffix += 1}`;
      usedIds.add(id); item.id = id;
      return item;
    });
    const fallback = createBlankGoogleFormDefinition(options.projectOrName || options.defaultTitle || '');
    const type = ['registration', 'availability'].includes(clean(source.type)) ? clean(source.type) : 'custom';
    const emailCollectionType = clean(source.settings?.emailCollectionType || source.collectEmail).toUpperCase();
    const collectEmail = ['DO_NOT_COLLECT', 'VERIFIED', 'RESPONDER_INPUT'].includes(emailCollectionType) ? emailCollectionType : 'DO_NOT_COLLECT';
    const hasExplicitQuiz = Object.prototype.hasOwnProperty.call(source.settings || {}, 'isQuiz')
      || Object.prototype.hasOwnProperty.call(source.settings?.quizSettings || {}, 'isQuiz')
      || Object.prototype.hasOwnProperty.call(source, 'isQuiz');
    const explicitQuiz = Object.prototype.hasOwnProperty.call(source.settings || {}, 'isQuiz')
      ? source.settings.isQuiz
      : Object.prototype.hasOwnProperty.call(source.settings?.quizSettings || {}, 'isQuiz')
        ? source.settings.quizSettings.isQuiz
        : source.isQuiz;
    const isQuiz = hasExplicitQuiz ? Boolean(explicitQuiz) : items.some((item) => item.grading);
    const normalized = {
      id: clean(source.id) || fallback.id,
      schemaVersion: GOOGLE_FORM_DEFINITION_SCHEMA_VERSION,
      type,
      title: clean(source.title || source.info?.title) || fallback.title,
      description: clean(source.description || source.info?.description),
      collectEmail,
      settings: { emailCollectionType: collectEmail, isQuiz },
      items,
      createdAt: clean(source.createdAt) || fallback.createdAt,
      updatedAt: clean(source.updatedAt) || clean(source.createdAt) || fallback.updatedAt
    };
    const passthroughStrings = ['formId', 'revisionId', 'responderUri', 'editUri', 'documentTitle', 'source'];
    passthroughStrings.forEach((key) => { if (clean(source[key])) normalized[key] = clean(source[key]); });
    if (source.publishSettings && typeof source.publishSettings === 'object') normalized.publishSettings = cloneJson(source.publishSettings, {});
    return normalized;
  }

  function legacyGoogleFormQuestions(items) {
    return items.filter((item) => GOOGLE_FORM_QUESTION_KINDS.has(item.kind) && !['radioGrid', 'checkboxGrid', 'fileUpload', 'unknown'].includes(item.kind)).map((item) => ({
      key: item.key || item.id,
      title: item.title,
      kind: item.kind === 'shortText' ? 'text' : item.kind,
      required: Boolean(item.required),
      ...(item.options ? { options: cloneJson(item.options, []) } : {})
    }));
  }

  function availabilitySlotFingerprintFromSnapshot(snapshotInput) {
    const snapshot = Array.isArray(snapshotInput) ? snapshotInput : null;
    if (!snapshot) return '';
    const seenIds = new Set();
    const normalized = [];
    for (const slotInput of snapshot) {
      const slot = slotInput && typeof slotInput === 'object' && !Array.isArray(slotInput) ? slotInput : {};
      const id = clean(slot.id);
      const date = clean(slot.date);
      const endDate = clean(slot.endDate) || date;
      const startTime = clean(slot.startTime);
      const endTime = clean(slot.endTime);
      const label = clean(slot.label);
      if (!id || seenIds.has(id) || validateScheduleSlot({ date, ...(endDate !== date ? { endDate } : {}), startTime, endTime }).length) return '';
      seenIds.add(id);
      normalized.push(endDate === date ? [id, date, startTime, endTime, label] : [id, date, endDate, startTime, endTime, label]);
    }
    normalized.sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
    });
    return JSON.stringify(normalized);
  }

  function projectAvailabilitySlotFingerprint(project) {
    const slots = project?.data?.slots;
    if (!Array.isArray(slots)) return '';
    return availabilitySlotFingerprintFromSnapshot(slots
      .filter((slot) => clean(slot?.status).toLowerCase() !== 'cancelled')
      .map((slot) => ({
        id: slot?.id,
        date: slot?.date,
        endDate: slot?.endDate,
        startTime: slot?.startTime,
        endTime: slot?.endTime,
        label: slot?.label
      })));
  }

  function googleFormAvailabilityOptionSnapshot(optionInput) {
    const option = optionInput && typeof optionInput === 'object' && !Array.isArray(optionInput) ? optionInput : { value: optionInput };
    const value = clean(option.value);
    const match = value.match(/^\[([^\]]+)\]\s+(\d{4}-\d{2}-\d{2})(?:~(\d{4}-\d{2}-\d{2}))?\s+(\d{2}:\d{2})-(\d{2}:\d{2})(?:\s+·\s+([\s\S]*))?$/);
    if (!match) return null;
    const id = clean(match[1]);
    const structuredId = option.slotId == null ? '' : clean(option.slotId);
    if (structuredId && structuredId !== id) return null;
    return { id, date: match[2], ...(match[3] ? { endDate: match[3] } : {}), startTime: match[4], endTime: match[5], label: clean(match[6]) };
  }

  function googleFormAvailabilitySlotFingerprint(definitionInput) {
    const definition = definitionInput && typeof definitionInput === 'object' && !Array.isArray(definitionInput) ? definitionInput : {};
    const items = Array.isArray(definition.items) ? definition.items : Array.isArray(definition.questions) ? definition.questions : null;
    if (!items) return '';
    const explicit = items.filter((item) => clean(item?.key) === 'slots' || clean(item?.sourceBinding?.type) === 'projectSlots');
    const inferred = explicit.length ? explicit : items.filter((item) => {
      if (!Array.isArray(item?.options) || !item.options.length) return false;
      return item.options.every((option) => googleFormAvailabilityOptionSnapshot(option));
    });
    if (inferred.length !== 1 || !Array.isArray(inferred[0].options)) return '';
    const snapshot = inferred[0].options.map(googleFormAvailabilityOptionSnapshot);
    if (snapshot.some((slot) => !slot)) return '';
    return availabilitySlotFingerprintFromSnapshot(snapshot);
  }

  function googleFormAvailabilityConsistency(project, linkedInput = {}) {
    const linked = linkedInput && typeof linkedInput === 'object' && !Array.isArray(linkedInput) ? linkedInput : {};
    const scheduleReadiness = availabilityFormScheduleReadiness(project);
    if (!scheduleReadiness.ready) return {
      consistent: false,
      reason: scheduleReadiness.blockers[0]?.message || '현재 프로젝트 일정의 시간대를 안전하게 확인할 수 없습니다.',
      currentFingerprint: '',
      expectedFingerprint: '',
      source: 'unsafeSchedule'
    };
    const currentFingerprint = projectAvailabilitySlotFingerprint(project);
    if (!currentFingerprint) return {
      consistent: false,
      reason: '현재 프로젝트의 유효한 일정 기준을 확인할 수 없습니다.',
      currentFingerprint: '',
      expectedFingerprint: '',
      source: 'missing'
    };

    const hasLinkedFingerprint = Object.prototype.hasOwnProperty.call(linked, 'availabilitySlotFingerprint');
    let expectedFingerprint = hasLinkedFingerprint && typeof linked.availabilitySlotFingerprint === 'string'
      ? clean(linked.availabilitySlotFingerprint)
      : '';
    let source = hasLinkedFingerprint ? 'linked' : 'definition';
    if (!hasLinkedFingerprint) {
      const definitionId = clean(linked.definitionId);
      const definitions = Array.isArray(project?.data?.forms?.definitions) ? project.data.forms.definitions : [];
      const matches = definitionId ? definitions.filter((definition) => clean(definition?.id) === definitionId) : [];
      if (matches.length === 1) expectedFingerprint = googleFormAvailabilitySlotFingerprint(matches[0]);
    }
    if (!expectedFingerprint) return {
      consistent: false,
      reason: '가능 시간 설문을 만들 당시의 일정 기준이 없어 응답을 자동 반영할 수 없습니다.',
      currentFingerprint,
      expectedFingerprint: '',
      source
    };
    if (currentFingerprint !== expectedFingerprint) return {
      consistent: false,
      reason: '가능 시간 설문을 만든 뒤 프로젝트 일정이 변경되어 응답을 자동 반영할 수 없습니다.',
      currentFingerprint,
      expectedFingerprint,
      source
    };
    return { consistent: true, reason: '', currentFingerprint, expectedFingerprint, source };
  }

  function googleFormAvailabilityLiveStructure(formInput, linkedInput = {}) {
    const form = formInput && typeof formInput === 'object' && !Array.isArray(formInput) ? formInput : {};
    const linked = linkedInput && typeof linkedInput === 'object' && !Array.isArray(linkedInput) ? linkedInput : {};
    const rawItems = Array.isArray(form.items) ? form.items : [];
    const looksLikeApiForm = rawItems.some((item) => item?.questionItem || item?.questionGroupItem || item?.pageBreakItem || item?.textItem || item?.imageItem || item?.videoItem);
    const definition = looksLikeApiForm ? googleFormDefinitionFromApi(form) : normalizeGoogleFormDefinition(form);
    const items = Array.isArray(definition.items) ? definition.items : [];
    const questionIdOf = (item) => clean(item?.questionId);
    const candidatesFor = (semanticKey, legacyTitle) => {
      const expectedId = clean(linked?.questionIds?.[semanticKey]);
      if (expectedId) return items.filter((item) => questionIdOf(item) === expectedId);
      return items.filter((item) => clean(item?.title) === legacyTitle);
    };
    const invalid = (reason) => ({ valid: false, reason, fingerprint: '', definition });

    const slotsCandidates = candidatesFor('slots', '참여 가능한 시간');
    if (slotsCandidates.length !== 1) return invalid('현재 Google 설문에서 가능 시간 질문을 정확히 하나 찾을 수 없습니다.');
    const slotsItem = slotsCandidates[0];
    if (slotsItem.kind !== 'checkbox' || slotsItem.required !== true) {
      return invalid('가능 시간 질문은 필수 체크박스(복수 선택)여야 안전하게 동기화할 수 있습니다.');
    }
    const snapshot = (Array.isArray(slotsItem.options) ? slotsItem.options : []).map(googleFormAvailabilityOptionSnapshot);
    if (!snapshot.length || snapshot.some((slot) => !slot)) return invalid('가능 시간 질문의 선택지가 프로젝트 일정 형식과 다릅니다.');

    let identityQuestionCount = 0;
    for (const [semanticKey, legacyTitle] of [['participantId', '참여자 고유번호'], ['name', '성함']]) {
      const expectedId = clean(linked?.questionIds?.[semanticKey]);
      const candidates = candidatesFor(semanticKey, legacyTitle);
      if (expectedId && candidates.length !== 1) return invalid(`${legacyTitle} 질문 연결이 Google 설문의 현재 구조와 다릅니다.`);
      if (!expectedId && candidates.length > 1) return invalid(`${legacyTitle} 질문이 여러 개라 응답자를 안전하게 구분할 수 없습니다.`);
      if (!candidates.length) continue;
      if (candidates[0].kind !== 'shortText') return invalid(`${legacyTitle} 질문은 단답형이어야 응답자를 안전하게 구분할 수 있습니다.`);
      identityQuestionCount += 1;
    }
    const collectsEmail = ['VERIFIED', 'RESPONDER_INPUT'].includes(clean(form?.settings?.emailCollectionType || definition?.settings?.emailCollectionType).toUpperCase());
    if (!identityQuestionCount && !collectsEmail) return invalid('응답자를 명단과 연결할 고유번호, 성함 또는 이메일 수집 정보가 없습니다.');

    return {
      valid: true,
      reason: '',
      fingerprint: availabilitySlotFingerprintFromSnapshot(snapshot),
      definition,
      slotsQuestionId: questionIdOf(slotsItem)
    };
  }

  function googleFormAvailabilityLiveFingerprint(formInput, linkedInput = {}) {
    const structure = googleFormAvailabilityLiveStructure(formInput, linkedInput);
    return structure.valid ? structure.fingerprint : '';
  }

  function googleFormSemanticQuestionIds(formInput, type, existingQuestionIds = {}) {
    if (!['registration', 'availability'].includes(type)) return {};
    const form = formInput && typeof formInput === 'object' && !Array.isArray(formInput) ? formInput : {};
    const rawItems = Array.isArray(form.items) ? form.items : [];
    const looksLikeApiForm = rawItems.some((item) => item?.questionItem || item?.questionGroupItem || item?.pageBreakItem || item?.textItem || item?.imageItem || item?.videoItem);
    const definition = looksLikeApiForm ? googleFormDefinitionFromApi(form) : normalizeGoogleFormDefinition(form);
    const items = Array.isArray(definition.items) ? definition.items : [];
    const specs = type === 'registration'
      ? {
          name: { title: '성함', kinds: ['shortText'], required: true },
          phone: { title: '휴대폰 번호', kinds: ['shortText'] },
          email: { title: '이메일 주소', kinds: ['shortText'] },
          group: { title: '소속·분류', kinds: ['shortText'] }
        }
      : {
          participantId: { title: '참여자 고유번호', kinds: ['shortText'] },
          name: { title: '성함', kinds: ['shortText'] },
          slots: { title: '참여 가능한 시간', kinds: ['checkbox'], required: true },
          notes: { title: '상세 요청사항', kinds: ['shortText', 'paragraph'] }
        };
    const result = {};
    Object.entries(specs).forEach(([key, spec]) => {
      const expectedId = clean(existingQuestionIds?.[key]);
      const expectedCandidates = expectedId ? items.filter((item) => clean(item?.questionId) === expectedId) : [];
      const candidates = expectedCandidates.length
        ? expectedCandidates
        : items.filter((item) => clean(item?.title) === spec.title);
      if (candidates.length !== 1) return;
      const item = candidates[0];
      if (!spec.kinds.includes(item.kind) || (spec.required && item.required !== true) || !clean(item.questionId)) return;
      result[key] = clean(item.questionId);
    });
    return result;
  }

  function googleFormRegistrationLiveStructure(formInput, linkedInput = {}) {
    const form = formInput && typeof formInput === 'object' && !Array.isArray(formInput) ? formInput : {};
    const linked = linkedInput && typeof linkedInput === 'object' && !Array.isArray(linkedInput) ? linkedInput : {};
    const rawItems = Array.isArray(form.items) ? form.items : [];
    const looksLikeApiForm = rawItems.some((item) => item?.questionItem || item?.questionGroupItem || item?.pageBreakItem || item?.textItem || item?.imageItem || item?.videoItem);
    const definition = looksLikeApiForm ? googleFormDefinitionFromApi(form) : normalizeGoogleFormDefinition(form);
    const items = Array.isArray(definition.items) ? definition.items : [];
    const invalid = (reason) => ({ valid: false, reason, definition, questionIds: {} });
    const resolve = (semanticKey, legacyTitle, { required = false } = {}) => {
      const expectedId = clean(linked?.questionIds?.[semanticKey]);
      const expectedCandidates = expectedId ? items.filter((item) => clean(item?.questionId) === expectedId) : [];
      const candidates = expectedCandidates.length
        ? expectedCandidates
        : items.filter((item) => clean(item?.title) === legacyTitle);
      if (candidates.length > 1) return { error: `${legacyTitle} 질문이 여러 개라 응답을 안전하게 구분할 수 없습니다.` };
      if (!candidates.length) return { item: null };
      const item = candidates[0];
      if (item.kind !== 'shortText') return { error: `${legacyTitle} 질문은 단답형이어야 명단에 안전하게 반영할 수 있습니다.` };
      if (required && item.required !== true) return { error: `${legacyTitle} 질문은 필수 단답형이어야 명단에 안전하게 반영할 수 있습니다.` };
      return { item };
    };

    const resolved = {};
    for (const [key, title, options] of [
      ['name', '성함', { required: true }],
      ['phone', '휴대폰 번호', {}],
      ['email', '이메일 주소', {}],
      ['group', '소속·분류', {}]
    ]) {
      const result = resolve(key, title, options);
      if (result.error) return invalid(result.error);
      resolved[key] = result.item;
    }
    if (!resolved.name) return invalid('이름 질문을 현재 Google 설문에서 찾지 못했습니다.');
    const collectsEmail = ['VERIFIED', 'RESPONDER_INPUT'].includes(clean(form?.settings?.emailCollectionType || definition?.settings?.emailCollectionType).toUpperCase());
    if (!resolved.phone && !resolved.email && !collectsEmail) return invalid('신청자를 구분할 휴대폰 번호 또는 이메일 수집 정보가 없습니다.');
    return {
      valid: true,
      reason: '',
      definition,
      collectsEmail,
      questionIds: Object.fromEntries(Object.entries(resolved).filter(([, item]) => item?.questionId).map(([key, item]) => [key, clean(item.questionId)]))
    };
  }

  function buildGoogleFormDefinition(project, type = 'availability') {
    const id = makeId('form-definition'); const now = new Date().toISOString();
    if (type === 'registration') {
      const items = [
        createGoogleFormItem('shortText', { key: 'name', title: '성함', required: true }),
        createGoogleFormItem('shortText', { key: 'phone', title: '휴대폰 번호', required: true }),
        createGoogleFormItem('shortText', { key: 'group', title: '소속·분류', required: false })
      ];
      return { id, schemaVersion: GOOGLE_FORM_DEFINITION_SCHEMA_VERSION, type, title: `${project.name} 신청자 정보`, description: '일정 운영에 필요한 기본 정보를 입력해주세요.', collectEmail: 'RESPONDER_INPUT', settings: { emailCollectionType: 'RESPONDER_INPUT', isQuiz: false }, items, questions: legacyGoogleFormQuestions(items), createdAt: now, updatedAt: now };
    }
    const options = project.data.slots.filter((slot) => clean(slot?.status).toLowerCase() !== 'cancelled').slice().sort((a, b) => slotKey(a).localeCompare(slotKey(b))).map((slot) => ({ value: `[${slot.id}] ${slot.date}${clean(slot.endDate) && slot.endDate !== slot.date ? `~${slot.endDate}` : ''} ${slot.startTime}-${slot.endTime}${slot.label ? ` · ${slot.label}` : ''}`, slotId: slot.id }));
    const slotsItem = createGoogleFormItem('checkbox', { key: 'slots', title: '참여 가능한 시간', required: true, options, sourceBinding: { type: 'projectSlots' } });
    slotsItem.options = normalizeGoogleFormOptions(options);
    const items = [
      createGoogleFormItem('shortText', { key: 'name', title: '성함', required: true }),
      slotsItem,
      createGoogleFormItem('paragraph', { key: 'notes', title: '상세 요청사항', required: false })
    ];
    return {
      id,
      schemaVersion: GOOGLE_FORM_DEFINITION_SCHEMA_VERSION,
      type: 'availability',
      title: `${project.name} 가능 시간 조사`,
      description: '성함과 이메일을 확인하고 실제로 참여 가능한 시간을 모두 선택해주세요. 최종 일정은 전체 응답을 검토한 뒤 확정됩니다.',
      collectEmail: 'RESPONDER_INPUT',
      settings: { emailCollectionType: 'RESPONDER_INPUT', isQuiz: false },
      items,
      questions: legacyGoogleFormQuestions(items),
      createdAt: now,
      updatedAt: now
    };
  }

  function googleFormUnsupportedItems(definitionInput) {
    const source = definitionInput && typeof definitionInput === 'object' && !Array.isArray(definitionInput) ? definitionInput : {};
    const rawItems = Array.isArray(source.items) ? source.items : Array.isArray(source.questions) ? source.questions : [];
    const rawQuestionTitleIndexes = new Set(rawItems.flatMap((item, index) => {
      const kind = canonicalGoogleFormItemKind(item?.kind || item?.type);
      return GOOGLE_FORM_QUESTION_KINDS.has(kind) && !clean(item?.title) ? [index] : [];
    }));
    const blankChoiceIndexes = new Set(rawItems.flatMap((item, index) => {
      const kind = canonicalGoogleFormItemKind(item?.kind || item?.type);
      if (!['radio', 'checkbox', 'dropdown'].includes(kind)) return [];
      return !Array.isArray(item?.options) || !item.options.length || item.options.some((option) => !clean(option?.value ?? option)) ? [index] : [];
    }));
    const blankGridRowIndexes = new Set(rawItems.flatMap((item, index) => {
      const kind = canonicalGoogleFormItemKind(item?.kind || item?.type);
      if (!['radioGrid', 'checkboxGrid'].includes(kind)) return [];
      return !Array.isArray(item?.rows) || !item.rows.length || item.rows.some((row) => !clean(row?.title ?? row?.value ?? row)) ? [index] : [];
    }));
    const blankGridOptionIndexes = new Set(rawItems.flatMap((item, index) => {
      const kind = canonicalGoogleFormItemKind(item?.kind || item?.type);
      if (!['radioGrid', 'checkboxGrid'].includes(kind)) return [];
      return !Array.isArray(item?.options) || !item.options.length || item.options.some((option) => !clean(option?.value ?? option)) ? [index] : [];
    }));
    const rawIntegerInRange = (value, minimum, maximum) => clean(value) !== '' && Number.isInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
    const invalidScaleIndexes = new Set(rawItems.flatMap((item, index) => {
      if (canonicalGoogleFormItemKind(item?.kind || item?.type) !== 'scale') return [];
      const hasLow = Object.prototype.hasOwnProperty.call(item || {}, 'low');
      const hasHigh = Object.prototype.hasOwnProperty.call(item || {}, 'high');
      const low = hasLow ? Number(item.low) : 1;
      const high = hasHigh ? Number(item.high) : 5;
      const invalid = (hasLow && !rawIntegerInRange(item.low, 0, 1))
        || (hasHigh && !rawIntegerInRange(item.high, 2, 10))
        || !Number.isFinite(low) || !Number.isFinite(high) || low >= high;
      return invalid ? [index] : [];
    }));
    const invalidRatingIndexes = new Set(rawItems.flatMap((item, index) => {
      if (canonicalGoogleFormItemKind(item?.kind || item?.type) !== 'rating') return [];
      const hasTopLevel = Object.prototype.hasOwnProperty.call(item || {}, 'ratingScaleLevel');
      const hasNested = Object.prototype.hasOwnProperty.call(item?.rating || {}, 'ratingScaleLevel');
      const hasLegacyLevel = Object.prototype.hasOwnProperty.call(item || {}, 'level');
      if (!hasTopLevel && !hasNested && !hasLegacyLevel) return [];
      const value = hasTopLevel ? item.ratingScaleLevel : hasNested ? item.rating.ratingScaleLevel : item.level;
      return rawIntegerInRange(value, 3, 10) ? [] : [index];
    }));
    const explicitMediaWidths = (item) => {
      const widths = [];
      const collect = (owner) => { if (owner && typeof owner === 'object' && Object.prototype.hasOwnProperty.call(owner, 'width')) widths.push(owner.width); };
      const kind = canonicalGoogleFormItemKind(item?.kind || item?.type);
      if (kind === 'image' || kind === 'video') {
        collect(item);
        collect(item?.properties);
        collect(item?.image);
        collect(item?.image?.properties);
        collect(item?.media);
        collect(item?.media?.properties);
      }
      collect(item?.questionImage);
      collect(item?.questionImage?.properties);
      if (kind === 'video') { collect(item?.video); collect(item?.video?.properties); }
      (Array.isArray(item?.options) ? item.options : []).forEach((option) => { collect(option?.image); collect(option?.image?.properties); });
      return widths;
    };
    const invalidMediaWidthIndexes = new Set(rawItems.flatMap((item, index) => explicitMediaWidths(item).some((width) => !rawIntegerInRange(width, 0, 740)) ? [index] : []));
    const gradingIndexes = new Set(rawItems.flatMap((item, index) => item?.grading && typeof item.grading === 'object' && !Array.isArray(item.grading) ? [index] : []));
    const invalidPointValueIndexes = new Set(rawItems.flatMap((item, index) => {
      const grading = item?.grading;
      if (!grading || typeof grading !== 'object' || Array.isArray(grading) || !Object.prototype.hasOwnProperty.call(grading, 'pointValue')) return [];
      return rawIntegerInRange(grading.pointValue, 0, 999) ? [] : [index];
    }));
    const incompleteGradingIndexes = new Set(rawItems.flatMap((item, index) => {
      const grading = item?.grading;
      if (!grading || typeof grading !== 'object' || Array.isArray(grading)) return [];
      const answers = Array.isArray(grading.correctAnswers) ? grading.correctAnswers : Array.isArray(grading.correctAnswers?.answers) ? grading.correctAnswers.answers : Array.isArray(grading.answers) ? grading.answers : [];
      return answers.map((answer) => clean(answer?.value ?? answer)).filter(Boolean).length ? [] : [index];
    }));
    const definition = normalizeGoogleFormDefinition(definitionInput);
    return definition.items.flatMap((item, index) => {
      let reason = '';
      if (item.kind === 'fileUpload') reason = 'Google Forms API는 파일 업로드 질문 생성을 지원하지 않습니다.';
      else if (item.kind === 'unknown') reason = item.unsupportedReason || '알 수 없는 항목 유형입니다.';
      else if (rawQuestionTitleIndexes.has(index)) reason = '질문 제목을 입력해야 합니다.';
      else if (invalidScaleIndexes.has(index)) reason = '선형 배율은 시작 0~1, 끝 2~10의 정수이고 시작이 끝보다 작아야 합니다.';
      else if (invalidRatingIndexes.has(index)) reason = '평점 단계는 3~10 사이의 정수여야 합니다.';
      else if (invalidMediaWidthIndexes.has(index)) reason = '이미지와 동영상 너비는 0~740 사이의 정수여야 합니다.';
      else if (invalidPointValueIndexes.has(index)) reason = '배점은 0~999 사이의 정수여야 합니다.';
      else if (incompleteGradingIndexes.has(index)) reason = '채점할 정답을 하나 이상 입력해야 합니다.';
      else if (!definition.settings.isQuiz && gradingIndexes.has(index)) reason = '채점 정보가 있는 질문은 퀴즈를 켜거나 채점 정보를 지워야 합니다.';
      else if (blankChoiceIndexes.has(index)) reason = '비어 있지 않은 선택지가 하나 이상 필요합니다.';
      else if (blankGridRowIndexes.has(index)) reason = '그리드에는 이름이 있는 행이 하나 이상 필요합니다.';
      else if (blankGridOptionIndexes.has(index)) reason = '그리드에는 이름이 있는 열이 하나 이상 필요합니다.';
      else if (['radio', 'checkbox', 'dropdown'].includes(item.kind) && !item.options?.length) reason = '선택지가 하나 이상 필요합니다.';
      else if ((item.options || []).some((option) => option.goToSectionId)) reason = '응답에 따른 섹션 이동은 Google Forms에서 고급 편집해야 합니다.';
      else if (['radioGrid', 'checkboxGrid'].includes(item.kind) && (!item.rows?.length || !item.options?.length)) reason = '그리드에는 행과 열이 하나 이상 필요합니다.';
      else if (['radioGrid', 'checkboxGrid'].includes(item.kind) && item.options.some((option) => option.isOther || option.goToAction || option.goToSectionId)) reason = '그리드 선택지에는 기타 항목이나 섹션 이동을 사용할 수 없습니다.';
      else if (item.kind === 'dropdown' && item.options.some((option) => option.isOther)) reason = '드롭다운에는 기타 항목을 사용할 수 없습니다.';
      else if (item.kind === 'checkbox' && item.options.some((option) => option.goToAction || option.goToSectionId)) reason = '체크박스 선택지에는 섹션 이동을 사용할 수 없습니다.';
      else if (item.grading && ['radio', 'checkbox', 'dropdown'].includes(item.kind) && item.grading.correctAnswers.some((answer) => !item.options.some((option) => option.value === answer))) reason = '정답은 현재 선택지 중에서 골라야 합니다.';
      else if (item.questionImage && !googleFormAbsoluteHttpUrl(item.questionImage.sourceUri)) reason = '질문 이미지는 http 또는 https로 시작하는 전체 주소가 필요합니다.';
      else if (item.options?.some((option) => option.image && !googleFormAbsoluteHttpUrl(option.image.sourceUri))) reason = '선택지 이미지는 http 또는 https로 시작하는 전체 주소가 필요합니다.';
      else if (item.kind === 'image' && !googleFormAbsoluteHttpUrl(item.image?.sourceUri)) reason = '이미지는 http 또는 https로 시작하는 전체 주소가 필요합니다.';
      else if (item.kind === 'video' && !googleFormYoutubeVideoId(item.youtubeUri)) reason = 'YouTube 동영상 전체 주소 또는 11자리 동영상 ID가 필요합니다.';
      return reason ? [{ id: item.id, kind: item.kind, title: item.title, reason }] : [];
    });
  }

  function googleFormAbsoluteHttpUrl(value) {
    try {
      const url = new URL(clean(value));
      return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
    } catch (_) { return false; }
  }

  function googleFormYoutubeVideoId(value) {
    const raw = clean(value);
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') return '';
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      let candidate = '';
      if (host === 'youtu.be') candidate = url.pathname.split('/').filter(Boolean)[0] || '';
      else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
        candidate = clean(url.searchParams.get('v')) || (url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || '');
      }
      return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : '';
    } catch (_) { return ''; }
  }

  function googleFormYoutubeUri(value) {
    const id = googleFormYoutubeVideoId(value);
    return id ? `https://www.youtube.com/watch?v=${id}` : '';
  }

  function googleFormMediaProperties(media = {}) {
    const properties = {};
    if (['LEFT', 'CENTER', 'RIGHT'].includes(media.alignment)) properties.alignment = media.alignment;
    if (Number(media.width) > 0) properties.width = integerInRange(media.width, 0, 1, 740);
    return properties;
  }

  function googleFormImage(mediaInput = {}) {
    const media = normalizeGoogleFormMedia(mediaInput);
    const image = { sourceUri: media.sourceUri };
    if (media.altText) image.altText = media.altText;
    const properties = googleFormMediaProperties(media);
    if (Object.keys(properties).length) image.properties = properties;
    return image;
  }

  function googleFormGrading(item) {
    if (!item.grading || !GOOGLE_FORM_GRADED_KINDS.has(item.kind)) return null;
    const grading = {
      pointValue: integerInRange(item.grading.pointValue, 1, 0, 1_000_000),
      correctAnswers: { answers: item.grading.correctAnswers.map((value) => ({ value })) }
    };
    ['whenRight', 'whenWrong', 'generalFeedback'].forEach((key) => {
      if (item.grading[key]) grading[key] = cloneJson(item.grading[key], {});
    });
    return grading;
  }

  function googleFormChoiceOptions(options = [], { questionGroup = false } = {}) {
    return options.map((option) => {
      const result = { value: option.value };
      if (!questionGroup && option.isOther) result.isOther = true;
      if (option.image?.sourceUri) result.image = googleFormImage(option.image);
      if (!questionGroup && option.goToAction) result.goToAction = option.goToAction;
      else if (!questionGroup && option.goToSectionId) result.goToSectionId = option.goToSectionId;
      return result;
    });
  }

  function googleFormQuestion(item) {
    const question = { required: Boolean(item.required) };
    if (item.kind === 'shortText' || item.kind === 'paragraph') question.textQuestion = { paragraph: item.kind === 'paragraph' };
    else if (['radio', 'checkbox', 'dropdown'].includes(item.kind)) {
      question.choiceQuestion = {
        type: item.kind === 'radio' ? 'RADIO' : item.kind === 'checkbox' ? 'CHECKBOX' : 'DROP_DOWN',
        options: googleFormChoiceOptions(item.options),
        shuffle: Boolean(item.shuffle)
      };
    } else if (item.kind === 'scale') question.scaleQuestion = { low: item.low, high: item.high, lowLabel: item.lowLabel, highLabel: item.highLabel };
    else if (item.kind === 'date') question.dateQuestion = { includeYear: Boolean(item.includeYear), includeTime: Boolean(item.includeTime) };
    else if (item.kind === 'time') question.timeQuestion = { duration: Boolean(item.duration) };
    else if (item.kind === 'rating') question.ratingQuestion = { ratingScaleLevel: item.ratingScaleLevel, iconType: item.ratingIconType };
    const grading = googleFormGrading(item); if (grading) question.grading = grading;
    return question;
  }

  function googleFormApiItem(item) {
    const apiItem = { title: item.title || '', description: item.description || '' };
    if (['shortText', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'date', 'time', 'rating'].includes(item.kind)) {
      apiItem.questionItem = { question: googleFormQuestion(item) };
      if (item.questionImage?.sourceUri) apiItem.questionItem.image = googleFormImage(item.questionImage);
    } else if (item.kind === 'radioGrid' || item.kind === 'checkboxGrid') {
      apiItem.questionGroupItem = {
        questions: item.rows.map((row) => ({ required: Boolean(row.required), rowQuestion: { title: row.title } })),
        grid: {
          columns: { type: item.kind === 'checkboxGrid' ? 'CHECKBOX' : 'RADIO', options: googleFormChoiceOptions(item.options, { questionGroup: true }), shuffle: false },
          shuffleQuestions: Boolean(item.shuffleRows)
        }
      };
      if (item.questionImage?.sourceUri) apiItem.questionGroupItem.image = googleFormImage(item.questionImage);
    } else if (item.kind === 'section') apiItem.pageBreakItem = {};
    else if (item.kind === 'textBlock') apiItem.textItem = {};
    else if (item.kind === 'image') apiItem.imageItem = { image: googleFormImage(item.image) };
    else if (item.kind === 'video') {
      const properties = googleFormMediaProperties(item);
      apiItem.videoItem = { video: { youtubeUri: googleFormYoutubeUri(item.youtubeUri), ...(Object.keys(properties).length ? { properties } : {}) }, caption: item.caption || '' };
    }
    return apiItem;
  }

  function googleFormsApiRequests(definition) {
    const unsupported = googleFormUnsupportedItems(definition);
    if (unsupported.length) {
      const error = new Error(`Google 설문으로 만들 수 없는 항목이 있습니다: ${unsupported.map((item) => item.title || item.kind).join(', ')}`);
      error.code = 'GOOGLE_FORM_UNSUPPORTED_ITEMS'; error.unsupportedItems = unsupported;
      throw error;
    }
    const normalized = normalizeGoogleFormDefinition(definition);
    const requests = [
      { updateFormInfo: { info: { title: normalized.title, description: normalized.description }, updateMask: 'title,description' } },
      { updateSettings: { settings: { emailCollectionType: normalized.settings.emailCollectionType, quizSettings: { isQuiz: Boolean(normalized.settings.isQuiz) } }, updateMask: 'emailCollectionType,quizSettings.isQuiz' } }
    ];
    normalized.items.forEach((item, index) => requests.push({ createItem: { item: googleFormApiItem(item), location: { index } } }));
    return requests;
  }

  function googleFormItemFromApi(apiItemInput, index = 0) {
    const apiItem = apiItemInput && typeof apiItemInput === 'object' ? apiItemInput : {};
    const base = { id: clean(apiItem.itemId) || `imported-item-${index + 1}`, googleItemId: clean(apiItem.itemId), title: apiItem.title, description: apiItem.description };
    if (apiItem.questionItem?.question) {
      const question = apiItem.questionItem.question;
      const grading = question.grading ? {
        pointValue: question.grading.pointValue,
        correctAnswers: (question.grading.correctAnswers?.answers || []).map((answer) => answer.value),
        whenRight: question.grading.whenRight,
        whenWrong: question.grading.whenWrong,
        generalFeedback: question.grading.generalFeedback
      } : null;
      const common = { ...base, required: question.required, questionId: question.questionId, grading, questionImage: apiItem.questionItem.image };
      if (question.textQuestion) return createGoogleFormItem(question.textQuestion.paragraph ? 'paragraph' : 'shortText', common);
      if (question.choiceQuestion) {
        const type = question.choiceQuestion.type === 'CHECKBOX' ? 'checkbox' : question.choiceQuestion.type === 'DROP_DOWN' ? 'dropdown' : 'radio';
        return createGoogleFormItem(type, { ...common, options: question.choiceQuestion.options, shuffle: question.choiceQuestion.shuffle });
      }
      if (question.scaleQuestion) return createGoogleFormItem('scale', { ...common, ...question.scaleQuestion });
      if (question.dateQuestion) return createGoogleFormItem('date', { ...common, ...question.dateQuestion });
      if (question.timeQuestion) return createGoogleFormItem('time', { ...common, ...question.timeQuestion });
      if (question.ratingQuestion) return createGoogleFormItem('rating', { ...common, ...question.ratingQuestion });
      if (question.fileUploadQuestion) return createGoogleFormItem('fileUpload', { ...common, fileUpload: question.fileUploadQuestion, rawApiItem: apiItem });
      return createGoogleFormItem('unknown', { ...common, originalKind: 'questionItem', rawApiItem: apiItem });
    }
    if (apiItem.questionGroupItem?.grid) {
      const group = apiItem.questionGroupItem;
      const kind = group.grid.columns?.type === 'CHECKBOX' ? 'checkboxGrid' : 'radioGrid';
      return createGoogleFormItem(kind, {
        ...base,
        questionImage: group.image,
        required: Boolean((group.questions || []).length && (group.questions || []).every((question) => question.required)),
        rows: (group.questions || []).map((question, rowIndex) => ({ id: clean(question.questionId) || `row-${rowIndex + 1}`, title: question.rowQuestion?.title, required: question.required, questionId: question.questionId })),
        options: group.grid.columns?.options,
        shuffleRows: group.grid.shuffleQuestions
      });
    }
    if (apiItem.pageBreakItem) return createGoogleFormItem('section', base);
    if (apiItem.textItem) return createGoogleFormItem('textBlock', base);
    if (apiItem.imageItem?.image) return createGoogleFormItem('image', { ...base, image: apiItem.imageItem.image });
    if (apiItem.videoItem?.video) return createGoogleFormItem('video', { ...base, youtubeUri: apiItem.videoItem.video.youtubeUri, caption: apiItem.videoItem.caption, ...apiItem.videoItem.video.properties });
    return createGoogleFormItem('unknown', { ...base, originalKind: Object.keys(apiItem).find((key) => key.endsWith('Item')) || 'unknown', rawApiItem: apiItem });
  }

  function googleFormDefinitionFromApi(formInput) {
    const form = formInput && typeof formInput === 'object' && !Array.isArray(formInput) ? formInput : {};
    const formId = clean(form.formId);
    return normalizeGoogleFormDefinition({
      id: formId ? `google-form-definition-${formId}` : makeId('google-form-definition'),
      schemaVersion: GOOGLE_FORM_DEFINITION_SCHEMA_VERSION,
      type: 'custom',
      source: 'google',
      formId,
      revisionId: form.revisionId,
      responderUri: form.responderUri,
      editUri: formId ? `https://docs.google.com/forms/d/${formId}/edit` : '',
      title: form.info?.title,
      documentTitle: form.info?.documentTitle,
      description: form.info?.description,
      settings: {
        emailCollectionType: form.settings?.emailCollectionType || 'DO_NOT_COLLECT',
        isQuiz: Boolean(form.settings?.quizSettings?.isQuiz)
      },
      publishSettings: form.publishSettings,
      items: (Array.isArray(form.items) ? form.items : []).map(googleFormItemFromApi)
    });
  }

  function googleFormIdFromInput(rawInput) {
    const raw = clean(rawInput);
    if (!raw) return '';
    if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (_) {}
    const match = decoded.match(/\/forms\/(?:u\/\d+\/)?d\/(?!e\/)([A-Za-z0-9_-]{10,})(?:\/|$)/i);
    if (match) return match[1];
    try {
      const url = new URL(raw);
      const queryId = clean(url.searchParams.get('formId') || url.searchParams.get('id'));
      if (/^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
    } catch (_) {}
    return '';
  }

  function formAnswerValues(response, questionId) {
    const answer = questionId ? response?.answers?.[questionId] : null;
    return answer?.textAnswers?.answers?.map((item) => clean(item.value)).filter(Boolean) || [];
  }

  function formQuestionIndex(form) {
    const candidatesByTitle = new Map();
    (form?.items || []).forEach((item) => {
      const id = item.questionItem?.question?.questionId;
      const title = clean(item.title);
      if (!id || !title) return;
      const candidates = candidatesByTitle.get(title) || [];
      candidates.push(id);
      candidatesByTitle.set(title, candidates);
    });
    return new Map([...candidatesByTitle].flatMap(([title, candidates]) => candidates.length === 1 ? [[title, candidates[0]]] : []));
  }

  function mergeLiveGoogleFormQuestionIds(existingQuestionIds = {}, discoveredQuestionIds = {}, liveQuestionIds = []) {
    const live = new Set(Array.from(liveQuestionIds || []).map(clean).filter(Boolean));
    const preserved = Object.fromEntries(Object.entries(existingQuestionIds || {}).filter(([, questionId]) => live.has(clean(questionId))));
    return { ...preserved, ...(discoveredQuestionIds || {}) };
  }

  function responseOrderKey(response) {
    const submittedAt = Date.parse(response?.lastSubmittedTime || response?.createTime || '');
    return [
      Number.isFinite(submittedAt) ? submittedAt : 0,
      clean(response?.responseId),
      JSON.stringify(response?.answers || {})
    ];
  }

  function compareResponseOrder(left, right) {
    const leftKey = responseOrderKey(left);
    const rightKey = responseOrderKey(right);
    if (leftKey[0] !== rightKey[0]) return leftKey[0] - rightKey[0];
    if (leftKey[1] !== rightKey[1]) return leftKey[1].localeCompare(rightKey[1]);
    return leftKey[2].localeCompare(rightKey[2]);
  }

  function applyGoogleFormResponses(project, linked, payload) {
    const responses = Array.isArray(payload?.responses) ? payload.responses : [];
    let registrationStructure = null;
    if (linked?.type === 'registration') {
      registrationStructure = googleFormRegistrationLiveStructure(payload?.form, linked);
      if (!registrationStructure.valid) return {
        changed: 0,
        dataChanged: false,
        unmatched: responses.length,
        needsReview: true,
        type: 'registration',
        message: `${registrationStructure.reason} 기존 명단은 변경하지 않았습니다. 설문을 다시 가져와 질문 구성을 확인해주세요.`
      };
    }
    if (linked?.type === 'availability') {
      const consistency = googleFormAvailabilityConsistency(project, linked);
      if (!consistency.consistent) return {
        changed: 0,
        unmatched: responses.length,
        needsReview: true,
        type: 'availability',
        availabilityConsistency: consistency,
          message: `${consistency.reason} 기존 가능 시간은 변경하지 않았습니다.`
        };
      const liveStructure = googleFormAvailabilityLiveStructure(payload?.form, linked);
      const liveFingerprint = liveStructure.fingerprint;
      if (!liveFingerprint || liveFingerprint !== consistency.currentFingerprint || liveFingerprint !== consistency.expectedFingerprint) return {
        changed: 0,
        unmatched: responses.length,
        needsReview: true,
        type: 'availability',
        availabilityConsistency: { ...consistency, consistent: false, liveFingerprint, source: 'liveForm', liveStructureReason: liveStructure.reason || '' },
        message: `${liveStructure.reason || 'Google 설문의 현재 일정 선택지가 프로젝트와 다릅니다.'} 기존 가능 시간은 변경하지 않았습니다. 설문을 다시 가져와 확인해주세요.`
      };
    }
    const questions = formQuestionIndex(payload?.form);
    const liveQuestionIds = new Set((payload?.form?.items || []).map((item) => clean(item?.questionItem?.question?.questionId)).filter(Boolean));
    const questionId = (semanticKey, legacyTitle) => {
      const structurallyVerifiedId = clean(registrationStructure?.questionIds?.[semanticKey]);
      if (structurallyVerifiedId) return structurallyVerifiedId;
      const linkedId = clean(linked?.questionIds?.[semanticKey]);
      return linkedId && liveQuestionIds.has(linkedId) ? linkedId : questions.get(legacyTitle);
    };
    if (linked?.type === 'registration') {
      const fields = [
        { key: 'name', title: '성함' },
        { key: 'phone', title: '휴대폰 번호' },
        { key: 'email', title: '이메일 주소' },
        { key: 'group', title: '소속·분류' }
      ];
      const fieldQuestionIds = Object.fromEntries(fields.map((field) => [field.key, questionId(field.key, field.title)]));
      if (!fieldQuestionIds.name) return {
        changed: 0,
        unmatched: responses.length,
        needsReview: true,
        type: 'registration',
        message: '이름 질문을 현재 Google 설문에서 찾지 못해 명단을 변경하지 않았습니다. 설문 연결을 다시 가져와 확인해주세요.'
      };
      const headers = fields.map((field) => field.title);
      const orderedResponses = responses.slice().sort(compareResponseOrder);
      let unmatched = 0;
      const responseRows = orderedResponses.map((response) => fields.map((field) => formAnswerValues(response, fieldQuestionIds[field.key])[0] || (field.key === 'email' ? clean(response.respondentEmail) : ''))).filter((row) => {
        if (clean(row[0])) return true;
        unmatched += 1; return false;
      });
      if (!responseRows.length) return { changed: 0, unmatched, needsReview: Boolean(unmatched), type: 'registration', message: unmatched ? `이름이 없는 신청 응답 ${unmatched}건은 명단에 반영하지 않았습니다.` : '새로 반영할 신청 응답이 없습니다.' };
      const matrix = [headers, ...responseRows];
      const imported = matrixToRoster(matrix, { roles: project.data.roles || [] });
      const standardTypes = new Set(['name', 'phone', 'email', 'group']);
      const existingTypes = new Set(project.data.columns.map((column) => column.type));
      let columnsChanged = 0;
      imported.columns.filter((column) => standardTypes.has(column.type) && !existingTypes.has(column.type)).forEach((column) => {
        project.data.columns.push({ ...column });
        existingTypes.add(column.type);
        columnsChanged += 1;
      });
      const columnByType = new Map(project.data.columns.map((column) => [column.type, column]));
      const beforePeople = new Map(project.data.people.map((person) => [person.id, JSON.stringify(person)]));
      const touchedPeople = new Set();
      const identityKey = (field, value) => {
        const normalized = clean(value).toLowerCase();
        if (field !== 'phone') return normalized;
        return /^[+\d\s().-]+$/.test(normalized) ? normalized.replace(/[^0-9]/g, '') : normalized;
      };
      const matchingPeople = (field, key) => key
        ? project.data.people.filter((person) => identityKey(field, person[field]) === key)
        : [];
      imported.people.forEach((incoming) => {
        const emailKey = identityKey('email', incoming.email);
        const phoneKey = identityKey('phone', incoming.phone);
        const nameKey = identityKey('name', incoming.name);
        const emailMatches = matchingPeople('email', emailKey);
        const phoneMatches = matchingPeople('phone', phoneKey);
        const nameMatches = matchingPeople('name', nameKey);
        let target = emailMatches.length === 1 ? emailMatches[0] : null;
        if (emailMatches.length > 1) { unmatched += 1; return; }
        if (target && phoneKey && (phoneMatches.length > 1 || (phoneMatches.length === 1 && phoneMatches[0].id !== target.id))) { unmatched += 1; return; }
        if (!target && phoneKey) {
          if (phoneMatches.length > 1) { unmatched += 1; return; }
          if (phoneMatches.length === 1) {
            const existingEmailKey = identityKey('email', phoneMatches[0].email);
            if (emailKey && existingEmailKey && emailKey !== existingEmailKey) { unmatched += 1; return; }
            target = phoneMatches[0];
          }
        }
        if (target && nameKey && nameMatches.length && !nameMatches.some((person) => person.id === target.id)) { unmatched += 1; return; }
        if (!target && nameMatches.length === 1) {
          const candidate = nameMatches[0];
          const candidateEmailKey = identityKey('email', candidate.email);
          const candidatePhoneKey = identityKey('phone', candidate.phone);
          const emailCompatible = !emailKey ? !candidateEmailKey : (!candidateEmailKey || candidateEmailKey === emailKey);
          const phoneCompatible = !phoneKey ? !candidatePhoneKey : (!candidatePhoneKey || candidatePhoneKey === phoneKey);
          if (emailCompatible && phoneCompatible) target = candidate;
        } else if (!target && nameMatches.length > 1 && !emailKey && !phoneKey) {
          unmatched += 1; return;
        }
        if (target) {
          ['name', 'phone', 'email', 'group'].forEach((type) => {
            const column = columnByType.get(type);
            if (column && incoming[type]) target.values[column.id] = incoming[type];
            target[type] = incoming[type] || target[type];
          });
        } else {
          if (!clean(incoming.name) || (!clean(incoming.email) && !clean(incoming.phone))) { unmatched += 1; return; }
          const values = {};
          project.data.columns.forEach((column) => { values[column.id] = incoming[column.type] || ''; });
          target = { ...incoming, id: makeId('person'), sourceOrder: project.data.people.length, values };
          project.data.people.push(target);
        }
        touchedPeople.add(target.id);
      });
      const changed = [...touchedPeople].filter((personId) => beforePeople.get(personId) !== JSON.stringify(project.data.people.find((person) => person.id === personId))).length;
      return { changed, dataChanged: Boolean(changed || columnsChanged), columnsChanged, unmatched, type: 'registration', message: `${changed}명의 신청자 정보를 변경했습니다.${columnsChanged ? ` 명단 컬럼 ${columnsChanged}개를 추가했습니다.` : ''}${unmatched ? ` 일치 여부를 확인할 응답 ${unmatched}건이 있습니다.` : ''}` };
    }

    if (linked?.type !== 'availability') {
      return {
        changed: 0,
        unmatched: 0,
        type: 'custom',
        responseCount: responses.length,
        message: `자유 설문 응답 ${responses.length}건을 확인했습니다. 명단이나 일정에는 자동으로 반영하지 않았습니다.`
      };
    }

    const nameId = questionId('name', '성함');
    const participantId = questionId('participantId', '참여자 고유번호');
    const slotsId = questionId('slots', '참여 가능한 시간');
    if (!slotsId) return {
      changed: 0,
      unmatched: responses.length,
      needsReview: true,
      type: 'availability',
      message: '가능 시간 질문을 현재 Google 설문에서 찾지 못해 기존 가능 시간을 변경하지 않았습니다. 설문 연결을 다시 가져와 확인해주세요.'
    };
    const latestByPerson = new Map();
    let unmatched = 0;
    responses.forEach((response) => {
      const rawId = formAnswerValues(response, participantId)[0];
      const name = formAnswerValues(response, nameId)[0];
      const email = clean(response.respondentEmail).toLowerCase();
      const nameKey = clean(name).toLowerCase();
      const idPerson = rawId ? project.data.people.find((item) => item.id === rawId) : null;
      const emailMatches = email ? project.data.people.filter((item) => clean(item.email).toLowerCase() === email) : [];
      const nameMatches = nameKey ? project.data.people.filter((item) => clean(item.name).toLowerCase() === nameKey) : [];
      if (emailMatches.length > 1) { unmatched += 1; return; }
      let person = idPerson;
      if (person) {
        const storedEmail = clean(person.email).toLowerCase();
        const emailPointsElsewhere = emailMatches.length === 1 && emailMatches[0].id !== person.id;
        const emailConflictsWithPerson = Boolean(email && storedEmail && email !== storedEmail);
        const namePointsElsewhere = nameMatches.length === 1 && nameMatches[0].id !== person.id;
        const ambiguousDifferentName = nameMatches.length > 1 && !nameMatches.some((item) => item.id === person.id);
        if (emailPointsElsewhere || emailConflictsWithPerson || namePointsElsewhere || ambiguousDifferentName) { unmatched += 1; return; }
      }
      if (!person && emailMatches.length === 1) person = emailMatches[0];
      if (person && nameMatches.length && !nameMatches.some((item) => item.id === person.id)) { unmatched += 1; return; }
      if (!person && name) {
        if (nameMatches.length > 1) { unmatched += 1; return; }
        person = nameMatches[0] || null;
      }
      if (!person) { unmatched += 1; return; }
      const current = latestByPerson.get(person.id);
      if (!current || compareResponseOrder(current.response, response) < 0) latestByPerson.set(person.id, { person, response });
    });
    let changed = 0;
    latestByPerson.forEach(({ person, response }) => {
      const rawValues = formAnswerValues(response, slotsId);
      const recognizedSlotIds = rawValues
        .map((value) => value.match(/^\[([^\]]+)\]/)?.[1])
        .filter((slotId) => project.data.slots.some((slot) => clean(slot?.id) === clean(slotId) && clean(slot?.status).toLowerCase() !== 'cancelled'));
      if (recognizedSlotIds.length !== rawValues.length) { unmatched += 1; return; }
      const nextSlotIds = [...new Set(recognizedSlotIds)];
      const previousSlotIds = [...new Set(project.data.availability[person.id] || [])];
      if (previousSlotIds.slice().sort().join('\u0000') === nextSlotIds.slice().sort().join('\u0000')) return;
      project.data.availability[person.id] = nextSlotIds;
      changed += 1;
    });
    return { changed, unmatched, type: 'availability', message: `${changed}명의 가능 시간을 반영했습니다.${unmatched ? ` 일치하지 않은 응답 ${unmatched}건은 확인이 필요합니다.` : ''}` };
  }

  function externalOperationFingerprint(project, kind, connections = [], effectiveDefaultConnectionIds = {}) {
    const data = project?.data || {};
    const sorted = (items) => items.slice().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const lifecycle = [project?.status || '', sorted(project?.installedModules || [])];
    const schedule = {
      timeZone: clean(project?.settings?.timezone) || 'Asia/Seoul',
      slots: sorted((data.slots || []).map((slot) => [slot.id, slot.date, clean(slot.endDate) && slot.endDate !== slot.date ? slot.endDate : '', slot.startTime, slot.endTime, slot.label, slot.status, Boolean(slot.locked)])),
      assignments: sorted((data.assignments || []).map((assignment) => [assignment.id, assignment.slotId, assignment.personId, assignment.roleId, Boolean(assignment.locked)])),
      people: sorted((data.people || []).map((person) => [person.id, person.name, person.email, person.phone, person.active !== false, sorted(Object.entries(person.values || {}))])),
      roles: sorted((data.roles || []).map((role) => [role.id, role.name, role.active !== false]))
    };
    const artifacts = sorted((data.externalArtifacts || []).filter((artifact) => artifact.kind === kind).map((artifact) => [artifact.externalId || '', artifact.slotId || '', artifact.personId || '', artifact.connectionId || '', artifact.status || '', artifact.updatedAt || artifact.createdAt || '', artifact.joinUrl || '']));
    const defaultType = kind === 'zoom' ? 'zoom' : kind === 'googleForm' ? 'forms' : 'gmail';
    const effectiveDefaultConnectionId = project?.settings?.defaultConnectionIds?.[defaultType] || effectiveDefaultConnectionIds?.[defaultType] || '';
    const routing = kind === 'zoom'
      ? [effectiveDefaultConnectionId, sorted((data.slots || []).map((slot) => [slot.id, slot.zoomConnectionId || '']))]
      : kind === 'googleForm'
        ? [effectiveDefaultConnectionId]
        : [effectiveDefaultConnectionId];
    const routedConnectionIds = new Set();
    if (effectiveDefaultConnectionId) routedConnectionIds.add(effectiveDefaultConnectionId);
    if (kind === 'zoom') (data.slots || []).forEach((slot) => { if (slot.zoomConnectionId) routedConnectionIds.add(slot.zoomConnectionId); });
    artifacts.forEach((artifact) => { if (artifact[3]) routedConnectionIds.add(artifact[3]); });
    const connectionIdentity = sorted([...routedConnectionIds].map((id) => {
      const connection = (connections || []).find((item) => item.id === id);
      return connection ? [id, connection.type || '', connection.status || '', connection.account || '', connection.updatedAt || ''] : [id, 'missing'];
    }));
    const payload = kind === 'gmailDraft'
      ? sorted(buildMailPackage(project, effectiveDefaultConnectionIds).entries.map((entry) => [entry.personId, entry.email, entry.subject, entry.body, entry.bodyHtml]))
      : kind === 'googleForm'
        ? [project?.name || '', data.forms || {}, data.columns || [], data.availability || {}, schedule]
        : [project?.name || '', schedule];
    return JSON.stringify({ kind, lifecycle, payload, artifacts, routing, connectionIdentity });
  }

  function buildMailPackage(project, effectiveDefaultConnectionIds = {}) {
    const personMap = new Map(project.data.people.map((person) => [person.id, person]));
    const roleMap = new Map(project.data.roles.map((role) => [role.id, role]));
    const slotMap = new Map(project.data.slots.map((slot) => [slot.id, slot]));
    const entries = project.data.people.filter((person) => person.active !== false && person.email).map((person) => {
      const assignments = project.data.assignments.filter((assignment) => assignment.personId === person.id && slotMap.has(assignment.slotId) && slotMap.get(assignment.slotId).status !== 'cancelled').map((assignment) => {
        const slot = slotMap.get(assignment.slotId);
        const peers = project.data.assignments.filter((candidate) => candidate.slotId === assignment.slotId && candidate.personId !== person.id).map((candidate) => personMap.get(candidate.personId)?.name).filter(Boolean);
        const zoomConnectionId = slot?.zoomConnectionId || project.settings?.defaultConnectionIds?.zoom || effectiveDefaultConnectionIds?.zoom || null;
        const artifact = project.data.externalArtifacts.find((candidate) => candidate.kind === 'zoom' && candidate.slotId === assignment.slotId && candidate.connectionId === zoomConnectionId && candidate.status === 'created');
        return { date: slot?.date || '', endDate: slot?.endDate || '', startTime: slot?.startTime || '', endTime: slot?.endTime || '', label: slot?.label || '', role: roleMap.get(assignment.roleId)?.name || '', peers, zoomJoinUrl: artifact?.joinUrl || '' };
      }).sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
      const personalSchedule = assignments.map((item) => `${item.date}${item.endDate && item.endDate !== item.date ? `~${item.endDate}` : ''} ${item.startTime}-${item.endTime}${item.label ? ` · ${item.label}` : ''}${item.peers.length ? ` · 함께: ${item.peers.join(', ')}` : ''}${item.zoomJoinUrl ? `\n${item.zoomJoinUrl}` : ''}`).join('\n\n');
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
    analyzeRosterInput,
    matrixToRoster,
    normalizePersonRoleIds,
    isValidCalendarDate,
    timeToMinutes,
    validateScheduleSlot,
    parseSlots,
    slotKey,
    compareCalendarDates,
    calendarEventInstants,
    calendarEventPhase,
    calendarAutomationTimeReadiness,
    zoomMeetingSlotReadiness,
    availabilityFormScheduleReadiness,
    generateSchedule,
    validateAssignments,
    validateScheduleConstraints,
    rosterViewIncludedIds,
    scheduleSheetConflicts,
    collectScheduleConflicts,
    diffScheduleDependencies,
    planScheduleChange,
    planScheduleBatchChange,
    escapeCsv,
    scheduleOutputTable,
    scheduleToCsv,
    scheduleToExcelXml,
    addMinutesToTime,
    externalChangeApprovalRequired,
    createBlankGoogleFormDefinition,
    createGoogleFormItem,
    normalizeGoogleFormDefinition,
    googleFormDefinitionFromApi,
    googleFormIdFromInput,
    googleFormUnsupportedItems,
    mergeLiveGoogleFormQuestionIds,
    projectAvailabilitySlotFingerprint,
    googleFormAvailabilitySlotFingerprint,
    googleFormAvailabilityConsistency,
    googleFormAvailabilityLiveFingerprint,
    googleFormSemanticQuestionIds,
    googleFormRegistrationLiveStructure,
    buildGoogleFormDefinition,
    googleFormsApiRequests,
    applyGoogleFormResponses,
    externalOperationFingerprint,
    buildMailPackage,
    mailPackageToCsv
  };
});
