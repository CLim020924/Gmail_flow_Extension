const fs = require('node:fs');
const path = require('node:path');

class JsonStorage {
  constructor(filePath, onChanged = () => {}) {
    this.filePath = filePath;
    this.onChanged = onChanged;
    this.data = {};
    this.writeChain = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('저장 데이터 읽기 실패:', error);
      this.data = {};
    }
  }

  async get(keys) {
    if (keys == null) return { ...this.data };
    if (typeof keys === 'string') return { [keys]: this.data[keys] };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, this.data[key]]));
    }
    if (typeof keys === 'object') {
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
        key,
        Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback
      ]));
    }
    return {};
  }

  async set(values) {
    const changes = {};
    Object.entries(values || {}).forEach(([key, value]) => {
      changes[key] = { oldValue: this.data[key], newValue: value };
      this.data[key] = value;
    });
    await this.persist();
    if (Object.keys(changes).length) this.onChanged(changes);
  }

  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const operation = this.writeChain.catch(() => {}).then(() => {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      fs.writeFileSync(temporaryPath, snapshot, 'utf8');
      try {
        fs.renameSync(temporaryPath, this.filePath);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        try { fs.unlinkSync(this.filePath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        fs.renameSync(temporaryPath, this.filePath);
      }
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }
}

module.exports = { JsonStorage };
