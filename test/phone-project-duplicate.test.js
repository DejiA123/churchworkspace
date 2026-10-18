'use strict';
/*
 * ⧉ DUPLICATE A PROJECT — in a real browser, on the real Cloud Studio, the way
 * an iPhone uses the Projects screen.
 *
 * "I should be able to duplicate projects if I want — let that feature be
 *  available." Now:
 *   [1] the project open in the editor has Duplicate under it: a copy with the
 *       same video and edits (its shorts, its text) is first in the list as
 *       "… (copy)"
 *   [2] every other project's row has its own Duplicate button: "(copy 2)"
 *   [3] the copy opens in the editor with the edits, and changing it leaves
 *       the original exactly as it was
 *
 *   node test/phone-project-duplicate.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — duplicating projects was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7441;
const CODE = 'projdup-test-9182';
const WORK = path.join(os.tmpdir(), 'mw-proj-dup-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}
async function waitUp() {
  for (let k = 0; k < 60; k++) {
    try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); }
  }
  return false;
}

(async () => {
  const VID = path.join(MEDIA, 'Gospel Jamz 2026 Day 2.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=30', '-f', 'lavfi', '-i', 'sine=f=220:d=30',
    '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(800);
    // an edit worth copying: two shorts and a text
    await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      T.addShort(2, 10); T.addShort(12, 20);
      document.getElementById('vePlayer').currentTime = 3;
      document.getElementById('veAddText').click();
    });
    await sleep(700);
    await page.evaluate(() => { const d = document.getElementById('vtDone'); if (d) d.click(); });
    await sleep(300);
    const list = () => page.evaluate(() => window.api.sessions.list());
    const load = (id) => page.evaluate((id) => window.api.sessions.load(id), id);
    const shape = (d) => {
      const segs = (d && d.timeline && d.timeline.segments) || [];
      return { shorts: segs.filter((s) => s.ai).length, texts: ((d && d.timeline && d.timeline.textOverlays) || d && d.textOverlays || []).length, video: d && d.video && d.video.path };
    };

    console.log('\n=== [1] the open project: Duplicate ===');
    await page.evaluate(() => window.MWSocial.openProjects());
    await page.waitForSelector('#cloudProjView [data-pv="duplicate"]', { timeout: 15000 });
    await sleep(600);
    const origId = await page.evaluate(() => window.VideoEditor.projectId());
    const orig = await load(origId);
    await page.tap('#cloudProjView [data-pv="duplicate"]');
    await page.waitForFunction(() => document.querySelectorAll('#cloudProjView .pj-row').length >= 1, null, { timeout: 15000 });
    await sleep(500);
    let rows = await list();
    const copy1 = rows.find((r) => r.id !== origId);
    check(rows.length === 2 && !!copy1 && / \(copy\)$/.test(copy1.name), 'a copy is made, called “… (copy)”', rows.map((r) => r.name));
    const c1 = copy1 ? await load(copy1.id) : null;
    check(c1 && JSON.stringify(shape(c1)) === JSON.stringify(shape(orig)) && shape(orig).shorts === 2,
      'with the same video and edits (its two shorts, its text)', { orig: shape(orig), copy: shape(c1) });
    const firstRow = await page.evaluate(() => { const r = document.querySelector('#cloudProjView .pj-row b'); return r && r.textContent; });
    check(/\(copy\)$/.test(firstRow || ''), 'and it is in the list', firstRow);

    console.log('\n=== [2] a project in the list: its own Duplicate ===');
    await page.tap(`#cloudProjView [data-pjdup="${copy1.id}"]`);
    await page.waitForFunction(() => document.querySelectorAll('#cloudProjView .pj-row').length >= 2, null, { timeout: 15000 });
    rows = await list();
    const copy2 = rows.find((r) => r.id !== origId && r.id !== copy1.id);
    check(rows.length === 3 && copy2 && / \(copy 2\)$/.test(copy2.name), 'the row’s Duplicate makes “… (copy 2)”', rows.map((r) => r.name));

    console.log('\n=== [3] the copy is a project of its own ===');
    await page.evaluate((id) => window.MWSocial.openProject(id), copy1.id);
    await page.waitForFunction((id) => window.VideoEditor.projectId && window.VideoEditor.projectId() === id, copy1.id, { timeout: 30000 });
    await sleep(1200);
    const inEditor = await page.evaluate(() => window.VideoEditor.__test.segments().filter((s) => s.lane === 0).length);
    check(inEditor >= 2, 'it opens in the editor with the edits', inEditor);
    // change the copy: one short deleted, saved
    await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      const sh = document.querySelector('#veClipList [data-del]'); if (sh) sh.click();
    });
    await sleep(400);
    await page.evaluate(() => window.VideoEditor.flushProject());
    await sleep(500);
    const afterCopy = shape(await load(copy1.id)), afterOrig = shape(await load(origId));
    check(afterCopy.shorts === 1, 'the copy keeps the change', afterCopy);
    check(afterOrig.shorts === 2 && JSON.stringify(afterOrig) === JSON.stringify(shape(orig)), 'the original is exactly as it was', afterOrig);
  } catch (e) {
    check(false, 'ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
