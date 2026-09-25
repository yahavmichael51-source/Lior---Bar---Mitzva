// Platform-independent API handler, shared by the Node server (server.js) and the
// Netlify Function (netlify/functions/api.mjs). It takes a plain request description
// and returns { status, headers, body } so each platform only adapts I/O.
const crypto = require('node:crypto');

const DEFAULT_EVENT = { childName: 'ליאור', eventDate: '', eventLocation: '' };
const STATUSES = ['yes', 'no', 'maybe'];
const STATUS_LABELS = { yes: 'מגיע/ה', no: 'לא מגיע/ה', maybe: 'עוד לא יודע/ת' };
const MAX_NAME = 60;
const MAX_PEOPLE = 30; // total party size, including the guest
const MAX_SETTING = 200;
const MAX_BODY = 10_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, body, headers = {}) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

function parseBody(text) {
  if (!text) return {};
  if (text.length > MAX_BODY) throw new HttpError(413, 'בקשה גדולה מדי');
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new HttpError(400, 'בקשה לא תקינה');
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const cleanName = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

// Validates a response payload; returns { value } or { error } (error text is shown to the user).
// Guests must give a last name; the admin may leave it empty (older responses have none).
function validateResponse(body, { requireLastName = true } = {}) {
  const firstName = cleanName(body.firstName);
  if (!firstName) return { error: 'נא לכתוב שם פרטי' };
  if (firstName.length > MAX_NAME) return { error: 'השם ארוך מדי' };
  const lastName = cleanName(body.lastName);
  if (!lastName && requireLastName) return { error: 'נא לכתוב שם משפחה' };
  if (lastName.length > MAX_NAME) return { error: 'שם המשפחה ארוך מדי' };
  const status = body.status;
  if (!STATUSES.includes(status)) return { error: 'נא לבחור תשובה' };
  let people = 0;
  if (status === 'yes') {
    people = Number(body.people);
    if (!Number.isInteger(people) || people < 1) return { error: 'נא לבחור כמה אנשים יגיעו' };
    if (people > MAX_PEOPLE) return { error: `אפשר לרשום עד ${MAX_PEOPLE} אנשים בתשובה אחת` };
  }
  return { value: { firstName, lastName, status, people } };
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

// Guests get a random token when they answer, kept only on their phone; we store its hash
// so the guest (and only they) can later change the answer.
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Same person = same first + last name, ignoring case and extra spaces.
function nameKey(r) {
  return (cleanName(r.firstName) + '|' + cleanName(r.lastName)).toLowerCase();
}

// For the organizer: everything except the token hash.
function publicResponse(r) {
  const { editTokenHash, ...rest } = r;
  return { lastName: '', history: [], ...rest };
}

// For guests: their answer only (no change history).
function guestResponse(r) {
  const { history, ...rest } = publicResponse(r);
  return rest;
}

// Before an answer changes, keep what it was so the organizer can see the earlier answer.
function withHistory(existing, value, changedBy) {
  const history = Array.isArray(existing.history) ? existing.history : [];
  const same =
    existing.status === value.status &&
    Number(existing.people) === value.people &&
    existing.firstName === value.firstName &&
    (existing.lastName || '') === value.lastName;
  if (same) return history;
  return history.concat({
    firstName: existing.firstName,
    lastName: existing.lastName || '',
    status: existing.status,
    people: Number(existing.people),
    answeredAt: existing.updatedAt || existing.createdAt,
    changedAt: new Date().toISOString(),
    changedBy,
  });
}

function describeAnswer(r) {
  return r.status === 'yes' ? `${STATUS_LABELS.yes} (${r.people})` : STATUS_LABELS[r.status];
}

function summarize(responses) {
  const summary = { totalPeople: 0, yes: 0, no: 0, maybe: 0, responses: responses.length, companions: 0, bySize: {} };
  for (const r of responses) {
    summary[r.status]++;
    if (r.status === 'yes') {
      summary.totalPeople += r.people;
      summary.bySize[r.people] = (summary.bySize[r.people] || 0) + 1;
    }
  }
  summary.companions = summary.totalPeople - summary.yes;
  summary.changed = responses.filter((r) => r.history && r.history.length).length;
  return summary;
}

function createApi(db, { adminUsername = '', adminPassword = '', sessionSecret } = {}) {
  const secret =
    sessionSecret ||
    crypto.createHash('sha256').update(`rsvp-session:${adminUsername}:${adminPassword}`).digest('hex');
  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

  function isAdmin(cookieHeader) {
    if (!adminUsername || !adminPassword) return false;
    const [expires, sig] = (parseCookies(cookieHeader).admin_session || '').split('.');
    if (!expires || !sig) return false;
    return safeEqual(sig, sign(expires)) && Number(expires) > Date.now();
  }

  function sessionCookie(value, maxAgeSec, secure) {
    return [`admin_session=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, secure ? 'Secure' : '']
      .filter(Boolean)
      .join('; ');
  }

  // Simple brute-force protection for the admin login (per server instance).
  const loginAttempts = new Map();
  const WINDOW = 15 * 60 * 1000;
  function tooManyAttempts(ip) {
    const rec = loginAttempts.get(ip);
    return !!rec && Date.now() - rec.first <= WINDOW && rec.count >= 10;
  }
  function recordFailedLogin(ip) {
    const rec = loginAttempts.get(ip);
    if (!rec || Date.now() - rec.first > WINDOW) loginAttempts.set(ip, { first: Date.now(), count: 1 });
    else rec.count++;
  }

  async function getEvent() {
    const s = await db.getSettings();
    return {
      childName: s.childName ?? DEFAULT_EVENT.childName,
      eventDate: s.eventDate ?? DEFAULT_EVENT.eventDate,
      eventLocation: s.eventLocation ?? DEFAULT_EVENT.eventLocation,
    };
  }

  async function route({ method, pathname, searchParams, headers, body, ip, secure }) {
    if (pathname === '/api/event' && method === 'GET') return json(200, await getEvent());

    if (pathname === '/api/rsvp' && method === 'POST') {
      const input = parseBody(body);
      const { value, error } = validateResponse(input);
      if (error) return json(400, { error });
      const editToken = crypto.randomBytes(24).toString('base64url');
      const key = nameKey(value);

      // The guest confirmed "that's me": update their earlier answer instead of adding a new one.
      // This phone gets a fresh edit token, so it can change the answer again later.
      if (input.replaceId !== undefined) {
        const existing = await db.getResponse(String(input.replaceId));
        if (!existing || nameKey(existing) !== key) return json(404, { error: 'התשובה הקודמת לא נמצאה' });
        const updated = await db.updateResponse(existing.id, value, {
          editTokenHash: hashToken(editToken),
          history: withHistory(existing, value, 'guest'),
        });
        return updated
          ? json(200, { ok: true, replaced: true, response: guestResponse(updated), editToken })
          : json(404, { error: 'התשובה הקודמת לא נמצאה' });
      }

      // Same first + last name already answered (e.g. from another phone): ask before adding a second answer.
      if (input.confirmNew !== true) {
        const match = (await db.listResponses()).find((r) => r.lastName && nameKey(r) === key);
        if (match) return json(409, { match: guestResponse(match) });
      }

      const saved = await db.addResponse({ ...value, editTokenHash: hashToken(editToken) });
      return json(201, { ok: true, response: guestResponse(saved), editToken });
    }

    // A guest viewing or changing their own answer, proven by the token from when they answered.
    const own = pathname.match(/^\/api\/rsvp\/([A-Za-z0-9_-]{1,64})$/);
    if (own && (method === 'GET' || method === 'PUT')) {
      const existing = await db.getResponse(own[1]);
      const token = headers.editToken || '';
      if (!existing || !existing.editTokenHash || !token || !safeEqual(hashToken(token), existing.editTokenHash)) {
        return json(404, { error: 'התשובה לא נמצאה' });
      }
      if (method === 'GET') return json(200, { response: guestResponse(existing) });
      const { value, error } = validateResponse(parseBody(body));
      if (error) return json(400, { error });
      const updated = await db.updateResponse(own[1], value, { history: withHistory(existing, value, 'guest') });
      return updated ? json(200, { ok: true, response: guestResponse(updated) }) : json(404, { error: 'התשובה לא נמצאה' });
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      if (!adminUsername || !adminPassword) {
        return json(503, { error: 'לא הוגדרו שם משתמש וסיסמה בשרת (ADMIN_USERNAME ו־ADMIN_PASSWORD)' });
      }
      if (tooManyAttempts(ip)) return json(429, { error: 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה.' });
      const { username, password } = parseBody(body);
      // Evaluate both comparisons so timing doesn't reveal which one was wrong.
      const userOk = typeof username === 'string' && safeEqual(username.trim(), adminUsername);
      const passOk = typeof password === 'string' && safeEqual(password, adminPassword);
      if (!(userOk && passOk)) {
        recordFailedLogin(ip);
        return json(401, { error: 'שם משתמש או סיסמה שגויים' });
      }
      loginAttempts.delete(ip);
      const expires = String(Date.now() + SESSION_TTL_MS);
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(`${expires}.${sign(expires)}`, SESSION_TTL_MS / 1000, secure) });
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, secure) });
    }

    if (!pathname.startsWith('/api/admin/')) return json(404, { error: 'Not found' });
    if (!isAdmin(headers.cookie)) return json(401, { error: 'נדרשת התחברות' });

    if (pathname === '/api/admin/responses' && method === 'GET') {
      const responses = (await db.listResponses()).map(publicResponse);
      return json(200, { summary: summarize(responses), responses, event: await getEvent() });
    }

    const m = pathname.match(/^\/api\/admin\/responses\/([A-Za-z0-9_-]{1,64})$/);
    if (m && method === 'PUT') {
      const { value, error } = validateResponse(parseBody(body), { requireLastName: false });
      if (error) return json(400, { error });
      const existing = await db.getResponse(m[1]);
      if (!existing) return json(404, { error: 'התשובה לא נמצאה' });
      const updated = await db.updateResponse(m[1], value, { history: withHistory(existing, value, 'admin') });
      return updated ? json(200, { ok: true, response: publicResponse(updated) }) : json(404, { error: 'התשובה לא נמצאה' });
    }
    if (m && method === 'DELETE') {
      return (await db.deleteResponse(m[1])) ? json(200, { ok: true }) : json(404, { error: 'התשובה לא נמצאה' });
    }

    if (pathname === '/api/admin/event' && method === 'PUT') {
      const input = parseBody(body);
      const updates = {};
      for (const key of ['childName', 'eventDate', 'eventLocation']) {
        if (typeof input[key] !== 'string') continue;
        const v = input[key].trim();
        if (v.length > MAX_SETTING) return json(400, { error: 'הטקסט ארוך מדי' });
        updates[key] = v;
      }
      await db.setSettings(updates);
      return json(200, { ok: true, event: await getEvent() });
    }

    if (pathname === '/api/admin/export.csv' && method === 'GET') {
      const filter = searchParams.get('status');
      const valid = STATUSES.includes(filter) || filter === 'changed';
      let rows = (await db.listResponses()).map(publicResponse);
      if (filter === 'changed') rows = rows.filter((r) => r.history.length > 0);
      else if (valid) rows = rows.filter((r) => r.status === filter);
      const lines = [
        ['שם פרטי', 'שם משפחה', 'תשובה', 'מספר אנשים', 'שעת שליחה', 'עודכן לאחרונה', 'תשובות קודמות'].map(csvCell).join(','),
      ];
      for (const r of rows) {
        lines.push(
          [
            r.firstName,
            r.lastName,
            STATUS_LABELS[r.status],
            r.people,
            formatIsraelTime(r.createdAt),
            r.updatedAt ? formatIsraelTime(r.updatedAt) : '',
            r.history.map((h) => `${describeAnswer(h)} עד ${formatIsraelTime(h.changedAt)}`).join(' ← '),
          ]
            .map(csvCell)
            .join(',')
        );
      }
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="rsvp-${valid ? filter : 'all'}.csv"`,
        },
        // BOM so Excel opens Hebrew correctly.
        body: '﻿' + lines.join('\r\n') + '\r\n',
      };
    }

    return json(404, { error: 'Not found' });
  }

  return async function handle(req) {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'אירעה שגיאה בשרת. נסו שוב.' });
    }
  };
}

// Sort helper shared by storage adapters: newest first.
function byNewest(a, b) {
  return b.createdAt.localeCompare(a.createdAt) || String(b.id).localeCompare(String(a.id));
}

module.exports = { createApi, validateResponse, summarize, byNewest, DEFAULT_EVENT, MAX_BODY, MAX_PEOPLE };
