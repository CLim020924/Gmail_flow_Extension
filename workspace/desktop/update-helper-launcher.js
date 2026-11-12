const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const UpdateService = require('./update-service');

function windowsPowerShellPath(environment = process.env) {
  const windowsRoot = String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows');
  return path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function powerShellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function launchUpdateHelper(payload, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const spawnProcess = options.spawnProcess || spawn;
  const timeoutMs = Number(options.timeoutMs || 10_000);
  const pollMs = Number(options.pollMs || 100);
  const logPath = path.join(path.dirname(payload.installerPath), 'update-helper.log');
  await fileSystem.promises.rm(logPath, { force: true });

  const command = UpdateService.helperCommand(payload);
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const executable = windowsPowerShellPath(options.environment);
  const helperArguments = ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded];
  const bootstrap = [
    `$ErrorActionPreference='Stop'`,
    `Start-Process -FilePath ${powerShellQuote(executable)} -ArgumentList @(${helperArguments.map(powerShellQuote).join(',')}) -WindowStyle Hidden`
  ].join('; ');
  const bootstrapEncoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
  const child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', bootstrapEncoded], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true
  });
  let spawnError = null;
  child.once?.('error', (error) => { spawnError = error; });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`업데이트 설치 도우미를 실행하지 못했습니다: ${spawnError.message}`);
    try {
      const log = await fileSystem.promises.readFile(logPath, 'utf8');
      if (log.includes('helper ready')) return { pid: child.pid || 0, logPath, executable };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (child.exitCode != null && child.exitCode !== 0) throw new Error(`업데이트 설치 도우미 시작 프로세스가 실패했습니다. 종료 코드: ${child.exitCode}`);
    await wait(pollMs);
  }
  throw new Error('업데이트 설치 도우미가 제한 시간 안에 시작되지 않았습니다.');
}

module.exports = { windowsPowerShellPath, launchUpdateHelper };
