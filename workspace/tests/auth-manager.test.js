const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthManager } = require('../desktop/auth-manager');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cmoe-auth-'));
  const filePath = path.join(directory, 'credentials.json');
  const protect = (plain) => Buffer.from(`protected:${plain}`, 'utf8').toString('base64');
  const unprotect = (value) => Buffer.from(value, 'base64').toString('utf8').slice('protected:'.length);
  const manager = new AuthManager({ filePath, openExternal: async () => {}, protect, unprotect });
  await manager.setConfig('forms-1', { provider: 'google', type: 'forms', clientId: 'client-id', clientSecret: 'client-secret' });
  assert.equal(manager.publicStatus('forms-1').configured, true);
  const disk = fs.readFileSync(filePath, 'utf8');
  assert.equal(disk.includes('client-secret'), false, 'secret must not be stored in plaintext');
  const reloaded = new AuthManager({ filePath, openExternal: async () => {}, protect, unprotect });
  assert.equal(reloaded.publicStatus('forms-1').configured, true);
  await reloaded.remove('forms-1');
  assert.equal(reloaded.publicStatus('forms-1').configured, false);
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('auth-manager tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
