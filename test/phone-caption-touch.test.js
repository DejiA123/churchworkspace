'use strict';
/*
 * "WHEN MY FINGER IS ON TOP OF THE CAPTIONS, THE CAPTION BLOCK SHORTENS BY
 *  ITSELF OR REMOVES ITSELF" — real Chromium touch input (CDP), as an iPhone.
 *
 * Every way a finger meant to look or scroll can land on a caption — a quick
 * swipe, a resting finger then a swipe, a finger resting while the video plays,
 * a catch while the timeline coasts, a second finger arriving, a slow start —
 * must leave every caption exactly where it was. And the deliberate ways still
 * work, CapCut's way: tap to select, then drag its handle (trim) or hold it half
 * a second and drag (move) — each one Undo away.
 *
 *   node test/phone-caption-touch.test.js
 */
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(path.join(ROOT, 'node_modules/ffmpeg-static'));
const PORT = 7384, CODE = 'captouch-test-5821';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-captouch-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }

(async () => {
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1000);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, k) => ({ x: p.x, y: p.y, id: p.id == null ? k : p.id, radiusX: 4, radiusY: 4, force: 1 })) });

    const setup = async () => {
      await page.evaluate(() => {
        const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 14;
        const T = window.VideoEditor.__test;
        const w = 'the lord is my shepherd i shall not want he makes me lie down in green pastures he leads me beside still waters'.split(' ').map((x, i) => ({ text: x, start: 12 + i * 0.6, end: 12 + i * 0.6 + 0.5 }));
        const E = window.VideoEditor; if (E.zoomAround) E.zoomAround(100, 14, 195);
        T.setCapWords(w, 0); T.setCapWordsPerLine(3); T.setCapCase('upper'); T.revealCaps();
      });
      await sleep(800);
      // start each scenario with nothing selected
      await page.evaluate(() => { document.querySelectorAll('#veCapTrack .ve-cap-clip.sel').forEach((n) => n.classList.remove('sel')); });
    };
    const lines = () => page.evaluate(() => window.VideoEditor.__test.capLines().map((c) => [+c.start.toFixed(2), +c.end.toFixed(2)]));
    const state = () => page.evaluate(() => ({ scroll: document.getElementById('veTlScroll').scrollLeft, sel: [...document.querySelectorAll('#veCapTrack .ve-cap-clip.sel')].map((n) => +n.dataset.i), editing: !!document.querySelector('#veCapTrack .ve-cap-clip.editing') }));
    const onScreenBlock = () => page.evaluate(() => { const sc = document.getElementById('veTlScroll').getBoundingClientRect();
      const bs = Array.from(document.querySelectorAll('#veCapTrack .ve-cap-clip')).filter((n) => { const r = n.getBoundingClientRect(); return r.left >= sc.left + 20 && r.right <= sc.right - 20 && r.width > 60; });
      const n = bs[0]; if (!n) return null; const r = n.getBoundingClientRect(); return { i: +n.dataset.i, x: r.left, y: r.top, w: r.width, h: r.height }; });
    const diff = (a, b) => a.map((x, k) => (b[k] && (x[0] !== b[k][0] || x[1] !== b[k][1])) ? { k, before: x, after: b[k] } : null).filter(Boolean);
    const swipe = async (x, y, dx, holdMs, steps = 10, stepMs = 16) => {
      await touch('touchStart', [{ x, y }]);
      if (holdMs) await sleep(holdMs);
      for (let k = 1; k <= steps; k++) { await touch('touchMove', [{ x: x + dx * k / steps, y }]); await sleep(stepMs); }
      await touch('touchEnd', []);
      await sleep(500);
    };
    // a scenario that must change NOTHING
    const still = async (name, fn) => {
      await setup();
      const b = await onScreenBlock(); if (!b) { check(false, name + ': a caption on screen to touch'); return; }
      const L0 = await lines();
      await fn(b);
      const L1 = await lines(), s1 = await state();
      const changed = diff(L0, L1);
      check(!changed.length && L0.length === L1.length && !s1.editing, name + ' — no caption changes', { changed, editing: s1.editing });
    };
    const undo = () => page.evaluate(() => { const u = document.getElementById('veUndo'); if (u && !u.disabled) u.click(); });
    const tapSel = async (b) => { await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2); await sleep(600); };


    console.log('\n[A] a finger meant to look or scroll changes nothing');
    await still('a quick swipe that starts on a caption', (b) => swipe(b.x + b.w / 2, b.y + b.h / 2, -150, 0));
    await still('a finger that rests on a caption, then swipes', (b) => swipe(b.x + b.w / 2, b.y + b.h / 2, -150, 500));
    await still('a finger that rests, then swipes the other way', (b) => swipe(b.x + b.w / 2, b.y + b.h / 2, 120, 400));
    await still('a selected line, then a quick swipe from its middle', async (b) => { await tapSel(b); await swipe(b.x + b.w / 2, b.y + b.h / 2, -150, 0); });
    await still('a finger resting on a caption while the video PLAYS, then a swipe', async () => {
      await page.evaluate(() => document.getElementById('vePlayer').play()); await sleep(300);
      const nb = await onScreenBlock();
      if (nb) await swipe(nb.x + nb.w / 2, nb.y + nb.h / 2, -150, 600);
      await page.evaluate(() => document.getElementById('vePlayer').pause());
    });
    await still('a second finger arriving on a held caption (a pinch), then a tap elsewhere', async (b) => {
      const x = b.x + b.w / 2, y = b.y + b.h / 2;
      await touch('touchStart', [{ x, y, id: 1 }]); await sleep(550);
      await touch('touchStart', [{ x, y, id: 1 }, { x: x + 80, y, id: 2 }]);
      await touch('touchMove', [{ x, y, id: 1 }, { x: x + 120, y, id: 2 }]);
      await touch('touchEnd', [{ x, y, id: 1 }]); await touch('touchEnd', []); await sleep(300);
      await page.touchscreen.tap(60, 200); await sleep(300);
    });
    await still('a selected line caught by its edge while the timeline is still coasting', async (b) => {
      await tapSel(b);
      await page.evaluate(() => { document.getElementById('veTlScroll').scrollLeft += 4; });
      await sleep(60);
      const nb = await page.evaluate((i) => { const r = document.querySelector(`#veCapTrack .ve-cap-clip[data-i="${i}"]`).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, b.i);
      await swipe(nb.x + nb.w - 3, nb.y + nb.h / 2, -100, 0);
    });
    await still('a selected line held while the video PLAYS, then a swipe', async (b) => {
      await tapSel(b);
      await page.evaluate(() => document.getElementById('vePlayer').play()); await sleep(200);
      const nb = await page.evaluate((i) => { const n = document.querySelector(`#veCapTrack .ve-cap-clip[data-i="${i}"]`); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, b.i);
      if (nb) await swipe(nb.x + nb.w / 2, nb.y + nb.h / 2, -150, 650);
      await page.evaluate(() => document.getElementById('vePlayer').pause());
    });
    await still('a slow start from a caption that then speeds up', async (b) => {
      const x = b.x + b.w / 2, y = b.y + b.h / 2;
      await touch('touchStart', [{ x, y }]);
      for (let k = 1; k <= 8; k++) { await touch('touchMove', [{ x: x - k, y }]); await sleep(60); }
      for (let k = 1; k <= 10; k++) { await touch('touchMove', [{ x: x - 8 - k * 15, y }]); await sleep(16); }
      await touch('touchEnd', []); await sleep(500);
    });
    await still('a selected line held still and let go (no typing, no change)', async (b) => {
      await tapSel(b);
      await touch('touchStart', [{ x: b.x + b.w / 2, y: b.y + b.h / 2 }]); await sleep(700); await touch('touchEnd', []); await sleep(400);
    });

    console.log('\n[B] the deliberate ways still work, and Undo puts them back');
    {
      await setup();
      const b = await onScreenBlock();
      const L0 = await lines();
      await tapSel(b);
      await swipe(b.x + b.w - 3, b.y + b.h / 2, 60, 0);
      const L1 = await lines();
      check(L1[b.i][1] > L0[b.i][1] + 0.1 && L1[b.i][0] === L0[b.i][0], 'tap to select, then drag its right handle: the line gets longer', { before: L0[b.i], after: L1[b.i] });
      await undo(); await sleep(300);
      const L2 = await lines();
      check(JSON.stringify(L2[b.i]) === JSON.stringify(L0[b.i]), '…and Undo puts it back', { before: L0[b.i], after: L2[b.i] });
    }
    {
      await setup();
      const b = await onScreenBlock();
      const L0 = await lines();
      await tapSel(b);
      await swipe(b.x + b.w / 2, b.y + b.h / 2, 60, 700);
      const L1 = await lines();
      const d0 = L0[b.i][1] - L0[b.i][0], d1 = L1[b.i][1] - L1[b.i][0];
      check(L1[b.i][0] > L0[b.i][0] + 0.1 && Math.abs(d1 - d0) < 0.02, 'tap to select, hold half a second, drag: the line moves, the same length', { before: L0[b.i], after: L1[b.i] });
      await undo(); await sleep(300);
      const L2 = await lines();
      check(JSON.stringify(L2[b.i]) === JSON.stringify(L0[b.i]), '…and Undo puts it back', { before: L0[b.i], after: L2[b.i] });
    }
  } catch (e) { check(false, 'the test ran to the end', e.message); }
  finally { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
