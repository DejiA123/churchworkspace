'use strict';
/*
 * EVERY SHEET PULLS DOWN TO CLOSE. "I should be able to drag the Music screen
 * down, not only tap Done — the same for all similar windows." With a real
 * finger (touch events) on an iPhone-sized page:
 *   [1] 🎵 Music: a short pull springs back; a long pull from its top closes it
 *   [2] a pull that starts lower down (on the list) does not close it
 *   [3] the studio's Export sheet pulls down to close the same way
 *   [4] My Uploads still pulls down to close
 *   node test/phone-pull-down.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7469, CODE = 'pulldown-test-7731';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-pulldown-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
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
  const VID = path.join(MEDIA, 'clip.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=10', '-f', 'lavfi', '-i', 'sine=f=220:d=10',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 1, null, { timeout: 30000 });
    await sleep(800);
    const cdp = await ctx.newCDPSession(page);
    const pull = async (x, y, dy) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * k) / 10 }] }); await sleep(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(600);
    };
    const top = (sel) => page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + 24, h: r.height }; }, sel);
    const shown = (sel) => page.evaluate((q) => { const m = document.querySelector(q); return !!m && !m.classList.contains('hidden'); }, sel);

    console.log('\n=== [1] Music ===');
    await page.evaluate(() => document.getElementById('veMusic').click());
    await sleep(700);
    let t = await top('#libModal .lib-box');
    await pull(t.x, t.y, 40);
    check(await shown('#libModal'), 'a short pull springs back: Music stays open');
    t = await top('#libModal .lib-box');
    await pull(t.x, t.y, 220);
    check(!(await shown('#libModal')), 'pulled down by its top, Music closes');

    console.log('\n=== [2] only by its top ===');
    await page.evaluate(() => document.getElementById('veMusic').click());
    await sleep(700);
    t = await top('#libModal .lib-box');
    await pull(t.x, t.y + 220, 220);
    check(await shown('#libModal'), 'a pull lower down (on the list) does not close it');
    await page.evaluate(() => document.getElementById('libClose').click());
    await sleep(400);

    console.log('\n=== [3] the Export sheet ===');
    await page.evaluate(() => document.getElementById('cloudExport').click());
    await sleep(700);
    const open = await page.evaluate(() => document.body.classList.contains('mw-sheet-export'));
    check(open, 'Export opens its sheet');
    t = await top('#cloudSheetHead');
    await pull(t.x, t.y - 10, 220);
    check(!(await page.evaluate(() => document.body.classList.contains('mw-sheet'))), 'pulled down by its top, the Export sheet closes');

    console.log('\n=== [4] My Uploads ===');
    await page.evaluate(() => document.getElementById('cloudFiles').click());
    await sleep(1200);
    t = await top('#cloudFilesModal .cap-box');
    await pull(t.x, t.y, 220);
    check(!(await shown('#cloudFilesModal')), 'My Uploads still pulls down to close');
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally {
    try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
