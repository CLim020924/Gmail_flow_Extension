'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const NativeOfficeMerge = require('./native-office-merge');
const { inspectXlsxWorkbookStructure } = require('./spreadsheet');

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_COMBINED_SHEET_NAME = '전체 통합';

function fallbackError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function workerMessage(code) {
  const messages = {
    DOCUMENT_TOOL_CANCELLED: 'Excel 합치기를 중단했습니다.',
    INPUT_COUNT_INVALID: '합칠 Excel 파일을 2개 이상, 500개 이하로 선택해주세요.',
    INPUT_FORMAT_INVALID: 'LibreOffice 호환 병합은 안전 검사를 마친 XLSX 파일만 사용할 수 있습니다.',
    INPUT_IDENTITY_INVALID: 'Excel 원본 확인 정보가 올바르지 않습니다. 파일을 다시 선택해주세요.',
    INPUT_IDENTITY_CHANGED: '선택한 Excel 파일이 확인 이후 바뀌었습니다. 현재 파일을 다시 선택해주세요.',
    INPUT_TOTAL_SIZE_INVALID: '선택한 Excel 파일의 전체 크기가 안전한 처리 한도를 넘습니다.',
    INPUT_NOT_FOUND: '선택한 Excel 파일을 찾을 수 없습니다.',
    OUTPUT_EXISTS: '같은 이름의 병합 결과가 이미 있습니다. 다른 이름을 사용해주세요.',
    OUTPUT_FORMAT_INVALID: 'Excel 병합 결과는 XLSX 파일로 저장해야 합니다.',
    OUTPUT_EQUALS_INPUT: '원본 파일과 같은 위치에는 병합 결과를 저장할 수 없습니다.',
    LIBREOFFICE_PATH_INVALID: '검증된 LibreOffice 실행 파일을 찾지 못했습니다.',
    LIBREOFFICE_PROFILE_FAILED: 'Excel 호환 병합용 격리 환경을 준비하지 못했습니다.',
    LIBREOFFICE_START_FAILED: 'LibreOffice를 안전한 호환 병합 모드로 실행하지 못했습니다. LibreOffice를 닫고 다시 시도해주세요.',
    LIBREOFFICE_INPUT_OPEN_FAILED: 'LibreOffice가 Excel 원본을 안전하게 열지 못했습니다.',
    LIBREOFFICE_BASE_COPY_FAILED: '첫 Excel 파일의 안전한 작업 복사본을 만들지 못했습니다.',
    LIBREOFFICE_SHEET_COUNT_INVALID: 'Excel 파일에서 합칠 시트를 찾지 못했거나 시트가 너무 많습니다.',
    LIBREOFFICE_SHEET_SIZE_INVALID: '한 시트의 사용 영역이 안전한 검증 한도를 넘습니다.',
    LIBREOFFICE_SHEET_INSPECTION_FAILED: 'Excel 시트의 셀 내용을 안전하게 확인하지 못했습니다.',
    LIBREOFFICE_SHEET_NAME_FAILED: '중복된 Excel 시트 이름을 안전하게 정리하지 못했습니다.',
    LIBREOFFICE_SHEET_COPY_FAILED: 'LibreOffice가 Excel 시트를 순서대로 복사하지 못했습니다.',
    LIBREOFFICE_FORMULA_REBIND_FAILED: '복사된 시트의 내부 수식 연결을 결과 통합문서에 다시 묶지 못했습니다.',
    LIBREOFFICE_SHEET_VISIBILITY_FAILED: '숨김 시트 상태를 안전하게 유지하지 못했습니다.',
    LIBREOFFICE_EXPECTED_STRUCTURE_INVALID: 'Excel 시트 순서 검증 정보가 일치하지 않아 병합을 시작하지 않았습니다. 파일을 다시 선택해주세요.',
    LIBREOFFICE_COMBINED_HEADER_MISSING: '전체 통합 시트를 만들 표의 첫 행 헤더를 찾지 못했습니다. 각 시트의 1행에 같은 헤더가 있는지 확인해주세요.',
    LIBREOFFICE_COMBINED_HEADER_MISMATCH: '시트마다 1행 헤더의 이름 또는 열 수가 달라 전체 통합 시트를 만들지 않았습니다. 헤더를 같게 맞춘 뒤 다시 시도해주세요.',
    LIBREOFFICE_COMBINED_SHEET_CREATE_FAILED: '전체 통합 시트를 안전하게 만들지 못했습니다.',
    LIBREOFFICE_COMBINED_SHEET_SIZE_INVALID: '전체 통합 시트의 행·열 수가 안전한 처리 한도를 넘어 통합을 진행하지 않았습니다.',
    LIBREOFFICE_COMBINED_OUTPUT_CHANGED: '저장 후 전체 통합 시트의 헤더·행·열·내용이 달라져 결과를 저장하지 않았습니다.',
    LIBREOFFICE_SAVE_FAILED: 'LibreOffice가 병합 결과를 XLSX로 저장하지 못했습니다.',
    LIBREOFFICE_OUTPUT_CONTENT_CHANGED: '저장 후 다시 확인한 결과 셀·수식·도형 수가 원본과 달라 결과를 저장하지 않았습니다.',
    LIBREOFFICE_OUTPUT_VERIFY_FAILED: '저장된 Excel 결과의 시트 순서와 내용을 다시 확인하지 못했습니다.'
  };
  return messages[String(code || '').trim()] || 'LibreOffice 호환 방식으로 Excel 시트를 합치지 못했습니다.';
}

