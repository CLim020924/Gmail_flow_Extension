const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExtensionCore = require('../extension-core');
const { ExtensionManager } = require('../desktop/extension-manager');

(async () => {
  const bundledPath = path.join(__dirname, '..', 'extensions');
  const userPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-extensions-'));
  const sourcePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-extension-source-'));
  const manager = new ExtensionManager({ bundledPath, userPath });
  const bundled = manager.list();
  assert.equal(bundled.length, 6);
  assert.deepEqual(bundled.map((item) => item.id), ['people', 'forms', 'schedule', 'layout', 'zoom', 'gmailFlow']);
  assert.ok(bundled.every((item) => item.integrity.startsWith('sha256-')));

  const packagePath = path.join(sourcePath, 'sample-source.cmoe-extension');
  fs.writeFileSync(packagePath, JSON.stringify({
    format: ExtensionCore.MANIFEST_FORMAT,
    apiVersion: 1,
    id: 'sample.extension',
    version: '1.0.0',
    name: '샘플 선언형 확장',
    permissions: ['projects:read'],
    contributes: { workflow: false, order: 500 },
    declarative: { title: '안전 양식', fields: [{ id: 'memo', label: '메모', type: 'textarea' }, { id: 'kind', label: '종류', type: 'select', options: ['A', 'B'] }] }
  }));
  const installed = await manager.install(packagePath);
  assert.equal(installed.id, 'sample.extension');
  assert.equal(installed.source, 'local');
  assert.equal(installed.contributes.page, 'declarative');
  assert.equal(installed.declarative.fields.length, 2);
  await manager.remove(installed.id);
  assert.equal(manager.list().some((item) => item.id === installed.id), false);

  assert.throws(() => ExtensionCore.normalizeManifest({ format: ExtensionCore.MANIFEST_FORMAT, apiVersion: 1, id: 'bad.extension', version: '1.0.0', name: 'Bad', permissions: ['system:execute'] }), /허용되지 않은/);
  fs.rmSync(userPath, { recursive: true, force: true });
  fs.rmSync(sourcePath, { recursive: true, force: true });
  console.log('extension-core tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
