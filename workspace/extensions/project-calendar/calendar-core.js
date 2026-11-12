(function exposeProjectCalendarCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProjectCalendarCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MINUTE_MS = 60 * 1000;
  const DEFAULT_TIME_ZONE = 'UTC';
  const formatterCache = new Map();
  const timeZoneValidity = new Map();

  function dateParts(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
  }

  function isValidDateKey(value) {
    return Boolean(dateParts(value));
  }

  function timeToMinutes(value) {
    const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function minutesToTime(value) {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function durationMinutes(startTime, endTime) {
    const start = timeToMinutes(startTime);
    const end = timeToMinutes(endTime);
    return start == null || end == null || end <= start ? null : end - start;
  }

  function daysInMonth(year, month) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1 || month < 1 || month > 12) return 0;
    if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function utcDateMs(year, month, day) {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getTime();
  }

  function formatDateKey(year, month, day) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function dateKeyFromUtcMs(value) {
    const date = new Date(value);
    return formatDateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  function addDays(dateKey, amount) {
    const parts = dateParts(dateKey);
    const days = Number(amount);
    if (!parts || !Number.isInteger(days)) return null;
    return dateKeyFromUtcMs(utcDateMs(parts.year, parts.month, parts.day) + days * DAY_MS);
  }

  function compareDateKeys(left, right) {
    if (!isValidDateKey(left) || !isValidDateKey(right)) return null;
    return left === right ? 0 : left < right ? -1 : 1;
  }

  function orderedDateRange(firstDate, secondDate = firstDate) {
    if (!isValidDateKey(firstDate) || !isValidDateKey(secondDate)) return null;
    return firstDate <= secondDate
      ? { start: firstDate, end: secondDate }
      : { start: secondDate, end: firstDate };
  }

  function slotEndDate(slot = {}) {
    return String(slot.endDate || '').trim() || slot.date;
  }

  function slotOccursOnDate(slot = {}, dateKey) {
    const endDate = slotEndDate(slot);
    return isValidDateKey(slot.date) && isValidDateKey(endDate) && isValidDateKey(dateKey)
      && slot.date <= dateKey && dateKey <= endDate;
  }

  function offsetDateTime(dateKey, time, offsetMinutes) {
    const parts = dateParts(dateKey);
    const startMinutes = timeToMinutes(time);
    const offset = Number(offsetMinutes);
    if (!parts || startMinutes == null || !Number.isInteger(offset)) return null;
    const total = startMinutes + offset;
    const dayOffset = Math.floor(total / (24 * 60));
    const normalizedMinutes = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
    return { date: addDays(dateKey, dayOffset), time: minutesToTime(normalizedMinutes), dayOffset };
  }

  function mondayIndex(dateKey) {
    const parts = dateParts(dateKey);
    if (!parts) return null;
    const sundayFirst = new Date(utcDateMs(parts.year, parts.month, parts.day)).getUTCDay();
    return (sundayFirst + 6) % 7;
  }

  function weekRange(anchorDate) {
    const weekday = mondayIndex(anchorDate);
    if (weekday == null) return null;
    const start = addDays(anchorDate, -weekday);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    return { start, end: days[6], days };
  }

  function monthGrid(anchorDate) {
    const anchor = dateParts(anchorDate);
    if (!anchor) return null;
    const monthStart = formatDateKey(anchor.year, anchor.month, 1);
    const monthEnd = formatDateKey(anchor.year, anchor.month, daysInMonth(anchor.year, anchor.month));
    const rangeStart = addDays(monthStart, -mondayIndex(monthStart));
    const days = Array.from({ length: 42 }, (_, index) => {
      const date = addDays(rangeStart, index);
      return {
        date,
        inMonth: date.slice(0, 7) === monthStart.slice(0, 7),
        weekIndex: Math.floor(index / 7),
        weekday: index % 7
      };
    });
    return {
      anchorMonth: monthStart.slice(0, 7),
      monthStart,
      monthEnd,
      rangeStart,
      rangeEnd: days[41].date,
      days,
      weeks: Array.from({ length: 6 }, (_, index) => days.slice(index * 7, index * 7 + 7))
    };
  }

  function validTimeZone(timeZone) {
    const value = String(timeZone || '').trim();
    if (!value) return false;
    if (timeZoneValidity.has(value)) return timeZoneValidity.get(value);
    let valid = true;
    try { new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date(0)); }
    catch (_) { valid = false; }
    timeZoneValidity.set(value, valid);
    return valid;
  }

  function projectTimeZone(project, fallback = DEFAULT_TIME_ZONE) {
    const configured = String(project?.settings?.timezone || '').trim();
    return validTimeZone(configured) ? configured : (validTimeZone(fallback) ? fallback : DEFAULT_TIME_ZONE);
  }

  function formatterFor(timeZone) {
    if (!formatterCache.has(timeZone)) {
      formatterCache.set(timeZone, new Intl.DateTimeFormat('en-GB', {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }));
    }
    return formatterCache.get(timeZone);
  }

  function zonedParts(epochMs, timeZone) {
    if (!Number.isFinite(epochMs) || !validTimeZone(timeZone)) return null;
    const values = {};
    formatterFor(timeZone).formatToParts(new Date(epochMs)).forEach((part) => {
      if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type)) values[part.type] = Number(part.value);
    });
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].every((key) => Number.isFinite(values[key])) ? values : null;
  }

  function offsetAt(epochMs, timeZone) {
    const parts = zonedParts(epochMs, timeZone);
    if (!parts) return null;
    const localAsUtc = utcDateMs(parts.year, parts.month, parts.day)
      + (parts.hour * 60 + parts.minute) * MINUTE_MS
      + parts.second * 1000;
    return Math.round((localAsUtc - Math.floor(epochMs / 1000) * 1000) / MINUTE_MS);
  }

  function zonedDateTimeToEpoch(dateKey, time, timeZone = DEFAULT_TIME_ZONE) {
    const date = dateParts(dateKey);
    const minutes = timeToMinutes(time);
    if (!date) return { ok: false, reason: 'invalidDate', epochMs: null, ambiguous: false, alternatives: [] };
    if (minutes == null) return { ok: false, reason: 'invalidTime', epochMs: null, ambiguous: false, alternatives: [] };
    if (!validTimeZone(timeZone)) return { ok: false, reason: 'invalidTimeZone', epochMs: null, ambiguous: false, alternatives: [] };

    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const localAsUtc = utcDateMs(date.year, date.month, date.day) + minutes * MINUTE_MS;
    const offsets = new Set();
    [-48, -36, -24, -12, 0, 12, 24, 36, 48].forEach((hours) => {
      const offset = offsetAt(localAsUtc + hours * 60 * MINUTE_MS, timeZone);
      if (offset != null) offsets.add(offset);
    });
    const alternatives = [...offsets].map((offset) => localAsUtc - offset * MINUTE_MS).filter((candidate) => {
      const parts = zonedParts(candidate, timeZone);
      return parts?.year === date.year && parts.month === date.month && parts.day === date.day && parts.hour === hour && parts.minute === minute;
    }).sort((left, right) => left - right);
    const unique = [...new Set(alternatives)];
    if (!unique.length) return { ok: false, reason: 'nonexistentLocalTime', epochMs: null, ambiguous: false, alternatives: [] };
    return { ok: true, reason: '', epochMs: unique[0], ambiguous: unique.length > 1, alternatives: unique };
  }

  function dateKeyInTimeZone(now, timeZone = DEFAULT_TIME_ZONE) {
    const epochMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const parts = zonedParts(epochMs, timeZone);
    return parts ? formatDateKey(parts.year, parts.month, parts.day) : null;
  }

  function slotInterval(slot = {}, options = {}) {
    const timeZone = options.timeZone || projectTimeZone(options.project);
    const endDate = slotEndDate(slot);
    const startMinutes = timeToMinutes(slot.startTime);
    const endMinutes = timeToMinutes(slot.endTime);
    if (!isValidDateKey(slot.date) || !isValidDateKey(endDate) || startMinutes == null || endMinutes == null || endDate < slot.date || (endDate === slot.date && endMinutes <= startMinutes)) {
      const reason = !isValidDateKey(slot.date) ? 'invalidDate'
        : !isValidDateKey(endDate) ? 'invalidEndDate'
          : endDate < slot.date ? 'invalidDateRange'
            : startMinutes == null || endMinutes == null ? 'invalidTime'
              : 'invalidTimeRange';
      return { ok: false, reason, timeZone, startMs: null, endMs: null, wallDurationMinutes: null, elapsedMinutes: null };
    }
    const startDate = dateParts(slot.date);
    const finishDate = dateParts(endDate);
    const daySpan = Math.round((utcDateMs(finishDate.year, finishDate.month, finishDate.day) - utcDateMs(startDate.year, startDate.month, startDate.day)) / DAY_MS);
    const wallDurationMinutes = daySpan * 24 * 60 + endMinutes - startMinutes;
    const start = zonedDateTimeToEpoch(slot.date, slot.startTime, timeZone);
    const end = zonedDateTimeToEpoch(endDate, slot.endTime, timeZone);
    if (!start.ok || !end.ok || end.epochMs <= start.epochMs) {
      return { ok: false, reason: !start.ok ? start.reason : !end.ok ? end.reason : 'invalidElapsedRange', timeZone, startMs: null, endMs: null, wallDurationMinutes, elapsedMinutes: null };
    }
    return {
      ok: true,
      reason: '',
      timeZone,
      startMs: start.epochMs,
      endMs: end.epochMs,
      wallDurationMinutes,
      elapsedMinutes: (end.epochMs - start.epochMs) / MINUTE_MS,
      ambiguous: start.ambiguous || end.ambiguous
    };
  }

  function classifySlot(slot = {}, options = {}) {
    const interval = slotInterval(slot, options);
    const nowMs = options.now instanceof Date ? options.now.getTime() : options.now == null ? Date.now() : new Date(options.now).getTime();
    const imminentMinutes = options.imminentMinutes == null ? 24 * 60 : Number(options.imminentMinutes);
    if (!interval.ok || !Number.isFinite(nowMs) || !Number.isFinite(imminentMinutes) || imminentMinutes < 0) {
      return { ...interval, status: 'invalid', nowMs: Number.isFinite(nowMs) ? nowMs : null, minutesUntilStart: null };
    }
    let status;
    if (nowMs >= interval.endMs) status = 'past';
    else if (nowMs >= interval.startMs) status = 'live';
    else if (interval.startMs - nowMs <= imminentMinutes * MINUTE_MS) status = 'imminent';
    else status = 'upcoming';
    return { ...interval, status, nowMs, minutesUntilStart: (interval.startMs - nowMs) / MINUTE_MS };
  }

  function sortSlots(slots = [], options = {}) {
    return (Array.isArray(slots) ? slots : []).map((slot, index) => ({ slot, index, interval: slotInterval(slot, options) })).sort((left, right) => {
      if (left.interval.ok !== right.interval.ok) return left.interval.ok ? -1 : 1;
      if (left.interval.ok && left.interval.startMs !== right.interval.startMs) return left.interval.startMs - right.interval.startMs;
      if (left.interval.ok && left.interval.endMs !== right.interval.endMs) return left.interval.endMs - right.interval.endMs;
      return left.index - right.index;
    }).map((item) => item.slot);
  }

  function initialAnchorMonth(slots = [], options = {}) {
    const timeZone = options.timeZone || projectTimeZone(options.project);
    const nowValue = options.now == null ? Date.now() : options.now;
    const today = dateKeyInTimeZone(nowValue, timeZone);
    if (!today) return null;
    const validDates = (Array.isArray(slots) ? slots : []).filter((slot) => slotInterval(slot, { timeZone }).ok).map((slot) => slot.date).sort();
    const currentMonth = today.slice(0, 7);
    if (validDates.some((date) => date.slice(0, 7) === currentMonth)) return `${currentMonth}-01`;
    const next = validDates.find((date) => date >= today);
    if (next) return `${next.slice(0, 7)}-01`;
    const previous = validDates.at(-1);
    return previous ? `${previous.slice(0, 7)}-01` : `${currentMonth}-01`;
  }

  return {
    DAY_MS,
    MINUTE_MS,
    isValidDateKey,
    timeToMinutes,
    minutesToTime,
    durationMinutes,
    addDays,
    compareDateKeys,
    orderedDateRange,
    slotEndDate,
    slotOccursOnDate,
    offsetDateTime,
    weekRange,
    monthGrid,
    validTimeZone,
    projectTimeZone,
    zonedDateTimeToEpoch,
    dateKeyInTimeZone,
    slotInterval,
    classifySlot,
    sortSlots,
    initialAnchorMonth
  };
});
