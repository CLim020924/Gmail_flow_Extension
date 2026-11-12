async function fetchAllFormResponses(requestPage, formId, { pageSize = 500, maxPages = 100 } = {}) {
  if (typeof requestPage !== 'function') throw new TypeError('requestPage must be a function');
  const encodedFormId = encodeURIComponent(String(formId || '').trim());
  if (!encodedFormId) throw new Error('Google Form ID가 필요합니다.');
  const safePageSize = Math.max(1, Math.min(5000, Number(pageSize) || 500));
  const safeMaxPages = Math.max(1, Math.min(1000, Number(maxPages) || 100));
  const responses = [];
  const responseIds = new Set();
  const seenPageTokens = new Set();
  let pageToken = '';
  let pagesFetched = 0;

  while (pagesFetched < safeMaxPages) {
    const params = new URLSearchParams({ pageSize: String(safePageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await requestPage(`https://forms.googleapis.com/v1/forms/${encodedFormId}/responses?${params.toString()}`);
    pagesFetched += 1;
    (Array.isArray(page?.responses) ? page.responses : []).forEach((response) => {
      const responseId = String(response?.responseId || '').trim();
      if (responseId && responseIds.has(responseId)) return;
      if (responseId) responseIds.add(responseId);
      responses.push(response);
    });
    const nextPageToken = String(page?.nextPageToken || '').trim();
    if (!nextPageToken) return { responses, pagesFetched };
    if (seenPageTokens.has(nextPageToken)) throw new Error('Google Forms 응답 페이지가 반복되어 동기화를 중단했습니다.');
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new Error(`Google Forms 응답이 ${safeMaxPages}페이지를 초과해 동기화를 중단했습니다.`);
}

function assertGoogleFormStableDuringResponseFetch(formBefore, formAfter) {
  const beforeFormId = String(formBefore?.formId || '').trim();
  const afterFormId = String(formAfter?.formId || '').trim();
  const beforeRevisionId = String(formBefore?.revisionId || '').trim();
  const afterRevisionId = String(formAfter?.revisionId || '').trim();
  const revisionUnavailable = !beforeRevisionId || !afterRevisionId;
  if (revisionUnavailable
    || (beforeFormId && afterFormId && beforeFormId !== afterFormId)
    || beforeRevisionId !== afterRevisionId) {
    const error = new Error(revisionUnavailable
      ? 'Google 설문의 변경 기준을 확인할 수 없어 응답 동기화를 중단했습니다. 잠시 뒤 다시 시도해주세요.'
      : 'Google 설문이 응답을 가져오는 동안 변경되어 동기화를 중단했습니다. 최신 설문을 확인한 뒤 다시 시도해주세요.');
    error.code = revisionUnavailable ? 'GOOGLE_FORM_REVISION_UNAVAILABLE' : 'GOOGLE_FORM_CHANGED_DURING_RESPONSE_FETCH';
    error.details = { beforeFormId, afterFormId, beforeRevisionId, afterRevisionId };
    throw error;
  }
  return formAfter;
}

module.exports = { assertGoogleFormStableDuringResponseFetch, fetchAllFormResponses };
