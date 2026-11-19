const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../core');

const all = Core.createReviewApprovalSet(4, true);
assert.deepEqual([...all], [0, 1, 2, 3]);
assert.deepEqual(Core.reviewApprovalState(4, all), { approvedCount: 4, all: true, partial: false });

all.delete(2);
assert.deepEqual(Core.reviewApprovalState(4, all), { approvedCount: 3, all: false, partial: true });
assert.deepEqual(Core.reviewApprovalState(4, Core.createReviewApprovalSet(4, false)), { approvedCount: 0, all: false, partial: false });
assert.deepEqual(Core.reviewApprovalState(0, new Set()), { approvedCount: 0, all: false, partial: false });

const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
assert.match(html, /id="sendReviewApproveAll"/);
assert.match(html, /모든 대상의 받는 사람·제목·본문을 한 번에 체크/);
assert.match(script, /sendReviewApproveAll/);
assert.match(script, /createReviewApprovalSet/);

console.log('send review bulk approval tests passed');
