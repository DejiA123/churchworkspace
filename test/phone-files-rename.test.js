'use strict';
/*
 * RENAMING A VIDEO IN MY UPLOADS. "I should be able to rename them if I want
 * to." Each finished video (and each sent from the phone) has a ✏️ beside
 * ⬇ and 🗑. Checks, on an iPhone-sized page:
 *   [1] ✏️ opens a box with the current name, selected, ready to type over
 *   [2] Save: the list shows the new name, and it is still there after the
 *       list is fetched again (kept on the server)
 *   [3] only the NAME changes — the file on disk is the same file
 *   [4] Cancel leaves the name alone
 *   [5] the server refuses a file outside My Uploads
 *   node test/phone-files-rename.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7461, CODE = 'rename-test-7713';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-rename-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body, token) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false,
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, token ? { authorization: 'Bearer ' + token } : {}) }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(Object.assign({ status: res.statusCode }, JSON.parse(b))); } catch (e) { reject(e); } });
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
    const uid = login.me && login.me.uid;
    const outs = [path.join(MEDIA, 'Church Work Space'), uid ? path.join(DATA, 'spaces', uid, 'Church Work Space') : null].filter(Boolean);
    const mp4 = path.join(WORK, 'clip.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
    for (const d of outs) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(mp4, path.join(d, 'Copy of Gospel Jamz 2026 Day 2.mp4')); fs.copyFileSync(mp4, path.join(d, 'short-2.mp4')); }
    await page.evaluate(() => document.getElementById('cloudFiles').click()); await sleep(1500);
    const pathOf = (re) => page.evaluate((src) => { const r = [...document.querySelectorAll('#cloudFilesList .cf-row.can-del')].find((x) => new RegExp(src).test(x.querySelector('.cf-tx b').textContent)); return r && r.dataset.path; }, re);
    const sel = (p) => `#cloudFilesList .cf-row[data-path="${p.replace(/["\\]/g, '\\$&')}"]`;
    const target = await pathOf('Gospel Jamz 2026 Day 2');
    const row = sel(target);
    const before = fs.statSync(target).ino;
    await page.click(row + ' [data-act="rename"]'); await sleep(400);
    let st = await page.evaluate((sel) => { const r = document.querySelector(sel), i = r.querySelector('.cf-ren input');
      return { open: r.classList.contains('renaming'), value: i.value, focused: document.activeElement === i, selected: i.selectionEnd - i.selectionStart === i.value.length }; }, row);
    check(st.open && st.value === 'Copy of Gospel Jamz 2026 Day 2' && st.focused && st.selected, '[1] ✏️ opens the name, selected, ready to type over', st);
    if (process.env.MW_SHOTS) await page.screenshot({ path: process.env.MW_SHOTS + '/rename.png' });
    await page.fill(row + ' .cf-ren input', 'Gospel Jamz 2026 · Day 2 Highlights');
    await page.press(row + ' .cf-ren input', 'Enter'); await sleep(800);
    const shown = await page.evaluate((p) => { const r = document.querySelector(`#cloudFilesList .cf-row[data-path="${CSS.escape(p)}"]`); return { name: r.querySelector('.cf-tx b').textContent, open: r.classList.contains('renaming') }; }, target);
    check(shown.name === 'Gospel Jamz 2026 · Day 2 Highlights' && !shown.open, '[2] Save: the list shows the new name', shown);
    await page.evaluate(() => document.getElementById('cloudFilesClose') && document.getElementById('cloudFilesClose').click()); await sleep(500);
    await page.evaluate(() => document.getElementById('cloudFiles').click()); await sleep(1500);
    const again = await page.evaluate((p) => { const r = document.querySelector(`#cloudFilesList .cf-row[data-path="${CSS.escape(p)}"]`); return r && r.querySelector('.cf-tx b').textContent; }, target);
    check(again === 'Gospel Jamz 2026 · Day 2 Highlights', '[2] …and it is still called that when the list comes back from the server', again);
    check(fs.existsSync(target) && fs.statSync(target).ino === before, '[3] only the name changed: the file on disk is untouched', target);
    const other = sel(await pathOf('^(?!Gospel)'));
    const otherName = await page.$eval(other, (r) => r.querySelector('.cf-tx b').textContent);
    await page.click(other + ' [data-act="rename"]'); await sleep(300);
    await page.fill(other + ' .cf-ren input', 'Should not stick');
    await page.click(other + ' .cf-ren [data-act="cancel"]'); await sleep(400);
    const kept = await page.$eval(other, (r) => ({ name: r.querySelector('.cf-tx b').textContent, open: r.classList.contains('renaming') }));
    check(kept.name === otherName && !kept.open, '[4] Cancel leaves the name as it was', kept);
    const bad = await post('/api/rename', { path: path.join(DATA, 'users.json'), title: 'x' }, login.token);
    check(bad.status === 403 && !bad.ok, '[5] the server refuses to rename anything outside My Uploads', bad);
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally {
    try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
