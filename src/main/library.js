'use strict';
/*
 * Media library — the saved 🎵 music and 🎬 clips (outros/intros/stingers) the
 * Video Studio offers with one click.
 *
 * Files are COPIED into the library folder rather than referenced in place. A
 * church media volunteer's outro sting lives in Downloads today and is gone next
 * month; a library that quietly empties itself is worse than no library. The
 * copy also means the app never has to ask for a folder again.
 *
 *   <userData>/library/media.json      { music: [...], clips: [...] }
 *   <userData>/library/music/<id>.<ext>
 *   <userData>/library/music/<id>.preview.mp3  (what the phone preview plays)
 *   <userData>/library/clips/<id>.<ext>  (+ <id>.jpg thumbnail)
 *   <userData>/tools/yt-dlp[.exe]        (optional YouTube helper)
 */
const fs = require('fs');
const os = require('os');
const space = require('./space');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const jobs = require('./jobs');

const MUSIC_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma', 'opus'];
// Stills belong here too: a church's "clip" on the end of a short is very often
// a flyer or an invite card, not footage. They are held on screen for STILL_SEC
// and get the same frame fill as everything else, so a 16:9 card in a 9:16 short
// can sit on its own blurred background instead of black bars.
const STILL_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];
const CLIP_EXT = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', ...STILL_EXT];
const STILL_SEC = 4;

let ROOT = null;                 // <userData>/library — set once by init()
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function init(userDataDir) {
  ROOT = path.join(userDataDir, 'library');
  for (const d of [ROOT, path.join(ROOT, 'music'), path.join(ROOT, 'clips'), toolsDir()]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  }
  return ROOT;
}
// Each person on a shared Cloud Studio has their own music and outro library
// (space.js); the owner's is the original folder.
const root = () => {
  const base = ROOT || init(path.join(os.homedir(), '.church-work-space'));
  const r = space.pathFor(base);
  if (r !== base) for (const d of [path.join(r, 'music'), path.join(r, 'clips')]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
  return r;
};
const toolsDir = () => path.join(path.dirname(ROOT || root()), 'tools');
const dbPath = () => path.join(root(), 'media.json');

function readDb() {
  try {
    const d = JSON.parse(fs.readFileSync(dbPath(), 'utf-8'));
    return { music: Array.isArray(d.music) ? d.music : [], clips: Array.isArray(d.clips) ? d.clips : [] };
  } catch (e) { return { music: [], clips: [] }; }
}
function writeDb(db) {
  try {
    fs.mkdirSync(root(), { recursive: true });
    const tmp = dbPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tmp, dbPath());
  } catch (e) { /* library is a convenience — never take the app down for it */ }
  return db;
}