function workerFailure(value) {
  const workerCode = String(value || '').trim().slice(0, 128);
  const code = workerCode === 'DOCUMENT_TOOL_CANCELLED'
    ? 'DOCUMENT_TOOL_CANCELLED'
    : 'LIBREOFFICE_EXCEL_MERGE_WORKER_FAILED';
  const error = fallbackError(code, workerMessage(workerCode));
  error.workerCode = workerCode;
  error.details = {
    engine: 'LibreOffice',
    workerCode,
    phase: /OUTPUT|SAVE/.test(workerCode) ? 'verify' : /SHEET_COPY|COMBINED/.test(workerCode) ? 'merge' : 'prepare'
  };
  return error;
}

function workerPath() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'office-tools', 'libreoffice-excel-merge.py');
  if (packaged && fs.existsSync(packaged)) return packaged;
  // An external Python process cannot read a script through Electron's ASAR
  // virtual filesystem. In a packaged build, return the expected external
  // resource path even when it is missing so runWorker fails closed with a
  // repairable "worker missing" error instead of handing Python an ASAR path.
  if (packaged && /(?:^|[\\/])app\.asar(?:[\\/]|$)/i.test(__dirname)) return packaged;
  return path.join(__dirname, 'libreoffice-excel-merge.py');
}

function pythonPath(libreOfficePath) {
  return path.join(path.dirname(path.resolve(libreOfficePath)), 'python.exe');
}

function appendBounded(current, chunk) {
  if (Buffer.byteLength(current, 'utf8') >= MAX_PROCESS_OUTPUT_BYTES) return current;
  return (current + String(chunk || '')).slice(0, MAX_PROCESS_OUTPUT_BYTES);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let graceTimer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      callback(value);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { options.onTimeout?.(); } catch (_) {}
      graceTimer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish(reject, fallbackError('LIBREOFFICE_EXCEL_MERGE_TIMEOUT', 'Excel 호환 병합 시간이 초과되었습니다. 파일 수를 줄여 다시 시도해주세요.'));
      }, Math.max(1_000, Number(options.cooperativeTimeoutGraceMs) || 30_000));
    }, Math.max(10_000, Math.min(MAX_TIMEOUT_MS, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)));
    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
      options.onStdout?.(String(chunk));
    });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (timedOut) {
        finish(reject, fallbackError('LIBREOFFICE_EXCEL_MERGE_TIMEOUT', 'Excel 호환 병합 시간이 초과되었습니다. 파일 수를 줄여 다시 시도해주세요.'));
        return;
      }
      finish(resolve, { code: Number(code), stdout, stderr });
    });
  });
}

function publicProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = { ok: value.ok === true };
  for (const key of ['index', 'completed', 'total']) {
    const number = Number(value[key]);
    if (Number.isInteger(number) && number >= 0 && number <= 10_000) output[key] = number;
  }
  return output;
}

