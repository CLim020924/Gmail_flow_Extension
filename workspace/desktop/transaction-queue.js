function createTransactionQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Transaction operation must be a function.'));
    const result = tail.then(() => operation());
    tail = result.catch(() => {});
    return result;
  };
}

function createKeyedTransactionQueue() {
  const queues = new Map();
  return (key, operation) => {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Transaction operation must be a function.'));
    const normalizedKey = String(key || '');
    let queue = queues.get(normalizedKey);
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0 };
      queues.set(normalizedKey, queue);
    }
    queue.pending += 1;
    const result = queue.tail.then(() => operation());
    queue.tail = result.catch(() => {});
    return result.finally(() => {
      queue.pending -= 1;
      if (!queue.pending && queues.get(normalizedKey) === queue) queues.delete(normalizedKey);
    });
  };
}

function createKeyedOperationCoordinator({ staleMessage = '계정 연결 상태가 변경되어 외부 작업을 중단했습니다. 최신 상태에서 다시 시도해주세요.' } = {}) {
  const runKeyed = createKeyedTransactionQueue();
  const generations = new Map();
  const generation = (key) => Number(generations.get(String(key || '')) || 0);
  const staleError = () => {
    const error = new Error(staleMessage);
    error.code = 'CONNECTION_STATE_CHANGED';
    return error;
  };
  const advance = (key) => {
    const normalizedKey = String(key || '');
    const next = generation(normalizedKey) + 1;
    generations.set(normalizedKey, next);
    return next;
  };
  return {
    invalidate(key) {
      return advance(key);
    },
    run(key, operation) {
      const requestedGeneration = generation(key);
      return runKeyed(key, () => {
        if (generation(key) !== requestedGeneration) throw staleError();
        return operation();
      });
    },
    transition(key, operation) {
      const requestedGeneration = advance(key);
      return runKeyed(key, async () => {
        if (generation(key) !== requestedGeneration) throw staleError();
        try { return await operation(); }
        finally {
          // A newer transition or an explicit deletion already owns the next
          // generation. Do not advance over it and make that queued work stale.
          if (generation(key) === requestedGeneration) advance(key);
        }
      });
    }
  };
}

module.exports = { createTransactionQueue, createKeyedTransactionQueue, createKeyedOperationCoordinator };
