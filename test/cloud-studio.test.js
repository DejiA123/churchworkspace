'use strict';
/*
 * CLOUD STUDIO — the real end-to-end test.
 *
 * Nothing here is mocked. It boots the ACTUAL main process — all 199 IPC
 * handlers — under the Electron stand-in (src/cloud/electron-shim.js), starts
 * the cloud server in front of it, and then talks to it over real HTTP exactly
 * as a phone on the other side of the world would.
 *
 * That it runs under plain `node` at all is the first thing it proves: the
 * standalone deployment is not a second backend, it is this one.
 *
 *   [0] the page     — the generated page still contains every part of the
 *                      Video Studio that veditor.js reaches for. This is the
 *                      guard on the whole claim: move a modal in index.html and
 *                      this fails instead of the caption editor quietly
 *                      vanishing from the cloud.
 *   [A] signing in   — no code, wrong code, brute force locked out, right code
 *                      in, and a session that SURVIVES A RESTART
 *   [B] the gate     — a signed-in browser still cannot read the settings (API
 *                      keys, social tokens), run a shell, open a dialog, touch
 *                      Go Live, or point a handler outside the media folders
 *   [C] shaping      — paths:get answers with the two folders the page needs
 *                      and nothing about this machine
 *   [D] the envelope — PNG bytes make the round trip and come out byte-exact,
 *                      and a plain answer is still plain JSON
 *   [E] the real work— filmstrip, info, analyze, a genuine export with live
 *                      progress over SSE, and a Range download
 *   [F] upload       — chunked and RESUMABLE, including picking up after a
 *                      broken connection
 *   [G] the PWA      — manifest, icons, and a service worker that will never
 *                      cache the studio's work
 *   [I] deleting     — only exports and uploads, never a planned post's video
 *   [J] spaces       — each account sees only its own work
 *   [H] the scheduler— the phone's Social Scheduler: a Zernio key goes IN and
 *                      never comes back out, the accounts arrive without their
 *                      keys, a post's media is held to the same folders as
 *                      everything else, and the page is told which build it is
 *
 *   npm run test:cloud
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 7394;
const CODE = 'anchor-harvest-4271';

const WORK = path.join(os.tmpdir(), 'mw-cloud-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const OUTDIR = path.join(WORK, 'out');
const MEDIA = path.join(WORK, 'media');
fs.mkdirSync(OUTDIR, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const ffmpeg = require('ffmpeg-static');

let failed = false;
const results = [];
function log(ok, name, detail) {
  results.push(!!ok);
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── a synthetic sermon ───────────────────────── */

const SR = 16000;
const TOTAL = 60;
const LOUD = [[12, 24], [36, 48]];

function buildWav(file) {
  const n = SR * TOTAL;
  const data = Buffer.alloc(n * 2);
  const isLoud = (t) => LOUD.some(([a, b]) => t >= a && t < b);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const inPause = (Math.floor(t) % 7) === 6;
    const amp = inPause ? 40 : (isLoud(t) ? 13000 : 3200);
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
  const mp4 = path.join(MEDIA, 'sermon.mp4');
  buildWav(wav);
  execFileSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=0x184b8c:s=640x360:r=15:d=${TOTAL}`,
    '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', mp4,
  ], { stdio: 'ignore' });
  return mp4;
}

/* ───────────────────────── tiny HTTP client ───────────────────────── */

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    // agent:false — Node 19+ keeps sockets alive by default, and a pooled socket
    // from before a restart would come back as ECONNRESET rather than a request.
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf-8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, buf, json, text: buf.toString('utf-8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let TOKEN = '';
const auth = () => ({ Authorization: 'Bearer ' + TOKEN });

async function login(code, remember) {
  return request('POST', '/api/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, remember: !!remember }),
  });
}

/** An RPC the way the page makes one — binary when there are bytes to carry. */
async function rpc(channel, args) {
  const enc = cloud.encodeEnvelope({ channel, args: args || {} });
  const res = await request('POST', '/api/rpc', {
    headers: Object.assign({ 'Content-Type': enc.binary ? 'application/x-mw-rpc' : 'application/json' }, auth()),
    body: enc.body,
  });
  const ct = res.headers['content-type'] || '';
  let body = res.json;
  if (ct.indexOf('x-mw-rpc') >= 0) body = cloud.decodeEnvelope(res.buf);
  return { status: res.status, body, contentType: ct };
}
async function rpcOk(channel, args) {
  const r = await rpc(channel, args);
  if (r.status !== 200 || !r.body || !r.body.ok) {
    throw new Error(`${channel} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  return r.body.data;
}

