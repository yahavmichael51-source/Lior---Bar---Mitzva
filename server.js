// Bar mitzvah RSVP site — Node server for running locally or on any Node host.
// (On Netlify the same API runs as netlify/functions/api.mjs.)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApi, MAX_BODY } = require('./lib/api');
const { openDatabase } = require('./lib/db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(Buffer.concat(chunks).toString('utf8') + ' '.repeat(MAX_BODY)); // makes the API reply 413
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    });
    res.end(data);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

async function main() {
  const db = await openDatabase();
  const admins = [
    { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD },
    { username: process.env.ADMIN_USERNAME_2, password: process.env.ADMIN_PASSWORD_2 },
  ];
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.warn('WARNING: ADMIN_USERNAME / ADMIN_PASSWORD are not set — the admin page will refuse all logins.');
  }
  const handle = createApi(db, { admins, sessionSecret: process.env.SESSION_SECRET });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      if (url.pathname.startsWith('/api/')) {
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        const out = await handle({
          method: req.method,
          pathname: url.pathname,
          searchParams: url.searchParams,
          headers: { cookie: req.headers.cookie || '', editToken: req.headers['x-edit-token'] || '' },
          body: hasBody ? await readBody(req) : '',
          ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
          secure: !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https',
        });
        res.writeHead(out.status, out.headers);
        return res.end(out.body);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      serveStatic(res, url.pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  server.listen(PORT, () => console.log(`RSVP site running on http://localhost:${PORT} (storage: ${db.kind})`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
