'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { TextDecoder } = require('node:util');

const RHWP_VERSION = '0.8.4';
const RHWP_RELEASE_URL = 'https://github.com/edwardkim/rhwp/releases/download/v0.8.4/rhwp-v0.8.4-windows-x86_64.zip';
const RHWP_ARCHIVE_SHA256 = 'e65b3e220573b18e1588768c5a16684eb89b2daf2488768575444cb83cd1b8c6';
const RHWP_EXECUTABLE_SHA256 = '56c26d809b1e09310b34c6c8449eacf97b8dd00b164aa25262e3c08f99f1093d';
const RHWP_RUNTIME_RELATIVE = Object.freeze(['document-tools', 'runtimes', 'rhwp', RHWP_VERSION]);
const RHWP_MARKER_FILE = '.cmoe-rhwp-runtime.json';
const INFO_TIMEOUT_MS = 30_000;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_FONT_FAMILIES = 4_096;
const MAX_FONT_FAMILY_LENGTH = 256;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * rhwp v0.8.4 machine-output contract used here:
 *
 * - The tagged implementation's `info_json_value` emits a versioned envelope
 *   with `schemaVersion`, the exact CLI `source` argument, `format`, and a
 *   `fonts: Vec<String>` collected from the first HWP font-face language set:
 *   https://github.com/edwardkim/rhwp/blob/v0.8.4/src/main.rs#L8742-L8804
 * - The tagged contract test fixes `schemaVersion === "1.0"`, string source,
 *   format, and an array-valued fonts field (new fields may be added):
 *   https://github.com/edwardkim/rhwp/blob/v0.8.4/tests/cli_json_contract.rs#L77-L101
 * - The tagged CLI manual documents `info <file> [--json]` and the same
 *   envelope fields:
 *   https://github.com/edwardkim/rhwp/blob/v0.8.4/mydocs/manual/cli_commands.md
 *
 * Binary `.hwp` may report `hwp5` or `hwp3`; HWPX/HML are intentionally not
 * accepted by this adapter because they have a separate in-process inspector.
 */

class DocumentRhwpInspectionError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'DocumentRhwpInspectionError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function inspectionError(code, message, cause) {
  return new DocumentRhwpInspectionError(code, message, cause);
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function unavailableRuntimeResult() {
  return {
    checked: false,
    supported: false,
    format: 'hwp',
    usedFonts: [],
    embeddedFonts: [],
    families: [],
    reasonCode: 'RHWP_RUNTIME_REQUIRED',
    requiredDependency: 'rhwp'
  };
}

function unsupportedInputResult(format) {
  return {
    checked: false,
    supported: false,
    format: format || null,
    usedFonts: [],
    embeddedFonts: [],
    families: [],
    reasonCode: 'RHWP_INPUT_FORMAT_UNSUPPORTED'
  };
}

function normalizeExtension(value) {
  const extension = String(value || '').trim().replace(/^\./, '').toLocaleLowerCase('en-US');
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : '';
}

function normalizeOptions(extensionOrOptions, suppliedOptions) {
  if (typeof extensionOrOptions === 'string') {
    const options = suppliedOptions && typeof suppliedOptions === 'object' && !Array.isArray(suppliedOptions)
      ? suppliedOptions
      : {};
    return { ...options, extension: normalizeExtension(extensionOrOptions) };
  }
  if (extensionOrOptions == null) return {};
  if (typeof extensionOrOptions !== 'object' || Array.isArray(extensionOrOptions)) {
    throw inspectionError('RHWP_OPTIONS_INVALID', 'rHWP 검사 옵션이 올바르지 않습니다.');
  }
  return { ...extensionOrOptions };
}

function fsPromises(fsImpl) {
  const fsp = fsImpl?.promises || fsImpl;
  if (!fsp || typeof fsp.lstat !== 'function' || typeof fsp.stat !== 'function'
    || typeof fsp.readFile !== 'function' || typeof fsp.realpath !== 'function') {
    throw inspectionError('RHWP_FS_ADAPTER_INVALID', 'rHWP 검사에는 lstat/stat/readFile/realpath 파일 시스템 어댑터가 필요합니다.');
  }
  return fsp;
}

