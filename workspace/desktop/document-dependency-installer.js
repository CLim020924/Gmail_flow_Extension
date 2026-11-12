'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Dependencies = require('./document-dependencies');
const dependencyManifest = require('./document-dependency-manifest');

const packagedVendor = process.resourcesPath
  ? path.join(process.resourcesPath, 'vendor', 'node_modules', 'jszip')
  : '';
const vendorModulesPath = packagedVendor && nodeFs.existsSync(packagedVendor)
  ? path.dirname(packagedVendor)
  : path.join(__dirname, '..', 'vendor', 'node_modules');
const JSZip = require(path.join(vendorModulesPath, 'jszip'));

const LIBREOFFICE_PACKAGE_ID = 'TheDocumentFoundation.LibreOffice';
const LIBREOFFICE_VERSION = dependencyManifest.applications.libreOffice.wingetVersion;
const LIBREOFFICE_INSTALLER_SHA256 = dependencyManifest.applications.libreOffice.installerSha256;
const LIBREOFFICE_COMMAND = 'winget';
const LIBREOFFICE_SHOW_ARGUMENTS = Object.freeze([
  'show', '--id', LIBREOFFICE_PACKAGE_ID, '--exact', '--version', LIBREOFFICE_VERSION,
  '--source', 'winget', '--architecture', 'x64', '--installer-type', 'msi',
  '--accept-source-agreements', '--disable-interactivity'
]);
const LIBREOFFICE_ARGUMENTS = Object.freeze([
  'install', '--id', LIBREOFFICE_PACKAGE_ID, '--exact', '--version', LIBREOFFICE_VERSION, '--source', 'winget', '--silent',
  '--accept-package-agreements', '--accept-source-agreements'
]);

const RHWP_PINNED_RELEASE = Object.freeze({
  version: '0.8.4',
  platform: 'win32',
  architecture: 'x64',
  fileName: 'rhwp-v0.8.4-windows-x86_64.zip',
  url: 'https://github.com/edwardkim/rhwp/releases/download/v0.8.4/rhwp-v0.8.4-windows-x86_64.zip',
  sha256: 'e65b3e220573b18e1588768c5a16684eb89b2daf2488768575444cb83cd1b8c6',
  executableSha256: '56c26d809b1e09310b34c6c8449eacf97b8dd00b164aa25262e3c08f99f1093d'
});

const OFFICIAL_INSTALLER_URLS = Object.freeze({
  officePowerPoint: dependencyManifest.applications.officePowerPoint.officialInstallerUrl,
  officeWord: dependencyManifest.applications.officeWord.officialInstallerUrl,
  officeExcel: dependencyManifest.applications.officeExcel.officialInstallerUrl,
  hancomWriter: dependencyManifest.applications.hancomWriter.officialInstallerUrl,
  hancomCell: dependencyManifest.applications.hancomCell.officialInstallerUrl
});
const HANCOM_AUTOMATION_GUIDE_URL = Dependencies.HANCOM_AUTOMATION_GUIDE_URL;

const OFFICIAL_FONT_SOURCE_URLS = Object.freeze(Object.fromEntries(
  Object.entries(Dependencies.OFFICIAL_FONT_SOURCES).map(([sourceId, source]) => [sourceId, source.url])
));

const KOREAN_FONTS_CAPABILITY = Dependencies.WINDOWS_KOREAN_FONT_CAPABILITY;
const KOREAN_FONTS_COMMAND = 'powershell.exe';
const KOREAN_FONTS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  `$capabilityName = '${KOREAN_FONTS_CAPABILITY}'`,
  '$restartNeeded = $false',
  '$current = Get-WindowsCapability -Online -Name $capabilityName',
  "if ($current.State -ne 'Installed') {",
  '  $result = Add-WindowsCapability -Online -Name $capabilityName',
  '  $restartNeeded = $result.RestartNeeded -eq $true',
  '}',
  '$verified = Get-WindowsCapability -Online -Name $capabilityName',
  "if ($verified.State -ne 'Installed') { throw 'Windows capability verification failed.' }",
  'if ($restartNeeded) { exit 3010 }',
  'exit 0'
].join('\n');

function encodePowerShellScript(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

const KOREAN_FONTS_ARGUMENTS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  encodePowerShellScript(KOREAN_FONTS_SCRIPT)
]);

const TRUSTED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'fonts.gstatic.com'
]);
const MAX_REDIRECTS = 5;
const NETWORK_TIMEOUT_MS = 120_000;
const RHWP_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const RHWP_MAX_ARCHIVE_ENTRIES = 1_024;
const RHWP_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const RHWP_MAX_EXTRACTED_BYTES = 384 * 1024 * 1024;
const FONT_MAX_DOWNLOAD_BYTES = 96 * 1024 * 1024;
const LICENSE_MAX_DOWNLOAD_BYTES = 1024 * 1024;
const INSTALL_MARKER_FILE = '.cmoe-rhwp-runtime.json';
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_KEY_FIELDS = new Set([
  'productkey', 'licensekey', 'activationkey', 'serialnumber', 'productserial'
]);

class DocumentDependencyInstallError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'DocumentDependencyInstallError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function installError(code, message, cause) {
  return new DocumentDependencyInstallError(code, message, cause);
}

function assertObject(value, code = 'ACTION_INVALID', message = '의존성 작업 정보가 올바르지 않습니다.') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw installError(code, message);
  return value;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function assertNoProductKeys(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_FIELDS.has(key.toLocaleLowerCase('en-US'))) {
      throw installError('PRODUCT_KEY_FORBIDDEN', '제품 키나 활성화 키를 자동으로 찾거나 전달할 수 없습니다.');
    }
    assertNoProductKeys(child, seen);
  }
}

function assertExplicitConsent(action, options) {
  if (action.requiresUserConsent !== true || options?.userConfirmed !== true) {
    throw installError('USER_CONSENT_REQUIRED', '이 작업은 사용자가 현재 요청에서 명시적으로 동의해야 합니다.');
  }
}