const safeName = (n) => String(n || 'untitled').replace(/[^\w \-.()&']+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'untitled';

/** Everything still on disk, newest first. Entries whose file vanished are dropped. */
function list() {
  const db = readDb();
  let changed = false;
  const keep = (arr) => arr.filter((e) => {
    const ok = e && e.file && fs.existsSync(e.file);
    if (!ok) changed = true;
    // a lost preview copy only costs the preview its shortcut: the original plays
    if (ok && e.preview && !fs.existsSync(e.preview)) { delete e.preview; changed = true; }
    return ok;
  });
  const out = { music: keep(db.music), clips: keep(db.clips) };
  if (changed) writeDb(out);
  out.music.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  out.clips.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return out;
}

/*
 * A video given to My music — an instrumental screen-recorded off YouTube —
 * keeps only its sound, saved as a song (<id>.m4a). No sound, no song.
 */
const VIDEO_EXT = CLIP_EXT.filter((e) => !STILL_EXT.includes(e)).concat(['3gp']);
async function soundIn(ctx, video, srcPath, id) {
  let info = null;
  try { info = await video.getInfo(ctx, srcPath); } catch (e) { throw new Error('That video could not be read.'); }
  if (!info.hasAudio) throw new Error('That video has no sound to use as music.');
  const dest = path.join(root(), 'music', `${id}.m4a`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { await video.soundOf(ctx, { input: srcPath, output: dest, acodec: info.acodec }); }
  catch (e) { try { fs.rmSync(dest, { force: true }); } catch (er) {} throw new Error('The sound could not be taken from that video.'); }
  return dest;
}

function copyIn(kind, srcPath, id) {
  const ext = (path.extname(srcPath) || '').replace(/^\./, '').toLowerCase() || (kind === 'music' ? 'mp3' : 'mp4');
  const dest = path.join(root(), kind === 'music' ? 'music' : 'clips', `${id}.${ext}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcPath, dest);
  return { dest, ext };
}

/**
 * Add a file to the library. `ctx`/`video` are the ffmpeg context and the video
 * module — passed in (rather than required) so this module stays testable and
 * free of a circular require with video.js.
 */
/*
 * A file sent from a phone is saved as "<when>-<its name>" (cloud-api.js
 * receiveUpload, mobile-api.js) so two sends of "IMG_0001.mov" never collide.
 * The stamp is the server's bookkeeping, not the song's name: "Amazing Grace",
 * not "20261006071702-Amazing Grace" on the Music button.
 */
const plainName = (p) => path.basename(p, path.extname(p)).replace(/^\d{14}\.?\d*-(?=.)/, '');

async function add(ctx, video, { kind, path: srcPath, name, source, move }) {
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('That file could not be found.');
  const k = kind === 'music' ? 'music' : 'clips';
  const ext = (path.extname(srcPath) || '').replace(/^\./, '').toLowerCase();
  const allowed = k === 'music' ? MUSIC_EXT : CLIP_EXT;
  if (ext && !allowed.includes(ext) && !(k === 'music' && VIDEO_EXT.includes(ext))) {
    throw new Error(k === 'music'
      ? `“.${ext}” isn’t an audio file. Pick an ${MUSIC_EXT.slice(0, 4).join(', ')}…`
      : `“.${ext}” isn’t a video or picture. Pick an ${CLIP_EXT.slice(0, 4).join(', ')}… or a jpg/png.`);
  }
  const still = STILL_EXT.includes(ext);
  const id = uid();
  const fromVideo = k === 'music' && VIDEO_EXT.includes(ext);
  const dest = fromVideo ? await soundIn(ctx, video, srcPath, id) : copyIn(k, srcPath, id).dest;
  if (move) { try { fs.rmSync(srcPath, { force: true }); } catch (e) {} }

  const entry = {
    id, name: safeName(name || plainName(srcPath)),
    file: dest, ext: (path.extname(dest) || '').replace(/^\./, ''),
    addedAt: Date.now(), source: source || (fromVideo ? 'video' : 'file'),
  };
  // Duration (and, for clips, a poster frame) so the library reads like a real
  // media bin instead of a list of filenames.
  try {
    const info = await video.getInfo(ctx, dest);
    // A photo has no duration — it is one frame until something says how long to
    // hold it. Give it a sensible default the operator can live with.
    entry.durationSec = still ? STILL_SEC : info.durationSec;
    entry.durationLabel = still ? `0:0${STILL_SEC}` : info.durationLabel;
    if (k === 'clips') { entry.width = info.width; entry.height = info.height; entry.hasAudio = still ? false : info.hasAudio; entry.still = still; }
  } catch (e) {}
  /*
   * A song gets a second, browser-safe copy for the PREVIEW (video.audioPreview):
   * the phone plays whatever it is given straight off the studio, and a .wma, an
   * .opus on an older iPhone or a VBR mp3 without a seek table plays badly or not
   * at all. The export never touches it — it always mixes `file`, the original.
   * Entries made before this have no `preview` and simply keep playing `file`.
   */
  if (k === 'music' && video.audioPreview) {
    const preview = path.join(root(), 'music', `${id}.preview.mp3`);
    try { entry.preview = await video.audioPreview(ctx, { input: dest, output: preview }); entry.levelled = LEVEL_VER; }
    catch (e) { try { fs.rmSync(preview, { force: true }); } catch (er) {} }
  }
  if (k === 'clips') {
    try {
      const thumb = path.join(root(), 'clips', `${id}.jpg`);
      // seeking into a still is meaningless — take its only frame
      await video.thumbnail(ctx, { input: dest, timeSec: still ? 0 : Math.min(1, (entry.durationSec || 2) / 3), output: thumb });
      entry.thumb = thumb;
    } catch (e) {}
  }

  const db = readDb();
  db[k].unshift(entry);
  writeDb(db);
  return entry;
}

/*
 * Songs added before the preview copy was levelled (video.songGainDb) play
 * their preview at the song's own loudness while the export mixes it levelled:
 * the copy is made again, once, in the background, so the two match.
 */
const LEVEL_VER = 1;
const relevelling = new Map();   // library folder -> running pass (each person has their own)
function relevel(ctx, video) {
  const key = root();
  if (relevelling.has(key) || !video || !video.audioPreview) return relevelling.get(key) || null;
  if (list().music.every((e) => e.levelled === LEVEL_VER)) return null;
  const run = (async () => {
    for (const e of list().music) {
      if (e.levelled === LEVEL_VER) continue;
      const preview = path.join(root(), 'music', `${e.id}.preview.mp3`);
      const tmp = preview + '.new.mp3';
      try {
        await video.audioPreview(ctx, { input: e.file, output: tmp });
        fs.renameSync(tmp, preview);
        const db = readDb();
        const hit = db.music.find((x) => x.id === e.id);
        if (hit) { hit.preview = preview; hit.levelled = LEVEL_VER; writeDb(db); }
      } catch (er) { try { fs.rmSync(tmp, { force: true }); } catch (x) {} }
    }
  })().finally(() => { relevelling.delete(key); });
  relevelling.set(key, run);
  return run;
}

function remove({ kind, id }) {
  const k = kind === 'music' ? 'music' : 'clips';
  const db = readDb();
  const hit = db[k].find((e) => e.id === id);
  db[k] = db[k].filter((e) => e.id !== id);
  writeDb(db);
  if (hit) {
    for (const f of [hit.file, hit.thumb, hit.preview]) { try { if (f) fs.rmSync(f, { force: true }); } catch (e) {} }
  }
  return true;
}

function rename({ kind, id, name }) {
  const k = kind === 'music' ? 'music' : 'clips';
  const db = readDb();
  const hit = db[k].find((e) => e.id === id);
  if (hit) { hit.name = safeName(name); writeDb(db); }
  return hit || null;
}

/* ============================== YouTube ==============================
 * Search + audio import go through yt-dlp. It is NOT bundled (it needs frequent
 * updates to keep working, and shipping a stale copy would just break), so the
 * UI offers a one-click install into <userData>/tools the first time it's used.
 */
const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp' };
const ytLocalName = () => (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

/** Where yt-dlp is, or null. Checks our tools folder, a bundled bin/, then PATH. */
function ytPath() {
  const local = path.join(toolsDir(), ytLocalName());
  if (fs.existsSync(local)) return local;
  const bundled = path.join(__dirname, '..', '..', 'bin', 'yt-dlp', ytLocalName());
  if (fs.existsSync(bundled)) return bundled;
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'yt-dlp', ytLocalName());
  if (packaged && fs.existsSync(packaged)) return packaged;
  // On PATH? (a user who already has it shouldn't download a second copy)
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, ytLocalName());
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function ytStatus() {
  const p = ytPath();
  return {
    available: !!p,
    path: p,
    installDir: toolsDir(),
    howTo: p ? null : 'YouTube needs a small free helper (yt-dlp, ~17 MB). Click “Enable YouTube” once and the app downloads it for you.',
  };
}

/** Download a URL to a file, following GitHub's redirects. */
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects while downloading the YouTube helper.'));
    https.get(url, { headers: { 'User-Agent': 'ChurchWorkSpace' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode}).`)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress && total) onProgress(Math.min(99, Math.round((got / total) * 100)));
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest);
            if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
            resolve(dest);
          } catch (e) { reject(e); }
        });
      });
    }).on('error', (e) => reject(new Error('Could not reach the download server: ' + e.message)));
  });
}

