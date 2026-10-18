'use strict';
/*
 * SNAP CLOSES THE GAPS, AS CAPCUT DOES.
 * "There is a black gap on the left of the timeline because things are cut —
 *  they should all move to the left and close it when Snap is on." Checks, on
 * an iPhone-sized page, with a 40 s recording:
 *   [1] trimming the start of the video (its left handle, by finger) to 10 s:
 *       the clip is drawn from 0:00, the clock reads 0:00 / 0:30, and the
 *       picture is the first kept frame — not black
 *   [2] cutting 20-25 s out of the middle: the two pieces sit edge to edge,
 *       the clock's total is 0:25
 *   [3] playing across the join skips the cut footage
 *   [4] swiping the timeline: the place under the line is the right moment of
 *       the recording (15 s on the timeline = 30 s in)
 *   [5] Snap off: the gaps show again, where the footage was cut
 *   node test/phone-snap-gaps.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7465, CODE = 'snapgap-test-5514';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-snapgap-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
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
  const VID = path.join(MEDIA, 'service.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '15', '-c:a', 'libopus', '-shortest', VID]);
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
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1200);
    const cdp = await ctx.newCDPSession(page);
    const finger = async (x0, y, dx) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
      for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * k) / 12, y }] }); await sleep(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(500);
    };
    const st = () => page.evaluate(() => {
      const T = window.VideoEditor.__test, tr = document.getElementById('veTrack').getBoundingClientRect();
      const segs = [...document.querySelectorAll('#veSegments .ve-seg[data-id]')].map((n) => { const r = n.getBoundingClientRect(); return { id: n.dataset.id, x: Math.round(r.left - tr.left), r: Math.round(r.right - tr.left) }; }).sort((a, b) => a.x - b.x);
      const p = document.getElementById('vePlayer');
      return { snap: T.snapOn(), clips: T.segments().filter((s) => !s.lane).map((s) => ({ id: s.id, start: +s.start.toFixed(2), end: +s.end.toFixed(2) })), segs,
        clock: document.getElementById('veTime').textContent, t: p.currentTime, black: T.gapMaskVisible(), pps: window.VideoEditor.zoomLevel() };
    });
    let s = await st();
    check(s.snap, 'Snap is on to start with', s);

    console.log('\n=== [1] trim the start ===');
    const seg = await page.evaluate(() => { const r = document.querySelector('#veSegments .ve-seg[data-id]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.touchscreen.tap(seg.x + 40, seg.y + seg.h / 2);
    await sleep(400);
    const h = await page.evaluate(() => { const r = document.querySelector('#veSegments .ve-seg.sel .ve-seg-h.l').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await finger(h.x, h.y, 10 * s.pps);
    await sleep(600);
    s = await st();
    check(s.clips.length === 1 && Math.abs(s.clips[0].start - 10) < 1.6, 'the left handle trims the start to about 10 s', s.clips);
    check(s.segs[0].x <= 1, '…and the clip moves left to 0:00 — no black gap before it', s.segs);
    const fmtS = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
    check(s.clock === `0:00 / ${fmtS(40 - s.clips[0].start)}`, `the clock counts what is kept: 0:00 / ${fmtS(40 - s.clips[0].start)}`, s.clock);
    check(Math.abs(s.t - s.clips[0].start) < 0.3 && !s.black && s.t >= s.clips[0].start, 'the picture is the first kept frame, not black', { t: s.t, black: s.black });
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'snap-trimmed.png') });

    console.log('\n=== [2] cut a piece out of the middle ===');
    const start = s.clips[0].start;
    await page.evaluate(() => { const T = window.VideoEditor.__test; T.splitAt(20); T.splitAt(25); });
    await sleep(300);
    const mid = (await st()).clips.find((c) => Math.abs(c.start - 20) < 0.05);
    await page.evaluate((id) => window.VideoEditor.__test.deleteClip(id), mid.id);
    await sleep(600);
    s = await st();
    check(s.clips.length === 2 && s.segs.length === 2 && Math.abs(s.segs[1].x - s.segs[0].r) <= 2, 'the two pieces sit edge to edge (no gap between)', s.segs);
    const total = fmtS(40 - start - 5);
    check(s.clock.endsWith('/ ' + total), `the clock's total is what is kept (${total})`, s.clock);

    console.log('\n=== [3] play across the join ===');
    const seen = await page.evaluate(async () => {
      const p = document.getElementById('vePlayer'); p.currentTime = 19; await new Promise((r) => setTimeout(r, 300));
      const out = []; const pr = p.play(); if (pr && pr.catch) pr.catch(() => {});
      const t0 = performance.now();
      while (performance.now() - t0 < 2600) { out.push(p.currentTime); await new Promise((r) => setTimeout(r, 50)); }
      p.pause(); return out;
    });
    const inCut = seen.filter((t) => t > 20.4 && t < 24.9);
    check(seen[seen.length - 1] > 25 && inCut.length <= 6, 'playing skips the cut footage (20-25 s) and carries on after it', { last: seen[seen.length - 1], inCut: inCut.length });

    console.log('\n=== [4] a swipe lands on the right moment ===');
    await page.evaluate((pps) => { const sc = document.getElementById('veTlScroll');
      const gap = sc.clientWidth / 2; const pad = parseFloat(sc.style.paddingLeft) || 0;
      sc.scrollLeft = Math.max(0, pad + 15 * pps - gap); }, s.pps);
    await sleep(900);
    const want = start + 15 < 20 ? start + 15 : start + 15 + 5;
    const at = await page.evaluate(() => document.getElementById('vePlayer').currentTime);
    check(Math.abs(at - want) < 0.6, `15 s along the timeline is ${want.toFixed(1)} s into the recording`, { at, want });

    console.log('\n=== [5] Snap off ===');
    await page.evaluate(() => document.getElementById('veSnap').click());
    await sleep(600);
    s = await st();
    check(!s.snap && Math.abs(s.segs[0].x - start * s.pps) <= 3 && s.segs[1].x - s.segs[0].r > 4 * s.pps, 'Snap off: the gaps show again, where the footage was cut', { segs: s.segs, pps: s.pps });
    await page.evaluate(() => document.getElementById('veSnap').click());
    await sleep(600);
    s = await st();
    check(s.snap && s.segs[0].x <= 1, 'Snap on again: closed up again', s.segs);
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally {
    try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