async function runWorker(libreOfficePath, sources, outputPath, jobRoot, options = {}) {
  const executable = path.resolve(String(libreOfficePath || ''));
  const python = pythonPath(executable);
  const script = path.resolve(options.workerPath || workerPath());
  if (!fs.existsSync(executable) || !['soffice.exe', 'soffice.com'].includes(path.basename(executable).toLowerCase())) {
    throw fallbackError('LIBREOFFICE_EXCEL_MERGE_EXECUTABLE_INVALID', 'LibreOffice 실행 파일을 찾지 못했습니다.');
  }
  if (!fs.existsSync(python) || !fs.existsSync(script)) {
    throw fallbackError('LIBREOFFICE_EXCEL_MERGE_WORKER_MISSING', 'LibreOffice Excel 병합 도구를 찾지 못했습니다. 앱을 다시 설치해주세요.');
  }
  const resolvedRoot = path.resolve(jobRoot);
  const resultPath = path.join(resolvedRoot, `libreoffice-excel-result-${crypto.randomUUID()}.json`);
  const jobPath = path.join(resolvedRoot, `libreoffice-excel-job-${crypto.randomUUID()}.json`);
  const cancelPath = path.join(resolvedRoot, `libreoffice-excel-cancel-${crypto.randomUUID()}.signal`);
  const profilePath = path.join(resolvedRoot, `libreoffice-excel-profile-${crypto.randomUUID()}`);
  await fs.promises.writeFile(jobPath, JSON.stringify({
    operation: 'merge-excel',
    resultPath,
    cancelPath,
    profilePath,
    libreOfficePath: executable,
    sources,
    outputPath: path.resolve(outputPath),
    addCombinedSheet: options.addCombinedSheet === true,
    combinedSheetName: typeof options.combinedSheetName === 'string' ? options.combinedSheetName : '',
    expectedSheetNames: Array.isArray(options.expectedSheetNames) ? options.expectedSheetNames : [],
    expectedSourceSheetCounts: Array.isArray(options.expectedSourceSheetCounts) ? options.expectedSourceSheetCounts : []
  }), 'utf8');

  let cancelWritten = false;
  const requestCancel = async () => {
    if (cancelWritten) return;
    cancelWritten = true;
    await fs.promises.writeFile(cancelPath, 'cancel', { flag: 'wx' }).catch(() => {});
  };
  const cancellationTimer = typeof options.isCancelled === 'function'
    ? setInterval(() => { if (options.isCancelled()) void requestCancel(); }, 100)
    : null;
  cancellationTimer?.unref?.();
  let pending = '';
  const parseProgress = (chunk) => {
    pending += String(chunk || '');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const marker = line.indexOf('CMOE_PROGRESS:');
      if (marker < 0) continue;
      try {
        const event = publicProgress(JSON.parse(line.slice(marker + 'CMOE_PROGRESS:'.length)));
        if (event) options.onProgress?.(event);
      } catch (_) {}
    }
  };

  try {
    if (options.isCancelled?.()) await requestCancel();
    const runner = options.processRunner || runProcess;
    const processResult = await runner(python, [script, '--job', jobPath], {
      cwd: path.dirname(executable),
      timeoutMs: options.timeoutMs,
      cooperativeTimeoutGraceMs: options.cooperativeTimeoutGraceMs,
      onTimeout: requestCancel,
      onStdout: parseProgress
    });
    if (pending) parseProgress('\n');
    let payload = null;
    try { payload = JSON.parse(await fs.promises.readFile(resultPath, 'utf8')); }
    catch (_) {}
    if (!payload || payload.ok !== true || processResult.code !== 0) {
      throw workerFailure(payload?.fatalError || 'LIBREOFFICE_OPERATION_FAILED');
    }
    return payload.result;
  } finally {
    if (cancellationTimer) clearInterval(cancellationTimer);
    await Promise.all([
      fs.promises.unlink(jobPath).catch(() => {}),
      fs.promises.unlink(resultPath).catch(() => {}),
      fs.promises.unlink(cancelPath).catch(() => {}),
      fs.promises.rm(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    ]);
  }
}

