function secureStorageUnavailableError() {
  const error = new Error('운영체제의 보안 저장소를 사용할 수 없어 계정 토큰을 저장하지 않았습니다. 보안 저장소가 복구된 뒤 다시 연결해주세요.');
  error.name = 'SecureStorageUnavailableError';
  error.code = 'SECURE_STORAGE_UNAVAILABLE';
  return error;
}

function createSafeStorageCredentialProtection(safeStorage) {
  const ensureAvailable = () => {
    if (!safeStorage?.isEncryptionAvailable?.()) throw secureStorageUnavailableError();
  };
  const protect = (plainText) => {
    ensureAvailable();
    return {
      protection: 'dpapi',
      data: safeStorage.encryptString(String(plainText)).toString('base64')
    };
  };
  const unprotect = (data, protection = 'dpapi') => {
    if (!['dpapi', 'legacy-dpapi'].includes(String(protection || ''))) {
      const error = new Error('지원하지 않는 자격증명 보호 방식입니다.');
      error.code = 'UNSUPPORTED_CREDENTIAL_PROTECTION';
      throw error;
    }
    ensureAvailable();
    return safeStorage.decryptString(Buffer.from(String(data || ''), 'base64'));
  };
  const protectPrefixed = (plainText) => {
    const sealed = protect(plainText);
    return `${sealed.protection}:${sealed.data}`;
  };
  const unprotectPrefixed = (protectedText) => {
    const value = String(protectedText || '');
    const separator = value.indexOf(':');
    const protection = separator >= 0 ? value.slice(0, separator) : '';
    const data = separator >= 0 ? value.slice(separator + 1) : '';
    if (protection === 'base64') return Buffer.from(data, 'base64').toString('utf8');
    return unprotect(data, protection);
  };
  return { protect, unprotect, protectPrefixed, unprotectPrefixed };
}

module.exports = { secureStorageUnavailableError, createSafeStorageCredentialProtection };