function isNotFound(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateRelativeExecutable(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 2_048
    || value.includes('\\') || value.includes('\u0000') || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || /%(?:2e|2f|5c|25)/i.test(value)) {
    throw inspectionError('RHWP_MARKER_PATH_INVALID', 'rHWP marker의 실행 파일 상대경로가 올바르지 않습니다.');
  }
  const segments = value.split('/');
  if (segments.length > 32 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw inspectionError('RHWP_MARKER_PATH_INVALID', 'rHWP marker의 실행 파일 경로가 runtime을 벗어날 수 있습니다.');
  }
  for (const segment of segments) {
    if (segment.length > 255 || /[<>:"|?*\u0000-\u001f\u007f]/.test(segment)
      || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment)) {
      throw inspectionError('RHWP_MARKER_PATH_INVALID', 'rHWP marker에 Windows에서 안전하지 않은 실행 파일 경로가 있습니다.');
    }
  }
  if (segments.at(-1).toLocaleLowerCase('en-US') !== 'rhwp.exe') {
    throw inspectionError('RHWP_MARKER_PATH_INVALID', 'rHWP marker는 rhwp.exe만 가리킬 수 있습니다.');
  }
  return segments;
}

function parseMarker(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(String(source || ''), 'utf8');
  if (!bytes.length || bytes.length > MAX_MARKER_BYTES) {
    throw inspectionError('RHWP_MARKER_SIZE_INVALID', 'rHWP runtime marker 크기가 올바르지 않습니다.');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw inspectionError('RHWP_MARKER_INVALID', 'rHWP runtime marker가 올바른 UTF-8이 아닙니다.', error); }
  let marker;
  try { marker = JSON.parse(text); }
  catch (error) { throw inspectionError('RHWP_MARKER_INVALID', 'rHWP runtime marker JSON이 손상되었습니다.', error); }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || marker.schemaVersion !== 1 || marker.product !== 'rhwp'
    || marker.version !== RHWP_VERSION || marker.url !== RHWP_RELEASE_URL
    || marker.sha256 !== RHWP_ARCHIVE_SHA256
    || (Object.hasOwn(marker, 'executableSha256') && marker.executableSha256 !== RHWP_EXECUTABLE_SHA256)) {
    throw inspectionError('RHWP_MARKER_INVALID', 'rHWP runtime marker가 고정 v0.8.4 release 정보와 일치하지 않습니다.');
  }
  return { marker, executableSegments: validateRelativeExecutable(marker.executable) };
}

async function optionalLstat(fsp, target) {
  try { return await fsp.lstat(target); }
  catch (error) {
    if (isNotFound(error)) return null;
    throw inspectionError('RHWP_RUNTIME_READ_FAILED', 'rHWP runtime 상태를 읽지 못했습니다.', error);
  }
}

