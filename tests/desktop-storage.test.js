const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStorage } = require('../desktop/storage');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-flow-storage-'));
  const filePath = path.join(directory, 'data.json');
  const storage = new JsonStorage(filePath);
  const originalWriteFileSync = fs.writeFileSync;
  let failOnce = true;
  fs.writeFileSync = (...args) => {
    if (failOnce) { failOnce = false; throw new Error('simulated disk write failure'); }
    return originalWriteFileSync(...args);
  };
  try {
    await assert.rejects(storage.set({ first: true }), /simulated disk write failure/);
    await storage.set({ second: true });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  const reloaded = new JsonStorage(filePath);
  assert.deepEqual(await reloaded.get({ first: false, second: false }), { first: true, second: true }, 'a transient write failure must not permanently poison later desktop storage writes');
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('desktop storage tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