function expectedOriginalSheetNames(structures, options = {}) {
  const names = [];
  const used = new Set();
  structures.forEach((structure, sourceIndex) => {
    const sourceFileName = String(options.sourceFileNames?.[sourceIndex] || '');
    const fileNameStem = path.basename(sourceFileName, path.extname(sourceFileName));
    const useFileName = options.useFileNameAsSheetName === true && structure.sheets.length === 1 && fileNameStem;
    structure.sheets.forEach((sheet) => {
      if (sourceIndex === 0 && !useFileName) {
        const name = String(sheet.name || '').slice(0, 31);
        const key = name.toLocaleLowerCase('en-US');
        if (!name || used.has(key)) {
          throw fallbackError('LIBREOFFICE_EXCEL_MERGE_STRUCTURE_UNSUPPORTED', '첫 Excel 파일의 시트 이름을 안전하게 유지할 수 없습니다.');
        }
        used.add(key);
        names.push(name);
      } else {
        names.push(NativeOfficeMerge.safeExcelSheetName(useFileName ? fileNameStem : sheet.name, used, names.length + 1));
      }
    });
  });
  return { names, used };
}

function expectedSheetPlan(structures, options = {}) {
  const original = expectedOriginalSheetNames(structures, options);
  if (options.addCombinedSheet !== true) {
    return { names: original.names, combinedSheetName: '' };
  }
  const combinedSheetName = NativeOfficeMerge.safeExcelSheetName(
    options.combinedSheetName || DEFAULT_COMBINED_SHEET_NAME,
    original.used,
    original.names.length + 1
  );
  return {
    names: [combinedSheetName, ...original.names],
    combinedSheetName
  };
}

function expectedSheetNames(structures, options = {}) {
  return expectedSheetPlan(structures, options).names;
}

function assertFallbackStructure(structure) {
  if (!structure || !Array.isArray(structure.sheets) || !structure.sheets.length) {
    throw fallbackError('LIBREOFFICE_EXCEL_MERGE_STRUCTURE_UNSUPPORTED', 'Excel 시트 구조를 확인하지 못해 호환 병합을 시작하지 않았습니다.');
  }
  if (structure.externalLinksPresent) {
    throw fallbackError('LIBREOFFICE_EXCEL_MERGE_EXTERNAL_LINKS_UNSUPPORTED', '외부 연결이 있는 Excel 파일은 Microsoft Excel 방식으로만 안전하게 합칠 수 있습니다.');
  }
  if (structure.sheets.some((sheet) => sheet.type !== 'worksheet')) {
    throw fallbackError('LIBREOFFICE_EXCEL_MERGE_SHEET_TYPE_UNSUPPORTED', '차트·대화상자·매크로 시트가 있는 파일은 Microsoft Excel 방식으로만 안전하게 합칠 수 있습니다.');
  }
  if (structure.sheets.some((sheet) => !['visible', 'hidden'].includes(sheet.visibility))) {
    throw fallbackError('LIBREOFFICE_EXCEL_MERGE_VISIBILITY_UNSUPPORTED', '매우 숨김 또는 확인할 수 없는 시트 상태가 있는 파일은 Microsoft Excel 방식으로만 안전하게 합칠 수 있습니다.');
  }
}

