const DEFAULT_API_TIMEOUT_MS = 60_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;
const DEFAULT_DRIVE_TIMEOUT_MS = 120_000;

function networkTimeoutError(timeoutMs, cause) {
  const error = new Error(`네트워크 응답이 ${Math.ceil(timeoutMs / 1000)}초 안에 오지 않았습니다. 연결을 확인한 뒤 다시 시도해주세요.`);
  error.name = 'NetworkTimeoutError';
  error.code = 'NETWORK_TIMEOUT';
  error.timeoutMs = timeoutMs;
  if (cause) error.cause = cause;
  return error;
}

function operationTimeoutError(timeoutMs, message = '작업 완료를 기다리는 시간이 초과되었습니다.', code = 'OPERATION_TIMEOUT') {
  const error = new Error(message);
  error.name = 'OperationTimeoutError';
  error.code = code;
  error.timeoutMs = timeoutMs;
  return error;
}

function createAbortDeadline(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener?.('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(networkTimeoutError(timeoutMs));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    clear() {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.('abort', onCallerAbort);
    }
  };
}

async function runWithNetworkTimeout(operation, { signal, timeoutMs = DEFAULT_API_TIMEOUT_MS } = {}) {
  const deadline = createAbortDeadline(signal, timeoutMs);
  try {
    return await operation(deadline.signal);
  } catch (error) {
    if (deadline.didTimeOut() && !signal?.aborted) {
      if (error?.code === 'NETWORK_TIMEOUT') throw error;
      throw networkTimeoutError(timeoutMs, error);
    }
    throw error;
  } finally {
    deadline.clear();
  }
}

async function fetchAndReadWithTimeout(input, init = {}, { timeoutMs = DEFAULT_API_TIMEOUT_MS, read, fetchImpl } = {}) {
  const { signal: callerSignal, ...requestInit } = init || {};
  const request = fetchImpl || ((...args) => globalThis.fetch(...args));
  return runWithNetworkTimeout(async (signal) => {
    const response = await request(input, { ...requestInit, signal });
    const body = typeof read === 'function' ? await read(response) : undefined;
    return { response, body };
  }, { signal: callerSignal, timeoutMs });
}

function withOperationTimeout(operation, timeoutMs, message, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(operationTimeoutError(timeoutMs, message, code)), timeoutMs);
  });
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_TOKEN_TIMEOUT_MS,
  DEFAULT_DRIVE_TIMEOUT_MS,
  networkTimeoutError,
  runWithNetworkTimeout,
  fetchAndReadWithTimeout,
  withOperationTimeout
};
