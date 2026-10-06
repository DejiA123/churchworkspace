'use strict';
/*
 * PHONE STUDIO — the Video Studio, on your phone.
 *
 * The editing you do in this app is not really done by the window. It is done
 * by ffmpeg, whisper and MediaPipe on this PC. The window is a remote control
 * that happens to live on the same machine. Once you see it that way, editing a
 * sermon from a phone stops being a port and becomes a second remote control.
 *
 * So that is what this is: an HTTP server on the church wifi that serves a
 * mobile editing surface and forwards its requests into the exact same IPC
 * handlers the desktop uses (src/main/rpc.js). Pick a sermon, scrub it, run
 * Long-to-shorts, fix the captions, export — while the PC does the encoding at
 * full speed and hands the finished vertical clips back for you to save to the
 * camera roll or post. No App Store, no second codebase, no feature drift: a
 * fix to the export pipeline lands on the phone at the same instant.
 *
 * The honest limitation, stated plainly in the UI too: the PC has to be on and
 * reachable. Same wifi is the intended case.
 *
 * ── Security ─────────────────────────────────────────────────────────────
 * This gives a browser the power to run encoders and read media files on this
 * machine, so it is NOT open like the stage-display page is:
 *
 *   • a 6-digit pairing PIN, shown in the app, exchanged once for a token;
 *   • wrong PINs are rate-limited per IP and then locked out;
 *   • only ALLOWLISTED IPC channels can be called — never a shell, a dialog,
 *     the settings (they hold API keys and access tokens), or a file write;
 *   • every path an allowlisted channel is handed must resolve inside one of a
 *     few known media folders, so a stolen token still cannot read C:\Users;
 *   • media is served read-only, by extension, with proper Range support.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const rpc = require('./rpc');

/* ------------------------------------------------------------------ state */

let server = null;
let cfg = {
  port: 7380,
  pin: '',
  allowUpload: true,
  // Where the phone is allowed to read and write. Filled in by start().
  dirs: { output: '', uploads: '', temp: '', videos: '', library: '', ai: '' },
  appVersion: '',
};
const tokens = new Map();     // token -> { at, ip }
const attempts = new Map();   // ip -> { n, until }
let sseClients = new Set();   // open /api/events responses
let uploads = new Map();      // id -> { name, received, total }

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;  // a service, a rehearsal, an evening
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024 * 1024; // a 3-hour 4K service, with room

const PAGE_DIR = path.join(__dirname, '..', 'renderer');

/* -------------------------------------------------------------- allowlist */

/*
 * What a paired phone may ask this PC to do.
 *
 * `true` = allowed as-is. A function = allowed only if it says so (used for the
 * one channel that deletes something). Anything absent is refused, which is
 * why this is a list of names and not a list of prefixes: `video:*` would have
 * quietly admitted the next handler someone adds.
 */
const ALLOWED = {
  // long jobs
  'job:cancel': true,

  // reading and previewing
  'video:info': true,
  'video:presets': true,
  'video:thumbnail': true,
  'video:filmstrip': true,
  'video:waveform': true,
  'video:makeProxy': true,
  'video:setExportPrefs': true,
  'video:mixSounds': true,
  'audio:sfxList': true,
  'audio:sfx': true,
  'audio:saveRecording': true,
  'video:getExportPrefs': true,
  'video:audioSample': true,
  'video:detectSilence': true,
  'video:speechPauses': true,
  'video:extractFrames': true,

  // cutting and rendering
  'video:trim': true,
  'video:export': true,
  'video:extractAudio': true,
  'video:autoTrim': true,
  'video:merge': true,
  'video:joinPieces': true,
  'video:applyEdits': true,
  'video:stabilize': true,
  'video:reverse': true,
  'video:freezeFrame': true,
  'video:overlayComposite': true,
  'video:mixMusic': true,
  'video:appendClips': true,
  'video:captions': true,

  // long → short
  'sermon:analyze': true,
  'sermon:exportShort': true,
  'sermon:exportReframed': true,
  'sermon:exportFramed': true,

  // speech
  'captions:available': true,
  'captions:engineInfo': true,
  'captions:fonts': true,
  'captions:models': true,
  'captions:downloadModel': true,
  'captions:transcribe': true,
  'captions:burn': true,
  // the WYSIWYG caption track (transparent frames drawn by the renderer)
  'captions:burnTrack': true,
  'captions:trackPut': true,
  'captions:fontList': true,

  // text on video
  'overlays:burn': true,
  'overlays:burnImages': true,
  // the bundled typeface bytes the WYSIWYG rasteriser inlines (read-only)
  'fonts:data': true,

  // music beds and outro clips
  'library:list': true,
  'library:add': true,
  'library:remove': true,
  'library:rename': true,
  'youtube:status': true,
  'youtube:search': true,
  'youtube:import': true,

  // Face-tracking samples frames into a temp folder and must tidy up after
  // itself. Recursive delete is far too sharp a tool to hand over unguarded, so
  // this is the one channel with a gate: a temp folder, made by us, and nothing
  // else — not a parent, not a sibling, not a path with `..` in it.
  'fs:rmdir': (args) => {
    const dir = args && args.dir;
    if (!dir || typeof dir !== 'string') return false;
    const full = path.resolve(dir);
    const tmp = path.resolve(cfg.dirs.temp || os.tmpdir());
    if (!within(full, tmp) || full === tmp) return false;
    return /^mw-(frames|thumb|strip|wave|proxy|cap|ovl|ovlpng|pip)-/i.test(path.basename(full));
  },
};

