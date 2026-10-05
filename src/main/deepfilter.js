'use strict';
/*
 * DEEPFILTERNET — the voice cleaner behind Studio sound and Remove background
 * noise.
 *
 * "It is nasty, not clean — it creates a low-quality sound, a squeak thing."
 *
 * It was. Measured on the real recorded voice in test/fixtures (dirtied the
 * way a church camera dirties it: the hall, air handling, hiss, hum) and
 * scored with PESQ — the ITU's model of how people rate a voice, 1 to 4.5 —
 * and STOI, how much of the speech can be made out:
 *
 *                                          PESQ   STOI   room    top end
 *      the dirty recording, untouched      1.31   0.78   -22 dB   -2 dB
 *      Remove background noise (afftdn)    1.34   0.77   -25 dB   -8 dB
 *      Studio sound, as the server ran it  1.22   0.76   -25 dB   -5 dB
 *      Studio sound with RNNoise           1.62   0.79   -31 dB   -2 dB
 *      DeepFilterNet (this)                1.84   0.86   -35 dB   +1 dB
 *
 * afftdn is spectral subtraction, and its signature is "musical noise": the
 * leftover room breaks into short chirps that come and go — the squeak — while
 * the top of the voice goes with the hiss. The cloud image never had the
 * RNNoise model in it, so on the server Studio sound WAS afftdn, under a
 * presence boost and a loudness stage that lifted the chirps 15 dB. It scored
 * below doing nothing at all.
 *
 * DeepFilterNet (Schröter et al., MIT/Apache-2.0) is a speech-enhancement
 * network that works out what the voice is, band by band, and rebuilds it,
 * rather than subtracting a guess at the room. On a harder recording — a
 * reverberant room, people talking, a rumble that comes and goes — it lifts
 * intelligibility from 0.62 to 0.73 where everything else stayed put.
 *
 * It runs as its own small program (bin/deepfilter, fetched and checked by
 * scripts/fetch-deepfilter.js and the Dockerfile), one CPU core each, about
 * 0.4× real time: a minute-long short costs ~25 s. A whole service is split
 * across the cores (see CHUNK_*). Its output is the same on every run and
 * lines up with the recording to the sample — the two things RNNoise in this
 * ffmpeg never managed.
 *
 * Without the program the app does exactly what it did before (video.js's
 * ffmpeg chains), so a desktop build that was not given it still works.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const jobs = require('./jobs');
const machine = require('./machine');

const VERSION = '0.5.6';
const RELEASE_URL = `https://github.com/Rikorose/DeepFilterNet/releases/download/v${VERSION}/`;
/* The program for each platform this app runs on, and what it must hash to.
 * The DeepFilterNet3 model is built into it. */
const ASSETS = {
  'linux-x64': { file: `deep-filter-${VERSION}-x86_64-unknown-linux-musl`, sha256: '70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da' },
  'linux-arm64': { file: `deep-filter-${VERSION}-aarch64-unknown-linux-gnu`, sha256: '14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166' },
  'win-x64': { file: `deep-filter-${VERSION}-x86_64-pc-windows-msvc.exe`, sha256: '75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915' },
  'mac-arm64': { file: `deep-filter-${VERSION}-aarch64-apple-darwin`, sha256: '4601e7f4e4c03e59a4c5b5000216ef3add3e808799cfccd95e14e83ea4611081' },
  'mac-x64': { file: `deep-filter-${VERSION}-x86_64-apple-darwin`, sha256: 'd3be84003acb7c23e738ad7f70a158ec779a8d233a82e7fa3e717d112eb5b50f' },
};
const platformKey = (platform = process.platform, arch = process.arch) =>
  `${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}-${arch}`;
const exeName = (platform = process.platform) => (platform === 'win32' ? 'deep-filter.exe' : 'deep-filter');

