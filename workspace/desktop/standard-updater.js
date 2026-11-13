function updateFileSize(updateInfo) {
  const size = Number(updateInfo?.files?.find((file) => Number.isFinite(Number(file?.size)))?.size || 0);
  return Number.isSafeInteger(size) && size > 0 ? size : 0;
}

function releaseNotes(updateInfo) {
  const notes = updateInfo?.releaseNotes;
  if (Array.isArray(notes)) return notes.map((item) => String(item?.note || item || '').trim()).filter(Boolean).slice(0, 12);
  return String(notes || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

function publicCheckResult(currentVersion, result) {
  const info = result?.updateInfo || {};
  return {
    currentVersion,
    available: Boolean(result?.isUpdateAvailable),
    feed: {
      version: String(info.version || currentVersion),
      bytes: updateFileSize(info),
      notes: releaseNotes(info)
    }
  };
}

class StandardUpdater {
  constructor({ autoUpdater, currentVersion, packaged, portable, broadcast = () => {}, logger = console, createCancellationToken = null }) {
    this.autoUpdater = autoUpdater;
    this.currentVersion = String(currentVersion || '0.0.0');
    this.packaged = Boolean(packaged);
    this.portable = Boolean(portable);
    this.broadcast = broadcast;
    this.logger = logger;
    this.createCancellationToken = createCancellationToken;
    this.checked = null;
    this.checkResult = null;
    this.checkPromise = null;
    this.downloadPromise = null;
    this.cancellationToken = null;
    this.downloaded = false;
    this.installHandedOff = false;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = logger;
    autoUpdater.on('download-progress', (progress) => {
      const received = Number(progress?.transferred || 0);
      const total = Number(progress?.total || 0);
      this.broadcast({
        stage: 'downloading',
        message: '표준 업데이터가 새 버전을 다운로드하고 있습니다.',
        received,
        total,
        percent: Math.max(0, Math.min(100, Number(progress?.percent || (total ? received / total * 100 : 0))))
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.downloaded = true;
      this.broadcast({ stage: 'verified', message: '다운로드와 검증이 완료되었습니다.', received: updateFileSize(info), total: updateFileSize(info), percent: 100 });
    });
    autoUpdater.on('update-cancelled', () => {
      this.downloaded = false;
      this.broadcast({ stage: 'canceled', message: '업데이트 다운로드를 취소했습니다.', percent: 0 });
    });
    autoUpdater.on('error', (error) => {
      logger.error?.('표준 업데이트 오류', error);
      if (this.downloadPromise) this.broadcast({ stage: 'error', message: error?.message || '업데이트를 완료하지 못했습니다.', percent: 0 });
    });
  }

  status() {
    return { currentVersion: this.currentVersion, packaged: this.packaged, portable: this.portable, checked: this.checked };
  }

  async check() {
    if (!this.packaged) throw new Error('개발 실행에서는 배포 업데이트를 확인하지 않습니다.');
    if (this.portable) throw new Error('휴대형은 자동 업데이트를 지원하지 않습니다.');
    if (this.checkPromise) return this.checkPromise;
    this.broadcast({ stage: 'checking', message: '표준 업데이트 정보를 확인하고 있습니다.', percent: 0 });
    this.checkPromise = this.autoUpdater.checkForUpdates().then((result) => {
      this.checkResult = result;
      this.checked = publicCheckResult(this.currentVersion, result);
      return { ...this.checked, packaged: this.packaged, portable: this.portable };
    }).finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async download() {
    if (!this.checkResult?.isUpdateAvailable) throw new Error('먼저 새 버전 확인을 완료해주세요.');
    if (this.downloadPromise) return this.downloadPromise;
    this.downloaded = false;
    this.cancellationToken = this.checkResult.cancellationToken || this.createCancellationToken?.();
    if (!this.cancellationToken) throw new Error('업데이트 다운로드 취소 토큰을 만들 수 없습니다.');
    const version = this.checked.feed.version;
    this.broadcast({ stage: 'connecting', message: `CMOE Workspace ${version} 다운로드를 준비하고 있습니다.`, received: 0, total: this.checked.feed.bytes, percent: 0 });
    this.downloadPromise = this.autoUpdater.downloadUpdate(this.cancellationToken).then(() => {
      this.downloaded = true;
      return { ready: true, version };
    }).finally(() => {
      this.downloadPromise = null;
      this.cancellationToken = null;
    });
    return this.downloadPromise;
  }

  cancel() {
    if (!this.cancellationToken || !this.downloadPromise) return { canceled: false };
    this.cancellationToken.cancel();
    return { canceled: true };
  }

  install() {
    if (!this.downloaded || this.installHandedOff) throw new Error('검증된 업데이트 설치 파일이 준비되지 않았습니다.');
    this.installHandedOff = true;
    this.autoUpdater.quitAndInstall(false, true);
  }
}

module.exports = { StandardUpdater, publicCheckResult, updateFileSize, releaseNotes };
