(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CMOEExtensions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MANIFEST_FORMAT = 'cmoe-extension-manifest';
  const API_VERSION = 1;
  const ALLOWED_PERMISSIONS = new Set(['projects:read', 'projects:write', 'people:read', 'people:write', 'schedule:read', 'schedule:write', 'files:read', 'files:write', 'network:google', 'network:zoom']);
  const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'email', 'tel', 'select', 'checkbox']);

  function normalizeDeclarative(input) {
    if (!input || typeof input !== 'object') return null;
    const fields = (Array.isArray(input.fields) ? input.fields : []).slice(0, 80).map((field, index) => {
      const id = String(field.id || `field${index + 1}`).trim();
      if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error(`올바르지 않은 선언형 필드 ID: ${id}`);
      const type = FIELD_TYPES.has(field.type) ? field.type : 'text';
      return {
        id,
        label: String(field.label || id).trim().slice(0, 80),
        type,
        required: Boolean(field.required),
        placeholder: String(field.placeholder || '').slice(0, 160),
        options: type === 'select' ? (Array.isArray(field.options) ? field.options : []).slice(0, 100).map(String) : []
      };
    });
    return { title: String(input.title || '').trim().slice(0, 100), description: String(input.description || '').trim().slice(0, 500), fields };
  }

  function normalizeManifest(input = {}) {
    const id = String(input.id || '').trim();
    const version = String(input.version || '').trim();
    const name = String(input.name || '').trim();
    if (input.format !== MANIFEST_FORMAT) throw new Error('CMOE 확장 manifest 형식이 아닙니다.');
    if (Number(input.apiVersion) !== API_VERSION) throw new Error(`지원하지 않는 확장 API 버전입니다: ${input.apiVersion}`);
    if (!/^[a-z][a-zA-Z0-9.-]{1,63}$/.test(id)) throw new Error('확장 ID 형식이 올바르지 않습니다.');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('확장 버전은 SemVer 형식이어야 합니다.');
    if (!name) throw new Error('확장 이름이 필요합니다.');
    const permissions = [...new Set(Array.isArray(input.permissions) ? input.permissions.map(String) : [])];
    const unknown = permissions.filter((permission) => !ALLOWED_PERMISSIONS.has(permission));
    if (unknown.length) throw new Error(`허용되지 않은 확장 권한: ${unknown.join(', ')}`);
    return {
      format: MANIFEST_FORMAT,
      apiVersion: API_VERSION,
      id,
      version,
      name,
      shortName: String(input.shortName || name).trim(),
      description: String(input.description || '').trim(),
      category: String(input.category || 'utility').trim(),
      accent: String(input.accent || 'slate').trim(),
      icon: String(input.icon || name.slice(0, 1)).trim().slice(0, 2),
      core: Boolean(input.core),
      bundled: Boolean(input.bundled),
      permissions,
      contributes: {
        workflow: Boolean(input.contributes?.workflow || input.declarative),
        page: String(input.contributes?.page || (input.declarative ? 'declarative' : '')).trim(),
        order: Number.isFinite(Number(input.contributes?.order)) ? Number(input.contributes.order) : 999
      },
      declarative: normalizeDeclarative(input.declarative)
    };
  }

  function compareVersions(a, b) {
    const left = String(a).split(/[.-]/).slice(0, 3).map(Number);
    const right = String(b).split(/[.-]/).slice(0, 3).map(Number);
    for (let index = 0; index < 3; index += 1) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
    return 0;
  }

  function buildRegistry(manifests = []) {
    const byId = new Map();
    manifests.map(normalizeManifest).forEach((manifest) => {
      const current = byId.get(manifest.id);
      if (!current || compareVersions(current.version, manifest.version) < 0) byId.set(manifest.id, manifest);
    });
    return [...byId.values()].sort((a, b) => a.contributes.order - b.contributes.order || a.name.localeCompare(b.name, 'ko'));
  }

  return { MANIFEST_FORMAT, API_VERSION, ALLOWED_PERMISSIONS: [...ALLOWED_PERMISSIONS], FIELD_TYPES: [...FIELD_TYPES], normalizeManifest, compareVersions, buildRegistry };
});
