// Focused check that returning guests are recognized and that every change keeps the earlier answer
// for the organizer. Prints one line per scenario. Runs against the Node server or (TEST_TARGET=netlify)
// the Netlify simulation.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const PORT = 3460;
const BASE = `http://localhost:${PORT}`;
const PHONE = { viewport: { width: 390, height: 844 } };
let passed = 0;

async function check(title, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${title}`);
}

async function answer(page, first, last, statusLabel, peopleLabel) {
  await page.fill('#firstName', first);
  await page.fill('#lastName', last);
  await page.getByRole('radio', { name: statusLabel, exact: true }).check();
  if (peopleLabel) await page.getByRole('radio', { name: peopleLabel, exact: true }).check();
  await page.click('#submitBtn');
  await page.waitForSelector('#thanksCard:not([hidden]), #matchCard:not([hidden])');
  return (await page.isVisible('#matchCard')) ? 'asked' : 'saved';
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsvp-recog-'));
  const entry = process.env.TEST_TARGET === 'netlify' ? 'test/netlify-sim.mjs' : 'server.js';
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_USERNAME: 'sarit', ADMIN_PASSWORD: 'pw', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const browser = await chromium.launch();
  const newPhone = async () => (await browser.newContext(PHONE)).newPage();
  const adminRows = async () => {
    const admin = await newPhone();
    await admin.goto(BASE + '/?admin');
    await admin.waitForSelector('#loginDialog[open]');
    await admin.fill('#loginUser', 'sarit');
    await admin.fill('#loginPass', 'pw');
    await admin.click('#loginSubmit');
    await admin.waitForURL(BASE + '/admin');
    await admin.waitForSelector('#dashView:not([hidden])');
    const data = await admin.evaluate(() => fetch('/api/admin/responses').then((r) => r.json()));
    return { admin, data };
  };
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`Recognition checks (${process.env.TEST_TARGET === 'netlify' ? 'Netlify' : 'Node server'}):`);

    const phoneA = await newPhone();
    await phoneA.goto(BASE + '/');
    await check('New guest (Dana Levi, not sure yet) is saved without any question', async () => {
      assert.equal(await answer(phoneA, 'דנה', 'לוי', 'עוד לא יודע/ת'), 'saved');
    });

    await check('Same phone, days later: opening the link shows her answer + "change answer", not an empty form', async () => {
      await phoneA.goto(BASE + '/');
      await phoneA.waitForSelector('#mineCard:not([hidden])');
      assert.ok(await phoneA.isHidden('#formCard'));
      assert.match(await phoneA.textContent('#mineList'), /דנה לוי/);
      assert.match(await phoneA.textContent('#mineList'), /עוד לא יודע\/ת/);
    });

    await check('Same phone: she changes to "coming, me + 1" — the answer is updated in place', async () => {
      await phoneA.getByRole('button', { name: 'שינוי תשובה' }).click();
      assert.equal(await answer(phoneA, 'דנה', 'לוי', 'מגיע/ה', 'אני + 1'), 'saved');
      assert.match(await phoneA.textContent('#thanksText'), /עודכנה/);
    });

    const phoneB = await newPhone();
    await phoneB.goto(BASE + '/');
    await check('Different phone, same name: she is asked "is that you?" (her earlier answer is not shown to others)', async () => {
      assert.equal(await answer(phoneB, 'דנה', 'לוי', 'לא מגיע/ה'), 'asked');
      assert.match(await phoneB.textContent('#matchText'), /דנה לוי/);
      assert.doesNotMatch(await phoneB.textContent('#matchText'), /מגיע/);
    });

    await check('"Yes, that\'s me" updates her existing answer — still one row for Dana', async () => {
      await phoneB.click('#matchMe');
      await phoneB.waitForSelector('#thanksCard:not([hidden])');
      assert.match(await phoneB.textContent('#thanksText'), /עודכנה/);
      const { data } = await adminRows();
      const danas = data.responses.filter((r) => r.firstName === 'דנה');
      assert.equal(danas.length, 1);
      assert.equal(danas[0].status, 'no');
    });

    await check('Recognized even with extra spaces / different letter case in the name', async () => {
      const p = await newPhone();
      await p.goto(BASE + '/');
      assert.equal(await answer(p, '  דנה ', ' לוי  ', 'לא מגיע/ה'), 'asked');
      const q = await newPhone();
      await q.goto(BASE + '/');
      await answer(q, 'Tom', 'Cohen', 'לא מגיע/ה');
      const q2 = await newPhone();
      await q2.goto(BASE + '/');
      assert.equal(await answer(q2, 'tom', 'COHEN', 'לא מגיע/ה'), 'asked');
    });

    await check('Same first name but different last name is a different person — no question', async () => {
      const p = await newPhone();
      await p.goto(BASE + '/');
      assert.equal(await answer(p, 'דנה', 'כהן', 'מגיע/ה', 'רק אני'), 'saved');
    });

    await check('"No, I\'m someone else with the same name" saves a separate answer', async () => {
      const p = await newPhone();
      await p.goto(BASE + '/');
      assert.equal(await answer(p, 'דנה', 'לוי', 'מגיע/ה', 'רק אני'), 'asked');
      await p.click('#matchOther');
      await p.waitForSelector('#thanksCard:not([hidden])');
      const { data } = await adminRows();
      assert.equal(data.responses.filter((r) => r.firstName === 'דנה' && r.lastName === 'לוי').length, 2);
    });

    await check('After switching phones, only the newest phone can change the answer', async () => {
      const [{ id, token }] = await phoneA.evaluate(() => JSON.parse(localStorage.getItem('rsvp-mine')));
      const r = await fetch(`${BASE}/api/rsvp/${id}`, { headers: { 'X-Edit-Token': token } });
      assert.equal(r.status, 404);
      await phoneA.goto(BASE + '/');
      await phoneA.waitForTimeout(500);
      assert.ok(await phoneA.isHidden('#mineCard'), 'old phone no longer lists it');
      await phoneB.goto(BASE + '/');
      await phoneB.waitForSelector('#mineCard:not([hidden])');
    });

    await check('Organizer sees the current answer AND every earlier answer, newest first', async () => {
      const { admin, data } = await adminRows();
      const dana = data.responses.find((r) => r.firstName === 'דנה' && r.lastName === 'לוי' && r.history.length);
      assert.equal(dana.status, 'no');
      assert.deepEqual(
        dana.history.map((h) => [h.status, h.people]),
        [['maybe', 0], ['yes', 2]],
        'history: not sure → coming with 2 → (now) not coming'
      );
      const row = admin.locator('#rows tr.changed', { hasText: 'לוי' });
      const text = await row.textContent();
      assert.match(text, /לא מגיע\/ה/);
      assert.match(text, /קודם: מגיע\/ה \(2\)[\s\S]*קודם: עוד לא יודע\/ת/);
      assert.equal(await admin.textContent('#sChanged'), '1');
      await admin.selectOption('#filter', 'changed');
      assert.equal(await admin.locator('#rows tr').count(), 1);
      const csv = await admin.evaluate(() => fetch('/api/admin/export.csv?status=changed').then((r) => r.text()));
      assert.match(csv, /דנה,לוי,לא מגיע\/ה,0,.*עוד לא יודע\/ת עד .* ← מגיע\/ה \(2\) עד /);
    });

    await check('Totals count only the current answer (earlier answers are not double-counted)', async () => {
      const { data } = await adminRows();
      // Dana Levi (no), Tom Cohen (no), Dana Cohen (1), second Dana Levi (1)
      assert.deepEqual(
        { total: data.summary.totalPeople, yes: data.summary.yes, no: data.summary.no, maybe: data.summary.maybe },
        { total: 2, yes: 2, no: 2, maybe: 0 }
      );
    });

    await check('Guests never see the change history; the organizer\'s edits are recorded too', async () => {
      await phoneB.goto(BASE + '/');
      const [{ id, token }] = await phoneB.evaluate(() => JSON.parse(localStorage.getItem('rsvp-mine')));
      const mine = await (await fetch(`${BASE}/api/rsvp/${id}`, { headers: { 'X-Edit-Token': token } })).json();
      assert.equal(mine.response.history, undefined);
      const { admin } = await adminRows();
      await admin.locator('#rows tr', { hasText: 'Tom' }).getByRole('button', { name: 'עריכה' }).click();
      await admin.selectOption('#editStatus', 'maybe');
      await admin.click('#editForm button[type=submit]');
      await admin.waitForFunction(() => document.getElementById('sChanged').textContent === '2');
      assert.match(await admin.locator('#rows tr', { hasText: 'Tom' }).textContent(), /קודם: לא מגיע\/ה.*\(על ידי המנהל\)/);
    });

    console.log(`All ${passed} recognition checks passed ✓`);
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(`✗ failed after ${passed} passing checks:`, err);
  process.exit(1);
});
