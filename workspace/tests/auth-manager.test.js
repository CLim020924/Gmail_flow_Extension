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
  const originalWriteFile = fs.promises.writeFile;
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  fs.promises.writeFile = async (...args) => {
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return await originalWriteFile.call(fs.promises, ...args);
    } finally { activeWrites -= 1; }
  };
  try {
    await Promise.all([
      manager.setConfig('gmail-1', { provider: 'google', type: 'gmail', clientId: 'gmail-client', clientSecret: 'gmail-secret' }),
      manager.setConfig('zoom-1', { provider: 'zoom', type: 'zoom', clientId: 'zoom-client', clientSecret: 'zoom-secret', redirectUri: 'http://127.0.0.1/oauth/callback' })
    ]);
  } finally { fs.promises.writeFile = originalWriteFile; }
  assert.equal(maximumActiveWrites, 1, '서로 다른 연결도 공유 자격증명 파일에는 동시에 쓰지 않아야 한다');
  const disk = fs.readFileSync(filePath, 'utf8');
  assert.equal(disk.includes('client-secret'), false, 'secret must not be stored in plaintext');
  const reloaded = new AuthManager({ filePath, openExternal: async () => {}, protect, unprotect });
  assert.equal(reloaded.publicStatus('forms-1').configured, true);
  assert.equal(reloaded.publicStatus('gmail-1').configured, true);
  assert.equal(reloaded.publicStatus('zoom-1').configured, true);
  reloaded.entries['drive-metadata'] = {
    provider: 'google', type: 'drive', clientId: 'drive-client', clientSecret: '',
    accessToken: 'drive-token', refreshToken: 'drive-refresh', expiresAt: Date.now() + 120_000
  };
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: (name) => name.toLowerCase() === 'etag' ? '"drive-etag-1"' : null },
      text: async () => JSON.stringify({ id: 'drive-file-1', modifiedTime: '2026-08-27T08:00:00.000Z' })
    });
    const metadata = await reloaded.requestWithMetadata('drive-metadata', 'https://www.googleapis.com/drive/v3/files/drive-file-1');
    assert.equal(metadata.etag, '"drive-etag-1"', 'Drive conditional writes need the response ETag from the authenticated request');
    assert.equal(metadata.data.id, 'drive-file-1');
    global.fetch = async () => ({
      ok: false, status: 412,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { message: 'Precondition failed' } })
    });
    await assert.rejects(
      reloaded.request('drive-metadata', 'https://www.googleapis.com/upload/drive/v3/files/drive-file-1'),
      (error) => error.status === 412,
      'Drive ETag conflicts must preserve HTTP 412 so the caller cannot silently overwrite a newer remote file'
    );
  } finally { global.fetch = originalFetch; }
  await reloaded.remove('forms-1');
  assert.equal(reloaded.publicStatus('forms-1').configured, false);
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('auth-manager tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
