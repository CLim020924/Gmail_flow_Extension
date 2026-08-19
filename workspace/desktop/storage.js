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
      if (error.code !== 'ENOENT') console.error('Workspace 데이터 읽기 실패:', error);
      this.data = {};
    }
  }

  async get(key, fallback = null) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  async set(key, value) {
    const oldValue = this.data[key];
    this.data[key] = value;
    await this.persist();
    this.onChanged({ [key]: { oldValue, newValue: value } });
  }

  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.promises.writeFile(temporaryPath, snapshot, 'utf8');
      try {
        await fs.promises.rename(temporaryPath, this.filePath);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
        try { await fs.promises.unlink(this.filePath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        await fs.promises.rename(temporaryPath, this.filePath);
      }
    });
    return this.writeChain;
  }
}

module.exports = { JsonStorage };
