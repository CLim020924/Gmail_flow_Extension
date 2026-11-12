const fs = require('node:fs');

const GOOGLE_OAUTH_RELEASE_FORMAT = 'cmoe-google-desktop-oauth-v1';
const MAX_GOOGLE_OAUTH_CONFIG_BYTES = 64 * 1024;
const MAX_GOOGLE_CLIENT_ID_LENGTH = 512;
const MAX_GOOGLE_CLIENT_SECRET_LENGTH = 4096;
const GOOGLE_DESKTOP_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function textWithinBounds(value, maximumLength) {
  const normalized = String(value || '').trim();
  return normalized && normalized.length <= maximumLength && !CONTROL_CHARACTER_PATTERN.test(normalized)
    ? normalized
    : '';
}

function normalizeExpectedClientId(value) {
  const expectedClientId = String(value || '').trim();
  if (!expectedClientId) return '';
  if (expectedClientId.length > MAX_GOOGLE_CLIENT_ID_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(expectedClientId)
    || !GOOGLE_DESKTOP_CLIENT_ID_PATTERN.test(expectedClientId)) {
    throw configError('GOOGLE_OAUTH_EXPECTED_CLIENT_ID_INVALID', 'The expected Google Desktop OAuth Client ID is invalid.');
  }
  return expectedClientId;
}

function normalizeGoogleDesktopCredentials(input, { expectedClientId = '' } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clientId = textWithinBounds(source.clientId ?? source.client_id, MAX_GOOGLE_CLIENT_ID_LENGTH);
  const clientSecret = textWithinBounds(source.clientSecret ?? source.client_secret, MAX_GOOGLE_CLIENT_SECRET_LENGTH);
  if (!clientId || !GOOGLE_DESKTOP_CLIENT_ID_PATTERN.test(clientId)) {
    throw configError('GOOGLE_OAUTH_CLIENT_ID_INVALID', 'The Google Desktop OAuth Client ID is missing or invalid.');
  }
  if (!clientSecret) {
    throw configError('GOOGLE_OAUTH_CLIENT_SECRET_INVALID', 'The Google Desktop OAuth client configuration is incomplete.');
  }
  const expected = normalizeExpectedClientId(expectedClientId);
  if (expected && clientId !== expected) {
    throw configError('GOOGLE_OAUTH_CLIENT_ID_MISMATCH', 'The Google Desktop OAuth Client ID does not match the expected release client.');
  }
  return { clientId, clientSecret };
}

function boundedConfigText(raw, label = 'Google OAuth configuration') {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  if (buffer.length < 2 || buffer.length > MAX_GOOGLE_OAUTH_CONFIG_BYTES) {
    throw configError('GOOGLE_OAUTH_CONFIG_SIZE_INVALID', `${label} has an invalid size.`);
  }
  return buffer.toString('utf8');
}

function parsedJson(raw, label) {
  try { return JSON.parse(boundedConfigText(raw, label)); }
  catch (error) {
    if (error?.code === 'GOOGLE_OAUTH_CONFIG_SIZE_INVALID') throw error;
    throw configError('GOOGLE_OAUTH_CONFIG_JSON_INVALID', `${label} is not valid JSON.`);
  }
}

function googleDesktopCredentialsFromDownloadedJson(raw, options = {}) {
  const parsed = parsedJson(raw, 'The downloaded Google OAuth configuration');
  const installed = parsed?.installed;
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    throw configError('GOOGLE_OAUTH_DESKTOP_CONFIG_REQUIRED', 'The selected file is not a Google Desktop application OAuth configuration.');
  }
  return normalizeGoogleDesktopCredentials(installed, options);
}

function generatedGoogleOAuthReleaseConfig(credentials, options = {}) {
  const normalized = normalizeGoogleDesktopCredentials(credentials, options);
  return {
    format: GOOGLE_OAUTH_RELEASE_FORMAT,
    clientId: normalized.clientId,
    clientSecret: normalized.clientSecret
  };
}

function serializeGoogleOAuthReleaseConfig(credentials, options = {}) {
  return `${JSON.stringify(generatedGoogleOAuthReleaseConfig(credentials, options))}\n`;
}

