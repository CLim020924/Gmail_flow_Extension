'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const {
  fontRegistryQueryPowerShellArguments,
  fontRegistryMutationPowerShellArguments,
  fontRuntimePowerShellArguments
} = require('./document-dependency-installer');

const MAX_FONT_FILE_BYTES = 96 * 1024 * 1024;
const MAX_FONT_FACES = 64;
const MAX_TABLES_PER_FACE = 256;
const MAX_NAME_RECORDS = 4096;
const USER_FONT_REGISTRY_KEY = 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc']);
const SFNT_SIGNATURES = new Set([0x00010000, 0x74727565, 0x4f54544f]);
const FONT_TARGET_LOCKS = new Map();
const FONT_CONTENT_LOCKS = new Map();

class UserFontFileInstallError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'UserFontFileInstallError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fontError(code, message, cause) {
  return new UserFontFileInstallError(code, message, cause);
}

function canonicalFontName(value, field = '글꼴 이름') {
  if (typeof value !== 'string') throw fontError('FONT_NAME_INVALID', `${field}이(가) 올바르지 않습니다.`);
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > 256 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw fontError('FONT_NAME_INVALID', `${field}이(가) 올바르지 않습니다.`);
  }
  return normalized;
}

function normalizeExactFontName(value) {
  return canonicalFontName(value).toLocaleLowerCase('en-US');
}

function checkedRange(buffer, offset, length, code = 'FONT_SFNT_INVALID') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset > buffer.length || length > buffer.length - offset) {
    throw fontError(code, '글꼴 파일의 내부 범위가 올바르지 않습니다.');
  }
  return { start: offset, end: offset + length };
}

function utf16Be(buffer) {
  if (buffer.length % 2 !== 0) return '';
  const littleEndian = Buffer.allocUnsafe(buffer.length);
  for (let offset = 0; offset < buffer.length; offset += 2) {
    littleEndian[offset] = buffer[offset + 1];
    littleEndian[offset + 1] = buffer[offset];
  }
  const value = littleEndian.toString('utf16le');
  if (value.includes('\ufffd')) return '';
  return value;
}

function decodeNameRecord(buffer, platformId) {
  if (platformId === 0 || platformId === 3) return utf16Be(buffer);
  if (platformId === 1) return buffer.toString('latin1');
  return '';
}

function appendUniqueName(target, keys, rawValue) {
  let display;
  try {
    display = canonicalFontName(String(rawValue).replace(/\u0000/g, ''));
  } catch (_) {
    return;
  }
  const key = normalizeExactFontName(display);
  if (keys.has(key)) return;
  keys.add(key);
  target.push(display);
}

