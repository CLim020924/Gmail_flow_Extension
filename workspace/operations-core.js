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

  function parseSlots(text) {
    const slots = [];
    const errors = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
      const value = clean(line);
      if (!value) return;
      const match = value.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})(?:\s+(.+))?$/);
      if (!match) { errors.push(`${index + 1}줄 형식을 확인해주세요: ${value}`); return; }
      const date = match[1].replace(/[/.]/g, '-').split('-').map((part, partIndex) => partIndex ? part.padStart(2, '0') : part).join('-');
      slots.push({ id: makeId('slot'), date, startTime: match[2].padStart(5, '0'), endTime: match[3].padStart(5, '0'), label: clean(match[4]), locked: false, status: 'draft' });
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
    const orderedSlots = (slots || []).slice().sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
    const orderedRoles = (roles || []).filter((role) => role.active !== false);
    const assignments = existingAssignments.filter((assignment) => assignment.locked || orderedSlots.find((slot) => slot.id === assignment.slotId)?.locked).map((item) => ({ ...item }));
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
      const personAssignments = assignments.filter((assignment) => assignment.personId === person.id);
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
    const entries = project.data.people.filter((person) => person.active !== false && person.email).map((person) => {
      const assignments = project.data.assignments.filter((assignment) => assignment.personId === person.id).map((assignment) => {
        const slot = project.data.slots.find((candidate) => candidate.id === assignment.slotId);
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
    parseSlots,
    slotKey,
    generateSchedule,
    validateAssignments,
    scheduleToCsv,
    scheduleToExcelXml,
    buildGoogleFormDefinition,
    googleFormsApiRequests,
    buildMailPackage,
    mailPackageToCsv
  };
});
