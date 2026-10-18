'use strict';
/*
 * The Video Studio's 🎵 Music sheet on a phone has a FREE MUSIC tab: Mixkit's
 * lo-fi, upbeat, worship… songs (freemusic.js), by mood. Checks:
 *   - the tab is there, opens on 🎧 Lo-fi first, every mood has songs
 *   - ▶ fetches the song (once) and plays it
 *   - Use puts it under the video (the music lane) and it lands in My music
 *   - a mood chip switches the list
 * A stand-in Mixkit serves the songs (MW_FREE_LIVE=1 uses the real one).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the free music tab was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7447, MPORT = 7448;
const CODE = 'freemusic-test-3310';
const LIVE = process.env.MW_FREE_LIVE === '1';
const WORK = path.join(os.tmpdir(), 'mw-free-studio-' + process.pid);
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
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=12', '-f', 'lavfi', '-i', 'sine=f=220:d=12',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const SONG = path.join(WORK, 'song.mp3');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=30', '-c:a', 'libmp3lame', '-b:a', '64k', SONG]);
  const hits = [];
  const mixkit = http.createServer((req, res) => {
    hits.push(req.method + ' ' + req.url);
    if (!/^\/music\/\d+\/\d+\.mp3$/.test(req.url)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    if (req.method === 'HEAD') return res.end();
    res.end(fs.readFileSync(SONG));
  });
  if (!LIVE) await new Promise((r) => mixkit.listen(MPORT, '127.0.0.1', r));
  const env = Object.assign({}, process.env, LIVE ? {} : { MW_FREE_MUSIC_BASE: `http://127.0.0.1:${MPORT}/music/` });
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore', env });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { mixkit.close(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await sleep(1500);
    await page.evaluate(() => document.getElementById('veMusic').click());
    await sleep(600);
    await page.locator('#libModal [data-libtab="free"]').tap();
    let s = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      s = await page.evaluate(() => ({
        moods: [...document.querySelectorAll('#libFreeMoods [data-freemood]')].map((b) => b.textContent),
        on: (document.querySelector('#libFreeMoods .lib-chip.on') || {}).textContent || '',
        rows: [...document.querySelectorAll('#libFreeList [data-freeid]')].map((r) => r.querySelector('b').textContent),
        sub: (document.getElementById('libSub') || {}).textContent || '',
      }));
      if (s.rows.length) break;
    }
    check(s.moods.length === 8 && s.moods.some((m) => /Sermon/.test(m)) && s.moods.some((m) => /Prayer/.test(m)) && /Lo-fi/.test(s.on) && s.rows.includes('Lo-Fi 01'), 'the Free music tab opens on 🎧 Lo-fi, with its songs (and eight moods, 🎹 Sermon and 🕯 Prayer among them)', s);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'studio-free-music.png') });
    // ♥ a favourite: hearted, it gets a Favourites chip of its own (first), and is kept on the device
    await page.locator('#libFreeList [data-freefav="mk764"]').tap();
    await sleep(400);
    let fv = await page.evaluate(() => ({ chips: [...document.querySelectorAll('#libFreeMoods [data-freemood]')].map((b) => b.dataset.freemood),
      on: !!document.querySelector('#libFreeList [data-freefav="mk764"].on'), saved: localStorage.getItem('mw-free-favs') }));
    check(fv.on && fv.chips[0] === '__fav' && /mk764/.test(fv.saved || ''), '♡ on a song hearts it: a ♥ Favourites chip comes first', fv);
    await page.locator('#libFreeMoods [data-freemood="__fav"]').tap();
    await sleep(300);
    fv = await page.evaluate(() => [...document.querySelectorAll('#libFreeList [data-freeid]')].map((r) => r.querySelector('b').textContent));
    check(fv.length === 1 && fv[0] === 'Lo-Fi 02', '♥ Favourites lists the hearted songs', fv);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'studio-favs.png') });
    await page.locator('#libFreeList [data-freefav="mk764"]').tap();
    await sleep(300);
    fv = await page.evaluate(() => ({ empty: (document.querySelector('#libFreeList .lib-empty') || {}).textContent || '', saved: localStorage.getItem('mw-free-favs') }));
    check(/Tap the ♡/.test(fv.empty) && !/mk764/.test(fv.saved || ''), '♥ again takes it out (and says how to add one)', fv);
    await page.locator('#libFreeMoods [data-freemood="lofi"]').tap();
    await sleep(300);
    const sermon = await page.evaluate(async () => { const F = await window.api.freeMusic.list(false); return F.tracks.filter((t) => t.mood === 'sermon').map((t) => t.title); });
    check(sermon.length >= 25 && !sermon.includes('Pilates and Yoga') && sermon.includes('Silent Descent'), 'the sermon shelf is bigger — and Pilates and Yoga is gone', sermon.length);
    // ▶ fetches it once and plays it
    await page.locator('#libFreeList [data-freeplay="mk763"]').tap();
    let p = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      p = await page.evaluate(() => { const a = document.getElementById('veMusicAudio'); return { paused: a.paused, t: a.currentTime, playing: !!document.querySelector('#libFreeList [data-freeplay="mk763"].playing') }; });
      if (!p.paused && p.t > 0.5) break;
    }
    check(!p.paused && p.t > 0.5 && p.playing, '▶ fetches the song and plays it', p);
    await page.locator('#libFreeList [data-freeplay="mk763"]').tap();
    await sleep(300);
    check(await page.evaluate(() => document.getElementById('veMusicAudio').paused), '…and ▶ again stops it');
    // Use: under the video, and kept in My music
    await page.locator('#libFreeList [data-freeuse="mk763"]').tap();
    let u = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      u = await page.evaluate(async () => ({ use: (document.querySelector('#libFreeList [data-freeuse="mk763"]') || {}).textContent || '',
        bar: (document.getElementById('libChosenName') || {}).textContent || '', lib: (await window.api.library.list()).music.map((m) => m.name + '|' + m.source) }));
      if (/In use/.test(u.use)) break;
    }
    check(/In use/.test(u.use) && /Lo-Fi 01/.test(u.bar), 'Use puts it under the video', u);
    check(u.lib.length === 1 && /^Lo-Fi 01.*Lily J\|free:mk763$/.test(u.lib[0]), 'it is fetched ONCE into My music (listening and using share it)', u.lib);
    if (!LIVE) check(hits.filter((h) => /^GET /.test(h)).length === 1, 'the stand-in Mixkit was asked for the file once', hits.filter((h) => /^GET /.test(h)));
    // ── the song on the timeline is a clip too: tap it, trim its ends, move it (a finger, as on an iPhone)
    await page.evaluate(() => document.getElementById('libClose') && document.getElementById('libClose').click());
    await sleep(500);
    const cdp = await ctx.newCDPSession(page);
    const finger = async (x0, y, dx, hold) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
      if (hold) await sleep(hold);
      for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * k) / 12, y }] }); await sleep(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(400);
    };
    const T = () => page.evaluate(() => window.VideoEditor.__test.music());
    const box = (sel) => page.evaluate((q) => { const n = document.querySelector(q); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, d: getComputedStyle(n).display }; }, sel);
    await page.evaluate(() => { document.getElementById('veTlScroll').scrollLeft = 0; });
    await sleep(400);
    let mb = await box('.ve-music-seg');
    await page.touchscreen.tap(mb.x + 60, mb.y + mb.h / 2);
    await sleep(400);
    let st = await T(), lh = await box('.ve-music-seg .ve-music-h.l');
    check(st && st.sel && lh && lh.d !== 'none', 'a tap on the song picks it: white handles at its ends', { st, lh });
    // the left handle 2 s later: it comes in at 2 s, and from 2 s into the song
    const pps = await page.evaluate(() => window.VideoEditor.zoomLevel());
    await finger(lh.x + lh.w / 2, lh.y + lh.h / 2, 2 * pps);
    st = await T();
    check(!st.bed && Math.abs(st.tlStart - 2) < 0.3 && Math.abs(st.srcStart - st.tlStart) < 0.01 && Math.abs(st.tlStart + st.len - 12) < 0.3,
      'dragging its start in: the song comes in at 2 s (and the rest stays where it was)', { st, pps });
    // the right handle 3 s earlier: it now stops at about 9 s
    await page.evaluate(() => { document.getElementById('veTlScroll').scrollLeft = 1e6; });
    await sleep(400);
    const rh = await box('.ve-music-seg .ve-music-h.r');
    await finger(rh.x + rh.w / 2, rh.y + rh.h / 2, -3 * pps);
    st = await T();
    check(Math.abs(st.tlStart + st.len - 9) < 0.3 && Math.abs(st.tlStart - 2) < 0.3, 'dragging its end in: it stops at 9 s', st);
    // the preview hears what the export will: nothing before 2 s or after 9 s
    const hear = await page.evaluate(() => [1, 3, 8.5, 10].map((t) => window.VideoEditor.__test.musicPosAt(t)));
    check(hear[0] == null && hear[1] != null && Math.abs(hear[1] - 3) < 0.3 && hear[2] != null && hear[3] == null, 'the preview plays it only from 2 s to 9 s', hear);
    const ex = await page.evaluate(() => window.VideoEditor.__test.musicExportFor(0, 12));
    check(ex && Math.abs(ex.delaySec - 2) < 0.3 && Math.abs(ex.durSec - 7) < 0.3 && Math.abs(ex.startSec - 2) < 0.3, '…and the export brings it in at 2 s for 7 s', ex);
    // hold it and slide it: the whole song moves 1 s later
    await page.evaluate(() => { document.getElementById('veTlScroll').scrollLeft = 0; });
    await sleep(400);
    mb = await box('.ve-music-seg');
    const before = await T();
    await finger(mb.x + Math.min(mb.w / 2, 80), mb.y + mb.h / 2, 1 * pps, 600);
    st = await T();
    check(Math.abs(st.tlStart - before.tlStart - 1) < 0.3 && Math.abs(st.len - before.len) < 0.01, 'held and slid, the whole song moves along (its length kept)', { before, st });
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'studio-music-trim.png') });
    await page.evaluate(() => document.getElementById('veMusic').click());
    await sleep(500);
    await page.locator('#libModal [data-libtab="free"]').tap();
    await sleep(300);
    await page.locator('#libFreeMoods [data-freemood="upbeat"]').tap();
    await sleep(300);
    const up = await page.evaluate(() => [...document.querySelectorAll('#libFreeList [data-freeid]')].map((r) => r.querySelector('b').textContent));
    check(up.includes('Upbeat Jazz') && !up.includes('Lo-Fi 01'), 'a mood chip switches the list (☀️ Upbeat: "Upbeat Jazz"…)', up);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'studio-free-upbeat.png') });
    // a NEW project starts with no music — the last one's song does not carry over…
    const VID2 = path.join(MEDIA, 'second.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=360x640:r=15:d=8', '-f', 'lavfi', '-i', 'sine=f=330:d=8',
      '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID2]);
    await page.evaluate(() => document.getElementById('libClose') && document.getElementById('libClose').click());
    const first = await page.evaluate(() => window.VideoEditor.flushProject());
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID2);
    await sleep(1500);
    const fresh = await page.evaluate(() => ({ btn: document.getElementById('veMusic').textContent, lane: (document.getElementById('veMusicTrack') || {}).textContent || '' }));
    check(/^🎵 Music$/.test(fresh.btn.trim()) && /No background music/.test(fresh.lane), 'a new project starts with NO background music (the last song does not carry over)', fresh);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await sleep(1500);
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID2);
    await sleep(1500);
    check(/^🎵 Music$/.test(await page.evaluate(() => document.getElementById('veMusic').textContent.trim())), '…not even after the app is opened again');
    // …and the project it was chosen in still has it
    check(!!first, 'the first project was saved', first);
    await page.evaluate((id) => window.VideoEditor.openProject(id), first);
    await sleep(2000);
    const back = await page.evaluate(() => document.getElementById('veMusic').textContent.trim());
    check(/Lo-Fi 01/.test(back), 'the first project, opened again, still has its song', back);
    // 🕯 Prayer: worship pads the studio makes itself, in every key
    await page.evaluate(() => document.getElementById('veMusic').click());
    await sleep(600);
    await page.locator('#libFreeMoods [data-freemood="prayer"]').tap();
    await sleep(300);
    const pads = await page.evaluate(() => [...document.querySelectorAll('#libFreeList [data-freeid]')].map((r) => r.querySelector('b').textContent));
    check(pads.filter((t) => / Worship Pad in /.test(t)).length === 24 && pads.includes('Warm Worship Pad in C') && pads.includes('Shimmer Worship Pad in F#'),
      'Prayer has worship pads in every key, Warm and Shimmer', pads.length);
    await page.locator('#libFreeList [data-freeuse="pad-c-warm"]').tap();
    let pad = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      pad = await page.evaluate(async () => ({ use: (document.querySelector('#libFreeList [data-freeuse="pad-c-warm"]') || {}).textContent || '',
        lib: (await window.api.library.list()).music.filter((m) => m.source === 'free:pad-c-warm').map((m) => ({ name: m.name, d: m.durationSec })) }));
      if (/In use/.test(pad.use)) break;
    }
    check(/In use/.test(pad.use) && pad.lib.length === 1 && pad.lib[0].name === 'Warm Worship Pad in C' && Math.abs(pad.lib[0].d - 180) < 3,
      'Use makes the pad on the server (3 minutes) and puts it under the video', pad);
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally { await done(); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
