const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: nodeSpawn } = require('node:child_process');

const LOGIN_BROWSER_IDS = Object.freeze(['system', 'windows-picker', 'chrome', 'edge']);
const LOGIN_BROWSER_LABELS = Object.freeze({
  system: '기본 브라우저',
  'windows-picker': '다른 브라우저 선택',
  chrome: 'Chrome',
  edge: 'Edge'
});
const CHROMIUM_BROWSER_IDS = Object.freeze(['chrome', 'edge']);
const MAX_LOCAL_STATE_BYTES = 8 * 1024 * 1024;

const OAUTH_RULES = Object.freeze({
  google: Object.freeze({
    origin: 'https://accounts.google.com',
    pathname: '/o/oauth2/v2/auth',
    allowedParams: new Set([
      'client_id',
      'redirect_uri',
      'response_type',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'state',
      'access_type',
      'prompt',
      'login_hint'
    ])
  }),
  zoom: Object.freeze({
    origin: 'https://zoom.us',
    pathname: '/oauth/authorize',
    allowedParams: new Set([
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method'
    ])
  })
});

function codedError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizeBrowserId(value) {
  const browserId = String(value || '').trim().toLowerCase();
  if (!LOGIN_BROWSER_IDS.includes(browserId)) {
    throw codedError('선택한 로그인 브라우저는 사용할 수 없습니다.', 'LOGIN_BROWSER_NOT_ALLOWED');
  }
  return browserId;
}

function normalizedStandardRoot(value, kind) {
  const root = path.win32.normalize(String(value || '').trim()).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:\\Program Files$/i.test(root) && kind === 'program-files') return root;
  if (/^[A-Za-z]:\\Program Files \(x86\)$/i.test(root) && kind === 'program-files-x86') return root;
  if (/^[A-Za-z]:\\Users\\[^\\/:*?"<>|]+\\AppData\\Local$/i.test(root) && kind === 'local-app-data') return root;
  if (/^[A-Za-z]:\\Windows$/i.test(root) && kind === 'windows-root') return root;
  return '';
}

function standardBrowserCandidates(environment = process.env) {
  const programFiles = normalizedStandardRoot(environment.ProgramFiles, 'program-files');
  const programFilesX86 = normalizedStandardRoot(environment['ProgramFiles(x86)'], 'program-files-x86');
  const localAppData = normalizedStandardRoot(environment.LOCALAPPDATA, 'local-app-data');
  const join = (root, ...parts) => root ? path.win32.join(root, ...parts) : '';
  return Object.freeze({
    chrome: Object.freeze([
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean)),
    edge: Object.freeze([
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean))
  });
}

function standardChromiumUserDataRoots(environment = process.env) {
  const localAppData = normalizedStandardRoot(environment.LOCALAPPDATA, 'local-app-data');
  const join = (root, ...parts) => root ? path.win32.join(root, ...parts) : '';
  return Object.freeze({
    chrome: join(localAppData, 'Google', 'Chrome', 'User Data'),
    edge: join(localAppData, 'Microsoft', 'Edge', 'User Data')
  });
}

function standardPowerShellCandidate(environment = process.env) {
  const windowsRoot = normalizedStandardRoot(environment.SystemRoot, 'windows-root');
  return windowsRoot ? path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
}

function canonicalWindowsPath(value) {
  return path.win32.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function resolveCandidate(candidate, fileSystem = fs) {
  try {
    if (!fileSystem.statSync(candidate).isFile()) return '';
    const realpath = typeof fileSystem.realpathSync?.native === 'function'
      ? fileSystem.realpathSync.native(candidate)
      : fileSystem.realpathSync(candidate);
    // Do not follow a junction or symlink from an allowlisted location to a
    // different executable. The launched file must itself be the fixed path.
    if (canonicalWindowsPath(realpath) !== canonicalWindowsPath(candidate)) return '';
    return path.win32.normalize(realpath);
  } catch (_) {
    return '';
  }
}

function resolveLoginBrowser(browserIdValue, { environment = process.env, fileSystem = fs } = {}) {
  const browserId = normalizeBrowserId(browserIdValue);
  if (['system', 'windows-picker'].includes(browserId)) return { id: browserId, label: LOGIN_BROWSER_LABELS[browserId] };
  const candidates = standardBrowserCandidates(environment)[browserId];
  for (const candidate of candidates) {
    const executablePath = resolveCandidate(candidate, fileSystem);
    if (executablePath) return { id: browserId, label: LOGIN_BROWSER_LABELS[browserId], executablePath };
  }
  throw codedError(`${LOGIN_BROWSER_LABELS[browserId]}이 설치되어 있지 않거나 실행할 수 없습니다.`, 'LOGIN_BROWSER_UNAVAILABLE');
}

function resolveWindowsApplicationPicker({ environment = process.env, fileSystem = fs, applicationPickerScriptPath = '' } = {}) {
  const powershellCandidate = standardPowerShellCandidate(environment);
  const powershellPath = powershellCandidate ? resolveCandidate(powershellCandidate, fileSystem) : '';
  const scriptPath = applicationPickerScriptPath ? resolveCandidate(applicationPickerScriptPath, fileSystem) : '';
  if (!powershellPath || !scriptPath) {
    throw codedError('Windows의 브라우저 선택 화면을 사용할 수 없습니다.', 'LOGIN_BROWSER_PICKER_UNAVAILABLE');
  }
  return { powershellPath, scriptPath };
}

function normalizeOwnerWindowHandle(value) {
  const text = String(value || '').trim();
  if (!/^[1-9][0-9]{0,19}$/.test(text)) {
    throw codedError('Windows 브라우저 선택 화면의 기준 창을 확인할 수 없습니다.', 'LOGIN_BROWSER_PICKER_UNAVAILABLE');
  }
  try {
    const handle = BigInt(text);
    if (handle <= 0n || handle > 0xffffffffffffffffn) throw new Error('out of range');
  } catch (_) {
    throw codedError('Windows 브라우저 선택 화면의 기준 창을 확인할 수 없습니다.', 'LOGIN_BROWSER_PICKER_UNAVAILABLE');
  }
  return text;
}

function listLoginBrowsers(options = {}) {
  const browsers = [];
  for (const browserId of ['chrome', 'edge']) {
    try {
      const browser = resolveLoginBrowser(browserId, options);
      browsers.push({ id: browser.id, label: browser.label });
    } catch (error) {
      if (error.code !== 'LOGIN_BROWSER_UNAVAILABLE') throw error;
    }
  }
  try {
    resolveWindowsApplicationPicker(options);
    browsers.push({ id: 'windows-picker', label: LOGIN_BROWSER_LABELS['windows-picker'] });
  } catch (error) {
    if (error.code !== 'LOGIN_BROWSER_PICKER_UNAVAILABLE') throw error;
  }
  if (!browsers.length) browsers.push({ id: 'system', label: LOGIN_BROWSER_LABELS.system });
  return browsers;
}

function normalizeProfileDirectory(value) {
  const profileId = String(value || '').trim();
  if (!/^(?:Default|Profile [1-9][0-9]{0,5})$/.test(profileId)) {
    throw codedError('선택한 브라우저 사용자는 사용할 수 없습니다.', 'LOGIN_BROWSER_PROFILE_NOT_ALLOWED');
  }
  return profileId;
}

function publicProfileText(value, maxLength) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxLength);
}

