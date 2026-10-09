'use strict';
/*
 * SEVERAL UPLOADS AT ONCE, FROM A PHONE: "I should be able to upload more than
 * one file simultaneously." Over a slow connection (each piece takes 3 s):
 *   [1] four picked together: three go up at the same time, the fourth waits
 *   [2] each has its own bar and Stop; stopping one leaves the others going
 *   [3] more can be sent while some are on their way
 *   [4] everything not stopped arrives, and the list shows it
 *
 *   node test/phone-upload-many.test.js
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
const PORT = 7397, CODE = 'upmany-test-5821';
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

    const mk = (n, mb) => { const f = path.join(WORK, n); fs.writeFileSync(f, Buffer.alloc(mb * 1024 * 1024, 7)); return f; };
    const files = [mk('one.mp4', 10), mk('two.mp4', 10), mk('three.mp4', 10), mk('four.mp4', 10)];
    let inFlight = 0, most = 0;
    await page.route('**/api/upload?*offset=*', async (route) => {
      inFlight++; most = Math.max(most, inFlight);
      await sleep(3000);
      try { await route.continue(); } catch (e) {}
      inFlight--;
    });
    await page.evaluate(() => document.getElementById('cloudFiles').click()); await sleep(1200);
    const pick = async (list) => { const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.click('#cloudUpload')]); await ch.setFiles(list); };
    await pick(files);
    await sleep(1500);
    const rows = () => page.evaluate(() => [...document.querySelectorAll('#cloudUploadBar .cloud-up-row')].map((r) => ({ name: r.querySelector('.cloud-upload-name').textContent, wait: r.classList.contains('wait'), stop: !!r.querySelector('[data-upstop]') })));
    let r1 = await rows();
    console.log(JSON.stringify(r1));
    check(r1.length === 4 && r1.filter((x) => !x.wait).length === 3 && r1.filter((x) => x.wait).length === 1, '[1] four picked: three going up, one waiting', r1);
    check(r1.every((x) => x.stop), '[2] each has its own Stop');
    const stopAll = await page.evaluate(() => !!document.querySelector('#cloudUploadBar [data-upstop="*"]'));
    check(stopAll, '[2] and there is a Stop all');
    // stop the second one only
    await page.click('#cloudUploadBar .cloud-up-row:nth-child(2) [data-upstop]');
    await sleep(800);
    let r2 = await rows();
    check(r2.length === 3 && !r2.some((x) => x.name === 'two.mp4'), '[2] stopping one takes only that one away', r2);
    // [3] one more while they are going
    await pick([mk('five.mp4', 4)]);
    await sleep(800);
    let r3 = await rows();
    check(r3.some((x) => x.name === 'five.mp4'), '[3] another can be sent while these are on their way', r3);
    // wait for the lot
    for (let k = 0; k < 120; k++) { if (!(await rows()).length) break; await sleep(500); }
    check(most >= 3, '[1] they really went up at the same time (pieces in flight together: ' + most + ')');
    const names = await page.evaluate(() => [...document.querySelectorAll('#cloudFilesList .cf-row')].map((r) => r.textContent));
    const has = (n) => names.some((t) => t.includes(n));
    check(has('one.mp4') && has('three.mp4') && has('four.mp4') && has('five.mp4') && !has('two.mp4'), '[4] all but the stopped one arrived, and the list shows them', names.map((t) => t.slice(0, 40)));
    const isl = await page.evaluate(() => [...document.querySelectorAll('.cloud-island')].map((x) => x.textContent).join(' | '));
    void isl;
  } finally { await browser.close(); srv.kill(); }
  console.log(`${pass} PASS / ${fail} FAIL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
