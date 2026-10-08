'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const video = require('./video');
const jobs = require('./jobs');
const machine = require('./machine');
const wordbook = require('./wordbook');

/*
 * Automatic captions: on-device speech-to-text (whisper.cpp) with WORD-LEVEL
 * timing, then CapCut-style styled burn-in via ffmpeg/libass. Fully offline.
 */

/**
 * Where a whisper.cpp CLI may live, most-preferred first, relative to bin/whisper
 * (or Resources/whisper when packaged).
 *
 * Windows ships `Release/whisper-cli.exe`. macOS/Linux use an extension-less
 * binary, and we accept the layouts people actually end up with: an arch-suffixed
 * drop (`whisper-cli-arm64`, so an x64 and an arm64 build can sit side by side),
 * whisper.cpp's own release layout (`build/bin/whisper-cli`), or the binary
 * dropped straight into the folder. Exported (and pure) so it can be unit-tested
 * for a platform this machine isn't.
 */
function cliCandidates(platform, arch) {
  if (platform === 'win32') return [path.join('Release', 'whisper-cli.exe'), 'whisper-cli.exe'];
  const names = [`whisper-cli-${arch}`, 'whisper-cli'];
  const dirs = ['Release', path.join('build', 'bin'), 'bin', '.'];
  const out = [];
  for (const d of dirs) for (const n of names) out.push(d === '.' ? n : path.join(d, n));
  return out;
}
function whisperBaseDir() {
  const packaged = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'whisper'));
  return packaged ? path.join(process.resourcesPath, 'whisper') : path.join(__dirname, '..', '..', 'bin', 'whisper');
}
/** First candidate that exists under `base`, or null. */
function findCli(base, platform, arch) {
  for (const rel of cliCandidates(platform || process.platform, arch || process.arch)) {
    const p = path.join(base, rel);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) {}
  }
  return null;
}
function whisperPaths() {
  const base = whisperBaseDir();
  const found = findCli(base);
  return {
    base,
    // `cli` is the resolved binary when one exists, otherwise the canonical place
    // to put it — so error messages can name an exact path.
    cli: found || path.join(base, cliCandidates(process.platform, process.arch)[0]),
    cliFound: !!found,
    model: path.join(base, 'ggml-base.en.bin'),
    modelTiny: path.join(base, 'ggml-tiny.en.bin'),
  };
}
/* --------------------------- speech models ------------------------------
 *
 * `base.en` ships with the app and is what everything ran on. It is a 74M-
 * parameter model and it mishears — on a real sermon it wrote "STEPPING GO
 * GIVING" for "stepping, giving God praise". No amount of decoder tuning fixes
 * a model that small; the single biggest accuracy lever there is is a BIGGER
 * model, and the only reason not to ship one is the installer.
 *
 * So the bigger ones are an optional ONE-TIME DOWNLOAD into <userData>/models.
 * The installer stays the size it was, and a church that wants the best
 * captions clicks once in Settings and gets them forever after — offline from
 * then on, like the Bible translations. Ranked worst-to-best; whichever of
 * these is installed and highest-ranked is what captions use.
 */
