'use strict';
/*
 * CLOUD STUDIO — the Video Studio, from anywhere in the world, in a browser.
 *
 * Phone Studio (src/main/mobile-api.js) proved the idea on the church wifi: the
 * editing is not done by the window, it is done by ffmpeg and whisper on a
 * machine, and a window is only a remote control. This takes that the whole way:
 *
 *   • the page it serves is the REAL Video Studio, generated from the desktop's
 *     own index.html (see page.js) — not a mobile subset that drifts;
 *   • it is a PWA, so it installs to a home screen and opens like an app;
 *   • it runs in two places without changing a line of the studio:
 *       – HOSTED:     inside the desktop app, reachable over the internet
 *                     through a tunnel (see tunnel.js). Your PC does the work,
 *                     at full speed, with the models you already downloaded.
 *       – STANDALONE: `node src/cloud/server.js` on a server, with the desktop
 *                     switched off. Same handlers, no Electron (see server.js).
 *
 * ── Security ─────────────────────────────────────────────────────────────
 * Phone Studio faces a church hall. This faces the internet, so it is tighter:
 *
 *   • an access code that is words, not six digits — a 6-digit PIN is 10^6 and
 *     the internet has all day. Wrong codes are rate-limited per IP and then
 *     locked out, and a lockout is announced rather than silently absorbed.
 *   • only ALLOWLISTED channels run, by exact name, never by prefix — so the
 *     next handler somebody adds is refused until it is considered here.
 *     Deliberately absent: settings (API keys, social tokens), accounts, shell,
 *     dialog, the live and presentation studios, and any general file write.
 *   • every path argument must resolve inside a few known media folders
 *     (src/main/path-guard.js), so a stolen token still cannot read C:\Users.
 *   • `paths:get` is RESHAPED on the way out: the page needs the output and
 *     fonts folders; it has no business learning where userData is.
 *   • media is served read-only, by extension, with Range support.
 *
 * ── Why the RPC has a binary mode ────────────────────────────────────────
 * WYSIWYG captions rasterise hundreds of transparent PNG frames in the browser
 * and hand them to ffmpeg — that is what makes the preview and the export the
 * same thing. A Uint8Array through JSON.stringify becomes {"0":137,"1":80,…}:
 * about 6x the bytes and a parse that allocates an object per pixel byte. So
 * this speaks a small binary envelope when there are bytes to carry, and plain
 * JSON when there are not.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const rpc = require('../main/rpc');
const space = require('../main/space');
const { makeGuard, within } = require('../main/path-guard');
const page = require('./page');

/* ------------------------------------------------------------------ state */

let server = null;
let cfg = {
  port: 7390,
  host: '0.0.0.0',
  code: '',                 // the access code, as the operator reads it out
  allowUpload: true,
  publicUrl: '',            // filled in by the tunnel, shown in the app
  appVersion: '',
  // Where signed-in devices are remembered across a restart (see loadTokens).
  // Defaults to sitting beside the uploads folder when the host does not say.
  tokenFile: '',
  maxUploadBytes: 16 * 1024 * 1024 * 1024,
  dirs: { output: '', uploads: '', temp: '', videos: '', library: '', ai: '', fonts: '', sessions: '' },
};

const tokens = new Map();     // token -> { at, ip, ttl, agent }
const attempts = new Map();   // ip -> { n, until }
const sseClients = new Set();
const uploads = new Map();    // id -> { name, received, total, path }
const sockets = new Set();    // every open connection, so stop() can hang up
let started = 0;
let lastActive = 0;   // the last time a person did something (see /api/idle)
const QUIET_API = new Set(['/api/idle', '/api/hello', '/api/events', '/api/status']);

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;          // an evening's editing
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;    // "keep me signed in"
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

/*
 * WHERE THIS PERSON MAY POINT. The owner (and a studio with no accounts yet)
 * keeps every folder the studio was started with. Anyone else gets their own
 * exports, uploads, library and sessions (space.js), plus the read-only things
 * every page needs — fonts, the AI assets, the temp folder the studio works
 * in — and never the server's Videos folder or another person's space.
 */
function dirsFor(id) {
  const d = cfg.dirs;
  const who = id === undefined ? space.current() : id;
  if (!who) return d;
  return {
    output: space.pathFor(d.output, who), uploads: space.pathFor(d.uploads, who),
    library: space.pathFor(d.library, who), sessions: space.pathFor(d.sessions, who),
    temp: d.temp, fonts: d.fonts, ai: d.ai, videos: '',
  };
}
const guard = makeGuard(() => Object.values(dirsFor()).filter(Boolean));
const allowedPath = (p) => guard.allowedPath(p);
/* the narrator samples being made (one at a time per voice) and the line they say */
const voiceSampling = new Map();
const VOICE_SAMPLE_LINE = 'What you are about to hear could change your life. Stay with me to the end — and share it with someone who needs it today.';

/* -------------------------------------------------------------- allowlist */

/*
 * THE SOCIAL SCHEDULER, FROM A PHONE.
 *
 * The posts, and the linked accounts WITHOUT their keys. A Zernio key can be
 * set from here but never read back (social:setKeys answers "is one set", and
 * nothing else); the desk's own accounts:* and settings:* channels stay
 * refused, and so does the one-tap publish, which opens windows on the machine.
 * Media paths on a post go through the same folder guard as every other path
 * (path-guard.js knows `mediaPaths`). MW_CLOUD_SOCIAL=off leaves all of it out.
 */
const SOCIAL_ON = String(process.env.MW_CLOUD_SOCIAL || 'on').toLowerCase() !== 'off';
const SOCIAL = {
  'scheduler:list': true,
  'scheduler:add': true,
  'scheduler:update': true,
  'scheduler:remove': true,
  'scheduler:publishAuto': true,
  'scheduler:retry': true,
  'scheduler:plans': true,
  'social:accounts': true,
  'social:setKeys': true,
  'social:linkStart': true,
  'social:linkClaim': true,
  // one tap: every sign-in in turn (main.js); setupNext is reached only through /social/next/<code>
  'social:setupStart': { args: (a) => !a || a.platforms == null || (Array.isArray(a.platforms) && a.platforms.every((p) => typeof p === 'string')) },
  'social:setupStatus': { args: (a) => !!a && typeof a.code === 'string' && /^[0-9a-f]{36}$/.test(a.code) },
  'social:unlink': true,
  'social:check': true,
  'social:suggestCopy': true,
  'social:withMusic': true,
};

/**
 * What a signed-in browser may ask the studio machine to do.
 *
 * `true`               — allowed as it stands.
 * `{ args, result }`   — allowed, with the arguments vetted and/or the answer
 *                        reshaped before it leaves the machine.
 *
 * This is a list of NAMES. `video:*` would quietly admit tomorrow's handler.
 */
/* Channels that change something every person on the server shares. */
const OWNER_ONLY = new Set(['captions:removeModel', 'captions:downloadModel', 'llm:install']);

