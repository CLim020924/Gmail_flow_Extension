const path = require('node:path');

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function safeShortcutLabel(rawLabel, fallback = 'CMOE 프로그램') {
  const normalized = String(rawLabel || '').normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  let label = normalized === '.' || normalized === '..' ? '' : normalized;
  if (!label) label = String(fallback || 'CMOE 프로그램').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim() || 'CMOE 프로그램';
  if (WINDOWS_RESERVED_NAME.test(label)) label = `_${label}`;
  return Array.from(label).slice(0, 80).join('').replace(/[. ]+$/g, '') || 'CMOE 프로그램';
}

function shortcutPathInside(directory, rawLabel, suffix = '') {
  const parent = path.resolve(String(directory || ''));
  const label = safeShortcutLabel(rawLabel);
  const safeSuffix = String(suffix || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0, 24);
  const target = path.resolve(parent, `${label}${safeSuffix}.lnk`);
  if (path.dirname(target).toLowerCase() !== parent.toLowerCase()) {
    const error = new Error('바로가기 파일 경로가 허용된 폴더를 벗어났습니다.');
    error.code = 'SHORTCUT_PATH_OUTSIDE_PARENT';
    throw error;
  }
  return target;
}

module.exports = { safeShortcutLabel, shortcutPathInside };
