'use strict';
/*
 * THE CAPTIONS WINDOW'S PLAYER ON A PHONE — in a real browser, on the real
 * Cloud Studio, the way an iPhone uses it.
 *
 * "In the captions editor window when the video is playing I cannot pause the
 *  video." The lit line's own button stayed ▶ while the whole video played, and
 * tapping it — the obvious place to tap — started that line over instead of
 * stopping. Now:
 *   [A] the big ⏸ pauses, and ▶ carries on, however often it is pressed —
 *       including with the window opened while the video was already playing
 *   [B] while it plays, the line being heard wears ⏸ and tapping it pauses
 *       right there (no jump back); every other line keeps ▶ and plays itself
 *   [C] a line started with its own ▶ shows ⏸ and that pauses it too
 *   [D] Safari's dropped click: a touch with no click after it still pauses
 *       and plays (the buttons act on the finger lifting)
 *   [E] the list does not scroll itself under a finger — a tap on a moving
 *       list is a tap Safari throws away
 *
 * Needs Playwright with Chromium (not one of the app's dependencies); without
 * it this says so and skips.
 *
 *   node test/caption-player.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the captions player was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7398;
const CODE = 'capplayer-test-5822';
const WORK = path.join(os.tmpdir(), 'mw-cap-player-' + process.pid);
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
  // a 40 s picture the browser can play (Chromium here has no H.264), with sound
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const open = async (ctxOpts) => {
      const ctx = await browser.newContext(ctxOpts);
      await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
      await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
      await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
      await sleep(1000);
      return page;
    };
    const page = await open({ ...devices['iPhone 13'] });
    await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      const base = 'glory to god hallelujah glory to god we just want to thank god for giving us that big opportunity to praise him today'.split(' ');
      const w = []; for (let i = 0; i < 60; i++) w.push({ text: base[i % base.length], start: 0.3 + i * 0.6, end: 0.3 + i * 0.6 + 0.5 });
      T.setCapWords(w, 0); T.setCapWordsPerLine(3); T.revealCaps();
      // this test server has no speech engine; the window itself is what is under test
      window.api.captions.engineInfo = async () => ({ available: true });
    });
    await sleep(500);
    const st = () => page.evaluate(() => {
      const p = document.getElementById('vePlayer');
      const on = Array.from(document.querySelectorAll('#capList .cap-row-play')).filter((b) => b.textContent.trim() === '⏸').map((b) => +b.dataset.playI);
      return { open: !document.getElementById('capModal').classList.contains('hidden'), paused: p.paused, t: p.currentTime, btn: document.getElementById('capPlay').textContent, on };
    });

    console.log('\n=== [A] the big ⏸ pauses ===');
    await page.evaluate(() => document.getElementById('vePlayer').play());
    await sleep(1000);
    await page.evaluate(() => window.VideoEditor.__test.openCaptionsWindow());
    await sleep(1200);
    let s = await st();
    check(s.open && !s.paused && s.btn === '⏸', 'the window opens on a playing video, its button showing ⏸', s);
    for (let k = 1; k <= 4; k++) {
      await page.locator('#capPlay').tap();
      await sleep(700);
      const a = await st();
      await sleep(600);
      const b = await st();
      const wantPaused = k % 2 === 1;
      check(a.paused === wantPaused && b.paused === wantPaused && (wantPaused ? Math.abs(b.t - a.t) < 0.01 : b.t > a.t),
        `tap ${k} on the big button ${wantPaused ? 'pauses — and it stays paused' : 'plays on'}`, { a, b });
    }

    console.log('\n=== [B] the line being heard pauses from its own button ===');
    s = await st();
    if (s.paused) { await page.locator('#capPlay').tap(); await sleep(900); }
    s = await st();
    check(!s.paused && s.on.length === 1, 'while the whole video plays, exactly one line (the one being heard) shows ⏸', s);
    const lit = s.on[0];
    const t1 = (await st()).t;
    await page.locator(`#capList .cap-row-play[data-play-i="${lit}"]`).tap();
    await sleep(700);
    const a = await st();
    await sleep(700);
    const b = await st();
    check(a.paused && b.paused && a.t >= t1 - 0.05 && Math.abs(b.t - a.t) < 0.01, 'tapping it pauses right there — no jump back to the start of the line', { t1, a, b });
    check(b.on.length === 0 && b.btn === '▶', 'and every button goes back to ▶', b);
    const other = lit + 3;
    await page.locator(`#capList .cap-row-play[data-play-i="${other}"]`).scrollIntoViewIfNeeded();
    await page.locator(`#capList .cap-row-play[data-play-i="${other}"]`).tap();
    await sleep(500);
    const c = await st();
    check(!c.paused && c.on.length === 1 && c.on[0] === other, 'another line\'s ▶ plays THAT line, and its button turns to ⏸', { other, c });

    console.log('\n=== [C] a line started with its own ▶ ===');
    await page.locator(`#capList .cap-row-play[data-play-i="${other}"]`).tap();
    await sleep(600);
    const d = await st();
    check(d.paused && d.on.length === 0, 'its ⏸ pauses it', d);

    console.log('\n=== [D] a tap Safari never turns into a click still pauses (the iPhone bug) ===');
    // Safari drops the click of a tap that lands while the page is changing — the list
    // scrolling itself, captions coming and going. A touch with NO click after it:
    const touchOnly = (sel) => page.evaluate((sel) => {
      const b = document.querySelector(sel); const r = b.getBoundingClientRect();
      const t = new Touch({ identifier: 7, target: b, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      b.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
      return new Promise((res) => setTimeout(() => {
        b.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
        res();
      }, 80));
    }, sel);
    let e = await st();
    if (e.paused) { await page.locator('#capPlay').tap(); await sleep(800); }
    await touchOnly('#capPlay'); await sleep(700);
    e = await st();
    check(e.paused, 'the big ⏸ pauses on the finger lifting, with no click at all', e);
    await touchOnly('#capPlay'); await sleep(700);
    e = await st();
    check(!e.paused, 'and ▶ plays again the same way', e);
    const litD = (await st()).on[0];
    if (litD != null) {
      await touchOnly(`#capList .cap-row-play[data-play-i="${litD}"]`); await sleep(600);
      e = await st();
      check(e.paused, 'the lit line\'s ⏸ too', e);
    } else check(false, 'a line is lit while it plays', e);

    console.log('\n=== [E] the list holds still under a finger ===');
    // (nothing being typed in: a line with the keyboard up keeps the list where the hands are, on purpose)
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); const p = document.getElementById('vePlayer'); p.currentTime = 1; document.getElementById('capList').scrollTop = 0; });
    await page.locator('#capPlay').tap(); await sleep(400);
    // a finger rests on the window (on the time label) while the voice moves down the list
    await page.evaluate(() => { const el = document.getElementById('capPlayTime'); const r = el.getBoundingClientRect();
      const t = new Touch({ identifier: 9, target: el, clientX: r.left + 5, clientY: r.top + 5 });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] })); window.__finger = t; window.__fingerEl = el; });
    const top0 = await page.evaluate(() => document.getElementById('capList').scrollTop);
    await page.evaluate(() => { document.getElementById('vePlayer').currentTime = 30; });
    await sleep(1200);
    const top1 = await page.evaluate(() => document.getElementById('capList').scrollTop);
    check(top1 === top0, 'while a finger is on the window the list does not scroll itself', { top0, top1 });
    await page.evaluate(() => { const t = window.__finger; window.__fingerEl.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] })); });
    await sleep(2500);
    const top2 = await page.evaluate(() => document.getElementById('capList').scrollTop);
    check(top2 > top0, 'once it lifts, the list follows the voice again', { top0, top2 });
  } catch (e) { check(false, 'the test ran to the end', e.message); }
  await done();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