function credentialsFromGeneratedReleaseConfig(raw, options = {}) {
  const parsed = parsedJson(raw, 'The generated Google OAuth release configuration');
  if (parsed?.format !== GOOGLE_OAUTH_RELEASE_FORMAT) {
    throw configError('GOOGLE_OAUTH_RELEASE_FORMAT_INVALID', 'The generated Google OAuth release configuration has an unsupported format.');
  }
  return normalizeGoogleDesktopCredentials(parsed, options);
}

function readGeneratedReleaseCredentials(filePath, options = {}) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) return null;
  let stat;
  try { stat = fs.statSync(normalizedPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw configError('GOOGLE_OAUTH_RELEASE_CONFIG_UNREADABLE', 'The generated Google OAuth release configuration cannot be read.');
  }
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_GOOGLE_OAUTH_CONFIG_BYTES) {
    throw configError('GOOGLE_OAUTH_CONFIG_SIZE_INVALID', 'The generated Google OAuth release configuration has an invalid size.');
  }
  let raw;
  try { raw = fs.readFileSync(normalizedPath); }
  catch (_) {
    throw configError('GOOGLE_OAUTH_RELEASE_CONFIG_UNREADABLE', 'The generated Google OAuth release configuration cannot be read.');
  }
  return credentialsFromGeneratedReleaseConfig(raw, options);
}

function normalizedPublicClientId(value, { expectedClientId = '' } = {}) {
  const clientId = String(value || '').trim();
  if (!clientId) return '';
  if (clientId.length > MAX_GOOGLE_CLIENT_ID_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(clientId)
    || !GOOGLE_DESKTOP_CLIENT_ID_PATTERN.test(clientId)) {
    throw configError('GOOGLE_OAUTH_PUBLIC_CLIENT_ID_INVALID', 'The bundled Google Desktop OAuth public Client ID is invalid.');
  }
  const expected = normalizeExpectedClientId(expectedClientId);
  if (expected && clientId !== expected) {
    throw configError('GOOGLE_OAUTH_CLIENT_ID_MISMATCH', 'The bundled Google Desktop OAuth Client ID does not match the expected release client.');
  }
  return clientId;
}

function loadGoogleOAuthReleaseConfig({
  managedClientId = '',
  managedClientSecret = '',
  generatedPath = '',
  publicClientId = '',
  expectedClientId = ''
} = {}) {
  const hasManagedClientId = Boolean(String(managedClientId || '').trim());
  const hasManagedClientSecret = Boolean(String(managedClientSecret || '').trim());
  if (hasManagedClientId !== hasManagedClientSecret) {
    throw configError('GOOGLE_OAUTH_MANAGED_CONFIG_INCOMPLETE', 'The managed Google Desktop OAuth client configuration is incomplete.');
  }
  if (hasManagedClientId) {
    const credentials = normalizeGoogleDesktopCredentials({ clientId: managedClientId, clientSecret: managedClientSecret }, { expectedClientId });
    return { ...credentials, source: 'managed', ready: true };
  }

  const generated = readGeneratedReleaseCredentials(generatedPath, { expectedClientId });
  if (generated) return { ...generated, source: 'generated', ready: true };

  const fallbackClientId = normalizedPublicClientId(publicClientId, { expectedClientId });
  return {
    clientId: fallbackClientId,
    clientSecret: '',
    source: fallbackClientId ? 'public-id' : 'missing',
    ready: false
  };
}

function publicGoogleOAuthReleaseStatus(config = {}) {
  return {
    ready: Boolean(config.ready && config.clientId && config.clientSecret),
    source: ['managed', 'generated', 'public-id', 'missing'].includes(config.source) ? config.source : 'missing',
    hasPublicClientId: Boolean(config.clientId),
    requiresClientSecret: Boolean(config.clientId && !config.clientSecret)
  };
}

module.exports = {
  GOOGLE_OAUTH_RELEASE_FORMAT,
  MAX_GOOGLE_OAUTH_CONFIG_BYTES,
  normalizeGoogleDesktopCredentials,
  googleDesktopCredentialsFromDownloadedJson,
  generatedGoogleOAuthReleaseConfig,
  serializeGoogleOAuthReleaseConfig,
  credentialsFromGeneratedReleaseConfig,
  readGeneratedReleaseCredentials,
  loadGoogleOAuthReleaseConfig,
  publicGoogleOAuthReleaseStatus
};
