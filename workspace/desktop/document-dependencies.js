'use strict';

/**
 * This module deliberately produces data-only plans. It does not inspect the
 * host, download a file, start an installer, write a font, or mutate a
 * manifest. The eventual executor must repeat every validation immediately
 * before it performs an action.
 */

const PLAN_VERSION = 1;

const NATIVE_DEPENDENCY_IDS = Object.freeze([
  'officePowerPoint',
  'officeWord',
  'officeExcel',
  'hancomWriter',
  'hancomCell'
]);

const FALLBACK_DEPENDENCY_IDS = Object.freeze(['libreOffice', 'rhwp']);
const DEPENDENCY_IDS = Object.freeze([...NATIVE_DEPENDENCY_IDS, ...FALLBACK_DEPENDENCY_IDS]);
const PROPRIETARY_DEPENDENCY_IDS = NATIVE_DEPENDENCY_IDS;

const PROPRIETARY_DEPENDENCIES = new Set(PROPRIETARY_DEPENDENCY_IDS);
const SUPPORTED_DEPENDENCIES = new Set(DEPENDENCY_IDS);
const OFFICE_DEPENDENCIES = new Set(['officePowerPoint', 'officeWord', 'officeExcel']);
const HANCOM_DEPENDENCIES = new Set(['hancomWriter', 'hancomCell']);

const LIBREOFFICE_WINGET_ID = 'TheDocumentFoundation.LibreOffice';
const LIBREOFFICE_WINGET_VERSION = '26.8.0.3';
const LIBREOFFICE_INSTALLER_SHA256 = '4aa6c6e1895f4055104effcb556bd3362d20c6ad707c149543304f395ef9db95';
const WINDOWS_KOREAN_FONT_CAPABILITY = 'Language.Fonts.Kore~~~und-Kore~0.0.1.0';
const WINDOWS_USER_FONT_DIRECTORY = '%LOCALAPPDATA%\\Microsoft\\Windows\\Fonts';
const WINDOWS_USER_FONT_REGISTRY_KEY = 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
const RHWP_USER_DIRECTORY = '%LOCALAPPDATA%\\CMOE Workspace\\document-tools\\rhwp';
const HANCOM_AUTOMATION_SECURITY_REGISTRY_KEY = 'Software\\HNC\\HwpAutomation\\Modules';
const HANCOM_AUTOMATION_SECURITY_MODULE_NAME = 'CMOEWorkspaceFilePathChecker';
const HANCOM_AUTOMATION_GUIDE_URL = 'https://developer.hancom.com/hwpautomation';

const DEFAULT_OFFICIAL_INSTALLER_URLS = Object.freeze({
  microsoft: 'https://www.microsoft.com/microsoft-365',
  hancom: 'https://www.hancom.com/'
});

// These are information/download pages owned by the font's vendor or
// publisher. They are deliberately not direct font-file URLs: licensed fonts
// must be obtained under the vendor's own terms, then detected again by the
// app. Only the open-font manifest below may authorize an unattended download.
const OFFICIAL_FONT_SOURCES = Object.freeze({
  microsoftOfficeFonts: Object.freeze({
    vendor: 'microsoft',
    label: 'Microsoft Office 글꼴',
    url: 'https://support.microsoft.com/ko-kr/office/cloud-fonts-in-office-f7b009fe-037f-45ed-a556-b5fe6ede6adb'
  }),
  hancomFonts: Object.freeze({
    vendor: 'hancom',
    label: '한컴 글꼴',
    url: 'https://download.hancom.com/support/downloadCenter/download'
  }),
  kopubFonts: Object.freeze({
    vendor: 'kopub',
    label: 'KoPub 글꼴',
    url: 'https://www.kopus.org/biz-electronic-font2/'
  })
});

const URL_ALLOWLIST = Object.freeze({
  officialInstaller: Object.freeze(['microsoft.com', 'office.com', 'hancom.com']),
  officialFontSource: Object.freeze(['microsoft.com', 'office.com', 'hancom.com', 'kopus.org']),
  pinnedRelease: Object.freeze(['github.com']),
  fontAsset: Object.freeze([
    'github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'fonts.gstatic.com'
  ])
});