const ALLOWED = {
  'job:cancel': true,

  // what the page needs to know about this machine — and nothing more
  'paths:get': {
    result: (r) => ({
      outputDir: r && r.outputDir,
      fontsDir: r && r.fontsDir,
      appVersion: r && r.appVersion,
    }),
  },

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
  'audio:say': true,
  'audio:voices': true,
  'audio:saveRecording': true,
  'video:getExportPrefs': true,
  'video:audioSample': true,
  'video:detectSilence': true,
  'video:speechPauses': true,
  'video:extractFrames': true,
  'video:attachThumb': true,

  // cutting, rendering, finishing
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
  'video:phoneCopy': true,
  'video:phoneCopyStatus': true,
  'video:captions': true,

  // long → short
  'sermon:analyze': true,
  'batch:open': true,
  'batch:add': true,
  'batch:seal': true,
  'batch:list': true,
  'batch:cancel': true,
  'machine:info': true,
  'montage:status': true,
  'montage:create': true,
  'montage:project': true,
  'montage:remake': true,
  'sermon:exportShort': true,
  'sermon:exportReframed': true,
  'sermon:exportFramed': true,

  // speech, captions, the word book
  'captions:available': true,
  'captions:engineInfo': true,
  'captions:fonts': true,
  'captions:fontList': true,
  'diag:crash': true,
  'captions:models': true,
  'captions:downloadModel': true,
  'captions:removeModel': true,
  'captions:transcribe': true,
  'captions:burn': true,
  'captions:burnTrack': true,
  'captions:trackPut': true,
  // ☁️ which ear is available, and the ✍ AI proof-reader. NOT captions:cloudKey —
  // a key is pasted at the desk, never set from the internet.
  'captions:cloud': true,
  'social:cloudState': true,      // is the cloud AI judge set up (a yes/no, never the key) — the long-to-shorts picker
  'captions:grammar': true,
  // 🎯 the reframe's eye (asks with the desk's key; the key itself never travels)
  'reframe:aiState': true,
  'reframe:whoIsSpeaking': true,

  // The Word Book — the words this church's captions keep getting wrong.
  'wordbook:get': true,
  'wordbook:options': true,
  'wordbook:addFix': true,
  'wordbook:updateFix': true,
  'wordbook:removeFix': true,
  'wordbook:addTerm': true,
  'wordbook:removeTerm': true,
  'wordbook:learn': true,
  'wordbook:tidy': true,

  // text and pictures on the video
  'overlays:burn': true,
  'overlays:burnImages': true,
  'fonts:data': true,

  // the AI clip reader (a download the operator chooses)
  'llm:status': true,
  'llm:install': true,

  // saved sessions — pick the edit up where it was put down
  'session:list': true,
  'session:save': true,
  'session:load': true,
  'session:remove': true,
  'session:rename': true,
  'session:autosave': true,
  'session:autosaveGet': true,
  'session:autosaveClear': true,
  'session:export': true,
  'session:import': true,

  // music beds, outros, and the YouTube importer they come from
  'library:list': true,
  'library:add': true,
  'library:remove': true,
  'library:rename': true,
  'music:free': true,
  'music:freeGet': true,
  'youtube:status': true,
  'youtube:install': true,
  'youtube:search': true,
  'youtube:import': true,

  // pictures the editor reads and writes (data URLs, under the media roots)
  'fs:readImageDataUrl': true,
  'fs:writeImageDataUrl': true,

  // 🗓 the Social Scheduler — see SOCIAL below; added unless switched off
  ...(SOCIAL_ON ? SOCIAL : {}),

  /*
   * Frame sampling for auto-reframe leaves a temp folder behind and must tidy
   * up. Recursive delete is far too sharp to hand over unguarded, so this is
   * the one channel with a gate: a temp folder, made by us, named the way we
   * name them — not a parent, not a sibling, nothing with `..` in it.
   */
  'fs:rmdir': {
    args: (a) => {
      const dir = a && a.dir;
      if (!dir || typeof dir !== 'string') return false;
      const full = path.resolve(dir);
      const tmp = path.resolve(cfg.dirs.temp || os.tmpdir());
      if (!within(full, tmp) || full === tmp) return false;
      return /^mw-(frames|thumb|strip|wave|proxy|cap|ovl|ovlpng|pip)-/i.test(path.basename(full));
    },
  },
};

/* ------------------------------------------------------------ mime / files */

const MEDIA_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi',
  '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus', '.wma',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.ass', '.srt', '.vtt', '.json',
  '.ttf', '.otf', '.woff', '.woff2',
]);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus', '.wma']);
// what the file chooser may list when the studio asks for something other than
// a video (a song for the music library, a picture for a cover)
const PICKABLE_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, '.png', '.jpg', '.jpeg', '.gif', '.webp']);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.tflite': 'application/octet-stream', '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

const WEB_DIR = path.join(__dirname, 'web');

/* ------------------------------------------------------------- responding */

/* The page "Set up everything" ends on: what was linked, and what was not and why. */
const SETUP_NAMES = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };
function setupPage(r) {
  const h = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let title, body = '';
  if (r && r.expired) {
    title = 'This link has run out';
    body = '<p>Go back to the studio and tap <b>Set up everything</b> again.</p>';
  } else if (r && r.done) {
    const res = r.results || [];
    const good = res.filter((x) => x.ok), bad = res.filter((x) => !x.ok);
    title = good.length && !bad.length ? 'All set' : good.length ? 'Nearly there' : 'Nothing was connected';
    body = '<ul>' + res.map((x) => `<li class="${x.ok ? 'ok' : 'no'}"><b>${h(SETUP_NAMES[x.platform] || x.platform)}${x.another ? ' (2nd page)' : ''}</b> ${x.ok ? '✓ ' + h(x.name || 'connected') : '— ' + h(x.error || 'not connected')}</li>`).join('') + '</ul>'
      + (bad.some((x) => x.needSecondKey) ? '<p class="tip"><b>Still free:</b> each free Zernio account holds 2 accounts. Make a second free Zernio account (another email), go back to the studio and tap <b>Paste second key</b> — then <b>Set up everything</b> again. Only what is missing is asked for.</p>'
        : bad.some((x) => x.full) ? '<p class="tip">Both free Zernio accounts are full (2 each). Remove one you don’t use, or turn on billing at <a href="https://zernio.com" target="_blank" rel="noopener">zernio.com</a>.</p>' : '')
      + (bad.length && !bad.some((x) => x.full) ? '<p class="tip">Tap <b>Set up everything</b> again for anything not connected — only what is missing is asked for.</p>' : '');
  } else {
    title = 'That did not work';
    body = `<p>${h((r && r.error) || 'Something went wrong')}</p>`;
  }
  const back = r && r.back ? `<a class="go" href="${h(r.back)}">Back to the studio</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${h(title)}</title><style>
:root{color-scheme:dark}body{margin:0;background:#0b0b12;color:#f5f5f7;font:17px/1.45 -apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:440px;padding:28px 22px}h1{font-size:26px;margin:0 0 14px}ul{list-style:none;padding:0;margin:0 0 16px}li{padding:12px 14px;border-radius:14px;background:#1a1a24;margin:8px 0}
li.ok b{color:#86efac}li.no b{color:#fca5a5}.tip{color:#c4c4cc;font-size:15px}a{color:#c4b5fd}
.go{display:block;text-align:center;margin-top:18px;padding:14px;border-radius:14px;background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;font-weight:700;text-decoration:none}
small{display:block;text-align:center;color:#8b8b96;margin-top:10px}</style></head>
<body><main><h1>${h(title)}</h1>${body}${back}${back ? '<small>Or just close this page — the studio has it already.</small>' : ''}</main></body></html>`;
}

function send(res, code, type, body, extra) {
  const headers = Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // This page is nobody's frame, and nothing here is meant to be called from
    // another website — there is deliberately no CORS header anywhere.
    'X-Frame-Options': 'SAMEORIGIN',
  }, extra || {});
  res.writeHead(code, headers);
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

