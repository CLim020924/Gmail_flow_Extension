const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../desktop/update-data-backup');

(async () => {
  const backupFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-update-backup-'));
  try {
    const dataRoot = path.join(backupFixture, 'user-data');
    const backupRoot = path.join(backupFixture, 'backups');
    fs.mkdirSync(path.join(dataRoot, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'workspace-data.json'), '{"project":"synthetic"}');
    fs.writeFileSync(path.join(dataRoot, 'extensions', 'sample.cmoe-extension'), '{"id":"synthetic"}');
    const backup = await updater.createUpdateDataBackup({
      version: '1.15.2', backupRoot,
      entries: [
        { source: path.join(dataRoot, 'workspace-data.json'), relativePath: 'workspace/workspace-data.json' },
        { source: path.join(dataRoot, 'extensions'), relativePath: 'workspace/extensions' },
        { source: path.join(dataRoot, 'missing.json'), relativePath: 'workspace/missing.json' }
      ]
    });
    assert.equal(fs.readFileSync(path.join(backup.snapshotPath, 'workspace', 'workspace-data.json'), 'utf8'), '{"project":"synthetic"}');
    assert.equal(fs.existsSync(path.join(backup.snapshotPath, 'workspace', 'extensions', 'sample.cmoe-extension')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(backup.snapshotPath, 'backup-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.entries, ['workspace/workspace-data.json', 'workspace/extensions']);
    await assert.rejects(
      updater.createUpdateDataBackup({ version: '1.15.2', backupRoot: path.join(dataRoot, 'nested-backup'), entries: [{ source: dataRoot, relativePath: 'workspace' }] }),
      /겹칩/
    );
  } finally { fs.rmSync(backupFixture, { recursive: true, force: true }); }
  console.log('update data backup tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
