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
  ['desktop/drive-sync-guard.js', 'desktop/external-commit.js', 'desktop/transaction-queue.js'].forEach((relativePath) => {
    assert.equal(fs.existsSync(path.join(workspaceRoot, relativePath)), true, `Critical desktop runtime is missing: ${relativePath}`);
  });
  const vendorResource = resources.find((entry) => entry?.from === 'vendor/node_modules' && entry?.to === 'vendor/node_modules');
  assert.ok(vendorResource, 'electron-builder extraResources must copy vendor/node_modules.');

  const gmailFlowResource = resources.find((entry) => entry?.to === 'gmail-flow');
  assert.ok(gmailFlowResource, 'Gmail Flow runtime resources are missing from electron-builder configuration.');
  assert.equal(
    (gmailFlowResource.filter || []).includes('desktop/oauth-credentials.local.js'),
    false,
    'Local OAuth credentials must not be embedded in release installers.'
  );

  console.log(`CMOE Workspace ${packageJson.version} build preflight passed (ExcelJS ${installedExcelJs.version}).`);
} catch (error) {
  fail(error.message);
}