function clientIp(req) {
  // Behind a tunnel or a reverse proxy the socket address is the proxy's. The
  // forwarded address is only as trustworthy as whatever set it, which is why
  // it is used for RATE LIMITING and nothing else.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const a = fwd || (req.socket && req.socket.remoteAddress) || '';
  return a.replace(/^::ffff:/, '') || 'unknown';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------------------------------------------- the binary envelope */

/*
 * MWRPC1 — one JSON header, then the bytes.
 *
 *   'MWRPC1' | headerLength (uint32 BE) | header JSON | blob0 | blob1 | …
 *
 * Inside the header, every binary value has been replaced by {"__bin": i} and
 * its length recorded in `bins`. Rebuilding is a slice, not a parse, so a
 * caption track of 400 PNG frames costs one allocation each instead of one per
 * byte. The same shape travels in both directions.
 */
const MAGIC = Buffer.from('MWRPC1');

function encodeEnvelope(payload) {
  const bins = [];
  const swap = (v, depth = 0) => {
    if (depth > 12 || v == null) return v;
    if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) {
      const b = Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      bins.push(b);
      return { __bin: bins.length - 1 };
    }
    if (v instanceof ArrayBuffer) { bins.push(Buffer.from(v)); return { __bin: bins.length - 1 }; }
    if (Array.isArray(v)) return v.map((x) => swap(x, depth + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = swap(v[k], depth + 1);
      return out;
    }
    return v;
  };
  const head = swap(payload);
  // Nothing to carry beside the JSON? Then it IS just JSON. Framing a plain
  // answer and labelling it application/json is how the first version of this
  // handed the browser a body starting "MWRPC1" and asked it to JSON.parse it.
  if (!bins.length) return { body: Buffer.from(JSON.stringify(head), 'utf-8'), binary: false };
  head.__bins = bins.map((b) => b.length);
  const headBuf = Buffer.from(JSON.stringify(head), 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headBuf.length, 0);
  return { body: Buffer.concat([MAGIC, len, headBuf, ...bins]), binary: bins.length > 0 };
}

function decodeEnvelope(buf) {
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    return JSON.parse(buf.toString('utf-8'));
  }
  const headLen = buf.readUInt32BE(MAGIC.length);
  const headStart = MAGIC.length + 4;
  const head = JSON.parse(buf.subarray(headStart, headStart + headLen).toString('utf-8'));
  const lens = head.__bins || [];
  const blobs = [];
  let at = headStart + headLen;
  for (const n of lens) { blobs.push(buf.subarray(at, at + n)); at += n; }
  delete head.__bins;
  const swap = (v, depth = 0) => {
    if (depth > 12 || v == null) return v;
    if (Array.isArray(v)) return v.map((x) => swap(x, depth + 1));
    if (typeof v === 'object') {
      if (typeof v.__bin === 'number') return blobs[v.__bin] || Buffer.alloc(0);
      const out = {};
      for (const k of Object.keys(v)) out[k] = swap(v[k], depth + 1);
      return out;
    }
    return v;
  };
  return swap(head);
}

/* ------------------------------------------------------------------- auth */

/*
 * An access code somebody can read down a phone line and type on a handset,
 * that is still far out of reach of the internet's patience: two words from a
 * 256-word list and four digits is ~6.5e8 combinations, against 8 tries per
 * quarter of an hour. Words, because "is that a five or an S" has lost more
 * services than any attacker ever will.
 */
const WORDS = ('amen anchor angel anthem arbour arrow autumn banner beacon bell bible bless bridge bright brook candle canvas carol cedar chapel choir chorus cloud coast comfort copper coral cradle crown crystal dawn deacon delta dove ember empire eagle east elder ember faith falcon feast fern field flame flint forest fountain garden gate gentle giver glade glory grace grain granite green grove harbour harvest haven hearth heaven herald hill holly honey hope horizon hymn iris iron island ivory jasper joy jubilee juniper keeper kindle lamp lantern laurel light lily linen lion loaf lotus maple marble meadow mercy mercy mirror morning mountain music myrrh nectar noble north oak oasis olive onyx opal orchard organ palm parish pasture peace pearl pilgrim pillar pine plain praise prairie prayer psalm pulpit quarry quiet rain raven reed refuge rescue ridge river robin rock rose sabbath saffron sage sail saint sanctuary sapphire scroll sea season shelter shepherd shore silver simple sky slate solid song sparrow spirit spring stable star steeple stone stream summer sunrise sunset sweet table temple thicket thrive throne thunder tide timber torch tower trellis trinity trumpet truth valley velvet verse vessel vigil village vine violet voice walnut watch water wheat whisper willow window wine wing winter wisdom witness wonder wood wool worship wren yield zion').split(/\s+/);

function makeCode() {
  const w = () => WORDS[crypto.randomInt(0, WORDS.length)];
  return `${w()}-${w()}-${String(crypto.randomInt(0, 10000)).padStart(4, '0')}`;
}

const newToken = () => crypto.randomBytes(32).toString('base64url');

/* ------------------------------------------------------------- accounts
 *
 * EVERYONE HAS THEIR OWN SPACE. A name and a password, and behind it a space
 * of their own (src/main/space.js): their uploads, exports, saved sessions,
 * Word Book, library and posts, and nobody else's.
 *
 *   • Making a space needs the church's access code, so a stranger who finds
 *     the address cannot just sign themselves up.
 *   • The FIRST space made on a server is the owner's. It keeps the folders the
 *     studio already had, so nothing that was there before is lost or moved,
 *     and the owner can reset a forgotten password or remove a space.
 *   • Passwords are stored as scrypt hashes with their own salt, never as text.
 *   • Until the first space exists, the access code alone still opens the
 *     studio as the owner, so an installed app keeps working through the
 *     update. After that, signing in is by name and password.
 */
let users = [];          // [{ uid, name, salt, hash, owner, space, createdAt }]
const usersFile = () => (cfg.dirs.uploads ? path.join(path.dirname(cfg.dirs.uploads), 'cloud-users.json') : '');
function loadUsers() {
  users = [];
  const f = usersFile(); if (!f) return;
  try { const raw = JSON.parse(fs.readFileSync(f, 'utf-8')); if (Array.isArray(raw.users)) users = raw.users.filter((u) => u && u.uid && u.hash); } catch (e) {}
}
function saveUsers() {
  const f = usersFile(); if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch (e) { console.warn('[cloud] could not save accounts: ' + e.message); }
}
const nameKey = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
const hashPass = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function checkPass(u, pw) {
  try {
    const a = Buffer.from(hashPass(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function setPass(u, pw) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPass(pw, u.salt); }
const userById = (uid) => users.find((u) => u.uid === uid) || null;
const userByName = (n) => users.find((u) => nameKey(u.name) === nameKey(n)) || null;
const publicUser = (u) => (u ? { uid: u.uid, name: u.name, owner: !!u.owner, createdAt: u.createdAt } : null);
function makeUser(name, pw) {
  const owner = !users.length;
  const u = {
    uid: crypto.randomBytes(8).toString('hex'),
    name: String(name).trim().replace(/\s+/g, ' ').slice(0, 40),
    owner,
    // the owner keeps the studio's original folders; anyone else gets a space
    space: owner ? null : crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  setPass(u, pw);
  users.push(u);
  saveUsers();
  return u;
}
/** The person behind a request's token, or null (a studio with no accounts yet: the owner). */
function userOf(req, url) {
  const rec = tokens.get(tokenOf(req, url));
  return rec && rec.uid ? userById(rec.uid) : null;
}

/** Constant-time compare that does not leak the length either. */
function codeMatches(given) {
  const want = String(cfg.code || '');
  const got = String(given || '');
  if (!want) return false;                       // never open — this faces the world
  const a = crypto.createHash('sha256').update(want).digest();
  const b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

/*
 * SIGNED IN, AND STILL SIGNED IN AFTER A RESTART.
 *
 * Tokens used to live only in memory, which is fine for Phone Studio — that
 * server goes down when the app closes and the phone is in the same building
 * anyway. A cloud server is different: it restarts for an update, a reboot, a
 * crash, a container moving. If a restart signed everybody out, "keep me signed
 * in on this device" would be a promise the software could not keep, and the
 * access code would end up written on a wall somewhere because people were
 * typing it every day.
 *
 * So the live tokens go to a file beside the data. They are random bearer
 * tokens, no different in kind from the session cookie any website writes;
 * expired ones are dropped on the way in and on the way out, and rolling the
 * access code still clears every one of them.
 */
function tokenFile() {
  return cfg.tokenFile || (cfg.dirs.uploads ? path.join(path.dirname(cfg.dirs.uploads), 'cloud-sessions.json') : '');
}

function loadTokens() {
  const f = tokenFile();
  if (!f) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) { return; }
  if (!raw || raw.code !== codeFingerprint()) return;   // the code changed: everyone signs in again
  const now = Date.now();
  for (const [t, rec] of Object.entries(raw.tokens || {})) {
    if (rec && now - rec.at <= (rec.ttl || SESSION_TTL_MS)) tokens.set(t, rec);
  }
}

let saveTimer = null;

/** Write the live sessions out now. */
function writeTokens() {
  const f = tokenFile();
  if (!f) return;
  clearTimeout(saveTimer); saveTimer = null;
  const now = Date.now();
  const out = {};
  for (const [t, rec] of tokens) if (now - rec.at <= (rec.ttl || SESSION_TTL_MS)) out[t] = rec;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ code: codeFingerprint(), tokens: out }), 'utf-8');
  } catch (e) { /* a server that cannot remember sessions still works */ }
}

