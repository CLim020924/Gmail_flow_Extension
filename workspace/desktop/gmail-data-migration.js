const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_FILES = [
  'gmail-flow-data.json',
  'gmail-flow-data.json.bak'
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readSnapshot(rootPath) {
  const snapshot = new Map();
  for (const name of MIGRATION_FILES) {
    try {
      const data = await fs.promises.readFile(path.join(rootPath, name));
      const parsed = JSON.parse(data.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name}의 최상위 값이 객체가 아닙니다.`);
      snapshot.set(name, data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return snapshot;
}

function snapshotsEqual(first, second) {
  if (first.size !== second.size) return false;
  for (const [name, data] of first) if (!second.get(name)?.equals(data)) return false;
  return true;
}

async function readStableSnapshot(rootPath, { attempts = 6, settleMs = 75 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const first = await readSnapshot(rootPath);
    await wait(settleMs);
    const second = await readSnapshot(rootPath);
    if (snapshotsEqual(first, second)) return second;
  }
  const error = new Error('기존 Gmail Flow 데이터가 다른 프로세스에서 계속 변경되어 안전한 복사 시점을 찾지 못했습니다.');
  error.code = 'GMAIL_FLOW_MIGRATION_BUSY';
  throw error;
}

async function writeExclusiveFile(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(temporaryPath, data, { flag: 'wx' });
  try {
    try { await fs.promises.rename(temporaryPath, filePath); }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      try { await fs.promises.access(filePath); }
      catch (_) { throw error; }
    }
  } finally {
    try { await fs.promises.unlink(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function migrateLegacyGmailFlowData({ legacyRoot, targetRoot, attempts, settleMs }) {
  const source = path.resolve(legacyRoot);
  const target = path.resolve(targetRoot);
  if (source.toLowerCase() === target.toLowerCase()) return { status: 'same-directory', copied: [] };
  await fs.promises.mkdir(target, { recursive: true });
  const markerPath = path.join(target, '.legacy-gmail-flow-migration-v1.json');
  try { return JSON.parse(await fs.promises.readFile(markerPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const targetExisting = [];
  for (const name of MIGRATION_FILES) {
    try { await fs.promises.access(path.join(target, name)); targetExisting.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const snapshot = await readStableSnapshot(source, { attempts, settleMs });
  if (targetExisting.length) {
    const mismatched = [];
    for (const name of targetExisting) {
      const sourceData = snapshot.get(name);
      const targetData = await fs.promises.readFile(path.join(target, name));
      if (!sourceData?.equals(targetData)) mismatched.push(name);
    }
    if (mismatched.length) {
      const result = { status: 'skipped-existing-target', copied: [], existing: targetExisting, mismatched, migratedAt: new Date().toISOString() };
      await writeExclusiveFile(markerPath, JSON.stringify(result, null, 2));
      return result;
    }
  }
  const copied = [];
  for (const [name, data] of snapshot) {
    if (targetExisting.includes(name)) continue;
    await writeExclusiveFile(path.join(target, name), data);
    copied.push(name);
  }
  const result = { status: copied.length || targetExisting.length ? 'copied' : 'no-source', copied, resumed: targetExisting, migratedAt: new Date().toISOString() };
  await writeExclusiveFile(markerPath, JSON.stringify(result, null, 2));
  return result;
}

module.exports = { MIGRATION_FILES, readStableSnapshot, migrateLegacyGmailFlowData };
