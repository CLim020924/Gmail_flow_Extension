function collectOwnedWindows(BrowserWindow) {
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') throw new Error('CMOE 창 목록을 확인할 수 없습니다.');
  return BrowserWindow.getAllWindows().filter((window) => window && !window.isDestroyed());
}

class UpdateShutdownGate {
  constructor() { this.active = false; }

  begin() { this.active = true; }
  reset() { this.active = false; }

  assertOpenAllowed() {
    if (!this.active) return;
    const error = new Error('업데이트 설치를 준비하고 있어 새 창이나 작업을 시작할 수 없습니다.');
    error.code = 'UPDATE_SHUTDOWN_IN_PROGRESS';
    throw error;
  }
}

module.exports = { collectOwnedWindows, UpdateShutdownGate };