/**
 * Write a moment later, so a burst of sign-ins is one write.
 *
 * The debounce has to be FLUSHED on the way down, not just cancelled: a sign-in
 * followed straight away by a restart used to leave the pending write to fire
 * after `stop()` had cleared the map — so the file was written EMPTY and the
 * device that had just signed in was signed out by the restart it was meant to
 * survive. Same bargain as store.js: write late, but never lose a write.
 */
function saveTokens() {
  if (!tokenFile()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeTokens, 250);
}

/** Enough of the code to notice it changed, never enough to be the code. */
const codeFingerprint = () => crypto.createHash('sha256').update('mwcloud|' + String(cfg.code || '')).digest('hex').slice(0, 16);

const lockedOut = (ip) => {
  const a = attempts.get(ip);
  return !!(a && a.until && a.until > Date.now());
};
const lockoutLeft = (ip) => {
  const a = attempts.get(ip);
  return a && a.until ? Math.max(0, Math.ceil((a.until - Date.now()) / 60000)) : 0;
};
function noteFailure(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= MAX_ATTEMPTS) { a.until = Date.now() + LOCKOUT_MS; a.n = 0; }
  attempts.set(ip, a);
}
const clearFailures = (ip) => attempts.delete(ip);

function tokenOf(req, url) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (m) return m[1];
  // EventSource, <video src> and <img src> cannot set a header.
  return url.searchParams.get('k') || '';
}

function authed(req, url) {
  const t = tokenOf(req, url);
  if (!t) return false;
  const rec = tokens.get(t);
  if (!rec) return false;
  if (Date.now() - rec.at > (rec.ttl || SESSION_TTL_MS)) { tokens.delete(t); return false; }
  // A device signed in with the code alone, from before there were accounts,
  // has to sign in properly once there are; a removed person is signed out.
  if (users.length && !(rec.uid && userById(rec.uid))) { tokens.delete(t); return false; }
  rec.at = Date.now();
  return true;
}

/* ----------------------------------------------------------- SSE progress */

/**
 * The sender every RPC call is handed. A handler reporting progress calls
 * `event.sender.send('job:progress', …)`; it lands here and goes out to every
 * signed-in browser, which filters by the job ids it started.
 */
const sseSender = {
  send(channel, payload) { push(channel, payload); },
  isDestroyed() { return false; },
};

/*
 * Each browser's event stream belongs to a space, and an event goes only to
 * the space it is about: the one whose request raised it, or the one named in
 * `opts.space`. `opts.all` is for events that say nothing about anybody's work
 * (a list somewhere changed; each page re-reads its own).
 */
function push(event, data, opts = {}) {
  if (!sseClients.size) return;
  const target = Object.prototype.hasOwnProperty.call(opts, 'space') ? (opts.space || null) : space.current();
  const frame = `event: ${event}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;
  for (const res of Array.from(sseClients)) {
    if (!opts.all && (res._mwSpace || null) !== target) continue;
    try { res.write(frame); } catch (e) { sseClients.delete(res); }
  }
}

/* ------------------------------------------------- calls that outlive a request */

/*
 * ►► AN EXPORT DOES NOT HANG ON ONE HTTP REQUEST. ◄◄
 *
 * A call used to be one POST that stayed open until the work was done, and a
 * service-length export is many minutes of that request saying nothing. On a
 * phone that does not survive: the screen locks, the app goes behind another
 * one, the signal drops in the car park, a proxy on the way gives up on a
 * silent connection. Every one of those threw away the ANSWER, so the export
 * finished on the server and the phone said it had failed (and never offered
 * the file).
 *
 * So the page names each call (`X-MW-Call`) and the server keeps its answer:
 *   • a call that finishes within HOLD_MS answers on the same request, as before;
 *   • a longer one answers 202 "still working", and the page asks
 *     `/api/rpc/wait?call=` (each ask waits up to HOLD_MS) until it is done;
 *   • a page that lost the connection simply asks again when it is back, and a
 *     repeat of the POST itself attaches to the call already running.
 * Answers are kept for a while after they finish, in case the one sent was lost.
 */
const HOLD_MS = +process.env.MW_CALL_HOLD_MS || 20000; // (tests shorten it)
const KEEP_MS = 6 * 3600000;       // a finished answer nobody has collected (a phone left locked)
const KEEP_AFTER_READ_MS = 120000; // …and one that was sent, in case it was lost
const calls = new Map();
const validCallId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
const callKey = (me, id) => (validCallId(id) ? ((me && me.uid) || '-') + ':' + id : null);

function trackCall(key, work) {
  const c = { done: false, enc: null, waiters: new Set(), timer: null };
  calls.set(key, c);
  const expire = (ms) => { clearTimeout(c.timer); c.timer = setTimeout(() => calls.delete(key), ms); if (c.timer.unref) c.timer.unref(); };
  c.expire = expire;
  work.then((out) => {
    c.enc = encodeEnvelope(out);
    c.done = true;
    expire(KEEP_MS);
    for (const w of Array.from(c.waiters)) w();
  });
  return c;
}

function answerCall(c, req, res) {
  const reply = () => {
    if (res.writableEnded) return;
    // a quick answer is forgotten soon; a long job's is kept in case it was lost
    c.expire(c.long ? KEEP_AFTER_READ_MS : 15000);
    send(res, 200, c.enc.binary ? 'application/x-mw-rpc' : 'application/json; charset=utf-8', c.enc.body);
  };
  if (c.done) return reply();
  let t = null;
  const w = () => { clearTimeout(t); c.waiters.delete(w); reply(); };
  c.waiters.add(w);
  t = setTimeout(() => { c.waiters.delete(w); c.long = true; if (!res.writableEnded) json(res, 202, { pending: true }); }, HOLD_MS);
  res.on('close', () => { clearTimeout(t); c.waiters.delete(w); });
  return undefined;
}

/* ------------------------------------------------------------ file serving */

/** Serve a file with Range support — no phone browser will scrub without it. */
function sendFile(req, res, full, { download, cache } = {}) {
  let st;
  try { st = fs.statSync(full); } catch (e) { return send(res, 404, 'text/plain', 'not found'); }
  if (!st.isFile()) return send(res, 404, 'text/plain', 'not found');

  const headers = {
    'Content-Type': mimeOf(full),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache || 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (download) {
    const safe = path.basename(full).replace(/["\\]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${safe}"`;
  }

  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim());
  if (m) {
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start == null && end == null) return send(res, 416, 'text/plain', 'bad range');
    if (start == null) { start = Math.max(0, st.size - end); end = st.size - 1; }
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

/** One of the cloud page's own assets. */
function sendWeb(req, res, rel, cache) {
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!within(full, WEB_DIR)) return send(res, 403, 'text/plain', 'forbidden');
  return sendFile(req, res, full, { cache });
}

/* ------------------------------------------------------- library listings */

