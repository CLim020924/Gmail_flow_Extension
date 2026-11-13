function createUpdateLaunchNotice(argv = []) {
  let pending = Array.isArray(argv) && argv.includes('--update-failed')
    ? 'failed'
    : Array.isArray(argv) && argv.includes('--updated') ? 'updated' : '';

  return {
    consume() {
      const result = {
        updated: pending === 'updated',
        updateFailed: pending === 'failed'
      };
      pending = '';
      return result;
    }
  };
}

module.exports = { createUpdateLaunchNotice };