async function resolveRhwpRuntime(options) {
  const userDataPath = options.userDataPath;
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || userDataPath.includes('\u0000')) {
    throw inspectionError('RHWP_USER_DATA_PATH_INVALID', '절대 경로인 userDataPath가 필요합니다.');
  }
  const fsp = fsPromises(options.fs || nodeFs);
  const runtimePath = path.join(userDataPath, ...RHWP_RUNTIME_RELATIVE);
  const markerPath = path.join(runtimePath, RHWP_MARKER_FILE);
  const runtimeStats = await optionalLstat(fsp, runtimePath);
  if (!runtimeStats) return null;
  if (!runtimeStats.isDirectory?.() || runtimeStats.isSymbolicLink?.()) {
    throw inspectionError('RHWP_RUNTIME_PATH_INVALID', 'rHWP runtime 경로가 실제 디렉터리가 아닙니다.');
  }
  const markerStats = await optionalLstat(fsp, markerPath);
  if (!markerStats) return null;
  if (!markerStats.isFile?.() || markerStats.isSymbolicLink?.()) {
    throw inspectionError('RHWP_MARKER_INVALID', 'rHWP runtime marker가 실제 일반 파일이 아닙니다.');
  }
  if (!Number.isSafeInteger(markerStats.size) || markerStats.size <= 0 || markerStats.size > MAX_MARKER_BYTES) {
    throw inspectionError('RHWP_MARKER_SIZE_INVALID', 'rHWP runtime marker 크기가 올바르지 않습니다.');
  }
  let markerBytes;
  try { markerBytes = await fsp.readFile(markerPath); }
  catch (error) { throw inspectionError('RHWP_MARKER_READ_FAILED', 'rHWP runtime marker를 읽지 못했습니다.', error); }
  const { marker, executableSegments } = parseMarker(markerBytes);
  const executablePath = path.resolve(runtimePath, ...executableSegments);
  if (!isWithin(runtimePath, executablePath)) {
    throw inspectionError('RHWP_MARKER_PATH_INVALID', 'rHWP 실행 파일 경로가 runtime 경계를 벗어납니다.');
  }
  const executableStats = await optionalLstat(fsp, executablePath);
  if (!executableStats) throw inspectionError('RHWP_EXECUTABLE_MISSING', '검증된 rHWP runtime에 rhwp.exe가 없습니다.');
  if (!executableStats.isFile?.() || executableStats.isSymbolicLink?.()
    || !Number.isSafeInteger(executableStats.size) || executableStats.size <= 0
    || executableStats.size > MAX_EXECUTABLE_BYTES) {
    throw inspectionError('RHWP_EXECUTABLE_INVALID', 'rHWP 실행 파일이 실제 허용 크기의 일반 파일이 아닙니다.');
  }
  let executableBytes;
  try { executableBytes = await fsp.readFile(executablePath); }
  catch (error) { throw inspectionError('RHWP_EXECUTABLE_READ_FAILED', 'rHWP 실행 파일을 검증하지 못했습니다.', error); }
  const digestSha256 = options.digestSha256 || sha256Buffer;
  if (typeof digestSha256 !== 'function') {
    throw inspectionError('RHWP_HASH_ADAPTER_INVALID', 'rHWP SHA-256 검증기를 사용할 수 없습니다.');
  }
  const executableDigest = String(await digestSha256(executableBytes)).toLocaleLowerCase('en-US');
  if (executableDigest !== RHWP_EXECUTABLE_SHA256) {
    throw inspectionError('RHWP_EXECUTABLE_HASH_MISMATCH', 'rHWP 실행 파일이 검증된 v0.8.4 파일과 일치하지 않습니다. 다시 준비해주세요.');
  }

  let userDataReal;
  let runtimeReal;
  let executableReal;
  try {
    [userDataReal, runtimeReal, executableReal] = await Promise.all([
      fsp.realpath(userDataPath),
      fsp.realpath(runtimePath),
      fsp.realpath(executablePath)
    ]);
  } catch (error) {
    throw inspectionError('RHWP_RUNTIME_REALPATH_FAILED', 'rHWP runtime의 실제 경로를 확인하지 못했습니다.', error);
  }
  if (!isWithin(userDataReal, runtimeReal) || !isWithin(runtimeReal, executableReal)
    || path.basename(executableReal).toLocaleLowerCase('en-US') !== 'rhwp.exe') {
    throw inspectionError('RHWP_RUNTIME_BOUNDARY_VIOLATION', 'rHWP 실행 파일의 실제 경로가 앱 runtime 경계를 벗어납니다.');
  }
  return { runtimePath, markerPath, executablePath, marker };
}

function defaultRunner(executablePath, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executablePath, args, {
      shell: false,
      windowsHide: true,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      encoding: 'buffer',
      signal: options.signal
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  });
}

function runnerFunction(runner) {
  if (typeof runner === 'function') return runner;
  if (runner && typeof runner.run === 'function') return runner.run.bind(runner);
  if (runner == null) return defaultRunner;
  throw inspectionError('RHWP_RUNNER_INVALID', 'rHWP runner가 함수 또는 run 메서드를 제공해야 합니다.');
}

function decodeProcessOutput(value, label) {
  if (value == null) return '';
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
      throw inspectionError('RHWP_INFO_OUTPUT_LIMIT', `rHWP ${label} 출력이 허용 크기를 초과합니다.`);
    }
    return value;
  }
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw inspectionError('RHWP_PROCESS_RESULT_INVALID', `rHWP ${label} 출력 형식이 올바르지 않습니다.`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length > MAX_PROCESS_OUTPUT_BYTES) {
    throw inspectionError('RHWP_INFO_OUTPUT_LIMIT', `rHWP ${label} 출력이 허용 크기를 초과합니다.`);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw inspectionError('RHWP_INFO_JSON_INVALID', `rHWP ${label} 출력이 올바른 UTF-8이 아닙니다.`, error); }
}

function exitCode(result) {
  if (Number.isInteger(result?.exitCode)) return result.exitCode;
  if (Number.isInteger(result?.code)) return result.code;
  throw inspectionError('RHWP_PROCESS_RESULT_INVALID', 'rHWP runner가 정수 종료 코드를 반환하지 않았습니다.');
}