function listDir(dir, { limit = 500, exts = VIDEO_EXT } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    if (out.length >= limit) break;
    if (!exts.has(path.extname(n).toLowerCase())) continue;
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile() || st.size < 1024) continue;
    out.push({ path: full, name: n, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** How full the disk under `dir` is: { free, total } in bytes, or null. */
function diskOf(dir) {
  try {
    const st = fs.statfsSync ? fs.statfsSync(dir) : null;
    return st ? { free: st.bavail * st.bsize, total: st.blocks * st.bsize } : null;
  } catch (e) { return null; }
}

/*
 * DELETING FROM A PHONE.
 *
 * A server's disk fills with sermons sent from phones and shorts nobody needs
 * any more, and there was no way to clear any of it without a terminal. So a
 * signed-in phone may delete — but only what IT put there, and only what is
 * safe to lose:
 *
 *   • only files directly inside "Sent from a phone" or "Finished exports" —
 *     never the Videos folder (on the church PC that is the real Videos
 *     folder), never a subfolder, never anything the app keeps for itself;
 *   • only video files, by extension;
 *   • never a file a planned post still needs: deleting it would turn Sunday's
 *     post into a failure at the moment it was due to go out.
 *
 * An export's cover picture (the .jpg written beside it) goes with it. If the
 * deleted file was the video the rolling autosave points at, the autosave goes
 * too — otherwise the home screen would offer to "pick up" an edit whose video
 * no longer exists.
 */
const COMPANIONS = ['.jpg', '.srt', '.vtt'];
async function deleteFiles(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf-8') || '{}'); }
  catch (e) { return json(res, 400, { error: 'Bad request.' }); }
  const asked = (Array.isArray(body.paths) ? body.paths : [body.path]).filter((x) => typeof x === 'string' && x).slice(0, 300);
  if (!asked.length) return json(res, 400, { error: 'Nothing to delete.' });

  const mine = dirsFor();
  const folders = [mine.output, mine.uploads].filter(Boolean).map((d) => path.resolve(d));
  const key = (f) => (process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
  const needed = new Map();     // file -> the title of a planned post that uses it
  try {
    const got = await rpc.invoke('scheduler:list', {});
    for (const post of (got && got.ok && got.data) || []) {
      if (post.status !== 'scheduled' && post.status !== 'posting') continue;
      for (const m of post.mediaPaths || []) if (typeof m === 'string') needed.set(key(m), post.title || 'a planned post');
    }
  } catch (e) { /* no scheduler: nothing is needed by one */ }

  const deleted = [], refused = [], alsoGone = [];
  let freed = 0;
  for (const p of asked) {
    const full = path.resolve(p);
    const home = folders.find((d) => path.dirname(full) === d || (process.platform === 'win32' && path.dirname(full).toLowerCase() === d.toLowerCase()));
    if (!home) { refused.push({ path: p, why: 'Only files sent from a phone or finished exports can be deleted from here.' }); continue; }
    if (!VIDEO_EXT.has(path.extname(full).toLowerCase())) { refused.push({ path: p, why: 'Only videos can be deleted from here.' }); continue; }
    if (needed.has(key(full))) { refused.push({ path: p, why: `It is in a planned post (“${needed.get(key(full))}”) — delete or change that post first.` }); continue; }
    let st;
    try { st = fs.statSync(full); } catch (e) { deleted.push(p); continue; }      // already gone is gone
    if (!st.isFile()) { refused.push({ path: p, why: 'That is not a file.' }); continue; }
    try {
      fs.unlinkSync(full);
      freed += st.size;
      deleted.push(p);
    } catch (e) { refused.push({ path: p, why: 'The studio could not delete it (' + (e.code || e.message) + ').' }); continue; }
    // a montage's saved edit goes with it, and any copy made for saving to a phone
    try { freed += require('../main/phonecopy').removeFor(full); } catch (e) { /* none */ }
    try { const sc = full + '.montage.json'; const ss = fs.statSync(sc); fs.unlinkSync(sc); freed += ss.size; } catch (e) { /* none */ }
    // …and the copy without its overlays that the studio edits (montage.js baseOf)
    try { const bo = path.join(path.dirname(full), '.montage-edit', path.basename(full)); const bs = fs.statSync(bo); fs.unlinkSync(bo); freed += bs.size; alsoGone.push(bo); } catch (e) { /* none */ }
    // …and the stills its snapshot overlays froze (montage.js stillsFor: <name>.snap-N.jpg)
    try {
      const ed = path.join(path.dirname(full), '.montage-edit'), stem = path.basename(full).replace(/\.[^.]+$/, '') + '.snap-';
      for (const n of fs.readdirSync(ed)) if (n.startsWith(stem) && /\.snap-\d+\.jpg$/.test(n)) { const sf = path.join(ed, n); const ss = fs.statSync(sf); fs.unlinkSync(sf); freed += ss.size; }
    } catch (e) { /* none */ }
    const base = full.replace(/\.[^.\\/]+$/, '');
    for (const ext of COMPANIONS) {
      try { const c = base + ext; const cs = fs.statSync(c); fs.unlinkSync(c); freed += cs.size; } catch (e) { /* none */ }
    }
  }

  let autosaveCleared = false;
  if (deleted.length) {
    try {
      const got = await rpc.invoke('session:autosaveGet', {});
      const v = got && got.ok && got.data && got.data.video && got.data.video.path;
      if (v && deleted.concat(alsoGone).some((d) => key(d) === key(v))) {
        await rpc.invoke('session:autosaveClear', {});
        autosaveCleared = true;
      }
    } catch (e) { /* the autosave is a convenience */ }
  }
  return json(res, 200, { ok: true, deleted, refused, freed, autosaveCleared, disk: diskOf(mine.output || os.tmpdir()) });
}

/*
 * An upload that was given up on leaves its part file behind (that is what
 * lets a dropped one carry on). Nobody comes back for one after two days, and
 * a half-sent service recording is gigabytes, so they are swept up.
 */
const PART_MAX_AGE_MS = 48 * 3600 * 1000;
function sweepParts() {
  // the owner's uploads, and every space's
  const dirs = [cfg.dirs.uploads].concat(users.filter((u) => u.space).map((u) => space.pathFor(cfg.dirs.uploads, u.space))).filter(Boolean);
  let n = 0;
  for (const dir of dirs) n += sweepPartsIn(dir);
  return n;
}
function sweepPartsIn(dir) {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const name of names) {
    if (!name.startsWith('.part-')) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs > PART_MAX_AGE_MS) { fs.unlinkSync(full); n++; }
    } catch (e) { /* in use, or gone */ }
  }
  return n;
}
let sweepTimer = null;