/** The program for this machine, or null. */
function binPath() {
  const name = exeName();
  const repo = path.join(__dirname, '..', '..', 'bin', 'deepfilter');
  const tries = [
    process.env.MW_DEEPFILTER,
    process.resourcesPath && path.join(process.resourcesPath, 'deepfilter', name),   // a packaged desktop app
    path.join(repo, platformKey(), name),                                            // a checkout, after the fetch script
    path.join(repo, name),                                                           // the cloud image
  ];
  for (const p of tries) { try { if (p && fs.statSync(p).isFile()) return p; } catch (e) {} }
  return null;
}

/*
 * How much of the room each setting takes, in dB. Measured (PESQ / STOI on
 * the hall recording): 12 → 1.70 / 0.84, 20 → 1.84 / 0.85, 30 → 1.91 / 0.86,
 * 45 → 1.93 / 0.86. Every one of them is better than anything before.
 *
 * NOT all the way (DeepFilterNet's own default is "no limit"). Taken to
 * digital silence, the pauses keep only a few stray specks of the room, and
 * once Studio sound's loudness stage lifts them they are chirps again — the
 * squeak index (isolated peaks in the pauses) went from 0.04% to 5%. Leaving a
 * faint, even floor 30 dB down costs nothing measurable and sounds like a
 * quiet room instead of a gate.
 *
 * `pf` is the network's post-filter: a little more off the room between
 * syllables (PESQ 1.91 → 1.95), worth it from Strong up.
 */
const LEVELS = {
  light: { atten: 12, pf: false },
  medium: { atten: 20, pf: false },
  strong: { atten: 30, pf: true },
  max: { atten: 45, pf: true },
  studio: { atten: 30, pf: true },
};
/** A denoise setting as the app passes it (a level name, true, 0..1, 0..100) → a LEVELS key, or null. */
function levelFor(v) {
  if (v == null || v === false) return null;
  if (v === true) return 'medium';
  const s = String(v).toLowerCase();
  if (LEVELS[s]) return s;
  let n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1) n /= 100;
  return n <= 0.3 ? 'light' : n <= 0.6 ? 'medium' : n <= 0.85 ? 'strong' : 'max';
}

/*
 * THE MARKERS. video.js still builds its ffmpeg chain for every setting —
 * that is the fallback — and brackets the clean-up inside it:
 *
 *     highpass=f=80,anull@dfn_studio,<arnndn or afftdn>,anull@dfn_end,equalizer=…
 *
 * `anull` passes audio through untouched, so the chain runs as it always did
 * wherever it is used directly. Where the voice track is rendered on its own
 * (renderVerifiedVoice — every export and Hear the difference), the bracketed
 * part is swapped for this network.
 */
const START = (level) => `anull@dfn_${level}`;
const END = 'anull@dfn_end';
const MARK_RE = /anull@dfn_([a-z]+),?([\s\S]*?),?anull@dfn_end/;
function bracket(level, chain) {
  if (!LEVELS[level] || !chain) return chain;
  return `${START(level)},${chain},${END}`;
}
/** Split a marked chain into what runs before the network, the level, and what runs after. */
function splitChain(af) {
  const m = MARK_RE.exec(af || '');
  if (!m) return null;
  const tidy = (s) => s.replace(/^,+|,+$/g, '');
  return { level: m[1], pre: tidy(af.slice(0, m.index)), post: tidy(af.slice(m.index + m[0].length)) };
}

/*
 * A WHOLE SERVICE, ON EVERY CORE. One run of the network uses one core, so a
 * long recording is cut into pieces that run side by side. Each piece starts
 * WARM_SEC early — the network normalises what it hears with running averages
 * that take seconds to settle, and a cold start sounded different from the same
 * moment heard in context (−17 dB apart with 2 s of run-up, −37 dB with 8 s,
 * which is as close as two runs of it ever get) — and the run-up is cut away.
 * Neighbouring pieces then overlap by XF_SAMPLES and are cross-faded, so no
 * join can click. Under CHUNK_MIN_SEC it is one run: a short never splits.
 */
const SR = 48000;
const WARM_SEC = 8;
const CHUNK_MIN_SEC = 240;
/*
 * With its delay compensation on (-D) the network keeps the start of a file
 * exactly in place but hands back 1440 samples fewer than it was given — it
 * drops its own look-ahead off the end. Every piece is therefore given TAIL
 * samples more than it needs and trimmed back: a recording that came back 30 ms
 * short would put every cut after it 30 ms early.
 */
