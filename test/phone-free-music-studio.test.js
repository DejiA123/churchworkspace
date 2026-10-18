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
    check(s.moods.length === 7 && s.moods.some((m) => /Sermon/.test(m)) && /Lo-fi/.test(s.on) && s.rows.includes('Lo-Fi 01'), 'the Free music tab opens on 🎧 Lo-fi, with its songs (and seven moods, 🎹 Sermon among them)', s);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'studio-free-music.png') });
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
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally { await done(); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
