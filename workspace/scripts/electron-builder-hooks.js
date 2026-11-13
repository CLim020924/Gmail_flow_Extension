async function beforeBuild() {
  // Keep electron-builder's normal production dependency collection enabled.
  // The explicit build.files allowlist below limits the application sources,
  // while electron-builder resolves the updater's production dependency tree.
}

module.exports = { beforeBuild };