const OPEN_FONT_LICENSES = new Set([
  'OFL-1.1',
  'Apache-2.0',
  'Ubuntu-Font-License-1.0'
]);

// Microsoft distributes these legacy Korean families through the Windows
// Korean Supplemental Fonts capability. They must be obtained from Windows
// Update rather than copied or repackaged by CMOE Workspace.
const WINDOWS_KOREAN_FONT_FAMILIES = new Set([
  '바탕', '바탕체', 'batang', 'batangche',
  '돋움', '돋움체', 'dotum', 'dotumche',
  '굴림', '굴림체', 'gulim', 'gulimche',
  '궁서', '궁서체', 'gungsuh', 'gungsuhche'
].map(exactNameKey));

class DocumentDependencyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentDependencyError';
    this.code = code;
  }
}

function dependencyError(code, message) {
  return new DocumentDependencyError(code, message);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw dependencyError('DEPENDENCY_OBJECT_INVALID', `${label} 정보가 올바르지 않습니다.`);
  }
  return value;
}

function validateSha256(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^[a-f0-9]{64}$/i.test(value)) {
    throw dependencyError('SHA256_INVALID', 'SHA-256 값은 공백 없는 64자리 16진수여야 합니다.');
  }
  return value.toLowerCase();
}

function validateWingetId(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/.test(value)) {
    throw dependencyError('WINGET_ID_INVALID', 'winget 패키지 ID가 올바르지 않습니다.');
  }
  return value;
}

function hostnameAllowed(hostname, allowedRoots) {
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return allowedRoots.some((root) => normalized === root || normalized.endsWith(`.${root}`));
}

function validateAllowedUrl(value, purpose = 'officialInstaller') {
  const allowedRoots = URL_ALLOWLIST[purpose];
  if (!allowedRoots) throw dependencyError('URL_PURPOSE_INVALID', 'URL 사용 목적이 올바르지 않습니다.');
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 2_048
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw dependencyError('URL_INVALID', 'URL이 올바르지 않습니다.');
  }

  let parsed;
  try { parsed = new URL(value); }
  catch (_) { throw dependencyError('URL_INVALID', 'URL이 올바르지 않습니다.'); }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) {
    throw dependencyError('URL_NOT_ALLOWED', 'HTTPS 공식 주소만 사용할 수 있습니다.');
  }
  if (!hostnameAllowed(parsed.hostname, allowedRoots)) {
    throw dependencyError('URL_HOST_NOT_ALLOWED', '허용된 공식 배포 주소가 아닙니다.');
  }
  if (/[\\]/.test(value) || /%(?:2e|2f|5c|25)/i.test(value)
    || /(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(value)) {
    throw dependencyError('URL_PATH_INVALID', 'URL 경로가 올바르지 않습니다.');
  }
  if (purpose !== 'officialInstaller' && parsed.search) {
    throw dependencyError('URL_QUERY_NOT_ALLOWED', '검증할 파일 URL에는 변경 가능한 쿼리를 사용할 수 없습니다.');
  }
  if (purpose === 'pinnedRelease'
    && !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(parsed.pathname)) {
    throw dependencyError('PINNED_RELEASE_URL_INVALID', '고정 릴리스의 정확한 GitHub asset 주소가 필요합니다.');
  }
  return parsed.href;
}

function validateSafeName(value, label, maximum = 160) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw dependencyError('DEPENDENCY_NAME_INVALID', `${label} 이름이 올바르지 않습니다.`);
  }
  return value;
}

function validateVersion(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)) {
    throw dependencyError('VERSION_INVALID', '고정 릴리스 버전이 올바르지 않습니다.');
  }
  return value;
}

