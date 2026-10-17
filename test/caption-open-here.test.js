'use strict';
/*
 * THE CAPTIONS WINDOW OPENS WHERE YOU ARE — in a real browser, on the real
 * Cloud Studio, the way an iPhone uses it.
 *
 * "Wherever I am on the video timeline and I click the captions editor, the
 *  captions editor caption line should be where I am on the video timeline,
 *  not at the start." At 6:14 on the timeline the window opened on its first
 * line, and the cursor going there took the playhead back to 1:08. Now:
 *   [A] opened with the playhead in the middle, it is on the line being spoken
 *       there — the cursor in it, the row in sight — and the playhead stays
 *       with that line (not back at the first one)
 *   [B] somewhere else, the same: it follows the playhead every time
 *   [C] opened while the video plays, it is on the line being heard
 *   [D] the playhead in a pause between lines: the nearest line
 *
 * Needs Playwright with Chromium (not one of the app's dependencies); without
 * it this says so and skips.
 *
 *   node test/caption-open-here.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the captions window was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7402;
const CODE = 'caphere-test-6114';
const WORK = path.join(os.tmpdir(), 'mw-cap-here-' + process.pid);
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
  const VID = path.join(MEDIA, 'here.webm');
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
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1000);
    // 20 lines of 3 words: line k from 0.3 + 1.8k to 2.0 + 1.8k (a 0.1 s pause between lines)
    await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      const base = 'glory to god hallelujah glory to god we just want to thank god for giving us that big opportunity to praise him today'.split(' ');
      const w = []; for (let i = 0; i < 60; i++) w.push({ text: base[i % base.length], start: 0.3 + i * 0.6, end: 0.3 + i * 0.6 + 0.5 });
      T.setCapWords(w, 0); T.setCapWordsPerLine(3); T.revealCaps();
      window.api.captions.engineInfo = async () => ({ available: true });
    });
    await sleep(500);
    const lineOf = (t) => Math.floor((t - 0.3) / 1.8);
    // where the window is: the line with the cursor, whether its row is in sight, where the playhead is
    const st = () => page.evaluate(() => {
      const a = document.activeElement;
      const list = document.getElementById('capList');
      const row = a && a.closest && a.closest('.cap-row');
      let inSight = false;
      if (row && list) { const r = row.getBoundingClientRect(), l = list.getBoundingClientRect(); inSight = r.top >= l.top - 1 && r.bottom <= l.bottom + 1; }
      return { open: !document.getElementById('capModal').classList.contains('hidden'), i: a && a.classList && a.classList.contains('cap-text') ? +a.dataset.i : null,
        inSight, scrolled: list ? Math.round(list.scrollTop) : 0, t: document.getElementById('vePlayer').currentTime, paused: document.getElementById('vePlayer').paused };
    });
    const openAt = async (t, play) => {
      await page.evaluate(() => { const x = document.getElementById('capClose'); if (x && !document.getElementById('capModal').classList.contains('hidden')) x.click(); });
      await sleep(300);
      await page.evaluate(async ({ t, play }) => {
        const p = document.getElementById('vePlayer');
        p.pause(); p.currentTime = t;
        await new Promise((r) => { if (!p.seeking) r(); else p.addEventListener('seeked', r, { once: true }); });
        if (play) await p.play();
      }, { t, play });
      await sleep(play ? 600 : 300);
      const from = await page.evaluate(() => document.getElementById('vePlayer').currentTime);
      await page.evaluate(() => window.VideoEditor.__test.openCaptionsWindow());
      await sleep(900);
      return { from, s: await st() };
    };

    console.log('\n=== [A] opened in the middle: the line being spoken there ===');
    let { from, s } = await openAt(25.0);
    check(s.open && s.i === lineOf(25.0), `at 0:25 it opens on line ${lineOf(25.0)} (the one on the picture), not the first`, { from, s });
    check(s.inSight && s.scrolled > 0, 'that line is in sight (the list scrolled to it)', s);
    check(Math.abs(s.t - (0.3 + 1.8 * lineOf(25.0))) < 0.15, 'and the playhead stays with that line — not back at the first line', { t: s.t });

    console.log('\n=== [B] somewhere else: it follows the playhead every time ===');
    ({ from, s } = await openAt(3.0));
    check(s.i === lineOf(3.0) && s.inSight, `at 0:03 it opens on line ${lineOf(3.0)}`, { from, s });
    ({ from, s } = await openAt(35.0));
    check(s.i === 19 && s.inSight, 'at 0:35 it opens on the last line (19), at the end of the list', { from, s });
    ({ from, s } = await openAt(37.5));
    check(s.i === 19, 'after the last line (it ends at 0:36.2), still the last line — the nearest', { from, s });

    console.log('\n=== [C] opened while it plays: the line being heard ===');
    ({ from, s } = await openAt(14.0, true));
    check(s.i === lineOf(from) || s.i === lineOf(from) + 1, `playing (at ${from.toFixed(1)} s) it opens on the line being heard`, { from, s });

    console.log('\n=== [D] in a pause between lines: the nearest line ===');
    ({ from, s } = await openAt(9.24));   // line 4 is 7.5–9.2, line 5 starts at 9.3
    check(s.i === 4 || s.i === 5, 'in the 0.1 s pause after line 4, it opens on line 4 or 5 (the nearest)', { from, s });
    ({ from, s } = await openAt(0.05));
    check(s.i === 0, 'before the first line, the first line', { from, s });
  } catch (e) {
    check(false, 'ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