function inspectNameTable(buffer, tableOffset, tableLength) {
  const table = checkedRange(buffer, tableOffset, tableLength);
  if (tableLength < 6) throw fontError('FONT_NAME_TABLE_INVALID', '글꼴 이름 테이블이 너무 짧습니다.');
  const format = buffer.readUInt16BE(table.start);
  const count = buffer.readUInt16BE(table.start + 2);
  const storageRelativeOffset = buffer.readUInt16BE(table.start + 4);
  if (![0, 1].includes(format) || !count || count > MAX_NAME_RECORDS) {
    throw fontError('FONT_NAME_TABLE_INVALID', '글꼴 이름 테이블 형식이나 레코드 수가 올바르지 않습니다.');
  }
  const recordsLength = count * 12;
  const recordsEnd = table.start + 6 + recordsLength;
  const storageStart = table.start + storageRelativeOffset;
  if (recordsEnd > table.end || storageStart < recordsEnd || storageStart > table.end) {
    throw fontError('FONT_NAME_TABLE_INVALID', '글꼴 이름 레코드 범위가 올바르지 않습니다.');
  }
  if (format === 1) {
    if (recordsEnd + 2 > storageStart) {
      throw fontError('FONT_NAME_TABLE_INVALID', '글꼴 언어 태그 범위가 올바르지 않습니다.');
    }
    const languageTagCount = buffer.readUInt16BE(recordsEnd);
    const languageTagsEnd = recordsEnd + 2 + (languageTagCount * 4);
    if (languageTagCount > MAX_NAME_RECORDS || languageTagsEnd > storageStart) {
      throw fontError('FONT_NAME_TABLE_INVALID', '글꼴 언어 태그 범위가 올바르지 않습니다.');
    }
  }

  const familyNames = [];
  const fullNames = [];
  const familyKeys = new Set();
  const fullKeys = new Set();
  for (let index = 0; index < count; index += 1) {
    const recordOffset = table.start + 6 + (index * 12);
    const platformId = buffer.readUInt16BE(recordOffset);
    const nameId = buffer.readUInt16BE(recordOffset + 6);
    if (nameId !== 1 && nameId !== 4 && nameId !== 16) continue;
    const byteLength = buffer.readUInt16BE(recordOffset + 8);
    const relativeOffset = buffer.readUInt16BE(recordOffset + 10);
    if (!byteLength || byteLength > 16 * 1024) continue;
    const stringOffset = storageStart + relativeOffset;
    if (stringOffset < storageStart || stringOffset > table.end || byteLength > table.end - stringOffset) continue;
    const decoded = decodeNameRecord(buffer.subarray(stringOffset, stringOffset + byteLength), platformId);
    if (!decoded) continue;
    if (nameId === 4) appendUniqueName(fullNames, fullKeys, decoded);
    else appendUniqueName(familyNames, familyKeys, decoded);
  }
  if (!familyNames.length) {
    throw fontError('FONT_FAMILY_NAME_MISSING', '글꼴 파일의 내부 가족 이름을 확인할 수 없습니다.');
  }
  return { familyNames, fullNames };
}

function inspectSfntFace(buffer, faceOffset, faceIndex) {
  checkedRange(buffer, faceOffset, 12);
  const signature = buffer.readUInt32BE(faceOffset);
  if (!SFNT_SIGNATURES.has(signature)) {
    throw fontError('FONT_SFNT_INVALID', 'TrueType 또는 OpenType SFNT 글꼴이 아닙니다.');
  }
  const tableCount = buffer.readUInt16BE(faceOffset + 4);
  if (!tableCount || tableCount > MAX_TABLES_PER_FACE) {
    throw fontError('FONT_SFNT_INVALID', '글꼴 테이블 수가 허용 범위를 벗어났습니다.');
  }
  checkedRange(buffer, faceOffset + 12, tableCount * 16);
  const tags = new Set();
  let nameTable = null;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = faceOffset + 12 + (index * 16);
    const tag = buffer.subarray(recordOffset, recordOffset + 4).toString('latin1');
    if (tags.has(tag)) throw fontError('FONT_SFNT_INVALID', '글꼴에 중복된 테이블 태그가 있습니다.');
    tags.add(tag);
    const tableOffset = buffer.readUInt32BE(recordOffset + 8);
    const tableLength = buffer.readUInt32BE(recordOffset + 12);
    checkedRange(buffer, tableOffset, tableLength);
    if (tag === 'name') nameTable = { offset: tableOffset, length: tableLength };
  }
  if (!nameTable) throw fontError('FONT_NAME_TABLE_MISSING', '글꼴 파일에 이름 테이블이 없습니다.');
  const names = inspectNameTable(buffer, nameTable.offset, nameTable.length);
  return {
    index: faceIndex,
    offset: faceOffset,
    outline: signature === 0x4f54544f ? 'cff' : 'truetype',
    familyNames: names.familyNames,
    fullNames: names.fullNames
  };
}

function collectUniqueFaceNames(faces, property) {
  const values = [];
  const keys = new Set();
  for (const face of faces) {
    for (const value of face[property]) appendUniqueName(values, keys, value);
  }
  return values;
}

