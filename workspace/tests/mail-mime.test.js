const assert = require('node:assert/strict');
const { mimeDraft, safeMailHtml } = require('../desktop/mail-mime');

const cleaned = safeMailHtml('<table><tr><td style="background:#ff0" onclick="alert(1)">값</td></tr></table><script>alert(2)</script>');
assert.match(cleaned, /<table>/);
assert.doesNotMatch(cleaned, /onclick|script|alert\(2\)/i);

const raw = mimeDraft({ to: 'person@example.com\r\nBcc: attacker@example.com', subject: '표 안내', body: '일반 본문', bodyHtml: cleaned });
const decoded = Buffer.from(raw, 'base64url').toString('utf8');
assert.match(decoded, /Content-Type: multipart\/alternative/);
assert.match(decoded, /Content-Type: text\/html/);
assert.doesNotMatch(decoded, /Bcc:/);
const htmlEncoded = decoded.match(/Content-Type: text\/html;[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([^\r\n]+)/)?.[1];
assert.ok(htmlEncoded);
assert.match(Buffer.from(htmlEncoded, 'base64').toString('utf8'), /background:#ff0/);
console.log('mail-mime tests passed');