/*
 * WHERE a phone may point. The rule — by argument NAME, recursively, never by
 * "looks like a path" — lives in src/main/path-guard.js, because the Cloud
 * Studio enforces the same one and a security rule with two copies gets fixed
 * once. The allowlist above says WHAT may run; this says WHERE.
 *
 * The roots are read live rather than captured: the output folder can be
 * changed in Settings while this server is up.
 */
const guard = require('./path-guard').makeGuard(() => Object.values(cfg.dirs).filter(Boolean));
const within = require('./path-guard').within;

/* --------------------------------------------------------------- helpers */

/** Every folder the phone may touch. */
const roots = () => guard.roots();
/** True when the path sits inside one of them. */
const allowedPath = (p) => guard.allowedPath(p);
/** The first path argument pointing outside them, or null. */
const checkArgPaths = (value, keyPath, depth) => guard.checkArgPaths(value, keyPath, depth);


const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ass', '.srt']);
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream', '.task': 'application/octet-stream',
  '.ass': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** Every LAN address, so the app can tell the user what to type. */
/*
 * Ranked, and with the unreachable ones dropped. Listing every interface in
 * whatever order Node returned them is why "Phone Studio doesn't work even
 * though I'm on the same wifi" happened: on a laptop with VirtualBox and
 * Hyper-V installed, five of the six addresses offered could never be reached
 * by anything outside this PC. See lan-address.js.
 */
const addresses = () => require('./lan-address').candidates()
  .map((a) => ({ name: a.name, address: a.address, virtual: a.virtual }));
const urls = () => addresses().map((a) => `http://${a.address}:${cfg.port}`);

function send(res, code, type, body, extra) {
  const headers = Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, extra || {});
  res.writeHead(code, headers);
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

function clientIp(req) {
  const a = req.socket && req.socket.remoteAddress;
  return (a || '').replace(/^::ffff:/, '') || 'unknown';
}

/** Read a JSON request body, with a ceiling so a bad actor can't exhaust RAM. */
function readJson(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------- auth */

const newToken = () => crypto.randomBytes(24).toString('hex');

/** Constant-time-ish PIN compare — length is not a secret, the digits are. */
function pinMatches(given) {
  const want = String(cfg.pin || '');
  const got = String(given || '');
  if (!want) return true;                 // no PIN configured = open on the LAN
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function lockedOut(ip) {
  const a = attempts.get(ip);
  return !!(a && a.until && a.until > Date.now());
}
function noteFailure(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= MAX_ATTEMPTS) { a.until = Date.now() + LOCKOUT_MS; a.n = 0; }
  attempts.set(ip, a);
}
const clearFailures = (ip) => attempts.delete(ip);

/** The token from an Authorization header or the `k` query param (EventSource
 *  and <video src> cannot set headers). */
function tokenOf(req, url) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (m) return m[1];
  return url.searchParams.get('k') || '';
}

