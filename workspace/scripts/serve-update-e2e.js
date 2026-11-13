const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '');
const port = Number(process.argv[3] || 18946);
if (!process.argv[2] || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node scripts/serve-update-e2e.js <feed-directory> [port]');
}

function contentType(filePath) {
  if (filePath.endsWith('.yml')) return 'text/yaml; charset=utf-8';
  if (filePath.endsWith('.blockmap')) return 'application/octet-stream';
  if (filePath.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  return 'application/octet-stream';
}

const server = http.createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`).pathname).replace(/^\/+/, '');
  const filePath = path.resolve(root, name || 'latest.yml');
  const relative = path.relative(root, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    response.writeHead(403).end();
    return;
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch { response.writeHead(404).end(); return; }
  if (!stat.isFile()) { response.writeHead(404).end(); return; }

  const range = /^bytes=(\d+)-(\d*)$/i.exec(String(request.headers.range || ''));
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
  if (start < 0 || end < start || start >= stat.size) {
    response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
    return;
  }
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType(filePath),
    'Cache-Control': 'no-store'
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  response.writeHead(range ? 206 : 200, headers);
  fs.createReadStream(filePath, { start, end }).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`CMOE update E2E feed: http://127.0.0.1:${port}/ (${root})\n`);
});