function validateFileName(value, allowedExtensions, label = '파일') {
  const fileName = validateSafeName(value, label, 200);
  if (fileName === '.' || fileName === '..' || /[\\/:*?"<>|%;&`$]/.test(fileName)
    || /[. ]$/.test(fileName) || !/^[\p{L}\p{N} ._()+\[\]-]+$/u.test(fileName)) {
    throw dependencyError('ASSET_FILE_NAME_INVALID', `${label} 이름에 안전하지 않은 문자가 있습니다.`);
  }
  const lower = fileName.toLowerCase();
  if (!allowedExtensions.some((extension) => lower.endsWith(extension))) {
    throw dependencyError('ASSET_FILE_TYPE_INVALID', `${label} 형식을 사용할 수 없습니다.`);
  }
  return fileName;
}

function assertUrlFileName(url, expectedFileName) {
  const encodedName = new URL(url).pathname.split('/').pop() || '';
  let actualFileName;
  try { actualFileName = decodeURIComponent(encodedName); }
  catch (_) { throw dependencyError('ASSET_URL_FILE_NAME_INVALID', 'asset URL의 파일 이름이 올바르지 않습니다.'); }
  if (actualFileName !== expectedFileName) {
    throw dependencyError('ASSET_URL_FILE_NAME_MISMATCH', 'asset URL과 manifest의 파일 이름이 정확히 일치하지 않습니다.');
  }
}

function exactNameKey(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function fontSourceMatchKey(value) {
  return exactNameKey(value).replace(/[^a-z0-9가-힣]+/gu, '');
}

function officialFontSourceId(family) {
  const key = fontSourceMatchKey(family);
  if (!key) return '';
  if (key.startsWith('kopub')) return 'kopubFonts';
  if (key.startsWith('함초롬') || key.startsWith('한컴') || key.startsWith('hancom')) return 'hancomFonts';
  if (/^(?:aptos(?:display|body|narrow|mono)?|calibri|cambria(?:math)?|candara|consolas|constantia|corbel)(?:(?:thin|extralight|light|regular|medium|semibold|bold|extrabold|black|italic|oblique))*$/.test(key)) {
    return 'microsoftOfficeFonts';
  }
  return '';
}

function officialFontSourceAction(requestedFamily) {
  const family = validateSafeName(requestedFamily, '글꼴 가족', 128);
  const sourceId = officialFontSourceId(family);
  const source = OFFICIAL_FONT_SOURCES[sourceId];
  if (!source) return null;
  const url = validateAllowedUrl(source.url, 'officialFontSource');
  const expectedHosts = source.vendor === 'microsoft'
    ? ['microsoft.com', 'office.com']
    : source.vendor === 'hancom' ? ['hancom.com'] : ['kopus.org'];
  if (!hostnameAllowed(new URL(url).hostname, expectedHosts)) {
    throw dependencyError('FONT_SOURCE_VENDOR_MISMATCH', '글꼴 공급사의 공식 안내 주소가 아닙니다.');
  }
  return {
    id: `font-source:${sourceId}`,
    type: 'officialFontSource',
    sourceId,
    vendor: source.vendor,
    label: source.label,
    url,
    families: [family],
    automatic: false,
    interactive: true,
    requiresUserConsent: true,
    exactAssetOnly: true,
    fontSubstitution: false,
    note: '공급사 공식 글꼴 안내 화면에서 라이선스를 확인해 설치한 뒤 앱이 정확한 글꼴 이름을 다시 감지합니다.'
  };
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const key = value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dependencyAvailable(availability, dependencyId) {
  const value = availability && typeof availability === 'object' ? availability[dependencyId] : null;
  return value === true || Boolean(value && typeof value === 'object' && value.available === true);
}

function installedFontSet(installedFontFamilies) {
  return new Set((Array.isArray(installedFontFamilies) ? installedFontFamilies : [])
    .filter((value) => typeof value === 'string')
    .map(exactNameKey)
    .filter(Boolean));
}

function manifestApplication(manifest, dependencyId) {
  const applications = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest.applications
    : null;
  const entry = applications && typeof applications === 'object' && !Array.isArray(applications)
    ? applications[dependencyId]
    : null;
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
}

function officialInstallerAction(dependencyId, manifest) {
  const entry = manifestApplication(manifest, dependencyId);
  const vendor = OFFICE_DEPENDENCIES.has(dependencyId) ? 'microsoft' : 'hancom';
  const requestedUrl = entry.officialInstallerUrl || DEFAULT_OFFICIAL_INSTALLER_URLS[vendor];
  const url = validateAllowedUrl(requestedUrl, 'officialInstaller');
  const hostname = new URL(url).hostname;
  const vendorHosts = vendor === 'microsoft' ? ['microsoft.com', 'office.com'] : ['hancom.com'];
  if (!hostnameAllowed(hostname, vendorHosts)) {
    throw dependencyError('INSTALLER_VENDOR_MISMATCH', '제품 공급사의 공식 설치 주소가 아닙니다.');
  }
  return {
    id: `app:${dependencyId}:officialInstaller`,
    type: 'officialInstaller',
    dependencyId,
    vendor,
    url,
    automatic: false,
    interactive: true,
    requiresUserConsent: true,
    exactAssetOnly: true,
    note: '공급사의 공식 설치 화면을 열어 사용자가 라이선스와 설치 옵션을 직접 확인해야 합니다.'
  };
}

function officialHancomAutomationGuideAction(applicationArchitecture = 'unknown') {
  const architectureDetail = applicationArchitecture === 'x64'
    ? '현재 한컴 한글은 64비트로 감지되었고 공식 예제 모듈은 32비트이므로 자동 등록하지 않습니다.'
    : '한컴 오토메이션 사용 승인과 정확한 보안 모듈 등록이 필요하여 임의 DLL을 자동으로 받지 않습니다.';
  return {
    id: 'app:hancomWriter:automationGuide',
    type: 'officialHancomAutomationGuide',
    dependencyId: 'hancomWriter',
    vendor: 'hancom',
    url: validateAllowedUrl(HANCOM_AUTOMATION_GUIDE_URL, 'officialInstaller'),
    automatic: false,
    interactive: true,
    requiresUserConsent: true,
    exactAssetOnly: true,
    note: `${architectureDetail} 개인의 비상업적 이용 외에는 한컴의 별도 승인·라이선스가 필요합니다.`
  };
}

function hancomAutomationSecurityAction(platform, applicationArchitecture) {
  if (platform !== 'win32') {
    throw dependencyError('PLATFORM_UNSUPPORTED', '한컴 오토메이션 보안 모듈 자동 준비는 Windows만 지원합니다.');
  }
  return officialHancomAutomationGuideAction(applicationArchitecture);
}

function libreOfficeAction(manifest, platform) {
  if (platform !== 'win32') {
    throw dependencyError('PLATFORM_UNSUPPORTED', '현재 자동 준비 계획은 Windows만 지원합니다.');
  }
  const entry = manifestApplication(manifest, 'libreOffice');
  const packageId = validateWingetId(entry.wingetId || LIBREOFFICE_WINGET_ID);
  if (packageId !== LIBREOFFICE_WINGET_ID) {
    throw dependencyError('WINGET_PACKAGE_NOT_APPROVED', '승인된 LibreOffice winget 패키지 ID가 아닙니다.');
  }
  const version = validateVersion(entry.wingetVersion || '');
  const installerSha256 = validateSha256(entry.installerSha256);
  if (version !== LIBREOFFICE_WINGET_VERSION || installerSha256 !== LIBREOFFICE_INSTALLER_SHA256) {
    throw dependencyError('WINGET_RELEASE_NOT_APPROVED', '승인된 LibreOffice 버전과 WinGet installer SHA-256 정보가 아닙니다.');
  }
  return {
    id: 'app:libreOffice:winget',
    type: 'wingetInstall',
    dependencyId: 'libreOffice',
    packageId,
    version,
    installerSha256,
    source: 'winget',
    exact: true,
    automatic: true,
    interactive: false,
    requiresUserConsent: true,
    command: 'winget',
    arguments: [
      'install', '--id', packageId, '--exact', '--version', version, '--source', 'winget', '--silent',
      '--accept-package-agreements', '--accept-source-agreements'
    ],
    note: '사용자 동의 뒤 고정 패키지 ID·버전으로 설치하며 WinGet catalog의 installer SHA-256을 코드에 기록해 검증된 릴리스만 허용합니다.'
  };
}

function rhwpPinnedReleaseAction(manifest, platform, architecture) {
  if (platform !== 'win32') {
    throw dependencyError('PLATFORM_UNSUPPORTED', '현재 rHWP 자동 준비 계획은 Windows만 지원합니다.');
  }
  const release = manifestApplication(manifest, 'rhwp').pinnedRelease;
  if (!release) {
    throw dependencyError('RHWP_PINNED_RELEASE_REQUIRED', 'rHWP는 검증된 pinnedRelease가 없으면 자동으로 준비할 수 없습니다.');
  }
  assertPlainObject(release, 'rHWP pinnedRelease');
  const version = validateVersion(release.version);
  const releasePlatform = validateSafeName(release.platform || 'win32', '플랫폼', 32);
  const releaseArchitecture = validateSafeName(release.architecture || 'x64', '아키텍처', 32);
  if (releasePlatform !== platform || releaseArchitecture !== architecture) {
    throw dependencyError('RHWP_RELEASE_TARGET_MISMATCH', '현재 Windows 아키텍처에 맞는 rHWP 고정 릴리스가 아닙니다.');
  }
  const fileName = validateFileName(release.fileName, ['.zip'], 'rHWP 릴리스 파일');
  const url = validateAllowedUrl(release.url, 'pinnedRelease');
  assertUrlFileName(url, fileName);
  const sha256 = validateSha256(release.sha256);
  const executableSha256 = validateSha256(release.executableSha256);
  return {
    id: 'app:rhwp:pinnedRelease',
    type: 'stagePinnedReleasePerUser',
    dependencyId: 'rhwp',
    automatic: true,
    interactive: false,
    requiresUserConsent: true,
    version,
    platform: releasePlatform,
    architecture: releaseArchitecture,
    asset: { url, sha256, fileName, executableSha256 },
    destination: `${RHWP_USER_DIRECTORY}\\${version}`,
    verifyBeforeExtract: true,
    exactAssetOnly: true,
    note: 'SHA-256이 일치한 ZIP만 사용자 영역에 준비하며 시스템 전역 설치로 처리하지 않습니다.'
  };
}

function fontManifestEntries(manifest) {
  const fonts = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest.fonts : null;
  if (Array.isArray(fonts)) return fonts;
  if (fonts && typeof fonts === 'object') return Object.values(fonts);
  return [];
}

function registryFontFormat(fileName) {
  if (fileName.toLowerCase().endsWith('.otf')) return 'OpenType';
  if (fileName.toLowerCase().endsWith('.ttc')) return 'TrueType Collection';
  return 'TrueType';
}

function planPerUserFontInstall(requestedFamily, manifestEntry) {
  const family = validateSafeName(requestedFamily, '글꼴 가족', 128);
  const entry = assertPlainObject(manifestEntry, '글꼴 manifest');
  const manifestFamily = validateSafeName(entry.family, 'manifest 글꼴 가족', 128);
  if (exactNameKey(family) !== exactNameKey(manifestFamily)) {
    throw dependencyError('FONT_EXACT_MATCH_REQUIRED', '요청한 글꼴과 manifest 글꼴 가족이 정확히 일치하지 않습니다.');
  }
  if (entry.verified !== true) {
    throw dependencyError('FONT_MANIFEST_NOT_VERIFIED', '검증된 manifest 글꼴만 자동으로 준비할 수 있습니다.');
  }
  const license = validateSafeName(entry.license, '글꼴 라이선스', 80);
  if (!OPEN_FONT_LICENSES.has(license)) {
    throw dependencyError('FONT_LICENSE_NOT_APPROVED', '자동 설치가 승인된 공개 글꼴 라이선스가 아닙니다.');
  }
  const version = validateVersion(entry.version);
  const copyright = validateSafeName(entry.copyright || family, '글꼴 저작권', 240);
  const licenseSource = assertPlainObject(entry.licenseAsset, '글꼴 라이선스 파일');
  const licenseFileName = validateFileName(licenseSource.fileName, ['.txt'], '글꼴 라이선스 파일');
  const licenseUrl = validateAllowedUrl(licenseSource.url, 'fontAsset');
  assertUrlFileName(licenseUrl, licenseFileName);
  const licenseAsset = {
    url: licenseUrl,
    sha256: validateSha256(licenseSource.sha256),
    fileName: licenseFileName
  };
  if (!Array.isArray(entry.files) || !entry.files.length || entry.files.length > 32) {
    throw dependencyError('FONT_FILES_INVALID', '글꼴 manifest에는 1개 이상 32개 이하의 정확한 파일이 필요합니다.');
  }

  const files = entry.files.map((source, index) => {
    assertPlainObject(source, `${family} 글꼴 파일`);
    const fileName = validateFileName(source.fileName, ['.ttf', '.otf', '.ttc'], '글꼴 파일');
    const style = validateSafeName(source.style || 'Regular', '글꼴 스타일', 80);
    const url = validateAllowedUrl(source.url, 'fontAsset');
    assertUrlFileName(url, fileName);
    const sha256 = validateSha256(source.sha256);
    const format = registryFontFormat(fileName);
    const faceName = style.toLocaleLowerCase('en-US') === 'regular' ? family : `${family} ${style}`;
    return {
      index,
      style,
      format,
      asset: { url, sha256, fileName },
      destination: `${WINDOWS_USER_FONT_DIRECTORY}\\${fileName}`,
      registry: {
        hive: 'HKCU',
        key: WINDOWS_USER_FONT_REGISTRY_KEY,
        valueName: `${faceName} (${format})`,
        valueData: `${WINDOWS_USER_FONT_DIRECTORY}\\${fileName}`
      }
    };
  });

  const duplicateNames = new Set();
  for (const file of files) {
    const key = file.asset.fileName.toLocaleLowerCase('en-US');
    if (duplicateNames.has(key)) throw dependencyError('FONT_FILE_DUPLICATE', '글꼴 manifest에 같은 파일 이름이 중복되어 있습니다.');
    duplicateNames.add(key);
  }

  return {
    id: `font:${exactNameKey(family).replace(/[^a-z0-9가-힣]+/gu, '-') || 'font'}:perUser`,
    type: 'installOpenFontPerUser',
    family: manifestFamily,
    version,
    license,
    copyright,
    licenseAsset,
    automatic: true,
    interactive: false,
    requiresUserConsent: true,
    scope: 'user',
    exactAssetOnly: true,
    fontSubstitution: false,
    files,
    note: '각 파일의 SHA-256을 확인한 뒤 HKCU와 사용자 글꼴 폴더에만 설치합니다.'
  };
}

function planWindowsKoreanFontsInstall(requestedFamily, platform = 'win32') {
  const family = validateSafeName(requestedFamily, '글꼴 가족', 128);
  if (platform !== 'win32') {
    throw dependencyError('PLATFORM_UNSUPPORTED', 'Windows 한국어 추가 글꼴은 Windows에서만 준비할 수 있습니다.');
  }
  if (!WINDOWS_KOREAN_FONT_FAMILIES.has(exactNameKey(family))) {
    throw dependencyError('WINDOWS_FONT_CAPABILITY_MISMATCH', 'Windows 한국어 추가 글꼴에 포함된 글꼴이 아닙니다.');
  }
  return {
    id: 'font:windows-korean-supplemental',
    type: 'installWindowsCapability',
    dependencyId: 'windowsKoreanFonts',
    capabilityName: WINDOWS_KOREAN_FONT_CAPABILITY,
    families: [family],
    automatic: true,
    interactive: true,
    requiresAdministrator: true,
    requiresUserConsent: true,
    exactAssetOnly: true,
    fontSubstitution: false,
    note: 'Windows Update의 한국어 추가 글꼴 기능을 UAC 동의 후 설치합니다.'
  };
}

function actionPreparation(action) {
  if (action.type === 'officialInstaller') return 'openOfficialInstaller';
  if (action.type === 'officialHancomAutomationGuide') return 'openOfficialInstaller';
  if (action.type === 'officialFontSource') return 'openOfficialFontSource';
  return action.automatic ? 'autoInstall' : 'unavailable';
}

function unavailableRecord(kind, id, error) {
  return {
    kind,
    id,
    available: false,
    blocked: true,
    preparation: 'unavailable',
    reasonCode: String(error?.code || 'DEPENDENCY_UNAVAILABLE'),
    reason: String(error?.message || '자동 준비 계획을 만들 수 없습니다.')
  };
}

function plannedRecord(kind, id, action) {
  return {
    kind,
    id,
    available: false,
    blocked: true,
    preparation: actionPreparation(action),
    actionId: action.id
  };
}

function readyRecord(kind, id) {
  return { kind, id, available: true, blocked: false, preparation: null };
}

function planApplication(dependencyId, request, manifest) {
  if (!SUPPORTED_DEPENDENCIES.has(dependencyId)) {
    throw dependencyError('DEPENDENCY_UNSUPPORTED', `지원하지 않는 문서 의존성입니다: ${dependencyId}`);
  }
  if (dependencyId === 'hancomWriter' && request.availability?.registered === true
    && request.availability?.available !== true
    && (String(request.availability?.reasonCode || '').startsWith('HANCOM_SECURITY_MODULE_')
      || request.availability?.reasonCode === 'HANCOM_APPLICATION_ARCHITECTURE_UNKNOWN')) {
    return hancomAutomationSecurityAction(request.platform, request.availability.applicationArchitecture);
  }
  if (PROPRIETARY_DEPENDENCIES.has(dependencyId)) return officialInstallerAction(dependencyId, manifest);
  if (dependencyId === 'libreOffice') return libreOfficeAction(manifest, request.platform);
  if (dependencyId === 'rhwp') return rhwpPinnedReleaseAction(manifest, request.platform, request.architecture);
  throw dependencyError('DEPENDENCY_UNSUPPORTED', `지원하지 않는 문서 의존성입니다: ${dependencyId}`);
}

function planDocumentDependencies(request = {}, manifest = {}) {
  const input = assertPlainObject(request, '문서 의존성 요청');
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw dependencyError('DEPENDENCY_MANIFEST_INVALID', '문서 의존성 manifest가 올바르지 않습니다.');
  }
  const platform = validateSafeName(input.platform || 'win32', '플랫폼', 32);
  const architecture = validateSafeName(input.architecture || 'x64', '아키텍처', 32);
  const requiredApplications = uniqueStrings(input.requiredApplications);
  const requiredFonts = uniqueStrings(input.requiredFonts);
  const installedFonts = installedFontSet(input.installedFontFamilies);

  const applications = [];
  const fonts = [];
  const actions = [];
  const unresolved = [];
  const addAction = (action) => {
    const existing = actions.find((candidate) => candidate.id === action.id);
    if (existing?.type === 'installWindowsCapability' && action.type === 'installWindowsCapability') {
      existing.families = uniqueStrings([...(existing.families || []), ...(action.families || [])]);
      return existing;
    }
    if (existing?.type === 'officialFontSource' && action.type === 'officialFontSource') {
      existing.families = uniqueStrings([...(existing.families || []), ...(action.families || [])]);
      return existing;
    }
    if (existing) return existing;
    actions.push(action);
    return action;
  };

  for (const dependencyId of requiredApplications) {
    if (dependencyAvailable(input.availability, dependencyId)) {
      applications.push(readyRecord('application', dependencyId));
      continue;
    }
    try {
      const dependencyAvailability = input.availability && typeof input.availability === 'object'
        && input.availability[dependencyId] && typeof input.availability[dependencyId] === 'object'
        ? input.availability[dependencyId]
        : {};
      const action = planApplication(dependencyId, { platform, architecture, availability: dependencyAvailability }, manifest);
      addAction(action);
      applications.push(plannedRecord('application', dependencyId, action));
    } catch (error) {
      const record = unavailableRecord('application', dependencyId, error);
      applications.push(record); unresolved.push(record);
    }
  }

  const entries = fontManifestEntries(manifest);
  for (const requestedFamily of requiredFonts) {
    let family;
    try { family = validateSafeName(requestedFamily, '글꼴 가족', 128); }
    catch (error) {
      const record = unavailableRecord('font', String(requestedFamily || ''), error);
      fonts.push(record); unresolved.push(record); continue;
    }
    if (installedFonts.has(exactNameKey(family))) {
      fonts.push(readyRecord('font', family));
      continue;
    }
    if (platform !== 'win32') {
      const error = dependencyError('PLATFORM_UNSUPPORTED', '현재 사용자별 글꼴 준비 계획은 Windows만 지원합니다.');
      const record = unavailableRecord('font', family, error);
      fonts.push(record); unresolved.push(record); continue;
    }
    const matches = entries.filter((entry) => entry && typeof entry === 'object'
      && exactNameKey(entry.family) === exactNameKey(family));
    if (matches.length !== 1) {
      if (WINDOWS_KOREAN_FONT_FAMILIES.has(exactNameKey(family))) {
        try {
          const action = addAction(planWindowsKoreanFontsInstall(family, platform));
          fonts.push(plannedRecord('font', family, action));
        } catch (error) {
          const record = unavailableRecord('font', family, error);
          fonts.push(record); unresolved.push(record);
        }
        continue;
      }
      try {
        const officialAction = officialFontSourceAction(family);
        if (officialAction) {
          const action = addAction(officialAction);
          fonts.push(plannedRecord('font', family, action));
          continue;
        }
      } catch (error) {
        const record = unavailableRecord('font', family, error);
        fonts.push(record); unresolved.push(record); continue;
      }
      const error = dependencyError(
        matches.length ? 'FONT_MANIFEST_AMBIGUOUS' : 'FONT_EXACT_ASSET_NOT_FOUND',
        matches.length ? '같은 글꼴 가족의 manifest 항목이 중복되어 있습니다.' : '요청한 글꼴의 정확한 검증 asset을 찾을 수 없습니다.'
      );
      const record = unavailableRecord('font', family, error);
      fonts.push(record); unresolved.push(record); continue;
    }
    try {
      const action = planPerUserFontInstall(family, matches[0]);
      addAction(action);
      fonts.push(plannedRecord('font', family, action));
    } catch (error) {
      const record = unavailableRecord('font', family, error);
      fonts.push(record); unresolved.push(record);
    }
  }

  const requirements = [...applications, ...fonts];
  return {
    version: PLAN_VERSION,
    platform,
    architecture,
    policy: {
      exactAssetOnly: true,
      fontSubstitution: false,
      proprietaryUnattendedInstall: false,
      executionIncluded: false
    },
    applications,
    fonts,
    actions,
    unresolved,
    ready: requirements.filter((item) => item.available).map((item) => ({ kind: item.kind, id: item.id })),
    hasAutomaticActions: actions.some((action) => action.automatic),
    requiresUserConsent: actions.length > 0,
    requiresUserAction: actions.some((action) => !action.automatic),
    canAutoPrepare: unresolved.length === 0
      && requirements.every((item) => item.available || item.preparation === 'autoInstall')
  };
}

module.exports = {
  PLAN_VERSION,
  DEPENDENCY_IDS,
  NATIVE_DEPENDENCY_IDS,
  FALLBACK_DEPENDENCY_IDS,
  PROPRIETARY_DEPENDENCY_IDS,
  LIBREOFFICE_WINGET_ID,
  LIBREOFFICE_WINGET_VERSION,
  LIBREOFFICE_INSTALLER_SHA256,
  WINDOWS_KOREAN_FONT_CAPABILITY,
  WINDOWS_KOREAN_FONT_FAMILIES: Object.freeze([...WINDOWS_KOREAN_FONT_FAMILIES]),
  WINDOWS_USER_FONT_DIRECTORY,
  WINDOWS_USER_FONT_REGISTRY_KEY,
  RHWP_USER_DIRECTORY,
  HANCOM_AUTOMATION_SECURITY_REGISTRY_KEY,
  HANCOM_AUTOMATION_SECURITY_MODULE_NAME,
  HANCOM_AUTOMATION_GUIDE_URL,
  URL_ALLOWLIST,
  OFFICIAL_FONT_SOURCES,
  OPEN_FONT_LICENSES: Object.freeze([...OPEN_FONT_LICENSES]),
  DocumentDependencyError,
  validateSha256,
  validateWingetId,
  validateAllowedUrl,
  assertUrlFileName,
  officialFontSourceId,
  officialFontSourceAction,
  planPerUserFontInstall,
  planWindowsKoreanFontsInstall,
  planDocumentDependencies,
  createDocumentDependencyPlan: planDocumentDependencies,
  createPreparationPlan: planDocumentDependencies
};
