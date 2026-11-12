async function handleStartupFailure({ error, isSmokeTest, writeSmokeResult, dialog, shell, app, userDataPath, logError = console.error }) {
  logError('Workspace 시작 실패:', error);
  if (isSmokeTest) {
    writeSmokeResult?.('failed', { step: 'startup', error: error?.stack || error?.message || String(error) });
    app.exit(1);
    return { action: 'smoke-failed' };
  }
  let response = 1;
  try {
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'Workspace 데이터를 안전하게 열지 못했습니다',
      message: '저장 파일 또는 안전 백업을 읽지 못해 앱을 시작하지 않았습니다.',
      detail: `기존 파일은 덮어쓰지 않고 그대로 보존했습니다. 저장 폴더의 파일을 별도로 복사한 뒤 복구를 진행해주세요.\n\n${error?.message || String(error)}`,
      buttons: ['저장 폴더 열고 종료', '종료'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    response = result.response;
    if (response === 0) await shell.openPath(userDataPath);
  } catch (dialogError) {
    logError('Workspace 시작 실패 안내를 표시하지 못했습니다:', dialogError);
  } finally {
    app.exit(1);
  }
  return { action: response === 0 ? 'opened-folder' : 'exit' };
}

module.exports = { handleStartupFailure };
