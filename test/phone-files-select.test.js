'use strict';
/*
 * CHOOSING SEVERAL IN "YOUR FILES": "an option to select more than one video
 * so I can select as many as I want to save or delete."
 *   [1] Select: tap as many as you like; the bar says how many and offers Save N / Delete N
 *   [2] Select all N picks a whole group in one tap (Clear selection undoes it),
 *       and Save all / Delete all step aside while choosing
 *   [3] Delete N (asked twice) deletes exactly those
 *
 *   node test/phone-files-select.test.js
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
const PORT = 7402, CODE = 'selall-test-5821';
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

    const uid = login.me && login.me.uid;
    const outs = [path.join(MEDIA, 'Church Work Space'), uid ? path.join(DATA, 'spaces', uid, 'Church Work Space') : null].filter(Boolean);
    const mp4 = path.join(WORK, 'clip.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
    for (const d of outs) { fs.mkdirSync(d, { recursive: true }); for (let n = 0; n < 6; n++) fs.copyFileSync(mp4, path.join(d, `short-${n}.mp4`)); }
    await page.evaluate(() => document.getElementById('cloudFiles').click()); await sleep(1500);
    await page.click('#cloudFilesSelect'); await sleep(300);
    const rows = await page.$$('#cloudFilesList .cf-row.can-del .cf-main');
    for (const r of rows.slice(0, 2)) await r.click();
    await sleep(200);
    let st = await page.evaluate(() => ({ info: document.getElementById('cloudFilesSelInfo').textContent, save: document.getElementById('cloudFilesSelSave').textContent.trim(), del: document.getElementById('cloudFilesSelDelete').textContent.trim(), saveAll: !!document.querySelector('[data-saveall]'), selAll: (document.querySelector('[data-selall]') || {}).textContent }));
    check(/^2 selected/.test(st.info) && st.save === 'Save 2' && st.del === 'Delete 2', '[1] two ticked: "Save 2" and "Delete 2"', st);
    check(!st.saveAll && /Select all 6/.test(st.selAll || ''), '[2] while choosing, Save all / Delete all step aside for "Select all 6"', st);
    await page.click('[data-selall]'); await sleep(300);
    st = await page.evaluate(() => ({ n: document.querySelectorAll('#cloudFilesList .cf-row.chosen').length, info: document.getElementById('cloudFilesSelInfo').textContent, selAll: document.querySelector('[data-selall]').textContent }));
    check(st.n === 6 && /^6 selected/.test(st.info) && /Clear selection/.test(st.selAll), '[2] Select all ticks all six', st);
    if (process.env.MW_SHOTS) await page.screenshot({ path: process.env.MW_SHOTS + '/selall.png' });
    await page.click('[data-selall]'); await sleep(300);
    st = await page.evaluate(() => document.querySelectorAll('#cloudFilesList .cf-row.chosen').length);
    check(st === 0, '[2] and Clear selection unticks them', st);
    // [3] tick three, delete them
    const rows2 = await page.$$('#cloudFilesList .cf-row.can-del .cf-main');
    for (const r of rows2.slice(0, 3)) await r.click();
    await page.click('#cloudFilesSelDelete'); await sleep(200);
    await page.click('#cloudFilesSelDelete'); await sleep(2500);
    const left = outs.map((d) => fs.readdirSync(d).filter((n) => /\.mp4$/.test(n)).length);
    check(left.some((n) => n === 3), '[3] Delete 3 (asked twice) deletes exactly three', left);
    st = await page.evaluate(() => ({ selecting: document.getElementById('cloudFilesModal').classList.contains('cf-selecting'), saveAll: !!document.querySelector('[data-saveall]') }));
    check(!st.selecting && st.saveAll, '[3] and the list goes back to normal, Save all and all', st);
  } finally { await browser.close(); srv.kill(); }
  console.log(`${pass} PASS / ${fail} FAIL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