const TAIL = 4800;
const XF_SAMPLES = 1440;

/*
 * HOW BIG A PIECE, HOW MANY AT ONCE. The network holds its whole input in
 * memory — measured 158 MB for 5 minutes and 271 MB for 10 (about 45 MB plus
 * 23 MB a minute) — so a one-hour piece is ~1.4 GB. Pieces are capped (shorter
 * still on a small server), and only as many run at once as the CPUs this
 * process really has (machine.cpus reads the container's quota, not the
 * host's) and half its memory allow.
 */
const MB_BASE = 45, MB_PER_MIN = 23;
const cores = () => Math.max(1, Math.min(6, (machine.cpus() || 1) - 1 || 1));
function pieceLayout(N, pieceSec) {
  if (pieceSec) return { per: Math.round(pieceSec * SR), lanes: cores() };
  const capMin = machine.small() ? 8 : 30;
  const per = Math.min(capMin * 60 * SR, Math.max(CHUNK_MIN_SEC * SR, Math.ceil(N / cores())));
  const mb = MB_BASE + MB_PER_MIN * (per / SR / 60);
  return { per, lanes: Math.max(1, Math.min(cores(), Math.floor((machine.memoryMB() * 0.5) / mb))) };
}

/** Run the network on one WAV, into `outDir`. Killed by Cancel like any ffmpeg,
 *  and by `live`'s owner when a sibling piece has failed. */
function runNet(bin, { input, outDir, level, signal, live }) {
  const L = LEVELS[level] || LEVELS.medium;
  const args = ['-D', '-a', String(L.atten), ...(L.pf ? ['--pf'] : []), '-o', outDir, input];
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = jobs.track(spawn(bin, args, { windowsHide: true })); } catch (e) { reject(e); return; }
    try { if (proc.pid) os.setPriority(proc.pid, 10); } catch (e) {}
    if (live) live.add(proc);
    let err = '';
    if (signal) signal.addEventListener('abort', () => { try { proc.kill('SIGKILL'); } catch (e) {} });
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
    proc.on('error', (e) => { if (live) live.delete(proc); reject(new Error('Could not start the voice cleaner: ' + e.message)); });
    proc.on('close', (code) => {
      if (live) live.delete(proc);
      if (jobs.isCancelled()) return reject(new jobs.CancelledError());
      const out = path.join(outDir, path.basename(input));
      if (code === 0 && fs.existsSync(out)) resolve(out);
      else reject(new Error(`The voice cleaner failed (exit ${code}). ${err.slice(-600)}`));
    });
  });
}

/*
 * THE LEVEL IT HEARS, AND THE LEVEL THAT COMES BACK. The network's result
 * depends on how loud it is fed: measured on the hall recording, fed the words
 * at -40 dBFS it treated part of the voice as room (intelligibility 0.72 →
 * 0.64 on the harder recording), and its output came back 2-6 dB quieter than
 * it went in, more the louder the input — a cleaned short sounded quieter than
 * the same short uncleaned. So it is always fed at FEED_LUFS (quality is flat
 * across a wide band around it) and the voice is given back exactly the
 * loudness it had in the recording, its true peak never past -1.5 dBTP.
 *
 * Loudness is EBU R128's integrated loudness, gated: it reads the speech and
 * leaves the pauses out, so taking the room away does not fool it into
 * turning the voice up (a plain RMS percentile did, by ~3 dB). The true peak
 * counts the overs between samples, which is what an AAC encode lands on.
 */
