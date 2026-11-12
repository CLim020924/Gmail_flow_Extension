const fs = require('node:fs');
const path = require('node:path');

function parseStorageObject(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Gmail Flow 저장 파일의 최상위 값이 객체가 아닙니다.');
  return parsed;
}

function cloneStorageValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function temporaryPathFor(filePath, suffix = 'tmp') {
  return `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${suffix}`;
}

function replaceWithoutDeletingLiveFile(sourcePath, targetPath) {
  try { fs.renameSync(sourcePath, targetPath); }
  catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
    const displacedPath = temporaryPathFor(targetPath, 'swap-old');
    let displaced = false;
    let replacementCommitted = false;
    try {
      try { fs.renameSync(targetPath, displacedPath); displaced = true; }
      catch (displaceError) { if (displaceError.code !== 'ENOENT') throw displaceError; }
      try {
        fs.renameSync(sourcePath, targetPath);
        replacementCommitted = true;
      } catch (replacementError) {
        if (displaced) {
          try { fs.renameSync(displacedPath, targetPath); displaced = false; }
          catch (rollbackError) {
            replacementError.rollbackError = rollbackError;
            replacementError.recoveryPath = displacedPath;
          }
        }
        throw replacementError;
      }
    } finally {
      if (replacementCommitted && displaced) {
        try { fs.unlinkSync(displacedPath); }
        catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error('이전 Gmail Flow 저장 파일 정리 실패:', cleanupError); }
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
      console.error('Gmail Flow 기본 저장 파일을 읽지 못해 안전 백업을 사용합니다:', primaryError);
      return;
    } catch (backupError) {
      if (primaryError?.code === 'ENOENT' && backupError.code === 'ENOENT') { this.data = {}; return; }
      const failure = new Error('Gmail Flow 저장 파일과 안전 백업을 읽지 못했습니다. 원본 파일을 보존하기 위해 새 데이터로 덮어쓰지 않습니다.');
      failure.code = 'GMAIL_FLOW_STORAGE_RECOVERY_FAILED';
      failure.cause = primaryError;
      failure.backupError = backupError;
      throw failure;
    }
  }

  async get(keys) {
    if (keys == null) return cloneStorageValue(this.data);
    if (typeof keys === 'string') return { [keys]: cloneStorageValue(this.data[keys]) };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, cloneStorageValue(this.data[key])]));
    }
    if (typeof keys === 'object') {
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
        key,
        cloneStorageValue(Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback)
      ]));
    }
    return {};
  }

  async set(values) {
    const committedValues = Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, cloneStorageValue(value)]));
    const operation = this.writeChain.then(async () => {
      const changes = {};
      const nextData = { ...this.data };
      Object.entries(committedValues).forEach(([key, value]) => {
        changes[key] = { oldValue: cloneStorageValue(this.data[key]), newValue: cloneStorageValue(value) };
        nextData[key] = value;
      });
      await this.persist(nextData);
      this.data = nextData;
      if (Object.keys(changes).length) this.onChanged(changes);
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async persist(data = this.data) {
    const snapshot = JSON.stringify(data, null, 2);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = temporaryPathFor(this.filePath);
    fs.writeFileSync(temporaryPath, snapshot, 'utf8');
    try {
      let currentRaw = null;
      try {
        currentRaw = fs.readFileSync(this.filePath, 'utf8');
        parseStorageObject(currentRaw);
      } catch (error) {
        currentRaw = null;
        if (error.code !== 'ENOENT' && !this.recoveredFromBackup) throw error;
      }
      if (currentRaw != null) {
        const backupTemporaryPath = temporaryPathFor(this.backupPath);
        fs.writeFileSync(backupTemporaryPath, currentRaw, 'utf8');
        try { replaceWithoutDeletingLiveFile(backupTemporaryPath, this.backupPath); }
        finally { try { fs.unlinkSync(backupTemporaryPath); } catch (error) { if (error.code !== 'ENOENT') console.error('Gmail Flow 백업 임시 파일 정리 실패:', error); } }
      }
      replaceWithoutDeletingLiveFile(temporaryPath, this.filePath);
      this.recoveredFromBackup = false;
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') console.error('Gmail Flow 저장 임시 파일 정리 실패:', error); }
    }
  }
}

module.exports = { JsonStorage };
