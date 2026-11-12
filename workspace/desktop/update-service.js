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

function safeBackupRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))) throw new Error('업데이트 백업 항목 경로가 올바르지 않습니다.');
  return normalized;
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function createUpdateDataBackup({ version, backupRoot, entries = [] }) {
  versionParts(version);
  if (!path.isAbsolute(String(backupRoot || ''))) throw new Error('업데이트 백업 위치가 올바르지 않습니다.');
  const normalizedEntries = entries.map((entry) => ({ source: path.resolve(String(entry?.source || '')), relativePath: safeBackupRelativePath(entry?.relativePath) }));
  if (!normalizedEntries.length) throw new Error('보존할 사용자 데이터 항목이 없습니다.');
  for (const entry of normalizedEntries) {
    if (!path.isAbsolute(entry.source) || pathInside(entry.source, backupRoot) || pathInside(backupRoot, entry.source)) throw new Error('사용자 데이터와 백업 위치가 서로 겹칩니다.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotName = `before-${version}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotPath = path.join(path.resolve(backupRoot), snapshotName);
  await fs.promises.mkdir(path.resolve(backupRoot), { recursive: true });
  await fs.promises.mkdir(snapshotPath, { recursive: false });
  const copied = [];
  for (const entry of normalizedEntries) {
    let stat;
    try { stat = await fs.promises.lstat(entry.source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('링크로 연결된 사용자 데이터는 업데이트 백업에 사용할 수 없습니다.');
    const destination = path.join(snapshotPath, ...entry.relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (stat.isDirectory()) {
      await fs.promises.cp(entry.source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        preserveTimestamps: true,
        filter: async (source) => !(await fs.promises.lstat(source)).isSymbolicLink()
      });
    } else if (stat.isFile()) await fs.promises.copyFile(entry.source, destination, fs.constants.COPYFILE_EXCL);
    else continue;
    copied.push(entry.relativePath);
  }
  if (!copied.length) throw new Error('보존할 사용자 데이터를 찾지 못해 업데이트를 중단했습니다.');
  await fs.promises.writeFile(path.join(snapshotPath, 'backup-manifest.json'), `${JSON.stringify({ schemaVersion: 1, product: PRODUCT, beforeVersion: version, createdAt: new Date().toISOString(), entries: copied }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { snapshotPath, entries: copied };
}

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
  const downloadUrl = validateDownloadUrl(feed.url);
  const expectedPath = `${RELEASE_PATH_PREFIX}${feed.version}/CMOE-Workspace-Setup-${feed.version}-Windows.exe`;
  if (downloadUrl.pathname !== expectedPath) throw new Error('업데이트 버전과 공식 설치 파일 경로가 일치하지 않습니다.');
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

async function downloadInstaller(feedInput, destination, fetchImpl = globalThis.fetch, onProgress = () => {}, options = {}) {
  const feed = validateFeed(feedInput); await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`; await fs.promises.rm(partial, { force: true });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
  const externalSignal = options?.signal;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener?.('abort', abortFromCaller, { once: true });
  try {
    onProgress({ stage: 'connecting', message: '업데이트 서버에 연결하고 있습니다.', received: 0, total: feed.bytes, percent: 0 });
    const response = await fetchImpl(feed.url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`업데이트 파일을 내려받지 못했습니다. (${response.status})`);
    validateDownloadUrl(response.url || feed.url, { redirected: (response.url || feed.url) !== feed.url });
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength && contentLength !== feed.bytes) throw new Error('업데이트 파일 크기가 배포 정보와 다릅니다.');
    let received = 0; const hash = crypto.createHash('sha256');
    onProgress({ stage: 'downloading', message: '업데이트 파일을 다운로드하고 있습니다.', received: 0, total: feed.bytes, percent: 0 });
    const source = Readable.fromWeb(response.body); source.on('data', (chunk) => { received += chunk.length; if (received > MAX_INSTALLER_BYTES) source.destroy(new Error('업데이트 파일이 허용 크기를 초과했습니다.')); hash.update(chunk); onProgress({ stage: 'downloading', message: '업데이트 파일을 다운로드하고 있습니다.', received, total: feed.bytes, percent: Math.min(100, received / feed.bytes * 100) }); });
    await pipeline(source, fs.createWriteStream(partial, { flags: 'wx' }));
    onProgress({ stage: 'verifying', message: '다운로드한 파일의 크기와 SHA-256을 검증하고 있습니다.', received, total: feed.bytes, percent: 100 });
    const actualSha256 = hash.digest('hex');
    if (received !== feed.bytes || actualSha256 !== feed.sha256) throw new Error('업데이트 파일 검증에 실패했습니다. 파일을 실행하지 않습니다.');
    await fs.promises.rm(destination, { force: true }); await fs.promises.rename(partial, destination);
    onProgress({ stage: 'verified', message: '다운로드와 파일 검증이 완료되었습니다.', received, total: feed.bytes, percent: 100 });
    return destination;
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    if (externalSignal?.aborted) throw new Error('업데이트 다운로드를 취소했습니다.');
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function helperCommand({ installerPath, expectedSha256, expectedBytes, expectedVersion, appPath, pid }) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const numericPid = Number(pid);
  const numericBytes = Number(expectedBytes);
  return [
    `$ErrorActionPreference='Stop'`,
    `$app=${quote(appPath)}`,
    `$installer=${quote(installerPath)}`,
    `$log=Join-Path (Split-Path -Parent $installer) 'update-helper.log'`,
    `$form=$null`,
    `try {`,
    `Set-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' helper process started') -Encoding UTF8`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `$form=New-Object System.Windows.Forms.Form`,
    `$form.Text='CMOE Workspace 업데이트'`,
    `$form.Width=440`, `$form.Height=170`, `$form.StartPosition='CenterScreen'`,
    `$form.FormBorderStyle='FixedDialog'`, `$form.MaximizeBox=$false`, `$form.MinimizeBox=$false`, `$form.ControlBox=$false`, `$form.TopMost=$true`,
    `$label=New-Object System.Windows.Forms.Label`, `$label.Left=24`, `$label.Top=22`, `$label.Width=380`, `$label.Height=44`,
    `$label.Text='앱을 종료하고 업데이트를 준비하고 있습니다. 잠시만 기다려주세요.'`,
    `$progress=New-Object System.Windows.Forms.ProgressBar`, `$progress.Left=24`, `$progress.Top=78`, `$progress.Width=380`, `$progress.Height=18`, `$progress.Style='Marquee'`, `$progress.MarqueeAnimationSpeed=28`,
    `$form.Controls.Add($label)`, `$form.Controls.Add($progress)`, `$form.Show()`, `[System.Windows.Forms.Application]::DoEvents()`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' helper ready') -Encoding UTF8`,
    `$target=Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue`,
    `if($target){$targetPath=$null; try{$targetPath=$target.Path}catch{}; if($targetPath -and [IO.Path]::GetFullPath($targetPath) -ne [IO.Path]::GetFullPath($app)){throw 'APP_IDENTITY_MISMATCH'}}`,
    `$deadline=[DateTime]::UtcNow.AddSeconds(45)`,
    `do {$running=@(Get-CimInstance Win32_Process -Filter "Name='CMOE Workspace.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($app)}); if(!$running.Count){break}; [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200} while([DateTime]::UtcNow -lt $deadline)`,
    `if($running.Count){throw 'APP_PROCESSES_STILL_RUNNING'}`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' app processes stopped') -Encoding UTF8`,
    `if(!(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'INSTALLER_MISSING'}`,
    `if((Get-Item -LiteralPath $installer).Length -ne ${numericBytes}){throw 'INSTALLER_SIZE_MISMATCH'}`,
    `if((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${quote(expectedSha256)}){throw 'INSTALLER_HASH_MISMATCH'}`,
    `$label.Text='업데이트를 설치하고 있습니다. 창을 닫거나 앱을 다시 실행하지 마세요.'`, `[System.Windows.Forms.Application]::DoEvents()`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' installer starting') -Encoding UTF8`,
    `$process=Start-Process -FilePath $installer -ArgumentList '/S' -PassThru`,
    `while(!$process.HasExited){[System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200}`,
    `if($process.ExitCode -ne 0){throw ('INSTALLER_EXIT_'+$process.ExitCode)}`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' installer exited '+$process.ExitCode) -Encoding UTF8`,
    `if(!(Test-Path -LiteralPath $app -PathType Leaf)){throw 'UPDATED_APP_MISSING'}`,
    `$installedVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($app).FileVersion`,
    `if(!$installedVersion -or $installedVersion.Split('+')[0] -ne ${quote(expectedVersion)}){throw 'UPDATED_VERSION_MISMATCH'}`,
    `$label.Text='업데이트가 완료되었습니다. 새 버전을 실행합니다.'`, `[System.Windows.Forms.Application]::DoEvents()`, `Start-Sleep -Milliseconds 700`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' verified '+$installedVersion) -Encoding UTF8`,
    `$form.Close()`, `$form=$null`, `Start-Process -FilePath $app -ArgumentList '--updated'`,
    `} catch {`,
    `try{Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' ERROR '+$_.Exception.Message) -Encoding UTF8}catch{}`,
    `if($form){$label.Text='업데이트를 완료하지 못했습니다. 기존 앱을 다시 실행합니다.'; $progress.Style='Blocks'; [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Seconds 2; $form.Close()}`,
    `if(Test-Path -LiteralPath $app -PathType Leaf){Start-Process -FilePath $app -ArgumentList '--update-failed'}`, `exit 40`, `}`
  ].join('; ');
}

module.exports = { PRODUCT, PLATFORM, FEED_URL, MAX_INSTALLER_BYTES, compareVersions, validateFeed, validateDownloadUrl, checkForUpdate, downloadInstaller, createUpdateDataBackup, helperCommand };