function timeoutLike(error) {
  return error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR' || error?.name === 'AbortError'
    || error?.timedOut === true || (error?.killed === true && error?.signal === 'SIGTERM');
}

function outputLimitLike(error) {
  return error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    || Buffer.isBuffer(error?.stdout) && error.stdout.length > MAX_PROCESS_OUTPUT_BYTES
    || Buffer.isBuffer(error?.stderr) && error.stderr.length > MAX_PROCESS_OUTPUT_BYTES
    || typeof error?.stdout === 'string' && Buffer.byteLength(error.stdout, 'utf8') > MAX_PROCESS_OUTPUT_BYTES
    || typeof error?.stderr === 'string' && Buffer.byteLength(error.stderr, 'utf8') > MAX_PROCESS_OUTPUT_BYTES;
}

async function runRhwpInfo(executablePath, inputPath, runner) {
  const run = runnerFunction(runner);
  const args = ['info', inputPath, '--json'];
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(inspectionError('RHWP_INFO_TIMEOUT', 'rHWP info 검사가 30초를 초과했습니다.'));
  }, INFO_TIMEOUT_MS);
  let result;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => run(executablePath, [...args], {
        shell: false,
        windowsHide: true,
        timeout: INFO_TIMEOUT_MS,
        timeoutMs: INFO_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        signal: controller.signal
      })),
      timeoutPromise
    ]);
  } catch (error) {
    if (timedOut || timeoutLike(error)) {
      throw inspectionError('RHWP_INFO_TIMEOUT', 'rHWP info 검사가 30초를 초과했습니다.', error);
    }
    if (outputLimitLike(error)) {
      throw inspectionError('RHWP_INFO_OUTPUT_LIMIT', 'rHWP info 출력이 허용 크기를 초과했습니다.', error);
    }
    throw inspectionError('RHWP_INFO_FAILED', 'rHWP info 실행에 실패했습니다.', error);
  } finally {
    clearTimeout(timer);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw inspectionError('RHWP_PROCESS_RESULT_INVALID', 'rHWP runner 결과가 올바르지 않습니다.');
  }
  if (result.timedOut === true) throw inspectionError('RHWP_INFO_TIMEOUT', 'rHWP info 검사가 30초를 초과했습니다.');
  const stdout = decodeProcessOutput(result.stdout, 'stdout');
  decodeProcessOutput(result.stderr, 'stderr');
  const code = exitCode(result);
  if (code !== 0) throw inspectionError('RHWP_INFO_FAILED', `rHWP info가 종료 코드 ${code}(으)로 실패했습니다.`);
  if (!stdout.trim()) throw inspectionError('RHWP_INFO_JSON_INVALID', 'rHWP info stdout이 비어 있습니다.');
  return stdout;
}

function validateOptionalInteger(value, field, expected) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || expected !== undefined && value !== expected) {
    throw inspectionError('RHWP_INFO_SCHEMA_INVALID', `rHWP info의 ${field} 값이 올바르지 않습니다.`);
  }
}

function parseRhwpInfoJson(stdout, inputPath, inputBytes) {
  let value;
  try { value = JSON.parse(stdout.trim()); }
  catch (error) { throw inspectionError('RHWP_INFO_JSON_INVALID', 'rHWP info stdout이 단일 JSON 객체가 아닙니다.', error); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== '1.0') {
    throw inspectionError('RHWP_INFO_SCHEMA_INVALID', 'rHWP info schemaVersion 1.0 객체가 필요합니다.');
  }
  if (typeof value.source !== 'string' || value.source !== inputPath) {
    throw inspectionError('RHWP_INFO_SOURCE_MISMATCH', 'rHWP info source가 요청한 입력 경로와 일치하지 않습니다.');
  }
  if (!['hwp5', 'hwp3'].includes(value.format)) {
    throw inspectionError('RHWP_INFO_FORMAT_INVALID', 'binary HWP는 rhwp format hwp5 또는 hwp3이어야 합니다.');
  }
  if (!Array.isArray(value.fonts) || value.fonts.length > MAX_FONT_FAMILIES) {
    throw inspectionError('RHWP_INFO_FONTS_INVALID', 'rHWP info fonts 배열이 올바르지 않습니다.');
  }
  const families = [];
  const seen = new Set();
  for (const item of value.fonts) {
    if (typeof item !== 'string' || item !== item.trim() || !item || item.length > MAX_FONT_FAMILY_LENGTH
      || /[\u0000-\u001f\u007f]/.test(item)) {
      throw inspectionError('RHWP_INFO_FONTS_INVALID', 'rHWP info fonts에는 공백 없는 실제 글꼴 이름 문자열만 허용됩니다.');
    }
    if (!seen.has(item)) {
      seen.add(item);
      families.push(item);
    }
  }
  validateOptionalInteger(value.sizeBytes, 'sizeBytes', inputBytes);
  validateOptionalInteger(value.sections, 'sections');
  validateOptionalInteger(value.pageCount, 'pageCount');
  validateOptionalInteger(value.paraCount, 'paraCount');
  if (value.warnings !== undefined && !Array.isArray(value.warnings)) {
    throw inspectionError('RHWP_INFO_SCHEMA_INVALID', 'rHWP info warnings는 배열이어야 합니다.');
  }
  return {
    checked: true,
    supported: true,
    format: 'hwp',
    usedFonts: families,
    embeddedFonts: [],
    families: [...families]
  };
}

