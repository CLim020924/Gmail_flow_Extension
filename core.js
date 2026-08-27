(function attachGmailFlowCore(globalScope) {
  const VARIABLE_PATTERN = /\{([^{}\r\n]+)\}/g;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const GMAIL_FLOW_ROW_ID_KEY = '__gmailFlowRowId';

  const cleanText = (value) => String(value ?? '').trim();
  const usableColumns = (columns) => (columns || []).filter((column) => column.role !== 'excluded' && cleanText(column.name));
  const activeRows = (rows, columns) => {
    const columnIds = Array.isArray(columns)
      ? new Set(columns.map((column) => cleanText(column?.id)).filter(Boolean))
      : null;
    return (rows || []).filter((row) => Object.entries(row || {})
      .some(([key, value]) => !key.startsWith('__') && (!columnIds || columnIds.has(key)) && cleanText(value)));
  };

  function getVariableNames(columns) {
    return usableColumns(columns).map((column) => cleanText(column.name));
  }

  function extractVariables(...texts) {
    const found = [];
    texts.forEach((text) => {
      for (const match of String(text ?? '').matchAll(VARIABLE_PATTERN)) {
        const name = cleanText(match[1]);
        if (name && !found.includes(name)) found.push(name);
      }
    });
    return found;
  }

  function createVariableMap(columns, row) {
    const variables = {};
    usableColumns(columns).forEach((column) => {
      const name = cleanText(column.name);
      if (!(name in variables)) variables[name] = String(row?.[column.id] ?? '');
    });
    return variables;
  }

  function renderText(text, variables) {
    return String(text ?? '').replace(VARIABLE_PATTERN, (source, rawName) => {
      const name = cleanText(rawName);
      return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : source;
    });
  }

  function isValidEmail(value) {
    return EMAIL_PATTERN.test(cleanText(value));
  }

  function getEmailColumns(columns) {
    const explicit = (columns || []).filter((column) => column.role === 'email');
    if (explicit.length) return explicit;
    const inferred = usableColumns(columns).filter((column) => /^(이메일|메일|email|e-mail|email address)$/i.test(cleanText(column.name)));
    return inferred.length === 1 ? inferred : [];
  }

  function validateLabel(label) {
    const normalized = String(label ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) return { normalized: '', error: '' };
    if (normalized.length > 50) return { normalized, error: '라벨은 50자 이하여야 합니다.' };
    if (/[\[\]\/]/.test(normalized)) return { normalized, error: '라벨에는 [, ], / 문자를 사용할 수 없습니다.' };
    return { normalized, error: '' };
  }

  function validateCompose(input) {
    const columns = input.columns || [];
    const rows = activeRows(input.rows, columns);
    const method = input.method || '임시 저장';
    const errors = [];
    const variableNames = getVariableNames(columns);
    const duplicateVariables = variableNames.filter((name, index) => variableNames.indexOf(name) !== index);
    if (duplicateVariables.length) errors.push(`중복된 컬럼 이름이 있습니다: ${[...new Set(duplicateVariables)].join(', ')}`);

    const requestedVariables = extractVariables(input.subject, input.body, input.postscript);
    const unknownVariables = requestedVariables.filter((name) => !variableNames.includes(name));
    if (unknownVariables.length) errors.push(`명단에 없는 변수가 있습니다: ${unknownVariables.map((name) => `{${name}}`).join(', ')}`);

    const labelResult = validateLabel(method === '즉시 발송' ? '' : input.label);
    if (labelResult.error) errors.push(labelResult.error);

    const emailColumns = getEmailColumns(columns);
    if (emailColumns.length > 1) errors.push('수신 이메일 역할은 하나의 컬럼에만 지정해야 합니다.');
    if (method !== '임시 저장' && emailColumns.length === 0) errors.push('수신 이메일 역할로 지정된 컬럼이 필요합니다.');

    if (method !== '임시 저장') {
      if (!cleanText(input.subject)) errors.push('제목을 입력해야 합니다.');
      if (!cleanText(input.body)) errors.push('내용을 입력해야 합니다.');
    }

    const emailColumn = emailColumns.length === 1 ? emailColumns[0] : null;
    if (emailColumn) {
      const emails = rows.map((row) => cleanText(row[emailColumn.id]).toLowerCase());
      if (method !== '임시 저장') {
        const missingRows = emails.reduce((list, email, index) => (!email ? [...list, index + 1] : list), []);
        if (missingRows.length) errors.push(`이메일이 비어 있는 데이터 행: ${missingRows.join(', ')}`);
      }
      const invalidRows = emails.reduce((list, email, index) => (email && !isValidEmail(email) ? [...list, index + 1] : list), []);
      if (invalidRows.length) errors.push(`이메일 형식이 잘못된 데이터 행: ${invalidRows.join(', ')}`);
      const duplicates = emails.filter((email, index) => email && emails.indexOf(email) !== index);
      if (duplicates.length) errors.push(`중복 이메일이 있습니다: ${[...new Set(duplicates)].join(', ')}`);
    }

    if (method === '예약 발송') {
      const scheduledAt = new Date(`${input.scheduleDate || ''}T${input.scheduleTime || ''}`);
      if (!input.scheduleDate || !input.scheduleTime || Number.isNaN(scheduledAt.getTime())) errors.push('예약 날짜와 시간을 올바르게 입력해야 합니다.');
      else if (scheduledAt.getTime() <= Date.now()) errors.push('예약 시간은 현재보다 미래여야 합니다.');
    }

    const emptyCount = input.emptyDraftEnabled ? Math.max(0, Number(input.emptyDraftCount) || 0) : 0;
    if (method === '임시 저장' && rows.length + emptyCount === 0) errors.push('명단을 입력하거나 빈 초안 생성 개수를 지정해주세요.');
    if (method !== '임시 저장' && rows.length === 0) errors.push('발송할 명단 데이터가 없습니다.');

    return { valid: errors.length === 0, errors, rows, emailColumns, variableNames, normalizedLabel: labelResult.normalized };
  }

  function createWorkItems(input) {
    const validation = validateCompose(input);
    const emailColumn = validation.emailColumns[0];
    const bodyTemplate = [String(input.body || '').trim(), String(input.postscript || '').trim()].filter(Boolean).join('\n\n');
    const items = validation.rows.map((row, index) => {
      const variables = createVariableMap(input.columns, row);
      const email = emailColumn ? cleanText(row[emailColumn.id]).toLowerCase() : '';
      return {
        id: `roster-${index + 1}`,
        type: 'roster',
        rowNumber: index + 1,
        email,
        variables,
        subject: renderText(input.subject, variables),
        body: renderText(bodyTemplate, variables)
      };
    });

    const emptyCount = input.method === '임시 저장' && input.emptyDraftEnabled
      ? Math.max(0, Number(input.emptyDraftCount) || 0)
      : 0;
    const blankVariables = Object.fromEntries(validation.variableNames.map((name) => [name, '']));
    for (let index = 0; index < emptyCount; index += 1) {
      items.push({
        id: `blank-${index + 1}`,
        type: 'blank',
        rowNumber: null,
        email: '',
        variables: { ...blankVariables },
        subject: renderText(input.subject, blankVariables),
        body: renderText(bodyTemplate, blankVariables)
      });
    }
    return { validation, items };
  }

  function createSyncRevisionTracker() {
    let revision = 0;
    let dirty = false;
    return {
      markDirty() {
        revision += 1;
        dirty = true;
        return revision;
      },
      capture() { return revision; },
      markUploaded(uploadedRevision) {
        dirty = revision !== uploadedRevision;
        return !dirty;
      },
      clear() { dirty = false; },
      get dirty() { return dirty; }
    };
  }

  const MISSING = Symbol('missing');

  function cloneStorageValue(value) {
    if (value === MISSING || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cloneStorageValue);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneStorageValue(entry)]));
  }

  function storageValuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (left === MISSING || right === MISSING || left == null || right == null) return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left)
        && Array.isArray(right)
        && left.length === right.length
        && left.every((entry, index) => storageValuesEqual(entry, right[index]));
    }
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && storageValuesEqual(left[key], right[key]));
  }

  function storageEntryIdentity(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
    if (cleanText(entry.id)) return `id:${String(entry.id)}`;
    if (cleanText(entry[GMAIL_FLOW_ROW_ID_KEY])) return `gmail-row:${String(entry[GMAIL_FLOW_ROW_ID_KEY])}`;
    if (cleanText(entry.__workspacePersonId)) return `workspace-person:${String(entry.__workspacePersonId)}`;
    return '';
  }

  function canMergeByIdentity(...collections) {
    const entries = collections.flatMap((collection) => Array.isArray(collection) ? collection : []);
    if (!entries.length) return false;
    return entries.every((entry) => storageEntryIdentity(entry))
      && collections.every((collection) => {
        if (!Array.isArray(collection)) return true;
        const ids = collection.map(storageEntryIdentity);
        return new Set(ids).size === ids.length;
      });
  }

  function stableStorageHash(value) {
    const canonicalize = (entry) => {
      if (Array.isArray(entry)) return entry.map(canonicalize);
      if (!entry || typeof entry !== 'object') return entry;
      return Object.fromEntries(Object.keys(entry)
        .filter((key) => !key.startsWith('__'))
        .sort()
        .map((key) => [key, canonicalize(entry[key])]));
    };
    const text = JSON.stringify(canonicalize(value));
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeRosterRows(rows, scope) {
    if (!Array.isArray(rows)) return rows;
    return rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || cleanText(row[GMAIL_FLOW_ROW_ID_KEY])) {
        return cloneStorageValue(row);
      }
      return {
        ...cloneStorageValue(row),
        [GMAIL_FLOW_ROW_ID_KEY]: `legacy-${stableStorageHash({ scope, index, row })}`
      };
    });
  }

  function normalizeCloudStorageValue(key, value) {
    const normalized = cloneStorageValue(value);
    if (key === 'workspaceDraft' && normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
      normalized.rows = normalizeRosterRows(normalized.rows, 'workspaceDraft');
    } else if (key === 'savedRosters' && Array.isArray(normalized)) {
      normalized.forEach((roster, rosterIndex) => {
        if (!roster || typeof roster !== 'object' || Array.isArray(roster)) return;
        roster.rows = normalizeRosterRows(roster.rows, `savedRoster:${cleanText(roster.id) || rosterIndex}`);
      });
    }
    return normalized;
  }

  function mergeStorageValue(base, localValue, latestValue) {
    if (storageValuesEqual(localValue, base)) return cloneStorageValue(latestValue);
    if (storageValuesEqual(latestValue, base) || storageValuesEqual(localValue, latestValue)) return cloneStorageValue(localValue);

    if (localValue === MISSING) return cloneStorageValue(latestValue);
    if (latestValue === MISSING) return cloneStorageValue(localValue);

    if (Array.isArray(localValue) && Array.isArray(latestValue)) {
      const baseArray = Array.isArray(base) ? base : [];
      if (canMergeByIdentity(baseArray, localValue, latestValue)) {
        const baseById = new Map(baseArray.map((entry) => [storageEntryIdentity(entry), entry]));
        const localById = new Map(localValue.map((entry) => [storageEntryIdentity(entry), entry]));
        const latestById = new Map(latestValue.map((entry) => [storageEntryIdentity(entry), entry]));
        const ids = [...new Set([
          ...localValue.map(storageEntryIdentity),
          ...latestValue.map(storageEntryIdentity),
          ...baseArray.map(storageEntryIdentity)
        ])];
        return ids.flatMap((id) => {
          const merged = mergeStorageValue(
            baseById.has(id) ? baseById.get(id) : MISSING,
            localById.has(id) ? localById.get(id) : MISSING,
            latestById.has(id) ? latestById.get(id) : MISSING
          );
          return merged === MISSING ? [] : [merged];
        });
      }

      const length = Math.max(Array.isArray(base) ? base.length : 0, localValue.length, latestValue.length);
      return Array.from({ length }, (_, index) => mergeStorageValue(
        Array.isArray(base) && index < base.length ? base[index] : MISSING,
        index < localValue.length ? localValue[index] : MISSING,
        index < latestValue.length ? latestValue[index] : MISSING
      )).filter((entry) => entry !== MISSING);
    }

    const localIsObject = localValue && typeof localValue === 'object' && !Array.isArray(localValue);
    const latestIsObject = latestValue && typeof latestValue === 'object' && !Array.isArray(latestValue);
    if (localIsObject && latestIsObject) {
      const baseObject = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
      const keys = new Set([...Object.keys(baseObject), ...Object.keys(localValue), ...Object.keys(latestValue)]);
      const merged = {};
      keys.forEach((key) => {
        const value = mergeStorageValue(
          Object.prototype.hasOwnProperty.call(baseObject, key) ? baseObject[key] : MISSING,
          Object.prototype.hasOwnProperty.call(localValue, key) ? localValue[key] : MISSING,
          Object.prototype.hasOwnProperty.call(latestValue, key) ? latestValue[key] : MISSING
        );
        if (value !== MISSING) merged[key] = value;
      });
      return merged;
    }

    // Both windows changed the same scalar. The current window's explicit edit wins;
    // unchanged stale fields have already selected latestValue above.
    return cloneStorageValue(localValue);
  }

  function mergeCloudStorageValue(key, baseline, localValue, latestValue) {
    if (!['savedRosters', 'templates', 'structureTemplates', 'workspaceDraft'].includes(key)) {
      throw new Error(`Unsupported cloud storage key: ${key}`);
    }
    return mergeStorageValue(baseline, localValue, latestValue);
  }

  const api = { activeRows, createSyncRevisionTracker, createVariableMap, createWorkItems, extractVariables, getVariableNames, isValidEmail, mergeCloudStorageValue, normalizeCloudStorageValue, renderText, validateCompose, validateLabel };
  globalScope.GmailFlowCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