/** One-click install of the YouTube helper (user-initiated from the Music panel). */
async function ytInstall({ onProgress } = {}) {
  const existing = ytPath();
  if (existing) return { path: existing, installed: false };
  const asset = YTDLP_ASSET[process.platform] || 'yt-dlp';
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dest = path.join(toolsDir(), ytLocalName());
  await download(url, dest, onProgress);
  return { path: dest, installed: true };
}

/* YouTube refuses downloads from data-centre addresses (a cloud server) with
 * “Sign in to confirm you’re not a bot”. Two things get past it, both set by
 * the studio's owner on the server, never in the app or the repo:
 *   - YT_COOKIES (the cookies.txt text) or a secret file youtube-cookies.txt
 *     (Render → Environment → Secret Files) — a signed-in browser's cookies
 *   - YT_PROXY — a proxy yt-dlp should go through
 * yt-dlp rewrites its cookie file, and secret files are read-only, so it is
 * always given a private copy. */
const COOKIE_FILES = () => [
  process.env.YT_COOKIES_FILE,
  '/etc/secrets/youtube-cookies.txt',
  path.join(process.cwd(), 'youtube-cookies.txt'),
].filter(Boolean);
function cookieText() {
  const env = String(process.env.YT_COOKIES || '').trim();
  if (env) return env.replace(/\\n/g, '\n');
  for (const f of COOKIE_FILES()) {
    try { if (fs.existsSync(f)) { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } } catch (e) {}
  }
  return '';
}
let cookieCopy = null;
function ytAuthArgs() {
  const out = [];
  const text = cookieText();
  if (text) {
    try {
      if (!cookieCopy || !fs.existsSync(cookieCopy.file) || cookieCopy.src !== text) {
        const file = path.join(toolsDir(), 'yt-cookies.txt');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Netscape cookie files must start with this line or yt-dlp ignores them.
        const body = /^# (Netscape )?HTTP Cookie File/i.test(text) ? text : '# Netscape HTTP Cookie File\n' + text;
        fs.writeFileSync(file, body + '\n', { mode: 0o600 });
        cookieCopy = { file, src: text };
      }
      out.push('--cookies', cookieCopy.file);
    } catch (e) {}
  }
  const proxy = String(process.env.YT_PROXY || '').trim();
  if (proxy) out.push('--proxy', proxy);
  return out;
}
const hasYtAuth = () => !!cookieText();
const isBotCheck = (e) => /not a bot|sign in to confirm|confirm your age|cookies-from-browser|HTTP Error 429/i.test((e && e.message) || '');
/* Other YouTube "players" sometimes still answer when the default is told to
 * sign in, so a blocked download tries these before giving up. */
