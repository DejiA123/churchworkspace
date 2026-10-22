'use strict';
/*
 * MUTE VIDEO: "I am unable to mute the audio voice in the video studio … some
 * viral videos I want the voices muted and I would just let the music play."
 * On an iPhone the preview kept the voices (Safari ignores a video's volume),
 * and Mute in Volume changed one clip of the dozens a Viral montage is made of.
 *   [1] Sound › Mute video: one tap, every clip at 0%, and the screen shows it
 *   [2] the preview is silent on every clip (muted — the switch an iPhone obeys)
 *   [3] tapped again, each clip gets back its own volume
 *   [4] Undo takes it back
 *   [5] the exported video is silent where the voice was
 *
 *   node test/phone-mute-video.test.js        (MW_SHOTS=dir for screenshots)
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7421, CODE = 'mute-test-5821';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const onTop = (r) => r && !r.filesHidden && r.grid.every((g) => /cloudFilesModal/.test(g));
const WORK = path.join(os.tmpdir(), 'mw-mute-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }

(async () => {
  // 9 s with a voice-like tone all through it
  const VID = path.join(MEDIA, 'talk.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=9', '-f', 'lavfi', '-i', 'sine=f=220:d=9', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
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
    await page.waitForFunction((p) => window.VideoEditor.sourcePath() === p, VID, { timeout: 30000 });
    await sleep(800);
    // a montage is many clips: three here, one at 150%
    await page.evaluate(() => { const E = window.VideoEditor.__test; E.splitAt(3); E.splitAt(6); });
    await page.evaluate(() => { const E = window.VideoEditor.__test; E.seekTo(4.5); E.openFx('volume'); E.fxScope('clip'); E.setClipFx('vol', 1.5); E.closeFx(); });
    let st = await page.evaluate(() => ({ fx: window.VideoEditor.__test.clipFx(), muted: window.VideoEditor.videoMuted() }));
    const loud = st.fx.findIndex((f) => f && f.vol === 1.5);
    check(st.fx.length === 3 && loud >= 0 && st.fx.filter(Boolean).length === 1 && !st.muted, 'set up: three clips, one of them at 150%', st);
    // [1] the phone: Sound › Mute video
    await page.evaluate(() => { const b = [...document.querySelectorAll('#cloudDock .cloud-dock-row.on .cloud-tool')].find((x) => /Sound/.test(x.textContent)); if (b) b.click(); });
    await sleep(300);
    const tool = await page.evaluate(() => { const r = document.querySelector('#cloudDock .cloud-dock-row.on'); const b = r && [...r.querySelectorAll('.cloud-tool')].find((x) => /Mute video/.test(x.textContent)); return b ? { first: r.querySelectorAll('.cloud-tool:not(.cloud-tool-back)')[0] === b, disabled: b.disabled } : null; });
    check(!!tool && tool.first && !tool.disabled, '[1] the Sound row starts with "Mute video"', tool);
    await page.evaluate(() => { const b = [...document.querySelectorAll('#cloudDock .cloud-dock-row.on .cloud-tool')].find((x) => /Mute video/.test(x.textContent)); b.click(); });
    await sleep(400);
    st = await page.evaluate(() => ({ fx: window.VideoEditor.__test.clipFx(), muted: window.VideoEditor.videoMuted(), on: [...document.querySelectorAll('#cloudDock .cloud-dock-row.on .cloud-tool')].find((x) => /Mute video/.test(x.textContent)).classList.contains('on'),
      greyed: document.getElementById('veTimeline').classList.contains('ve-video-muted'), says: document.body.innerText.includes('Video muted') }));
    check(st.muted && st.fx.every((f) => f && f.vol === 0) && st.on && st.greyed && st.says, '[1] one tap: every clip at 0%, the tool lit, the sound row greyed and "Video muted" said', st);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/mute-on.png' });
    // [2] the preview is silent the way an iPhone obeys (muted, not volume) — on every clip, playing
    const heard = [];
    for (const t of [1, 4.5, 7.5]) {
      await page.evaluate((x) => window.VideoEditor.__test.seekTo(x), t);
      await page.evaluate(() => { const p = document.querySelector('#vePlayer, video'); return p && p.play && p.play().catch(() => {}); });
      await sleep(500);
      heard.push(await page.evaluate(() => window.VideoEditor.__test.playerMuted()));
      await page.evaluate(() => { const p = document.querySelector('#vePlayer, video'); if (p) p.pause(); });
    }
    check(heard.every(Boolean), '[2] the preview plays with the video\'s sound off on every clip (muted — the one switch an iPhone obeys)', heard);
    // [3] tapped again: each clip gets its own volume back (the middle one 150%)
    await page.evaluate(() => { const b = [...document.querySelectorAll('#cloudDock .cloud-dock-row.on .cloud-tool')].find((x) => /Mute video/.test(x.textContent)); b.click(); });
    await sleep(300);
    st = await page.evaluate(() => ({ fx: window.VideoEditor.__test.clipFx(), muted: window.VideoEditor.videoMuted(), pm: (window.VideoEditor.__test.seekTo(1), window.VideoEditor.__test.playerMuted()) }));
    check(!st.muted && st.fx.every((f, i) => (i === loud ? f && f.vol === 1.5 : f === null)), '[3] tapped again: the sound is back, each clip as it was (150% stays 150%)', st);
    // [4] undo takes the mute back too
    await page.evaluate(() => window.VideoEditor.toggleVideoMute(true));
    await page.evaluate(() => window.VideoEditor.__test.undo());
    await sleep(300);
    st = await page.evaluate(() => ({ muted: window.VideoEditor.videoMuted(), fx: window.VideoEditor.__test.clipFx() }));
    check(!st.muted && st.fx[loud] && st.fx[loud].vol === 1.5, '[4] Undo takes the mute back', st);
    // [5] the export: muted, the video's sound is silent from start to end (pieces at 0%); the music still plays
    await page.evaluate(() => window.VideoEditor.toggleVideoMute(true));
    const out = await page.evaluate(async () => {
      const api = window.api.sermon, real = api.exportShort;
      let got = null, pieces = null;
      api.exportShort = async (o) => { pieces = o.pieces; const r = await real.call(api, o); got = r; return r; };
      try { await window.VideoEditor.__test.exportEditedVideo(); } finally { api.exportShort = real; }
      for (let k = 0; k < 120 && !got; k++) await new Promise((r) => setTimeout(r, 500));
      return { got, pieces };
    });
    const file = out.got && (typeof out.got === 'string' ? out.got : out.got.output || out.got.path);
    check(!!(out.pieces && out.pieces.length === 3 && out.pieces.every((p) => p.fx && p.fx.vol === 0)), '[5] the export is told: every piece at 0%', out.pieces);
    let maxDb = null;
    if (file && fs.existsSync(file)) {
      const r = require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr || '');
      maxDb = m ? (m[1] === '-inf' ? -999 : parseFloat(m[1])) : null;
    }
    check(maxDb != null && maxDb < -60, '[5] and the exported video is silent where the voice was (no sound above -60 dB)', { file, maxDb });
  } finally { await browser.close(); srv.kill(); }
  console.log(`${pass} PASS / ${fail} FAIL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
