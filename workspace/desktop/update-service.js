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
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CmoeNativeWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'`,
    `$form=New-Object System.Windows.Forms.Form`,
    `$form.Text='CMOE Workspace 업데이트'`,
    `$form.ClientSize=New-Object Drawing.Size(520,258)`, `$form.StartPosition='CenterScreen'`, `$form.BackColor=[Drawing.Color]::White`, `$form.Font=New-Object Drawing.Font('Segoe UI',9)`,
    `$form.FormBorderStyle='FixedDialog'`, `$form.MaximizeBox=$false`, `$form.MinimizeBox=$false`, `$form.ControlBox=$false`, `$form.TopMost=$true`, `$form.ShowInTaskbar=$true`,
    `$eyebrow=New-Object System.Windows.Forms.Label`, `$eyebrow.SetBounds(24,18,472,16)`, `$eyebrow.Text='PROGRAM UPDATE'`, `$eyebrow.ForeColor=[Drawing.Color]::FromArgb(104,116,128)`, `$eyebrow.Font=New-Object Drawing.Font('Segoe UI',8,[Drawing.FontStyle]::Bold)`,
    `$title=New-Object System.Windows.Forms.Label`, `$title.SetBounds(24,38,472,30)`, `$title.Text=${quote(`CMOE Workspace ${expectedVersion} 업데이트`)}`, `$title.ForeColor=[Drawing.Color]::FromArgb(32,43,54)`, `$title.Font=New-Object Drawing.Font('Segoe UI',15,[Drawing.FontStyle]::Bold)`,
    `$divider=New-Object System.Windows.Forms.Panel`, `$divider.SetBounds(0,76,520,1)`, `$divider.BackColor=[Drawing.Color]::FromArgb(222,227,231)`,
    `$stage1=New-Object System.Windows.Forms.Panel`, `$stage1.SetBounds(24,94,113,4)`, `$stage2=New-Object System.Windows.Forms.Panel`, `$stage2.SetBounds(143,94,113,4)`, `$stage3=New-Object System.Windows.Forms.Panel`, `$stage3.SetBounds(262,94,113,4)`, `$stage4=New-Object System.Windows.Forms.Panel`, `$stage4.SetBounds(381,94,115,4)`, `$stages=@($stage1,$stage2,$stage3,$stage4)`,
    `$status=New-Object System.Windows.Forms.Label`, `$status.SetBounds(24,116,472,28)`, `$status.ForeColor=[Drawing.Color]::FromArgb(32,43,54)`, `$status.Font=New-Object Drawing.Font('Segoe UI',10,[Drawing.FontStyle]::Bold)`,
    `$track=New-Object System.Windows.Forms.Panel`, `$track.SetBounds(24,153,472,10)`, `$track.BackColor=[Drawing.Color]::FromArgb(220,226,231)`,
    `$fill=New-Object System.Windows.Forms.Panel`, `$fill.SetBounds(0,0,0,10)`, `$fill.BackColor=[Drawing.Color]::FromArgb(35,111,161)`, `$track.Controls.Add($fill)`,
    `$detail=New-Object System.Windows.Forms.Label`, `$detail.SetBounds(24,178,382,50)`, `$detail.ForeColor=[Drawing.Color]::FromArgb(82,96,109)`,
    `$progressText=New-Object System.Windows.Forms.Label`, `$progressText.SetBounds(410,178,86,24)`, `$progressText.TextAlign='TopRight'`, `$progressText.ForeColor=[Drawing.Color]::FromArgb(82,96,109)`,
    `function Set-Stage([int]$active,[string]$message,[string]$description){for($index=0;$index -lt 4;$index++){$stages[$index].BackColor=if($index -lt $active){[Drawing.Color]::FromArgb(35,111,161)}else{[Drawing.Color]::FromArgb(220,226,231)}};$status.Text=$message;$detail.Text=$description}`,
    `function Set-Determinate([int]$value){$safe=[Math]::Max(0,[Math]::Min(100,$value));$fill.Left=0;$fill.Width=[Math]::Floor($track.ClientSize.Width*$safe/100);$progressText.Text=($safe.ToString()+'%');[System.Windows.Forms.Application]::DoEvents()}`,
    `function Set-Activity([int]$tick,[string]$text){$width=96;$travel=[Math]::Max(1,$track.ClientSize.Width-$width);$cycle=$travel*2;$position=$tick%$cycle;if($position -gt $travel){$position=$cycle-$position};$fill.Width=$width;$fill.Left=$position;$progressText.Text=$text;[System.Windows.Forms.Application]::DoEvents()}`,
    `$form.Controls.AddRange(@($eyebrow,$title,$divider,$stage1,$stage2,$stage3,$stage4,$status,$track,$detail,$progressText))`,
    `Set-Stage 1 '앱을 종료하고 업데이트를 준비하고 있습니다.' '설치 충돌을 막기 위해 실행 중인 CMOE Workspace가 완전히 종료될 때까지 기다립니다.'`, `Set-Activity 0 '준비 중'`,
    `$form.Show()`, `[void][CmoeNativeWindow]::ShowWindow($form.Handle,5)`, `[void][CmoeNativeWindow]::SetForegroundWindow($form.Handle)`, `[System.Windows.Forms.Application]::DoEvents()`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' helper ready') -Encoding UTF8`,
    `$target=Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue`,
    `if($target){$targetPath=$null; try{$targetPath=$target.Path}catch{}; if($targetPath -and [IO.Path]::GetFullPath($targetPath) -ne [IO.Path]::GetFullPath($app)){throw 'APP_IDENTITY_MISMATCH'}}`,
    `$deadline=[DateTime]::UtcNow.AddSeconds(45)`, `$activityTick=0`,
    `do {$running=@(Get-CimInstance Win32_Process -Filter "Name='CMOE Workspace.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq [IO.Path]::GetFullPath($app)}); if(!$running.Count){break}; Set-Activity $activityTick '종료 대기'; $activityTick=($activityTick+18); Start-Sleep -Milliseconds 160} while([DateTime]::UtcNow -lt $deadline)`,
    `if($running.Count){throw 'APP_PROCESSES_STILL_RUNNING'}`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' app processes stopped') -Encoding UTF8`,
    `Set-Stage 2 '설치 파일을 최종 검증하고 있습니다.' '다운로드한 설치 파일의 크기와 SHA-256을 다시 확인합니다.'`, `Set-Determinate 25`,
    `if(!(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'INSTALLER_MISSING'}`,
    `if((Get-Item -LiteralPath $installer).Length -ne ${numericBytes}){throw 'INSTALLER_SIZE_MISMATCH'}`,
    `$stream=[IO.File]::OpenRead($installer)`,
    `try{$hasher=[Security.Cryptography.SHA256]::Create(); try{$buffer=New-Object byte[] (1024*1024);$readTotal=0L;while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){[void]$hasher.TransformBlock($buffer,0,$count,$buffer,0);$readTotal+=$count;Set-Determinate (25+[Math]::Floor(20*$readTotal/[Math]::Max(1,$stream.Length)))};[void]$hasher.TransformFinalBlock((New-Object byte[] 0),0,0);$actualHash=([BitConverter]::ToString($hasher.Hash)).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}}finally{$stream.Dispose()}`,
    `if($actualHash -ne ${quote(expectedSha256)}){throw 'INSTALLER_HASH_MISMATCH'}`,
    `Set-Stage 3 '업데이트를 설치하고 있습니다.' '설치 중에는 앱을 다시 실행하거나 컴퓨터를 끄지 마세요.'`, `Set-Activity 0 '설치 중'`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' installer starting') -Encoding UTF8`,
    `$process=Start-Process -FilePath $installer -ArgumentList '/S' -PassThru`,
    `$installStarted=[DateTime]::UtcNow`, `$activityTick=0`,
    `while(!$process.HasExited){$elapsed=[Math]::Max(0,[Math]::Floor(([DateTime]::UtcNow-$installStarted).TotalSeconds));Set-Activity $activityTick ('설치 중 · '+$elapsed+'초');$activityTick=($activityTick+18);Start-Sleep -Milliseconds 160}`,
    `if($process.ExitCode -ne 0){throw ('INSTALLER_EXIT_'+$process.ExitCode)}`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' installer exited '+$process.ExitCode) -Encoding UTF8`,
    `Set-Stage 4 '설치된 새 버전을 확인하고 있습니다.' '새 실행 파일과 버전을 확인한 뒤 자동으로 다시 실행합니다.'`, `Set-Determinate 95`,
    `if(!(Test-Path -LiteralPath $app -PathType Leaf)){throw 'UPDATED_APP_MISSING'}`,
    `$installedVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($app).FileVersion`,
    `if(!$installedVersion -or $installedVersion.Split('+')[0] -ne ${quote(expectedVersion)}){throw 'UPDATED_VERSION_MISMATCH'}`,
    `Set-Stage 4 '업데이트가 완료되었습니다.' '새 버전의 CMOE Workspace를 실행합니다.'`, `Set-Determinate 100`, `Start-Sleep -Milliseconds 700`,
    `Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' verified '+$installedVersion) -Encoding UTF8`,
    `$form.Close()`, `$form=$null`, `Start-Process -FilePath $app -ArgumentList '--updated'`,
    `} catch {`,
    `try{Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o')+' ERROR '+$_.Exception.Message) -Encoding UTF8}catch{}`,
    `if($form){Set-Stage 1 '업데이트를 완료하지 못했습니다.' '기존 앱을 다시 실행하여 오류 내용을 표시합니다.';$fill.BackColor=[Drawing.Color]::FromArgb(180,35,24);Set-Determinate 100;Start-Sleep -Seconds 2;$form.Close()}`,
    `if(Test-Path -LiteralPath $app -PathType Leaf){Start-Process -FilePath $app -ArgumentList '--update-failed'}`, `exit 40`, `}`
  ].join('; ');
}

module.exports = { PRODUCT, PLATFORM, FEED_URL, MAX_INSTALLER_BYTES, compareVersions, validateFeed, validateDownloadUrl, checkForUpdate, downloadInstaller, createUpdateDataBackup, helperCommand };