/** Everything a signed-in browser can open. */
function browse(exts) {
  const seen = new Set();
  const d = dirsFor();
  const groups = [
    { key: 'output', label: 'Finished exports', dir: d.output },
    { key: 'uploads', label: 'Sent from a phone', dir: d.uploads },
    { key: 'videos', label: 'Videos folder', dir: d.videos },
  ];
  return groups.map((g) => {
    const items = listDir(g.dir, { exts: exts || VIDEO_EXT }).filter((f) => {
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

  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');

  /*
   * IS ANYONE USING IT? Asked by scripts/cloud-update.sh (from inside the box
   * only) before it restarts the studio for a new version: a restart while
   * someone is uploading, editing or exporting would cut them off. Anything a
   * signed-in person does calls /api/…; the app's own keep-alives, the health
   * check and strangers knocking do not count.
   */
  if (p === '/api/idle') {
    const ip = String(req.socket.remoteAddress || '');
    if (!/^(::ffff:)?127\.|^::1$/.test(ip)) return send(res, 404, 'text/plain', 'not found');
    return json(res, 200, {
      idleSec: Math.round((Date.now() - (lastActive || started || Date.now())) / 1000),
      uploads: uploads.size, watching: sseClients.size,
    });
  }

  /* --- the app shell (open: it is a sign-in page until you sign in) ------ */

  if (p === '/' || p === '/index.html') {
    const html = page.build({ version: cfg.appVersion || '0' });
    return send(res, 200, 'text/html; charset=utf-8', html);
  }
  if (p === '/cloud-boot.js') return sendWeb(req, res, 'cloud-boot.js');
  if (p === '/cloud-social.js') return sendWeb(req, res, 'cloud-social.js');
  if (p === '/cloud.css') return sendWeb(req, res, 'cloud.css');
  if (p === '/manifest.webmanifest') return sendWeb(req, res, 'manifest.webmanifest');
  // A service worker may only control the scope it is served from, so this one
  // is served from the root even though it lives in web/.
  if (p === '/sw.js') return sendWeb(req, res, 'sw.js');
  if (p.startsWith('/icons/')) {
    const name = path.basename(p);
    if (!/^[\w.-]+\.(png|svg|ico)$/i.test(name)) return send(res, 404, 'text/plain', 'not found');
    return sendWeb(req, res, path.join('icons', name), 'public, max-age=604800');
  }

  /*
   * The studio's own files, verbatim. Allowlisted by name: this is not a static
   * server for src/renderer, it hands over six known files.
   */
  if (p.startsWith('/r/')) {
    const name = path.basename(p);
    if (!page.SERVABLE.has(name)) return send(res, 404, 'text/plain', 'not found');
    return sendFile(req, res, path.join(page.RENDERER_DIR, name), { cache: 'no-cache' });
  }

  /*
   * MediaPipe's wasm and models, so auto-reframe runs in THIS browser.
   *
   * Deliberately outside the sign-in gate: MediaPipe builds its own runtime
   * URLs by appending names to the base it is given, so it never carries our
   * Authorization header and a `?k=` would be lost the moment it appends
   * `/vision_wasm_internal.js`. These are Google's redistributable files,
   * identical for every install, containing nothing about this church — serving
   * them unauthenticated gives an attacker exactly what a public CDN already
   * does. Everything that touches the church's media stays behind the gate.
   */
  if (p.startsWith('/ai/')) {
    const base = cfg.dirs.ai;
    if (!base) return send(res, 404, 'text/plain', 'ai assets not available');
    const full = path.normalize(path.join(base, decodeURIComponent(p.slice(4))));
    if (!within(full, base)) return send(res, 403, 'text/plain', 'forbidden');
    return sendFile(req, res, full, { cache: 'public, max-age=604800' });
  }

  /*
   * The caption fonts that ship with the studio — by file name only, from the
   * fonts folder only. Outside the sign-in gate for the same reason as /ai/:
   * open-licence files identical in every install, nothing about this church.
   * And unlike the media route they may be KEPT (a week here, for good by the
   * phone's service worker): served as media, every one of the 21 faces came
   * down again each time the home-screen app opened, and the Font picker sat
   * empty until the last had arrived.
   */
  if (p.startsWith('/fonts/')) {
    const base = cfg.dirs.fonts;
    let name = '';
    try { name = decodeURIComponent(p.slice(7)); } catch (e) { name = ''; }
    if (!base || !/^[\w][\w .()+-]*\.(ttf|otf|woff2?)$/i.test(name)) return send(res, 404, 'text/plain', 'not found');
    const full = path.normalize(path.join(base, name));
    if (!within(full, base)) return send(res, 403, 'text/plain', 'forbidden');
    return sendFile(req, res, full, { cache: 'public, max-age=604800' });
  }

  /*
   * ►► WHERE EACH SIGN-IN COMES BACK TO (Scheduler → Set up everything). ◄◄
   * Outside the sign-in gate: it is opened by the platform's own redirect, in
   * whatever browser the sign-in happened, which carries no Authorization.
   * The random one-run code in the address is the key (main.js setupRuns): it
   * keeps the account that was just linked and goes straight on to the next
   * platform's sign-in, then says what was linked.
   */
  if (p.startsWith('/social/next/') && SOCIAL_ON) {
    const code = p.slice('/social/next/'.length);
    if (!/^[0-9a-f]{36}$/.test(code)) return send(res, 404, 'text/plain', 'not found');
    let out;
    try { out = await rpc.invoke('social:setupNext', { code }, null); } catch (e) { out = { ok: false, error: e.message }; }
    const r = out && out.ok ? out.data : { error: (out && out.error) || 'Something went wrong' };
    if (r && r.redirect && /^https:\/\//i.test(r.redirect)) {
      res.writeHead(302, { location: r.redirect, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end();
    }
    return send(res, 200, 'text/html; charset=utf-8', setupPage(r), { 'cache-control': 'no-store' });
  }

  if (p === '/api/hello') {
    return json(res, 200, {
      ok: true,
      name: 'Church Work Space',
      version: cfg.appVersion || '',
      signedIn: authed(req, url),
      // spaces: whether this studio has accounts yet, and who is signed in
      accounts: users.length,
      me: authed(req, url) ? publicUser(userOf(req, url)) : null,
      allowUpload: !!cfg.allowUpload,
      allowDelete: !!cfg.allowUpload,
      publicUrl: cfg.publicUrl || '',
      standalone: !!cfg.standalone,
      // The build the page is made from right now. An installed phone app is
      // resumed rather than reopened, and compares this with its own to know
      // when to offer a refresh (cloud-boot.js, "updates").
      build: page.assetKey(cfg.appVersion || '0'),
      social: SOCIAL_ON,
    });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (lockedOut(ip)) {
      return json(res, 429, { error: `Too many wrong tries. Try again in ${lockoutLeft(ip)} minutes.` });
    }
    let body;
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf-8') || '{}'); }
    catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    body = body || {};
    const given = String(body.code || '').trim().toLowerCase().replace(/\s+/g, '-');
    const name = String(body.name || '').trim();
    const pw = String(body.password || '');
    const issue = (u) => {
      clearFailures(ip);
      const t = newToken();
      tokens.set(t, {
        at: Date.now(),
        ip,
        ttl: body.remember ? REMEMBER_TTL_MS : SESSION_TTL_MS,
        agent: String(req.headers['user-agent'] || '').slice(0, 120),
        uid: u ? u.uid : undefined,
      });
      saveTokens();
      return json(res, 200, { ok: true, token: t, version: cfg.appVersion || '', me: publicUser(u) });
    };
    const wrong = (msg, code) => {
      noteFailure(ip);
      const left = lockedOut(ip) ? ` Locked for ${lockoutLeft(ip)} minutes.` : '';
      return json(res, code || 401, { error: msg + left });
    };
    // Making a space: the church's code says they belong here.
    if (body.create) {
      if (!codeMatches(given)) return wrong('That access code is not right — ask whoever runs the studio for it.');
      if (name.length < 2) return json(res, 400, { error: 'Type your name (at least 2 letters).' });
      if (pw.length < 6) return json(res, 400, { error: 'Choose a password of at least 6 characters.' });
      if (userByName(name)) return json(res, 409, { error: 'There is already a space with that name — sign in, or choose another name.' });
      return issue(makeUser(name, pw));
    }
    // Signing in to a space.
    if (name || pw) {
      const u = userByName(name);
      if (!u || !checkPass(u, pw)) return wrong('That name and password do not match.');
      return issue(u);
    }
    // The code alone: only while there are no spaces yet (an older installed app).
    if (users.length) return json(res, 401, { error: 'Sign in with your name and password.', needsAccount: true });
    if (!codeMatches(given)) return wrong('That code is not right.');
    return issue(null);
  }

  /* --- everything below needs a signed-in browser ----------------------- */

  if (!authed(req, url)) return json(res, 401, { error: 'Sign in first.', needsAuth: true });
  if (!QUIET_API.has(p)) lastActive = Date.now();   // a signed-in person did something

  // Everything from here on runs in the signed-in person's own space.
  const me = userOf(req, url);
  return space.run(me ? me.space : null, () => authedRoutes(req, res, url, p, me));
}

async function authedRoutes(req, res, url, p, me) {
  if (p === '/api/me') {
    return json(res, 200, { ok: true, me: publicUser(me), accounts: users.length, people: me && me.owner ? users.map(publicUser) : undefined });
  }
  if (p === '/api/me/password' && req.method === 'POST') {
    if (!me) return json(res, 400, { error: 'Make your space first.' });
    let body; try { body = JSON.parse((await readBody(req, 4096)).toString('utf-8') || '{}'); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    if (!checkPass(me, body.current)) return json(res, 401, { error: 'Your current password is not right.' });
    if (String(body.password || '').length < 6) return json(res, 400, { error: 'Choose a password of at least 6 characters.' });
    setPass(me, body.password); saveUsers();
    return json(res, 200, { ok: true });
  }
  // The owner looks after the spaces: a new password for someone who forgot
  // theirs, and removing a space (with its files) when someone leaves.
  if (p.startsWith('/api/people/') && req.method === 'POST') {
    if (!me || !me.owner) return json(res, 403, { error: 'Only the owner can change other people’s spaces.' });
    let body; try { body = JSON.parse((await readBody(req, 4096)).toString('utf-8') || '{}'); } catch (e) { return json(res, 400, { error: 'Bad request.' }); }
    const u = userById(body.uid);
    if (!u) return json(res, 404, { error: 'That space is not here any more.' });
    if (p === '/api/people/reset') {
      const temp = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
      setPass(u, temp); saveUsers();
      for (const [t, rec] of tokens) if (rec.uid === u.uid && u !== me) tokens.delete(t);
      saveTokens();
      return json(res, 200, { ok: true, password: temp });
    }
    if (p === '/api/people/remove') {
      if (u.owner) return json(res, 400, { error: 'The owner’s space cannot be removed.' });
      users = users.filter((x) => x !== u); saveUsers();
      for (const [t, rec] of tokens) if (rec.uid === u.uid) tokens.delete(t);
      saveTokens();
      const root = space.rootOf(u.space);
      if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} }
      for (const d of ['output', 'uploads']) {
        const dir = space.pathFor(cfg.dirs[d], u.space);
        if (dir && dir !== cfg.dirs[d] && root && !dir.startsWith(root)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    tokens.delete(tokenOf(req, url));
    saveTokens();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res._mwSpace = space.current();
    sseClients.add(res);
    // A tunnel or a mobile network will drop a silent connection; this keeps it.
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return undefined;
  }

  if (p === '/api/rpc/wait') {
    const c = calls.get(callKey(me, url.searchParams.get('call')));
    if (!c) return json(res, 404, { unknown: true });
    return answerCall(c, req, res);
  }

  if (p === '/api/rpc' && req.method === 'POST') {
    // A retry of a call the server already has (the phone lost the answer, or
    // never knew whether the request arrived): wait on the one that is
    // running instead of starting the export a second time.
    const cid = req.headers['x-mw-call'];
    const known = calls.get(callKey(me, cid));
    if (known) { req.resume(); return answerCall(known, req, res); }
    let body;
    try { body = decodeEnvelope(await readBody(req, 512 * 1024 * 1024)); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }

    const channel = body && body.channel;
    const args = (body && body.args) || {};
    const rule = Object.prototype.hasOwnProperty.call(ALLOWED, channel) ? ALLOWED[channel] : undefined;
    if (rule === undefined) {
      return json(res, 403, { ok: false, error: `"${channel}" is not available from the cloud studio.` });
    }
    if (rule && typeof rule === 'object' && rule.args && !rule.args(args)) {
      return json(res, 403, { ok: false, error: `"${channel}" refused those arguments.` });
    }
    // shared by everyone on the server: only the owner may remove or install them
    if (OWNER_ONLY.has(channel) && me && !me.owner) {
      return json(res, 403, { ok: false, error: 'Only the studio’s owner can change that — it is shared by everyone here.' });
    }
    const badKey = guard.checkArgPaths(args);
    if (badKey) {
      return json(res, 403, { ok: false, error: `That file is outside the folders this studio may use (${badKey}).` });
    }

    const work = rpc.invoke(channel, args, sseSender).then((out) => {
      if (out && out.ok && rule && typeof rule === 'object' && rule.result) {
        out = { ok: true, data: rule.result(out.data) };
      }
      return out;
    }, (e) => ({ ok: false, error: (e && e.message) || String(e) }));
    // Without a call id (an older page) the request simply waits, as it always did.
    if (!validCallId(cid)) {
      // The envelope is passed through otherwise untouched — a browser sees exactly
      // what the desktop renderer sees, cancellations included.
      const enc = encodeEnvelope(await work);
      return send(res, 200, enc.binary ? 'application/x-mw-rpc' : 'application/json; charset=utf-8', enc.body);
    }
    return answerCall(trackCall(callKey(me, cid), work), req, res);
  }

  /*
   * ▶ A FREE SONG, TO LISTEN TO BEFORE IT IS USED (the AI Montage's song list).
   * The phone cannot play it from incompetech (it will not be played inside
   * another site), and fetching it first and then playing loses the tap an
   * iPhone needs before it makes a sound. So the phone plays THIS address at
   * once: the server gets the song into its library (once — after that it is
   * just a file) and streams it, ranges and all.
   */
  /*
   * ▶ A NARRATOR VOICE, TO HEAR BEFORE IT IS CHOSEN (the Viral Montage). The
   * same line in each voice, made once on the server (the first one wakes the
   * voice — about a minute) and kept; played at this address on the tap.
   */
  if (p === '/api/voice-sample') {
    const vox = require('../main/voiceover');
    const id = String(url.searchParams.get('voice') || '').replace(/[^a-z_]/g, '').slice(0, 30);
    if (!vox.VOICES.some(([v]) => v === id)) return send(res, 400, 'text/plain', 'which voice?');
    if (!vox.installed()) return send(res, 503, 'text/plain', 'The AI voice is not installed on this server.');
    const dir = path.join(os.tmpdir(), 'mw-voice-samples');
    const file = path.join(dir, id + '.wav');
    if (!fs.existsSync(file)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (!voiceSampling.has(id)) {
          const tmp = file + '.part.wav';
          voiceSampling.set(id, vox.speak(VOICE_SAMPLE_LINE, { voice: id, out: tmp }).then(() => fs.renameSync(tmp, file)).finally(() => voiceSampling.delete(id)));
        }
        await voiceSampling.get(id);
      } catch (e) { return send(res, 502, 'text/plain', 'The voice could not be made: ' + ((e && e.message) || e)); }
    }
    return sendFile(req, res, file, {});
  }

  if (p === '/api/free-song') {
    const id = String(url.searchParams.get('id') || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80);
    if (!id) return send(res, 400, 'text/plain', 'which song?');
    let out = null;
    try { out = await rpc.invoke('music:freeGet', { id }); } catch (e) { out = { ok: false, error: e.message }; }
    const file = out && out.ok && out.data && out.data.file;
    if (!file) return send(res, 502, 'text/plain', (out && out.error) || 'That song could not be fetched.');
    if (!allowedPath(file)) return send(res, 403, 'text/plain', 'forbidden');
    return sendFile(req, res, path.resolve(file), {});
  }

  if (p === '/api/media' || p === '/api/file') {
    const target = url.searchParams.get('p') || '';
    if (!allowedPath(target)) return send(res, 403, 'text/plain', 'forbidden');
    if (!MEDIA_EXT.has(path.extname(target).toLowerCase())) return send(res, 403, 'text/plain', 'forbidden');
    return sendFile(req, res, path.resolve(target), {
      download: p === '/api/file' || url.searchParams.get('dl') === '1',
    });
  }

  if (p === '/api/videos') {
    return json(res, 200, { ok: true, groups: browse(url.searchParams.get('all') === '1' ? PICKABLE_EXT : null), disk: diskOf(dirsFor().output || os.tmpdir()), canDelete: !!cfg.allowUpload });
  }

  if (p === '/api/delete' && req.method === 'POST') {
    if (!cfg.allowUpload) return json(res, 403, { error: 'Changing files on this studio from a phone is switched off.' });
    return deleteFiles(req, res);
  }

  if (p === '/api/status') return json(res, 200, status());

  if (p === '/api/upload' && (req.method === 'POST' || req.method === 'PUT')) {
    if (!cfg.allowUpload) return json(res, 403, { error: 'Sending files to this studio is switched off.' });
    return receiveUpload(req, res, url);
  }

  return send(res, 404, 'text/plain', 'not found');
}

/* ------------------------------------------------------------- the upload */

/**
 * Straight binary upload: the body IS the file, so a 4 GB recording streams to
 * disk a chunk at a time instead of being assembled in memory.
 *
 * `?offset=` makes it resumable, which on a phone is not a nicety: a browser
 * tab that loses signal half way through a service recording would otherwise
 * start again from zero. The client asks for the size on disk first (HEAD-ish,
 * via `?probe=1`) and sends the rest.
 */
function receiveUpload(req, res, url) {
  const raw = url.searchParams.get('name') || 'upload.mp4';
  // Long names are shortened from the MIDDLE of the name, never the end: a
  // file called "AQPvBr-7yrv4JQ…(120 characters)….mp4" lost its ".mp4" to the
  // cut and was refused as "not a video".
  const base0 = path.basename(raw).replace(/[^\w.\- ()]+/g, '_');
  const ext0 = path.extname(base0).slice(0, 10);
  const cleaned = ((base0.slice(0, base0.length - ext0.length).slice(0, 70) || 'upload') + ext0) || 'upload.mp4';
  const ext = path.extname(cleaned).toLowerCase();
  if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext) && !MEDIA_EXT.has(ext)) {
    return json(res, 400, { error: 'Only video, audio and picture files can be sent.' });
  }

  const dir = dirsFor().uploads;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  // The id keeps a resumed upload pointing at the same file on disk.
  const id = (url.searchParams.get('id') || crypto.randomBytes(6).toString('hex')).replace(/[^\w-]/g, '').slice(0, 24);
  const partial = path.join(dir, `.part-${id}-${cleaned}`);
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
  const total = Number(url.searchParams.get('size') || req.headers['content-length'] || 0) || 0;

  // Stop: the half-sent file goes (a stopped upload leaves nothing behind)
  if (url.searchParams.get('discard') === '1') {
    const live = uploads.get(id);
    if (live && live.req) { try { live.req.destroy(); } catch (e) {} }
    uploads.delete(id);
    setTimeout(() => { try { fs.rmSync(partial, { force: true }); } catch (e) {} }, 300);   // after the cut-off piece lets go of it
    return json(res, 200, { ok: true, discarded: true });
  }

  if (url.searchParams.get('probe') === '1') {
    let have = 0;
    try { have = fs.statSync(partial).size; } catch (e) { have = 0; }
    return json(res, 200, { ok: true, id, have });
  }

  if (total > cfg.maxUploadBytes) return json(res, 413, { error: 'That file is too big to send.' });

  let onDisk = 0;
  try { onDisk = fs.statSync(partial).size; } catch (e) { onDisk = 0; }
  if (offset > onDisk) return json(res, 409, { ok: false, error: 'Upload is out of step.', have: onDisk });

  const rec = { id, name: cleaned, received: offset, total, path: partial, req };
  uploads.set(id, rec);

  const out = fs.createWriteStream(partial, offset ? { flags: 'r+', start: offset } : { flags: 'w' });
  let failed = false;
  const fail = (msg, code) => {
    if (failed) return;
    failed = true;
    uploads.delete(id);
    try { out.destroy(); } catch (e) {}
    if (!res.headersSent) json(res, code || 500, { error: msg, id, have: rec.received });
  };

  req.on('data', (c) => {
    rec.received += c.length;
    if (rec.received > cfg.maxUploadBytes) { req.destroy(); return fail('That file is too big to send.', 413); }
    if (total) push('upload:progress', { id, name: cleaned, percent: Math.round((rec.received / total) * 100) });
  });
  // An aborted upload keeps its part file so the next attempt can carry on.
  req.on('aborted', () => fail('Upload interrupted.'));
  req.on('error', () => fail('Upload failed.'));
  out.on('error', (e) => fail('Could not save the file: ' + e.message));
  req.pipe(out);

  out.on('close', () => {
    if (failed) return;
    uploads.delete(id);
    if (!rec.received) {
      try { fs.rmSync(partial, { force: true }); } catch (e) {}
      return json(res, 400, { error: 'Nothing was sent.' });
    }
    // Still more to come — the client will call again with the new offset.
    if (total && rec.received < total) {
      return json(res, 200, { ok: true, partial: true, id, have: rec.received });
    }
    // 14, not 15: the 15th character of an ISO stamp is the dot before the
    // milliseconds, and a file called '20260916121756.-sermon.mp4' looks broken.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const full = path.join(dir, `${stamp}-${cleaned}`);
    try { fs.renameSync(partial, full); }
    catch (e) { return json(res, 500, { error: 'Could not finish saving the file: ' + e.message }); }
    push('upload:progress', { id, name: cleaned, percent: 100, done: true, path: full });
    json(res, 200, { ok: true, path: full, name: path.basename(full), size: rec.received });
  });
  return undefined;
}

/* ---------------------------------------------------------------- control */

function status() {
  const free = (dir) => {
    try {
      const s = fs.statfsSync ? fs.statfsSync(dir) : null;
      return s ? s.bavail * s.bsize : null;
    } catch (e) { return null; }
  };
  return {
    ok: true,
    running: !!server,
    version: cfg.appVersion || '',
    standalone: !!cfg.standalone,
    uptimeSec: started ? Math.round((Date.now() - started) / 1000) : 0,
    signedInDevices: tokens.size,
    watching: sseClients.size,
    outputDir: dirsFor().output,
    freeBytes: free(dirsFor().output || os.tmpdir()),
    channels: Object.keys(ALLOWED).length,
    uploads: Array.from(uploads.values()).map((u) => ({ id: u.id, name: u.name, received: u.received, total: u.total })),
  };
}

async function start(opts = {}) {
  cfg = Object.assign({}, cfg, opts, { dirs: Object.assign({}, cfg.dirs, opts.dirs || {}) });
  if (!cfg.code) cfg.code = makeCode();
  if (server) stop();
  for (const d of [cfg.dirs.uploads, cfg.dirs.output]) {
    if (d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
  }
  loadUsers();
  loadTokens();
  sweepParts();
  if (!sweepTimer) { sweepTimer = setInterval(sweepParts, 6 * 3600 * 1000); if (sweepTimer.unref) sweepTimer.unref(); }

  // Fail loudly at start rather than mysteriously at the first click.
  const bad = page.check();
  if (!bad.ok) {
    throw new Error('The cloud page is missing parts of the Video Studio: ' + bad.missing.join(', '));
  }
  // …and the shell around it. A missing global does not crash the studio —
  // every call is guarded — it quietly costs a feature, which is worse.
  const shell = page.shellCheck();
  if (!shell.ok) {
    throw new Error('The cloud page is missing part of the studio shell: ' + shell.missing.join(', '));
  }
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        try { json(res, 500, { error: (e && e.message) || 'server error' }); } catch (er) {}
      });
    });
    // An export can run for many minutes with no bytes moving on the RPC socket.
    // Node's default 5-minute header/request timeouts would cut it off.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;
    server.keepAliveTimeout = 65000;
    // Keep-alive and SSE sockets outlive a request; stop() has to find them.
    server.on('connection', (s2) => { sockets.add(s2); s2.on('close', () => sockets.delete(s2)); });
    server.on('error', (e) => {
      server = null;
      reject(new Error(e.code === 'EADDRINUSE'
        ? `Port ${cfg.port} is already in use — pick another one in Settings.`
        : 'Could not start the Cloud Studio: ' + e.message));
    });
    server.listen(cfg.port, cfg.host, () => { started = Date.now(); resolve(state()); });
  });
}