const MODELS = [
  // Bundled with the desktop app; a SERVER image carries no models, so these
  // two can be fetched as well — Tiny is the one a 512 MB server can hold.
  { id: 'tiny.en', file: 'ggml-tiny.en.bin', name: 'Tiny (fastest, roughest)', sizeMB: 78, rank: 0, bundled: true,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin' },
  { id: 'base.en', file: 'ggml-base.en.bin', name: 'Base (ships with the app)', sizeMB: 148, rank: 1, bundled: true,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' },
  { id: 'small.en', file: 'ggml-small.en.bin', name: 'Small — much more accurate', sizeMB: 466, rank: 2,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin' },
  { id: 'medium.en', file: 'ggml-medium.en.bin', name: 'Medium — very accurate, slow', sizeMB: 1533, rank: 3,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin' },
  /*
   * TURBO — large-v3's accuracy without large-v3's decoder.
   *
   * OpenAI's turbo release keeps the full encoder and cuts the decoder from 32
   * layers to 4, which is where nearly all the decoding time goes. It is the
   * only model above Medium worth offering here: measured on this machine,
   * Medium already runs at 3.2x SLOWER than real time (128.9 s for 39.8 s of
   * audio), and plain large-v3 is roughly twice that again — useless for
   * anything that has to keep up with a service.
   *
   * DELIBERATELY NOT SHIPPED: large-v3 itself (2951 MB). It is more accurate
   * than turbo by a hair and hopelessly slower, so offering it would only be a
   * way for a church to make their captions take all afternoon.
   *
   * Multilingual rather than .en — there is no English-only turbo — which
   * costs nothing here because every call passes `-l en`.
   */
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', name: 'Turbo — the best, and quick with it', sizeMB: 1549, rank: 4,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin' },
];
let MODELS_DIR = null;                  // <userData>/models — set by init()
function init(userDataDir) {
  MODELS_DIR = path.join(userDataDir, 'models');
  try { fs.mkdirSync(MODELS_DIR, { recursive: true }); } catch (e) {}
}
/** Where a model lives: the download folder first, then the bundled bin/whisper. */
function modelPath(m) {
  const cands = [];
  if (MODELS_DIR) cands.push(path.join(MODELS_DIR, m.file));
  cands.push(path.join(whisperBaseDir(), m.file));
  for (const p of cands) { try { if (fs.existsSync(p) && fs.statSync(p).size > 1e6) return p; } catch (e) {} }
  return null;
}
/*
 * A MODEL THIS MACHINE CAN HOLD. whisper is the biggest thing the studio
 * runs: Small needs about 850 MB and Base about 390. On a desktop that is
 * nothing; on a 512 MB server, starting one gets the whole studio killed for
 * memory mid-job — the operator saw a 502 and lost the job they were waiting
 * on. So a model that does not fit steps down to the best installed one that
 * does, and when none does, the caller gets a sentence saying so instead of a
 * crash.
 */
function fitModel(chosenPath) {
  const m = MODELS.find((x) => chosenPath && path.basename(chosenPath) === x.file);
  if (!m || machine.fitsWhisper(m.id)) return { path: chosenPath };
  const down = MODELS.filter((x) => x.rank < m.rank && machine.fitsWhisper(x.id) && modelPath(x))
    .sort((x, y) => y.rank - x.rank)[0];
  if (down) return { path: modelPath(down), steppedFrom: m.id, id: down.id };
  return { path: null, need: m };
}

/** Every model, with where it is and whether it's the one captions will use. */
function models() {
  const best = bestModel();
  return MODELS.map((m) => {
    const p = modelPath(m);
    return { id: m.id, name: m.name, sizeMB: m.sizeMB, bundled: !!m.bundled,
      installed: !!p, path: p, downloadable: !!m.url, inUse: !!best && best.id === m.id };
  });
}
/** The highest-ranked model actually present — what captions transcribe with. */
function bestModel() {
  let best = null;
  for (const m of MODELS) { if (m.rank >= 1 && modelPath(m) && (!best || m.rank > best.rank)) best = m; }
  return best;
}
/*
 * WHICH MODEL A LONG-TO-SHORTS SCAN LISTENS WITH.
 *
 * These two rules are different on purpose, and the difference is the whole
 * point of this function:
 *
 *  • AUTOMATIC stops at Small. Captioning reads one 90-second clip; a scan reads
 *    the best part of an HOUR of a long service, and Medium is roughly 3x
 *    slower — so a church that downloaded Medium for nicer captions must not
 *    silently discover their 30-minute scan now takes an hour and a half.
 *  • AN EXPLICIT CHOICE IS AN INSTRUCTION, Medium included. The operator picked
 *    it from the Hearing dropdown, having been told the cost; second-guessing
 *    them there would just be the cap wearing a different hat.
 *
 * Pure and exported so the ladder can be tested without a whisper install.
 */
const SCAN_AUTO = ['small.en', 'base.en'];
function pickScanModel(installedIds, requested) {
  const installed = new Set(installedIds || []);
  if (requested && installed.has(requested) && MODELS.some((m) => m.id === requested)) return requested;
  return SCAN_AUTO.find((id) => installed.has(id)) || 'base.en';
}

function modelFor(kind) {
  const p = whisperPaths();
  /*
   * An explicit model id — the operator picked it from a dropdown — wins
   * outright when it is actually installed. Falls through to the keyword
   * shortcuts below if not.
   *
   * MATCHED AGAINST THE LIST, not by looking for a dot. This used to be
   * `kind.includes('.')`, which worked only because every id happened to end
   * in `.en`; `large-v3-turbo` has no dot in it, so an operator who chose
   * Turbo fell straight past this branch and silently got whatever bestModel()
   * fancied instead of the model they asked for.
   */
  if (kind && MODELS.some((x) => x.id === kind)) {
    const m = MODELS.find((x) => x.id === kind);
    const mp = m && modelPath(m);
    if (mp) return mp;
  }
  if (kind === 'tiny' && fs.existsSync(p.modelTiny)) return p.modelTiny;
  // 'best' (and the default) climb to the most accurate installed model; an
  // explicit 'base' pins the bundled one (the highlights scanner wants speed).
  if (kind === 'base') return p.model;
  const b = bestModel();
  return (b && modelPath(b)) || p.model;
}

/**
 * Download an optional model. Streams to a .part file and only renames on a
 * complete, correctly-sized transfer, so a dropped connection can never leave a
 * truncated model that whisper would load and produce gibberish from.
 */
function downloadModel(id, { onProgress } = {}) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error('Unknown speech model: ' + id);
  if (!m.url) throw new Error(`${m.name} ships with the app — there is nothing to download.`);
  if (!MODELS_DIR) throw new Error('The model folder is not ready yet.');
  const dest = path.join(MODELS_DIR, m.file);
  const part = dest + '.part';
  return new Promise((resolve, reject) => {
    const https = require('https');
    const get = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects fetching the model.'));
      https.get(url, { headers: { 'user-agent': 'ChurchWorkSpace' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode}).`)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        const out = fs.createWriteStream(part);
        res.on('data', (d) => {
          got += d.length;
          if (onProgress && total) onProgress(Math.min(99, Math.round((got / total) * 100)));
        });
        res.on('error', (e) => { try { out.destroy(); fs.unlinkSync(part); } catch (er) {} reject(e); });
        out.on('error', reject);
        out.on('close', () => {
          if (total && got !== total) { try { fs.unlinkSync(part); } catch (e) {} return reject(new Error('The download was cut short — please try again.')); }
          try { fs.renameSync(part, dest); } catch (e) { return reject(e); }
          if (onProgress) onProgress(100);
          resolve({ id: m.id, path: dest, bytes: got });
        });
        res.pipe(out);
      }).on('error', reject);
    };
    get(m.url);
  });
}
/** Delete a downloaded model (bundled ones can't be removed). */
function removeModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m || m.bundled || !MODELS_DIR) return false;
  try { fs.rmSync(path.join(MODELS_DIR, m.file), { force: true }); return true; } catch (e) { return false; }
}
function fontsDir() {
  const packaged = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'fonts'));
  return packaged ? path.join(process.resourcesPath, 'fonts') : path.join(__dirname, '..', '..', 'bin', 'fonts');
}
/*
 * ANY MODEL ON DISK WILL DO. This asked for Base by name, so the Cloud Studio
 * image — engine built in, Tiny the one model a 512 MB server can run — told
 * the phone "The speech model is missing" and captions never started, though
 * transcribe() already steps down to Tiny when Base is not there.
 */
function anyModel() {
  const p = whisperPaths();
  if (fs.existsSync(p.model)) return p.model;
  for (const m of MODELS) { const mp = modelPath(m); if (mp) return mp; }
  return null;
}
function isAvailable() {
  const { cli, cliFound } = whisperPaths();
  return !!cliFound && fs.existsSync(cli) && !!anyModel();
}

/**
 * A binary copied out of a zip / off the internet usually arrives without the
 * execute bit, and on macOS with a `com.apple.quarantine` flag that makes the OS
 * kill it on launch. Both are silent, confusing failures ("Could not start the
 * speech engine"), and both are one call to fix — so fix them instead of making
 * the user find out. Best-effort: never throws.
 */
function ensureExecutable(cli) {
  if (process.platform === 'win32') return;
  try {
    fs.accessSync(cli, fs.constants.X_OK);
  } catch (e) {
    try { fs.chmodSync(cli, 0o755); } catch (e2) { /* read-only volume — reported later */ }
  }
  if (process.platform === 'darwin') {
    try { require('child_process').spawnSync('xattr', ['-d', 'com.apple.quarantine', cli], { stdio: 'ignore' }); } catch (e) {}
  }
}

/**
 * Why auto-captions are (or aren't) usable, in words the UI can show. Keeps the
 * "not available in this build" dead end from being the end of the story.
 */
function engineInfo() {
  const p = whisperPaths();
  const hasCli = !!p.cliFound;
  const found = anyModel();
  const hasModel = !!found;
  const info = {
    available: hasCli && hasModel,
    platform: process.platform, arch: process.arch,
    cli: p.cli, model: found || p.model, hasCli, hasModel,
  };
  if (info.available) return info;
  if (!hasCli && process.platform === 'darwin') {
    info.reason = 'This macOS build does not include the on-device speech engine yet.';
    info.howTo = `Drop a macOS whisper.cpp binary at bin/whisper/Release/whisper-cli-${process.arch} (or whisper-cli) and rebuild — see BUILD-MAC.md §5. Everything else about captions (styling, editing on the timeline, burning them into the video) already works.`;
  } else if (!hasCli) {
    info.reason = 'The speech engine binary is missing from this install.';
    info.howTo = `Expected it at ${p.cli}. Reinstalling the app restores it.`;
  } else {
    info.reason = 'No speech model is installed.';
    info.howTo = `Expected ggml-base.en.bin or ggml-tiny.en.bin in ${p.base}. Reinstalling the app restores it — on a server, add a free Groq key as GROQ_API_KEY and speech is heard in the cloud instead.`;
  }
  return info;
}

// dropdown value -> the font family name libass matches (bundled .ttf or system)
/*
 * The caption typefaces, in the order the picker offers them: the heavy display
 * faces that short-form video actually uses first, the friendlier and more
 * ordinary ones after.
 *
 * Each entry maps the NAME THE OPERATOR PICKS to the family recorded INSIDE the
 * font file, because that is the only string libass will match on — and the two
 * are not always the same. A file downloaded as "Rubik-ExtraBold" calls itself
 * "Rubik ExtraBold", and asking for "Rubik" silently falls back to Arial. `file`
 * is what the renderer needs to show each name IN its own typeface.
 *
 * All of these are OFL/Apache licensed, so they ship with the app and work
 * offline. (A note on requests: "Sequel" is a commercial family and cannot be
 * bundled — Archivo Black and Anton are the closest free equivalents.)
 */
const FONT_LIST = [
  // heavy display — the short-form staples
  { name: 'Bebas Neue', family: 'Bebas Neue', file: 'BebasNeue-Regular.ttf' },
  { name: 'Anton', family: 'Anton', file: 'Anton-Regular.ttf' },
  { name: 'Archivo Black', family: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf' },
  { name: 'Rubik', family: 'Rubik ExtraBold', file: 'Rubik-ExtraBold.ttf' },
  { name: 'Montserrat', family: 'Montserrat ExtraBold', file: 'Montserrat-ExtraBold.ttf' },
  { name: 'Oswald', family: 'Oswald', file: 'Oswald-Bold.ttf' },
  { name: 'Teko', family: 'Teko', file: 'Teko-Bold.ttf' },
  // blocky + chunky
  { name: 'Bungee', family: 'Bungee', file: 'Bungee-Regular.ttf' },
  { name: 'Sigmar One', family: 'Sigmar One', file: 'SigmarOne-Regular.ttf' },
  { name: 'Bowlby One', family: 'Bowlby One', file: 'BowlbyOne-Regular.ttf' },
  { name: 'Titan One', family: 'Titan One', file: 'TitanOne-Regular.ttf' },
  { name: 'Lilita One', family: 'Lilita One', file: 'LilitaOne-Regular.ttf' },
  { name: 'Luckiest Guy', family: 'Luckiest Guy', file: 'LuckiestGuy-Regular.ttf' },
  { name: 'Passion One', family: 'Passion One', file: 'PassionOne-Bold.ttf' },
  { name: 'Alfa Slab One', family: 'Alfa Slab One', file: 'AlfaSlabOne-Regular.ttf' },
  { name: 'Bangers', family: 'Bangers', file: 'Bangers-Regular.ttf' },
  // rounded / clean
  { name: 'Fredoka', family: 'Fredoka', file: 'Fredoka-Bold.ttf' },
  { name: 'Poppins', family: 'Poppins', file: 'Poppins-Bold.ttf' },
  // elegant, for a title card rather than a sermon clip
  { name: 'Playfair Display', family: 'Playfair Display ExtraBold', file: 'PlayfairDisplay-ExtraBold.ttf' },
  { name: 'Pacifico', family: 'Pacifico', file: 'Pacifico-Regular.ttf' },
  { name: 'Great Vibes', family: 'Great Vibes', file: 'GreatVibes-Regular.ttf' },
  // always available, never bundled
  { name: 'Arial', family: 'Arial', file: null },
];
const FONTS = FONT_LIST.reduce((m, f) => { m[f.name] = f.family; return m; }, {});
const SIZE_PCT = { xs: 0.036, s: 0.045, m: 0.058, l: 0.072, xl: 0.088 };

/* ------------------------- how a caption line ARRIVES -------------------------
 *
 * Short-form captions rarely just appear — they pop, they rise, they fade in,
 * and a sermon clip without that reads as older than it is.
 *
 * Each of these is one ASS override tag written at the head of the line. They
 * are deliberately built from tags that need NO absolute coordinates, because a
 * caption's position comes from its alignment and margins: `\move` would demand
 * the anchor point in pixels and would override that alignment, so "slide" is
 * made with a vertical scale-in rather than by moving the line around the frame.
 *
 * Every transition is given the line's OWN duration, so it can never be longer
 * than the line it decorates — a 190ms bounce on a 120ms word would still be
 * growing when the word disappeared.
 */
const CAP_TRANSITIONS = [
  { id: 'none', name: 'None' },
  { id: 'fade', name: 'Fade' },
  { id: 'pop', name: 'Pop' },
  { id: 'bounce', name: 'Bounce' },
  { id: 'slideup', name: 'Slide up' },
  { id: 'zoom', name: 'Zoom out' },
  { id: 'typewriter', name: 'Typewriter' },
];
const capTransition = (id) => CAP_TRANSITIONS.find((t) => t.id === id) || CAP_TRANSITIONS[0];

/**
 * The override tag that makes one line arrive, sized to that line's duration.
 * Returns '' for 'none' (and for 'typewriter', which is not a prefix at all —
 * see capTypewriterText).
 */
function capEnterTag(id, durationSec) {
  const t = capTransition(id).id;
  if (t === 'none' || t === 'typewriter') return '';
  const ms = Math.max(60, Math.round((durationSec || 1) * 1000));
  const cap = (v, max) => Math.max(30, Math.min(max, Math.round(v)));
  if (t === 'fade') return '{\\fad(' + cap(ms * 0.35, 200) + ',' + cap(ms * 0.25, 160) + ')}';
  if (t === 'pop') return '{\\fscx60\\fscy60\\t(0,' + cap(ms * 0.30, 140) + ',\\fscx100\\fscy100)}';
  if (t === 'bounce') {
    const a = cap(ms * 0.25, 110), b = Math.max(a + 30, cap(ms * 0.45, 190));
    return '{\\fscx45\\fscy45\\t(0,' + a + ',\\fscx112\\fscy112)\\t(' + a + ',' + b + ',\\fscx100\\fscy100)}';
  }
  if (t === 'slideup') {
    const d = cap(ms * 0.32, 160);
    return '{\\fad(' + Math.round(d * 0.8) + ',0)\\fscy55\\t(0,' + d + ',\\fscy100)}';
  }
  if (t === 'zoom') return '{\\fscx165\\fscy165\\t(0,' + cap(ms * 0.33, 170) + ',\\fscx100\\fscy100)}';
  return '';
}

/**
 * Typewriter is the odd one out: not one line with a tag, but a SEQUENCE of
 * lines, each showing one more character than the last.
 *
 * The obvious implementation — karaoke timing (\k) — does not do this. Karaoke
 * recolours un-sung text from the primary to the secondary colour; it does not
 * hide it, and the outline is drawn for the whole line regardless. What you get
 * is a colour sweep across fully-visible words, which is not a typewriter and
 * measurably barely moves. Growing the text itself is unambiguous, and it costs
 * only a handful of extra subtitle lines.
 */
function capTypewriterLines(text, start, end) {
  const full = String(text || '');
  // A `\N` break is ONE thing to type, not a backslash followed by an N — the
  // line breaks come in pre-computed now, and typing them out literally would
  // put "\" and "N" on the picture for a frame each.
  const chars = full.split(/(\\N)/).filter(Boolean).flatMap((p) => (p === '\\N' ? [p] : [...p]));
  if (chars.length < 2) return [{ start, end, text: full }];
  const dur = Math.max(0.06, end - start);
  // Type across the first part of the line, then hold the finished words. A
  // caption the viewer never gets to READ is a worse caption, however good the
  // effect, so the reveal never eats more than half the time it is on screen.
  const typeFor = Math.min(dur * 0.5, 0.9);
  const step = typeFor / chars.length;
  const out = [];
  for (let i = 1; i <= chars.length; i++) {
    const a = start + step * (i - 1);
    const b = i === chars.length ? end : start + step * i;
    const piece = chars.slice(0, i).join("");
    if (piece.trim()) out.push({ start: a, end: b, text: piece });
  }
  return out;
}

// The speech engine is the biggest single process a small server runs (Tiny
// alone is ~270 MB), so it takes its turn with the ffmpegs — see ffmpeg.gated.
function runWhisper(cli, args, onProgress) {
  return ff.gated(() => runWhisperNow(cli, args, onProgress));
}
function runWhisperNow(cli, args, onProgress) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(cli);
    ensureExecutable(cli);
    // Windows finds whisper's DLLs via cwd. macOS/Linux resolve .dylib/.so through
    // the loader path, so a DYNAMICALLY linked whisper.cpp build (the default for
    // most release zips) needs its own folder on the library path — otherwise it
    // dies with "image not found" before printing anything useful.
    const env = Object.assign({}, process.env);
    if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = [dir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
      env.DYLD_FALLBACK_LIBRARY_PATH = [dir, env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':');
    } else if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
    const proc = jobs.track(spawn(cli, args, { windowsHide: true, cwd: dir, env }));
    let stderr = '';
    const handle = (buf) => {
      const s = buf.toString(); stderr += s; if (stderr.length > 100000) stderr = stderr.slice(-50000);
      const m = /progress\s*=\s*(\d+)%/.exec(s); if (m && onProgress) onProgress(parseInt(m[1], 10));
    };
    proc.stdout.on('data', handle); proc.stderr.on('data', handle);
    proc.on('error', (e) => reject(new Error('Could not start the speech engine: ' + startupHint(e, cli))));
    proc.on('close', (code) => {
      // Cancelled by the user (we SIGKILLed it) — not a transcription failure.
      if (jobs.isCancelled()) return reject(new jobs.CancelledError());
      // whisper-cli meets a flag it does not know with its help text and exit code 0, writing nothing
      if (code === 0 && /error: unknown argument/i.test(stderr)) {
        return reject(new Error('The speech engine on this machine is too old for an option the studio used ('
          + ((/unknown argument:\s*(\S+)/i.exec(stderr) || [])[1] || '?') + ').'));
      }
      if (code === 0) return resolve(stderr);
      // macOS kills a quarantined/unsigned binary with SIGKILL and no output —
      // say what that means instead of showing an empty "Transcription failed".
      if (process.platform === 'darwin' && !stderr.trim()) {
        return reject(new Error(`The speech engine would not run (macOS blocked it).\nIn Terminal:  xattr -cr "${cli}"  then try again.`));
      }
      reject(new Error('Transcription failed.\n' + stderr.slice(-1500)));
    });
  });
}
/** Turn a spawn errno into something a media volunteer can act on. */
function startupHint(e, cli) {
  const msg = e.message || String(e);
  if (e.code === 'EACCES') return `${msg}\nThe file is not executable. In Terminal:  chmod +x "${cli}"`;
  if (e.code === 'ENOENT') return `${msg}\nExpected the binary at: ${cli}`;
  if (process.platform === 'darwin' && /Exec format|arch/i.test(msg)) {
    return `${msg}\nThat binary is built for a different CPU — this Mac is ${process.arch}. Download the ${process.arch} whisper.cpp build.`;
  }
  return msg;
}

/**
 * What the speech engine actually HEARS.
 *
 * Whisper is fed 16k mono either way; the question is what shape that audio is
 * in — and the answer is NOT "as processed as possible". Measured on 99s of real
 * sermon, against a small.en transcription as the reference:
 *
 *   highpass only ................. 13.2% of words differ   <- best
 *   + dynaudnorm .................. 16.8%
 *   + speechnorm .................. 17.1%
 *   nothing at all ................ 17.7%
 *   + spectral de-noise ........... 20.7%   <- worst
 *
 * So levelling and de-noising, both of which make audio nicer to a human ear,
 * make it HARDER for the model: they move energy around inside the exact bands
 * the acoustic model was trained on. The high-pass is the one that helps,
 * because sub-70Hz rumble carries no speech at all and only eats headroom.
 *
 * That is why de-noising is opt-in here (`denoise`, 0..1) and off by default,
 * even though the very same afftdn is what cleans the audio that reaches the
 * finished video. Different jobs, opposite answers.
 *
 * ffmpeg keeps these filters PTS-aligned, so word timings are unaffected —
 * test/captions-accuracy.test.js measures the drift to prove it.
 *
 * When de-noising IS asked for, it is the very same chain the finished video
 * gets (video.noiseReductionAf, floor and all) rather than a second, subtly
 * different one — one implementation, one set of measurements behind it.
 */
function asrAudioFilter({ denoise = 0, floorDb } = {}) {
  return video.noiseReductionAf(denoise, { floorDb }) || 'highpass=f=70';
}

/**
 * Words (with timings) out of whisper's FULL json (`-ojf`), which carries every
 * token with its own offsets. Returns null when the file has no token detail, so
 * the caller can fall back to the old one-word-per-segment run.
 *
 * Why this exists: word-level captions used to be produced by asking whisper for
 * one-word segments (`-ml 1 --split-on-word`). That forces the decoder to chop
 * its own output, which is both slower and worse — the model loses the sentence
 * context it uses to choose between homophones. Reading the tokens of a NORMAL
 * transcription gives the same word timings (measured: median 80ms apart, p90
 * 160ms) off a decode that got to hear whole sentences.
 */
/**
 * The `--dtw` preset for a model file, plus the flag that lets it run.
 *
 * whisper names its alignment-head presets after the model ("base.en",
 * "medium.en"…), so the preset is read back off the file we are about to load.
 * An unrecognised file (someone dropped in their own) gets no DTW rather than a
 * wrong preset, and captions fall back to the token timestamps as before.
 */
// whisper.cpp's own names for the alignment presets (examples/cli/cli.cpp): dots, not dashes —
// "-dtw large-v3-turbo" is refused ("unknown DTW preset", exit 3), so every Turbo caption failed
const DTW_PRESET = { 'large-v3-turbo': 'large.v3.turbo', 'large-v3': 'large.v3', 'large-v2': 'large.v2', 'large-v1': 'large.v1' };
const dtwPreset = (id) => DTW_PRESET[id] || id;
function dtwFor(modelPath, cli) {
  const m = MODELS.find((x) => String(modelPath || '').endsWith(x.file));
  if (!m) return [];
  const preset = dtwPreset(m.id);
  /*
   * Only the flags THIS whisper-cli knows. Measured on the Oracle server: the
   * image's whisper.cpp (v1.7.4) has no `-nfa` (flash attention was opt-in
   * then, so DTW needs nothing switched off) — and whisper-cli answers an
   * unknown flag by printing its help and exiting 0 without writing a word,
   * so every caption the server heard itself failed with "Could not read the
   * transcription". Asked once per binary.
   */
  if (cli) {
    const help = cliHelp(cli);
    if (help && !/(^|\s)-dtw\b|--dtw\b/.test(help)) return [];
    if (help && !/(^|\s)-nfa\b|--no-flash-attn\b/.test(help)) return ['-dtw', preset];
  }
  return ['-nfa', '-dtw', preset];
}
const helpOf = new Map();
/** whisper-cli's own list of flags ('' when it cannot be read). */
function cliHelp(cli) {
  if (helpOf.has(cli)) return helpOf.get(cli);
  let text = '';
  // runnable first (a fresh unzip has no exec bit), and only a real answer is remembered —
  // a failed read once wedged the flags until the app was restarted (found by review)
  try { ensureExecutable(cli); } catch (e) {}
  try {
    const dir = path.dirname(cli);
    const env = Object.assign({}, process.env);
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = [dir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
    const r = require('child_process').spawnSync(cli, ['-h'], { cwd: dir, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    text = String((r.stdout || '') + (r.stderr || ''));
  } catch (e) { text = ''; }
  if (/usage|-m FNAME|--model/i.test(text)) helpOf.set(cli, text);
  return text;
}

function wordsFromTokens(json) {
  const out = [];
  for (const seg of (json && json.transcription) || []) {
    const toks = seg.tokens || [];
    let cur = null;
    for (const t of toks) {
      const raw = t && t.text != null ? String(t.text) : '';
      // whisper's own markers: [_BEG_], [_TT_123], [_SOT_] … never spoken words
      if (!raw.trim() || raw[0] === '[') continue;
      const off = t.offsets || {};
      /*
       * `t_dtw` is the audio-aligned moment, in hundredths of a second, and it
       * is the one to believe: the plain offsets bunch nine words into half a
       * second where DTW spreads them across the four they were spoken in. It is
       * -1 when whisper did not compute it (an unknown model, or an older
       * build), and then the offsets are all there is.
       */
      const dtw = Number(t.t_dtw);
      const hasDtw = Number.isFinite(dtw) && dtw >= 0;
      const s = hasDtw ? dtw / 100 : (off.from || 0) / 1000;
      const e = hasDtw ? Math.max(s, (off.to || 0) / 1000) : (off.to || 0) / 1000;
      if (/^\s/.test(raw) || !cur) { if (cur) out.push(cur); cur = { start: s, end: Math.max(s, e), text: raw.trim(), dtw: hasDtw }; }
      else { cur.text += raw; cur.end = Math.max(cur.end, e); }
    }
    if (cur) out.push(cur);
  }
  if (!out.length) return null;
  // Whisper can hand back a zero-length token (start === end). A caption block of
  // zero duration is invisible, so give every word a minimum on-screen life and
  // keep the sequence monotonic.
  let prev = 0;
  for (const w of out) {
    w.start = Math.max(0, Math.min(w.start, w.end));
    if (w.start < prev) w.start = prev;
    w.end = Math.max(w.end, w.start + 0.06);
    prev = w.start;
  }
  /*
   * DTW gives each token a MOMENT, not a span, so a word's end still comes from
   * the bunched offsets and can land well before the next word begins — which
   * would end a caption line in the middle of its own last word. A word runs
   * until the next one starts, capped so that a real pause still reads as one
   * rather than holding the line on screen through it.
   */
  if (out.some((w) => w.dtw)) {
    /*
     * DTW MARKS A WORD A SIXTH OF A SECOND LATE, AND ALWAYS THE SAME WAY.
     *
     * The alignment locks onto the vowel; the ear hears the consonant in front
     * of it. On a caption LINE that is nothing. On a word that lights up it is
     * five frames of colour sitting on a word the speaker has already left.
     *
     * Measured against the recording itself, on the one thing that cannot be
     * fooled by a shift: A WORD CANNOT START WHILE NOBODY IS SPEAKING. Take the
     * silences out of the audio, sweep the lead, and count how many word starts
     * land inside one (18.2% of this teaching is silence, so that is what pure
     * chance would score):
     *
     *     lead   0.00   0.05   0.10   0.15   0.20   0.25   0.30
     *     in     3.86%  2.70%  1.73%  1.05%  1.76%  4.20%  6.53%
     *
     * A clear minimum at 0.15, over 2,666 words. Beware the obvious measurement
     * instead of this one — matching each speech onset to the NEAREST word is
     * blind to exactly the error being corrected, because shifting a whole run
     * of words just makes it pick a different one.
     */
    const LEAD = 0.15;
    for (const w of out) w.start = Math.max(0, w.start - LEAD);
    const HOLD = 1.2;
    for (let i = 0; i < out.length; i++) {
      const next = out[i + 1];
      const until = next ? Math.min(next.start, out[i].start + HOLD) : out[i].start + Math.min(HOLD, Math.max(0.3, out[i].end - out[i].start));
      out[i].end = Math.max(out[i].start + 0.06, until);
    }
  }
  return out.filter((w) => w.text).map((w) => ({ start: w.start, end: w.end, text: w.text }));
}

/**
 * Transcribe -> timed text chunks. Returns { words: [{start,end,text}], durationSec }.
 *
 * granularity:'word' (default, for captions) gives one WORD per entry;
 * granularity:'segment' (for sermon-highlight boundaries) gives whisper's natural
 * punctuated PHRASE/SENTENCE segments — faster AND carries the punctuation we
 * need to cut clips on complete-sentence boundaries.
 *
 * Both now come out of ONE ordinary decode. Word mode reads the per-token
 * timestamps out of the full json instead of making whisper emit one-word
 * segments, which is what lets captions afford beam search: the old word mode
 * was greedy-only because chopping into words was already slow, and greedy is
 * exactly where the misheard words came from.
 */
async function transcribe(ctx, { input, startSec, endSec, model: modelKind, granularity = 'word', fast, threads: threadsOpt, denoise, onProgress }) {
  const { cli } = whisperPaths();
  const wanted = modelFor(modelKind);
  const engineMissing = () => {
    const i = engineInfo();
    return new Error([i.reason, i.howTo].filter(Boolean).join(' ') || 'The speech engine/model is missing. Please reinstall the app.');
  };
  if (!isAvailable()) throw engineMissing();
  // a model this machine can hold — see fitModel
  let fit = fs.existsSync(wanted) ? fitModel(wanted) : { path: null, need: MODELS.find((x) => x.id === 'base.en') };
  /*
   * SOMETHING ALWAYS FITS. When nothing installed does — a server image has no
   * models at all, and the one the operator chose can be too big for it — Tiny
   * is fetched once (78 MB) and used. Rough, but words, not a crash.
   */
  const tiny = MODELS.find((x) => x.id === 'tiny.en');
  if (!fit.path && machine.fitsWhisper(tiny.id) && !modelPath(tiny) && MODELS_DIR) {
    try {
      if (onProgress) onProgress(1);
      await downloadModel(tiny.id, {});
      fit = { path: modelPath(tiny), id: tiny.id };
    } catch (e) { /* the message below says what to do */ }
  } else if (!fit.path && modelPath(tiny) && machine.fitsWhisper(tiny.id)) {
    fit = { path: modelPath(tiny), id: tiny.id };
  }
  if (!fit.path && !fit.need) throw engineMissing();
  if (!fit.path) {
    throw new Error(`This server has ${machine.memoryMB()} MB of memory, and the ${fit.need.name.replace(/\s*[—(].*$/, '')} speech model needs about `
      + `${machine.whisperNeedMB(fit.need.id)} MB — starting it would crash the studio. Add a free Groq key to the server as GROQ_API_KEY `
      + 'so speech is heard in the cloud instead, or download the Tiny model, or give the server more memory.');
  }
  const model = fit.path;
  const info = await video.getInfo(ctx, input);
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const wav = path.join(os.tmpdir(), `mw-asr-${stamp}.wav`);
  const outBase = path.join(os.tmpdir(), `mw-asr-${stamp}`);

  const clip = (startSec != null && endSec != null);
  const inArgs = clip ? ['-ss', String(startSec), '-i', input, '-t', String(Math.max(0.3, endSec - startSec))] : ['-i', input];
  const total = clip ? (endSec - startSec) : info.durationSec;
  // The room only has to be measured when it is going to be removed.
  const floorDb = video.noiseStrength(denoise) > 0
    ? await video.measureNoiseFloor(ctx, input, { startSec, endSec })
    : null;
  await ff.runFfmpeg(ctx.ffmpeg, [...inArgs, '-vn', '-af', asrAudioFilter({ denoise, floorDb }), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav],
    { onProgress: (p) => onProgress && onProgress(Math.round(p * 0.1)), totalDurationSec: total });

  const threads = String(Math.max(2, Math.min(8, threadsOpt || machine.cpus())));
  // fast: greedy decode, no temperature-fallback retries — ~2x faster, keeps the
  // keywords/punctuation/timing that highlight SCANNING needs (measured on the
  // real sermon: 45s -> 21.5s per 90s window, same sentences). Captions that get
  // BURNED onto video never use it: they take beam search plus the temperature
  // fallback, which is what rescues a phrase the greedy path mangles.
  const decodeArgs = fast ? ['-bs', '1', '-bo', '1', '-nf'] : ['-bs', '5', '-bo', '5'];
  // -sns: suppress non-speech tokens, so a cough or the band between sentences
  // can't turn into "(music)" burned across the picture.
  const jsonArg = granularity === 'segment' ? '-oj' : '-ojf';
  /*
   * WHERE EACH WORD ACTUALLY FALLS.
   *
   * whisper's per-token timestamps are a by-product of decoding and they bunch:
   * on a real sermon, "the faith 30 years ago and I've met all" — nine words —
   * came out inside 0.44 SECONDS, which no one can say. Fine for a caption LINE,
   * useless for a caption that lights up word by word.
   *
   * `--dtw` aligns the tokens to the audio properly instead (dynamic time
   * warping against the model's attention). On the same passage it moved words
   * by 100-880ms and spread them the way the voice actually does. It cannot run
   * with flash attention, which this build has on by default and which will
   * silently switch DTW back off ("dtw_token_timestamps is not supported with
   * flash_attn - disabling") — hence `-nfa` alongside it.
   *
   * Only for word granularity. A highlights SCAN reads whole phrases, where
   * these timings change nothing and flash attention is worth keeping.
   */
  const dtwArgs = granularity === 'segment' ? [] : dtwFor(model, cli);
  const run = (extra) => runWhisper(cli, ['-m', model, '-f', wav, '-l', 'en', '-t', threads, ...decodeArgs, '-sns', ...dtwArgs, ...extra, '-pp', jsonArg, '-of', outBase],
    (p) => onProgress && onProgress(10 + Math.round(p * 0.88)));
  await run([]);

  const readJson = () => JSON.parse(fs.readFileSync(outBase + '.json', 'utf-8'));
  const asSegments = (json) => (json.transcription || [])
    .map((s) => ({ start: (s.offsets ? s.offsets.from : 0) / 1000, end: (s.offsets ? s.offsets.to : 0) / 1000, text: (s.text || '').trim() }))
    .filter((w) => w.text && w.end >= w.start);

  let words = [];
  try {
    const json = readJson();
    if (granularity === 'segment') words = asSegments(json);
    else {
      words = wordsFromTokens(json) || [];
      if (!words.length) {
        // No token detail (an older whisper build): fall back to the original
        // one-word-per-segment decode rather than returning nothing.
        await run(['-ml', '1', '--split-on-word']);
        words = asSegments(readJson());
      }
    }
  } catch (e) { throw new Error('Could not read the transcription: ' + e.message); }
  finally { [wav, outBase + '.json'].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} }); }
  if (onProgress) onProgress(100);
  /*
   * THE WORD BOOK — the last thing that happens to the words, and the reason
   * the same name does not have to be retyped every Sunday.
   *
   * This is the one gate every route passes through: the studio's captions, one
   * short's captions, the phone, and the highlight scanner all reach the words
   * via this function, so a correction taught once is in force everywhere with
   * nothing else needing to remember to ask. It is plain text arithmetic over a
   * list that is already in memory — no second decode, no model — and on a
   * three-hour sermon it costs single-digit milliseconds against the hour the
   * transcription itself took. See src/main/wordbook.js.
   */
  const book = wordbook.apply(words);
  // `words` = the whisper entries (per-word in 'word' mode, per-phrase in 'segment'
  // mode). `segments` is an alias so callers can use whichever name reads clearer.
  return {
    words: book.entries, segments: book.entries,
    // the model that really heard it: on the server image that is Tiny, which
    // bestModel() never names
    durationSec: info.durationSec, model: (MODELS.find((x) => path.basename(model) === x.file) || bestModel() || {}).id || 'base.en',
    // What the book changed, so the studio can say so rather than silently
    // handing back different words from the ones that were spoken into it.
    fixed: book.count, fixedWords: book.count ? wordbook.summarise(book.changes, 4) : '',
  };
}

/* ---- text helpers (also used to mirror renderer grouping if needed) ---- */
function transformCase(t, c) {
  if (c === 'upper') return t.toUpperCase();
  if (c === 'lower') return t.toLowerCase();
  if (c === 'title') return t.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return t;
}

/**
 * Punctuation earns nothing on a burned-in caption.
 *
 * A line holds three or four words for a second and a half — the pause IS the
 * line break — so a full stop hanging off "THE END GOAL." is pure visual noise,
 * and whisper sprinkles commas and quotes liberally. Every one of these is
 * stripped before the words are drawn:
 *
 *     .   ,   ?   "   “ ”   « »   „   …   and their full-width twins
 *
 * Apostrophes stay (DON'T, AIN'T, YOU'RE would break without them), as do
 * hyphens and exclamation marks. A full stop or comma BETWEEN DIGITS also stays,
 * so "1,000" and "3.5" survive intact — only sentence punctuation goes.
 *
 * Pure and exported so the renderer's preview, the burner and the tests all
 * agree on exactly one definition of "clean".
 */
function cleanCaptionText(t) {
  return String(t)
    // A curly apostrophe is part of the WORD (don’t) — straighten it, never drop it.
    .replace(/[’ʼ]/g, "'")
    // quotes of every shape: " “ ” „ ‟ « » ‹ › ″ ＂ and the lone ‘ ’ used as quotes
    .replace(/["“”„‟«»‹›″＂‘]/g, '')
    .replace(/[?？¿]/g, '')                 // question marks
    .replace(/[…⋯]/g, ' ')                 // ellipsis reads as a pause, not a character
    .replace(/[.,。．，、]/g, (m, i, s) =>  // full stops / commas: keep only between digits
      (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? m : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group the transcriber's words into caption lines.
 *
 * Each line keeps the WORDS it was built from, cleaned and cased exactly as they
 * will be drawn, so `event.words[i]` is the same token as `event.text`'s i-th.
 * That alignment is what lets the highlight land on the right word: derived
 * later from the joined text it would drift the moment cleaning dropped a token
 * (whisper is generous with stray quotes and ellipses, and each one used to
 * vanish silently between the two representations).
 */
function buildCaptionEvents(words, { wordsPerLine = 3, textCase = 'none' } = {}) {
  const events = [];
  const push = (grp) => {
    if (!grp.length) return;
    // Clean each word on its own first, then join — so a word that cleans away
    // to nothing takes its timing with it instead of leaving the rest one place
    // out of step.
    const kept = grp
      .map((x) => ({ start: x.start, end: x.end, text: cleanCaptionText(transformCase(String(x.text || ''), textCase)) }))
      .filter((x) => x.text);
    if (!kept.length) return;
    // A single entry can still clean into two tokens ("well…and" -> "well and");
    // the text is the source of truth for what is drawn, so split there too.
    const wordsOut = [];
    for (const k of kept) {
      const parts = k.text.split(/\s+/).filter(Boolean);
      const span = Math.max(0, k.end - k.start) / (parts.length || 1);
      parts.forEach((p, i) => wordsOut.push({ text: p, start: k.start + span * i, end: k.start + span * (i + 1) }));
    }
    const text = wordsOut.map((w) => w.text).join(' ');
    if (text) events.push({ start: grp[0].start, end: grp[grp.length - 1].end, text, words: wordsOut });
  };
  if (wordsPerLine === 'auto') {
    let cur = [];
    for (const w of words) { cur.push(w); if (cur.length >= 6 || /[.?!,]$/.test(w.text)) { push(cur); cur = []; } }
    push(cur);
  } else {
    /*
     * Up to N words a line — but a line also ENDS at a full stop and at a pause.
     *
     * Chopping strictly every three words puts the end of one sentence and the
     * start of the next on the same line, and splits a phrase across a line
     * break that the speaker did not. It reads wrong, and it is not what
     * hand-made short-form captions do: measured across the 889 lines of a
     * professionally cut teaching, 24% of them are one or two words, and those
     * short lines are the ones followed by a pause (0.47s at the third quartile,
     * against 0.9s at the ninetieth for gaps in general). They are sentence ends,
     * not arithmetic.
     *
     * So the count is a ceiling, and silence or a full stop closes the line
     * early. PAUSE is deliberately short: it is the breath between phrases, not
     * the gap between paragraphs.
     */
    const n = Math.max(1, parseInt(wordsPerLine, 10) || 3);
    /*
     * A breath is read two ways, because the timings arrive in two shapes.
     *
     * With the plain token timestamps a word has a start AND an end, and the
     * silence is the space between one end and the next start. With `--dtw` a
     * token has only a MOMENT: wordsFromTokens runs each word up to the next
     * one's start, so that space is always zero and a gap test on it would
     * never fire once. What survives both is the STRIDE — start to start —
     * which a pause stretches whichever way the timings were made.
     */
    const PAUSE = 0.35, STRIDE = 0.75;
    let cur = [];
    for (let i = 0; i < words.length; i++) {
      cur.push(words[i]);
      const next = words[i + 1];
      const sentenceEnd = /[.?!]["'”’)]?$/.test(String(words[i].text || ''));
      const breath = next
        && ((next.start - words[i].end) >= PAUSE || (next.start - words[i].start) >= STRIDE);
      if (cur.length >= n || sentenceEnd || breath) { push(cur); cur = []; }
    }
    push(cur);
  }
  return events;
}

/* ---------------------------- .ass generation ---------------------------- */

/* ------------- the size libass has to be asked for -------------------------
 *
 * CSS sets the em square to the font size; libass sizes a face from the font's
 * own vertical metrics, which for these display faces are far taller than the
 * em. The factor is (winAscent + winDescent) / unitsPerEm, read out of the
 * font's own OS/2 and head tables — measured against real renders of all 21
 * bundled faces, it predicts the observed capital height to within a few per
 * cent, where leaving it out is wrong by up to 157%.
 *
 * A font we cannot read (a system face named by hand, "Arial") keeps a factor
 * of 1, which is exactly what the file did before — no guessing on a face whose
 * metrics are not in front of us.
 */
const _assFactor = new Map();
function assSizeFactor(family) {
  if (_assFactor.has(family)) return _assFactor.get(family);
  let k = 1;
  try {
    const def = FONT_LIST.find((f) => f.family === family || f.name === family);
    const file = def && def.file ? path.join(fontsDir(), def.file) : null;
    if (file && fs.existsSync(file)) {
      const m = faceMetrics(file);
      if (m && m.upem > 0 && m.winAsc + m.winDesc > 0) k = (m.winAsc + m.winDesc) / m.upem;
    }
  } catch (e) { k = 1; }
  if (!(k > 0.2 && k < 4)) k = 1;
  _assFactor.set(family, k);
  return k;
}
const assSizeFor = (family, fontPx) => Math.max(4, Math.round(fontPx * assSizeFactor(family)));

/** unitsPerEm and the OS/2 window metrics, straight out of a TrueType file. */
function faceMetrics(file) {
  const b = fs.readFileSync(file);
  const n = b.readUInt16BE(4);
  const tab = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    tab[b.toString('ascii', o, o + 4)] = b.readUInt32BE(o + 8);
  }
  if (!tab.head || !tab['OS/2']) return null;
  return {
    upem: b.readUInt16BE(tab.head + 18),
    winAsc: b.readUInt16BE(tab['OS/2'] + 74),
    winDesc: b.readUInt16BE(tab['OS/2'] + 76),
  };
}

function assTime(t) { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = (t % 60).toFixed(2); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}`; }
function assColor(hex, alpha = 0) { const n = parseInt((hex || '#ffffff').slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; const hh = (v) => v.toString(16).padStart(2, '0'); return `&H${alpha.toString(16).padStart(2, '0')}${hh(b)}${hh(g)}${hh(r)}`.toUpperCase(); }
function assEscape(t) { return String(t).replace(/[{}]/g, '').replace(/\r?\n/g, '\\N'); }

/**
 * Write a styled .ass.
 * opts: { font, sizeKey, color, outline, position, style, outlineScale, box, bold }
 *
 * `style` is one of the three primitives the renderer's visual style picker is
 * built from: 'shadow' (drop shadow), 'outline' (stroked text) and 'box' (a
 * coloured band behind the words, ASS BorderStyle 3, where the OUTLINE colour is
 * the band). `outlineScale` thickens the stroke for the chunky looks — it's what
 * separates "Outline" from "Pop"/"Neon" — and `outline` carries the band or
 * stroke colour the picker chose, instead of the old hard-coded black.
 */
function writeAss(events, { width, height, opts = {}, output }) {
  const family = FONTS[opts.font] || 'Arial';
  // An exact size wins over the named step, exactly as CapLayout.sizeFrac reads
  // it on the other side — otherwise a caption sized between M and L would be
  // one size on the preview and another in the file.
  const exact = Number(opts.sizePct);
  const sizePct = (Number.isFinite(exact) && exact > 0)
    ? Math.min(0.30, Math.max(0.01, exact))
    : (SIZE_PCT[opts.sizeKey] || SIZE_PCT.m);
  /*
   * TWO ENGINES, TWO MEANINGS OF "FONT SIZE".
   *
   * `fontPx` is the size CapLayout uses, and CSS reads it as the EM SQUARE: a
   * capital comes out at capHeight/unitsPerEm of it. libass does NOT. It sizes a
   * face from the font's own line metrics, so the SAME number draws a smaller
   * capital — by a factor that belongs to the FONT, and it is not small:
   *
   *     Bebas Neue (the default)  1.30x      Montserrat  1.56x
   *     Poppins                   1.81x      Bungee      2.57x
   *
   * measured at font size 100 across the bundled faces. So a caption burned by
   * the subtitle engine has been coming out a quarter to two-thirds smaller than
   * the studio drew it, on the one path the operator cannot see beforehand.
   *
   * assSizeFor() undoes that, so both engines put the same capital on the
   * picture. Everything derived from the size — the outline, the drop shadow,
   * the tracking, the word gap — stays measured against `fontPx`, because those
   * are real pixels on the frame and CapLayout computes them from `fontPx` too.
   */
  const fontPx = height * sizePct;
  const fontSize = assSizeFor(family, fontPx);
  const style = opts.style || (opts.box ? 'box' : 'shadow');
  const box = style === 'box';
  const borderStyle = box ? 3 : 1;
  const scale = Math.max(0.5, Math.min(3, Number(opts.outlineScale) || 1));
  let outlinePx, shadow;
  if (box) { outlinePx = Math.round(fontPx * 0.25); shadow = 0; }
  else if (style === 'outline') { outlinePx = Math.max(2, Math.round(fontPx * 0.09 * scale)); shadow = Math.max(0, Math.round(outlinePx / 2)); }
  else { outlinePx = 0; shadow = Math.max(2, Math.round(fontPx * 0.06)); } // shadow = CapCut white+drop-shadow
  const bold = opts.bold === false ? 0 : 1;
  // Tracking, in output pixels. MUST be the same figure CapLayout.metricsAt
  // works out (fontPx x cfg.tracking), or the two engines set the same caption
  // to two different widths.
  /*
   * Letter spacing goes in as an inline sp tag on every line, NOT in the
   * style's Spacing field: libass leaves a negative Spacing there unapplied, so
   * a tightened caption came out at its natural width in the file while the
   * preview drew it tightened. Measured on "BRINGING HIS SEEDS" at -0.044em the
   * first word was 262px in the file against 247px on the preview; through sp
   * the two agree. Not rounded, either — sp takes decimals, and rounding cost
   * 0.4px on every character of the line.
   */
  const trackPx = fontPx * Math.min(0.5, Math.max(-0.2, Number(opts.tracking) || 0));
  const trackTag = Math.abs(trackPx) > 0.01 ? `{\\fsp${trackPx.toFixed(2)}}` : '';
  const primary = assColor(opts.color || '#ffffff');
  // Boxed looks paint the band with the OUTLINE colour (BorderStyle 3). Fall back
  // to a translucent black band when the caller didn't name one.
  const bandDefault = opts.color === '#000000' ? '#ffffff' : '#000000';
  const outlineCol = box
    ? (opts.outline ? assColor(opts.outline, 40) : assColor(bandDefault, 160))
    : assColor(opts.outline || '#000000');
  /*
   * WHERE THE WORDS SIT.
   *
   * Normally the three presets: bottom / centre / top, as an ASS alignment plus
   * a margin. But once the operator has DRAGGED the caption on the preview, the
   * position is an exact point rather than a preset, and \pos is the only thing
   * that can express it. \pos ignores alignment margins, so the anchor is
   * switched to 5 (centre-centre) — then the point means the middle of the
   * words, which is what dragging a box by its middle should mean.
   *
   * posX/posY are fractions of the OUTPUT FRAME, so they survive any resolution.
   */
  const hasPoint = Number.isFinite(Number(opts.posX)) && Number.isFinite(Number(opts.posY));
  const align = hasPoint ? 5 : (opts.position === 'top' ? 8 : opts.position === 'center' ? 5 : 2);
  const marginV = hasPoint ? 0 : Math.round(height * (opts.position === 'center' ? 0 : 0.10));
  const posTag = hasPoint
    ? `{\\pos(${Math.round(clamp01(Number(opts.posX)) * width)},${Math.round(clamp01(Number(opts.posY)) * height)})}`
    : '';

  /*
   * WHERE THE LINES BREAK.
   *
   * WrapStyle 2 means "only break where the text says to" — libass does no word
   * wrapping of its own here, on purpose. The renderer decides the breaks (see
   * caplayout.js, the module the preview draws from) and sends them as `lines`,
   * so this file and the preview split the same words in the same places. When
   * an event arrives without them — an older caller, or the phone bridge — the
   * whole line is written as one, exactly as before.
   */
  const linesOf = (s) => {
    const ls = Array.isArray(s.lines) && s.lines.length ? s.lines : [s.text];
    return ls.map((l) => cleanCaptionText(l)).filter(Boolean).join('\\N');
  };

  const header =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Cap,${family},${fontSize},${primary},&H000000FF,${outlineCol},${assColor('#000000', 180)},${bold},0,0,0,100,100,0,0,${borderStyle},${outlinePx},${shadow},${align},60,60,${marginV},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  // Last gate before anything is drawn: whatever route the text took to get here
  // — auto-transcribed, hand-retyped on the timeline, or restored from an older
  // session — it is cleaned once more, so a full stop physically cannot reach the
  // picture. A line that was ONLY punctuation drops out entirely.
  const trans = capTransition(opts.transition).id;
  const hl = highlightSpec(opts, fontPx);
  const body = events
    .map((s) => ({ start: s.start, end: s.end, text: linesOf(s), words: s.words }))
    .filter((s) => s.text)
    .flatMap((s) => (trans === 'typewriter' ? capTypewriterLines(s.text, s.start, s.end) : [s]))
    .flatMap((s) => (hl ? capHighlightLines(s, hl) : [s]))
    .map((s) => {
      const dur = Math.max(0.06, (s.end || 0) - (s.start || 0));
      // A split line's arrival belongs to the LINE, not to each word of it: only
      // the window the line actually arrives in wears the tag, so a Pop pops
      // once instead of on every syllable.
      const tag = (trans === 'typewriter' || s.mid) ? '' : capEnterTag(trans, s.lineDur || dur);
      // `text` already carries the renderer's own `\N` breaks, and assEscape
      // leaves backslashes alone — so they survive into the file as breaks.
      return `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Cap,,0,0,0,,${posTag}${trackTag}${tag}${s.raw ? s.text : assEscape(s.text)}`;
    }).join('\n');
  fs.writeFileSync(output, header + body, 'utf-8');
  return output;
}

/* ------------------- the word being spoken, in a subtitle -------------------
 *
 * The second engine's half of highlight mode (the first is CapLayout, which the
 * preview and the frame rasteriser share). Same look, same words, same moments;
 * only the thing holding the pen is different.
 *
 * Karaoke timing — ASS `\k` — is the obvious tool and the wrong one. `\k`
 * recolours un-sung text from the secondary colour to the primary AS it is sung,
 * so everything behind the playhead stays changed: two states, a wipe. What is
 * wanted here is three — not yet said, being said, already said — with exactly
 * ONE word ever picked out. That cannot be expressed as a colour sweep, so the
 * line is written once per word instead, each copy identical but for which word
 * carries the override tag. A three-word line becomes three Dialogue lines, and
 * the file stays a plain .ass that any player draws correctly.
 */

/**
 * null when the line can be written as one piece; otherwise what to do with the
 * words of it.
 *
 * The gap belongs to the LOOK, not to the highlight: CapLayout pads the spaces
 * whenever `wordGap` is set, whether or not a word is lit. This engine has to do
 * the same or the same look would come out differently wide depending on which
 * of the two drew it — which is exactly the drift this whole arrangement exists
 * to prevent.
 */
function highlightSpec(opts, fontPx) {
  if (!opts) return null;
  const gapPx = Math.max(0, Number(opts.wordGap) || 0) * fontPx;
  const trackPx = fontPx * Math.min(0.5, Math.max(-0.2, Number(opts.tracking) || 0));
  const lit = !!(opts.wordHighlight && opts.wordColor);
  if (!lit && gapPx < 1) return null;
  return {
    lit,
    on: assColorTag(opts.wordColor || opts.color || '#ffffff'),
    // Back to the style's own colour, so the words either side of the highlight
    // are drawn by exactly the same rule as a line without one.
    off: assColorTag(opts.color || '#ffffff'),
    // Extra space between words. `wordGap` is a fraction of the font size on
    // both engines (CSS margin there, output pixels here), and `\fsp` is applied
    // to the SPACE alone and cleared straight after — so it pads the word gap
    // without touching the letter spacing inside either word.
    gapPx,
    trackPx,
    // How the word is picked out (CapLayout's word modes). This engine is only
    // the fallback for very long tracks, so a Box word is drawn as the block's
    // colour on the word itself — the closest thing a subtitle line can carry.
    mode: ['karaoke', 'reveal', 'box', 'pop'].includes(opts.wordMode) ? opts.wordMode : 'color',
  };
}

/**
 * A moment for each token that will actually be DRAWN.
 *
 * The transcriber's own per-word timings are used verbatim when they still
 * describe this line — that is what makes the colour land on the voice rather
 * than near it. They stop describing it when a line has been retyped on the
 * timeline, or when the last cleaning pass dropped a token the timings still
 * count; rather than abandon the effect there, the line's span is shared out
 * across the tokens in proportion to their length.
 *
 * MUST stay the same rule as CapLayout.wordTimes in the renderer, or the two
 * engines would colour different words for the same caption.
 */
function wordWindows(s, tokens) {
  const given = Array.isArray(s.words) ? s.words.filter((w) => w && String(w.text || '').trim()) : [];
  const start = Number(s.start) || 0;
  const end = Math.max(start + 0.06, Number(s.end) || start + 1);
  if (given.length === tokens.length) {
    return tokens.map((t, i) => ({
      text: t,
      start: Math.min(end, Math.max(start, Number(given[i].start) || start)),
      end: Math.min(end, Math.max(start, Number(given[i].end) || end)),
    }));
  }
  const total = tokens.reduce((n, t) => n + t.length, 0) || tokens.length;
  let acc = 0;
  return tokens.map((t) => {
    const a = start + (end - start) * (acc / total);
    acc += t.length;
    return { text: t, start: a, end: start + (end - start) * (acc / total) };
  });
}

/**
 * One caption line -> one Dialogue per word, each showing the whole line with a
 * different word coloured.
 *
 * A word holds the colour until the NEXT word starts rather than until its own
 * end stamp — whisper leaves a gap wherever the speaker drew breath, and letting
 * the highlight fall out during each one flickers.
 */
function capHighlightLines(s, hl) {
  // The drawn tokens, in order, with the line breaks kept in place between them.
  const parts = String(s.text).split('\\N').map((l) => l.split(/\s+/).filter(Boolean));
  const flat = parts.reduce((a, l) => a.concat(l), []);
  if (!flat.length) return [s];
  // `\fsp` overrides the style's Spacing outright rather than adding to it, so
  // the gap tag has to carry the tracking with it — and the reset after the
  // space must go back to the TRACKING, not to zero, or every look with letter
  // spacing would lose it from the second word onwards.
  const gapTag = hl.gapPx >= 0.5 ? `{\\fsp${(hl.gapPx + hl.trackPx).toFixed(2)}}` : '';
  const resetTag = `{\\fsp${hl.trackPx.toFixed(2)}}`;
  const render = (active) => {
    let k = 0;
    return parts.map((line) => line.map((w) => {
      const now = k === active;
      const on = hl.mode === 'karaoke' ? (active >= 0 && k <= active) : now;
      let t = assEscape(w);
      // Word by word: what has not been said yet is there but invisible, so the
      // line keeps its shape as the words arrive.
      if (hl.mode === 'reveal' && k > active) t = `{\\alpha&HFF&}${t}{\\alpha&H00&}`;
      else if (on && hl.mode === 'pop' && now) t = `{\\fscx118\\fscy118\\1c${hl.on}}${t}{\\fscx100\\fscy100\\1c${hl.off}}`;
      else if (on) t = `{\\1c${hl.on}}${t}{\\1c${hl.off}}`;
      k++;
      return t;
    }).join(gapTag ? `${gapTag} ${resetTag}` : ' ')).join('\\N');
  };
  // Padding the gaps but lighting nothing: one line, drawn once, with the wider
  // spaces. Splitting it per word would only produce identical copies.
  if (!hl.lit) return [{ start: s.start, end: s.end, text: render(-1), raw: true, lineDur: undefined }];
  const words = wordWindows(s, flat);
  const lineDur = Math.max(0.06, (s.end || 0) - (s.start || 0));
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const start = i === 0 ? s.start : Math.max(s.start, words[i].start);
    const end = i === words.length - 1 ? s.end : Math.min(s.end, Math.max(start + 0.02, words[i + 1].start));
    if (!(end > start)) continue;
    out.push({ start, end, text: render(i), raw: true, mid: i > 0, lineDur });
  }
  return out.length ? out : [s];
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }
// Inline ASS override-tag colour (6-hex BGR + trailing &) — different from the
// 8-hex &HAABBGGRR used in [V4+ Styles] fields.
function assColorTag(hex) {
  const n = parseInt((hex || '#ffffff').slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const hh = (v) => v.toString(16).padStart(2, '0');
  return `&H${hh(b)}${hh(g)}${hh(r)}&`.toUpperCase();
}
function assAlphaTag(opacity) {
  const a = Math.round(255 * (1 - clamp01(opacity == null ? 1 : opacity)));
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}&`;
}

/**
 * Write positioned text-overlay events (CapCut "add text anywhere" style) to an
 * .ass file. Each overlay: { text, x, y (0-1 normalized center), start, end,
 * font, sizePct|sizePx, color, outlineColor, outline, bold, italic, opacity }.
 * Reuses the same burnCaptions() pipeline as auto-captions.
 */
function writeOverlayAss(overlays, { width, height, output }) {
  const header =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Ovl,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,5,10,10,10,1\n` +
    // BorderStyle 3 = opaque BOX behind the text (box colour = OutlineColour).
    `Style: OvlBox,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,2,1,5,10,10,10,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const body = overlays.map((o) => {
    const family = FONTS[o.font] || o.font || 'Arial';
    const fontSize = Math.max(8, Math.round(o.sizePx != null ? o.sizePx : height * (o.sizePct || 0.06)));
    // With the black backing box (o.bg): \bord becomes the box PADDING and \3c its
    // colour; drop the drop-shadow (the box already separates text from video).
    const bord = o.bg ? Math.max(2, Math.round(fontSize * 0.18))
      : (o.outline === false ? 0 : (o.outlineWidth != null ? o.outlineWidth : Math.max(1, Math.round(fontSize * 0.08))));
    // \pos anchors the text's CENTRE — an edge-placed text would hang half outside
    // the picture. Estimate the rendered size and clamp so EVERY glyph stays
    // inside the frame (the "text must always remain in the frame" guarantee).
    const lines = String(o.text || '').split(/\r?\n/);
    const maxLine = Math.max(1, ...lines.map((l) => l.length));
    const estW = maxLine * fontSize * 0.58 + bord * 2;
    const estH = lines.length * fontSize * 1.25 + bord * 2;
    const padX = Math.round(width * 0.015), padY = Math.round(height * 0.01);
    let px = Math.round(clamp01(o.x == null ? 0.5 : o.x) * width);
    let py = Math.round(clamp01(o.y == null ? 0.5 : o.y) * height);
    if (estW >= width - 2 * padX) px = Math.round(width / 2); // wider than the frame: centre (libass wraps)
    else px = Math.min(width - padX - Math.round(estW / 2), Math.max(padX + Math.round(estW / 2), px));
    if (estH >= height - 2 * padY) py = Math.round(height / 2);
    else py = Math.min(height - padY - Math.round(estH / 2), Math.max(padY + Math.round(estH / 2), py));
    const tags = [
      '\\an5', `\\pos(${px},${py})`, `\\fn${family}`, `\\fs${fontSize}`,
      `\\b${o.bold ? 1 : 0}`, `\\i${o.italic ? 1 : 0}`,
      `\\1c${assColorTag(o.color || '#ffffff')}`, `\\3c${assColorTag(o.bg ? (o.bgColor || '#000000') : (o.outlineColor || '#000000'))}`,
      `\\bord${bord}`, `\\shad${o.bg || o.shadow === false ? 0 : 2}`,
      `\\1a${assAlphaTag(o.opacity)}`,
    ];
    // The backing panel. A colour the operator chose is drawn SOLID — a white
    // name banner at 78% is a grey one — while the default black keeps the
    // slight translucency it has always had.
    if (o.bg) tags.push(o.bgColor ? '\\3a&H00&' : '\\3a&H38&');
    // The arrival, in the subtitle engine's own words — the same timings the
    // picture route uses (video.textAnimTimes), so the fallback moves alike.
    const anim = video.textAnimOf(o.anim);
    if (anim !== 'none') {
      const { inD, outD } = video.textAnimTimes((Number(o.end) || 0) - (Number(o.start) || 0));
      const inMs = Math.round(inD * 1000), outMs = Math.round(outD * 1000);
      tags.push(`\\fad(${inMs},${outMs})`);
      if (anim === 'rise') {
        const at = tags.findIndex((t) => t.startsWith('\\pos('));
        tags[at] = `\\move(${px},${py + Math.round(video.TEXT_RISE * height)},${px},${py},0,${inMs})`;
      } else if (anim === 'pop') {
        const k = Math.round(inMs * 0.7);
        tags.push(`\\fscx60\\fscy60\\t(0,${k},\\fscx108\\fscy108)\\t(${k},${inMs},\\fscx100\\fscy100)`);
      } else if (anim === 'zoom') {
        tags.push(`\\fscx135\\fscy135\\t(0,${inMs},\\fscx100\\fscy100)`);
      }
    }
    return `Dialogue: 0,${assTime(o.start)},${assTime(o.end)},${o.bg ? 'OvlBox' : 'Ovl'},,0,0,0,,{${tags.join('')}}${assEscape(o.text)}`;
  }).join('\n');
  fs.writeFileSync(output, header + body, 'utf-8');
  return output;
}

/** Burn an .ass into the video. Copies bundled fonts next to the .ass so libass
 *  finds them, and runs ffmpeg from that dir (avoids Windows path escaping). */
async function burnCaptions(ctx, { input, assPath, output, onProgress }) {
  const info = await video.getInfo(ctx, input);
  const cwd = path.dirname(assPath);
  // make bundled fonts discoverable via fontsdir=.
  try { const fd = fontsDir(); if (fs.existsSync(fd)) for (const f of fs.readdirSync(fd)) if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(fd, f), path.join(cwd, f)); } catch (e) {}
  const vf = `ass=${path.basename(assPath)}:fontsdir=.`;
  // Quality note: burning captions necessarily re-encodes the video once, but it
  // must NOT visibly drop quality. So: (1) keep the SOURCE resolution AND frame
  // rate (no scale, no -r cap — a 60fps sermon stays 60fps); (2) use high-quality
  // settings (QSV global_quality 20 / libx264 crf 18 — a notch ABOVE the shorts
  // pipeline, near visually-lossless for delivery); (3) copy audio untouched; and
  // (4) decode-check the QSV output, since Quick Sync can exit 0 while writing a
  // corrupted stream — the worst possible "quality drop" — and fall back to the
  // software encoder if so.
  const tail = ['-c:a', 'copy', '-movflags', '+faststart', '-y', output];
  try {
    await ff.runFfmpeg(ctx.ffmpeg, ['-hwaccel', 'auto', '-i', input, '-vf', `${vf},format=nv12`, '-c:v', 'h264_qsv', '-global_quality', '20', ...tail], { onProgress, totalDurationSec: info.durationSec, cwd });
    if (await video.isCleanEncode(ctx, output)) return output;
  } catch (e) { /* fall back to software */ }
  await ff.runFfmpeg(ctx.ffmpeg, ['-i', input, '-vf', `${vf},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', ...tail], { onProgress, totalDurationSec: info.durationSec, cwd });
  return output;
}

module.exports = {
  init, isAvailable, engineInfo, transcribe, buildCaptionEvents, transformCase, cleanCaptionText,
  writeAss, writeOverlayAss, burnCaptions, FONTS, FONT_LIST, SIZE_PCT, whisperPaths, fontsDir,
  CAP_TRANSITIONS, capTransition, capEnterTag, capTypewriterLines,
  assSizeFactor, assSizeFor, faceMetrics,
  cliCandidates, findCli, ensureExecutable, dtwFor, dtwPreset, cliHelp,
  MODELS, models, bestModel, modelFor, fitModel, pickScanModel, SCAN_AUTO, downloadModel, removeModel, asrAudioFilter, wordsFromTokens,
};