function buildElevatedPowerShellInvocation(command, args) {
  if (String(command).toLocaleLowerCase('en-US') !== KOREAN_FONTS_COMMAND
    || !exactArray(args, KOREAN_FONTS_ARGUMENTS)) {
    throw installError('ELEVATED_COMMAND_NOT_APPROVED', '코드에 고정된 Windows 글꼴 준비 명령만 관리자 권한으로 실행할 수 있습니다.');
  }
  const innerArgumentList = KOREAN_FONTS_ARGUMENTS
    .map((argument) => `'${argument.replace(/'/g, "''")}'`)
    .join(', ');
  const elevationScript = [
    "$ErrorActionPreference = 'Stop'",
    `$innerArguments = @(${innerArgumentList})`,
    'try {',
    `  $process = Start-Process -FilePath '${KOREAN_FONTS_COMMAND}' -ArgumentList $innerArguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    '  if ($null -eq $process) { exit 1 }',
    '  exit [int]$process.ExitCode',
    '} catch {',
    '  if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }',
    '  throw',
    '}'
  ].join('\n');
  return Object.freeze({
    command: 'powershell.exe',
    args: Object.freeze([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(elevationScript)
    ])
  });
}

function defaultRunner(command, args, options = {}) {
  let executable = command;
  let executableArguments = [...args];
  if (options.requiresAdministrator === true) {
    const elevated = buildElevatedPowerShellInvocation(command, args);
    executable = elevated.command;
    executableArguments = [...elevated.args];
  }
  return new Promise((resolve, reject) => {
    execFile(executable, executableArguments, {
      windowsHide: true,
      shell: false,
      timeout: options.timeoutMs || 15 * 60 * 1000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error && Number.isInteger(error.code)) {
        return resolve({ code: error.code, stdout, stderr, error });
      }
      if (error) return reject(error);
      resolve({ code: 0, stdout, stderr });
    });
  });
}

function runnerFunction(runner) {
  if (typeof runner === 'function') return runner;
  if (runner && typeof runner.run === 'function') return runner.run.bind(runner);
  return defaultRunner;
}

function fsPromises(fsImpl) {
  const promises = fsImpl?.promises || fsImpl;
  if (!promises || typeof promises.mkdir !== 'function' || typeof promises.writeFile !== 'function'
    || typeof promises.rename !== 'function' || typeof promises.rm !== 'function'
    || typeof promises.readFile !== 'function' || typeof promises.stat !== 'function') {
    throw installError('FS_ADAPTER_INVALID', '파일 시스템 어댑터가 필요한 안전한 비동기 메서드를 제공하지 않습니다.');
  }
  return promises;
}

function normalizeExitCode(result) {
  if (typeof result === 'number') return result;
  if (!result || typeof result !== 'object') return 0;
  if (Number.isInteger(result.exitCode)) return result.exitCode;
  if (Number.isInteger(result.code)) return result.code;
  return 0;
}

async function runChecked(run, command, args, options, failureCode) {
  let result;
  try {
    result = await run(command, [...args], { ...options, shell: false });
  } catch (error) {
    throw installError(failureCode, '외부 준비 작업을 완료하지 못했습니다.', error);
  }
  const exitCode = normalizeExitCode(result);
  const successExitCodes = Array.isArray(options?.successExitCodes) && options.successExitCodes.length
    ? options.successExitCodes
    : [0];
  if (!successExitCodes.includes(exitCode)) {
    throw installError(failureCode, `외부 준비 작업이 종료 코드 ${exitCode}(으)로 실패했습니다.`);
  }
  return { ...(result && typeof result === 'object' ? result : {}), exitCode };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
  return key ? headers[key] : null;
}

function validateTransportUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch (_) { throw installError('DOWNLOAD_URL_INVALID', '다운로드 주소가 올바르지 않습니다.'); }
  const hostname = parsed.hostname.toLocaleLowerCase('en-US').replace(/\.$/, '');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash
    || !TRUSTED_DOWNLOAD_HOSTS.has(hostname)) {
    throw installError('DOWNLOAD_HOST_NOT_ALLOWED', '허용된 HTTPS 배포 호스트만 사용할 수 있습니다.');
  }
  if (parsed.href.length > 8_192 || /[\\\u0000-\u001f\u007f]/.test(parsed.pathname)
    || /%(?:2e|2f|5c|25)/i.test(parsed.pathname)
    || /(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(parsed.pathname)) {
    throw installError('DOWNLOAD_PATH_INVALID', '다운로드 경로가 안전하지 않습니다.');
  }
  return parsed;
}

async function readResponseBuffer(response, maximumBytes) {
  const declaredValue = headerValue(response.headers, 'content-length');
  if (declaredValue != null && declaredValue !== '') {
    if (!/^\d+$/.test(String(declaredValue))) {
      throw installError('DOWNLOAD_LENGTH_INVALID', '다운로드 크기 헤더가 올바르지 않습니다.');
    }
    const declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared) || declared <= 0 || declared > maximumBytes) {
      throw installError('DOWNLOAD_TOO_LARGE', '다운로드 파일이 허용된 크기를 초과합니다.');
    }
  }

  const chunks = [];
  let total = 0;
  const append = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maximumBytes) throw installError('DOWNLOAD_TOO_LARGE', '다운로드 파일이 허용된 크기를 초과합니다.');
    chunks.push(chunk);
  };

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) append(chunk);
  } else if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      append(value);
    }
  } else if (typeof response.arrayBuffer === 'function') {
    append(await response.arrayBuffer());
  } else {
    throw installError('DOWNLOAD_BODY_INVALID', '다운로드 응답 본문을 읽을 수 없습니다.');
  }
  if (!total) throw installError('DOWNLOAD_EMPTY', '다운로드 파일이 비어 있습니다.');
  return Buffer.concat(chunks, total);
}

async function downloadBuffer(fetchImpl, initialUrl, maximumBytes) {
  if (typeof fetchImpl !== 'function') throw installError('FETCH_ADAPTER_REQUIRED', '다운로드 어댑터가 필요합니다.');
  let current = validateTransportUrl(initialUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      let response;
      try {
        response = await fetchImpl(current.href, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/octet-stream' }
        });
      } catch (error) {
        throw installError('DOWNLOAD_FAILED', '검증된 배포 파일을 다운로드하지 못했습니다.', error);
      }
      const status = Number(response?.status);
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects === MAX_REDIRECTS) throw installError('DOWNLOAD_REDIRECT_LIMIT', '다운로드 리디렉션이 너무 많습니다.');
        const location = headerValue(response.headers, 'location');
        if (!location) throw installError('DOWNLOAD_REDIRECT_INVALID', '다운로드 리디렉션 주소가 없습니다.');
        current = validateTransportUrl(new URL(location, current).href);
        continue;
      }
      if (status !== 200) throw installError('DOWNLOAD_HTTP_ERROR', `다운로드 서버가 HTTP ${status || 0}을 반환했습니다.`);
      if (response.url) validateTransportUrl(response.url);
      return readResponseBuffer(response, maximumBytes);
    }
    throw installError('DOWNLOAD_REDIRECT_LIMIT', '다운로드 리디렉션이 너무 많습니다.');
  } finally {
    clearTimeout(timer);
  }
}

async function downloadVerifiedAsset(fetchImpl, asset, maximumBytes, digestSha256 = sha256Buffer) {
  assertObject(asset, 'ASSET_INVALID', '고정 asset 정보가 올바르지 않습니다.');
  const expected = Dependencies.validateSha256(asset.sha256);
  const data = await downloadBuffer(fetchImpl, asset.url, maximumBytes);
  const actual = String(await digestSha256(data)).toLocaleLowerCase('en-US');
  if (actual !== expected) {
    throw installError('ASSET_HASH_MISMATCH', '다운로드 파일의 SHA-256이 고정 manifest와 일치하지 않습니다.');
  }
  return data;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw installError('RHWP_ZIP_INVALID', 'rHWP ZIP의 중앙 디렉터리를 찾을 수 없습니다.');
}

function safeArchivePath(rawName) {
  if (typeof rawName !== 'string' || !rawName || rawName.length > 1_024 || /\u0000/.test(rawName)) {
    throw installError('RHWP_ZIP_PATH_INVALID', 'ZIP 항목 이름이 올바르지 않습니다.');
  }
  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    throw installError('RHWP_ZIP_SLIP', 'ZIP에 절대 경로가 포함되어 있습니다.');
  }
  const isDirectory = normalized.endsWith('/');
  const trimmed = isDirectory ? normalized.slice(0, -1) : normalized;
  const segments = trimmed.split('/');
  if (!trimmed || segments.length > 24 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw installError('RHWP_ZIP_SLIP', 'ZIP에 상위 경로나 빈 경로가 포함되어 있습니다.');
  }
  for (const segment of segments) {
    if (segment.length > 200 || /[<>:"|?*\u0000-\u001f\u007f]/.test(segment)
      || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment)) {
      throw installError('RHWP_ZIP_PATH_INVALID', 'ZIP에 Windows에서 안전하지 않은 경로가 포함되어 있습니다.');
    }
  }
  return { relativePath: segments.join('/'), isDirectory };
}

function preflightRhwpZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > RHWP_MAX_DOWNLOAD_BYTES) {
    throw installError('RHWP_ZIP_INVALID', 'rHWP ZIP 크기가 올바르지 않습니다.');
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
    || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw installError('RHWP_ZIP_UNSUPPORTED', '다중 디스크 또는 ZIP64 rHWP archive는 설치하지 않습니다.');
  }
  if (!totalEntries || totalEntries > RHWP_MAX_ARCHIVE_ENTRIES) {
    throw installError('RHWP_ZIP_ENTRY_LIMIT', 'rHWP ZIP 항목 수가 허용 범위를 벗어났습니다.');
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    throw installError('RHWP_ZIP_INVALID', 'rHWP ZIP 중앙 디렉터리 범위가 올바르지 않습니다.');
  }

  const names = new Set();
  let expandedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw installError('RHWP_ZIP_INVALID', 'rHWP ZIP 중앙 디렉터리 항목이 손상되었습니다.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || (flags & 0x0001)) {
      throw installError('RHWP_ZIP_INVALID', '암호화되었거나 손상된 ZIP 항목은 설치하지 않습니다.');
    }
    const nameBuffer = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawName = nameBuffer.toString((flags & 0x0800) ? 'utf8' : 'latin1');
    const safe = safeArchivePath(rawName);
    const key = safe.relativePath.normalize('NFKC').toLocaleLowerCase('en-US');
    if (names.has(key)) throw installError('RHWP_ZIP_DUPLICATE', 'ZIP에 대소문자만 다른 중복 경로가 있습니다.');
    names.add(key);
    if (!safe.isDirectory) {
      if (uncompressed > RHWP_MAX_ENTRY_BYTES) throw installError('RHWP_ZIP_BOMB', 'ZIP 단일 항목이 너무 큽니다.');
      expandedBytes += uncompressed;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > RHWP_MAX_EXTRACTED_BYTES) {
        throw installError('RHWP_ZIP_BOMB', 'ZIP 압축 해제 크기가 허용 범위를 초과합니다.');
      }
    }
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) {
    throw installError('RHWP_ZIP_INVALID', 'rHWP ZIP 중앙 디렉터리 크기가 일치하지 않습니다.');
  }
  return { entryCount: totalEntries, expandedBytes };
}

function unixFileType(entry) {
  let permissions = entry?.unixPermissions;
  if (typeof permissions === 'string') permissions = Number.parseInt(permissions, 8);
  return Number.isInteger(permissions) ? (permissions & 0o170000) : 0;
}

async function readZipEntry(entry, maximumBytes) {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream('nodebuffer');
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream.destroy?.();
      reject(error);
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maximumBytes) return fail(installError('RHWP_ZIP_BOMB', 'ZIP 항목의 실제 압축 해제 크기가 너무 큽니다.'));
      chunks.push(Buffer.from(chunk));
    });
    stream.on('error', (error) => fail(installError('RHWP_ZIP_INVALID', 'ZIP 항목을 압축 해제하지 못했습니다.', error)));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, bytes));
    });
  });
}

async function loadSafeRhwpEntries(buffer) {
  preflightRhwpZip(buffer);
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  } catch (error) {
    throw installError('RHWP_ZIP_INVALID', 'rHWP ZIP을 읽을 수 없습니다.', error);
  }
  const entries = Object.values(archive.files);
  if (!entries.length || entries.length > RHWP_MAX_ARCHIVE_ENTRIES) {
    throw installError('RHWP_ZIP_ENTRY_LIMIT', 'rHWP ZIP 항목 수가 허용 범위를 벗어났습니다.');
  }
  const safeEntries = [];
  const names = new Set();
  let executableCount = 0;
  for (const entry of entries) {
    const originalName = typeof entry.unsafeOriginalName === 'string' ? entry.unsafeOriginalName : entry.name;
    const safe = safeArchivePath(originalName);
    const key = safe.relativePath.normalize('NFKC').toLocaleLowerCase('en-US');
    if (names.has(key)) throw installError('RHWP_ZIP_DUPLICATE', 'ZIP에 중복 경로가 있습니다.');
    names.add(key);
    if (unixFileType(entry) === 0o120000) throw installError('RHWP_ZIP_SYMLINK', 'ZIP 심볼릭 링크는 설치하지 않습니다.');
    if (!safe.isDirectory && path.posix.basename(safe.relativePath).toLocaleLowerCase('en-US') === 'rhwp.exe') {
      executableCount += 1;
    }
    if (safe.relativePath.toLocaleLowerCase('en-US') === INSTALL_MARKER_FILE.toLocaleLowerCase('en-US')) {
      throw installError('RHWP_ZIP_RESERVED_ENTRY', 'ZIP이 앱 설치 상태 파일을 덮어쓸 수 없습니다.');
    }
    safeEntries.push({ entry, ...safe });
  }
  if (executableCount !== 1) throw installError('RHWP_EXECUTABLE_INVALID', 'ZIP에는 정확히 하나의 rhwp.exe가 있어야 합니다.');
  return safeEntries;
}

async function exists(fsp, target) {
  try { await fsp.stat(target); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function installedRhwpInfo(fsp, target, digestSha256) {
  try {
    const marker = JSON.parse(await fsp.readFile(path.join(target, INSTALL_MARKER_FILE), 'utf8'));
    if (marker.version !== RHWP_PINNED_RELEASE.version || marker.sha256 !== RHWP_PINNED_RELEASE.sha256
      || (Object.hasOwn(marker, 'executableSha256') && marker.executableSha256 !== RHWP_PINNED_RELEASE.executableSha256)
      || marker.url !== RHWP_PINNED_RELEASE.url || typeof marker.executable !== 'string') return null;
    const executable = path.resolve(target, ...marker.executable.split('/'));
    if (!isWithin(target, executable)) return null;
    const stats = await fsp.stat(executable);
    if (!stats.isFile()) return null;
    const executableBytes = await fsp.readFile(executable);
    const executableDigest = String(await digestSha256(executableBytes)).toLocaleLowerCase('en-US');
    if (executableDigest !== RHWP_PINNED_RELEASE.executableSha256) return null;
    return { ...marker, executablePath: executable };
  } catch (_) {
    return null;
  }
}

async function installRhwpRuntime({ fsp, fetchImpl, userDataPath, digestSha256 }) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw installError('USER_DATA_PATH_INVALID', '절대 경로인 userDataPath가 필요합니다.');
  }
  const runtimeRoot = path.join(userDataPath, 'document-tools', 'runtimes', 'rhwp');
  const target = path.join(runtimeRoot, RHWP_PINNED_RELEASE.version);
  const existing = await installedRhwpInfo(fsp, target, digestSha256);
  if (existing) return { kind: 'rhwp', installed: true, alreadyInstalled: true, path: target, executablePath: existing.executablePath };
  if (await exists(fsp, target)) {
    throw installError('RHWP_INSTALL_CONFLICT', '기존 rHWP runtime 폴더가 검증된 설치 상태가 아닙니다.');
  }

  const archive = await downloadVerifiedAsset(fetchImpl, RHWP_PINNED_RELEASE, RHWP_MAX_DOWNLOAD_BYTES, digestSha256);
  const entries = await loadSafeRhwpEntries(archive);
  await fsp.mkdir(runtimeRoot, { recursive: true });
  const staging = path.join(runtimeRoot, `.installing-${RHWP_PINNED_RELEASE.version}-${crypto.randomUUID()}`);
  await fsp.mkdir(staging, { recursive: false });
  let executableRelativePath = null;
  let executableSha256 = null;
  let expandedBytes = 0;
  try {
    for (const item of entries) {
      const destination = path.resolve(staging, ...item.relativePath.split('/'));
      if (!isWithin(staging, destination)) throw installError('RHWP_ZIP_SLIP', 'ZIP 항목이 runtime 폴더를 벗어납니다.');
      if (item.isDirectory) {
        await fsp.mkdir(destination, { recursive: true });
        continue;
      }
      const remaining = RHWP_MAX_EXTRACTED_BYTES - expandedBytes;
      const data = await readZipEntry(item.entry, Math.min(RHWP_MAX_ENTRY_BYTES, remaining));
      expandedBytes += data.length;
      if (expandedBytes > RHWP_MAX_EXTRACTED_BYTES) throw installError('RHWP_ZIP_BOMB', 'ZIP 실제 압축 해제 크기가 너무 큽니다.');
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, data, { flag: 'wx' });
      if (path.basename(destination).toLocaleLowerCase('en-US') === 'rhwp.exe') {
        executableRelativePath = item.relativePath;
        executableSha256 = String(await digestSha256(data)).toLocaleLowerCase('en-US');
        if (executableSha256 !== RHWP_PINNED_RELEASE.executableSha256) {
          throw installError('RHWP_EXECUTABLE_HASH_MISMATCH', 'rHWP 실행 파일의 SHA-256이 고정 manifest와 일치하지 않습니다.');
        }
      }
    }
    const marker = {
      schemaVersion: 1,
      product: 'rhwp',
      version: RHWP_PINNED_RELEASE.version,
      url: RHWP_PINNED_RELEASE.url,
      sha256: RHWP_PINNED_RELEASE.sha256,
      executableSha256,
      executable: executableRelativePath
    };
    await fsp.writeFile(path.join(staging, INSTALL_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
    try {
      await fsp.rename(staging, target);
    } catch (error) {
      const winner = await installedRhwpInfo(fsp, target, digestSha256);
      if (!winner) throw installError('RHWP_ATOMIC_INSTALL_FAILED', 'rHWP runtime을 원자적으로 설치하지 못했습니다.', error);
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const installed = await installedRhwpInfo(fsp, target, digestSha256);
  if (!installed) throw installError('RHWP_INSTALL_VERIFY_FAILED', '설치된 rHWP runtime 검증에 실패했습니다.');
  return { kind: 'rhwp', installed: true, alreadyInstalled: false, path: target, executablePath: installed.executablePath };
}

function canonicalFontAction(action) {
  if (action.fontSubstitution !== false || action.exactAssetOnly !== true || action.scope !== 'user') {
    throw installError('FONT_SUBSTITUTION_FORBIDDEN', '정확한 공개 글꼴 asset만 설치할 수 있으며 글꼴 대체는 허용되지 않습니다.');
  }
  const manifestEntry = dependencyManifest.fonts.find((entry) => entry.family === action.family);
  if (!manifestEntry) throw installError('FONT_ACTION_NOT_APPROVED', '코드에 고정된 공개 글꼴만 설치할 수 있습니다.');
  const expected = Dependencies.planPerUserFontInstall(action.family, manifestEntry);
  const fields = ['family', 'version', 'license', 'copyright', 'scope', 'exactAssetOnly', 'fontSubstitution'];
  const sortValue = (value) => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  };
  const sameData = (left, right) => JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
  if (fields.some((field) => action[field] !== expected[field])
    || !sameData(action.licenseAsset, expected.licenseAsset)
    || !sameData(action.files, expected.files)) {
    throw installError('FONT_ACTION_NOT_APPROVED', '공개 글꼴 action이 고정 manifest와 일치하지 않습니다.');
  }
  return expected;
}

function decodeSfntName(buffer, platformId) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '';
  if (platformId === 0 || platformId === 3) {
    if (buffer.length % 2 !== 0) return '';
    const littleEndian = Buffer.allocUnsafe(buffer.length);
    for (let index = 0; index < buffer.length; index += 2) {
      littleEndian[index] = buffer[index + 1];
      littleEndian[index + 1] = buffer[index];
    }
    return littleEndian.toString('utf16le').replace(/\u0000/g, '').trim();
  }
  if (platformId === 1) return buffer.toString('latin1').replace(/\u0000/g, '').trim();
  return '';
}

function sfntFamilyNames(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buffer.length < 12) throw installError('FONT_SFNT_INVALID', '글꼴 파일의 SFNT 헤더가 올바르지 않습니다.');
  const signature = buffer.subarray(0, 4).toString('latin1');
  const scalar = buffer.readUInt32BE(0);
  if (scalar !== 0x00010000 && signature !== 'OTTO' && signature !== 'true') {
    throw installError('FONT_SFNT_INVALID', '고정 asset이 TrueType/OpenType 글꼴이 아닙니다.');
  }
  const tableCount = buffer.readUInt16BE(4);
  if (!tableCount || tableCount > 256 || 12 + (tableCount * 16) > buffer.length) {
    throw installError('FONT_SFNT_INVALID', '글꼴 테이블 디렉터리가 올바르지 않습니다.');
  }
  let nameOffset = -1;
  let nameLength = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + (index * 16);
    if (buffer.subarray(recordOffset, recordOffset + 4).toString('latin1') !== 'name') continue;
    nameOffset = buffer.readUInt32BE(recordOffset + 8);
    nameLength = buffer.readUInt32BE(recordOffset + 12);
    break;
  }
  if (nameOffset < 0 || nameLength < 6 || nameOffset + nameLength > buffer.length) {
    throw installError('FONT_SFNT_INVALID', '글꼴 이름 테이블이 없거나 손상되었습니다.');
  }
  const recordCount = buffer.readUInt16BE(nameOffset + 2);
  const stringStorageOffset = buffer.readUInt16BE(nameOffset + 4);
  const recordsEnd = nameOffset + 6 + (recordCount * 12);
  const stringsStart = nameOffset + stringStorageOffset;
  const tableEnd = nameOffset + nameLength;
  if (!recordCount || recordCount > 4_096 || recordsEnd > tableEnd
    || stringsStart < recordsEnd || stringsStart > tableEnd) {
    throw installError('FONT_SFNT_INVALID', '글꼴 이름 레코드 범위가 올바르지 않습니다.');
  }
  const names = new Set();
  for (let index = 0; index < recordCount; index += 1) {
    const recordOffset = nameOffset + 6 + (index * 12);
    const platformId = buffer.readUInt16BE(recordOffset);
    const nameId = buffer.readUInt16BE(recordOffset + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = buffer.readUInt16BE(recordOffset + 8);
    const relativeOffset = buffer.readUInt16BE(recordOffset + 10);
    const start = stringsStart + relativeOffset;
    const end = start + length;
    if (!length || start < stringsStart || end > tableEnd) continue;
    const name = decodeSfntName(buffer.subarray(start, end), platformId);
    if (name) names.add(name.normalize('NFKC'));
  }
  if (!names.size) throw installError('FONT_SFNT_INVALID', '글꼴 이름 테이블에서 가족 이름을 확인할 수 없습니다.');
  return [...names];
}

function verifySfntFamily(data, expectedFamily) {
  const expectedKey = String(expectedFamily).normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const names = sfntFamilyNames(data);
  if (!names.some((name) => name.trim().toLocaleLowerCase('en-US') === expectedKey)) {
    throw installError('FONT_FAMILY_MISMATCH', `다운로드 글꼴의 내부 가족 이름이 ${expectedFamily}와(과) 일치하지 않습니다.`);
  }
  return names;
}

function textOutput(result) {
  if (typeof result?.stdout === 'string') return result.stdout;
  if (Buffer.isBuffer(result?.stdout) || result?.stdout instanceof Uint8Array) {
    return Buffer.from(result.stdout).toString('utf8');
  }
  return '';
}

function fontRegistryQueryPowerShellArguments(registry) {
  const payload = Buffer.from(JSON.stringify({ key: registry.key, valueName: registry.valueName }), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$payload = ConvertFrom-Json -InputObject $payloadJson',
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey([string]$payload.key, $false)',
    'if ($null -eq $key) { exit 3 }',
    'try {',
    '  $value = $key.GetValue([string]$payload.valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '  if ($null -eq $value) { exit 3 }',
    '  if ($key.GetValueKind([string]$payload.valueName) -ne [Microsoft.Win32.RegistryValueKind]::String) { throw "Registry value type is not REG_SZ." }',
    '  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$value))',
    '  [Console]::Out.Write($encoded)',
    '} finally {',
    '  $key.Dispose()',
    '}'
  ].join('\n');
  return Object.freeze([
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(script)
  ]);
}

function fontRegistryMutationPowerShellArguments(operation, registry, expectedTarget) {
  if (!['add', 'remove'].includes(operation) || typeof expectedTarget !== 'string' || !path.isAbsolute(expectedTarget)) {
    throw installError('FONT_REGISTRY_ACTION_INVALID', '사용자 글꼴 레지스트리 작업이 올바르지 않습니다.');
  }
  const payload = Buffer.from(JSON.stringify({
    operation,
    key: registry.key,
    valueName: registry.valueName,
    expectedTarget
  }), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$payload = ConvertFrom-Json -InputObject $payloadJson',
    "$write = $payload.operation -eq 'add'",
    'if ($write) {',
    '  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey([string]$payload.key, $true)',
    '} else {',
    '  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey([string]$payload.key, $true)',
    '}',
    "if ($null -eq $key) { if ($write) { throw 'Registry key could not be opened.' } else { [Console]::Out.Write('noop'); exit 0 } }",
    'try {',
    '  $current = $key.GetValue([string]$payload.valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '  if ($write) {',
    '    if ($null -eq $current) {',
    '      $key.SetValue([string]$payload.valueName, [string]$payload.expectedTarget, [Microsoft.Win32.RegistryValueKind]::String)',
    "      [Console]::Out.Write('created')",
    '    } else {',
    "      if ($key.GetValueKind([string]$payload.valueName) -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'Registry value type conflict.' }",
    "      if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$current, [string]$payload.expectedTarget)) { throw 'Registry value data conflict.' }",
    "      [Console]::Out.Write('existing')",
    '    }',
    '  } else {',
    '    if ($null -ne $current -and $key.GetValueKind([string]$payload.valueName) -eq [Microsoft.Win32.RegistryValueKind]::String -and [StringComparer]::OrdinalIgnoreCase.Equals([string]$current, [string]$payload.expectedTarget)) {',
    '      $key.DeleteValue([string]$payload.valueName, $false)',
    "      [Console]::Out.Write('removed')",
    "    } else { [Console]::Out.Write('noop') }",
    '  }',
    '} finally {',
    '  $key.Dispose()',
    '}'
  ].join('\n');
  return Object.freeze([
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(script)
  ]);
}

async function queryUserFontRegistry(run, registry, expectedTarget) {
  let result;
  try {
    result = await run(KOREAN_FONTS_COMMAND, fontRegistryQueryPowerShellArguments(registry), {
      windowsHide: true,
      requiresAdministrator: false,
      elevation: 'none',
      operation: 'font-registry-query',
      shell: false
    });
  } catch (error) {
    if (Number(error?.code) === 3) return { exists: false };
    throw installError('FONT_REGISTRY_QUERY_FAILED', '기존 사용자 글꼴 등록 상태를 확인하지 못했습니다.', error);
  }
  const exitCode = normalizeExitCode(result);
  if (exitCode === 3) return { exists: false };
  if (exitCode !== 0) {
    throw installError('FONT_REGISTRY_QUERY_FAILED', `사용자 글꼴 등록 확인이 종료 코드 ${exitCode}(으)로 실패했습니다.`);
  }
  const encodedValue = textOutput(result).trim();
  if (!encodedValue || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedValue) || encodedValue.length % 4 !== 0) {
    throw installError('FONT_REGISTRY_CONFLICT', '같은 이름의 기존 글꼴 등록 값을 안전하게 확인할 수 없습니다.');
  }
  const existing = Buffer.from(encodedValue, 'base64').toString('utf8');
  const normalize = (value) => path.win32.normalize(String(value)).toLocaleLowerCase('en-US');
  if (normalize(existing) !== normalize(expectedTarget)) {
    throw installError('FONT_REGISTRY_CONFLICT', '같은 이름의 다른 사용자 글꼴 등록이 있어 덮어쓰지 않았습니다.');
  }
  return { exists: true, value: existing };
}

function fontRuntimePowerShellArguments(operation, fontPaths) {
  if (!['add', 'remove'].includes(operation) || !Array.isArray(fontPaths) || !fontPaths.length
    || fontPaths.some((fontPath) => typeof fontPath !== 'string' || !path.isAbsolute(fontPath))) {
    throw installError('FONT_RUNTIME_ACTION_INVALID', '글꼴 런타임 등록 작업이 올바르지 않습니다.');
  }
  const payload = Buffer.from(JSON.stringify({ operation, paths: fontPaths }), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `Add-Type -TypeDefinition @'`,
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class CmoeFontNative {',
    '  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern int AddFontResourceExW(string fileName, uint flags, IntPtr reserved);',
    '  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  [return: MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool RemoveFontResourceExW(string fileName, uint flags, IntPtr reserved);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);',
    '}',
    `'@`,
    `$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$payload = ConvertFrom-Json -InputObject $payloadJson',
    '$changed = New-Object System.Collections.Generic.List[string]',
    'try {',
    '  foreach ($fontPath in @($payload.paths)) {',
    "    $resolved = [IO.Path]::GetFullPath([string]$fontPath)",
    "    if ($payload.operation -eq 'add') {",
    "      if (-not [IO.File]::Exists($resolved)) { throw 'Font file not found.' }",
    "      if ([CmoeFontNative]::AddFontResourceExW($resolved, 0, [IntPtr]::Zero) -le 0) { throw 'AddFontResourceExW failed.' }",
    '      $changed.Add($resolved)',
    '    } else {',
    '      [void][CmoeFontNative]::RemoveFontResourceExW($resolved, 0, [IntPtr]::Zero)',
    '    }',
    '  }',
    '} catch {',
    "  if ($payload.operation -eq 'add') {",
    '    foreach ($addedPath in $changed) { [void][CmoeFontNative]::RemoveFontResourceExW($addedPath, 0, [IntPtr]::Zero) }',
    '    $rollbackBroadcastResult = [IntPtr]::Zero',
    '    [void][CmoeFontNative]::SendMessageTimeoutW([IntPtr]0xffff, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$rollbackBroadcastResult)',
    '  }',
    '  throw',
    '}',
    '$broadcastResult = [IntPtr]::Zero',
    '[void][CmoeFontNative]::SendMessageTimeoutW([IntPtr]0xffff, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$broadcastResult)'
  ].join('\n');
  return Object.freeze([
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(script)
  ]);
}

async function writeExactFile(fsp, target, data, expectedSha256, digestSha256) {
  if (await exists(fsp, target)) {
    const current = await fsp.readFile(target);
    if (String(await digestSha256(current)).toLocaleLowerCase('en-US') === expectedSha256) return false;
    throw installError('FONT_FILE_CONFLICT', '같은 이름의 다른 글꼴 파일이 이미 있어 덮어쓰지 않았습니다.');
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.cmoe-${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, data, { flag: 'wx' });
  try {
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    if (await exists(fsp, target)) {
      const current = await fsp.readFile(target);
      if (String(await digestSha256(current)).toLocaleLowerCase('en-US') === expectedSha256) return false;
    }
    throw installError('FONT_ATOMIC_INSTALL_FAILED', '글꼴 파일을 원자적으로 설치하지 못했습니다.', error);
  }
  return true;
}

async function installOpenFont({ action, fsp, fetchImpl, run, userDataPath, localAppDataPath, digestSha256 }) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)
    || typeof localAppDataPath !== 'string' || !path.isAbsolute(localAppDataPath)) {
    throw installError('FONT_PATH_INVALID', '공개 글꼴 설치에는 절대 userDataPath와 localAppDataPath가 필요합니다.');
  }
  const expected = canonicalFontAction(action);
  const licenseData = await downloadVerifiedAsset(fetchImpl, expected.licenseAsset, LICENSE_MAX_DOWNLOAD_BYTES, digestSha256);
  const downloadedFonts = [];
  for (const file of expected.files) {
    const data = await downloadVerifiedAsset(fetchImpl, file.asset, FONT_MAX_DOWNLOAD_BYTES, digestSha256);
    verifySfntFamily(data, expected.family);
    downloadedFonts.push({ file, data });
  }

  const fontDirectory = path.join(localAppDataPath, 'Microsoft', 'Windows', 'Fonts');
  const licenseDirectory = path.join(userDataPath, 'document-tools', 'font-licenses', expected.family, expected.version);
  const licensePath = path.join(licenseDirectory, expected.licenseAsset.fileName);
  const notice = {
    schemaVersion: 1,
    family: expected.family,
    version: expected.version,
    license: expected.license,
    copyright: expected.copyright,
    licenseAsset: expected.licenseAsset,
    fontAssets: expected.files.map((file) => file.asset),
    fontSubstitution: false
  };
  const noticePath = path.join(licenseDirectory, 'NOTICE.json');
  const noticeData = Buffer.from(`${JSON.stringify(notice, null, 2)}\n`, 'utf8');
  const installedFiles = downloadedFonts.map((item) => ({
    ...item,
    target: path.join(fontDirectory, item.file.asset.fileName),
    registry: item.file.registry,
    created: false,
    registryExists: false
  }));
  for (const installed of installedFiles) {
    const { registry } = installed;
    if (registry.hive !== 'HKCU' || registry.key !== Dependencies.WINDOWS_USER_FONT_REGISTRY_KEY) {
      throw installError('FONT_REGISTRY_INVALID', '사용자별 Windows 글꼴 레지스트리만 사용할 수 있습니다.');
    }
    installed.registryExists = (await queryUserFontRegistry(run, registry, installed.target)).exists;
  }

  const createdPaths = [];
  const createdRegistryValues = [];
  let runtimeRegistered = false;
  try {
    for (const installed of installedFiles) {
      installed.created = await writeExactFile(
        fsp,
        installed.target,
        installed.data,
        installed.file.asset.sha256,
        digestSha256
      );
      if (installed.created) createdPaths.push(installed.target);
    }

    await fsp.mkdir(licenseDirectory, { recursive: true });
    if (await writeExactFile(
      fsp,
      licensePath,
      licenseData,
      expected.licenseAsset.sha256,
      digestSha256
    )) createdPaths.push(licensePath);
    if (await exists(fsp, noticePath)) {
      const current = await fsp.readFile(noticePath);
      if (!Buffer.from(current).equals(noticeData)) {
        throw installError('FONT_NOTICE_CONFLICT', '기존 글꼴 라이선스 고지가 고정 manifest와 다릅니다.');
      }
    } else if (await writeExactFile(fsp, noticePath, noticeData, await digestSha256(noticeData), digestSha256)) {
      createdPaths.push(noticePath);
    }

    for (const installed of installedFiles) {
      const { registry } = installed;
      const registrationResult = await runChecked(run, KOREAN_FONTS_COMMAND, fontRegistryMutationPowerShellArguments(
        'add',
        registry,
        installed.target
      ), {
        windowsHide: true,
        requiresAdministrator: false,
        elevation: 'none',
        operation: 'font-registry-add'
      }, 'FONT_REGISTRATION_FAILED');
      const registrationState = textOutput(registrationResult).trim();
      if (!['created', 'existing'].includes(registrationState)) {
        throw installError('FONT_REGISTRATION_FAILED', '사용자 글꼴 레지스트리 등록 결과를 확인하지 못했습니다.');
      }
      if (registrationState === 'created') createdRegistryValues.push({ registry, target: installed.target });
    }

    await runChecked(run, KOREAN_FONTS_COMMAND, fontRuntimePowerShellArguments(
      'add',
      installedFiles.map((item) => item.target)
    ), {
      windowsHide: true,
      requiresAdministrator: false,
      elevation: 'none',
      operation: 'font-runtime-register'
    }, 'FONT_RUNTIME_REGISTRATION_FAILED');
    runtimeRegistered = true;

    return {
      kind: 'font',
      installed: true,
      alreadyInstalled: createdPaths.length === 0 && createdRegistryValues.length === 0,
      family: expected.family,
      files: installedFiles.map((item) => item.target),
      licensePath,
      noticePath,
      copyright: expected.copyright,
      fontSubstitution: false,
      runtimeRegistered: true,
      registryValuesCreated: createdRegistryValues.length,
      applicationRestartRecommended: true
    };
  } catch (error) {
    if (runtimeRegistered) {
      await run(KOREAN_FONTS_COMMAND, fontRuntimePowerShellArguments(
        'remove',
        installedFiles.map((item) => item.target)
      ), {
        windowsHide: true,
        requiresAdministrator: false,
        elevation: 'none',
        operation: 'font-runtime-rollback',
        shell: false
      }).catch(() => {});
    }
    for (const createdRegistry of [...createdRegistryValues].reverse()) {
      await run(KOREAN_FONTS_COMMAND, fontRegistryMutationPowerShellArguments(
        'remove',
        createdRegistry.registry,
        createdRegistry.target
      ), {
        windowsHide: true,
        requiresAdministrator: false,
        elevation: 'none',
        operation: 'font-registry-rollback',
        shell: false
      }).catch(() => {});
    }
    for (const createdPath of [...createdPaths].reverse()) {
      await fsp.rm(createdPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

function createKoreanFontsOnDemandAction(families = ['굴림']) {
  const requested = typeof families === 'string' ? [families] : families;
  if (!Array.isArray(requested) || !requested.length) throw installError('WINDOWS_FONT_FAMILIES_INVALID', '설치할 한국어 글꼴 가족이 필요합니다.');
  let action = null;
  for (const family of requested) {
    const next = Dependencies.planWindowsKoreanFontsInstall(family, 'win32');
    if (!action) action = { ...next, families: [...next.families] };
    else if (!action.families.includes(family)) action.families.push(family);
  }
  return action;
}

function validateWindowsCapabilityAction(action) {
  if (action.dependencyId !== 'windowsKoreanFonts' || action.capabilityName !== KOREAN_FONTS_CAPABILITY
    || action.requiresAdministrator !== true || action.fontSubstitution !== false || action.exactAssetOnly !== true
    || !Array.isArray(action.families) || !action.families.length) {
    throw installError('WINDOWS_CAPABILITY_ACTION_INVALID', 'Windows 한국어 추가 글꼴 action이 올바르지 않습니다.');
  }
  for (const family of action.families) Dependencies.planWindowsKoreanFontsInstall(family, 'win32');
}

function validateRhwpAction(action) {
  const asset = assertObject(action.asset, 'RHWP_ACTION_INVALID', 'rHWP asset 정보가 없습니다.');
  if (action.dependencyId !== 'rhwp' || action.version !== RHWP_PINNED_RELEASE.version
    || action.platform !== RHWP_PINNED_RELEASE.platform || action.architecture !== RHWP_PINNED_RELEASE.architecture
    || action.verifyBeforeExtract !== true || action.exactAssetOnly !== true
    || asset.url !== RHWP_PINNED_RELEASE.url || asset.sha256 !== RHWP_PINNED_RELEASE.sha256
    || asset.executableSha256 !== RHWP_PINNED_RELEASE.executableSha256
    || asset.fileName !== RHWP_PINNED_RELEASE.fileName) {
    throw installError('RHWP_ACTION_NOT_PINNED', 'rHWP action이 승인된 v0.8.4 Windows asset과 일치하지 않습니다.');
  }
}

function validateOfficialInstallerAction(action) {
  const expectedUrl = OFFICIAL_INSTALLER_URLS[action.dependencyId];
  if (!expectedUrl || action.url !== expectedUrl || action.automatic !== false || action.interactive !== true) {
    throw installError('OFFICIAL_INSTALLER_ACTION_INVALID', '공급사의 고정 공식 설치 안내 action만 열 수 있습니다.');
  }
  if (Object.hasOwn(action, 'command') || Object.hasOwn(action, 'arguments')
    || Object.hasOwn(action, 'unattendedInstaller')) {
    throw installError('PROPRIETARY_AUTOMATION_FORBIDDEN', 'Microsoft 또는 한컴 제품을 무인 설치할 수 없습니다.');
  }
  return expectedUrl;
}

function validateOfficialHancomAutomationGuideAction(action) {
  if (action.type !== 'officialHancomAutomationGuide' || action.dependencyId !== 'hancomWriter'
    || action.vendor !== 'hancom' || action.url !== HANCOM_AUTOMATION_GUIDE_URL
    || action.automatic !== false || action.interactive !== true
    || action.requiresUserConsent !== true || action.exactAssetOnly !== true) {
    throw installError('HANCOM_AUTOMATION_GUIDE_ACTION_INVALID', '한컴 공식 오토메이션 안내 action이 올바르지 않습니다.');
  }
  if (Object.hasOwn(action, 'command') || Object.hasOwn(action, 'arguments')
    || Object.hasOwn(action, 'unattendedInstaller') || Object.hasOwn(action, 'asset')) {
    throw installError('HANCOM_AUTOMATION_DOWNLOAD_FORBIDDEN', '사용 승인이 확인되지 않은 한컴 오토메이션 모듈은 자동으로 다운로드하거나 등록할 수 없습니다.');
  }
  return HANCOM_AUTOMATION_GUIDE_URL;
}

function validateOfficialFontSourceAction(action) {
  const expectedUrl = OFFICIAL_FONT_SOURCE_URLS[action.sourceId];
  if (!expectedUrl || action.url !== expectedUrl || action.automatic !== false || action.interactive !== true
    || action.requiresUserConsent !== true || action.exactAssetOnly !== true || action.fontSubstitution !== false
    || !Array.isArray(action.families) || !action.families.length || action.families.length > 100) {
    throw installError('OFFICIAL_FONT_SOURCE_ACTION_INVALID', '공급사의 고정 공식 글꼴 안내 action만 열 수 있습니다.');
  }
  const seen = new Set();
  for (const family of action.families) {
    const expected = Dependencies.officialFontSourceAction(family);
    const key = String(family).normalize('NFKC').toLocaleLowerCase('en-US');
    if (!expected || expected.sourceId !== action.sourceId || expected.url !== expectedUrl
      || expected.id !== action.id || seen.has(key)) {
      throw installError('OFFICIAL_FONT_SOURCE_ACTION_INVALID', '요청한 글꼴과 공식 공급처가 일치하지 않습니다.');
    }
    seen.add(key);
  }
  if (Object.hasOwn(action, 'command') || Object.hasOwn(action, 'arguments')
    || Object.hasOwn(action, 'unattendedInstaller') || Object.hasOwn(action, 'asset')) {
    throw installError('PROPRIETARY_FONT_AUTOMATION_FORBIDDEN', '라이선스 글꼴 파일을 임의로 내려받거나 무인 설치할 수 없습니다.');
  }
  return expectedUrl;
}

function verifyLibreOfficeCatalogResult(result) {
  const stdout = typeof result?.stdout === 'string'
    ? result.stdout
    : Buffer.isBuffer(result?.stdout) || result?.stdout instanceof Uint8Array
      ? Buffer.from(result.stdout).toString('utf8')
      : '';
  const hashes = [...new Set(stdout.match(/\b[a-f0-9]{64}\b/gi)?.map((value) => value.toLocaleLowerCase('en-US')) || [])];
  if (hashes.length !== 1 || hashes[0] !== LIBREOFFICE_INSTALLER_SHA256) {
    throw installError('LIBREOFFICE_CATALOG_HASH_MISMATCH', 'WinGet catalog의 LibreOffice installer SHA-256이 고정 manifest와 일치하지 않습니다.');
  }
}

function validateActionForExecution(action, executionOptions) {
  assertObject(action);
  assertNoProductKeys(action);
  assertExplicitConsent(action, executionOptions);
  if (action.fontSubstitution === true) {
    throw installError('FONT_SUBSTITUTION_FORBIDDEN', '자동 글꼴 대체는 허용되지 않습니다.');
  }
  switch (action.type) {
    case 'officialInstaller':
      validateOfficialInstallerAction(action);
      break;
    case 'officialHancomAutomationGuide':
      validateOfficialHancomAutomationGuideAction(action);
      break;
    case 'officialFontSource':
      validateOfficialFontSourceAction(action);
      break;
    case 'wingetInstall':
      if (action.dependencyId !== 'libreOffice' || action.packageId !== LIBREOFFICE_PACKAGE_ID
        || action.version !== LIBREOFFICE_VERSION || action.installerSha256 !== LIBREOFFICE_INSTALLER_SHA256
        || action.command !== LIBREOFFICE_COMMAND || action.source !== 'winget' || action.exact !== true
        || !exactArray(action.arguments, LIBREOFFICE_ARGUMENTS)) {
        throw installError('LIBREOFFICE_ACTION_INVALID', '승인된 정확한 LibreOffice winget action만 실행할 수 있습니다.');
      }
      break;
    case 'stagePinnedReleasePerUser':
      validateRhwpAction(action);
      break;
    case 'installWindowsCapability':
      validateWindowsCapabilityAction(action);
      break;
    case 'installOpenFontPerUser':
      canonicalFontAction(action);
      break;
    default:
      throw installError('ACTION_TYPE_UNSUPPORTED', `지원하지 않는 의존성 action입니다: ${String(action.type || '')}`);
  }
}

function createDocumentDependencyInstaller(options = {}) {
  const run = runnerFunction(options.runner);
  const shell = options.shell;
  const fetchImpl = options.fetch || globalThis.fetch;
  const fsp = fsPromises(options.fs || nodeFs);
  const userDataPath = options.userDataPath;
  const localAppDataPath = options.localAppDataPath || process.env.LOCALAPPDATA;
  const digestSha256 = options.digestSha256 || sha256Buffer;
  if (typeof digestSha256 !== 'function') throw installError('HASH_ADAPTER_INVALID', 'SHA-256 어댑터가 올바르지 않습니다.');

  async function executeAction(action, executionOptions = {}) {
    validateActionForExecution(action, executionOptions);

    switch (action.type) {
      case 'officialInstaller': {
        const url = validateOfficialInstallerAction(action);
        if (!shell || typeof shell.openExternal !== 'function') {
          throw installError('SHELL_ADAPTER_REQUIRED', '공식 설치 페이지를 열 Electron shell 어댑터가 필요합니다.');
        }
        await shell.openExternal(url);
        return { kind: 'officialInstaller', opened: true, dependencyId: action.dependencyId, url };
      }
      case 'officialHancomAutomationGuide': {
        const url = validateOfficialHancomAutomationGuideAction(action);
        if (!shell || typeof shell.openExternal !== 'function') {
          throw installError('SHELL_ADAPTER_REQUIRED', '한컴 공식 오토메이션 안내를 열 Electron shell 어댑터가 필요합니다.');
        }
        await shell.openExternal(url);
        return { kind: 'officialHancomAutomationGuide', opened: true, dependencyId: 'hancomWriter', url };
      }
      case 'officialFontSource': {
        const url = validateOfficialFontSourceAction(action);
        if (!shell || typeof shell.openExternal !== 'function') {
          throw installError('SHELL_ADAPTER_REQUIRED', '공식 글꼴 안내 페이지를 열 Electron shell 어댑터가 필요합니다.');
        }
        await shell.openExternal(url);
        return { kind: 'officialFontSource', opened: true, sourceId: action.sourceId, families: [...action.families], url };
      }
      case 'wingetInstall':
        verifyLibreOfficeCatalogResult(await runChecked(run, LIBREOFFICE_COMMAND, LIBREOFFICE_SHOW_ARGUMENTS, {
          windowsHide: true,
          requiresAdministrator: false,
          elevation: 'none',
          uacBypass: false
        }, 'LIBREOFFICE_CATALOG_CHECK_FAILED'));
        await runChecked(run, LIBREOFFICE_COMMAND, LIBREOFFICE_ARGUMENTS, {
          windowsHide: true,
          requiresAdministrator: false,
          elevation: 'allow-installer-uac',
          uacBypass: false
        }, 'LIBREOFFICE_INSTALL_FAILED');
        return {
          kind: 'libreOffice',
          installed: true,
          packageId: LIBREOFFICE_PACKAGE_ID,
          version: LIBREOFFICE_VERSION,
          catalogInstallerSha256: LIBREOFFICE_INSTALLER_SHA256
        };
      case 'stagePinnedReleasePerUser':
        return installRhwpRuntime({ fsp, fetchImpl, userDataPath, digestSha256 });
      case 'installWindowsCapability': {
        const capabilityResult = await runChecked(run, KOREAN_FONTS_COMMAND, KOREAN_FONTS_ARGUMENTS, {
          windowsHide: true,
          requiresAdministrator: true,
          elevation: 'prompt',
          uacBypass: false,
          successExitCodes: [0, 3010]
        }, 'WINDOWS_CAPABILITY_INSTALL_FAILED');
        const restartRequired = capabilityResult.exitCode === 3010;
        return {
          kind: 'windowsCapability',
          installed: true,
          capabilityName: KOREAN_FONTS_CAPABILITY,
          families: [...action.families],
          restartRequired,
          applicationRestartRecommended: restartRequired
        };
      }
      case 'installOpenFontPerUser':
        return installOpenFont({ action, fsp, fetchImpl, run, userDataPath, localAppDataPath, digestSha256 });
      default:
        throw installError('ACTION_TYPE_UNSUPPORTED', `지원하지 않는 의존성 action입니다: ${String(action.type || '')}`);
    }
  }

  async function executePlan(plan, executionOptions = {}) {
    assertObject(plan, 'PLAN_INVALID', '문서 의존성 계획이 올바르지 않습니다.');
    if (plan.version !== Dependencies.PLAN_VERSION || plan.policy?.exactAssetOnly !== true
      || plan.policy?.fontSubstitution !== false || plan.policy?.proprietaryUnattendedInstall !== false
      || plan.policy?.executionIncluded !== false || !Array.isArray(plan.actions)) {
      throw installError('PLAN_POLICY_INVALID', '안전 정책이 고정된 planner 결과만 실행할 수 있습니다.');
    }
    const confirmed = new Set(Array.isArray(executionOptions.confirmedActionIds) ? executionOptions.confirmedActionIds : []);
    const actionIds = new Set();
    for (const action of plan.actions) {
      if (typeof action?.id !== 'string' || !action.id || actionIds.has(action.id)) {
        throw installError('PLAN_ACTION_ID_INVALID', '계획의 action ID가 없거나 중복되었습니다.');
      }
      actionIds.add(action.id);
      validateActionForExecution(action, { userConfirmed: confirmed.has(action.id) });
    }
    const results = [];
    for (const action of plan.actions) {
      results.push(await executeAction(action, { userConfirmed: confirmed.has(action.id) }));
    }
    return results;
  }

  return Object.freeze({
    executeAction,
    executePlan,
    createKoreanFontsOnDemandAction
  });
}

module.exports = {
  LIBREOFFICE_PACKAGE_ID,
  LIBREOFFICE_VERSION,
  LIBREOFFICE_INSTALLER_SHA256,
  LIBREOFFICE_COMMAND,
  LIBREOFFICE_ARGUMENTS,
  LIBREOFFICE_SHOW_ARGUMENTS,
  RHWP_PINNED_RELEASE,
  OFFICIAL_INSTALLER_URLS,
  HANCOM_AUTOMATION_GUIDE_URL,
  OFFICIAL_FONT_SOURCE_URLS,
  KOREAN_FONTS_CAPABILITY,
  KOREAN_FONTS_COMMAND,
  KOREAN_FONTS_SCRIPT,
  KOREAN_FONTS_ARGUMENTS,
  TRUSTED_DOWNLOAD_HOSTS: Object.freeze([...TRUSTED_DOWNLOAD_HOSTS]),
  MAX_REDIRECTS,
  RHWP_MAX_DOWNLOAD_BYTES,
  RHWP_MAX_ARCHIVE_ENTRIES,
  RHWP_MAX_ENTRY_BYTES,
  RHWP_MAX_EXTRACTED_BYTES,
  FONT_MAX_DOWNLOAD_BYTES,
  LICENSE_MAX_DOWNLOAD_BYTES,
  DocumentDependencyInstallError,
  sha256Buffer,
  encodePowerShellScript,
  buildElevatedPowerShellInvocation,
  sfntFamilyNames,
  verifySfntFamily,
  fontRegistryQueryPowerShellArguments,
  fontRegistryMutationPowerShellArguments,
  fontRuntimePowerShellArguments,
  preflightRhwpZip,
  createKoreanFontsOnDemandAction,
  createDocumentDependencyInstaller
};
