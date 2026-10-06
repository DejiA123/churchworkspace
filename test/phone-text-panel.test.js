'use strict';
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
const PORT = 7385, CODE = 'textpanel-test-5821';
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
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(800);
    const id = await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      const id = T.addTextAt({ text: 'GRACE & MERCY', start: 0, end: 999, x: 0.5, y: 0.25, sizePct: 0.11 });
      T.selectText(null); document.getElementById('vePlayer').currentTime = 2;
      return id;
    });
    await sleep(600);
    const st = () => page.evaluate(() => {
      const r = (sel) => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
      const bar = document.getElementById('veTextTools');
      return { frame: r('#vePlayer'), shown: !bar.classList.contains('hidden'), bar: r('#veTextTools'), size: document.getElementById('vtSize').value,
        editing: !!document.querySelector('.ve-text-box .ve-text-content[contenteditable="true"]'), vw: innerWidth, vh: innerHeight };
    });
    const before = await st();
    console.log('\n[1] a tap brings the panel up, and nothing moves');
    const box = page.locator(`.ve-text-box[data-id="${id}"]`);
    const bb = await box.boundingBox();
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(500);
    const on = await st();
    check(on.shown, 'the panel is up', on);
    check(JSON.stringify(on.frame) === JSON.stringify(before.frame), 'the picture did not move or change size', { before: before.frame, after: on.frame });
    check(!on.editing, 'a first tap picks the text without starting to type', on);
    check(on.bar && on.bar[0] <= 1 && on.bar[2] >= on.vw - 2 && on.bar[1] + on.bar[3] >= on.vh - 2, 'the panel is docked along the bottom of the screen, full width', on.bar);
    check(on.bar && on.bar[2] <= on.vw + 1, 'nothing in it hangs off the side of the phone', on.bar);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'text-panel.png') });
    console.log('\n[2] the Size number is the text\'s own');
    check(on.size === '11', 'it reads 11 (% of the picture) for a title 11% tall', on.size);
    await page.setViewportSize({ width: 844, height: 390 });
    await sleep(700);
    check((await st()).size === '11', 'sideways it still reads 11', (await st()).size);
    await page.setViewportSize({ width: before.vw, height: before.vh });
    await sleep(700);
    const back = await st();
    check(back.size === '11', 'and upright again, 11', back.size);
    console.log('\n[3] slider and typing');
    await page.evaluate(() => { const r = document.getElementById('vtSizeRange'); r.value = '20'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(300);
    const slid = await page.evaluate((id) => ({ pct: window.VideoEditor.__test.textStyleOf(id).sizePct, shown: document.getElementById('vtSize').value }), id);
    check(Math.abs(slid.pct - 0.2) < 1e-9 && slid.shown === '20', 'sliding to 20 makes the letters 20% of the picture, and says so', slid);
    // the keyboard, as iOS makes it: the visual viewport shrinks
    await page.evaluate(() => {
      const vv = window.visualViewport; const h = innerHeight - 336;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
      vv.dispatchEvent(new Event('resize'));
      document.getElementById('vtSize').focus();
    });
    await sleep(500);
    const kb = await st();
    check(JSON.stringify(kb.frame) === JSON.stringify(back.frame), 'with the keyboard up the picture stays exactly as it was', { before: back.frame, kb: kb.frame });
    await page.evaluate(() => { const n = document.getElementById('vtSize'); n.value = '8'; n.dispatchEvent(new Event('change', { bubbles: true })); });
    const typed = await page.evaluate((id) => window.VideoEditor.__test.textStyleOf(id).sizePct, id);
    check(Math.abs(typed - 0.08) < 1e-9, 'a size typed with the keyboard up is stored as typed (8%)', typed);
    console.log('\n[4] a focused box is never overwritten');
    await page.evaluate(() => { const n = document.getElementById('vtSize'); n.focus(); n.value = '5'; document.getElementById('vePlayer').play(); });
    await sleep(1500);
    check(await page.evaluate(() => document.getElementById('vtSize').value) === '5', 'what is being typed stays while the video plays');
    await page.evaluate(() => { document.getElementById('vePlayer').pause(); document.getElementById('vtSize').blur(); delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
    console.log('\n[5] Done');
    await page.locator('#vtDone').tap();
    await sleep(400);
    check(!(await st()).shown, '✓ Done puts the panel away');
  } catch (e) { check(false, 'the test ran to the end', e.message); }
  finally { await browser.close(); srv.kill(); fs.rmSync(WORK, { recursive: true, force: true }); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
