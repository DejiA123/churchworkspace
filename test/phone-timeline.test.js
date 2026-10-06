'use strict';
/*
 * THE PHONE'S TIMELINE, AS CAPCUT HAS IT — in a real browser, on the real
 * Cloud Studio, the way an iPhone uses it.
 *
 *   [A] the white line stays in the middle: at the start, after a swipe, while
 *       playing, at the very end, after a pinch and after Fit — and the start
 *       and the end of the video both reach it
 *   [B] a swipe is a scrub: whatever is under the line is what the picture
 *       shows, and taking the timeline stops playback
 *   [C] nothing jumps on a tap; trim handles belong to the selected clip only;
 *       a first tap on a caption selects it, its handle trims it, a second tap
 *       types into it
 *   [D] the things a review found: a touch on a block the lane redraws cannot
 *       freeze the timeline; Play during a coasting flick keeps playing; a
 *       long press on empty track still draws a clip; a wide screen keeps the
 *       desk's timeline
 *   [E] a caption typed in lower case wears the Case that is chosen
 *
 * Needs Playwright with Chromium (it is not one of the app's dependencies);
 * without it this says so and skips.
 *
 *   node test/phone-timeline.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the phone timeline was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7397;
const CODE = 'timeline-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-phone-timeline-' + process.pid);
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
    const geo = () => page.evaluate(() => {
      const sc = document.getElementById('veTlScroll'), ph = document.getElementById('vePlayhead'), p = document.getElementById('vePlayer');
      const r = sc.getBoundingClientRect(), h = ph.getBoundingClientRect();
      return { centred: sc.classList.contains('ve-centred'), pad: parseFloat(sc.style.paddingLeft) || 0, half: sc.clientWidth / 2,
        x: h.left + h.width / 2 - r.left, scroll: sc.scrollLeft, t: p.currentTime, paused: p.paused, D: p.duration };
    });
    // a finger on the timeline: touchstart, the scroll it makes, touchend
    const swipe = (dx) => page.evaluate((dx) => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect();
      const fire = (type) => { const t = new Touch({ identifier: 1, target: sc, clientX: r.left + 100, clientY: r.top + 60 });
        sc.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t] })); };
      fire('touchstart'); sc.scrollLeft += dx;
      return new Promise((res) => setTimeout(() => { fire('touchend'); res(); }, 120));
    }, dx);
    const centred = (g) => Math.abs(g.x - g.half) <= 3;

    // the phone runs the Word Book too ("Fix captions from book"): its built-in names must have the
    // known-word list, or the phone could do what the server no longer does ("plate" -> "Pilate")
    const wb = await page.evaluate(() => {
      const W = window.WordBook, m = W.compile({ enabled: true, soundAlike: true, fixes: [], terms: [] });
      const say = (t) => W.applyToWords(t.split(' ').map((x, i) => ({ text: x, start: i, end: i + 0.9 })), m).words.map((w) => w.text).join(' ');
      return { list: typeof window.WordBookEnglish === 'string', plate: say('the plate was'), name: say('think about Methabosheth who') };
    });
    check(wb.list && wb.plate === 'the plate was' && wb.name === 'think about Mephibosheth who',
      'the phone loads the known-word list: "plate" stays, "Methabosheth" is still fixed', wb);

    console.log('\n=== [A] the line stays in the middle ===');
    let g = await geo();
    check(g.centred && Math.abs(g.pad - g.half) <= 1, 'the phone timeline is centred, with half a screen of room before the start', g);
    check(centred(g) && g.t === 0, 'at 0:00 the start of the video is on the line', g);
    await swipe(100000);
    await sleep(500);
    g = await geo();
    check(g.t > g.D - 0.6 && centred(g), 'scrolled all the way, the end of the video is on the line', g);

    console.log('\n=== [B] a swipe is a scrub ===');
    await swipe(-100000); await swipe(220);
    await sleep(500);
    g = await geo();
    const pps = await page.evaluate(() => window.VideoEditor.zoomLevel());
    check(centred(g) && Math.abs(g.t - 220 / pps) < 0.15, 'the picture shows whatever the swipe left under the line', { t: g.t, want: 220 / pps });
    const b0 = await geo();
    await page.evaluate(() => document.getElementById('vePlayer').play());
    await sleep(1500);
    const b1 = await geo();
    check(b1.t > b0.t + 0.8 && b1.scroll > b0.scroll + 8 && centred(b1), 'playing slides the clips under a still line', { b0, b1 });
    await swipe(-60);
    await sleep(400);
    check((await geo()).paused, 'taking the timeline while it plays stops it');

    console.log('\n=== [C] taps, handles, captions ===');
    const t0 = (await geo()).t;
    const seg = await page.locator('#veSegments .ve-seg').first().boundingBox();
    await page.touchscreen.tap(seg.x + Math.min(seg.width - 30, 260), seg.y + seg.height / 2);
    await sleep(500);
    check(await page.evaluate(() => !!document.querySelector('#veSegments .ve-seg.sel')), 'a tap on a clip selects it');
    check(Math.abs((await geo()).t - t0) < 0.05, 'and nothing moves');
    const hs = await page.evaluate(() => Array.from(document.querySelectorAll('#veSegments .ve-seg')).map((s) => ({ sel: s.classList.contains('sel'), h: getComputedStyle(s.querySelector('.ve-seg-h')).display })));
    check(hs.every((x) => (x.sel ? x.h !== 'none' : x.h === 'none')), 'trim handles show on the selected clip only', hs);
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.currentTime = 14; });
    await sleep(500);
    await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      const w = 'the lord is my shepherd i shall not want he makes me lie down'.split(' ').map((x, i) => ({ text: x, start: 12 + i * 0.6, end: 12 + i * 0.6 + 0.5 }));
      T.setCapWords(w, 0); T.setCapWordsPerLine(3); T.setCapCase('upper'); T.revealCaps();
    });
    await sleep(700);
    // (showing the captions takes the timeline to the first line: tap the one on screen)
    const ci = await page.evaluate(() => { const sc = document.getElementById('veTlScroll').getBoundingClientRect();
      const b = Array.from(document.querySelectorAll('#veCapTrack .ve-cap-clip')).find((n) => { const r = n.getBoundingClientRect(); return r.left >= sc.left && r.right <= sc.right && r.width > 60; });
      return b ? +b.dataset.i : -1; });
    const blk = page.locator(`#veCapTrack .ve-cap-clip[data-i="${ci}"]`);
    let bb = await blk.boundingBox();
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(400);
    const cs = await page.evaluate((ci) => ({ ci, sel: !!document.querySelector(`#veCapTrack .ve-cap-clip.sel[data-i="${ci}"]`), editing: !!document.querySelector('#veCapTrack .ve-cap-clip.editing') }), ci);
    check(cs.sel && !cs.editing, 'a first tap on a caption selects it without starting to type', cs);
    const before = await page.evaluate((ci) => window.VideoEditor.__test.capLines()[ci].end, ci);
    const hr = await page.locator(`#veCapTrack .ve-cap-clip[data-i="${ci}"] .ve-cc-h.r`).boundingBox();
    const hx = hr.x + hr.width / 2, hy = hr.y + hr.height / 2;
    const fireAt = (type, x, y) => page.evaluate(({ type, x, y }) => {
      const el = document.elementFromPoint(x, y) || document.body;
      const t = new Touch({ identifier: 3, target: el, clientX: x, clientY: y });
      (type === 'touchstart' ? el : document).dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t] }));
    }, { type, x, y });
    await fireAt('touchstart', hx, hy);
    for (let k = 1; k <= 6; k++) { await fireAt('touchmove', hx + k * 6, hy); await sleep(30); }
    await fireAt('touchend', hx + 36, hy);
    await sleep(400);
    check(await page.evaluate((ci) => window.VideoEditor.__test.capLines()[ci].end, ci) > before + 0.1, 'its handle trims it, on the phone');
    bb = await blk.boundingBox();
    await page.touchscreen.tap(bb.x + Math.min(20, bb.width / 3), bb.y + bb.height / 2);
    await sleep(400);
    check(await page.evaluate(() => !!document.querySelector('#veCapTrack .ve-cap-clip.editing')), 'a second tap types into it');
    await page.evaluate(() => { const l = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label'); if (l) { l.textContent = 'my shepherd is good'; l.blur(); } });
    await sleep(300);

    console.log('\n=== [E] the chosen Case ===');
    check(await page.evaluate((ci) => window.VideoEditor.__test.capLines()[ci].text, ci) === 'MY SHEPHERD IS GOOD', 'a line typed in lower case is saved in ALL CAPS when that is chosen');

    console.log('\n=== [D] what the review found ===');
    await page.evaluate(() => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect();
      const el = document.createElement('div'); el.style.cssText = 'position:absolute;left:0;top:0;width:50px;height:30px'; sc.appendChild(el);
      const t = new Touch({ identifier: 7, target: el, clientX: r.left + 20, clientY: r.top + 20 });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] }));
      el.remove();     // the lane redrew the block under the finger
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t], targetTouches: [] }));
    });
    await sleep(300);
    const d0 = await geo();
    await page.evaluate(() => document.getElementById('vePlayer').play());
    await sleep(1200);
    const d1 = await geo();
    await page.evaluate(() => document.getElementById('vePlayer').pause());
    check(d1.t > d0.t + 0.6 && d1.scroll > d0.scroll + 4 && centred(d1), 'a touch on a block the lane redrew does not stop the timeline following playback', { d0, d1 });
    await sleep(300);
    // a flick that is still coasting, then Play
    await page.evaluate(() => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect();
      const t = new Touch({ identifier: 9, target: sc, clientX: r.left + 120, clientY: r.top + 60 });
      sc.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] }));
      sc.scrollLeft += 40;
      sc.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t], targetTouches: [] }));
    });
    await sleep(60);
    await page.evaluate(() => document.getElementById('vePlayer').play());
    for (let k = 0; k < 4; k++) { await page.evaluate(() => { document.getElementById('veTlScroll').scrollLeft += 6; }); await sleep(40); }
    await sleep(800);
    check(!(await geo()).paused, 'Play during a coasting flick keeps playing');
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.pause(); });
    await sleep(300);
    // the same with the studio's own Play button, the coast stepping in the SAME frame (second review:
    // the media 'play' event comes later, and a coasting step before it paused the video again)
    const events = await page.evaluate(async () => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect(), p = document.getElementById('vePlayer');
      const seen = []; const on = (e) => seen.push(e.type); p.addEventListener('play', on); p.addEventListener('pause', on);
      const t = new Touch({ identifier: 11, target: sc, clientX: r.left + 120, clientY: r.top + 60 });
      sc.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] }));
      sc.scrollLeft += 40;
      sc.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t], targetTouches: [] }));
      await new Promise((res) => setTimeout(res, 60));
      document.getElementById('vePlay').click();
      sc.scrollLeft += 6; sc.dispatchEvent(new Event('scroll'));   // the coast, before 'play' arrives
      for (let k = 0; k < 4; k++) { await new Promise((res) => requestAnimationFrame(res)); sc.scrollLeft += 6; }
      await new Promise((res) => setTimeout(res, 600));
      p.removeEventListener('play', on); p.removeEventListener('pause', on);
      return { seen, paused: p.paused };
    });
    check(!events.paused && !events.seen.includes('pause'), 'tapping Play during a coasting flick keeps playing (no play-then-pause)', events);
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 12; });
    await sleep(400);
    await page.evaluate(() => { const f = document.getElementById('veZoomFit'); if (f) f.click(); });
    await sleep(500);
    g = await geo();
    check(Math.abs(g.t - 12) < 0.1 && centred(g), 'Fit keeps the video where it was, the line in the middle', g);
    await page.evaluate(() => { const E = window.VideoEditor; E.zoomAround(E.zoomLevel() * 2, 0, 10); });
    await sleep(400);
    g = await geo();
    check(Math.abs(g.t - 12) < 0.1 && centred(g), 'a pinch keeps the line on the same moment', g);
    const lp = await page.evaluate(async () => {
      const tk = document.getElementById('veTrack'), b = tk.getBoundingClientRect();
      const t0 = document.getElementById('vePlayer').currentTime;
      const x = b.left + b.width * 0.3, y = b.top + 3;
      const mk = (type, cx) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1 });
      tk.dispatchEvent(mk('mousedown', x));      // the touch bridge's long press: untrusted, like this
      for (let k = 1; k <= 5; k++) document.dispatchEvent(mk('mousemove', x + k * 12));
      const shown = getComputedStyle(document.getElementById('veSelbox')).display;
      document.dispatchEvent(mk('mouseup', x + 60));
      await new Promise((r) => setTimeout(r, 300));
      return { shown, moved: Math.abs(document.getElementById('vePlayer').currentTime - t0) };
    });
    check(lp.shown === 'block' && lp.moved < 0.05, 'a long press on empty track still draws a clip, without moving the line', lp);
    const still = await page.evaluate(async () => {
      const tk = document.getElementById('veTrack'), b = tk.getBoundingClientRect();
      const t0 = document.getElementById('vePlayer').currentTime;
      const x = b.left + b.width * 0.7, y = b.top + 3;
      const mk = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1 });
      tk.dispatchEvent(mk('mousedown'));                     // a long press that ends without moving (a slow tap)
      document.dispatchEvent(mk('mouseup'));
      await new Promise((r) => setTimeout(r, 300));
      return Math.abs(document.getElementById('vePlayer').currentTime - t0);
    });
    check(still < 0.05, 'a long press that lifts without moving does not jump the video there', still);
    const wide = await open({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const wg = await wide.evaluate(() => ({ centred: document.getElementById('veTlScroll').classList.contains('ve-centred'), pad: document.getElementById('veTlScroll').style.paddingLeft }));
    check(!wg.centred && !wg.pad, 'a wide screen keeps the desk\'s timeline', wg);
  } catch (e) {
    check(false, 'the test ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