function inspectFontBuffer(input, options = {}) {
  const maximumBytes = Number.isSafeInteger(options.maximumBytes) && options.maximumBytes > 0
    ? Math.min(options.maximumBytes, MAX_FONT_FILE_BYTES)
    : MAX_FONT_FILE_BYTES;
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buffer.length) throw fontError('FONT_FILE_EMPTY', '글꼴 파일이 비어 있습니다.');
  if (buffer.length > maximumBytes) throw fontError('FONT_FILE_TOO_LARGE', '글꼴 파일이 허용된 크기를 초과합니다.');
  if (buffer.length < 12) throw fontError('FONT_SFNT_INVALID', '글꼴 파일의 SFNT 헤더가 올바르지 않습니다.');

  let container = 'sfnt';
  let faceOffsets = [0];
  if (buffer.subarray(0, 4).toString('latin1') === 'ttcf') {
    container = 'ttc';
    const version = buffer.readUInt32BE(4);
    const faceCount = buffer.readUInt32BE(8);
    if (![0x00010000, 0x00020000].includes(version) || !faceCount || faceCount > MAX_FONT_FACES) {
      throw fontError('FONT_TTC_INVALID', 'TrueType Collection 헤더가 올바르지 않습니다.');
    }
    const baseHeaderLength = 12 + (faceCount * 4);
    const headerLength = baseHeaderLength + (version === 0x00020000 ? 12 : 0);
    checkedRange(buffer, 0, headerLength, 'FONT_TTC_INVALID');
    faceOffsets = [];
    const seenOffsets = new Set();
    for (let index = 0; index < faceCount; index += 1) {
      const offset = buffer.readUInt32BE(12 + (index * 4));
      if (offset < headerLength || offset % 4 !== 0 || seenOffsets.has(offset)) {
        throw fontError('FONT_TTC_INVALID', 'TrueType Collection의 글꼴 위치가 올바르지 않습니다.');
      }
      checkedRange(buffer, offset, 12, 'FONT_TTC_INVALID');
      seenOffsets.add(offset);
      faceOffsets.push(offset);
    }
    if (version === 0x00020000) {
      const dsigLength = buffer.readUInt32BE(baseHeaderLength + 4);
      const dsigOffset = buffer.readUInt32BE(baseHeaderLength + 8);
      if (dsigLength) checkedRange(buffer, dsigOffset, dsigLength, 'FONT_TTC_INVALID');
      else if (dsigOffset !== 0) throw fontError('FONT_TTC_INVALID', 'TrueType Collection의 DSIG 범위가 올바르지 않습니다.');
    }
  }

  const faces = faceOffsets.map((offset, index) => inspectSfntFace(buffer, offset, index));
  const familyNames = collectUniqueFaceNames(faces, 'familyNames');
  const fullNames = collectUniqueFaceNames(faces, 'fullNames');
  return {
    container,
    byteLength: buffer.length,
    faces,
    familyNames,
    fullNames
  };
}

function verifyExactFamily(fontOrInspection, expectedFamily) {
  const displayFamily = canonicalFontName(expectedFamily, '요청한 글꼴 가족 이름');
  const expectedKey = normalizeExactFontName(displayFamily);
  const inspection = Buffer.isBuffer(fontOrInspection) || fontOrInspection instanceof Uint8Array
    ? inspectFontBuffer(fontOrInspection)
    : fontOrInspection;
  if (!inspection || !Array.isArray(inspection.familyNames)) {
    throw fontError('FONT_INSPECTION_INVALID', '글꼴 검사 결과가 올바르지 않습니다.');
  }
  const matchedFaces = (inspection.faces || []).filter((face) => (
    Array.isArray(face.familyNames)
      && face.familyNames.some((name) => normalizeExactFontName(name) === expectedKey)
  ));
  const matched = inspection.familyNames.some((name) => normalizeExactFontName(name) === expectedKey);
  if (!matched) {
    throw fontError('FONT_FAMILY_MISMATCH', `선택한 파일에 정확한 글꼴 가족 '${displayFamily}'이(가) 없습니다.`);
  }
  return { inspection, expectedFamily: displayFamily, matchedFaces };
}

function normalizeExitCode(result) {
  if (typeof result === 'number') return result;
  if (Number.isInteger(result?.exitCode)) return result.exitCode;
  if (Number.isInteger(result?.code)) return result.code;
  return 0;
}

