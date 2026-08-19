const assert = require('node:assert/strict');
const { mergeWorkspaceState } = require('../desktop/state-merge');

const current = { updatedAt: '2026-01-01T00:00:06Z', installedExtensions: ['people'], deletedLibraryIds: ['gone'], projects: [{ id: 'a', updatedAt: '2026-01-01T00:00:01Z', name: 'A1' }], quickWorkspaces: { gmailFlow: { id: 'q', updatedAt: '2026-01-01T00:00:03Z', name: 'mail' } }, library: { rosters: [{ id: 'r', savedAt: '2026-01-01T00:00:01Z', name: 'old' }], mailTemplates: [{ id: 'gone', savedAt: '2026-01-01T00:00:01Z' }], layoutTemplates: [], workflowTemplates: [{ id: 'w', updatedAt: '2026-01-01T00:00:01Z', name: 'old workflow' }] } };
const incoming = { projects: [{ id: 'b', updatedAt: '2026-01-01T00:00:02Z', name: 'B' }], quickWorkspaces: { schedule: { id: 's', updatedAt: '2026-01-01T00:00:04Z', name: 'schedule' } }, library: { rosters: [{ id: 'r', savedAt: '2026-01-01T00:00:05Z', name: 'new' }], mailTemplates: [], layoutTemplates: [], workflowTemplates: [{ id: 'w', updatedAt: '2026-01-01T00:00:05Z', name: 'new workflow' }] } };
const merged = mergeWorkspaceState(current, incoming);
assert.deepEqual(merged.projects.map((item) => item.id).sort(), ['a', 'b']);
assert.equal(merged.library.rosters[0].name, 'new');
assert.ok(merged.quickWorkspaces.gmailFlow && merged.quickWorkspaces.schedule);
assert.deepEqual(merged.installedExtensions, ['people']);
assert.equal(merged.library.mailTemplates.length, 0);
assert.equal(merged.library.workflowTemplates[0].name, 'new workflow');
console.log('state-merge tests passed');
