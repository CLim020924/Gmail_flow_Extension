const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExtensionCore = require('../extension-core');

class ExtensionManager {
  constructor({ bundledPath, userPath }) {
    this.bundledPath = bundledPath;
    this.userPath = userPath;
  }

  readManifest(filePath, bundled) {
    const source = fs.readFileSync(filePath);
    const manifest = ExtensionCore.normalizeManifest({ ...JSON.parse(source.toString('utf8')), bundled });
    return { ...manifest, source: bundled ? 'bundled' : 'local', integrity: `sha256-${crypto.createHash('sha256').update(source).digest('base64')}` };
  }

  scanDirectory(directory, bundled) {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const filePath = entry.isDirectory() ? path.join(directory, entry.name, 'manifest.json') : (entry.name.endsWith('.cmoe-extension') ? path.join(directory, entry.name) : '');
        if (!filePath || !fs.existsSync(filePath)) return [];
        try { return [this.readManifest(filePath, bundled)]; }
        catch (error) { console.error(`확장 manifest 제외 (${filePath}):`, error.message); return []; }
      });
    } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
  }

  list() {
    const manifests = [...this.scanDirectory(this.bundledPath, true), ...this.scanDirectory(this.userPath, false)];
    return ExtensionCore.buildRegistry(manifests).map((item) => {
      const original = manifests.find((candidate) => candidate.id === item.id && candidate.version === item.version);
      return { ...item, source: original?.source || 'bundled', integrity: original?.integrity || '' };
    });
  }

  async install(sourcePath) {
    const source = await fs.promises.readFile(sourcePath);
    const parsed = JSON.parse(source.toString('utf8'));
    if (parsed.code || parsed.scripts || parsed.main || parsed.renderer) throw new Error('현재 안전 모드에서는 실행 코드가 포함된 외부 확장을 설치할 수 없습니다.');
    const manifest = ExtensionCore.normalizeManifest({ ...parsed, bundled: false });
    if (manifest.core) throw new Error('외부 확장은 핵심 확장으로 등록할 수 없습니다.');
    await fs.promises.mkdir(this.userPath, { recursive: true });
    const destination = path.join(this.userPath, `${manifest.id}.cmoe-extension`);
    await fs.promises.writeFile(destination, JSON.stringify({ ...parsed, bundled: false }, null, 2), { encoding: 'utf8', flag: 'w' });
    return this.list().find((item) => item.id === manifest.id);
  }

  async remove(extensionId) {
    const manifest = this.list().find((item) => item.id === extensionId);
    if (!manifest || manifest.source !== 'local') throw new Error('기본 포함 확장은 파일에서 제거할 수 없습니다.');
    const target = path.resolve(this.userPath, `${extensionId}.cmoe-extension`);
    if (path.dirname(target) !== path.resolve(this.userPath)) throw new Error('확장 경로가 안전하지 않습니다.');
    await fs.promises.unlink(target);
    return { ok: true };
  }
}

module.exports = { ExtensionManager };