function authed(req, url) {
  const t = tokenOf(req, url);
  if (!t) return false;
  const rec = tokens.get(t);
  if (!rec) return false;
  if (Date.now() - rec.at > TOKEN_TTL_MS) { tokens.delete(t); return false; }
  rec.at = Date.now();
  return true;
}

/* ----------------------------------------------------------- SSE progress */

/**
 * The sender handed to every RPC call. A handler that reports progress calls
 * `event.sender.send('job:progress', { jobId, percent })`; that lands here and
 * is pushed to every paired phone, which filters by the job ids it started.
 */
const sseSender = {
  send(channel, payload) { push(channel, payload); },
  isDestroyed() { return false; },
};

function push(event, data) {
  if (!sseClients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;
  for (const res of Array.from(sseClients)) {
    try { res.write(frame); } catch (e) { sseClients.delete(res); }
  }
}

/* ------------------------------------------------------------ file serving */

/** Serve a file with Range support — iOS Safari will not scrub without it. */
function sendFile(req, res, full, { download } = {}) {
  let st;
  try { st = fs.statSync(full); } catch (e) { return send(res, 404, 'text/plain', 'not found'); }
  if (!st.isFile()) return send(res, 404, 'text/plain', 'not found');

  const type = mimeOf(full);
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (download) {
    const safe = path.basename(full).replace(/["\\]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${safe}"`;
  }

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start == null && end == null) return send(res, 416, 'text/plain', 'bad range');
    if (start == null) { start = Math.max(0, st.size - end); end = st.size - 1; }   // suffix range
    if (end == null || end >= st.size) end = st.size - 1;
    if (start > end || start >= st.size) {
      return send(res, 416, 'text/plain', 'bad range', { 'Content-Range': `bytes */${st.size}` });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = String(end - start + 1);
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(full, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }

  headers['Content-Length'] = String(st.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(full);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

/** Static asset from the renderer folder (the phone UI itself). */
function sendStatic(req, res, rel) {
  const full = path.normalize(path.join(PAGE_DIR, rel));
  if (!within(full, PAGE_DIR)) return send(res, 403, 'text/plain', 'forbidden');
  let body;
  try { body = fs.readFileSync(full); } catch (e) { return send(res, 404, 'text/plain', 'not found'); }
  return send(res, 200, mimeOf(full), body);
}

/* ------------------------------------------------------- library listings */

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);

function listDir(dir, { limit = 400 } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    if (out.length >= limit) break;
    if (!VIDEO_EXT.has(path.extname(n).toLowerCase())) continue;
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile() || st.size < 1024) continue;
    out.push({ path: full, name: n, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** Everything the phone can open: exports, uploads, and the Videos folder. */
function browse() {
  const seen = new Set();
  const groups = [
    { key: 'output', label: 'Finished exports', dir: cfg.dirs.output },
    { key: 'uploads', label: 'Sent from a phone', dir: cfg.dirs.uploads },
    { key: 'videos', label: 'Videos folder', dir: cfg.dirs.videos },
  ];
  return groups.map((g) => {
    const items = listDir(g.dir).filter((f) => {
      const k = process.platform === 'win32' ? f.path.toLowerCase() : f.path;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => b.mtime - a.mtime);
    return { key: g.key, label: g.label, dir: g.dir, files: items };
  }).filter((g) => g.dir);
}

/* ------------------------------------------------------------- the router */

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return send(res, 400, 'text/plain', 'bad request'); }
  const p = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

  // The phone page is same-origin with the API; nothing here is meant to be
  // callable from another website, so there is deliberately no CORS header.
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');

  /* --- open endpoints ---------------------------------------------------- */

  if (p === '/' || p === '/index.html') return sendStatic(req, res, 'phone.html');
  if (p === '/phone.css' || p === '/phone.js') return sendStatic(req, res, p.slice(1));
  // Auto-reframe on the phone runs the SAME tracker as the desktop, so the
  // crop path a phone export follows is identical to a desktop one.
  if (p === '/facetrack.js') return sendStatic(req, res, 'facetrack.js');

  /*
   * MediaPipe's wasm + models, so auto-reframe can run in the phone's browser.
   *
   * Deliberately OUTSIDE the pairing gate. MediaPipe loads its own runtime by
   * appending relative names to the base URL it is given — it never sees our
   * Authorization header and a `?k=` on the base would be lost the moment it
   * builds `base + '/vision_wasm_internal.js'`. These are Google's own
   * redistributable model files, identical for every install and containing
   * nothing about this church, so serving them unauthenticated on the LAN gives
   * an attacker exactly what a public CDN already would. Everything that touches
   * the user's media stays behind the token below.
   */
  if (p.startsWith('/ai/')) {
    const base = cfg.dirs.ai;
    if (!base) return send(res, 404, 'text/plain', 'ai assets not available');
    const full = path.normalize(path.join(base, decodeURIComponent(p.slice(4))));
    if (!within(full, base)) return send(res, 403, 'text/plain', 'forbidden');
    return sendFile(req, res, full);
  }

  if (p === '/api/hello') {
    return json(res, 200, {
      ok: true,
      name: 'Church Work Space',
      version: cfg.appVersion || '',
      needsPin: !!cfg.pin,
      allowUpload: !!cfg.allowUpload,
      paired: authed(req, url),
    });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (lockedOut(ip)) return json(res, 429, { error: 'Too many wrong PINs. Try again in a few minutes.' });
    let body;
    try { body = await readJson(req, 4096); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!pinMatches(body && body.pin)) { noteFailure(ip); return json(res, 401, { error: 'Wrong PIN.' }); }
    clearFailures(ip);
    const t = newToken();
    tokens.set(t, { at: Date.now(), ip });
    return json(res, 200, { ok: true, token: t, version: cfg.appVersion || '' });
  }

  /* --- everything below needs a paired phone ----------------------------- */

  if (!authed(req, url)) return json(res, 401, { error: 'Pair this phone first.' });

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return undefined;
  }

  if (p === '/api/rpc' && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const channel = body && body.channel;
    const args = (body && body.args) || {};
    const rule = Object.prototype.hasOwnProperty.call(ALLOWED, channel) ? ALLOWED[channel] : undefined;
    if (rule === undefined) {
      return json(res, 403, { ok: false, error: `"${channel}" is not available from a phone.` });
    }
    if (typeof rule === 'function' && !rule(args)) {
      return json(res, 403, { ok: false, error: `"${channel}" refused those arguments.` });
    }
    const badKey = checkArgPaths(args);
    if (badKey) {
      return json(res, 403, { ok: false, error: `That file is outside the folders this phone may use (${badKey}).` });
    }
    const out = await rpc.invoke(channel, args, sseSender);
    // The envelope is passed through untouched — a phone sees exactly what the
    // desktop renderer sees, cancellations included.
    return json(res, 200, out);
  }

  if (p === '/api/media' || p === '/api/file') {
    const target = url.searchParams.get('p') || '';
    if (!allowedPath(target)) return send(res, 403, 'text/plain', 'forbidden');
    if (!MEDIA_EXT.has(path.extname(target).toLowerCase())) return send(res, 403, 'text/plain', 'forbidden');
    return sendFile(req, res, path.resolve(target), { download: p === '/api/file' || url.searchParams.get('dl') === '1' });
  }

  if (p === '/api/videos') return json(res, 200, { ok: true, groups: browse() });

  if (p === '/api/presets') {
    const out = await rpc.invoke('video:presets', {}, sseSender);
    return json(res, 200, out);
  }

  if (p === '/api/upload' && (req.method === 'POST' || req.method === 'PUT')) {
    if (!cfg.allowUpload) return json(res, 403, { error: 'Uploads from phones are switched off.' });
    return receiveUpload(req, res, url);
  }

  if (p === '/api/uploads') return json(res, 200, { ok: true, active: Array.from(uploads.values()) });

  return send(res, 404, 'text/plain', 'not found');
}

/* ------------------------------------------------------- upload from phone */

/**
 * Straight binary upload: the body IS the file. No multipart parsing, because
 * a 4 GB service recording should stream to disk a chunk at a time rather than
 * be assembled in memory, and `fetch(file)` from the phone already sends it
 * that way. The name rides in the query string, sanitised hard.
 */
function receiveUpload(req, res, url) {
  const raw = url.searchParams.get('name') || 'upload.mp4';
  const total = Number(req.headers['content-length'] || 0) || 0;
  if (total > MAX_UPLOAD_BYTES) return json(res, 413, { error: 'That file is too big to send over wifi.' });

  const cleaned = path.basename(raw).replace(/[^\w.\- ()]+/g, '_').slice(0, 80) || 'upload.mp4';
  const ext = path.extname(cleaned).toLowerCase();
  if (!VIDEO_EXT.has(ext) && !MEDIA_EXT.has(ext)) return json(res, 400, { error: 'Only video and audio files can be sent.' });

  const dir = cfg.dirs.uploads;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const full = path.join(dir, `${stamp}-${cleaned}`);
  const id = crypto.randomBytes(6).toString('hex');
  const rec = { id, name: cleaned, received: 0, total };
  uploads.set(id, rec);

  const out = fs.createWriteStream(full);
  let failed = false;
  const fail = (msg, code) => {
    if (failed) return;
    failed = true;
    uploads.delete(id);
    try { out.destroy(); } catch (e) {}
    try { fs.rmSync(full, { force: true }); } catch (e) {}
    if (!res.headersSent) json(res, code || 500, { error: msg });
  };

  req.on('data', (c) => {
    rec.received += c.length;
    if (rec.received > MAX_UPLOAD_BYTES) { req.destroy(); return fail('That file is too big to send over wifi.', 413); }
    // Progress rides the same channel the phone already listens on for exports.
    if (total) push('upload:progress', { id, name: cleaned, percent: Math.round((rec.received / total) * 100) });
  });
  req.on('aborted', () => fail('Upload interrupted.'));
  req.on('error', () => fail('Upload failed.'));
  out.on('error', (e) => fail('Could not save the file: ' + e.message));
  req.pipe(out);
  out.on('close', () => {
    if (failed) return;
    uploads.delete(id);
    if (!rec.received) { try { fs.rmSync(full, { force: true }); } catch (e) {} return json(res, 400, { error: 'Nothing was sent.' }); }
    push('upload:progress', { id, name: cleaned, percent: 100, done: true, path: full });
    json(res, 200, { ok: true, path: full, name: path.basename(full), size: rec.received });
  });
}

/* ---------------------------------------------------------------- control */

/** A PIN people can read off a screen and type on a phone without mistakes. */
function makePin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function start(opts = {}) {
  cfg = Object.assign({}, cfg, opts, { dirs: Object.assign({}, cfg.dirs, opts.dirs || {}) });
  if (!cfg.pin) cfg.pin = makePin();
  if (server) stop();
  for (const d of [cfg.dirs.uploads]) { if (d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} } }
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        try { json(res, 500, { error: (e && e.message) || 'server error' }); } catch (er) {}
      });
    });
    // Sermon exports can run for many minutes with no bytes moving on the RPC
    // socket. Node's default 5-minute headers/request timeouts would cut them.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;
    server.keepAliveTimeout = 65000;
    server.on('error', (e) => {
      server = null;
      reject(new Error(e.code === 'EADDRINUSE'
        ? `Port ${cfg.port} is already in use — pick another one in Settings.`
        : 'Could not start Phone Studio: ' + e.message));
    });
    server.listen(cfg.port, '0.0.0.0', () => resolve(state()));
  });
}

function stop() {
  for (const res of Array.from(sseClients)) { try { res.end(); } catch (e) {} }
  sseClients.clear();
  tokens.clear();
  uploads.clear();
  if (server) { try { server.close(); } catch (e) {} server = null; }
  return true;
}

const isRunning = () => !!server;

function state() {
  return {
    running: isRunning(),
    port: cfg.port,
    pin: cfg.pin,
    allowUpload: !!cfg.allowUpload,
    urls: urls(),
    addresses: addresses(),
    paired: tokens.size,
    dirs: cfg.dirs,
  };
}

/** Roll the PIN — every paired phone has to pair again. */
function resetPin(pin) {
  cfg.pin = pin || makePin();
  tokens.clear();
  attempts.clear();
  return cfg.pin;
}

module.exports = {
  start, stop, isRunning, state, resetPin, addresses, urls, browse,
  // exported for tests
  ALLOWED, within, allowedPath, checkArgPaths, makePin, _cfg: () => cfg,
};
