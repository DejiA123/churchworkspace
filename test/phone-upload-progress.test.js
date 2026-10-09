'use strict';
/*
 * AN UPLOAD SAYS HOW FAR IT HAS GOT: "can there be a percentage during the
 * upload so I am engaged". Over a phone-speed connection (~1.5 MB/s up):
 *   the row shows "34% · 12 MB of 30 MB · under a minute left", and the
 *   number climbs while a piece is on its way (it used to move only once an
 *   8 MB piece had finished — a minute and more on a phone).
 *
 *   node test/phone-upload-progress.test.js
 */
/*
 * THE TEXT PANEL ON A PHONE — still, docked, and its Size number true.
 *
 *   [1] tapping a text on the picture brings the panel up WITHOUT moving or
 *       resizing the picture, and a first tap does not start typing
 *   [2] the Size number is the text's own (% of the picture's height): the
 *       same in the normal layout, full screen and sideways
 *   [3] the slider changes the size live; a size typed with the keyboard up
 *       is stored as typed
 *   [4] a focused Size box is never overwritten while the video plays
 *   [5] ✓ Done puts the panel away
 *
 *   node test/phone-text-panel.test.js
 */
/* (setup shared with phone-file-picker.test.js)
 * THE FILE CHOOSER
 *
 * "When you click Add music from my PC I have to close My music to see Your
 * files." The chooser sat earlier in the page than the studio's windows with
 * the same z-index, so it opened BEHIND them. This drives the real Cloud Studio
 * like an iPhone and checks, by what is actually under the finger:
 *   [1] My music → the chooser is on top, says "music", accepts audio, and a
 *       song sent from the phone lands in My music under its own name
 *   [2] My clips, the cover's own photo, the effects panel, the captions
 *       window → the chooser is on top of each
 *   [3] the timeline's + (nothing open) still works
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-file-picker.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7400, CODE = 'uppct-test-5821';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const onTop = (r) => r && !r.filesHidden && r.grid.every((g) => /cloudFilesModal/.test(g));
const WORK = path.join(os.tmpdir(), 'mw-zorder-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
(async () => {
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=20', '-f', 'lavfi', '-i', 'sine=f=220:d=20', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const SHOTS = process.env.MW_SHOTS || '';
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });

    const BIG = path.join(WORK, 'sermon.mp4');
    fs.writeFileSync(BIG, Buffer.alloc(30 * 1024 * 1024, 7));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 1.5 * 1024 * 1024 });
    await page.evaluate(() => document.getElementById('cloudFiles').click()); await sleep(1200);
    const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.click('#cloudUpload')]);
    await ch.setFiles(BIG);
    const seen = [];
    for (let k = 0; k < 16; k++) {
      await sleep(500);
      const t = await page.evaluate(() => { const e = document.querySelector('#cloudUploadBar .cloud-up-pct'); return e ? e.textContent : ''; });
      if (t) seen.push(t);
    }
    console.log(seen.slice(0, 3).concat(['…']).concat(seen.slice(-3)).join('\n'));
    const pcts = seen.map((t) => parseInt(t, 10)).filter((n) => !isNaN(n));
    const steps = new Set(pcts).size;
    check(/\d+% · [\d.]+ MB of 30(\.0)? MB/.test(seen[seen.length - 1] || ''), 'the row says the percentage and how much of how much', seen[seen.length - 1]);
    check(steps >= 6, 'the number climbs while it goes, not once a piece (' + steps + ' different values in 8 s)', pcts);
    check(seen.some((t) => /left/.test(t)), 'and how long is left', seen.slice(-1));
    if (process.env.MW_SHOTS) await page.screenshot({ path: process.env.MW_SHOTS + '/up-pct.png' });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    for (let k = 0; k < 60; k++) { if (!(await page.evaluate(() => document.querySelectorAll('#cloudUploadBar .cloud-up-row').length))) break; await sleep(500); }
    const names = await page.evaluate(() => [...document.querySelectorAll('#cloudFilesList .cf-row')].map((r) => r.textContent).join('|'));
    check(/sermon\.mp4/.test(names), 'and it arrives', names.slice(0, 120));
  } finally { await browser.close(); srv.kill(); }
  console.log(`${pass} PASS / ${fail} FAIL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
