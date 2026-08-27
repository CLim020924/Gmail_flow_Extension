async function beforeBuild() {
  // Runtime dependencies are deliberately copied by build.files/extraResources.
  // Returning false prevents electron-builder from trying to rediscover the
  // development-only node_modules tree with a machine-specific package manager.
  return false;
}

module.exports = { beforeBuild };
