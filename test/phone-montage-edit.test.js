'use strict';
/*
 * EDIT THE MONTAGE: "I should be able to see the video preview rather than the
 * thumbnail." A tap on a shot's picture plays that shot of the montage.
 *   [1] every shot's picture has ▶ on it
 *   [2] a tap plays that shot (from the montage itself), bigger, in place
 *   [3] a second tap stops it
 *
 *   node test/phone-montage-edit.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7417, CODE = 'mtedit-test-6113';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const onTop = (r) => r && !r.filesHidden && r.grid.every((g) => /cloudFilesModal/.test(g));
const WORK = path.join(os.tmpdir(), 'mw-mtedit-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
(async () => {
  const VID = path.join(MEDIA, 'a.mp4'), VID2 = path.join(MEDIA, 'b.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=8', '-f', 'lavfi', '-i', 'sine=f=220:d=8', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', VID]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=15:d=8', '-f', 'lavfi', '-i', 'sine=f=330:d=8', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', VID2]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#home`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.api && window.api.montage && window.MWSocial, null, { timeout: 30000 });
    const made = await page.evaluate((v) => window.api.montage.create({ mediaPaths: v, style: 'hype', lengthSec: 8, aspect: '9:16', keepAudio: true }).then((r) => r.output, (e) => 'ERR ' + e.message), [VID, VID2]);
    check(made && !/^ERR/.test(made), 'a montage is made', made);
    await page.evaluate((o) => window.MWSocial.editMontage(o), made);
    await sleep(1200);
    const n = await page.evaluate(() => document.querySelectorAll('#cloudMontageEdit [data-me-play]').length);
    check(n >= 2, '[1] every shot has its picture to tap, with ▶ on it', n);
    // the second shot: it plays from where it is in the montage
    const want = await page.evaluate(async (o) => { const pj = await window.api.montage.project(o); return { start: pj.shots[0].seconds, end: pj.shots[0].seconds + pj.shots[1].seconds }; }, made);
    // (this test browser has no H.264, so the montage cannot actually play here: what is checked is that the tap
    // starts THAT shot of the montage, in place and bigger — an iPhone plays it)
    const st = await page.evaluate(() => {
      const slot = document.querySelector('#cloudMontageEdit [data-me-play="1"]');
      slot.style.transition = 'none';   // (its size, not the animation to it)
      slot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const v = slot.querySelector('video');
      const m = v && /#t=([\d.]+),([\d.]+)$/.exec(v.src);
      return v ? { from: m && +m[1], to: m && +m[2], montage: /montage-.*\.mp4/.test(decodeURIComponent(v.src)), playing: slot.classList.contains('playing'), w: slot.getBoundingClientRect().width } : null;
    });
    check(st && st.montage && Math.abs(st.from - want.start) < 0.05 && Math.abs(st.to - want.end) < 0.05 && st.playing && st.w >= 100, '[2] tapping a shot plays THAT shot of the montage, bigger, right there', { st, want });
    await page.evaluate(() => { const v = document.querySelector('#cloudMontageEdit video'); if (v) v.onerror = null; });
    await page.evaluate(() => { const slot = document.querySelector('#cloudMontageEdit [data-me-play="1"]'); if (slot.querySelector('video')) slot.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await sleep(300);
    const gone = await page.evaluate(() => !document.querySelector('#cloudMontageEdit video'));
    check(gone, '[3] a second tap stops it, and the picture comes back');
    if (process.env.MW_SHOTS) { await page.locator('#cloudMontageEdit [data-me-play="0"]').tap(); await sleep(900); await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'montage-edit-play.png') }); }
  } catch (e) {
    check(false, 'the test ran to the end', e && e.message);
  } finally { await browser.close(); srv.kill(); }
  console.log(`${pass} PASS / ${fail} FAIL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
