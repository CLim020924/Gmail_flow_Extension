const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCloudBackupPayload, restoreCloudBackupFiles, safeGmailData, validateCloudBackupPayload } = require('../desktop/cloud-backup');

(async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cmoe-cloud-backup-'));
  const extensions = path.join(root, 'extensions');
  const templates = path.join(root, 'templates');
  await fs.promises.mkdir(extensions, { recursive: true });
  await fs.promises.mkdir(templates, { recursive: true });
  await fs.promises.writeFile(path.join(extensions, 'custom.json'), '{"name":"custom"}', 'utf8');
  await fs.promises.writeFile(path.join(templates, 'sample.bin'), Buffer.from([1, 2, 3, 4]));
  const workspaceState = { format: 'cmoe-workspace', version: 1, projects: [{ id: 'p1' }] };
  const payload = await createCloudBackupPayload({
    version: '1.15.3', workspaceState,
    gmailData: { savedRosters: [{ id: 'r1' }], onlineSchedulerConfig: { secret: 'must-not-upload' }, cloudSyncMeta: { local: true } },
    documentProfiles: [{ id: 'profile-1' }],
    fileRoots: { extensions, 'document-templates': templates }
  });
  assert.equal(validateCloudBackupPayload(payload), payload);
  assert.deepEqual(payload.gmailData.savedRosters, [{ id: 'r1' }]);
  assert.equal(payload.gmailData.onlineSchedulerConfig, undefined);
  assert.equal(payload.gmailData.cloudSyncMeta, undefined);
  assert.equal(payload.files.length, 2);
  const output = path.join(root, 'restored');
  await restoreCloudBackupFiles(payload, { extensions: path.join(output, 'extensions'), 'document-templates': path.join(output, 'templates') });
  assert.equal(await fs.promises.readFile(path.join(output, 'extensions', 'custom.json'), 'utf8'), '{"name":"custom"}');
  assert.deepEqual(await fs.promises.readFile(path.join(output, 'templates', 'sample.bin')), Buffer.from([1, 2, 3, 4]));
  const tampered = JSON.parse(JSON.stringify(payload));
  tampered.files[0].data = Buffer.from('tampered').toString('base64');
  assert.throws(() => validateCloudBackupPayload(tampered), /검증|무결성/);
  assert.equal(safeGmailData({ templates: [], onlineSchedulerConfig: { secret: 'x' } }).onlineSchedulerConfig, undefined);
  await fs.promises.rm(root, { recursive: true, force: true });
  console.log('cloud backup tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