function readBoundedJson(filePath, fileSystem = fs) {
  try {
    const stats = fileSystem.statSync(filePath);
    if (!stats.isFile() || (Number.isFinite(stats.size) && stats.size > MAX_LOCAL_STATE_BYTES)) return null;
    const raw = fileSystem.readFileSync(filePath, 'utf8');
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_LOCAL_STATE_BYTES) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function existingProfileDirectory(userDataRoot, profileId, fileSystem = fs) {
  try {
    const directory = path.win32.join(userDataRoot, profileId);
    if (!fileSystem.statSync(directory).isDirectory()) return false;
    if (typeof fileSystem.realpathSync !== 'function') return true;
    const realpath = typeof fileSystem.realpathSync.native === 'function'
      ? fileSystem.realpathSync.native.bind(fileSystem.realpathSync)
      : fileSystem.realpathSync.bind(fileSystem);
    const rootRealpath = path.win32.normalize(realpath(userDataRoot));
    const directoryRealpath = path.win32.normalize(realpath(directory));
    const relative = path.win32.relative(rootRealpath, directoryRealpath);
    return relative === profileId && !path.win32.isAbsolute(relative) && !relative.startsWith(`..${path.win32.sep}`);
  } catch (_) {
    return false;
  }
}

function listLoginBrowserProfiles(browserIdValue, { environment = process.env, fileSystem = fs } = {}) {
  const browserId = normalizeBrowserId(browserIdValue);
  if (!CHROMIUM_BROWSER_IDS.includes(browserId)) {
    throw codedError('이 브라우저에서는 사용자 선택을 지원하지 않습니다.', 'LOGIN_BROWSER_PROFILES_UNSUPPORTED');
  }
  resolveLoginBrowser(browserId, { environment, fileSystem });
  const userDataRoot = standardChromiumUserDataRoots(environment)[browserId];
  if (!userDataRoot) throw codedError('브라우저 사용자 정보를 확인할 수 없습니다.', 'LOGIN_BROWSER_PROFILES_UNAVAILABLE');
  const localState = readBoundedJson(path.win32.join(userDataRoot, 'Local State'), fileSystem);
  const profileState = localState?.profile;
  const infoCache = profileState?.info_cache;
  if (!infoCache || typeof infoCache !== 'object' || Array.isArray(infoCache)) return [];

  const lastUsed = (() => {
    try { return normalizeProfileDirectory(profileState.last_used); }
    catch (_) { return ''; }
  })();
  const orderedIds = [];
  const append = (value) => {
    let profileId;
    try { profileId = normalizeProfileDirectory(value); }
    catch (_) { return; }
    if (!orderedIds.includes(profileId)) orderedIds.push(profileId);
  };
  (Array.isArray(profileState.profiles_order) ? profileState.profiles_order : []).forEach(append);
  (Array.isArray(profileState.last_active_profiles) ? profileState.last_active_profiles : []).forEach(append);
  append(lastUsed);
  Object.keys(infoCache).forEach(append);

  const profiles = [];
  orderedIds.forEach((profileId, index) => {
    const info = infoCache[profileId];
    if (!info || typeof info !== 'object' || Array.isArray(info) || info.is_omitted_from_profile_list === true) return;
    if (!existingProfileDirectory(userDataRoot, profileId, fileSystem)) return;
    const label = publicProfileText(info.name || info.shortcut_name || info.gaia_name, 80)
      || `${LOGIN_BROWSER_LABELS[browserId]} 사용자 ${index + 1}`;
    const account = publicProfileText(info.user_name, 320);
    profiles.push({ id: profileId, label, account, isLastUsed: profileId === lastUsed });
  });
  return profiles;
}

function resolveLoginBrowserProfile(browserId, profileId, options = {}) {
  const normalizedProfileId = normalizeProfileDirectory(profileId);
  const profile = listLoginBrowserProfiles(browserId, options).find((item) => item.id === normalizedProfileId);
  if (!profile) throw codedError('선택한 브라우저 사용자를 더 이상 찾을 수 없습니다.', 'LOGIN_BROWSER_PROFILE_UNAVAILABLE');
  return profile;
}

function profileToken(secret, browserId, profileDirectory) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret || '');
  if (key.length < 32) throw new TypeError('A 32-byte browser profile token secret is required.');
  return crypto.createHmac('sha256', key)
    .update(String(browserId || ''))
    .update('\0')
    .update(String(profileDirectory || ''))
    .digest('base64url');
}