async function inspectHwpFonts(inputPath, options = {}) {
  if (typeof inputPath !== 'string' || !inputPath || inputPath !== inputPath.trim()
    || inputPath.length > 32_767 || inputPath.includes('\u0000') || !path.isAbsolute(inputPath)) {
    throw inspectionError('RHWP_INPUT_PATH_INVALID', 'binary HWP 입력은 절대 파일 경로여야 합니다.');
  }
  const extension = normalizeExtension(options.extension || path.extname(inputPath));
  if (extension !== 'hwp') return unsupportedInputResult(extension);
  const runtime = await resolveRhwpRuntime(options);
  if (!runtime) return unavailableRuntimeResult();

  const fsp = fsPromises(options.fs || nodeFs);
  let inputStats;
  try { inputStats = await fsp.stat(inputPath); }
  catch (error) {
    throw inspectionError(isNotFound(error) ? 'RHWP_INPUT_NOT_FOUND' : 'RHWP_INPUT_READ_FAILED', 'binary HWP 입력 파일을 읽을 수 없습니다.', error);
  }
  if (!inputStats.isFile?.()) throw inspectionError('RHWP_INPUT_INVALID', 'binary HWP 입력은 실제 일반 파일이어야 합니다.');
  if (!Number.isSafeInteger(inputStats.size) || inputStats.size <= 0 || inputStats.size > MAX_INPUT_BYTES) {
    throw inspectionError('RHWP_INPUT_SIZE_INVALID', 'binary HWP 입력 크기가 허용 범위를 벗어났습니다.');
  }
  const stdout = await runRhwpInfo(runtime.executablePath, inputPath, options.runner);
  return parseRhwpInfoJson(stdout, inputPath, inputStats.size);
}

async function inspectDocumentFonts(inputPath, extensionOrOptions = {}, suppliedOptions = {}) {
  const options = normalizeOptions(extensionOrOptions, suppliedOptions);
  return inspectHwpFonts(inputPath, options);
}

function createDocumentRhwpInspector(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw inspectionError('RHWP_OPTIONS_INVALID', 'rHWP inspector 옵션이 올바르지 않습니다.');
  }
  return Object.freeze({
    inspectHwpFonts: (inputPath, callOptions = {}) => inspectHwpFonts(inputPath, { ...options, ...callOptions }),
    inspectDocumentFonts: (inputPath, extension = 'hwp') => inspectDocumentFonts(inputPath, extension, options),
    resolveRuntime: () => resolveRhwpRuntime(options)
  });
}

module.exports = {
  RHWP_VERSION,
  RHWP_RELEASE_URL,
  RHWP_ARCHIVE_SHA256,
  RHWP_EXECUTABLE_SHA256,
  RHWP_RUNTIME_RELATIVE,
  RHWP_MARKER_FILE,
  INFO_TIMEOUT_MS,
  MAX_INPUT_BYTES,
  MAX_MARKER_BYTES,
  MAX_PROCESS_OUTPUT_BYTES,
  MAX_FONT_FAMILIES,
  DocumentRhwpInspectionError,
  sha256Buffer,
  unavailableRuntimeResult,
  parseRhwpInfoJson,
  resolveRhwpRuntime,
  inspectHwpFonts,
  inspectDocumentFonts,
  createDocumentRhwpInspector,
  createRhwpDocumentInspector: createDocumentRhwpInspector
};
