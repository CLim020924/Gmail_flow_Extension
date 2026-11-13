const os = require('node:os');
const path = require('node:path');
const base = require('../package.json').build;

module.exports = {
  ...base,
  appId: 'kr.co.cmoe.workspace.update-test',
  productName: 'CMOE Workspace Update Test',
  extraMetadata: {
    ...(base.extraMetadata || {}),
    name: 'cmoe-workspace-update-test'
  },
  directories: {
    ...base.directories,
    output: process.env.CMOE_UPDATE_E2E_OUTPUT || path.join(os.tmpdir(), 'cmoe-update-e2e-build')
  },
  publish: [{ provider: 'generic', url: 'http://127.0.0.1:18946/', useMultipleRangeRequest: false }],
  nsis: {
    ...base.nsis,
    artifactName: 'CMOE-Workspace-Update-Test-Setup-${version}-Windows.${ext}',
    shortcutName: 'CMOE Workspace Update Test'
  }
};

