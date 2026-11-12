(function exposeCertificateRosterCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CertificateRosterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const STATUS_LABELS = { active: '진행 중', paused: '일시정지', completed: '완료', archived: '보관됨' };
  const TYPE_ALIASES = {
    name: ['이름', '성명', '참가자', '참여자', '수강생', '대상자', '고객명', 'name', 'person'],
    email: ['이메일', '메일', '전자우편', 'email', 'e-mail'],
    phone: ['전화번호', '휴대폰', '연락처', '전화', 'phone', 'mobile'],
    group: ['그룹', '분류', '소속', '조', '팀', '과정', 'group', 'team'],
    id: ['아이디', '번호', '사번', '학번', 'id']
  };

  function text(value) { return String(value ?? ''); }
  function cleanId(value) { return text(value).trim().slice(0, 200); }
  function normalizedLabel(value) {
    return text(value).normalize('NFKC').trim().toLocaleLowerCase('ko-KR').replace(/[\s_.·・()\[\]{}\-/:]+/g, '');
  }

  function columnType(column) {
    const explicit = cleanId(column?.type || column?.workspaceType).toLowerCase();
    if (TYPE_ALIASES[explicit]) return explicit;
    const label = normalizedLabel(column?.name);
    return Object.entries(TYPE_ALIASES).find(([, aliases]) => aliases.some((alias) => normalizedLabel(alias) === label))?.[0] || 'text';
  }

  function sourceColumns(columns = []) {
    const seen = new Set();
    return (Array.isArray(columns) ? columns : []).map((column, index) => {
      const id = cleanId(column?.id) || `column-${index + 1}`;
      return { id, name: text(column?.name).trim() || `컬럼${index + 1}`, type: columnType(column) };
    }).filter((column) => column.id && !seen.has(column.id) && seen.add(column.id));
  }

  function activePeople(people = []) {
    return (Array.isArray(people) ? people : []).filter((person) => person?.active !== false).slice().sort((a, b) => Number(a?.sourceOrder ?? 0) - Number(b?.sourceOrder ?? 0));
  }

  function valueFor(person, column) {
    const stored = person?.values && typeof person.values === 'object' ? person.values[column.id] : undefined;
    if (stored !== undefined && stored !== null && text(stored).length) return text(stored);
    return ['name', 'email', 'phone', 'group'].includes(column.type) ? text(person?.[column.type]) : text(stored);
  }

  // A deterministic change token, not an authentication primitive. It lets the
  // picker reject a source that changed between mapping and the final read.
  function rosterVersion(columns, people) {
    const compact = JSON.stringify({
      columns: sourceColumns(columns),
      people: (Array.isArray(people) ? people : []).map((person) => [
        Number(person?.sourceOrder ?? 0), person?.active !== false,
        sourceColumns(columns).map((column) => valueFor(person, column))
      ])
    });
    let first = 0x811c9dc5; let second = 0x9e3779b9;
    for (let index = 0; index < compact.length; index += 1) {
      const code = compact.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
    return `${first.toString(36)}${second.toString(36)}`;
  }

  function sourceMetadata(kind, source, options = {}) {
    const columns = sourceColumns(kind === 'project' ? source?.data?.columns : source?.columns);
    const people = kind === 'project' ? source?.data?.people : source?.people;
    const activeCount = activePeople(people).length;
    const totalCount = Array.isArray(people) ? people.length : 0;
    return {
      key: `${kind}:${cleanId(source?.id)}`,
      kind,
      id: cleanId(source?.id),
      name: text(source?.name).trim() || (kind === 'project' ? '이름 없는 프로젝트' : '이름 없는 저장 명단'),
      client: kind === 'project' ? text(source?.client).trim() : '',
      rosterName: kind === 'project' ? text(source?.data?.rosterName).trim() : '',
      status: kind === 'project' ? (STATUS_LABELS[source?.status] ? source.status : 'active') : 'saved',
      statusLabel: kind === 'project' ? (STATUS_LABELS[source?.status] || STATUS_LABELS.active) : '저장 명단',
      current: kind === 'project' && cleanId(source?.id) === cleanId(options.currentProjectId),
      activeCount,
      totalCount,
      inactiveCount: Math.max(0, totalCount - activeCount),
      updatedAt: kind === 'project' ? (source?.updatedAt || source?.createdAt || '') : (source?.updatedAt || source?.savedAt || ''),
      columns,
      version: rosterVersion(columns, people)
    };
  }

  function buildCatalog(state = {}) {
    const currentProjectId = cleanId(state?.activeProjectId);
    const projects = (Array.isArray(state?.projects) ? state.projects : [])
      .map((project) => sourceMetadata('project', project, { currentProjectId }))
      .sort((a, b) => Number(b.current) - Number(a.current) || Number(a.status === 'archived') - Number(b.status === 'archived') || text(b.updatedAt).localeCompare(text(a.updatedAt)));
    const saved = (Array.isArray(state?.library?.rosters) ? state.library.rosters : [])
      .map((roster) => sourceMetadata('saved', roster))
      .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
    return { currentProjectId, projects, saved };
  }

  function findSource(state, kind, id) {
    if (kind === 'project') return (state?.projects || []).find((project) => cleanId(project?.id) === id) || null;
    if (kind === 'saved') return (state?.library?.rosters || []).find((roster) => cleanId(roster?.id) === id) || null;
    return null;
  }

  function readForCertificate(state = {}, payload = {}) {
    const kind = payload?.kind === 'project' ? 'project' : payload?.kind === 'saved' ? 'saved' : '';
    const id = cleanId(payload?.id);
    if (!kind || !id || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('가져올 명단 정보가 올바르지 않습니다.');
    const source = findSource(state, kind, id);
    if (!source) throw new Error('선택한 명단을 찾지 못했습니다. 목록을 새로 열어주세요.');
    const metadata = sourceMetadata(kind, source, { currentProjectId: state?.activeProjectId });
    if (payload.expectedVersion && cleanId(payload.expectedVersion) !== metadata.version) {
      const error = new Error('선택한 명단이 방금 변경되었습니다. 최신 내용을 다시 확인해주세요.');
      error.code = 'ROSTER_SOURCE_CHANGED';
      throw error;
    }
    const requestedIds = [...new Set((Array.isArray(payload.columnIds) ? payload.columnIds : []).map(cleanId).filter(Boolean))];
    if (!requestedIds.length || requestedIds.length > 80) throw new Error('가져올 명단 열을 1개 이상 선택해주세요.');
    const allowed = new Map(metadata.columns.map((column) => [column.id, column]));
    if (requestedIds.some((columnId) => !allowed.has(columnId))) throw new Error('명단에서 선택한 열을 찾지 못했습니다. 매핑을 다시 확인해주세요.');
    const selectedColumns = requestedIds.map((columnId) => allowed.get(columnId));
    const people = activePeople(kind === 'project' ? source?.data?.people : source?.people).slice(0, 2000);
    if (!people.length) throw new Error('선택한 명단에 사용 중인 사람이 없습니다.');
    const rows = people.map((person) => Object.fromEntries(selectedColumns.map((column) => [column.id, valueFor(person, column).slice(0, 4000)])));
    return { source: metadata, columns: selectedColumns, rows, truncated: metadata.activeCount > rows.length };
  }

  function inferredTypeForField(field) {
    const label = normalizedLabel(field?.label);
    return Object.entries(TYPE_ALIASES).find(([, aliases]) => aliases.some((alias) => {
      const token = normalizedLabel(alias);
      return label === token || (token.length >= 2 && label.includes(token));
    }))?.[0] || '';
  }

  function suggestMappings(fields = [], columns = []) {
    const safeColumns = sourceColumns(columns);
    return (Array.isArray(fields) ? fields : []).map((field) => {
      const label = normalizedLabel(field?.label);
      const exact = safeColumns.filter((column) => normalizedLabel(column.name) === label);
      if (label && exact.length === 1) return exact[0].id;
      const inferredType = inferredTypeForField(field);
      const byType = inferredType ? safeColumns.filter((column) => column.type === inferredType) : [];
      return byType.length === 1 ? byType[0].id : '';
    });
  }

  function mapRows(fields = [], mappings = [], rows = []) {
    const safeFields = Array.isArray(fields) ? fields : [];
    return (Array.isArray(rows) ? rows : []).slice(0, 2000).map((row) => ({
      values: safeFields.map((_field, index) => {
        const columnId = cleanId(mappings[index]);
        return columnId ? text(row?.[columnId]).slice(0, 4000) : '';
      })
    }));
  }

  return { STATUS_LABELS, normalizedLabel, sourceColumns, rosterVersion, buildCatalog, readForCertificate, suggestMappings, mapRows };
});
