const assert = require('node:assert/strict');
const { createTransactionQueue, createKeyedTransactionQueue, createKeyedOperationCoordinator } = require('../desktop/transaction-queue');

(async () => {
  const runTransaction = createTransactionQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = runTransaction(async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
    return 1;
  });
  const second = runTransaction(async () => {
    order.push('second');
    return 2;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start'], 'a later transaction must wait for the active transaction');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);

  await assert.rejects(runTransaction(async () => { throw new Error('expected'); }), /expected/);
  assert.equal(await runTransaction(async () => 3), 3, 'the queue must recover after a failed transaction');

  const runKeyed = createKeyedTransactionQueue();
  const keyedOrder = [];
  let releaseKeyed;
  const keyedGate = new Promise((resolve) => { releaseKeyed = resolve; });
  const keyedFirst = runKeyed('gmail-1', async () => { keyedOrder.push('gmail-start'); await keyedGate; keyedOrder.push('gmail-end'); });
  const keyedSecond = runKeyed('gmail-1', async () => { keyedOrder.push('gmail-next'); });
  const otherConnection = runKeyed('gmail-2', async () => { keyedOrder.push('other-connection'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(keyedOrder, ['gmail-start', 'other-connection'], 'different connections may run while the same connection remains serialized');
  releaseKeyed();
  await Promise.all([keyedFirst, keyedSecond, otherConnection]);
  assert.deepEqual(keyedOrder, ['gmail-start', 'other-connection', 'gmail-end', 'gmail-next']);

  const coordinator = createKeyedOperationCoordinator();
  let releaseAuthorization;
  const authorizationGate = new Promise((resolve) => { releaseAuthorization = resolve; });
  const authorization = coordinator.transition('gmail-1', async () => { await authorizationGate; return 'connected'; });
  let staleApiRan = false;
  const staleApi = coordinator.run('gmail-1', async () => { staleApiRan = true; });
  releaseAuthorization();
  assert.equal(await authorization, 'connected');
  await assert.rejects(staleApi, (error) => error.code === 'CONNECTION_STATE_CHANGED');
  assert.equal(staleApiRan, false, 'an API request queued during account authorization must not run with replacement credentials');
  assert.equal(await coordinator.run('gmail-1', async () => 'latest-account'), 'latest-account', 'new API work may run after the account transition finishes');
  console.log('transaction-queue tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
