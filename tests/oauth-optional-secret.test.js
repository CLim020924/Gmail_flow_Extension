const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopOAuth, loadDesktopOAuthClientSecret } = require('../desktop/oauth');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-flow-oauth-optional-secret-test-'));
const missingCredentials = path.join(tempDir, 'missing-credentials.js');

async function captureTokenBodies(clientSecret) {
  const oauth = new DesktopOAuth({
    clientId: 'desktop-client-id',
    clientSecret,
    authFile: path.join(tempDir, `oauth-${clientSecret ? 'secret' : 'public'}.json`),
    openExternal: async () => {}
  });
  const bodies = [];
  oauth.tokenRequest = async (body) => {
    bodies.push(new URLSearchParams(body));
    return { access_token: 'access-token', expires_in: 3600 };
  };
  oauth.save = async () => {};
  await oauth.exchangeCode('authorization-code', 'http://127.0.0.1/callback', 'verifier');
  oauth.auth.refreshToken = 'refresh-token';
  await oauth.refreshToken();
  return bodies;
}

(async () => {
  try {
    assert.equal(loadDesktopOAuthClientSecret(missingCredentials), '');
    const localCredentials = path.join(tempDir, 'credentials.js');
    fs.writeFileSync(localCredentials, "module.exports = { clientSecret: ' configured-secret ' };\n", 'utf8');
    assert.equal(loadDesktopOAuthClientSecret(localCredentials), 'configured-secret');

    const blankSecretBodies = await captureTokenBodies('   ');
    assert.equal(blankSecretBodies.length, 2);
    blankSecretBodies.forEach((body) => assert.equal(body.has('client_secret'), false));

    const secretBodies = await captureTokenBodies(' desktop-client-secret ');
    assert.equal(secretBodies.length, 2);
    secretBodies.forEach((body) => assert.equal(body.get('client_secret'), 'desktop-client-secret'));

    console.log('oauth optional secret test passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
