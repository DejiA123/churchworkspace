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
    console.log('\n[6] the size changes on the picture AS IT IS SLID — even while typing in the box');
    {
      const bb2 = await page.locator(`.ve-text-box[data-id="${id}"]`).boundingBox();
      await page.touchscreen.tap(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
      await sleep(400);
      await page.evaluate((id) => window.VideoEditor.__test.startEditingText ? window.VideoEditor.__test.startEditingText(id) : null, id);
      const bb3 = await page.locator(`.ve-text-box[data-id="${id}"]`).boundingBox();
      if (!(await page.evaluate(() => !!document.querySelector('.ve-text-box .ve-text-content[contenteditable="true"]')))) { await page.touchscreen.tap(bb3.x + bb3.width / 2, bb3.y + bb3.height / 2); await sleep(400); }
      const px = () => page.evaluate((id) => parseFloat(getComputedStyle(document.querySelector(`.ve-text-box[data-id="${id}"] .ve-text-content`)).fontSize), id);
      const editing = await page.evaluate(() => !!document.querySelector('.ve-text-box .ve-text-content[contenteditable="true"]'));
      const a0 = await px();
      await page.evaluate(() => { const r = document.getElementById('vtSizeRange'); r.value = '16'; r.dispatchEvent(new Event('input', { bubbles: true })); });
      await sleep(150);
      const a1 = await px();
      check(editing && a1 > a0 * 1.5, 'sliding the size while typing makes the words bigger right away (no waiting)', { editing, a0, a1 });
      await page.evaluate(() => { const n = document.getElementById('vtSize'); n.value = '10'; n.dispatchEvent(new Event('input', { bubbles: true })); });
      await sleep(150);
      const a2 = await px();
      check(a2 < a1, 'and so does typing a number in the size box', { a1, a2 });
      await page.locator('#vtDone').tap();
      await sleep(400);
    }
    console.log('\n[7] a text block picked on the TIMELINE leaves its handles free');
    {
      const clip = page.locator(`.ve-text-clip[data-id="${id}"]`);
      await clip.scrollIntoViewIfNeeded().catch(() => {});
      const cb = await clip.boundingBox();
      await page.evaluate((id) => { const el = document.querySelector(`.ve-text-clip[data-id="${id}"]`); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); }, id);
      await sleep(400);
      const lane = await st();
      const handle = await page.evaluate((id) => { const h = document.querySelector(`.ve-text-clip[data-id="${id}"] [data-tedge="r"], .ve-text-clip[data-id="${id}"] .ve-tc-h.r, .ve-text-clip[data-id="${id}"] .ve-tc-h`); if (!h) return null; const r = h.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { hit: !!(at && (at === h || h.contains(at))), y: Math.round(r.top) }; }, id);
      check(!lane.shown && cb, 'picking the block on the timeline does not bring the panel up over it', lane);
      check(handle && handle.hit, 'its trim handle is there to grab — nothing on top of it', handle);
      const bb4 = await page.locator(`.ve-text-box[data-id="${id}"]`).boundingBox();
      await page.touchscreen.tap(bb4.x + bb4.width / 2, bb4.y + bb4.height / 2);
      await sleep(400);
      check((await st()).shown, 'tapping the text on the picture brings the panel up');
      // ✓ puts the panel down but keeps the text picked: its block's handles are free
      await page.locator('#vtDone').tap();
      await sleep(400);
      const after = await st();
      const free = await page.evaluate((id) => { const h = document.querySelector(`.ve-text-clip[data-id="${id}"] [data-tedge="r"], .ve-text-clip[data-id="${id}"] .ve-tc-h`); if (!h) return null; const r = h.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(at && (at === h || h.contains(at))); }, id);
      check(!after.shown && free, '✓ puts the panel down and the block on the timeline can be stretched', { after, free });
      check(await page.evaluate(() => !!(window.VideoEditor.__test.textSel ? window.VideoEditor.__test.textSel() : document.querySelector('.ve-text-box.selected, .ve-text-box.sel'))), 'the text is still picked');
    }
    console.log('\n[8] the screen stays on while something is being made');
    {
      /*
       * An iPhone's rules, played by a stand-in lock (Chromium cannot prove
       * iOS — only that the page follows the rules WebKit's source sets): the
       * lock is granted only with a fresh tap, and after one grant, later asks
       * in the same page life go through without one.
       */
      await page.evaluate(() => {
        const fake = { sticky: false, asked: 0, live: 0,
          request() {
            fake.asked++;
            // (a real tap, seen by the page — Playwright's own evaluate() counts as a gesture to Chromium)
            const tapped = Date.now() - (window.__lastTap || 0) < 1000;
            if (!tapped && !fake.sticky) return Promise.reject(Object.assign(new Error('Permission was denied'), { name: 'NotAllowedError' }));
            fake.sticky = true; fake.live++;
            const ls = new Set();
            const s = { released: false, addEventListener: (t, f) => ls.add(f), release() { if (!s.released) { s.released = true; fake.live--; ls.forEach((f) => f()); } return Promise.resolve(); } };
            return Promise.resolve(s);
          } };
        window.__fakeLock = fake;
        ['click', 'touchend', 'pointerup'].forEach((t) => window.addEventListener(t, () => { window.__lastTap = Date.now(); }, true));
        Object.defineProperty(navigator, 'wakeLock', { value: fake, configurable: true });
        window.__awakeGrace(0);
      });
      const tap = async () => {
        await page.evaluate(() => { const d = document.createElement('div'); d.id = 'tapme'; d.style.cssText = 'position:fixed;left:40%;top:45%;width:20px;height:20px;z-index:2147483647'; document.body.appendChild(d); });
        await page.click('#tapme');
        await page.evaluate(() => document.getElementById('tapme').remove());
        await page.waitForTimeout(100);
      };
      const st = (ms = 150) => page.evaluate(async (w) => { await new Promise((r) => setTimeout(r, w)); return Object.assign(window.__awakeState(), { live: window.__fakeLock.live, asked: window.__fakeLock.asked }); }, ms);
      const a0 = await st(0);
      check(!a0.needed && !a0.lock, 'nothing running: the screen may sleep', a0);
      await page.evaluate(() => window.__keepAwake('t', true));
      const a1 = await st();
      check(a1.needed && !a1.lock && a1.err === 'NotAllowedError' && a1.note, 'work starts with no tap: refused, as an iPhone refuses — and the page says "tap the screen once"', a1);
      await tap();
      const a2 = await st();
      check(a2.lock && a2.live === 1 && !a2.note, 'one tap: the lock is held, the note goes', a2);
      await page.evaluate(() => window.__keepAwake('t', false));
      const a3 = await st();
      check(!a3.lock && a3.live === 0, 'done: it lets go', a3);
      await page.evaluate(() => window.__keepAwake('t', true));
      const a4 = await st();
      check(a4.lock && a4.live === 1, 'the next export, no tap needed: the first tap unlocked the later asks', a4);
      await page.evaluate(() => { window.__awakeGrace(1500); window.__keepAwake('t', false); });
      const a5 = await st(400);
      const a6 = await st(3700);   // (the grace, then the next 2-second check)
      check(a5.lock && !a6.lock && a6.live === 0, 'the pause between two shorts never drops it: held for a grace, then let go', { a5, a6 });
      await page.evaluate(() => window.__awakeGrace(0));
      const a7 = await page.evaluate(() => { window.__showOverlay('Exporting…'); const s = window.__awakeState(); window.__hideOverlay(); return s; });
      check(a7.needed, 'an export watched on the progress card counts too', a7);
      const n0 = await st(2200);
      check(!n0.lock && n0.live === 0 && !n0.note, 'and once it is over nothing is left holding the screen', n0);
      // no wake lock at all (a home-screen app before iOS 18.4): the video that WebKit does count
      await page.evaluate(() => { delete navigator.wakeLock; try { delete Navigator.prototype.wakeLock; } catch (e) {} window.__keepAwake('v', true); });
      await tap();
      const v1 = await st(400);
      // (this Chromium has no H.264 to play it with — what counts is that the tap started it, unmuted and not looping)
      check(v1.useVideo && v1.videoEl && (v1.video || v1.videoErr === 'NotSupportedError') && v1.videoErr !== 'NotAllowedError' && !v1.videoMuted && !v1.videoLoop,
        'the fallback video is started by the tap — not muted, not looping (WebKit ignores either)', v1);
      await page.evaluate(() => window.__keepAwake('v', false));
      const v2 = await st(300);
      const kept = await page.evaluate(() => !!document.querySelector('video[title="Keeping the screen on"]'));
      check(!v2.video && kept, 'done: it pauses but stays, so the next export needs no new tap', { v2, kept });
      await page.evaluate(() => window.__awakeGrace());
    }
    console.log('\n[9] a short recorded for a server batch sends its caption pictures ahead (no white screen)');
    {
      const r = await page.evaluate(async () => {
        const T = window.VideoEditor.__test;
        window.__mwBatch.begin({ width: 1080, height: 1920, durationSec: 4, hasAudio: true, fps: 24 });
        try {
          const tr = await T.capTrackFor([{ start: 0, end: 2, text: 'Hello church' }, { start: 2, end: 4, text: 'God is good' }], 1080, 1920, 4);
          return { id: tr && tr.trackId, keep: tr && tr.keep, inline: tr ? tr.frames.filter((f) => f.png).length : -1, refs: tr ? tr.frames.filter((f) => f.ref != null).length : -1 };
        } finally { window.__mwBatch.end(); }
      });
      check(r.id && r.keep && r.inline === 0 && r.refs > 0, 'the pictures went to the server; the recipe only names them', r);
    }
  } catch (e) { check(false, 'the test ran to the end', e.message); }
  finally { await browser.close(); srv.kill(); fs.rmSync(WORK, { recursive: true, force: true }); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
