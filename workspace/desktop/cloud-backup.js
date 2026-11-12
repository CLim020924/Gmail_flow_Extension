const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'cmoe-workspace-cloud-backup';
const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const ALLOWED_FILE_ROOTS = new Set(['extensions', 'document-templates']);
const GMAIL_KEYS = ['savedRosters', 'templates', 'structureTemplates', 'workspaceDraft', 'mailBatches', 'mailBatchCancelRequests'];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (!normalized || parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error('Drive 백업 파일 경로가 올바르지 않습니다.');
  }
  return normalized;
}

async function collectDirectoryFiles(sourceRoot, archiveRoot, files, totals) {
  let entries;
  try { entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('링크로 연결된 파일은 Drive 백업에 포함하지 않습니다.');
    const source = path.join(sourceRoot, entry.name);
    const relative = safeRelativePath(`${archiveRoot}/${entry.name}`);
    if (entry.isDirectory()) await collectDirectoryFiles(source, relative, files, totals);
    else if (entry.isFile()) {
      const stat = await fs.promises.stat(source);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Drive 백업 파일이 50MB를 넘습니다: ${relative}`);
      totals.bytes += stat.size;
      if (totals.bytes > MAX_TOTAL_BYTES) throw new Error('Drive 백업 파일 합계가 120MB를 넘습니다. 큰 템플릿 파일을 정리한 뒤 다시 시도해주세요.');
      const data = await fs.promises.readFile(source);
      files.push({ path: relative, bytes: data.length, sha256: sha256(data), data: data.toString('base64') });
    }
  }
}

function safeGmailData(input = {}) {
  return Object.fromEntries(GMAIL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key)).map((key) => [key, clone(input[key])]));
}

async function createCloudBackupPayload({ version, workspaceState, gmailData = {}, documentProfiles = [], fileRoots = {} }) {
  if (!workspaceState || workspaceState.format !== 'cmoe-workspace') throw new Error('Workspace 자료 형식을 확인할 수 없어 Drive 백업을 만들지 않았습니다.');
  const files = [];
  const totals = { bytes: 0 };
  for (const [archiveRoot, sourceRoot] of Object.entries(fileRoots)) {
    if (!ALLOWED_FILE_ROOTS.has(archiveRoot) || !path.isAbsolute(String(sourceRoot || ''))) throw new Error('Drive 백업 대상 폴더가 올바르지 않습니다.');
    await collectDirectoryFiles(path.resolve(sourceRoot), archiveRoot, files, totals);
  }
  const payload = {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    appVersion: String(version || ''),
    createdAt: new Date().toISOString(),
    workspaceState: clone(workspaceState),
    gmailData: safeGmailData(gmailData),
    documentData: { certificateProfiles: clone(Array.isArray(documentProfiles) ? documentProfiles : []) },
    files
  };
  payload.digest = sha256(Buffer.from(JSON.stringify({ ...payload, digest: undefined }), 'utf8'));
  return payload;
}

function validateCloudBackupPayload(input) {
  if (!input || input.format !== FORMAT || Number(input.schemaVersion) !== SCHEMA_VERSION) throw new Error('지원하지 않는 Drive 백업 형식입니다.');
  if (!input.workspaceState || input.workspaceState.format !== 'cmoe-workspace') throw new Error('Drive 백업에 Workspace 자료가 없습니다.');
  if (!Array.isArray(input.files) || input.files.length > 20_000) throw new Error('Drive 백업 파일 목록이 올바르지 않습니다.');
  let total = 0;
  const seen = new Set();
  for (const file of input.files) {
    const relative = safeRelativePath(file?.path);
    const root = relative.split('/')[0];
    if (!ALLOWED_FILE_ROOTS.has(root) || seen.has(relative)) throw new Error('Drive 백업 파일 목록에 허용되지 않은 경로가 있습니다.');
    seen.add(relative);
    const data = Buffer.from(String(file.data || ''), 'base64');
    if (data.length !== Number(file.bytes) || data.length > MAX_FILE_BYTES || sha256(data) !== String(file.sha256 || '').toLowerCase()) throw new Error(`Drive 백업 파일 검증에 실패했습니다: ${relative}`);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Drive 백업 파일 합계가 허용 크기를 넘습니다.');
  }
  const expectedDigest = sha256(Buffer.from(JSON.stringify({ ...input, digest: undefined }), 'utf8'));
  if (String(input.digest || '').toLowerCase() !== expectedDigest) throw new Error('Drive 백업 전체 무결성 검증에 실패했습니다.');
  return input;
}

async function restoreCloudBackupFiles(input, targetRoots = {}) {
  const payload = validateCloudBackupPayload(input);
  const restored = [];
  for (const file of payload.files) {
    const relative = safeRelativePath(file.path);
    const [root, ...parts] = relative.split('/');
    const targetRoot = targetRoots[root];
    if (!path.isAbsolute(String(targetRoot || ''))) throw new Error('Drive 백업 복원 위치가 올바르지 않습니다.');
    const destination = path.resolve(targetRoot, ...parts);
    const base = path.resolve(targetRoot);
    const relation = path.relative(base, destination);
    if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new Error('Drive 백업 파일이 복원 폴더를 벗어납니다.');
    const data = Buffer.from(file.data, 'base64');
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}-${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, data, { flag: 'wx' });
    try {
      await fs.promises.copyFile(temporary, destination);
      const verified = await fs.promises.readFile(destination);
      if (sha256(verified) !== file.sha256) throw new Error(`Drive 백업 복원 검증에 실패했습니다: ${relative}`);
    } finally { await fs.promises.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    restored.push(relative);
  }
  return { restored };
}

module.exports = { FORMAT, GMAIL_KEYS, createCloudBackupPayload, restoreCloudBackupFiles, safeGmailData, validateCloudBackupPayload };
