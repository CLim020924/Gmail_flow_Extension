const assert = require('node:assert/strict');
const { collectOwnedWindows, UpdateShutdownGate } = require('../desktop/update-shutdown-policy');

const main = { id: 'main', isDestroyed: () => false };
const gmail = { id: 'gmail', isDestroyed: () => false };
const documentEditor = { id: 'document', isDestroyed: () => false };
const futureProgramWindow = { id: 'future', isDestroyed: () => false };
const destroyed = { id: 'destroyed', isDestroyed: () => true };
assert.deepEqual(
  collectOwnedWindows({ getAllWindows: () => [main, gmail, documentEditor, futureProgramWindow, destroyed] }).map(({ id }) => id),
  ['main', 'gmail', 'document', 'future']
);

const gate = new UpdateShutdownGate();
gate.assertOpenAllowed();
gate.begin();
assert.throws(() => gate.assertOpenAllowed(), (error) => error.code === 'UPDATE_SHUTDOWN_IN_PROGRESS');
gate.reset();
gate.assertOpenAllowed();

console.log('update shutdown policy tests passed');