const PLAYER_FALLBACKS = ['tv_simply,web_safari', 'mweb,android_vr', 'tv,web_embedded'];

function botCheckHelp() {
  return new Error(hasYtAuth()
    ? 'YouTube is still asking the server to prove it isn’t a robot. The YouTube cookies on the server have probably expired — the studio’s owner should export fresh ones and replace them. Meanwhile, add the song from your phone under 🎵 My music.'
    : 'YouTube blocks downloads from cloud servers (“confirm you’re not a bot”). Searching still works. To fix it, the studio’s owner adds YouTube cookies on the server once (Render → Environment → Secret Files → youtube-cookies.txt). Meanwhile, add the song from your phone under 🎵 My music.');
}

/** Run yt-dlp and collect stdout. Cancellable like any other job. */
function runYt(args, { onProgress, timeoutMs = 180000 } = {}) {
  const cli = ytPath();
  if (!cli) return Promise.reject(new Error('The YouTube helper isn’t installed yet — click “Enable YouTube” first.'));
  const full = args[0] === '-U' ? args : ytAuthArgs().concat(args);
  return new Promise((resolve, reject) => {
    const proc = jobs.track(spawn(cli, full, { windowsHide: true }));
    let out = '', err = '';
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString(); if (out.length > 8e6) out = out.slice(-4e6); });
    proc.stderr.on('data', (d) => {
      const s = d.toString(); err += s; if (err.length > 60000) err = err.slice(-30000);
      const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(s);
      if (m && onProgress) onProgress(Math.min(99, Math.round(parseFloat(m[1]))));
    });
    proc.on('error', (e) => { clearTimeout(killer); reject(new Error('Could not start the YouTube helper: ' + e.message)); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (jobs.isCancelled()) return reject(new jobs.CancelledError());
      if (code === 0) return resolve(out);
      reject(new Error('YouTube request failed.\n' + (err.split('\n').filter((l) => /error/i.test(l)).slice(-3).join('\n') || err.slice(-600))));
    });
  });
}

/* Tracks a church can safely lay under a short without a copyright strike
 * advertise it loudly in the title or channel name — NCS-style channels exist
 * for exactly this. These markers are how we recognise them. */
const FREE_MARKERS = /no.?copyright|copyright.?free|royalty.?free|free to use|free for (?:use|profit|commercial)|creative commons|\bNCS\b|no copyright sounds|audio library|\bDMCA.?free\b|non.?copyright|free background music|vlog no copyright/i;
function looksCopyrightFree(entry) {
  return FREE_MARKERS.test(`${entry.title || ''} ${entry.uploader || ''}`);
}

/**
 * Search YouTube (metadata only — nothing is downloaded).
 *
 * `copyrightFree` (the Music panel's default) makes the search SAFE by default:
 * the query is steered toward no-copyright/royalty-free uploads and the results
 * are filtered to ones that declare it in their title or channel. If the filter
 * would leave almost nothing, the steered results are returned unfiltered (each
 * flagged) rather than showing an empty list.
 */