/* ───────────────────── the app, with no Electron ───────────────────── */

const version = require(path.join(ROOT, 'package.json')).version;
const shim = require(path.join(ROOT, 'src/cloud/electron-shim')).install({
  dataDir: path.join(WORK, 'userData'),
  mediaDir: MEDIA,
  version,
});

// Stand the posting machinery down, exactly as the real server does.
const schedulerMod = require(path.join(ROOT, 'src/main/scheduler'));
if (schedulerMod.Scheduler) schedulerMod.Scheduler.prototype.start = function () { return this; };
require(path.join(ROOT, 'src/main/autopost')).startHeartbeat = () => ({ stop() {} });

const rpcBridge = require(path.join(ROOT, 'src/main/rpc'));
require(path.join(ROOT, 'src/main/main.js'));

const cloud = require(path.join(ROOT, 'src/cloud/cloud-api'));
const page = require(path.join(ROOT, 'src/cloud/page'));

const dirs = () => ({
  output: OUTDIR,
  uploads: path.join(WORK, 'uploads'),
  temp: shim.paths.temp,
  videos: MEDIA,
  library: path.join(WORK, 'userData', 'library'),
  sessions: path.join(WORK, 'userData', 'sessions'),
  fonts: (() => { try { return require(path.join(ROOT, 'src/main/captioner')).fontsDir(); } catch (e) { return ''; } })(),
  ai: path.join(ROOT, 'bin', 'ai'),
});

/* ───────────────────────────── the run ───────────────────────────── */

