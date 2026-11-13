const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(workspaceRoot, 'package.json'));
const vendorLock = require(path.join(workspaceRoot, 'vendor', 'package-lock.json'));
const excelJsRoot = path.join(workspaceRoot, 'vendor', 'node_modules', 'exceljs');
const excelJsPackagePath = path.join(excelJsRoot, 'package.json');

function fail(message) {
  console.error(`CMOE Workspace build preflight failed: ${message}`);
  process.exitCode = 1;
}

try {
  assert.equal(fs.existsSync(excelJsPackagePath), true, 'ExcelJS runtime is missing. Run npm ci in workspace first.');

  const installedExcelJs = require(excelJsPackagePath);
  const lockedExcelJs = vendorLock.packages?.['node_modules/exceljs'];
  assert.ok(lockedExcelJs?.version, 'workspace/vendor/package-lock.json does not lock ExcelJS.');
  assert.equal(installedExcelJs.version, lockedExcelJs.version, 'Installed ExcelJS does not match the vendor lockfile. Run npm ci again.');

  const ExcelJS = require(excelJsRoot);
  assert.equal(typeof ExcelJS.Workbook, 'function', 'ExcelJS cannot be loaded with its runtime dependencies.');
  assert.ok(new ExcelJS.Workbook(), 'ExcelJS Workbook initialization failed.');

  const resources = Array.isArray(packageJson.build?.extraResources) ? packageJson.build.extraResources : [];
  assert.equal(packageJson.build?.beforeBuild, 'scripts/electron-builder-hooks.js', 'electron-builder must use the self-contained runtime hook.');
  assert.equal(typeof require(path.join(workspaceRoot, packageJson.build.beforeBuild)).beforeBuild, 'function', 'electron-builder beforeBuild hook is invalid.');
  assert.ok((packageJson.build?.files || []).includes('desktop/**/*'), 'electron-builder must package all desktop runtime modules.');
  const runtimePackages = [
    'electron-log', 'electron-updater', 'builder-util-runtime', 'debug', 'ms', 'sax',
    'fs-extra', 'graceful-fs', 'jsonfile', 'universalify', 'js-yaml', 'argparse',
    'lazy-val', 'lodash.escaperegexp', 'lodash.isequal', 'semver', 'tiny-typed-emitter'
  ];
  const updaterRuntimeFiles = resources.find((entry) => entry?.from === 'node_modules' && entry?.to === 'updater-runtime/node_modules');
  assert.ok(updaterRuntimeFiles, 'Installer updater runtime resource set is missing.');
  runtimePackages.forEach((name) => {
    assert.ok((updaterRuntimeFiles.filter || []).includes(`${name}/**/*`), `Installer runtime allowlist is missing ${name}.`);
    require.resolve(`${name}/package.json`, { paths: [workspaceRoot] });
  });
  [
    'certificate-roster-core.js',
    'document-tools-ui.js',
    'external-progress.js',
    'guide-core.js',
    'desktop/document-tools.js',
    'desktop/google-forms.js',
    'desktop/google-oauth-release-config.js',
    'desktop/login-browser.js',
    'desktop/drive-sync-guard.js',
    'desktop/external-commit.js',
    'desktop/transaction-queue.js',
    'desktop/update-data-backup.js',
    'desktop/standard-updater.js',
    'extensions/document-editor/manifest.json',
    'extensions/project-calendar/manifest.json',
    'build/installer.nsh'
  ].forEach((relativePath) => {
    assert.equal(fs.existsSync(path.join(workspaceRoot, relativePath)), true, `Critical desktop runtime is missing: ${relativePath}`);
  });
  const vendorResource = resources.find((entry) => entry?.from === 'vendor/node_modules' && entry?.to === 'vendor/node_modules');
  assert.ok(vendorResource, 'electron-builder extraResources must copy vendor/node_modules.');
  ['office-tools', 'browser-tools'].forEach((resourceName) => {
    assert.ok(resources.some((entry) => entry?.from === resourceName && entry?.to === resourceName), `electron-builder must package ${resourceName}.`);
  });

  const gmailFlowResource = resources.find((entry) => entry?.to === 'gmail-flow');
  assert.ok(gmailFlowResource, 'Gmail Flow runtime resources are missing from electron-builder configuration.');
  assert.ok((gmailFlowResource.filter || []).includes('online-scheduler-client.js'), 'The online scheduler client must be bundled with Gmail Flow.');
  assert.equal(
    (gmailFlowResource.filter || []).includes('desktop/oauth-credentials.local.js'),
    false,
    'Local OAuth credentials must not be embedded in release installers.'
  );
  assert.equal(packageJson.build?.appId, 'kr.co.cmoe.workspace', 'CMOE Workspace appId must remain stable for updates.');
  assert.equal(packageJson.build?.productName, 'CMOE Workspace', 'CMOE Workspace product name changed unexpectedly.');
  assert.equal(packageJson.build?.nsis?.include, 'build/installer.nsh', 'Installer maintenance UI must be included.');
  assert.equal(packageJson.build?.nsis?.oneClick, true, 'Standard updater requires the one-click NSIS progress flow.');
  assert.equal(packageJson.build?.nsis?.deleteAppDataOnUninstall, false, 'Uninstall must preserve user data.');
  assert.equal(packageJson.build?.nsis?.allowToChangeInstallationDirectory, false, 'The installed app must keep one stable per-user installation path.');
  assert.deepEqual(packageJson.build?.win?.target, ['nsis'], 'CMOE Workspace must be distributed as an installer only.');
  assert.equal(Object.hasOwn(packageJson.build || {}, 'portable'), false, 'Portable distribution configuration must remain disabled.');
  assert.equal(Object.hasOwn(packageJson.scripts || {}, 'build:windows'), false, 'Portable build scripts must remain disabled.');

  const generatedGoogleConfigPath = path.join(workspaceRoot, 'desktop', 'google-oauth-client.generated.json');
  const { readGeneratedReleaseCredentials } = require(path.join(workspaceRoot, 'desktop', 'google-oauth-release-config.js'));
  const googleCredentials = readGeneratedReleaseCredentials(generatedGoogleConfigPath);
  assert.ok(googleCredentials?.clientId && googleCredentials?.clientSecret, 'The local generated Google OAuth release configuration is missing or invalid.');

  console.log(`CMOE Workspace ${packageJson.version} build preflight passed (ExcelJS ${installedExcelJs.version}).`);
} catch (error) {
  fail(error.message);
}
