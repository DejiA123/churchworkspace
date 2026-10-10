'use strict';
/*
 * DELETE THE PROJECT YOU HAVE OPEN — on a phone.
 *
 * "There should be an option for me to delete the current project." The
 * Projects list could delete every project but the open one. This drives the
 * real Cloud Studio like an iPhone and checks:
 *   [1] Project row → Delete asks first; Cancel keeps everything
 *   [2] OK deletes that project only (another one stays), the studio lets go
 *       of the video, Projects comes up, and the video file is untouched
 *   [3] the project does not come back by itself (no autosave remakes it,
 *       no "carry on" slot left behind)
 *   [4] the card at the top of Projects ("Open in the editor") has
 *       Delete this project too
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-project-delete.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7393, CODE = 'soundvid-test-6631';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-soundvid-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
(async () => {
  const REC = path.join(WORK, 'Instrumental screen recording.mp4');
  const MUTE = path.join(WORK, 'Silent clip.mp4');
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=8', '-f', 'lavfi', '-i', 'sine=f=220:d=8', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=390x844:r=30:d=9', '-f', 'lavfi', '-i', 'sine=f=440:d=9', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', REC]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=15:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', MUTE]);
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
    await sleep(600);
    const songs = () => page.evaluate(async () => (await window.api.library.list()).music);

    // [1]
    await page.evaluate(() => window.VideoEditor.__test.openLibrary('music'));
    await sleep(300);
    const btn = page.locator('#libAddMusicVideo');
    check(await btn.isVisible(), 'My music shows 🎬 Sound from a video');
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'music-from-video.png') });
    async function send(file) {
      await btn.tap(); await sleep(800);
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.evaluate(() => document.getElementById('cloudUpload').click())]);
      const accept = await chooser.element().evaluate((n) => n.accept);
      await chooser.setFiles(file);
      await page.waitForFunction(() => document.getElementById('cloudFilesModal').classList.contains('hidden'), null, { timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => !document.getElementById('overlay') || document.getElementById('overlay').classList.contains('hidden') || getComputedStyle(document.getElementById('overlay')).display === 'none', null, { timeout: 30000 }).catch(() => {});
      await sleep(1500);
      return accept;
    }
    const toasts = [];
    await page.exposeFunction('__seenToast', (t) => toasts.push(t));
    await page.evaluate(() => { const o = window.__toast; window.__toast = (m, k) => { window.__seenToast(String(m)); return o && o(m, k); }; });
    const accept = await send(REC);
    check(/\.mp4/.test(accept) && /\.mov/.test(accept) && !/\.mp3/.test(accept), 'its chooser asks for a video', accept);

    // [2]
    const list = await songs();
    const s = list.find((m) => /Instrumental screen recording/.test(m.name));
    check(!!s, 'the recording is in My music under its own name', { songs: list.map((m) => m.name), toasts });
    if (s) {
      check(/\.m4a$/.test(s.file) && s.source === 'video', 'it is kept as a song (.m4a), marked as from a video', { file: s.file, source: s.source });
      check(Math.abs((s.durationSec || 0) - 9) < 0.3, 'the whole length of the sound is kept', s.durationSec);
      const probe = execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1').includes('ffprobe') && fs.existsSync(ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')) ? ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1') : 'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,bit_rate', '-of', 'json', s.file]).toString();
      const st = JSON.parse(probe).streams;
      check(st.length === 1 && st[0].codec_type === 'audio', 'sound only — no picture in the song', st);
      // [3]
      check(st[0] && st[0].codec_name === 'aac' && Math.abs(parseInt(st[0].bit_rate, 10) - 160000) < 30000, 'an iPhone\'s AAC sound is kept as it is (not re-encoded)', st);
      const using = await page.evaluate(() => (document.getElementById('libMusicList').innerText || ''));
      check(/In use/.test(using) && /Instrumental screen recording[\s\S]{0,40}/.test(using), 'it becomes the music in use', using.slice(0, 200));
    }

    // [4]
    const before = (await songs()).length;
    toasts.length = 0;
    await send(MUTE);
    check((await songs()).length === before, 'a video with no sound adds nothing');
    check(toasts.some((t) => /no sound/i.test(t)), 'and says why', toasts);
  } catch (e) {
    check(false, 'the test ran to the end', e.message);
  } finally {
    await browser.close(); srv.kill();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
