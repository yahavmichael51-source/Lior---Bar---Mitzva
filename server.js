// Bar mitzvah RSVP site — tiny dependency-light Node server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, DEFAULT_EVENT } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.createHash('sha256').update('rsvp-session:' + ADMIN_PASSWORD).digest('hex');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATUSES = ['yes', 'no', 'maybe'];
const STATUS_LABELS = { yes: 'מגיע/ה', no: 'לא מגיע/ה', maybe: 'עוד לא יודע/ת' };
const MAX_NAME = 60;
const MAX_SETTING = 200;

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuffer || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeSession() {
  const expires = String(Date.now() + SESSION_TTL_MS);
  return `${expires}.${sign(expires)}`;
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const token = parseCookies(req).admin_session || '';
  const [expires, sig] = token.split('.');
  if (!expires || !sig) return false;
  return safeEqual(sig, sign(expires)) && Number(expires) > Date.now();
}

function isHttps(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, value, maxAgeSec) {
  return [
    `admin_session=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    isHttps(req) ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

// Simple in-memory brute-force protection for the admin login.
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > 15 * 60 * 1000) return false;
  return rec.count >= 10;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > 15 * 60 * 1000) loginAttempts.set(ip, { first: now, count: 1 });
  else rec.count++;
}

// Validates a response payload; returns { value } or { error } (error text is shown to the user).
function validateResponse(body) {
  const firstName = typeof body.firstName === 'string' ? body.firstName.trim().replace(/\s+/g, ' ') : '';
  if (!firstName) return { error: 'נא לכתוב שם פרטי' };
  if (firstName.length > MAX_NAME) return { error: 'השם ארוך מדי' };
  const status = body.status;
  if (!STATUSES.includes(status)) return { error: 'נא לבחור תשובה' };
  let people = 0;
  if (status === 'yes') {
    people = Number(body.people);
    if (![1, 2, 3].includes(people)) return { error: 'נא לבחור כמה אנשים יגיעו' };
  }
  return { value: { firstName, status, people } };
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatIsraelTime(iso) {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

async function getEvent(db) {
  const s = await db.getSettings();
  return {
    childName: s.childName ?? DEFAULT_EVENT.childName,
    eventDate: s.eventDate ?? DEFAULT_EVENT.eventDate,
    eventLocation: s.eventLocation ?? DEFAULT_EVENT.eventLocation,
  };
}

function summarize(responses) {
  const summary = { totalPeople: 0, yes: 0, no: 0, maybe: 0 };
  for (const r of responses) {
    summary[r.status]++;
    if (r.status === 'yes') summary.totalPeople += r.people;
  }
  return summary;
}

// ---------- static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// ---------- routes ----------

async function handleApi(req, res, url, db) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/event' && method === 'GET') return send(res, 200, await getEvent(db));

  if (pathname === '/api/rsvp' && method === 'POST') {
    const { value, error } = validateResponse(await readJson(req));
    if (error) return send(res, 400, { error });
    const saved = await db.addResponse(value);
    return send(res, 201, { ok: true, response: saved });
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (!ADMIN_PASSWORD) return send(res, 503, { error: 'לא הוגדרה סיסמת מנהל בשרת (ADMIN_PASSWORD)' });
    if (tooManyAttempts(ip)) return send(res, 429, { error: 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה.' });
    const { password } = await readJson(req);
    if (typeof password !== 'string' || !safeEqual(password, ADMIN_PASSWORD)) {
      recordFailedLogin(ip);
      return send(res, 401, { error: 'סיסמה שגויה' });
    }
    loginAttempts.delete(ip);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, makeSession(), SESSION_TTL_MS / 1000) });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'נדרשת התחברות' });

    if (pathname === '/api/admin/responses' && method === 'GET') {
      const responses = await db.listResponses();
      return send(res, 200, { summary: summarize(responses), responses, event: await getEvent(db) });
    }

    const m = pathname.match(/^\/api\/admin\/responses\/(\d+)$/);
    if (m && method === 'PUT') {
      const { value, error } = validateResponse(await readJson(req));
      if (error) return send(res, 400, { error });
      const updated = await db.updateResponse(Number(m[1]), value);
      return updated ? send(res, 200, { ok: true, response: updated }) : send(res, 404, { error: 'התשובה לא נמצאה' });
    }
    if (m && method === 'DELETE') {
      return (await db.deleteResponse(Number(m[1])))
        ? send(res, 200, { ok: true })
        : send(res, 404, { error: 'התשובה לא נמצאה' });
    }

    if (pathname === '/api/admin/event' && method === 'PUT') {
      const body = await readJson(req);
      for (const key of ['childName', 'eventDate', 'eventLocation']) {
        if (typeof body[key] !== 'string') continue;
        const v = body[key].trim();
        if (v.length > MAX_SETTING) return send(res, 400, { error: 'הטקסט ארוך מדי' });
        await db.setSetting(key, v);
      }
      return send(res, 200, { ok: true, event: await getEvent(db) });
    }

    if (pathname === '/api/admin/export.csv' && method === 'GET') {
      const filter = url.searchParams.get('status');
      let rows = await db.listResponses();
      if (STATUSES.includes(filter)) rows = rows.filter((r) => r.status === filter);
      const lines = [['שם פרטי', 'תשובה', 'מספר אנשים', 'שעת שליחה'].map(csvCell).join(',')];
      for (const r of rows) {
        lines.push([r.firstName, STATUS_LABELS[r.status], r.people, formatIsraelTime(r.createdAt)].map(csvCell).join(','));
      }
      // BOM so Excel opens Hebrew correctly.
      return send(res, 200, '﻿' + lines.join('\r\n') + '\r\n', {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rsvp-${filter && STATUSES.includes(filter) ? filter : 'all'}.csv"`,
      });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

async function main() {
  const db = await openDatabase();
  if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set — the admin page will refuse all logins.');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') return send(res, 200, 'ok');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, db);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err.status) return send(res, err.status, { error: 'בקשה לא תקינה' });
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'אירעה שגיאה בשרת. נסו שוב.' });
    }
  });

  server.listen(PORT, () => console.log(`RSVP site running on http://localhost:${PORT} (storage: ${db.kind})`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
