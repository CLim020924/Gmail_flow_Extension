const crypto = require('node:crypto');

function safeMailHtml(value) {
  return String(value || '')
    .replace(/<(script|iframe|object|embed|form|input|button|link|meta)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|form|input|button|link|meta)\b[^>]*\/?\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function mimeDraft({ to, subject, body, bodyHtml }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(String(subject || ''), 'utf8').toString('base64')}?=`;
  const boundary = `cmoe-${crypto.randomBytes(16).toString('hex')}`;
  const html = safeMailHtml(bodyHtml || String(body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'));
  const mime = [
    `To: ${String(to || '').split(/[\r\n]/, 1)[0].trim()}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '', `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '',
    Buffer.from(String(body || ''), 'utf8').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '',
    Buffer.from(`<div>${html}</div>`, 'utf8').toString('base64'),
    `--${boundary}--`
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

module.exports = { safeMailHtml, mimeDraft };
