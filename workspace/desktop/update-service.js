const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const PRODUCT = 'cmoe-workspace';
const PLATFORM = 'windows-x64';
const FEED_URL = 'https://cresero.com/downloads/cmoe-workspace/update.json';
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const RELEASE_PATH_PREFIX = '/CLim020924/cresero-downloads/releases/download/cmoe-workspace-v';

function versionParts(value) {
  if (!/^\d+\.\d+\.\d+$/.test(String(value || ''))) throw new Error('업데이트 버전 형식이 올바르지 않습니다.');
  return String(value).split('.').map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function validateDownloadUrl(value, { redirected = false } = {}) {
  let parsed; try { parsed = new URL(value); } catch (_) { throw new Error('업데이트 다운로드 주소가 올바르지 않습니다.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) throw new Error('허용되지 않은 업데이트 다운로드 주소입니다.');
  if (!redirected && (parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(RELEASE_PATH_PREFIX) || !parsed.pathname.endsWith('.exe'))) throw new Error('CMOE Workspace 공식 릴리스 파일만 업데이트에 사용할 수 있습니다.');
  return parsed;
}

function validateFeed(feed) {
  if (!feed || feed.schemaVersion !== 1 || feed.product !== PRODUCT || feed.platform !== PLATFORM) throw new Error('다른 제품 또는 플랫폼의 업데이트 정보입니다.');
  versionParts(feed.version);
  if (!Number.isSafeInteger(feed.bytes) || feed.bytes < 1 || feed.bytes > MAX_INSTALLER_BYTES) throw new Error('업데이트 파일 크기 정보가 올바르지 않습니다.');
  if (!/^[a-f0-9]{64}$/.test(String(feed.sha256 || ''))) throw new Error('업데이트 SHA-256 정보가 올바르지 않습니다.');
  validateDownloadUrl(feed.url);
  return { schemaVersion: 1, product: PRODUCT, platform: PLATFORM, version: feed.version, bytes: feed.bytes, sha256: feed.sha256, url: feed.url, notes: Array.isArray(feed.notes) ? feed.notes.map(String).slice(0, 12) : [] };
}

async function checkForUpdate(currentVersion, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('업데이트 확인에 필요한 네트워크 기능을 사용할 수 없습니다.');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try { response = await fetchImpl(FEED_URL, { redirect: 'error', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } }); }
  catch (cause) { throw new Error(`업데이트 정보를 확인하지 못했습니다. ${cause?.message || ''}`.trim()); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`업데이트 서버가 응답하지 않았습니다. (${response.status})`);
  const feed = validateFeed(await response.json());
  return { currentVersion, available: compareVersions(feed.version, currentVersion) > 0, feed };
}

async function downloadInstaller(feedInput, destination, fetchImpl = globalThis.fetch, onProgress = () => {}) {
  const feed = validateFeed(feedInput); await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`; await fs.promises.rm(partial, { force: true });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    const response = await fetchImpl(feed.url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`업데이트 파일을 내려받지 못했습니다. (${response.status})`);
    validateDownloadUrl(response.url || feed.url, { redirected: (response.url || feed.url) !== feed.url });
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength && contentLength !== feed.bytes) throw new Error('업데이트 파일 크기가 배포 정보와 다릅니다.');
    let received = 0; const hash = crypto.createHash('sha256');
    const source = Readable.fromWeb(response.body); source.on('data', (chunk) => { received += chunk.length; if (received > MAX_INSTALLER_BYTES) source.destroy(new Error('업데이트 파일이 허용 크기를 초과했습니다.')); hash.update(chunk); onProgress({ received, total: feed.bytes, percent: Math.min(100, received / feed.bytes * 100) }); });
    await pipeline(source, fs.createWriteStream(partial, { flags: 'wx' }));
    if (received !== feed.bytes || hash.digest('hex') !== feed.sha256) throw new Error('업데이트 파일 검증에 실패했습니다. 파일을 실행하지 않습니다.');
    await fs.promises.rm(destination, { force: true }); await fs.promises.rename(partial, destination);
    return destination;
  } catch (error) { await fs.promises.rm(partial, { force: true }); throw error; }
  finally { clearTimeout(timeout); }
}

function helperCommand({ installerPath, expectedSha256, appPath, pid }) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return `$ErrorActionPreference='Stop'; Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; $installer=${quote(installerPath)}; if((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${quote(expectedSha256)}){exit 31}; $process=Start-Process -FilePath $installer -ArgumentList '/S','--updated' -Wait -PassThru; if($process.ExitCode -ne 0){exit $process.ExitCode}; $app=${quote(appPath)}; if(Test-Path -LiteralPath $app){Start-Process -FilePath $app -ArgumentList '--updated'}`;
}

module.exports = { PRODUCT, PLATFORM, FEED_URL, MAX_INSTALLER_BYTES, compareVersions, validateFeed, validateDownloadUrl, checkForUpdate, downloadInstaller, helperCommand };