function stdoutText(result) {
  if (typeof result?.stdout === 'string') return result.stdout;
  if (Buffer.isBuffer(result?.stdout) || result?.stdout instanceof Uint8Array) {
    return Buffer.from(result.stdout).toString('utf8');
  }
  return '';
}

function defaultRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs || 60_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error && Number.isInteger(error.code)) return resolve({ code: error.code, stdout, stderr, error });
      if (error) return reject(error);
      return resolve({ code: 0, stdout, stderr });
    });
  });
}

function runnerFunction(runner) {
  if (typeof runner === 'function') return runner;
  if (runner && typeof runner.run === 'function') return runner.run.bind(runner);
  return defaultRunner;
}

async function runCommand(run, command, args, options, failureCode, allowedCodes = [0]) {
  let result;
  try {
    result = await run(command, [...args], {
      ...options,
      shell: false,
      requiresAdministrator: false,
      elevation: 'none'
    });
  } catch (error) {
    throw fontError(failureCode, '사용자 글꼴 준비 명령을 실행하지 못했습니다.', error);
  }
  const exitCode = normalizeExitCode(result);
  if (!allowedCodes.includes(exitCode)) {
    throw fontError(failureCode, `사용자 글꼴 준비 명령이 종료 코드 ${exitCode}(으)로 실패했습니다.`);
  }
  return { ...(result && typeof result === 'object' ? result : {}), exitCode };
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function buildFontRuntimePowerShellArguments(operation, fontPaths) {
  try { return fontRuntimePowerShellArguments(operation, fontPaths); }
  catch (error) { throw fontError('FONT_RUNTIME_ACTION_INVALID', '글꼴 런타임 등록 작업이 올바르지 않습니다.', error); }
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(String(left)).toLocaleLowerCase('en-US')
    === path.win32.normalize(String(right)).toLocaleLowerCase('en-US');
}

async function withFontTargetLock(targetPath, work) {
  const key = path.win32.normalize(String(targetPath)).toLocaleLowerCase('en-US');
  return withKeyedLock(FONT_TARGET_LOCKS, key, work);
}

async function withFontContentLock(digest, work) {
  return withKeyedLock(FONT_CONTENT_LOCKS, String(digest).toLocaleLowerCase('en-US'), work);
}

async function withKeyedLock(locks, key, work) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function queryRegistryValue(run, valueName, expectedTarget) {
  const registry = { key: USER_FONT_REGISTRY_KEY, valueName };
  const result = await runCommand(run, 'powershell.exe', fontRegistryQueryPowerShellArguments(registry),
    { operation: 'user-font-registry-query', windowsHide: true }, 'FONT_REGISTRY_QUERY_FAILED', [0, 3]);
  if (result.exitCode === 3) return { exists: false, registry };
  const encodedTarget = stdoutText(result).trim();
  if (!encodedTarget || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedTarget) || encodedTarget.length % 4 !== 0) {
    throw fontError('FONT_REGISTRY_CONFLICT', '같은 등록 이름의 기존 값을 안전하게 확인할 수 없습니다.');
  }
  const existingTarget = Buffer.from(encodedTarget, 'base64').toString('utf8');
  if (!existingTarget || !sameWindowsPath(existingTarget, expectedTarget)) {
    throw fontError('FONT_REGISTRY_CONFLICT', '같은 등록 이름이 다른 글꼴 파일을 가리켜 덮어쓰지 않았습니다.');
  }
  return { exists: true, target: existingTarget, registry };
}

function fsPromises(fsImpl) {
  const candidate = fsImpl?.promises || fsImpl;
  const methods = ['stat', 'readFile', 'mkdir', 'writeFile', 'rename', 'rm'];
  if (!candidate || methods.some((method) => typeof candidate[method] !== 'function')) {
    throw fontError('FS_ADAPTER_INVALID', '안전한 사용자 글꼴 설치에 필요한 파일 시스템 기능이 없습니다.');
  }
  return candidate;
}

