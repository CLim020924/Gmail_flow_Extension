(function attachGmailFlowCore(globalScope) {
  const VARIABLE_PATTERN = /\{([^{}\r\n]+)\}/g;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const cleanText = (value) => String(value ?? '').trim();
  const usableColumns = (columns) => (columns || []).filter((column) => column.role !== 'excluded' && cleanText(column.name));
  const activeRows = (rows) => (rows || []).filter((row) => Object.values(row || {}).some((value) => cleanText(value)));

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
    return (columns || []).filter((column) => column.role === 'email');
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
    const rows = activeRows(input.rows);
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

  const api = { activeRows, createVariableMap, createWorkItems, extractVariables, getVariableNames, isValidEmail, renderText, validateCompose, validateLabel };
  globalScope.GmailFlowCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
