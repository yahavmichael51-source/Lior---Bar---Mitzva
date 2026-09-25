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
const USERNAME = 'avishay';
const PASSWORD = 'test-password-123';

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const PHONE = { viewport: { width: 390, height: 844 } };

// Each guest answers from their own "phone" (a fresh browser context with empty storage).
async function submitRsvp(browser, firstName, lastName, statusLabel, peopleLabel, otherCount) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  await page.goto(BASE + '/');
  await page.fill('#firstName', firstName);
  await page.fill('#lastName', lastName);
  await page.getByRole('radio', { name: statusLabel, exact: true }).check();
  const peopleVisible = await page.isVisible('#peopleField');
  assert.equal(peopleVisible, statusLabel === 'מגיע/ה', `people question visibility for ${statusLabel}`);
  if (peopleLabel) await page.getByRole('radio', { name: peopleLabel, exact: true }).check();
  assert.equal(await page.isVisible('#otherCount'), peopleLabel === 'אחר', 'other-count field visibility');
  if (otherCount !== undefined) await page.fill('#otherCount', String(otherCount));
  await page.click('#submitBtn');
  await page.waitForSelector('#thanksCard:not([hidden])');
  assert.match(await page.textContent('#thanksText'), /נשמרה/);
  await context.close();
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-test-'));
  const entry = process.env.TEST_TARGET === 'netlify' ? 'test/netlify-sim.mjs' : 'server.js';
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_USERNAME: USERNAME, ADMIN_PASSWORD: PASSWORD, DATABASE_URL: process.env.TEST_DATABASE_URL || '' },
    stdio: 'inherit',
  });
  const browser = await chromium.launch();
  try {
    await waitForServer();
    const page = await browser.newPage(PHONE);

    // Validation: name is required, and "coming" requires a head count.
    await page.goto(BASE + '/');
    await page.getByRole('radio', { name: 'מגיע/ה', exact: true }).check();
    await page.click('#submitBtn');
    assert.equal(await page.textContent('#error'), 'נא לכתוב שם פרטי');
    await page.fill('#firstName', 'בדיקה');
    await page.click('#submitBtn');
    assert.equal(await page.textContent('#error'), 'נא לכתוב שם משפחה');
    await page.fill('#lastName', 'בודק');
    await page.click('#submitBtn');
    assert.equal(await page.textContent('#error'), 'נא לבחור כמה אנשים יגיעו');

    // Server rejects invalid payloads too.
    let r;
    for (const people of [0, 31, 2.5, 'abc']) {
      r = await fetch(BASE + '/api/rsvp', { method: 'POST', body: JSON.stringify({ firstName: 'x', lastName: 'y', status: 'yes', people }) });
      assert.equal(r.status, 400, `people=${people} must be rejected`);
    }
    r = await fetch(BASE + '/api/rsvp', { method: 'POST', body: JSON.stringify({ firstName: 'x', status: 'no' }) });
    assert.equal(r.status, 400, 'last name is required');

    // "Other" needs a valid number.
    await page.goto(BASE + '/');
    await page.fill('#firstName', 'בדיקה');
    await page.fill('#lastName', 'בודק');
    await page.getByRole('radio', { name: 'מגיע/ה', exact: true }).check();
    await page.getByRole('radio', { name: 'אחר', exact: true }).check();
    await page.click('#submitBtn');
    assert.match(await page.textContent('#error'), /מספר בין 1 ל־30/);
    await page.fill('#otherCount', '31');
    await page.click('#submitBtn');
    assert.match(await page.textContent('#error'), /מספר בין 1 ל־30/);

    await submitRsvp(browser, 'דנה', 'לוי', 'מגיע/ה', 'רק אני');       // 1
    await submitRsvp(browser, 'יוסי', 'כהן', 'מגיע/ה', 'אני + 1');     // 2
    await submitRsvp(browser, 'רחל', 'מזרחי', 'מגיע/ה', 'אני + 2');    // 3
    await submitRsvp(browser, 'אבי', 'פרץ', 'מגיע/ה', 'אני + 3');      // 4
    await submitRsvp(browser, 'נועה', 'ביטון', 'מגיע/ה', 'אני + 4');   // 5
    await submitRsvp(browser, 'שרה', 'אברהם', 'מגיע/ה', 'אחר', 7);     // 7
    await submitRsvp(browser, 'משה', 'דהן', 'לא מגיע/ה');
    await submitRsvp(browser, 'יוסי', 'כהן', 'עוד לא יודע/ת');         // same name: must stay a separate row

    // A guest who wasn't sure changes their answer twice, from the same phone.
    const guestCtx = await browser.newContext(PHONE);
    const guest = await guestCtx.newPage();
    await guest.goto(BASE + '/');
    await guest.fill('#firstName', 'עידו');
    await guest.fill('#lastName', 'שלום');
    await guest.getByRole('radio', { name: 'עוד לא יודע/ת', exact: true }).check();
    await guest.click('#submitBtn');
    await guest.waitForSelector('#thanksCard:not([hidden])');
    // Right away from the thank-you screen: change to "coming, me + 2".
    await guest.click('#changeBtn');
    await guest.waitForSelector('#formCard:not([hidden])');
    assert.equal(await guest.inputValue('#firstName'), 'עידו');
    assert.equal(await guest.inputValue('#lastName'), 'שלום');
    assert.ok(await guest.isChecked('input[name=status][value=maybe]'));
    assert.equal(await guest.textContent('#submitBtn'), 'עדכון התשובה');
    await guest.getByRole('radio', { name: 'מגיע/ה', exact: true }).check();
    await guest.getByRole('radio', { name: 'אני + 2', exact: true }).check();
    await guest.click('#submitBtn');
    await guest.waitForSelector('#thanksCard:not([hidden])');
    assert.match(await guest.textContent('#thanksText'), /עודכנה/);
    // Days later: reopening the link shows their answer with a "change" button.
    await guest.goto(BASE + '/');
    await guest.waitForSelector('#mineCard:not([hidden])');
    assert.ok(await guest.isHidden('#formCard'));
    assert.match(await guest.textContent('#mineList'), /עידו שלום/);
    assert.match(await guest.textContent('#mineList'), /מגיע\/ה · 3 אנשים/);
    await guest.getByRole('button', { name: 'שינוי תשובה' }).click();
    assert.ok(await guest.isChecked('input[name=people][value="3"]'));
    await guest.getByRole('radio', { name: 'לא מגיע/ה', exact: true }).check();
    assert.ok(await guest.isHidden('#peopleField'));
    await guest.click('#submitBtn');
    await guest.waitForSelector('#thanksCard:not([hidden])');
    await guest.goto(BASE + '/');
    await guest.waitForSelector('#mineCard:not([hidden])');
    assert.match(await guest.textContent('#mineList'), /לא מגיע\/ה/);
    // ...and back to coming with me + 2 (final state for the totals below).
    await guest.getByRole('button', { name: 'שינוי תשובה' }).click();
    await guest.getByRole('radio', { name: 'מגיע/ה', exact: true }).check();
    await guest.getByRole('radio', { name: 'אני + 2', exact: true }).check();
    await guest.click('#submitBtn');
    await guest.waitForSelector('#thanksCard:not([hidden])');
    // Only the token holder can read or change an answer.
    const [{ id: ownId }] = await guest.evaluate(() => JSON.parse(localStorage.getItem('rsvp-mine')));
    r = await fetch(BASE + '/api/rsvp/' + ownId);
    assert.equal(r.status, 404, 'no token → no access');
    r = await fetch(BASE + '/api/rsvp/' + ownId, {
      method: 'PUT',
      headers: { 'X-Edit-Token': 'guess' },
      body: JSON.stringify({ firstName: 'x', lastName: 'y', status: 'no' }),
    });
    assert.equal(r.status, 404, 'wrong token → no access');
    // "Send for someone else" from the same phone starts a blank form.
    await guest.goto(BASE + '/');
    await guest.waitForSelector('#mineCard:not([hidden])');
    await guest.click('#newForOther');
    assert.equal(await guest.inputValue('#firstName'), '');
    await guestCtx.close();
    // Expected: 7 "coming" responses, 1+2+3+4+5+7+3 = 25 people, 18 companions; 9 responses.

    // Admin data is protected.
    r = await fetch(BASE + '/api/admin/responses');
    assert.equal(r.status, 401);
    r = await fetch(BASE + '/api/admin/export.csv');
    assert.equal(r.status, 401);
    const adminHtml = await (await fetch(BASE + '/admin')).text();
    const adminJs = await (await fetch(BASE + '/admin.js')).text();
    assert.ok(!adminHtml.includes(PASSWORD) && !adminJs.includes(PASSWORD), 'password must not reach the browser');

    // Corner login on the guest page: wrong username, wrong password, then correct.
    await page.goto(BASE + '/');
    const corner = await page.locator('#loginOpen').boundingBox();
    assert.ok(corner.x < 60 && corner.y < 60, 'login button sits in the top-left corner');
    await page.click('#loginOpen');
    await page.fill('#loginUser', 'someone');
    await page.fill('#loginPass', PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForFunction(() => document.getElementById('loginError').textContent === 'שם משתמש או סיסמה שגויים');
    await page.fill('#loginUser', USERNAME);
    await page.fill('#loginPass', 'wrong');
    await page.click('#loginSubmit');
    await page.waitForFunction(() => document.getElementById('loginError').textContent === 'שם משתמש או סיסמה שגויים');
    await page.fill('#loginPass', PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForURL(BASE + '/admin');
    await page.waitForSelector('#dashView:not([hidden])');

    // Reload to prove persistence + session cookie.
    await page.reload();
    await page.waitForSelector('#dashView:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 9);

    const stats = async () => ({
      total: await page.textContent('#sTotal'),
      yes: await page.textContent('#sYes'),
      no: await page.textContent('#sNo'),
      maybe: await page.textContent('#sMaybe'),
    });
    assert.deepEqual(await stats(), { total: '25', yes: '7', no: '1', maybe: '1' });
    assert.equal(await page.textContent('#sResponses'), '9');
    assert.equal(await page.textContent('#sCompanions'), '18');
    assert.equal(await page.textContent('#sTotal2'), '25');
    const adminJson = await page.evaluate(() => fetch('/api/admin/responses').then((x) => x.text()));
    assert.ok(!adminJson.includes('editTokenHash'), 'token hashes are never sent out');
    const edited = await page.locator('#rows tr', { hasText: 'עידו' }).textContent();
    assert.match(edited, /שלום/);
    assert.match(edited, /3 \(אני \+ 2\)/);
    const sizes = await page.$$eval('#sizeRows tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    assert.deepEqual(sizes, [
      ['רק אני (1)', '1', '1'],
      ['אני + 1 (2)', '1', '2'],
      ['אני + 2 (3)', '2', '6'],
      ['אני + 3 (4)', '1', '4'],
      ['אני + 4 (5)', '1', '5'],
      ['אני + 6 (7)', '1', '7'],
    ]);

    // Filter.
    await page.selectOption('#filter', 'yes');
    assert.equal(await page.locator('#rows tr').count(), 7);
    await page.selectOption('#filter', 'maybe');
    assert.equal(await page.locator('#rows tr').count(), 1);
    assert.equal(await page.getAttribute('#csvLink', 'href'), '/api/admin/export.csv?status=maybe');
    await page.selectOption('#filter', '');

    // CSV export (using the logged-in browser session).
    const csv = await page.evaluate(() => fetch('/api/admin/export.csv').then((x) => x.text()));
    const lines = csv.replace(/^﻿/, '').trim().split(/\r\n/);
    assert.equal(lines[0], 'שם פרטי,שם משפחה,תשובה,מספר אנשים,שעת שליחה,עודכן לאחרונה');
    assert.equal(lines.length, 10);
    assert.ok(lines.some((l) => l.startsWith('רחל,מזרחי,מגיע/ה,3,')));
    assert.ok(lines.some((l) => l.startsWith('שרה,אברהם,מגיע/ה,7,')));
    assert.ok(lines.some((l) => l.startsWith('עידו,שלום,מגיע/ה,3,') && !l.endsWith(',')), 'updated time is filled in');
    const csvYes = await page.evaluate(() => fetch('/api/admin/export.csv?status=yes').then((x) => x.text()));
    assert.equal(csvYes.trim().split(/\r\n/).length, 8);

    // Edit: change the "maybe" Yossi to coming with +1.
    const maybeRow = page.locator('#rows tr', { hasText: 'עוד לא יודע/ת' });
    await maybeRow.getByRole('button', { name: 'עריכה' }).click();
    await page.selectOption('#editStatus', 'yes');
    await page.fill('#editPeople', '2');
    await page.click('#editForm button[type=submit]');
    await page.waitForFunction(() => document.getElementById('sTotal').textContent === '27');
    assert.deepEqual(await stats(), { total: '27', yes: '8', no: '1', maybe: '0' });

    // Delete Dana.
    page.once('dialog', (d) => d.accept());
    await page.locator('#rows tr', { hasText: 'דנה' }).getByRole('button', { name: 'מחיקה' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 8);
    assert.deepEqual(await stats(), { total: '26', yes: '7', no: '1', maybe: '0' });
    assert.equal(await page.textContent('#sCompanions'), '19');

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
