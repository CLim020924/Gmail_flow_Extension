const assert = require('node:assert/strict');
const { fetchAllFormResponses } = require('../desktop/google-forms');

async function run() {
  const requestedUrls = [];
  const pages = [
    { responses: [{ responseId: 'response-1' }], nextPageToken: 'token one' },
    { responses: [{ responseId: 'response-1' }, { responseId: 'response-2' }], nextPageToken: 'token-two' },
    { responses: [{ responseId: 'response-3' }] }
  ];
  const paged = await fetchAllFormResponses(async (url) => {
    requestedUrls.push(url);
    return pages[requestedUrls.length - 1];
  }, 'form/id', { pageSize: 2 });
  assert.equal(paged.pagesFetched, 3);
  assert.deepEqual(paged.responses.map((response) => response.responseId), ['response-1', 'response-2', 'response-3'], 'overlapping pages are deduplicated by response ID');
  assert.match(requestedUrls[0], /forms\/form%2Fid\/responses\?pageSize=2$/);
  assert.match(requestedUrls[1], /pageToken=token\+one/, 'page tokens are URL encoded');
  assert.match(requestedUrls[2], /pageToken=token-two/);

  let repeatedCalls = 0;
  await assert.rejects(
    () => fetchAllFormResponses(async () => {
      repeatedCalls += 1;
      return { responses: [], nextPageToken: 'repeated-token' };
    }, 'repeating-form'),
    /페이지가 반복/,
    'repeated page tokens fail closed instead of looping forever'
  );
  assert.equal(repeatedCalls, 2);

  let oversizedPage = 0;
  await assert.rejects(
    () => fetchAllFormResponses(async () => ({ responses: [], nextPageToken: `page-${oversizedPage += 1}` }), 'large-form', { maxPages: 2 }),
    /2페이지를 초과/,
    'the pagination safety bound is enforced'
  );

  console.log('google-forms tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
