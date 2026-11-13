const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PRODUCT = 'cmoe-workspace';

function safeBackupRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))) throw new Error('업데이트 백업 항목 경로가 올바르지 않습니다.');
  return normalized;
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(String(value || ''))) throw new Error('업데이트 버전 형식이 올바르지 않습니다.');
}

async function createUpdateDataBackup({ version, backupRoot, entries = [] }) {
  assertVersion(version);
  if (!path.isAbsolute(String(backupRoot || ''))) throw new Error('업데이트 백업 위치가 올바르지 않습니다.');
  const normalizedEntries = entries.map((entry) => ({ source: path.resolve(String(entry?.source || '')), relativePath: safeBackupRelativePath(entry?.relativePath) }));
  if (!normalizedEntries.length) throw new Error('보존할 사용자 데이터 항목이 없습니다.');
  for (const entry of normalizedEntries) {
    if (!path.isAbsolute(entry.source) || pathInside(entry.source, backupRoot) || pathInside(backupRoot, entry.source)) throw new Error('사용자 데이터와 백업 위치가 서로 겹칩니다.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotName = `before-${version}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotPath = path.join(path.resolve(backupRoot), snapshotName);
  await fs.promises.mkdir(path.resolve(backupRoot), { recursive: true });
  await fs.promises.mkdir(snapshotPath, { recursive: false });
  const copied = [];
  for (const entry of normalizedEntries) {
    let stat;
    try { stat = await fs.promises.lstat(entry.source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('링크로 연결된 사용자 데이터는 업데이트 백업에 사용할 수 없습니다.');
    const destination = path.join(snapshotPath, ...entry.relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (stat.isDirectory()) {
      await fs.promises.cp(entry.source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        preserveTimestamps: true,
        filter: async (source) => !(await fs.promises.lstat(source)).isSymbolicLink()
      });
    } else if (stat.isFile()) await fs.promises.copyFile(entry.source, destination, fs.constants.COPYFILE_EXCL);
    else continue;
    copied.push(entry.relativePath);
  }
  if (!copied.length) throw new Error('보존할 사용자 데이터를 찾지 못해 업데이트를 중단했습니다.');
  await fs.promises.writeFile(path.join(snapshotPath, 'backup-manifest.json'), `${JSON.stringify({ schemaVersion: 1, product: PRODUCT, beforeVersion: version, createdAt: new Date().toISOString(), entries: copied }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { snapshotPath, entries: copied };
}

module.exports = { PRODUCT, createUpdateDataBackup, safeBackupRelativePath, pathInside };
