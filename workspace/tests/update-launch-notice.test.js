const assert = require('node:assert/strict');
const { createUpdateLaunchNotice } = require('../desktop/update-launch-notice');

const updated = createUpdateLaunchNotice(['CMOE Workspace.exe', '--updated']);
assert.deepEqual(updated.consume(), { updated: true, updateFailed: false });
assert.deepEqual(updated.consume(), { updated: false, updateFailed: false });

const failed = createUpdateLaunchNotice(['CMOE Workspace.exe', '--updated', '--update-failed']);
assert.deepEqual(failed.consume(), { updated: false, updateFailed: true });
assert.deepEqual(failed.consume(), { updated: false, updateFailed: false });

const normal = createUpdateLaunchNotice(['CMOE Workspace.exe']);
assert.deepEqual(normal.consume(), { updated: false, updateFailed: false });

console.log('update launch notice tests passed');