async function exists(fsp, target) {
  try {
    await fsp.stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeFontAtomically(fsp, target, data, expectedHash) {
  if (await exists(fsp, target)) {
    const current = await fsp.readFile(target);
    if (crypto.createHash('sha256').update(current).digest('hex') === expectedHash) return false;
    throw fontError('FONT_DESTINATION_CONFLICT', '같은 설치 경로에 다른 글꼴 파일이 있어 덮어쓰지 않았습니다.');
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.cmoe-${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, data, { flag: 'wx' });
  try {
    await fsp.rename(temporary, target);
    return true;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    if (await exists(fsp, target)) {
      const current = await fsp.readFile(target);
      if (crypto.createHash('sha256').update(current).digest('hex') === expectedHash) return false;
    }
    throw fontError('FONT_ATOMIC_COPY_FAILED', '글꼴 파일을 사용자 Fonts 폴더에 원자적으로 복사하지 못했습니다.', error);
  }
}

function safeSourcePath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw fontError('FONT_SOURCE_PATH_INVALID', '선택한 글꼴 파일의 절대 경로가 필요합니다.');
  }
  const extension = path.extname(filePath).toLocaleLowerCase('en-US');
  if (!ALLOWED_SOURCE_EXTENSIONS.has(extension)) {
    throw fontError('FONT_SOURCE_EXTENSION_INVALID', 'TTF, OTF 또는 TTC 글꼴 파일만 선택할 수 있습니다.');
  }
  return { filePath: path.resolve(filePath), extension };
}

function createUserFontFileInstaller(options = {}) {
  const fsp = fsPromises(options.fs || nodeFs);
  const run = runnerFunction(options.runner);
  const localAppData = options.localAppData;
  const platform = options.platform || process.platform;
  if (typeof localAppData !== 'string' || !path.isAbsolute(localAppData)) {
    throw fontError('LOCAL_APP_DATA_INVALID', '사용자 Fonts 폴더를 찾기 위한 절대 LOCALAPPDATA 경로가 필요합니다.');
  }
  const fontDirectory = path.join(path.resolve(localAppData), 'Microsoft', 'Windows', 'Fonts');

  async function inspectFile(filePath) {
    const source = safeSourcePath(filePath);
    const stat = await fsp.stat(source.filePath).catch((error) => {
      throw fontError('FONT_SOURCE_READ_FAILED', '선택한 글꼴 파일 정보를 읽지 못했습니다.', error);
    });
    if (!stat.isFile() || stat.size <= 0) throw fontError('FONT_SOURCE_NOT_FILE', '선택한 경로가 비어 있지 않은 글꼴 파일이 아닙니다.');
    if (stat.size > MAX_FONT_FILE_BYTES) throw fontError('FONT_FILE_TOO_LARGE', '글꼴 파일이 허용된 크기를 초과합니다.');
    let data;
    try {
      data = await fsp.readFile(source.filePath);
    } catch (error) {
      throw fontError('FONT_SOURCE_READ_FAILED', '선택한 글꼴 파일을 읽지 못했습니다.', error);
    }
    if (data.length > MAX_FONT_FILE_BYTES) throw fontError('FONT_FILE_TOO_LARGE', '글꼴 파일이 허용된 크기를 초과합니다.');
    return { source, data: Buffer.from(data), inspection: inspectFontBuffer(data) };
  }

  async function installFontFile(request, expectedFamilyArgument) {
    if (platform !== 'win32') throw fontError('WINDOWS_REQUIRED', '사용자 글꼴 원클릭 설치는 Windows에서만 지원합니다.');
    const input = typeof request === 'string'
      ? { filePath: request, expectedFamily: expectedFamilyArgument }
      : request;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw fontError('FONT_INSTALL_REQUEST_INVALID', '사용자 글꼴 설치 요청이 올바르지 않습니다.');
    }
    const inspected = await inspectFile(input.filePath);
    const verified = verifyExactFamily(inspected.inspection, input.expectedFamily);
    const digest = crypto.createHash('sha256').update(inspected.data).digest('hex');
    const destinationExtension = inspected.inspection.container === 'ttc'
      ? '.ttc'
      : inspected.source.extension;
    const targetPath = path.join(fontDirectory, `CMOE-${digest}${destinationExtension}`);
    const relativeTarget = path.relative(fontDirectory, targetPath);
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw fontError('FONT_DESTINATION_INVALID', '안전한 사용자 Fonts 설치 경로를 만들지 못했습니다.');
    }
    const matchedFullNames = collectUniqueFaceNames(verified.matchedFaces, 'fullNames');
    const displayName = matchedFullNames[0] || verified.expectedFamily;
    const registryValueName = `${displayName} (CMOE ${digest.slice(0, 12)})`;

    return withFontContentLock(digest, () => withFontTargetLock(targetPath, async () => {
      let targetCreated = false;
      let registryCreated = false;
      let runtimeRegistered = false;
      try {
        targetCreated = await writeFontAtomically(fsp, targetPath, inspected.data, digest);
        const existingRegistry = await queryRegistryValue(run, registryValueName, targetPath);
        if (!existingRegistry.exists) {
          const mutation = await runCommand(run, 'powershell.exe', fontRegistryMutationPowerShellArguments(
            'add', existingRegistry.registry, targetPath
          ), { operation: 'user-font-registry-add', windowsHide: true }, 'FONT_REGISTRY_ADD_FAILED');
          const mutationStatus = stdoutText(mutation).trim();
          if (!['created', 'existing'].includes(mutationStatus)) {
            throw fontError('FONT_REGISTRY_ADD_FAILED', '사용자 글꼴 등록 결과를 확인하지 못했습니다.');
          }
          registryCreated = mutationStatus === 'created';
          await queryRegistryValue(run, registryValueName, targetPath);
        }
        await runCommand(run, 'powershell.exe', buildFontRuntimePowerShellArguments('add', [targetPath]), {
          operation: 'user-font-runtime-register',
          windowsHide: true,
        }, 'FONT_RUNTIME_REGISTRATION_FAILED');
        runtimeRegistered = true;
        return {
          kind: 'userFontFile',
          installed: true,
          alreadyInstalled: !targetCreated && !registryCreated,
          expectedFamily: verified.expectedFamily,
          familyNames: inspected.inspection.familyNames,
          fullNames: inspected.inspection.fullNames,
          container: inspected.inspection.container,
          sha256: digest,
          targetPath,
          registryValueName,
          registryCreated,
          runtimeRegistered: true,
          requiresAdministrator: false,
          downloaded: false
        };
      } catch (error) {
        if (runtimeRegistered) {
          await run('powershell.exe', buildFontRuntimePowerShellArguments('remove', [targetPath]), {
            operation: 'user-font-runtime-rollback',
            windowsHide: true,
            shell: false,
            requiresAdministrator: false,
            elevation: 'none'
          }).catch(() => {});
        }
        if (registryCreated) {
          await run('powershell.exe', fontRegistryMutationPowerShellArguments('remove', {
            key: USER_FONT_REGISTRY_KEY,
            valueName: registryValueName
          }, targetPath), {
            operation: 'user-font-registry-rollback',
            windowsHide: true,
            shell: false,
            requiresAdministrator: false,
            elevation: 'none'
          }).catch(() => {});
        }
        if (targetCreated) await fsp.rm(targetPath, { force: true }).catch(() => {});
        throw error;
      }
    }));
  }

  return Object.freeze({
    inspectFile: async (filePath) => {
      const result = await inspectFile(filePath);
      return result.inspection;
    },
    installFontFile,
    install: installFontFile
  });
}

module.exports = Object.freeze({
  MAX_FONT_FILE_BYTES,
  MAX_FONT_FACES,
  MAX_TABLES_PER_FACE,
  MAX_NAME_RECORDS,
  USER_FONT_REGISTRY_KEY,
  ALLOWED_SOURCE_EXTENSIONS,
  UserFontFileInstallError,
  canonicalFontName,
  normalizeExactFontName,
  inspectFontBuffer,
  verifyExactFamily,
  buildFontRuntimePowerShellArguments,
  createUserFontFileInstaller
});
