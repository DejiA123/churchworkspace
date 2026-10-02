'use strict';
/*
 * PHONE STUDIO — the real end-to-end test.
 *
 * This does not mock the studio. It boots the ACTUAL main process (src/main/main.js,
 * every IPC handler the desktop registers), points its user-data at a temp folder
 * so nothing of the user's is touched, switches Phone Studio on, and then talks to
 * it over real HTTP exactly as a phone would:
 *
 *   [A] pairing        — wrong PIN refused, brute force locked out, right PIN pairs
 *   [B] the allowlist  — a paired phone still cannot reach a shell, a dialog, the
 *                        settings (they hold API keys), or a file outside the media
 *                        folders; and fs:rmdir only accepts our own temp folders
 *   [C] media serving  — Range requests (iOS Safari will not scrub without them),
 *                        byte-exact partial content, and forbidden paths refused
 *   [D] upload         — a real file streamed from "the phone" onto the PC and then
 *                        probed through the RPC that a phone would use next
 *   [E] the real work  — filmstrip, thumbnail, Long-to-shorts on a synthetic sermon
 *                        with known loud moments, live progress over SSE, a real
 *                        9:16 MP4 export, and the download that puts it on a phone
 *   [F] cancel         — job:cancel from the phone really kills the ffmpeg
 *   [G] the page       — the mobile UI and the MediaPipe assets are actually served
 *
 *   npx electron test/phone-studio.test.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 7391;
const PIN_TRIES = 8;

const WORK = path.join(os.tmpdir(), 'mw-phone-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const OUTDIR = path.join(WORK, 'out');
fs.mkdirSync(OUTDIR, { recursive: true });

// Isolate everything this test writes: its own settings store, its own library,
// its own upload folder. The user's real workstation.json is never opened.
app.setPath('userData', path.join(WORK, 'userData'));

const ffmpeg = require('ffmpeg-static');

let failed = false;
const results = [];
function log(ok, name, detail) {
  results.push(ok);
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── a synthetic sermon ─────────────────────────
 * 150 seconds of "speech" at a calm baseline with three deliberately loud
 * moments. The analyzer is audio-driven, so those three are the ground truth:
 * if Long-to-shorts works through the phone API, the clips it returns must sit
 * on them.
 */
const SR = 16000;
const LOUD = [[30, 46], [72, 88], [114, 130]];
const TOTAL = 150;

function buildWav(file) {
  const n = SR * TOTAL;
  const data = Buffer.alloc(n * 2);
  const isLoud = (t) => LOUD.some(([a, b]) => t >= a && t < b);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // A gap of near-silence every few seconds gives the analyzer the pause
    // boundaries it cuts on, which is how real speech behaves.
    const inPause = (Math.floor(t) % 7) === 6;
    const amp = inPause ? 40 : (isLoud(t) ? 13000 : 3200);
    // 180 Hz carrier with a slow tremolo so the loudness envelope varies the way
    // a voice does rather than sitting on one flat level.
    const v = Math.sin(2 * Math.PI * 180 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 1.7 * t));
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * amp))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

function buildSermon() {
  const wav = path.join(WORK, 'sermon.wav');
  const mp4 = path.join(WORK, 'sermon.mp4');
  buildWav(wav);
  execFileSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=0x184b8c:s=640x360:r=15:d=${TOTAL}`,
    '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', mp4,
  ], { stdio: 'ignore' });
  return mp4;
}

/* ───────────────────────── tiny HTTP client ───────────────────────── */

function request(method, urlPath, { headers = {}, body = null, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (!raw) { try { json = JSON.parse(buf.toString('utf-8')); } catch (e) { json = null; } }
        resolve({ status: res.statusCode, headers: res.headers, buf, json, text: raw ? '' : buf.toString('utf-8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let TOKEN = '';
const auth = () => ({ Authorization: 'Bearer ' + TOKEN });

async function rpc(channel, args) {
  const res = await request('POST', '/api/rpc', {
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
    body: JSON.stringify({ channel, args: args || {} }),
  });
  return { status: res.status, body: res.json };
}
async function rpcOk(channel, args) {
  const r = await rpc(channel, args);
  if (r.status !== 200 || !r.body || !r.body.ok) {
    throw new Error(`${channel} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.data;
}

