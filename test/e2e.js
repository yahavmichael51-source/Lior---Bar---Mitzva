// End-to-end check: starts the server on a fresh SQLite DB, submits RSVPs through the real
// guest page in a browser, then verifies the admin report (after a reload), editing, deleting and CSV.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const PORT = 3456;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'test-password-123';

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function submitRsvp(page, name, statusLabel, peopleLabel) {
  await page.goto(BASE + '/');
  await page.fill('#firstName', name);
  await page.getByRole('radio', { name: statusLabel, exact: true }).check();
  const peopleVisible = await page.isVisible('#peopleField');
  assert.equal(peopleVisible, statusLabel === 'מגיע/ה', `people question visibility for ${statusLabel}`);
  if (peopleLabel) await page.getByRole('radio', { name: peopleLabel, exact: true }).check();
  await page.click('#submitBtn');
  await page.waitForSelector('#thanksCard:not([hidden])');
  assert.match(await page.textContent('#thanksText'), /נשמרה/);
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-test-'));
  const entry = process.env.TEST_TARGET === 'netlify' ? 'test/netlify-sim.mjs' : 'server.js';
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, DATABASE_URL: process.env.TEST_DATABASE_URL || '' },
    stdio: 'inherit',
  });
  const browser = await chromium.launch();
  try {
    await waitForServer();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    // Validation: name is required, and "coming" requires a head count.
    await page.goto(BASE + '/');
    await page.getByRole('radio', { name: 'מגיע/ה', exact: true }).check();
    await page.click('#submitBtn');
    assert.equal(await page.textContent('#error'), 'נא לכתוב שם פרטי');
    await page.fill('#firstName', 'בדיקה');
    await page.click('#submitBtn');
    assert.equal(await page.textContent('#error'), 'נא לבחור כמה אנשים יגיעו');

    // Server rejects invalid payloads too.
    let r = await fetch(BASE + '/api/rsvp', { method: 'POST', body: JSON.stringify({ firstName: 'x', status: 'yes', people: 7 }) });
    assert.equal(r.status, 400);

    await submitRsvp(page, 'דנה', 'מגיע/ה', 'רק אני');       // 1
    await submitRsvp(page, 'יוסי', 'מגיע/ה', 'אני + 1');     // 2
    await submitRsvp(page, 'רחל', 'מגיע/ה', 'אני + 2');      // 3
    await submitRsvp(page, 'משה', 'לא מגיע/ה');
    await submitRsvp(page, 'יוסי', 'עוד לא יודע/ת');         // same name: must stay a separate row

    // Admin data is protected.
    r = await fetch(BASE + '/api/admin/responses');
    assert.equal(r.status, 401);
    r = await fetch(BASE + '/api/admin/export.csv');
    assert.equal(r.status, 401);
    const adminHtml = await (await fetch(BASE + '/admin')).text();
    const adminJs = await (await fetch(BASE + '/admin.js')).text();
    assert.ok(!adminHtml.includes(PASSWORD) && !adminJs.includes(PASSWORD), 'password must not reach the browser');

    // Wrong password.
    await page.goto(BASE + '/admin');
    await page.fill('#password', 'wrong');
    await page.click('#loginForm button');
    await page.waitForFunction(() => document.getElementById('loginError').textContent === 'סיסמה שגויה');

    // Login, then reload to prove persistence + session cookie.
    await page.fill('#password', PASSWORD);
    await page.click('#loginForm button');
    await page.waitForSelector('#dashView:not([hidden])');
    await page.reload();
    await page.waitForSelector('#dashView:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 5);

    const stats = async () => ({
      total: await page.textContent('#sTotal'),
      yes: await page.textContent('#sYes'),
      no: await page.textContent('#sNo'),
      maybe: await page.textContent('#sMaybe'),
    });
    assert.deepEqual(await stats(), { total: '6', yes: '3', no: '1', maybe: '1' });

    // Filter.
    await page.selectOption('#filter', 'yes');
    assert.equal(await page.locator('#rows tr').count(), 3);
    await page.selectOption('#filter', 'maybe');
    assert.equal(await page.locator('#rows tr').count(), 1);
    assert.equal(await page.getAttribute('#csvLink', 'href'), '/api/admin/export.csv?status=maybe');
    await page.selectOption('#filter', '');

    // CSV export (using the logged-in browser session).
    const csv = await page.evaluate(() => fetch('/api/admin/export.csv').then((x) => x.text()));
    const lines = csv.replace(/^﻿/, '').trim().split(/\r\n/);
    assert.equal(lines[0], 'שם פרטי,תשובה,מספר אנשים,שעת שליחה');
    assert.equal(lines.length, 6);
    assert.ok(lines.some((l) => l.startsWith('רחל,מגיע/ה,3,')));
    const csvYes = await page.evaluate(() => fetch('/api/admin/export.csv?status=yes').then((x) => x.text()));
    assert.equal(csvYes.trim().split(/\r\n/).length, 4);

    // Edit: change the "maybe" Yossi to coming with +1.
    const maybeRow = page.locator('#rows tr', { hasText: 'עוד לא יודע/ת' });
    await maybeRow.getByRole('button', { name: 'עריכה' }).click();
    await page.selectOption('#editStatus', 'yes');
    await page.selectOption('#editPeople', '2');
    await page.click('#editForm button[type=submit]');
    await page.waitForFunction(() => document.getElementById('sTotal').textContent === '8');
    assert.deepEqual(await stats(), { total: '8', yes: '4', no: '1', maybe: '0' });

    // Delete Dana.
    page.once('dialog', (d) => d.accept());
    await page.locator('#rows tr', { hasText: 'דנה' }).getByRole('button', { name: 'מחיקה' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 4);
    assert.deepEqual(await stats(), { total: '7', yes: '3', no: '1', maybe: '0' });

    // Editable event details show up on the guest page.
    await page.click('details.settings summary');
    await page.fill('#eventForm [name=eventDate]', 'יום חמישי, 12.11.2026 בשעה 19:30');
    await page.fill('#eventForm [name=eventLocation]', 'אולמי הגן, חיפה');
    await page.click('#eventForm button');
    await page.waitForFunction(() => document.getElementById('eventSaved').textContent.includes('נשמר'));
    await page.goto(BASE + '/');
    await page.waitForFunction(() => document.getElementById('meta').textContent.includes('אולמי הגן'));
    assert.match(await page.textContent('h1'), /ליאור/);

    // Logout blocks access again.
    await page.goto(BASE + '/admin');
    await page.waitForSelector('#dashView:not([hidden])');
    await page.click('#logoutBtn');
    await page.waitForSelector('#loginView:not([hidden])');
    assert.equal(await page.evaluate(() => fetch('/api/admin/responses').then((x) => x.status)), 401);

    console.log('All end-to-end checks passed ✓');
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