async function run() {
  console.log('\n=== [0] the app is up, with no Electron under it ===');
  await sleep(600);
  log(rpcBridge.has('sermon:analyze') && rpcBridge.has('captions:burnTrack') && rpcBridge.has('video:applyEdits'),
    'the real main process registered its handlers under the shim', rpcBridge.channels().length + ' channels');

  // Everything this test writes stays in its own folder.
  await rpcBridge.invoke('settings:update', { patch: { outputDir: OUTDIR } });

  /* ───────────── [0] the page is the whole studio ───────────── */
  const html = page.build({ version });
  const check = page.check(html);
  log(check.ok, 'the cloud page still contains every part of the Video Studio',
    check.checked + ' ids checked' + (check.missing.length ? ', MISSING ' + check.missing.join(', ') : ''));
  const shell = page.shellCheck();
  log(shell.ok, 'and every global the studio reaches for on window is provided',
    shell.checked + ' checked' + (shell.missing.length ? ', MISSING ' + shell.missing.join(', ') : ''));
  log(!/<script>/.test(html), 'the page has no inline script (its CSP forbids one)');
  log(html.includes('id="view-video"') && !html.includes('id="view-live"') && !html.includes('id="view-settings"'),
    'it carries the Video Studio and none of the studios a browser cannot drive');
  // Without `active` the view is display:none — a blank page on a laptop.
  log(/<section[^>]*class="view active[^"]*"[^>]*id="view-video"/.test(html),
    'the studio is the active view, whatever else is in its class list');
  log(html.includes('rel="manifest"') && html.includes('veditor.js'), 'it is a PWA that loads the real editor');
  log(html.includes('tasks.js'), 'and the background-export layer, so a phone can walk away from an export');

  const started = await cloud.start({
    port: PORT, code: CODE, allowUpload: true, appVersion: version,
    tokenFile: path.join(WORK, 'sessions.json'), dirs: dirs(),
  });
  log(started.running, 'the cloud server started', 'port ' + PORT);

  /* ───────────── [A] signing in ───────────── */
  console.log('\n=== [A] signing in ===');
  let r = await request('GET', '/api/hello');
  log(r.status === 200 && r.json.signedIn === false, 'a new browser is told it is not signed in');

  r = await rpc('video:info', { input: 'x' });
  log(r.status === 401, 'RPC is refused before signing in', 'status ' + r.status);
  r = await request('GET', '/api/videos');
  log(r.status === 401, 'the file list is refused before signing in');

  r = await login('wrong-code-0000');
  log(r.status === 401, 'a wrong code is refused');

  let lockedAt = 0;
  for (let i = 0; i < 9; i++) {
    const a = await login('still-wrong-' + i);
    if (a.status === 429) { lockedAt = i; break; }
  }
  log(lockedAt > 0 && lockedAt <= 8, 'brute force is locked out', 'after ' + (lockedAt + 1) + ' tries');

  r = await login(CODE);
  log(r.status === 429, 'and the right code is refused while locked out');

  // Rolling the code clears the lockout (and every session), which is the
  // documented way back in when somebody has locked themselves out.
  cloud.resetCode(CODE);

  r = await login(CODE, true);
  log(r.status === 200 && !!r.json.token, 'the right code signs in');
  TOKEN = r.json.token;

  r = await request('GET', '/api/hello', { headers: auth() });
  log(r.json.signedIn === true, 'and the browser is now signed in');

  // The one that matters for a server that will be restarted.
  cloud.stop();
  await cloud.start({
    port: PORT, code: CODE, allowUpload: true, appVersion: version,
    tokenFile: path.join(WORK, 'sessions.json'), dirs: dirs(),
  });
  r = await request('GET', '/api/hello', { headers: auth() });
  log(r.json.signedIn === true, 'a signed-in device SURVIVES a server restart');

  /* ───────────── [B] what a signed-in browser still cannot do ───────────── */
  console.log('\n=== [B] the gate ===');
  for (const ch of ['settings:get', 'settings:update', 'accounts:list', 'shell:openPath',
    'dialog:openFile', 'fs:writeText', 'fs:readText', 'live:start', 'present:show', 'phone:start']) {
    const g = await rpc(ch, {});
    log(g.status === 403, `"${ch}" is refused`, 'status ' + g.status);
  }

  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
  r = await rpc('video:info', { input: outside });
  log(r.status === 403, 'a path outside the media folders is refused', outside);

  r = await rpc('video:mixMusic', { input: path.join(MEDIA, 'sermon.mp4'), musicPath: outside });
  log(r.status === 403, 'a path hidden in a nested argument is refused too');

  r = await rpc('fs:rmdir', { dir: os.tmpdir() });
  log(r.status === 403, 'fs:rmdir refuses the temp folder itself');
  r = await rpc('fs:rmdir', { dir: path.join(shim.paths.temp, 'not-ours') });
  log(r.status === 403, 'fs:rmdir refuses a folder it did not make');

  r = await request('GET', '/api/media?p=' + encodeURIComponent(outside), { headers: auth() });
  log(r.status === 403, 'media serving refuses a file outside the media folders');

  r = await request('GET', '/r/renderer.js', { headers: auth() });
  log(r.status === 404, 'the renderer folder is an allowlist, not a static server');

  /* ───────────── [C] what the page is told about this machine ───────────── */
  console.log('\n=== [C] shaping ===');
  const paths = await rpcOk('paths:get');
  log(!!paths.outputDir && !!paths.fontsDir, 'paths:get gives the page the folders it needs');
  log(!('userData' in paths) && !('ffmpeg' in paths),
    'and tells it nothing else about this machine', Object.keys(paths).join(', '));

  /* ───────────── [D] the binary envelope ───────────── */
  console.log('\n=== [D] the RPC envelope ===');
  const plain = await rpc('video:presets', {});
  log(plain.contentType.indexOf('json') >= 0, 'an answer with no bytes in it comes back as plain JSON');

  const sermon = buildSermon();
  // A real transparent PNG, the way the caption/text rasteriser makes them.
  const pngPath = path.join(WORK, 'overlay.png');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red@0.6:s=320x80,format=rgba',
    '-frames:v', '1', pngPath], { stdio: 'ignore' });
  const png = fs.readFileSync(pngPath);

  const burned = await rpcOk('overlays:burnImages', {
    input: sermon,
    images: [{ png, start: 1, end: 4 }],
    outName: 'cloud-envelope-test',
  });
  log(fs.existsSync(burned) && fs.statSync(burned).size > 10000,
    'PNG bytes survive the trip and reach ffmpeg', path.basename(burned));

  // …and byte-exactly, which is the part a JSON round trip would quietly ruin.
  const echo = cloud.decodeEnvelope(cloud.encodeEnvelope({ ok: true, data: { png } }).body);
  log(Buffer.compare(Buffer.from(echo.data.png), png) === 0, 'and they come back byte-for-byte identical',
    png.length + ' bytes');

  /* ───────────── [E] the real work ───────────── */
  console.log('\n=== [E] the studio actually working ===');
  const info = await rpcOk('video:info', { input: sermon });
  log(info.durationSec >= TOTAL - 1 && info.width === 640, 'video:info reads the recording',
    `${info.width}x${info.height} ${Math.round(info.durationSec)}s`);

  const strip = await rpcOk('video:filmstrip', { input: sermon, count: 6 });
  log(Array.isArray(strip) ? strip.length > 0 : !!strip, 'a filmstrip comes back for the timeline');

  // Live progress, the way the page sees it.
  const seen = [];
  const es = http.request({
    host: '127.0.0.1', port: PORT, path: '/api/events?k=' + encodeURIComponent(TOKEN), method: 'GET',
  }, (res) => {
    res.on('data', (c) => {
      const s = c.toString();
      if (s.includes('job:progress')) {
        const m = /"percent":(\d+)/.exec(s);
        if (m) seen.push(Number(m[1]));
      }
    });
  });
  es.end();
  await sleep(300);

  const jobId = 'test_job_' + Date.now();
  const edited = await rpcOk('video:applyEdits', {
    input: sermon,
    edits: { cuts: [], preset: 'reel-9x16', quality: '720p' },
    jobId,
  });
  log(fs.existsSync(edited), 'a real export runs and writes a file', path.basename(edited));
  log(seen.length > 0 && Math.max(...seen) > 0, 'its progress streamed to the browser over SSE',
    seen.length + ' updates, to ' + Math.max(...seen, 0) + '%');

  const size = fs.statSync(edited).size;
  r = await request('GET', '/api/media?p=' + encodeURIComponent(edited), { headers: Object.assign({ Range: 'bytes=0-1023' }, auth()) });
  log(r.status === 206 && r.buf.length === 1024, 'the finished file serves a Range request (no phone scrubs without it)',
    r.headers['content-range']);

  r = await request('GET', '/api/file?p=' + encodeURIComponent(edited) + '&dl=1', { headers: auth() });
  log(r.status === 200 && r.buf.length === size && /attachment/.test(r.headers['content-disposition'] || ''),
    'and downloads whole, as an attachment', size + ' bytes');

  const clips = await rpcOk('sermon:analyze', {
    input: sermon, minLen: 8, maxLen: 20, maxClips: 3, deep: false, autoLen: false,
  });
  const list = clips.clips || clips;
  log(Array.isArray(list) && list.length > 0, 'Long-to-shorts finds clips through the cloud',
    Array.isArray(list) ? list.length + ' clips' : typeof list);
  if (Array.isArray(list) && list.length) {
    const onLoud = list.some((c) => LOUD.some(([a, b]) => c.start < b && c.end > a));
    log(onLoud, 'and they sit on the loud moments, as they do on the desktop');
  }

  try { es.destroy(); } catch (e) {}

  /* ───────────── [F] sending a file from the phone ───────────── */
  console.log('\n=== [F] upload ===');
  const bytes = fs.readFileSync(sermon);
  const id = 'testupload1';
  const q = (extra) => `/api/upload?name=phone-clip.mp4&id=${id}&size=${bytes.length}${extra || ''}`;
  const half = Math.floor(bytes.length / 2);

  r = await request('POST', q('&offset=0'), {
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth()),
    body: bytes.subarray(0, half),
  });
  log(r.status === 200 && r.json.partial === true && r.json.have === half,
    'a first chunk is taken and the server says how much it has', r.json && r.json.have);

  // "The phone lost signal here." It comes back and asks where it got to.
  r = await request('POST', q('&probe=1'), { headers: auth() });
  log(r.status === 200 && r.json.have === half, 'after a dropped connection it says where to pick up', r.json && r.json.have);

  r = await request('POST', q('&offset=' + half), {
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth()),
    body: bytes.subarray(half),
  });
  log(r.status === 200 && r.json.ok && r.json.size === bytes.length, 'the rest completes the file', r.json && r.json.name);
  const landed = r.json && r.json.path;
  log(landed && fs.existsSync(landed) && Buffer.compare(fs.readFileSync(landed), bytes) === 0,
    'and what landed is byte-identical to what was sent');
  log(landed && !/\.\s*-|\.-/.test(path.basename(landed)), 'with a sensible name', landed && path.basename(landed));

  const got = await rpcOk('video:info', { input: landed });
  log(got.durationSec >= TOTAL - 1, 'the uploaded file is immediately editable');

  /* ───────────── [G] the PWA ───────────── */
  console.log('\n=== [G] installable ===');
  r = await request('GET', '/manifest.webmanifest');
  const man = r.json || {};
  log(r.status === 200 && man.start_url === '/' && man.display === 'standalone',
    'the manifest makes it installable to a home screen');
  log((man.icons || []).length >= 2 && man.icons.some((i) => i.purpose === 'maskable'),
    'with a square icon and a maskable one', (man.icons || []).length + ' icons');
  for (const icon of man.icons || []) {
    const ic = await request('GET', icon.src);
    const isPng = ic.buf.length > 8 && ic.buf[0] === 0x89 && ic.buf.toString('ascii', 1, 4) === 'PNG';
    log(ic.status === 200 && isPng, 'icon ' + icon.src + ' is a real PNG', ic.buf.length + ' bytes');
  }

  r = await request('GET', '/sw.js');
  const sw = r.text;
  log(r.status === 200 && /serviceworker|self\.addEventListener\('fetch'/i.test(sw), 'a service worker is served');
  log(/p\.startsWith\('\/api\/'\)/.test(sw) && /return;/.test(sw),
    'and it refuses to cache anything under /api/ — the studio\'s work is never replayed');

  r = await request('GET', '/');
  log(r.status === 200 && /<title>Church Work Space/.test(r.text), 'the page itself is served to a browser that has not signed in');

  r = await request('GET', '/ai/blaze_face_short_range.tflite');
  log(r.status === 200 && r.buf.length > 10000,
    'MediaPipe assets are served so auto-reframe runs in the phone', r.buf.length + ' bytes');

  /* ───────────── [H] the Social Scheduler, from a phone ───────────── */
  console.log('\n=== [H] the Social Scheduler, from a phone ===');
  r = await request('GET', '/api/hello');
  log(r.json && r.json.build === page.assetKey(version) && r.json.social === true,
    'the page is told the build it is made from (an installed phone app compares it to offer a refresh)', r.json && r.json.build);
  let acc = await rpcOk('social:accounts');
  log(acc && Array.isArray(acc.accounts) && acc.keys && acc.keys.zo === false, 'the phone sees the accounts and whether a key is set', JSON.stringify(acc.keys));
  const SECRET = 'zo_live_' + 'k3y' + Date.now();
  const set = await rpcOk('social:setKeys', { zoApiKey: SECRET });
  log(set && set.zo === true && !JSON.stringify(set).includes(SECRET), 'a Zernio key can be set from the phone, and the answer is only "it is set"');
  const back = await rpc('social:accounts');
  log(back.status === 200 && !JSON.stringify(back.body).includes(SECRET), 'and it never comes back out');
  r = await rpc('settings:get', {});
  log(r.status === 403, 'the settings file is still refused');
  r = await rpc('social:setKeys', { zoApiKey: 'two words' });
  log(r.status === 200 && r.body && r.body.ok === false, 'something that is not a key is refused', r.body && r.body.error);
  r = await rpc('scheduler:add', { post: { title: 'x', mediaPaths: [outside], scheduledAt: new Date(Date.now() + 86400000).toISOString() } });
  log(r.status === 403, "a post cannot carry a file from outside the media folders", outside);
  r = await rpc('social:suggestCopy', { mediaPath: outside, listen: false });
  log(r.status === 403, 'nor can the caption writer be pointed outside them');
  const when = new Date(Date.now() + 2 * 86400000).toISOString();
  const post = await rpcOk('scheduler:add', { post: { title: 'Faith over fear', caption: 'Sunday #faith', mediaPaths: [edited], accountIds: [], platforms: ['tiktok'], scheduledAt: when } });
  const listed = await rpcOk('scheduler:list');
  log(post && post.id && listed.some((x) => x.id === post.id && x.scheduledAt === when), 'a post made on the phone is in the schedule');
  await rpcOk('scheduler:remove', { id: post.id });
  log(!(await rpcOk('scheduler:list')).some((x) => x.id === post.id), 'and can be deleted from it');
  for (const ch of ['accounts:list', 'accounts:connectZo', 'scheduler:publish', 'social:cloudSet']) {
    const g = await rpc(ch, {});
    log(g.status === 403, `"${ch}" (the desk's own) is still refused`, 'status ' + g.status);
  }
  await rpcOk('social:setKeys', { zoApiKey: '' });

  /* ───────────── [I] deleting from a phone ───────────── */
  console.log('\n=== [I] deleting from a phone ===');
  const del = (paths) => request('POST', '/api/delete', {
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth()), body: JSON.stringify({ paths }),
  });
  const keepVideo = path.join(MEDIA, 'sermon.mp4');
  r = await del([outside, keepVideo, path.join(WORK, 'userData', 'workstation.json')]);
  log(r.status === 200 && r.json.deleted.length === 0 && r.json.refused.length === 3 && fs.existsSync(keepVideo),
    'nothing outside exports and uploads can be deleted (the Videos folder is the machine’s own)');
  const planned = await rpcOk('scheduler:add', { post: { title: 'Keep me', mediaPaths: [edited], accountIds: [], platforms: [], scheduledAt: new Date(Date.now() + 86400000).toISOString() } });
  r = await del([edited]);
  log(r.json && r.json.deleted.length === 0 && /planned post/.test((r.json.refused[0] || {}).why || '') && fs.existsSync(edited),
    'a video a planned post still needs is kept, and says why');
  await rpcOk('scheduler:remove', { id: planned.id });
  const cover = edited.replace(/\.mp4$/, '.jpg');
  fs.writeFileSync(cover, 'jpeg');
  r = await del([edited, landed]);
  log(r.json && r.json.deleted.length === 2 && !fs.existsSync(edited) && !fs.existsSync(landed) && !fs.existsSync(cover) && r.json.freed > 0,
    'an export (with its cover picture) and an upload are deleted', (r.json && r.json.freed) + ' bytes freed');
  r = await request('GET', '/api/videos', { headers: auth() });
  log(r.json && r.json.disk && r.json.disk.total > 0 && r.json.canDelete === true, 'the file list says how much room is left');
  const stale = path.join(WORK, 'uploads', '.part-old-abandoned.mp4');
  fs.writeFileSync(stale, Buffer.alloc(2048));
  const old = (Date.now() - 3 * 86400000) / 1000;
  fs.utimesSync(stale, old, old);
  log(cloud.sweepParts() >= 1 && !fs.existsSync(stale), 'an upload given up on days ago is swept away');

  /* ───────────── [J] personal spaces ───────────── */
  // Last, because once there is an account the code alone stops opening the studio.
  console.log('\n=== [J] personal spaces ===');
  const jpost = (p, body, token) => request('POST', p, {
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body),
  });
  const as = async (token, channel, args) => { const keep = TOKEN; TOKEN = token; try { return (await rpc(channel, args)).body || {}; } finally { TOKEN = keep; } };
  const filesOf = async (token) => {
    const g = await request('GET', '/api/videos', { headers: { Authorization: 'Bearer ' + token } });
    return ((g.json && g.json.groups) || []).flatMap((x) => x.files.map((f) => f.path));
  };
  const sendFile = async (token, name, fill) => {
    const b = Buffer.alloc(4096, fill);
    const u = await request('POST', `/api/upload?name=${name}&id=sp${fill}x&size=${b.length}&offset=0`, {
      headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token }, body: b,
    });
    return u.json && u.json.path;
  };
  r = await request('GET', '/api/hello');
  log(r.json && r.json.accounts === 0, 'a studio starts with no accounts');
  r = await jpost('/api/login', { create: true, name: 'Deji', password: 'jesus-is-lord', code: CODE });
  const owner = r.json && r.json.token;
  log(!!owner && r.json.me.owner, 'the first account is the owner’s');
  r = await jpost('/api/login', { create: true, name: 'Ama', password: 'secret12', code: 'wrong-code' });
  log(r.status === 401, 'a new account needs the church access code');
  r = await jpost('/api/login', { create: true, name: 'Ama', password: 'secret12', code: CODE });
  const ama = r.json && r.json.token;
  log(!!ama && !r.json.me.owner, 'someone else makes their own space with the code');
  r = await jpost('/api/login', { create: true, name: 'ama', password: 'secret12', code: CODE });
  log(r.status === 409, 'names are unique');
  r = await login(CODE);
  log(r.status === 401 && r.json.needsAccount, 'the code alone no longer opens the studio');
  r = await request('GET', '/api/videos', { headers: auth() });
  log(r.status === 401, 'and a token from before accounts is signed out');
  r = await jpost('/api/login', { name: 'Ama', password: 'wrong' });
  log(r.status === 401, 'a wrong password is refused');

  const oFile = await sendFile(owner, 'owner-sermon.mp4', 1);
  const aFile = await sendFile(ama, 'ama-clip.mp4', 2);
  log(oFile && aFile && path.dirname(oFile) !== path.dirname(aFile), 'each upload lands in its sender’s own space');
  const oSees = await filesOf(owner), aSees = await filesOf(ama);
  log(oSees.includes(oFile) && !oSees.includes(aFile) && aSees.includes(aFile) && !aSees.includes(oFile),
    'each person’s Files shows only their own work');
  log(!aSees.some((p) => p.startsWith(MEDIA)), 'the server’s Videos folder is the owner’s only');
  r = await request('GET', '/api/media?p=' + encodeURIComponent(oFile), { headers: { Authorization: 'Bearer ' + ama } });
  log(r.status === 403, 'someone else’s file cannot be opened by its address');
  r = await as(ama, 'video:info', { input: oFile });
  log(r.ok === false, 'nor handed to the studio');
  r = await jpost('/api/delete', { paths: [oFile] }, ama);
  log(r.json && r.json.deleted.length === 0 && fs.existsSync(oFile), 'nor deleted');

  await as(owner, 'wordbook:addFix', { from: 'bishop richmond', to: 'Bishop Richman' });
  const wbO = await as(owner, 'wordbook:get', {}), wbA = await as(ama, 'wordbook:get', {});
  log(wbO.data.fixes.some((f) => f.to === 'Bishop Richman') && !wbA.data.fixes.some((f) => f.to === 'Bishop Richman'),
    'each Word Book is its owner’s');
  await as(owner, 'session:autosave', { data: { video: { path: oFile }, name: 'Owner edit', timeline: {} } });
  const asA = await as(ama, 'session:autosaveGet', {});
  log(!(asA.data && asA.data.name === 'Owner edit'), '“Continue editing” is each person’s own');
  const pO = await as(owner, 'paths:get', {}), pA = await as(ama, 'paths:get', {});
  log(pO.data.outputDir && pA.data.outputDir && pO.data.outputDir !== pA.data.outputDir, 'exports go to each person’s own folder');
  const spPost = await as(owner, 'scheduler:add', { post: { title: 'Sunday clip', caption: 'x', scheduledAt: new Date(Date.now() + 864e5).toISOString(), mediaPaths: [oFile] } });
  const listA = await as(ama, 'scheduler:list', {});
  log(!listA.data.some((x) => x.title === 'Sunday clip'), 'planned posts are each person’s own');
  r = await as(ama, 'scheduler:remove', { id: spPost.data.id });
  log(r.ok === false, 'nobody can delete someone else’s post');
  await as(owner, 'scheduler:remove', { id: spPost.data.id });

  const me = (await request('GET', '/api/me', { headers: { Authorization: 'Bearer ' + owner } })).json;
  const amaUid = me.people.find((u) => u.name === 'Ama').uid;
  log(me.people.length === 2 && !(await request('GET', '/api/me', { headers: { Authorization: 'Bearer ' + ama } })).json.people,
    'only the owner sees who has a space');
  r = await jpost('/api/people/reset', { uid: amaUid }, ama);
  log(r.status === 403, 'only the owner can reset a password');
  r = await jpost('/api/people/reset', { uid: amaUid }, owner);
  const temp = r.json && r.json.password;
  log(!!temp && (await request('GET', '/api/videos', { headers: { Authorization: 'Bearer ' + ama } })).status === 401, 'a reset signs that person out');
  r = await jpost('/api/login', { name: 'Ama', password: temp });
  const ama2 = r.json && r.json.token;
  r = await jpost('/api/me/password', { current: temp, password: 'my-own-pass' }, ama2);
  log(!!ama2 && r.json && r.json.ok, 'the new password works, and they can choose their own');
  r = await jpost('/api/people/remove', { uid: amaUid }, owner);
  log(r.json && r.json.ok && (await request('GET', '/api/videos', { headers: { Authorization: 'Bearer ' + ama2 } })).status === 401
    && !fs.existsSync(aFile) && fs.existsSync(oFile), 'removing a space signs them out and deletes only their files');

  /* ───────────── teardown ───────────── */
  cloud.stop();
  let after = null;
  try { after = await request('GET', '/api/hello'); } catch (e) { after = { status: 0 }; }
  log(after.status === 0, 'the server stops cleanly and the port is closed');
}

run()
  .catch((e) => { console.error('\nTEST CRASHED:', e); failed = true; })
  .then(() => {
    const pass = results.filter(Boolean).length;
    console.log(`\n${failed ? '❌' : '✅'} ${pass}/${results.length} checks passed`);
    try { cloud.stop(); } catch (e) {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
    process.exit(failed ? 1 : 0);
  });
