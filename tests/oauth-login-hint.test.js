const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopOAuth } = require('../desktop/oauth');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-flow-oauth-test-'));
const authFile = path.join(tempDir, 'oauth.json');
const openedUrls = [];

fs.writeFileSync(authFile, JSON.stringify({
  refreshToken: 'remembered-refresh-token',
  email: 'remembered@example.com',
  scopes: [GMAIL_SCOPE]
}), 'utf8');

const oauth = new DesktopOAuth({
  clientId: 'desktop-client-id',
  clientSecret: 'desktop-client-secret',
  authFile,
  openExternal: async (url) => openedUrls.push(url)
});

oauth.createCallbackServer = async () => ({
  redirectUri: 'http://127.0.0.1:45678/oauth2/callback',
  codePromise: Promise.resolve('authorization-code'),
  close: () => {}
});
oauth.exchangeCode = async () => ({ access_token: 'access-token', refresh_token: 'new-refresh-token', expires_in: 3600 });
oauth.fetchEmail = async () => 'remembered@example.com';

(async () => {
  try {
    await oauth.login([GMAIL_SCOPE]);
    const reconnectUrl = new URL(openedUrls.at(-1));
    assert.equal(reconnectUrl.searchParams.get('login_hint'), 'remembered@example.com');
    assert.equal(reconnectUrl.searchParams.get('prompt'), 'consent');

    await oauth.login([GMAIL_SCOPE], { selectAccount: true });
    const switchUrl = new URL(openedUrls.at(-1));
    assert.equal(switchUrl.searchParams.has('login_hint'), false);
    assert.equal(switchUrl.searchParams.get('prompt'), 'consent select_account');
    console.log('oauth login hint test passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