async function ytSearch({ query, limit = 12, copyrightFree = false }) {
  const q = String(query || '').trim();
  if (!q) return [];
  // A bare URL should resolve to that one video instead of being searched for.
  const isUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(q);
  const steer = copyrightFree && !isUrl && !FREE_MARKERS.test(q);
  const effective = steer ? `${q} no copyright music` : q;
  // Ask for extra results when filtering, so the safe ones still fill the list.
  const want = Math.max(1, Math.min(25, copyrightFree && !isUrl ? limit * 2 : limit));
  const target = isUrl ? (q.startsWith('http') ? q : 'https://' + q) : `ytsearch${want}:${effective}`;
  const raw = await runYtWithRepair(['--flat-playlist', '--no-warnings', '-J', target], { timeoutMs: 60000 });
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('Could not read the YouTube results.'); }
  const entries = data && Array.isArray(data.entries) ? data.entries : [data];
  let out = entries.filter(Boolean).map((e) => ({
    id: e.id,
    title: e.title || 'Untitled',
    uploader: e.uploader || e.channel || '',
    durationSec: e.duration || 0,
    url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    thumb: (e.thumbnails && e.thumbnails.length ? e.thumbnails[e.thumbnails.length - 1].url : e.thumbnail) || null,
  })).filter((e) => e.id);
  out.forEach((e) => { e.copyrightFree = looksCopyrightFree(e); });
  if (copyrightFree && !isUrl) {
    const safe = out.filter((e) => e.copyrightFree);
    // enough declared-free tracks → show only those; otherwise the steered
    // results are still the right neighbourhood, just not self-labelled
    out = (safe.length >= 3 ? safe : out).slice(0, limit);
  }
  return out;
}

/* yt-dlp goes stale (YouTube changes, the old binary starts failing). When a
 * search fails and the helper is OUR copy in <userData>/tools, self-update it
 * once (`yt-dlp -U`) and retry — the user just sees the search take a little
 * longer instead of a broken YouTube tab. */
let triedSelfUpdate = false;
async function runYtWithRepair(args, opts) {
  try {
    return await runYt(args, opts);
  } catch (err) {
    const cli = ytPath();
    const ours = cli && cli.startsWith(toolsDir());
    if (!ours || triedSelfUpdate || /isn.t installed/i.test(err.message || '')) throw err;
    triedSelfUpdate = true;
    try { await runYt(['-U'], { timeoutMs: 120000 }); } catch (e) { throw err; /* update failed — report the original error */ }
    return runYt(args, opts);
  }
}

/** Download, getting past a stale helper or YouTube's robot check where it can. */
async function getAudio(args, url, opts) {
  const withPlayer = (p) => args.slice(0, -1).concat(p ? ['--extractor-args', 'youtube:player_client=' + p] : [], [url]);
  let last;
  try { return await runYtWithRepair(args, opts); } catch (e) { last = e; }
  if (!isBotCheck(last)) throw last;
  for (const p of PLAYER_FALLBACKS) {
    try { return await runYt(withPlayer(p), opts); } catch (e) {
      if (e instanceof jobs.CancelledError) throw e;
      last = e;
      if (!isBotCheck(e)) break;
    }
  }
  if (isBotCheck(last)) throw botCheckHelp();
  throw last;
}

/**
 * Import a YouTube video's AUDIO into the music library.
 *
 * Only the user knows whether they have the right to use a given track, so the
 * UI states that plainly next to the search box; this function just does what it
 * is told with a file the user picked.
 */
async function ytImport(ctx, video, { url, title, onProgress }) {
  if (!url) throw new Error('Pick a YouTube video first.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-yt-'));
  const args = [
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--no-playlist', '--no-warnings', '--no-part',
    '-o', path.join(dir, 'track.%(ext)s'),
  ];
  if (ctx && ctx.ffmpeg) args.push('--ffmpeg-location', ctx.ffmpeg);
  args.push(url);
  try {
    await getAudio(args, url, { onProgress, timeoutMs: 900000 });
    const got = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => /\.(mp3|m4a|opus|webm|ogg|wav)$/i.test(f));
    if (!got.length) throw new Error('Nothing was downloaded from that video.');
    return await add(ctx, video, { kind: 'music', path: got[0], name: title || 'YouTube track', source: 'youtube' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = {
  init, list, add, remove, rename, root, toolsDir, relevel,
  ytPath, ytStatus, ytInstall, ytSearch, ytImport, looksCopyrightFree, ytAuthArgs, isBotCheck,
  MUSIC_EXT, CLIP_EXT, STILL_EXT, STILL_SEC, safeName,
};
