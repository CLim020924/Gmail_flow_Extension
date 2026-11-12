const fs = require('node:fs');
const path = require('node:path');

function parseStorageObject(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Workspace 저장 파일의 최상위 값이 객체가 아닙니다.');
  return parsed;
}

function cloneStorageValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function temporaryPathFor(filePath, suffix = 'tmp') {
  return `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${suffix}`;
}

async function replaceWithoutDeletingLiveFile(sourcePath, targetPath) {
  try { await fs.promises.rename(sourcePath, targetPath); }
  catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
    const displacedPath = temporaryPathFor(targetPath, 'swap-old');
    let displaced = false;
    let replacementCommitted = false;
    try {
      try { await fs.promises.rename(targetPath, displacedPath); displaced = true; }
      catch (displaceError) { if (displaceError.code !== 'ENOENT') throw displaceError; }
      try {
        await fs.promises.rename(sourcePath, targetPath);
        replacementCommitted = true;
      } catch (replacementError) {
        if (displaced) {
          try { await fs.promises.rename(displacedPath, targetPath); displaced = false; }
          catch (rollbackError) {
            replacementError.rollbackError = rollbackError;
            replacementError.recoveryPath = displacedPath;
          }
        }
        throw replacementError;
      }
    } finally {
      if (replacementCommitted && displaced) {
        try { await fs.promises.unlink(displacedPath); }
        catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error('이전 Workspace 저장 파일 정리 실패:', cleanupError); }
      }
    }
  }
}

class JsonStorage {
  constructor(filePath, onChanged = () => {}) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.onChanged = onChanged;
    this.data = {};
    this.recoveredFromBackup = false;
    this.writeChain = Promise.resolve();
    this.load();
  }

  load() {
    let primaryError = null;
    try {
      this.data = parseStorageObject(fs.readFileSync(this.filePath, 'utf8'));
      return;
    } catch (error) {
      primaryError = error;
    }
    try {
      this.data = parseStorageObject(fs.readFileSync(this.backupPath, 'utf8'));
      this.recoveredFromBackup = true;
      console.error('Workspace 기본 저장 파일을 읽지 못해 안전 백업을 사용합니다:', primaryError);
      return;
    } catch (backupError) {
      if (primaryError?.code === 'ENOENT' && backupError.code === 'ENOENT') { this.data = {}; return; }
      const failure = new Error('Workspace 저장 파일과 안전 백업을 읽지 못했습니다. 원본 파일을 보존하기 위해 새 데이터로 덮어쓰지 않습니다.');
      failure.code = 'WORKSPACE_STORAGE_RECOVERY_FAILED';
      failure.cause = primaryError;
      failure.backupError = backupError;
      throw failure;
    }
  }

  async get(key, fallback = null) {
    return cloneStorageValue(Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback);
  }

  async set(key, value) {
    const committedValue = cloneStorageValue(value);
    const operation = this.writeChain.then(async () => {
      const oldValue = cloneStorageValue(this.data[key]);
      const nextData = { ...this.data, [key]: committedValue };
      await this.persist(nextData);
      this.data = nextData;
      this.onChanged({ [key]: { oldValue, newValue: cloneStorageValue(committedValue) } });
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async persist(data = this.data) {
    const snapshot = JSON.stringify(data, null, 2);
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = temporaryPathFor(this.filePath);
    await fs.promises.writeFile(temporaryPath, snapshot, 'utf8');
    try {
      let currentRaw = null;
      try {
        currentRaw = await fs.promises.readFile(this.filePath, 'utf8');
        parseStorageObject(currentRaw);
      } catch (error) {
        currentRaw = null;
        if (error.code !== 'ENOENT' && !this.recoveredFromBackup) throw error;
      }
      if (currentRaw != null) {
        const backupTemporaryPath = temporaryPathFor(this.backupPath);
        await fs.promises.writeFile(backupTemporaryPath, currentRaw, 'utf8');
        try { await replaceWithoutDeletingLiveFile(backupTemporaryPath, this.backupPath); }
        finally { try { await fs.promises.unlink(backupTemporaryPath); } catch (error) { if (error.code !== 'ENOENT') console.error('Workspace 백업 임시 파일 정리 실패:', error); } }
      }
      await replaceWithoutDeletingLiveFile(temporaryPath, this.filePath);
      this.recoveredFromBackup = false;
    } finally {
      try { await fs.promises.unlink(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') console.error('Workspace 저장 임시 파일 정리 실패:', error); }
    }
  }
}

module.exports = { JsonStorage };