/**
 * Stop, and mean it.
 *
 * `server.close()` stops ACCEPTING; it does not hang up on connections already
 * open, and this server deliberately keeps them open — an SSE stream that lasts
 * all evening, and keep-alive sockets that browsers and Node's own default
 * agent hold onto. So a plain close leaves the port bound until those drain,
 * and "change the port and restart" in Settings fails with "already in use"
 * while the old server is still holding the door. Every socket is therefore
 * tracked and hung up here.
 */
function stop() {
  writeTokens();                 // before the map is cleared — see saveTokens()
  for (const res of Array.from(sseClients)) { try { res.end(); } catch (e) {} }
  sseClients.clear();
  for (const s of Array.from(sockets)) { try { s.destroy(); } catch (e) {} }
  sockets.clear();
  // The tokens on disk stay: stopping the server is not signing everybody out,
  // and a restart that did would make "keep me signed in" meaningless.
  tokens.clear();
  uploads.clear();
  started = 0;
  if (server) { try { server.close(); } catch (e) {} server = null; }
  return true;
}

const isRunning = () => !!server;

function state() {
  return {
    running: isRunning(),
    port: cfg.port,
    code: cfg.code,
    allowUpload: !!cfg.allowUpload,
    publicUrl: cfg.publicUrl || '',
    localUrls: require('../main/lan-address').candidates().map((a) => `http://${a.address}:${cfg.port}`),
    signedInDevices: tokens.size,
    dirs: cfg.dirs,
  };
}

/** Roll the access code — every signed-in browser has to sign in again. */
function resetCode(code) {
  cfg.code = (code && String(code).trim().toLowerCase().replace(/\s+/g, '-')) || makeCode();
  tokens.clear();
  attempts.clear();
  saveTokens();
  return cfg.code;
}

/** The tunnel tells us the public URL so the app can show it and make a QR. */
function setPublicUrl(u) { cfg.publicUrl = u || ''; return cfg.publicUrl; }

module.exports = {
  start, stop, isRunning, state, status, resetCode, setPublicUrl, browse, push,
  // exported for tests
  ALLOWED, SOCIAL_ON, makeCode, encodeEnvelope, decodeEnvelope, allowedPath, sweepParts, _cfg: () => cfg,
};
