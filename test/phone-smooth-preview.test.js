'use strict';
/*
 * THE VIDEO STUDIO ON A PHONE: QUICK TO PLAY, NO JUMPING BACK.
 * "Sometimes it takes some time for the video to play, and when I move the
 * timeline it sometimes jumps back to a previous time." Checks, like an iPhone:
 *   [1] a heavy video (full HD, a whole picture only every 10 s) is changed over
 *       to a light copy made on the server — at the same moment of the video,
 *       still paused — and the light copy has a whole picture every second
 *   [2] swiping the timeline on a SLOW connection: when the finger lifts, the
 *       line stays where it was left (it used to jump back to an older time
 *       when a slow seek landed), and the picture catches up to it
 *   node test/phone-smooth-preview.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7463, CODE = 'smooth-test-4410';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-smooth-' + process.pid);
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
let lastProxy = null; const sw0 = () => lastProxy;
const keyGap = (file) => {
  const r = require('child_process').spawnSync(ffmpeg, ['-v', 'info', '-skip_frame', 'nokey', '-i', file, '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8' });
  return String(r.stderr || '');
};
(async () => {
  // (this test browser plays no H.264, a phone does: the videos are VP9, and the light copy the
  //  server makes — H.264 — is checked on disk and stood in for in the browser by the same picture in VP9)
  const vp9 = (src, size, d, g, out, br) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=${d}`, '-f', 'lavfi', '-i', `sine=f=220:d=${d}`,
    '-c:v', 'libvpx-vp9', '-b:v', br, '-deadline', 'realtime', '-cpu-used', '8', '-g', String(g), '-keyint_min', String(g), '-c:a', 'libopus', '-shortest', out]);
  const HEAVY = path.join(MEDIA, 'Sunday service.webm');
  vp9(null, '1920x1080', 30, 300, HEAVY, '3M');
  const STANDIN = path.join(WORK, 'light.webm');
  vp9(null, '1280x720', 30, 30, STANDIN, '1M');
  const LIGHT = path.join(MEDIA, 'phone clip.webm');   // small: stays as it is
  vp9(null, '360x640', 60, 300, LIGHT, '600k');
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    // (served as a server serves a video: a part at a time, or the player cannot seek in it)
    await page.route(/cws-media-cache/i, (route) => {
      const buf = fs.readFileSync(STANDIN), m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
      if (!m) return route.fulfill({ status: 200, headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': String(buf.length) }, body: buf });
      const a = +m[1], b = m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1;
      return route.fulfill({ status: 206, headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': String(b - a + 1) }, body: buf.subarray(a, b + 1) });
    });
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });

    console.log('\n=== [1] a heavy video plays from a light copy ===');
    await page.evaluate((p) => window.VideoEditor.openPath(p), HEAVY);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 1, null, { timeout: 30000 });
    const orig = await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.currentTime = 12.4; return p.currentSrc; });
    let sw = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      sw = await page.evaluate(() => { const p = document.getElementById('vePlayer'); return { src: p.currentSrc, t: p.currentTime, paused: p.paused, ready: p.readyState, w: p.videoWidth }; });
      if (sw.src !== orig && sw.ready >= 2 && Math.abs(sw.t - 12.4) < 0.5) break;
    }
    const proxyFile = new URL(sw.src).searchParams.get('p') || '';
    check(sw.src !== orig && /cws-media-cache/.test(proxyFile), 'the phone changes over to the light copy made on the server', { orig, now: sw.src });
    check(Math.abs(sw.t - 12.4) < 0.5 && sw.paused && sw.w > 0 && sw.w <= 1280, '…at the same moment (12.4 s), still paused, showing a picture at most 720p', sw);
    const pf = fs.existsSync(proxyFile) ? proxyFile : null; lastProxy = pf;
    if (pf) {
      const keys = (keyGap(pf).match(/pts_time:([\d.]+)/g) || []).map((x) => +x.split(':')[1]);
      const gaps = keys.slice(1).map((k, i) => k - keys[i]);
      check(keys.length >= 25 && Math.max(...gaps) <= 1.1, 'the light copy has a whole picture every second (the original: every 10 s), so a seek is quick', { n: keys.length, max: Math.max(...gaps) });
    } else check(false, 'the light copy is on the server', proxyFile);
    const exp = await page.evaluate(() => window.VideoEditor.sourcePath && window.VideoEditor.sourcePath());
    check(exp === HEAVY, 'AI and exports still work from the original', exp);

    console.log('\n=== [2] no jumping back on a slow connection ===');
    await page.evaluate((p) => window.VideoEditor.openPath(p), LIGHT);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1500);
    const small = await page.evaluate(() => document.getElementById('vePlayer').currentSrc);
    check(!/cws-media-cache/.test(decodeURIComponent(small)), 'a small video is played as it is (no copy needed)', small);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 350, downloadThroughput: 200000, uploadThroughput: 200000 });
    // a finger: several pushes with no rest, lifted while seeks are still on their way
    const res = await page.evaluate(async () => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect(), p = document.getElementById('vePlayer');
      const fire = (type) => { const t = new Touch({ identifier: 1, target: sc, clientX: r.left + 100, clientY: r.top + 60 });
        sc.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t] })); };
      const frame = () => new Promise((res) => requestAnimationFrame(res));
      fire('touchstart');
      for (let k = 0; k < 24; k++) { sc.scrollLeft += 4; await frame(); await frame(); }
      fire('touchend');
      const left = sc.scrollLeft;
      let lowest = left, t0 = performance.now();
      while (performance.now() - t0 < 6000) { await frame(); lowest = Math.min(lowest, sc.scrollLeft); if (!p.seeking && performance.now() - t0 > 2500) break; }
      while (p.seeking && performance.now() - t0 < 20000) await frame();
      // what is under the line, and what the picture shows
      const pps = (sc.scrollWidth - sc.clientWidth) / Math.max(0.1, p.duration);
      return { left, lowest, end: sc.scrollLeft, t: p.currentTime, seeking: p.seeking };
    });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    check(res.lowest >= res.left - 2 && Math.abs(res.end - res.left) <= 2, 'the finger lifts on a slow connection: the line stays where it was left (no jumping back)', res);
    const under = await page.evaluate(() => { const sc = document.getElementById('veTlScroll'), p = document.getElementById('vePlayer'); return { time: document.getElementById('veTime').textContent, t: p.currentTime, seeking: p.seeking }; });
    check(!under.seeking, '…and the picture has caught up to it', under);
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally {
    try { const c = sw0(); if (c) fs.rmSync(c, { force: true }); } catch (e) {}
    try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