const FEED_LUFS = -28;
/** Integrated loudness (LUFS) and true peak (dBTP) of a file, or null. */
async function levels(ctx, file) {
  try {
    const log = await ff.runFfmpegCollect(ctx.ffmpeg, ['-nostats', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']);
    const tail = log.slice(log.lastIndexOf('Summary:'));
    const I = parseFloat((/I:\s*(-?[\d.]+) LUFS/.exec(tail) || [])[1]);
    const P = parseFloat((/Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(tail) || [])[1]);
    if (!Number.isFinite(I) || I < -69) return null;    // silence: nothing to level
    return { loud: I, peak: Number.isFinite(P) ? P : -120 };
  } catch (e) { return null; }
}
const clampDb = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Samples in a 16-bit mono WAV that ffmpeg wrote (it writes a plain data chunk). */
function wavSamples(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    for (let i = 12; i + 8 <= n;) {
      const id = head.toString('ascii', i, i + 4), size = head.readUInt32LE(i + 4);
      if (id === 'data') {
        const real = fs.fstatSync(fd).size - (i + 8);
        return Math.floor(Math.min(size >>> 0 || real, real) / 2);
      }
      i += 8 + size + (size & 1);
    }
  } finally { fs.closeSync(fd); }
  return 0;
}

/**
 * The voice track for an export, cleaned by the network: the same audio, the
 * same length to the sample, through the rest of the chain (EQ, level, fades).
 * Returns a temp WAV, or null when this machine has no voice cleaner or the
 * chain carries no marker (the caller then does what it always did).
 */
async function renderVoice(ctx, { inputArgs, cut, af, cwd, signal, pieceSec }) {
  const bin = binPath();
  const parts = splitChain(af);
  if (!bin || !parts) return null;
  const stem = path.join(os.tmpdir(), `cws-dfn-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(stem, { recursive: true });
  const ffArgs = (head, chain, out) => [...head, '-af', chain, '-ar', String(SR), '-c:a', 'pcm_s16le', '-y', out];
  const voice = `${stem}.wav`;
  const live = new Set();
  let done = false;
  try {
    /* 1. the export's own audio, up to the clean-up, as 48 kHz mono — the
     *    network's own rate; a voice track has no use for a stereo image.
     *  - first_pts=0: a WAV has no timestamps, so audio that starts after the
     *    picture (common off a capture box) would play early by that much;
     *    this pads it from time zero, where the picture starts.
     *  - the fold to one channel is spelled out (an average, never above full
     *    scale), so it is the same level on every route. */
    const pre = ['aresample=first_pts=0', parts.pre, /highpass=f=80$/.test(parts.pre) ? '' : 'highpass=f=80',
      'aresample=ochl=mono:rematrix_maxval=1'].filter(Boolean).join(',');
    const src = path.join(stem, 'src.wav');
    const a = [...inputArgs];
    // a cut plan's picture is not wanted here, and ffmpeg refuses a graph that leaves it dangling
    if (cut && cut.chain && cut.a) a.push('-filter_complex', `${cut.chain};${cut.v ? `[${cut.v}]nullsink;` : ''}[${cut.a}]${pre}[aout]`, '-map', '[aout]');
    else a.push('-vn', '-af', pre);
    a.push('-ar', String(SR), '-c:a', 'pcm_s16le', '-y', src);
    await ff.runFfmpeg(ctx.ffmpeg, a, { signal, cwd });
    const N = wavSamples(src);
    if (!N) return null;
    // fed at FEED_LUFS (never pushed past -0.5 dBTP); a silent track is left as it is
    const heard = await levels(ctx, src);
    const feed = heard ? Math.min(clampDb(FEED_LUFS - heard.loud, -20, 24), -0.5 - heard.peak) : 0;

    /* 2. the network, in pieces across the cores when it is long */
    // (pieceSec: a test's way to split a short clip and listen to the joins)
    const { per, lanes } = pieceLayout(N, pieceSec);
    const bounds = [];
    for (let s = 0; s < N;) {
      let e = Math.min(N, s + per);
      if (N - e < Math.min(per, 10 * SR)) e = N;   // a sliver left over joins the piece before it
      bounds.push([s, e]);
      s = e;
    }
    const outDir = path.join(stem, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const one = async ([s, e], i) => {
      const from = Math.max(0, s - WARM_SEC * SR), to = Math.min(N, e + TAIL);
      const pad = e + TAIL - to;               // past the end of the recording: silence
      const inp = path.join(stem, `p${i}.wav`);
      const chain = `atrim=start_sample=${from}:end_sample=${to},asetpts=N/SR/TB,volume=${feed.toFixed(2)}dB` + (pad > 0 ? `,apad=pad_len=${pad}` : '');
      await ff.runFfmpeg(ctx.ffmpeg, ffArgs(['-i', src], chain, inp), { signal });
      // the network takes its turn with the encoders, like whisper does — on a
      // one-CPU server it must not run beside an export
      const out = await ff.gated(() => runNet(bin, { input: inp, outDir, level: parts.level, signal, live }));
      try { fs.rmSync(inp, { force: true }); } catch (e) {}
      // its own stretch, plus the overlap the next piece fades in over
      const keep = (e - s) + (i < bounds.length - 1 ? XF_SAMPLES : 0);
      return { file: out, skip: s - from, keep };
    };
    // `lanes` at a time; the first failure stops the rest at once rather than
    // leaving them running for minutes beside the fallback
    const pieces = new Array(bounds.length);
    let next = 0, failure = null;
    const lane = async () => {
      while (next < bounds.length && !failure) {
        const i = next++;
        try { pieces[i] = await one(bounds[i], i); } catch (e) {
          if (!failure) failure = e;
          for (const p of live) { try { p.kill('SIGKILL'); } catch (er) {} }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, bounds.length) }, lane));
    if (failure) throw failure;

    /* 3. join, trim to the exact length, and run the rest of the chain */
    const head = [];
    pieces.forEach((p) => head.push('-i', p.file));
    let fc = pieces.map((p, i) => `[${i}:a]atrim=start_sample=${p.skip}:end_sample=${p.skip + p.keep},asetpts=N/SR/TB[p${i}]`).join(';');
    let last = 'p0';
    for (let i = 1; i < pieces.length; i++) {
      fc += `;[${last}][p${i}]acrossfade=ns=${XF_SAMPLES}:c1=tri:c2=tri[x${i}]`;
      last = `x${i}`;
    }
    fc += `;[${last}]atrim=end_sample=${N}[aout]`;
    const cleaned = path.join(stem, 'cleaned.wav');
    await ff.runFfmpeg(ctx.ffmpeg, [...head, '-filter_complex', fc, '-map', '[aout]', '-c:a', 'pcm_s16le', '-y', cleaned], { signal });
    // the voice back as loud as it was in the recording, its true peak never past -1.5 dBTP
    const got = await levels(ctx, cleaned);
    let makeup = heard && got ? heard.loud - got.loud : -feed;
    if (got) makeup = Math.min(makeup, -1.5 - got.peak);
    /* 4. back to stereo — the same voice both sides at the SAME level (a plain
     *    mono-to-stereo conversion puts each 3 dB down) — and THEN the rest of
     *    the chain, so Studio sound's loudness stage measures the track that
     *    ships: run on the single channel it landed 3 dB over its -16 LUFS. */
    const post = [`volume=${makeup.toFixed(2)}dB`, 'pan=stereo|c0=c0|c1=c0', parts.post, `aformat=sample_rates=${SR}`].filter(Boolean).join(',');
    await ff.runFfmpeg(ctx.ffmpeg, ['-i', cleaned, '-af', post, '-c:a', 'pcm_s16le', '-y', voice], { signal });
    done = true;
    return voice;
  } finally {
    for (const p of live) { try { p.kill('SIGKILL'); } catch (e) {} }
    try { fs.rmSync(stem, { recursive: true, force: true }); } catch (e) {}
    // a join that failed or was cancelled half-way leaves no half-written track behind
    if (!done) { try { fs.rmSync(voice, { force: true }); } catch (e) {} }
  }
}

module.exports = {
  VERSION, RELEASE_URL, ASSETS, LEVELS, platformKey, exeName, binPath, levelFor,
  bracket, splitChain, renderVoice, wavSamples, WARM_SEC, CHUNK_MIN_SEC, XF_SAMPLES,
};