/* ───────────────────────── the run ───────────────────────── */

// The real main process, loaded the way Electron loads it: at module scope,
// BEFORE the app is ready, because it registers a privileged scheme up there.
const rpcBridge = require(path.join(ROOT, 'src/main/rpc'));
require(path.join(ROOT, 'src/main/main.js'));

async function run() {
  console.log('\n=== [0] the real main process is up ===');
  await sleep(1500); // let whenReady finish wiring the store and handlers

  log(rpcBridge.has('sermon:analyze') && rpcBridge.has('video:info') && rpcBridge.has('captions:burn'),
    'the RPC bridge recorded the studio handlers', rpcBridge.channels().length + ' channels');

  // Keep every artefact inside the test folder.
  const setRes = await rpcBridge.invoke('settings:update', { patch: { outputDir: OUTDIR } });
  log(setRes.ok, 'test output folder set', OUTDIR);

  const startRes = await rpcBridge.invoke('phone:start', { port: PORT, allowUpload: true });
  log(startRes.ok && startRes.data.running, 'Phone Studio started', 'port ' + PORT);
  const PIN = startRes.data.pin;
  log(/^\d{6}$/.test(PIN), 'a 6-digit pairing PIN was generated');

  /* ───────────── [A] pairing ───────────── */
  console.log('\n=== [A] pairing ===');
  let r = await request('GET', '/api/hello');
  log(r.status === 200 && r.json.needsPin === true && r.json.paired === false,
    'an unpaired phone is told a PIN is needed');

  r = await rpc('video:info', { input: 'x' });
  log(r.status === 401, 'RPC is refused before pairing', 'status ' + r.status);

  r = await request('GET', '/api/videos');
  log(r.status === 401, 'the video list is refused before pairing');

  const wrong = await request('POST', '/api/login', {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '000000' === PIN ? '111111' : '000000' }),
  });
  log(wrong.status === 401, 'a wrong PIN is refused');

  // Hammer it: after MAX_ATTEMPTS the IP is locked out, so a stolen phone on the
  // church wifi cannot sit there trying a million six-digit numbers.
  let lockedStatus = 0;
  for (let i = 0; i < PIN_TRIES + 1; i++) {
    const res = await request('POST', '/api/login', {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '999999' }),
    });
    lockedStatus = res.status;
  }
  log(lockedStatus === 429, 'brute-forcing the PIN locks the phone out', 'status ' + lockedStatus);

  // A fresh PIN clears the lockout (this is also the operator's escape hatch).
  const newPin = await rpcBridge.invoke('phone:newPin');
  const PIN2 = newPin.data.pin;
  log(/^\d{6}$/.test(PIN2) && PIN2 !== PIN, 'a new PIN can be issued and differs from the old one');

  const good = await request('POST', '/api/login', {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN2 }),
  });
  log(good.status === 200 && !!good.json.token, 'the right PIN pairs the phone');
  TOKEN = good.json.token;

  r = await request('GET', '/api/hello', { headers: auth() });
  log(r.json.paired === true, 'the paired phone is recognised on the next request');

  /* ───────────── [B] the allowlist ───────────── */
  console.log('\n=== [B] what a paired phone still may not do ===');
  for (const ch of ['shell:openExternal', 'shell:openPath', 'dialog:openFile', 'settings:get',
    'settings:update', 'fs:writeText', 'fs:readText', 'accounts:list', 'live:start', 'present:open']) {
    const res = await rpc(ch, {});
    log(res.status === 403, `"${ch}" is refused`, 'status ' + res.status);
  }

  const outsider = process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';
  r = await rpc('video:info', { input: outsider });
  log(r.status === 403, 'a file outside the media folders is refused', outsider);

  r = await rpc('video:mixMusic', { input: path.join(OUTDIR, 'x.mp4'), musicPath: outsider });
  log(r.status === 403, 'a nested path argument (musicPath) is checked too');

  r = await rpc('video:appendClips', { input: path.join(OUTDIR, 'x.mp4'), clips: [outsider] });
  log(r.status === 403, 'a bare path inside an array argument is checked too');

  r = await rpc('fs:rmdir', { dir: os.tmpdir() });
  log(r.status === 403, 'fs:rmdir will not delete the temp folder itself');
  r = await rpc('fs:rmdir', { dir: path.join(os.tmpdir(), 'something-of-yours') });
  log(r.status === 403, 'fs:rmdir will not delete a folder it did not make');
  const ownTemp = path.join(os.tmpdir(), 'mw-frames-phonetest');
  fs.mkdirSync(ownTemp, { recursive: true });
  r = await rpc('fs:rmdir', { dir: ownTemp });
  log(r.status === 200 && !fs.existsSync(ownTemp), 'fs:rmdir does clean up its own frame folder');

  /* ───────────── [D] upload from the phone ───────────── */
  console.log('\n=== [D] sending a video from the phone ===');
  const sermon = buildSermon();
  log(fs.existsSync(sermon) && fs.statSync(sermon).size > 10000, 'built a synthetic 150s sermon',
    Math.round(fs.statSync(sermon).size / 1024) + ' KB');

  const bytes = fs.readFileSync(sermon);
  const up = await request('POST', `/api/upload?name=sunday%20service.mp4`, {
    headers: Object.assign({ 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) }, auth()),
    body: bytes,
  });
  log(up.status === 200 && up.json.path && fs.existsSync(up.json.path),
    'the upload landed on the PC', up.json && up.json.name);
  const UPLOADED = up.json.path;
  log(fs.statSync(UPLOADED).size === bytes.length, 'the uploaded file is byte-for-byte the same size');

  const badUp = await request('POST', '/api/upload?name=evil.exe', {
    headers: Object.assign({ 'Content-Length': '4' }, auth()), body: 'MZ\0\0',
  });
  log(badUp.status === 400, 'a non-media upload is refused', 'status ' + badUp.status);

  const listed = await request('GET', '/api/videos', { headers: auth() });
  const allFiles = (listed.json.groups || []).flatMap((g) => g.files.map((f) => f.path));
  log(allFiles.includes(UPLOADED), 'the uploaded video appears in the phone\'s video list');

  /* ───────────── [E] the real work ───────────── */
  console.log('\n=== [E] editing it from the phone ===');
  const info = await rpcOk('video:info', { input: UPLOADED });
  log(Math.abs(info.durationSec - TOTAL) < 3 && info.width === 640,
    'video:info over HTTP reads the real file', `${info.width}x${info.height} ${info.durationSec.toFixed(1)}s`);

  const strip = await rpcOk('video:filmstrip', { input: UPLOADED, count: 12 });
  log(fs.existsSync(strip) && fs.statSync(strip).size > 500, 'a filmstrip was rendered for the scrubber');

  const th = await rpcOk('video:thumbnail', { input: UPLOADED, timeSec: 5 });
  log(fs.existsSync(th), 'a thumbnail was rendered');

  /* [C] media serving — done here because we now have real files to serve */
  console.log('\n=== [C] streaming media to the phone ===');
  const full = await request('GET', `/api/media?p=${encodeURIComponent(UPLOADED)}&k=${TOKEN}`, { raw: true });
  log(full.status === 200 && full.headers['accept-ranges'] === 'bytes' && full.buf.length === bytes.length,
    'the whole file streams with Accept-Ranges', full.buf.length + ' bytes');
  log(full.headers['content-type'] === 'video/mp4', 'served with the right content type');

  const part = await request('GET', `/api/media?p=${encodeURIComponent(UPLOADED)}&k=${TOKEN}`, {
    headers: { Range: 'bytes=100-199' }, raw: true,
  });
  log(part.status === 206 && part.buf.length === 100
    && part.headers['content-range'] === `bytes 100-199/${bytes.length}`,
    'a Range request returns 206 with exactly the asked-for bytes', part.headers['content-range']);
  log(part.buf.equals(bytes.slice(100, 200)), 'and those bytes are the CORRECT ones');

  const suffix = await request('GET', `/api/media?p=${encodeURIComponent(UPLOADED)}&k=${TOKEN}`, {
    headers: { Range: 'bytes=-50' }, raw: true,
  });
  log(suffix.status === 206 && suffix.buf.equals(bytes.slice(-50)), 'a suffix Range (bytes=-50) works too');

  const denied = await request('GET', `/api/media?p=${encodeURIComponent(outsider)}&k=${TOKEN}`, { raw: true });
  log(denied.status === 403, 'a file outside the media folders will not stream');

  const noKey = await request('GET', `/api/media?p=${encodeURIComponent(UPLOADED)}`, { raw: true });
  log(noKey.status === 401, 'media needs the pairing token');

  /* live progress over SSE while a real job runs */
  console.log('\n=== [E2] Long to short clips, with live progress ===');
  const seen = [];
  const sse = http.get({ host: '127.0.0.1', port: PORT, path: `/api/events?k=${TOKEN}` }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString('utf-8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame);
        const data = /^data: (.+)$/m.exec(frame);
        if (ev && data) { try { seen.push({ event: ev[1], data: JSON.parse(data[1]) }); } catch (e) {} }
      }
    });
  });
  await sleep(300);

  const jobId = 'test-analyze-1';
  const res = await rpcOk('sermon:analyze', {
    input: UPLOADED, minLen: 10, idealLen: 15, maxLen: 24, maxClips: 5,
    autoLen: false, deep: false, jobId,
  });
  log(res.clips.length >= 2, `Long-to-shorts found clips through the phone API`, res.clips.length + ' clips');

  const hits = LOUD.filter(([a, b]) => res.clips.some((c) => c.start < b && c.end > a));
  log(hits.length === LOUD.length,
    'every planted loud moment is covered by a clip', `${hits.length}/${LOUD.length}`);

  const prog = seen.filter((e) => e.event === 'job:progress' && e.data.jobId === jobId);
  log(prog.length > 0, 'progress for that job streamed to the phone over SSE', prog.length + ' updates');
  log(prog.some((e) => e.data.percent > 0), 'and the percentages actually moved',
    'max ' + Math.max(0, ...prog.map((e) => e.data.percent)) + '%');

  /* a real vertical export, then the download that gets it onto the phone */
  console.log('\n=== [E3] exporting and downloading a short ===');
  const clip = res.clips[0];
  const shortPath = await rpcOk('sermon:exportShort', {
    input: UPLOADED, startSec: clip.start, endSec: Math.min(clip.start + 6, clip.end),
    preset: 'reel-9x16', label: 'phone-test', jobId: 'test-export-1',
  });
  log(fs.existsSync(shortPath), 'a real MP4 came out', path.basename(shortPath || ''));

  const shortInfo = await rpcOk('video:info', { input: shortPath });
  log(shortInfo.width === 1080 && shortInfo.height === 1920,
    'and it is a true 9:16 short', `${shortInfo.width}x${shortInfo.height}`);
  log(shortInfo.durationSec > 3 && shortInfo.durationSec < 9,
    'of the length that was asked for', shortInfo.durationSec.toFixed(1) + 's');

  const dl = await request('GET', `/api/file?p=${encodeURIComponent(shortPath)}&k=${TOKEN}`, { raw: true });
  log(dl.status === 200 && /attachment/.test(dl.headers['content-disposition'] || ''),
    'downloading it offers a Save, not an inline play', dl.headers['content-disposition']);
  log(dl.buf.length === fs.statSync(shortPath).size, 'the download is the complete file');

  /* ───────────── [F] cancel ───────────── */
  console.log('\n=== [F] Cancel from the phone kills the encode ===');
  const cancelJob = 'test-cancel-1';
  const slow = rpc('video:export', {
    input: UPLOADED, preset: 'wide-16x9', jobId: cancelJob,
  });
  await sleep(1500);
  const cancelRes = await rpcOk('job:cancel', { id: cancelJob });
  const slowRes = await slow;
  log(cancelRes && cancelRes.killed >= 1, 'the running ffmpeg was killed', 'killed ' + (cancelRes && cancelRes.killed));
  log(slowRes.body && slowRes.body.ok === false && slowRes.body.cancelled === true,
    'the phone is told it was cancelled, not that it failed');

  try { sse.destroy(); } catch (e) {}

  /* ───────────── [G] the page itself ───────────── */
  console.log('\n=== [G] the mobile page and its assets ===');
  const page = await request('GET', '/');
  log(page.status === 200 && /Phone Studio/.test(page.text), 'the phone page is served');
  for (const need of ['phone.css', 'phone.js', 'facetrack.js']) {
    log(page.text.includes(need), `the page pulls in ${need}`);
  }
  for (const asset of ['/phone.css', '/phone.js', '/facetrack.js']) {
    const a = await request('GET', asset, { raw: true });
    log(a.status === 200 && a.buf.length > 500, `${asset} is served`, a.buf.length + ' bytes');
  }
  const ft = await request('GET', '/facetrack.js');
  log(/MW_AI_BASE/.test(ft.text), 'the tracker reads its asset base from the page (so it works over HTTP)');

  const bundle = await request('GET', '/ai/vision_bundle.mjs', { raw: true });
  log(bundle.status === 200 && bundle.buf.length > 10000, 'MediaPipe is served to the phone for auto-reframe',
    Math.round(bundle.buf.length / 1024) + ' KB');
  const model = await request('GET', '/ai/blaze_face_short_range.tflite', { raw: true });
  log(model.status === 200 && model.buf.length > 10000, 'so is the face model');
  const escape = await request('GET', '/ai/..%2F..%2Fpackage.json', { raw: true });
  log(escape.status === 403 || escape.status === 404, 'the asset route cannot be walked out of', 'status ' + escape.status);

  /* ───────────── [H] the desktop panel that turns it on ───────────── */
  console.log('\n=== [H] the Settings panel on the PC ===');
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) {
    log(false, 'the studio window is open so the panel can be checked');
  } else {
    // The window is the real index.html with the real renderer.js, so this is
    // the panel an operator actually reads the address and PIN off.
    const panel = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('.nav-item[data-view="settings"]').click();
      const st = await window.api.phone.state();
      renderPhone(st);
      await new Promise(r => setTimeout(r, 150));
      const vis = (el) => !!el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 0;
      return {
        hasPanel: !!document.getElementById('phonePanel'),
        checked: document.getElementById('phoneOn').checked,
        detailsVisible: vis(document.getElementById('phoneDetails')),
        url: document.getElementById('phoneUrl').textContent,
        pin: document.getElementById('phonePin').textContent,
        pinPx: parseFloat(getComputedStyle(document.getElementById('phonePin')).fontSize),
        status: document.getElementById('phoneStatus').textContent,
        port: document.getElementById('phonePort').value,
        veBtn: !!document.getElementById('vePhone'),
        running: st.running, pinFromMain: st.pin,
      };
    })()`);
    log(panel.hasPanel && panel.checked && panel.detailsVisible,
      'the panel shows Phone Studio as on, with the connect steps unfolded');
    log(/^http:\/\/[\d.]+:\d+$/.test(panel.url), 'it shows an address a phone can actually type', panel.url);
    log(panel.pin.replace(/\s/g, '') === panel.pinFromMain,
      'it shows the SAME PIN the server will accept', panel.pin);
    // A PIN read off a monitor from arm's length has to be big; the whole feature
    // fails at this step if it isn't legible.
    log(panel.pinPx >= 16, 'the PIN is set large enough to read across a desk', panel.pinPx + 'px');
    log(String(panel.port) === String(PORT), 'the port box reflects the running server', panel.port);
    log(panel.veBtn, 'the Video Studio has a 📱 Phone button that jumps here');
    log(/On/.test(panel.status), 'the status line reads "On"', panel.status);
  }

  /* ───────────── teardown ───────────── */
  const stopped = await rpcBridge.invoke('phone:stop');
  log(stopped.ok && !stopped.data.running, 'Phone Studio stops cleanly');
  let afterStop = null;
  try { afterStop = await request('GET', '/api/hello'); } catch (e) { afterStop = { status: 0 }; }
  log(afterStop.status === 0, 'and the port really is closed');
}

app.whenReady().then(() => {
  run()
    .catch((e) => { console.error('\nTEST CRASHED:', e); failed = true; })
    .then(() => {
      const pass = results.filter(Boolean).length;
      console.log(`\n${failed ? '❌' : '✅'} ${pass}/${results.length} checks passed`);
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
      app.exit(failed ? 1 : 0);
    });
});