async function mergeExcelFilesWithLibreOffice(libreOfficePath, inputPaths, outputPath, jobRoot, options = {}) {
  const plan = await NativeOfficeMerge.prepareNativeOfficeMergePlan('excel', inputPaths, outputPath);
  if (plan.sources.some((source) => source.extension !== '.xlsx')) {
    throw fallbackError('LIBREOFFICE_EXCEL_MERGE_INPUT_UNSUPPORTED', 'Excel이 없는 PC의 호환 병합은 XLSX 파일만 지원합니다. XLS·ODS·CSV는 XLSX로 저장한 뒤 다시 선택해주세요.');
  }
  const structures = [];
  for (const source of plan.sources) {
    options.throwIfCancelled?.();
    const structure = await inspectXlsxWorkbookStructure(source.filePath);
    if (structure.sourceBytes !== source.bytes || structure.sourceSha256 !== source.sha256) {
      throw fallbackError('LIBREOFFICE_EXCEL_MERGE_INPUT_CHANGED', 'Excel 원본이 확인 중 바뀌었습니다. 현재 파일을 다시 선택해주세요.');
    }
    assertFallbackStructure(structure);
    structures.push(structure);
  }
  const addCombinedSheet = options.addCombinedSheet === true;
  const useFileNameAsSheetName = options.useFileNameAsSheetName === true;
  const sheetPlan = expectedSheetPlan(structures, {
    addCombinedSheet,
    combinedSheetName: options.combinedSheetName,
    useFileNameAsSheetName,
    sourceFileNames: plan.sources.map((source, index) => path.basename(String(options.sourceFileNames?.[index] || source.filePath)))
  });
  const expectedNames = sheetPlan.names;
  const expectedCounts = structures.map((structure) => structure.sheetCount);
  const result = await runWorker(
    libreOfficePath,
    plan.sources.map((source) => ({ path: source.filePath, bytes: source.bytes, sha256: source.sha256 })),
    plan.outputPath,
    jobRoot,
    {
      ...options,
      addCombinedSheet,
      combinedSheetName: sheetPlan.combinedSheetName,
      expectedSheetNames: expectedNames,
      expectedSourceSheetCounts: expectedCounts
    }
  );
  try {
    options.throwIfCancelled?.();
    const output = await inspectXlsxWorkbookStructure(plan.outputPath);
    const actualNames = output.sheetNames.map(String);
    const combinedRowCount = Number(result?.combinedRowCount);
    const combinedColumnCount = Number(result?.combinedColumnCount);
    const combinedMetadataValid = result?.combinedSheetAdded === addCombinedSheet
      && String(result?.combinedSheetName || '') === sheetPlan.combinedSheetName
      && result?.combinedValueSnapshot === addCombinedSheet
      && String(result?.combinedDataMode || '') === (addCombinedSheet ? 'calculated-values-with-cell-formatting' : '')
      && (addCombinedSheet
        ? Number.isInteger(combinedRowCount) && combinedRowCount >= 1
          && Number.isInteger(combinedColumnCount) && combinedColumnCount >= 1
        : combinedRowCount === 0 && combinedColumnCount === 0);
    const valid = result?.ok === true
      && result?.contentVerified === true
      && Number(result.sourceCount) === plan.sourceCount
      && Array.isArray(result.sourceSheetCounts)
      && result.sourceSheetCounts.length === expectedCounts.length
      && result.sourceSheetCounts.map(Number).every((value, index) => value === expectedCounts[index])
      && combinedMetadataValid
      && Number(result.sheetCount) === expectedNames.length
      && JSON.stringify(result.sheetNames) === JSON.stringify(expectedNames)
      && output.sheetCount === expectedNames.length
      && JSON.stringify(actualNames) === JSON.stringify(expectedNames)
      && output.sheets.every((sheet) => sheet.type === 'worksheet')
      && !output.externalLinksPresent;
    if (!valid) {
      throw fallbackError('LIBREOFFICE_EXCEL_MERGE_RESULT_INVALID', 'Excel 병합 결과의 시트 수·순서·내용 검증이 일치하지 않아 결과를 저장하지 않았습니다.');
    }
    return {
      kind: 'excel',
      outputPath: plan.outputPath,
      outputName: path.basename(plan.outputPath),
      outputBytes: output.sourceBytes,
      sourceCount: plan.sourceCount,
      sourceSheetCounts: expectedCounts,
      sheetCount: output.sheetCount,
      sheetNames: actualNames,
      sheetTypes: output.sheets.map((sheet) => sheet.type),
      sheetVisibility: output.sheets.map((sheet) => sheet.visibility),
      externalLinksPresent: false,
      externalLinkCount: 0,
      baseStrategy: 'libreoffice-physical-first-xlsx',
      compatibilityInputs: plan.compatibilityInputs,
      compatibilityFallback: true,
      contentVerified: true,
      combinedSheetAdded: addCombinedSheet,
      combinedSheetName: sheetPlan.combinedSheetName,
      combinedRowCount,
      combinedColumnCount,
      combinedValueSnapshot: addCombinedSheet,
      combinedDataMode: addCombinedSheet ? 'calculated-values-with-cell-formatting' : '',
      warnings: addCombinedSheet
        ? ['전체 통합 시트는 원본 시트의 계산된 값을 모은 스냅샷입니다. 원본 시트의 수식은 그대로 유지됩니다.']
        : [],
      requiresPreview: true,
      engine: 'libreoffice'
    };
  } catch (error) {
    await fs.promises.unlink(plan.outputPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  fallbackError,
  workerMessage,
  publicProgress,
  runWorker,
  expectedSheetPlan,
  expectedSheetNames,
  assertFallbackStructure,
  mergeExcelFilesWithLibreOffice
};