function publicLoginBrowserProfiles(browserId, options, secret) {
  return listLoginBrowserProfiles(browserId, options).map((profile) => ({
    id: profileToken(secret, browserId, profile.id),
    label: profile.label,
    account: profile.account,
    isLastUsed: profile.isLastUsed
  }));
}

function resolveProfileToken(browserId, tokenValue, options, secret) {
  const token = String(tokenValue || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw codedError('선택한 브라우저 사용자는 사용할 수 없습니다.', 'LOGIN_BROWSER_PROFILE_NOT_ALLOWED');
  }
  const profile = listLoginBrowserProfiles(browserId, options).find((candidate) => {
    const expected = profileToken(secret, browserId, candidate.id);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  });
  if (!profile) throw codedError('선택한 브라우저 사용자를 더 이상 찾을 수 없습니다.', 'LOGIN_BROWSER_PROFILE_UNAVAILABLE');
  return profile;
}

function singleSearchParam(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) throw codedError('OAuth 로그인 주소의 필수 값이 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  return values[0];
}

function validateLoopbackRedirect(value) {
  let redirect;
  try { redirect = new URL(value); }
  catch (_) { throw codedError('OAuth 로그인 응답 주소가 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED'); }
  const port = Number(redirect.port);
  if (redirect.protocol !== 'http:'
    || redirect.hostname !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || redirect.pathname !== '/oauth/callback'
    || redirect.username
    || redirect.password
    || redirect.search
    || redirect.hash) {
    throw codedError('OAuth 로그인 응답 주소가 허용된 로컬 주소가 아닙니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  }
}

function validateOAuthAuthorizationUrl(rawUrl, { provider, authMode = 'public-pkce' } = {}) {
  const value = String(rawUrl || '');
  if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw codedError('OAuth 로그인 주소가 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  }
  const normalizedProvider = String(provider || '').toLowerCase();
  const rule = OAUTH_RULES[normalizedProvider];
  if (!rule) throw codedError('지원하지 않는 OAuth 공급자입니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  if (String(authMode || '') !== 'public-pkce') {
    throw codedError('허용되지 않은 OAuth 로그인 방식입니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  }
  let url;
  try { url = new URL(value); }
  catch (_) { throw codedError('OAuth 로그인 주소가 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED'); }
  if (url.origin !== rule.origin
    || url.pathname !== rule.pathname
    || url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.hash) {
    throw codedError('허용되지 않은 OAuth 로그인 주소입니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  }

  const seen = new Set();
  for (const [name] of url.searchParams) {
    if (!rule.allowedParams.has(name) || seen.has(name)) {
      throw codedError('OAuth 로그인 주소에 허용되지 않은 값이 포함되어 있습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
    }
    seen.add(name);
  }

  if (singleSearchParam(url, 'response_type') !== 'code') {
    throw codedError('OAuth 로그인 응답 방식이 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  }
  const clientId = singleSearchParam(url, 'client_id');
  const validClientId = normalizedProvider === 'google'
    ? clientId.length <= 512 && /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)
    : /^[A-Za-z0-9._-]{8,256}$/.test(clientId);
  if (!validClientId) throw codedError('OAuth 앱 식별자가 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  if (!/^[A-Za-z0-9_-]{32}$/.test(singleSearchParam(url, 'state'))) {
    throw codedError('OAuth 상태 검증 값이 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  }
  if (singleSearchParam(url, 'code_challenge_method') !== 'S256'
    || !/^[A-Za-z0-9_-]{43}$/.test(singleSearchParam(url, 'code_challenge'))) {
    throw codedError('OAuth PKCE 검증 값이 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
  }
  validateLoopbackRedirect(singleSearchParam(url, 'redirect_uri'));

  if (normalizedProvider === 'google') {
    const scope = singleSearchParam(url, 'scope');
    const scopes = scope.split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid') || !scopes.includes('email') || !scopes.includes('profile')) {
      throw codedError('Google 로그인 권한 범위가 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
    }
    if (singleSearchParam(url, 'access_type') !== 'offline') {
      throw codedError('Google 오프라인 로그인 설정이 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
    }
    const prompt = new Set(singleSearchParam(url, 'prompt').split(/\s+/).filter(Boolean));
    if (!prompt.has('consent') || [...prompt].some((item) => !['consent', 'select_account'].includes(item))) {
      throw codedError('Google 계정 선택 설정이 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
    }
    if (url.searchParams.has('login_hint')) {
      const loginHint = singleSearchParam(url, 'login_hint');
      if (!loginHint || loginHint.length > 320 || /[\u0000-\u001f\u007f]/.test(loginHint)) {
        throw codedError('Google 로그인 계정 힌트가 올바르지 않습니다.', 'OAUTH_AUTHORIZATION_URL_REJECTED');
      }
    }
  }

  return url.href;
}

function spawnBrowser(spawn, executablePath, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executablePath, args, {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
    } catch (error) {
      reject(codedError('선택한 로그인 브라우저를 실행하지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED', error));
      return;
    }
    if (!child || typeof child.once !== 'function') {
      reject(codedError('선택한 로그인 브라우저를 실행하지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED'));
      return;
    }
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(codedError('선택한 로그인 브라우저를 실행하지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED', error));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref?.();
      resolve();
    });
  });
}

function openWindowsApplicationPicker(spawn, picker, url, ownerWindowHandle, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(codedError('브라우저 선택이 취소되었습니다.', 'AUTHORIZATION_CANCELLED'));
      return;
    }
    let child;
    const encodedUrl = Buffer.from(url, 'utf8').toString('base64');
    try {
      child = spawn(picker.powershellPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        picker.scriptPath,
        '-UrlBase64',
        encodedUrl,
        '-OwnerWindowHandle',
        ownerWindowHandle
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore']
      });
    } catch (error) {
      reject(codedError('Windows의 브라우저 선택 화면을 열지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED', error));
      return;
    }
    if (!child || typeof child.once !== 'function') {
      reject(codedError('Windows의 브라우저 선택 화면을 열지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED'));
      return;
    }
    let promiseSettled = false;
    let childEnded = false;
    let cancelled = false;
    let forceKillTimer = null;
    const cleanup = () => {
      signal?.removeEventListener?.('abort', onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
    };
    const onAbort = () => {
      if (childEnded) return;
      cancelled = true;
      try {
        if (child.stdin?.writable) child.stdin.end('cancel\n');
        else child.kill?.();
      } catch (_) {
        try { child.kill?.(); } catch (_) {}
      }
      forceKillTimer = setTimeout(() => {
        if (!childEnded) {
          try { child.kill?.(); } catch (_) {}
        }
      }, 1500);
      forceKillTimer.unref?.();
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.once('error', (error) => {
      childEnded = true;
      cleanup();
      if (promiseSettled) return;
      promiseSettled = true;
      reject(codedError('Windows의 브라우저 선택 화면을 열지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED', error));
    });
    child.once('exit', (code) => {
      childEnded = true;
      cleanup();
      if (promiseSettled) return;
      promiseSettled = true;
      if (cancelled) reject(codedError('브라우저 선택이 취소되었습니다.', 'AUTHORIZATION_CANCELLED'));
      else if (code === 0) resolve();
      else if (code === 2) reject(codedError('브라우저 선택이 취소되었습니다.', 'AUTHORIZATION_CANCELLED'));
      else reject(codedError('Windows의 브라우저 선택 화면을 열지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED'));
    });
    child.once('spawn', () => child.unref?.());
  });
}

function createLoginBrowserLauncher({ shell, spawn = nodeSpawn, environment = process.env, fileSystem = fs, applicationPickerScriptPath = '', profileTokenSecret = crypto.randomBytes(32), getOwnerWindowHandle = () => '' } = {}) {
  if (!shell || typeof shell.openExternal !== 'function') throw new TypeError('Electron shell.openExternal is required.');
  if (typeof spawn !== 'function') throw new TypeError('A child-process spawn function is required.');
  if (typeof getOwnerWindowHandle !== 'function') throw new TypeError('A window handle resolver is required.');
  const launcherOptions = { environment, fileSystem, applicationPickerScriptPath };
  const tokenSecret = Buffer.from(profileTokenSecret);
  if (tokenSecret.length < 32) throw new TypeError('A 32-byte browser profile token secret is required.');
  return Object.freeze({
    async list() {
      return listLoginBrowsers(launcherOptions);
    },
    async listProfiles(browserId) {
      return publicLoginBrowserProfiles(browserId, launcherOptions, tokenSecret);
    },
    async open(rawUrl, { provider, browserId = 'system', browserProfileId = '', authMode = 'public-pkce', signal = null } = {}) {
      const url = validateOAuthAuthorizationUrl(rawUrl, { provider, authMode });
      const browser = resolveLoginBrowser(browserId, { environment, fileSystem });
      if (browser.id === 'system') {
        if (browserProfileId) throw codedError('기본 브라우저에는 사용자를 지정할 수 없습니다.', 'LOGIN_BROWSER_PROFILE_NOT_ALLOWED');
        try { await shell.openExternal(url); }
        catch (error) { throw codedError('기본 로그인 브라우저를 실행하지 못했습니다.', 'LOGIN_BROWSER_LAUNCH_FAILED', error); }
      } else if (browser.id === 'windows-picker') {
        if (browserProfileId) throw codedError('Windows 브라우저 선택에는 사용자를 지정할 수 없습니다.', 'LOGIN_BROWSER_PROFILE_NOT_ALLOWED');
        const picker = resolveWindowsApplicationPicker(launcherOptions);
        const ownerWindowHandle = normalizeOwnerWindowHandle(getOwnerWindowHandle());
        await openWindowsApplicationPicker(spawn, picker, url, ownerWindowHandle, signal);
      } else {
        const args = [];
        if (browserProfileId) {
          const profile = resolveProfileToken(browser.id, browserProfileId, launcherOptions, tokenSecret);
          args.push(`--profile-directory=${profile.id}`, '--ignore-profile-directory-if-not-exists');
        }
        args.push(url);
        await spawnBrowser(spawn, browser.executablePath, args);
      }
      return { browserId: browser.id, ...(browserProfileId ? { browserProfileId } : {}) };
    }
  });
}

module.exports = {
  LOGIN_BROWSER_IDS,
  LOGIN_BROWSER_LABELS,
  standardBrowserCandidates,
  standardChromiumUserDataRoots,
  standardPowerShellCandidate,
  normalizeBrowserId,
  resolveLoginBrowser,
  listLoginBrowsers,
  normalizeProfileDirectory,
  listLoginBrowserProfiles,
  resolveLoginBrowserProfile,
  profileToken,
  publicLoginBrowserProfiles,
  resolveProfileToken,
  resolveWindowsApplicationPicker,
  normalizeOwnerWindowHandle,
  validateOAuthAuthorizationUrl,
  createLoginBrowserLauncher
};
