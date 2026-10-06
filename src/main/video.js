'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('./ffmpeg');
const deepfilter = require('./deepfilter');

/** Run async task factories with limited concurrency. */
/*
 * THE PREVIEW LANE. Opening a video starts several pictures at once — the
 * filmstrip's frames, the waveform, a thumbnail — and each is a decoder of the
 * whole picture. On a desktop that is nothing; on a 512 MB server, six 4K
 * decoders side by side measured 1.2 GB and the instance was killed. So on a
 * small machine these jobs queue and run one at a time; anywhere else they
 * keep their own parallelism.
 */
const machine = require('./machine');
let previewBusy = 0;
const previewQueue = [];
function inPreviewLane(fn) {
  const limit = machine.small() ? 1 : 8;
  return new Promise((resolve, reject) => {
    const go = () => {
      previewBusy++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        previewBusy--;
        const next = previewQueue.shift();
        if (next) next();
      });
    };
    if (previewBusy < limit) go(); else previewQueue.push(go);
  });
}

async function runLimited(factories, limit) {
  const results = []; let i = 0;
  async function worker() { while (i < factories.length) { const idx = i++; try { results[idx] = await factories[idx](); } catch (e) { results[idx] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, factories.length) }, worker));
  return results;
}

// Social platform aspect-ratio presets (width x height in px).
const PRESETS = {
  'reel-9x16':   { w: 1080, h: 1920, label: 'Reel / TikTok / Short (9:16)' },
  'square-1x1':  { w: 1080, h: 1080, label: 'Square feed (1:1)' },
  'portrait-4x5':{ w: 1080, h: 1350, label: 'Portrait feed (4:5)' },
  'wide-16x9':   { w: 1920, h: 1080, label: 'Landscape / YouTube (16:9)' },
};

function hms(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

const clamp01f = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/* ============================ EXPORT QUALITY ============================
 *
 * The frame the operator asks for, and the encode settings that make it worth
 * asking for.
 *
 * A preset (9:16, 1:1, 16:9…) says the SHAPE; the quality tier says how many
 * pixels. They are separate on purpose — "a Reel" and "in 4K" are two different
 * decisions, and pinning the shape to one size is what used to make every export
 * 1080-class whatever the recording was.
 *
 * `short` is the SHORT side of the frame, which is what 720p/1080p/4K actually
 * mean to a person: a 16:9 export at 1080p is 1920x1080, and a 9:16 export at
 * 1080p is 1080x1920. Both are "1080p", and both have 1080 across the short
 * edge. Deriving from the short side gets that right for every shape without a
 * table of special cases.
 *
 * Honesty about UPSCALING: a 720p recording exported at 4K really is a 4K file —
 * every pixel is there and every platform will treat it as 4K — but the DETAIL
 * cannot be invented. `upscaleFactor` exists so the app can say so plainly
 * rather than implying a sharpness that is not in the source.
 */
const QUALITY = {
  '480p':  { short: 480,  label: 'SD 480p',        crf: 20, qsv: 21, x264: 'medium' },
  '720p':  { short: 720,  label: 'HD 720p',        crf: 19, qsv: 20, x264: 'medium' },
  '1080p': { short: 1080, label: 'Full HD 1080p',  crf: 18, qsv: 19, x264: 'medium' },
  '4k':    { short: 2160, label: '4K UHD',         crf: 19, qsv: 20, x264: 'medium' },
};
const DEFAULT_QUALITY = '1080p';

/*
 * FRAME RATE AND BITRATE — CapCut's two other export dials, beside the size.
 *
 * They are the operator's standing choice (like the size), so they live here
 * rather than in every export call: every short, every edited video and every
 * export that goes through encodeWithFallback reads them. main.js keeps them on
 * disk and hands them over at startup, so a server restart never quietly
 * changes what the next export looks like.
 *
 *   fps   0 = the recording's own rate (24-60, as before); otherwise 24/25/30/50/60
 *   rate  'lower' (smaller files), 'recommended' (as before), 'higher' (more
 *         bits — less smearing once a platform re-compresses it)
 */
const RATE_CRF = { lower: 4, recommended: 0, higher: -3 };
const FPS_CHOICES = [24, 25, 30, 50, 60];
/*
 * PER PERSON on a shared Cloud Studio: one person choosing 60 fps must not
 * change the next person's exports. Keyed by the space the work runs in (the
 * owner, and the desktop, are '').
 */
const prefsBySpace = new Map();
const whose = () => { try { return require('./space').current() || ''; } catch (e) { return ''; } };
const cleanPrefs = (p = {}) => {
  const fps = Number(p.fps) || 0;
  return { fps: FPS_CHOICES.includes(fps) ? fps : 0, rate: Object.prototype.hasOwnProperty.call(RATE_CRF, p.rate) ? p.rate : 'recommended' };
};
function setExportPrefs(p = {}, who) {
  const v = cleanPrefs(p);
  prefsBySpace.set(who === undefined ? whose() : (who || ''), v);
  return Object.assign({}, v);
}
const getExportPrefs = (who) => Object.assign({}, prefsBySpace.get(who === undefined ? whose() : (who || '')) || { fps: 0, rate: 'recommended' });
/** Everyone's, for saving (main.js keeps them on disk). */
const allExportPrefs = () => Object.fromEntries(prefsBySpace);
const loadExportPrefs = (all = {}) => { for (const [k, v] of Object.entries(all || {})) prefsBySpace.set(k, cleanPrefs(v)); };

const qualityDef = (q) => {
  const base = QUALITY[String(q || '').toLowerCase()] || QUALITY[DEFAULT_QUALITY];
  const d = RATE_CRF[getExportPrefs().rate] || 0;
  return d ? Object.assign({}, base, { crf: base.crf + d, qsv: base.qsv + d }) : base;
};

/**
 * The exact pixel frame for a preset at a quality tier.
 *
 * The preset table carries the SHAPE as a 1080-class reference; the ratio is
 * taken from it and re-hung on the chosen short side. Both dimensions are
 * rounded to even numbers because H.264's 4:2:0 chroma cannot represent an odd
 * one — ffmpeg would refuse the encode outright.
 */
function presetSize(preset, quality) {
  const p = PRESETS[preset] || PRESETS['reel-9x16'];
  const q = qualityDef(quality);
  const ratio = p.w / p.h;
  let w, h;
  if (ratio >= 1) { h = q.short; w = Math.round(h * ratio); }   // landscape/square: height is the short side
  else { w = q.short; h = Math.round(w / ratio); }              // portrait: width is
  return { w: even(w), h: even(h), quality: q };
}

/**
 * The frame for an export that keeps the recording's own SHAPE ("Export video")
 * but is asked for a particular size. Returns null to mean "leave it exactly as
 * it is", which is what the Same-as-recording setting does.
 */
function sourceSize(info, quality) {
  if (!quality || String(quality).toLowerCase() === 'source') return null;
  const q = qualityDef(quality);
  const sw = info.width || 1920, sh = info.height || 1080;
  const ratio = sw / sh;
  let w, h;
  if (ratio >= 1) { h = q.short; w = Math.round(h * ratio); }
  else { w = q.short; h = Math.round(w / ratio); }
  return { w: even(w), h: even(h), quality: q };
}

/** How much this export is being stretched beyond the detail in the source. */
function upscaleFactor(info, target) {
  if (!target || !info || !info.height) return 1;
  return Math.max(1, Math.round((target.h / info.height) * 100) / 100);
}

/**
 * The output frame rate.
 *
 * Every export used to be forced to 30fps, which silently HALVED a 60fps
 * recording — the single most visible way to lose quality, and invisible in the
 * settings. The source rate is kept instead, clamped to the range every platform
 * accepts (and to something a church laptop can actually encode).
 */
function outputFps(info) {
  const fpsPick = getExportPrefs().fps;
  if (fpsPick) return fpsPick;      // the operator's choice (see setExportPrefs)
  const src = Number(info && info.fps) || 30;
  if (!Number.isFinite(src) || src <= 0) return 30;
  return Math.max(24, Math.min(60, Math.round(src * 100) / 100));
}

/* =========================== BACKGROUND NOISE ===========================
 *
 * A church recording is rarely clean: air conditioning, a projector fan, the
 * band still noodling behind the preacher, a hall's own hiss. None of it is
 * removable after the fact by turning the volume down — it lives UNDER the
 * voice — so this is spectral: ffmpeg's afftdn learns what the steady noise
 * looks like across the spectrum and subtracts it, leaving the speech.
 *
 * The operator picks HOW HARD, because there is a real trade-off and only they
 * can hear the room: gentle settings leave some hiss but the voice is untouched,
 * hard settings take the room out completely and start to thin out consonants
 * ("s" and "t" live in the same high band as the hiss). The five levels below
 * are measured in test/audio-clean.test.js — each one removes strictly more
 * noise than the one before it, and every one of them keeps the voice.
 *
 * Returns null for "off", so nothing is added to the filter graph and an export
 * that doesn't want this costs exactly what it always did.
 */
const NOISE_LEVELS = { off: 0, light: 0.25, medium: 0.5, strong: 0.75, max: 1, studio: 0.8 };
const DEFAULT_NOISE_FLOOR_DB = -28;   // used only when the room can't be measured
function noiseStrength(v) {
  if (v == null || v === false) return 0;
  if (v === true) return NOISE_LEVELS.medium;
  if (typeof v === 'string') {
    const named = NOISE_LEVELS[v.toLowerCase()];
    if (named != null) return named;
    const n = parseFloat(v);
    return clamp01f(n > 1 ? n / 100 : n);
  }
  const n = Number(v) || 0;
  return clamp01f(n > 1 ? n / 100 : n);
}

/**
 * The ffmpeg audio-filter chain for `strength` (0..1 or a level name), or null.
 *
 * `floorDb` is THE critical number: afftdn's `nf` is where it decides the room
 * stops and the voice starts, and it has to sit just above the actual room tone.
 * Measured on synthetic noise at a known level, with nr fixed at 40:
 *
 *      nf = floor - 14 ....... 0.4 dB removed   (nothing happens)
 *      nf = floor -  9 ....... 6.3 dB
 *      nf = floor -  4 ...... 18.6 dB
 *      nf = floor +  5 ...... 39.3 dB removed, 98% of the voice kept  <-
 *      nf = floor + 10 ...... 40.0 dB removed, 93% of the voice kept
 *
 * Hard-coding nf is therefore not an option — a quiet room and a loud one need
 * different numbers for the same result, which is why measureNoiseFloor() reads
 * the actual recording first. With nf set that way, `nr` becomes almost exactly
 * "dB of noise removed", which is what makes the strength control honest:
 *
 *      light ~12 dB   medium ~21 dB   strong ~30 dB   maximum ~37 dB
 *
 * (What does NOT work, and cost an afternoon: `tn=1`, afftdn's noise TRACKING.
 * It sounds like exactly the right idea — follow a room that changes — but in
 * this ffmpeg build it reduces the whole effect to 0.2 dB, i.e. silently does
 * nothing at all. test/audio-clean.test.js exists so that can never come back.)
 */
function noiseReductionAf(strength, { floorDb } = {}) {
  const n = noiseStrength(strength);
  if (n <= 0) return null;
  const floor = Number.isFinite(Number(floorDb)) ? Number(floorDb) : DEFAULT_NOISE_FLOOR_DB;
  const nf = Math.max(-80, Math.min(-20, Math.round(floor + 5)));
  const nr = Math.max(1, Math.min(97, Math.round((3 + n * 37) * 10) / 10));
  return [
    // Sub-80Hz carries no speech at all — only rumble, mains hum and stage thumps.
    'highpass=f=80',
    `afftdn=nr=${nr}:nf=${nf}`,
  ].join(',');
}

/* ===================== VOICE ISOLATION (RNNoise) ========================
 *
 * `afftdn` above assumes the noise is flat and steady, and subtracts a fixed
 * amount from every frequency. A hall's noise is neither: most of its energy is
 * air handling and traffic sitting at the bottom of the spectrum, hiss on top,
 * mains hum in between, and a congregation moving about underneath all of it.
 * Measured on a real recording (test/studio-voice.test.js builds one and reads
 * the numbers back), afftdn took 3.9 dB off that room, and its strength control
 * was inert while doing it: from nr=3 to nr=97, the whole range of the dial, the
 * room level moved by less than 0.1 dB. Meanwhile it gouged enough holes in the
 * speech to triple its distance from the dry voice. That is what "it sounds
 * weird and awful" was — a filter that left the noise alone and ate the words.
 *
 * ffmpeg ships the right tool for this: `arnndn`, a small recurrent network
 * trained to tell a human voice from everything else, frame by frame. It takes
 * 17-21 dB off the same room and leaves the voice where it was. It needs a
 * model file, which is in bin/rnnoise — see the README there for which one and
 * why.
 */
function rnnoiseModelPath() {
  const packaged = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'rnnoise'));
  const base = packaged ? path.join(process.resourcesPath, 'rnnoise') : path.join(__dirname, '..', '..', 'bin', 'rnnoise');
  const p = path.join(base, 'beguiling-drafter.rnnn');
  return fs.existsSync(p) ? p : null;
}

/**
 * A file path, safe to drop inside an ffmpeg filtergraph.
 *
 * This is fiddlier than it looks, and getting it wrong fails the whole export.
 * The value is unescaped TWICE on its way to the filter: once by the filtergraph
 * parser, which splits on `,` `;` `[` `]`, and again by the filter's own option
 * parser, which splits `key=value` pairs on `:`. So `arnndn=m=C\:/x` does NOT
 * work — the first pass eats the backslash, the second pass then splits at the
 * drive letter and hands "/x" to `mix` as a positional argument, which fails
 * with the memorable "Error applying option 'mix'".
 *
 * Each character is therefore escaped for the rounds it is actually special in:
 *
 *     , ; [ ]   round 1 only ......  \,
 *     :         round 2 only ......  \\:
 *     ' and \   both rounds ........ \\\'
 *
 * Not theoretical: the packaged app installs under the user's own name, so
 * "C:\Users\O'Brien\AppData\Local\Programs\Church Work Space\..." is an ordinary
 * path, and it hits three of these at once. test/studio-voice.test.js loads the
 * real model from seven differently-awkward directories.
 */
function ffPath(p) {
  const forward = String(p).replace(/\\/g, '/');   // after this there are none left to escape
  let out = '';
  for (const c of forward) {
    if (c === "'") out += "\\\\\\'";
    else if (c === ':') out += '\\\\:';
    else if (c === ',' || c === ';' || c === '[' || c === ']') out += '\\' + c;
    else out += c;
  }
  return out;
}

/**
 * `arnndn` for this install, or null when the model isn't on disk.
 *
 * THIS FILTER CANNOT BE TRUSTED TO RUN, AND THAT IS WHY THE AUDIO IS CHECKED.
 *
 * `arnndn` in the bundled ffmpeg (6.1.1) does not give the same answer twice.
 * Same binary, same input file, same command line, same filter graph — and it
 * lands on one of exactly TWO outputs, byte-identical within each. Measured over
 * 30 runs of the real chain on the same recording:
 *
 *      19 runs of 30 ....  the room is left exactly where it was
 *      11 runs of 30 ....  the room goes, ~17 dB of it
 *
 * It is not the model (all five published models do it), not the strength, not
 * the input format, not threading (`-threads 1`, `-filter_threads 1`), not SIMD
 * dispatch (`-cpuflags 0` and every level up to avx2+fma3), and not frame
 * sizing. ffmpeg's own verbose log is line-for-line identical between a good run
 * and a bad one apart from heap addresses — it believes it did the same work
 * both times, which is the signature of state being read before it is written,
 * upstream, inside a prebuilt binary this app cannot patch.
 *
 * Repeating the filter in the graph is NOT a fix, though it looks like one for a
 * while. Instances do roll separately, so the odds improve — but they never
 * reach certainty, and past a point the extra passes start eating the voice:
 *
 *      1 pass ....  19 uncleaned of 30
 *      2 passes ...  1 uncleaned of 30,  0 of 40 in the next batch
 *      3 passes ...  0 uncleaned of 30,  1 of 40 in the next batch
 *      4 passes ... 21 uncleaned of 40 — over-processed, the words come down too
 *
 * "Almost always" is not what the operator asked for, and a sermon that exports
 * uncleaned one time in twenty is exactly how this feature earned its reputation
 * in the first place. So the audio is not left to chance: renderVerifiedVoice
 * below runs the chain on its own, MEASURES whether the room actually went, and
 * runs it again if it did not. The encode then plays that checked track instead
 * of running the filter itself. One pass is enough once someone is looking.
 *
 * The delay: RNNoise works a 10 ms frame at a time and hands its output back one
 * frame late, so it delays the track by exactly 480 samples at 48 kHz — the same
 * 480 whatever the source rate is, because arnndn resamples to 48 kHz before it
 * runs. Inaudible on its own, but this app has been round the A/V sync houses
 * before and there is no reason to spend the budget here: dropping that frame
 * and re-basing the timestamps puts it back.
 */
const RNNOISE_FRAME_SAMPLES = 480;
function voiceIsolationAf() {
  const model = rnnoiseModelPath();
  if (!model) return null;
  return `arnndn=m=${ffPath(model)}` +
    `,atrim=start_sample=${RNNOISE_FRAME_SAMPLES},asetpts=N/SR/TB`;
}

/**
 * The same chain with the isolation repeated `n` times — the retry, and the only
 * lever that reliably changes arnndn's mind.
 *
 * Retrying the identical command is useless: the outcome is fixed for a given
 * command shape. Rendering the same eight seconds of the same MP4 six times over
 * gave the same uncleaned result all six times, while the very same audio with
 * the filter listed twice came back clean all six. The graph is what the dice
 * are rolled on, so the retry has to change the graph.
 *
 * The `,atrim=start_sample=` suffix is written by voiceIsolationAf just above,
 * so matching on it is safe even when the model path itself contains escaped
 * commas; the trim grows with the pass count because each pass costs one more
 * 10 ms frame of delay.
 */
function withVoicePasses(af, n) {
  const m = /(arnndn=.*?),atrim=start_sample=\d+/.exec(af || '');
  if (!m || n < 1) return af;
  return af.replace(m[0], Array(n).fill(m[1]).join(',') +
    `,atrim=start_sample=${RNNOISE_FRAME_SAMPLES * n}`);
}

/**
 * The separation between the words and the room, in dB — the one number that
 * says whether a recording is clean.
 *
 * Read from astats' per-second RMS, the same cheap pass measureNoiseFloor uses:
 * the 90th percentile is the preaching, the 10th is what is there when nobody
 * is speaking, and the gap between them is what the operator hears as "clean".
 * Absolute levels cannot be used for this — the chain ends in loudnorm and
 * lifts everything by ~15 dB — but the gap survives that untouched.
 */
async function measureSeparation(ctx, { inputArgs, cut, af, capSec = 120 } = {}) {
  try {
    const stats = 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level';
    const args = [...inputArgs];
    // Both the reference and the result have to be read the same way, through
    // the same graph the export would use — including the cut plan, or a
    // gap-closing export would be compared against audio it never plays.
    if (cut && cut.chain && cut.a) {
      args.push('-filter_complex', `${cut.chain};${cut.v ? `[${cut.v}]nullsink;` : ''}[${cut.a}]${af ? af + ',' : ''}${stats}[aout]`, '-map', '[aout]');
    } else {
      args.push('-vn', '-af', (af ? af + ',' : '') + stats);
    }
    /*
     * A cap, so measuring an hour-long service costs the same as measuring a
     * short — but only when the caller has not already trimmed. A clip arrives
     * as `-ss S -i file -t D`, and a second `-t` would override that D and
     * measure well past the end of the clip, comparing the result against a
     * stretch of the service the export never touches.
     */
    const lastI = inputArgs.lastIndexOf('-i');
    const alreadyTrimmed = lastI >= 0 && inputArgs.slice(lastI + 2).includes('-t');
    if (!alreadyTrimmed) args.push('-t', String(capSec));
    args.push('-f', 'null', '-');
    const log = await ff.runFfmpegCollect(ctx.ffmpeg, args);
    const vals = [];
    const re = /lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/g;
    let m;
    while ((m = re.exec(log)) !== null) { const v = parseFloat(m[1]); if (Number.isFinite(v) && v > -120) vals.push(v); }
    if (vals.length < 4) return null;
    vals.sort((a, b) => a - b);
    const at = (q) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * q)))];
    return at(0.9) - at(0.1);
  } catch (e) { return null; }
}

/**
 * STUDIO VOICE — what actually makes a hall recording sound like a studio.
 *
 * Taking the noise out is only the first of four things, and on its own it
 * leaves a clean but thin, distant, uneven recording. A voice sounds "recorded
 * properly" when all four are done:
 *
 *   1. the rumble goes      — high-pass, below anything a voice produces
 *   2. the room goes        — RNNoise above, which keeps what a person makes
 *                             (speech, singing, a shouted amen) and pushes down
 *                             what a person doesn't
 *   3. the boxiness goes    — a dip around 300 Hz, which is what a hall adds,
 *                             and a lift at 3 kHz, which is where consonants
 *                             live (this is why the cleaned voice sounds CLOSER)
 *   4. the level steadies   — gentle compression, then loudnorm to a broadcast
 *                             target, so the quiet sentences come up without the
 *                             loud ones clipping
 *
 * Step 4 is why step 2 has to actually work. The chain lifts a quietly-filmed
 * sermon by around 15 dB to reach the broadcast target, and whatever noise is
 * still in the recording is lifted by the same 15 dB. That is how the old chain
 * managed to make the hiss MORE audible while calling itself noise removal.
 *
 * Deliberately conservative otherwise: this is a sermon, not a pop record. The
 * compressor is 2:1 with a soft knee, the EQ moves are 3 dB, and the target is
 * -16 LUFS — what every platform normalises to anyway, so nothing gets squashed
 * twice.
 *
 * `floorDb` is only used by the afftdn fallback, for installs where the model
 * is missing; the network doesn't need to be told what the room sounds like.
 */
function studioVoiceAf(strength, { floorDb } = {}) {
  const isolate = voiceIsolationAf();
  // No model on disk (a partial build): fall back to the old spectral chain
  // rather than failing the export outright. It is weak, but it is not broken.
  const denoise = isolate || noiseReductionAf(strength == null ? 'strong' : strength, { floorDb });
  return [
    // Sub-80Hz carries no speech at all — only rumble, mains hum and stage thumps.
    'highpass=f=80',
    // Bracketed: where the voice track is rendered on its own, DeepFilterNet
    // takes this step's place (see deepfilter.js); the rest of the chain stays.
    deepfilter.bracket('studio', denoise),
    // hall boxiness out, presence in
    'equalizer=f=300:t=q:w=1.2:g=-3',
    'equalizer=f=3000:t=q:w=1.0:g=3',
    // even out the delivery, then land on the broadcast target
    'acompressor=threshold=-18dB:ratio=2.5:attack=15:release=250:knee=6:makeup=1',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    /*
     * loudnorm runs its true-peak detection at 192 kHz and hands the stream on
     * at that rate. Left alone, the AAC encoder then picks the nearest rate it
     * supports and every Studio-sound export went out as 96 kHz audio — legal,
     * but twice the rate anything plays back at, wasting bitrate on an octave
     * of nothing and landing outside what the social platforms ask for. Put it
     * back where it started.
     */
    'aformat=sample_rates=48000',
  ].filter(Boolean).join(',');
}

/**
 * The room tone of a recording, in dBFS — the quietest second in it.
 *
 * astats is asked to report per-second RMS and the FLOOR of those readings is
 * taken, not the average: the average includes the preaching, and what we need
 * is what is there when nobody is speaking. Reads at most 120 seconds, so
 * measuring an hour-long service costs the same as measuring a short.
 *
 * Returns null if it can't tell (no audio, ffmpeg unhappy) — the caller then
 * falls back to a sensible fixed floor rather than failing the export.
 */
async function measureNoiseFloor(ctx, input, { startSec, endSec } = {}) {
  try {
    const args = [];
    if (startSec != null) args.push('-ss', String(Math.max(0, Number(startSec) || 0)));
    args.push('-i', input, '-vn', '-t', String(Math.max(1, Math.min(120,
      endSec != null && startSec != null ? endSec - startSec : 120))));
    args.push('-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-');
    const log = await ff.runFfmpegCollect(ctx.ffmpeg, args);
    const vals = [];
    const re = /lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/g;
    let m;
    while ((m = re.exec(log)) !== null) { const v = parseFloat(m[1]); if (Number.isFinite(v) && v > -120) vals.push(v); }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    // the 10th percentile, not the outright minimum: one freak silent frame
    // (a dropout, a cut) would otherwise set the floor for the whole clip.
    return vals[Math.floor(vals.length * 0.1)];
  } catch (e) { return null; }
}

/** Measure the room, then build the chain for it. null when denoise is off. */
async function denoiseFilter(ctx, { input, denoise, startSec, endSec } = {}) {
  if (noiseStrength(denoise) <= 0) return null;
  const floorDb = await measureNoiseFloor(ctx, input, { startSec, endSec });
  // 'studio' is the full voice chain, not just a noise setting — same entry
  // point, so every export path that already honours `denoise` gets it.
  if (String(denoise).toLowerCase() === 'studio') return studioVoiceAf('strong', { floorDb });
  // The ffmpeg chain is the fallback; the brackets let the voice cleaner
  // (deepfilter.js) do this step wherever the voice track is rendered first.
  return deepfilter.bracket(deepfilter.levelFor(denoise), noiseReductionAf(denoise, { floorDb }));
}

/**
 * Fade the clip's OWN audio in at the start and/or out at the end (distinct
 * from the music-bed fade in mixMusic — this touches the voice track itself).
 * `dur` is the export's own output duration, so the fade-out start time is
 * always relative to what actually ends up in the file, not the source.
 * Returns null when both are 0, so an export that doesn't want this costs
 * exactly what it always did.
 */
function fadeFilter(fadeIn, fadeOut, dur) {
  const fi = Math.max(0, Number(fadeIn) || 0);
  let fo = Math.max(0, Number(fadeOut) || 0);
  if (fi <= 0 && fo <= 0) return null;
  const d = Math.max(0.05, Number(dur) || 0);
  const parts = [];
  if (fi > 0) parts.push(`afade=t=in:st=0:d=${Math.min(fi, d).toFixed(2)}`);
  if (fo > 0) {
    fo = Math.min(fo, d); // never fade out longer than the clip itself
    const st = Math.max(0, d - fo);
    parts.push(`afade=t=out:st=${st.toFixed(2)}:d=${fo.toFixed(2)}`);
  }
  return parts.join(',');
}
/** Combine the denoise + fade audio-filter chains into one `-af` string, or null. */
const combineAf = (...chains) => chains.filter(Boolean).join(',') || null;

/* ========================= BACKGROUND BLUR (FILL) =======================
 *
 * Two different jobs share this: a 16:9 recording going out as a 9:16 reel, and
 * a 16:9 photo or outro card dropped into a 9:16 short. In both cases the
 * picture does not fill the frame, and the app's only answers used to be crop
 * (which throws away the sides) or black bars (which look like a mistake).
 *
 * The third answer — the one CapCut and Instagram use — is to fill the empty
 * space with the picture's OWN content, blurred. It blends because it is
 * literally the same image: the colours behind the letterbox are the colours in
 * it. The subject stays whole and centred, nothing is cropped away, and the
 * frame is full.
 *
 * How the blur is built matters. Blurring a 1080x1920 frame with a radius big
 * enough to look right is very expensive per frame, so the background is scaled
 * DOWN by 8x first, blurred there, then scaled back up — the downscale is itself
 * a blur, the boxblur on the small image is worth ~8x its radius on the full
 * one, and the upscale smooths what is left. Same look, a fraction of the cost.
 *
 * `mode`:
 *   'crop'  — fill the frame by cropping (the default, unchanged behaviour)
 *   'blur'  — fit the whole picture, blurred background behind it
 *   'bars'  — fit the whole picture on plain black
 * `strength` 0..1 how heavy the blur is; `dim` 0..1 how much the background is
 * darkened so the real picture reads as the subject.
 */
const FILL_MODES = ['crop', 'blur', 'bars'];
function fillOpts(fill) {
  const f = (typeof fill === 'string') ? { mode: fill } : (fill || {});
  const mode = FILL_MODES.includes(f.mode) ? f.mode : 'crop';
  return {
    mode,
    strength: f.strength == null ? 0.6 : clamp01f(f.strength > 1 ? f.strength / 100 : f.strength),
    dim: f.dim == null ? 0.18 : clamp01f(f.dim > 1 ? f.dim / 100 : f.dim),
    // A background made only of the edges of a very wide picture can look washed
    // out; a little extra saturation puts the colour back.
    saturation: f.saturation == null ? 1.15 : Math.max(0, Math.min(3, Number(f.saturation) || 1.15)),
  };
}

/**
 * The video-filter chain that puts a srcW x srcH picture into a W x H frame.
 *
 * Pure and exported so test/background-blur.test.js can assert on the graph as
 * well as on rendered pixels. The returned string is a complete one-in/one-out
 * filtergraph (it may contain `;` and labels), which is legal both as `-vf` and
 * inside a -filter_complex branch.
 *
 * `label` (optional) names the branch's inputs/outputs uniquely, so several of
 * these can live in one -filter_complex without colliding.
 */
/**
 * COVER CAPTIONS THAT ARE ALREADY BURNED INTO THE PICTURE.
 *
 * A recording that arrives with subtitles already baked in cannot have them
 * "removed" — the pixels underneath the words were never recorded, so there is
 * nothing to uncover. What CAN be done is what a broadcaster does with a wrong
 * name-plate: cover the area, and put the right thing on top. Three ways,
 * because the right one depends on what is behind the words:
 *
 *   blur   the area is smeared beyond reading, and still moves with the shot —
 *          the least noticeable on a busy stage, and the default
 *   smear   ffmpeg's delogo, which rebuilds the area by interpolating inwards
 *          from its edges. Made for a static station logo, and genuinely
 *          invisible over a plain wall or a gradient; over detail it blotches
 *   solid   a plain filled bar. Honest, unmissable, and the only one that is
 *          guaranteed to leave nothing readable behind
 *
 * The rectangle is given in FRACTIONS of the picture, so the same setting means
 * the same place on a 720p and a 4K copy of the same service, and it is applied
 * BEFORE any crop or scale — at that point the numbers still describe the frame
 * the operator drew them on.
 */
function coverChain(srcW, srcH, cover, label = 'cv') {
  if (!cover || !cover.on || !srcW || !srcH) return null;
  const frac = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  let X = Math.round(clampN(frac(cover.x, 0), 0, 1) * srcW);
  let Y = Math.round(clampN(frac(cover.y, 0.8), 0, 1) * srcH);
  let W = Math.round(clampN(frac(cover.w, 1), 0.01, 1) * srcW);
  let H = Math.round(clampN(frac(cover.h, 0.18), 0.01, 1) * srcH);
  // Even numbers, because chroma is subsampled — but the ORIGIN rounds DOWN and
  // the size rounds UP, so a band asked to start at the very edge starts there
  // instead of leaving a two-pixel sliver of the old words showing.
  const down2 = (v) => Math.max(0, Math.floor(v / 2) * 2);
  const up2 = (v) => Math.max(2, Math.ceil(v / 2) * 2);
  X = down2(clampN(X, 0, Math.max(0, srcW - 4)));
  Y = down2(clampN(Y, 0, Math.max(0, srcH - 4)));
  W = Math.min(srcW - X, up2(clampN(W, 4, srcW - X)));
  H = Math.min(srcH - Y, up2(clampN(H, 4, srcH - Y)));
  if (W < 4 || H < 4) return null;
  const mode = cover.mode || 'blur';

  if (mode === 'solid') {
    const colour = (cover.colour || 'black').replace(/[^\w#@.]/g, '') || 'black';
    return `drawbox=x=${X}:y=${Y}:w=${W}:h=${H}:color=${colour}@1:t=fill`;
  }
  if (mode === 'smear') {
    // delogo interpolates from the pixels just OUTSIDE the box, so the box has
    // to have some picture on every side of it — nudge it in off any edge.
    const dx = Math.max(1, Math.min(X, srcW - 2));
    const dy = Math.max(1, Math.min(Y, srcH - 2));
    const dw = Math.max(2, Math.min(W, srcW - dx - 1));
    const dh = Math.max(2, Math.min(H, srcH - dy - 1));
    return `delogo=x=${dx}:y=${dy}:w=${dw}:h=${dh}`;
  }
  // blur: crop the band out, blur it hard, put it back exactly where it was
  const strength = clampN(frac(cover.strength, 0.8), 0, 1);
  const r = Math.max(4, Math.round(6 + strength * 26));
  const cr = Math.max(2, Math.round(r / 2));
  const a = `${label}a`, b = `${label}b`, c = `${label}c`;
  return `split=2[${a}][${b}];`
    + `[${b}]crop=${W}:${H}:${X}:${Y},boxblur=luma_radius=${r}:luma_power=2:chroma_radius=${cr}:chroma_power=1[${c}];`
    + `[${a}][${c}]overlay=${X}:${Y}`;
}

/** Put the cover in front of whatever the export was going to do anyway. */
function withCover(vfCore, srcW, srcH, cover, label) {
  const cv = coverChain(srcW, srcH, cover, label);
  if (!cv) return vfCore;
  return vfCore ? `${cv},${vfCore}` : cv;
}

/*
 * ►► CROP FIRST, THEN SCALE — the same order the face-tracked export uses. ◄◄
 *
 * `scale(increase),crop` is the tidy way to write "cover the frame and take the
 * middle", and on a 16:9 recording going to a 9:16 short it does an enormous
 * amount of work for nothing: 1280x720 is scaled UP TO 3413x1920 with lanczos
 * and then 68% of those pixels are thrown away. Measured on a real sermon, 21.3
 * seconds of it for a 30-second clip.
 *
 * Taking the crop out of the SOURCE first and scaling only that is the same
 * picture from a third of the work — 12.3 s for the same clip — and it is not a
 * new idea here: exportShortReframed has always done exactly this, because a
 * crop that follows the speaker has to. This just stops the STILL-centred crop
 * being the odd one out.
 *
 * WHAT CHANGES, MEASURED HONESTLY. The crop rectangle has to land on whole
 * pixels, so the framing can differ from the old chain by up to half a source
 * pixel. The PICTURE does not get worse — detail retained came out at 3.118
 * against 3.106 for the old order, i.e. very slightly sharper, because the
 * pixels that survive are resampled once instead of being resampled as part of
 * a frame three times the size.
 *
 * Only when there is real waste. A source already near the target shape has
 * nothing thrown away, and cropping it first would be a rounding error for no
 * gain at all.
 */
function cropFirstChain(srcW, srcH, W, H) {
  if (!srcW || !srcH || !W || !H) return null;
  const srcAR = srcW / srcH, tAR = W / H;
  if (Math.abs(srcAR - tAR) < 0.02) return null;         // nothing is being thrown away
  let cw, ch;
  if (srcAR > tAR) {                                      // too wide: keep the height
    ch = even(srcH);
    cw = Math.min(even(srcW), Math.round(ch * tAR / 2) * 2);
  } else {                                                // too tall: keep the width
    cw = even(srcW);
    ch = Math.min(even(srcH), Math.round(cw / tAR / 2) * 2);
  }
  if (cw < 2 || ch < 2) return null;
  // Not worth a filter when it would keep almost everything anyway.
  if (cw * ch > srcW * srcH * 0.85) return null;
  /*
   * The offset must be able to be ZERO, and even() cannot say zero — it floors
   * at 2, because everywhere else in this file it is sizing a picture, not
   * placing one. Using it here put `crop=406:720:438:2` on a 720-tall source:
   * two pixels down from the top, reading two past the bottom, on every export
   * that was not being cropped vertically at all.
   */
  const pos = (v, max) => Math.max(0, Math.min(max, Math.round(v / 2) * 2));
  const cx = pos((srcW - cw) / 2, srcW - cw);
  const cy = pos((srcH - ch) / 2, srcH - ch);
  return `crop=${cw}:${ch}:${cx}:${cy}`;
}

function fillChain(srcW, srcH, W, H, fill, label = 'f') {
  const o = fillOpts(fill);
  const pre = cropFirstChain(srcW, srcH, W, H);
  const cropChain = pre
    ? `${pre},scale=${W}:${H}:flags=lanczos,setsar=1`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`;
  if (o.mode === 'crop') return cropChain;

  // Would there be anything to fill? A source already at the target ratio is
  // fully covered by the fit, so blur/bars have literally nothing to draw —
  // fall back to the plain path and don't pay for a filter that shows nothing.
  const sAR = (srcW > 0 && srcH > 0) ? srcW / srcH : W / H;
  const tAR = W / H;
  if (Math.abs(sAR - tAR) < 0.01) return cropChain;

  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
  if (o.mode === 'bars') {
    return `${fit},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }

  // background: cover the frame, blurred small-then-big, dimmed a touch.
  const dw = even(W / 8), dh = even(H / 8);
  const r = Math.max(2, Math.round(2 + o.strength * 9));   // radius on the 1/8-size image
  const cr = Math.max(1, Math.round(r / 2));
  // Darkening is MULTIPLICATIVE, via a luma LUT — not eq's `brightness`, which
  // is an additive offset and therefore not "18% darker" at all. Measured: on a
  // dark sermon frame (mean luma 49) eq=brightness=-0.18 subtracts 46 levels and
  // leaves 1.5 — pure black, i.e. worse-looking than the letterbox it replaced.
  // The LUT takes the same 18% off both a dark frame (49 -> 40) and a bright one
  // (208 -> 170), which is what "dim the background a little" has to mean.
  // (val-16) keeps the black point where it is instead of dragging it under.
  const bg = [
    `scale=${dw}:${dh}:force_original_aspect_ratio=increase`,
    `crop=${dw}:${dh}`,
    `boxblur=luma_radius=${r}:luma_power=2:chroma_radius=${cr}:chroma_power=1`,
    Math.abs(o.saturation - 1) > 0.01 ? `eq=saturation=${o.saturation.toFixed(2)}` : null,
    o.dim > 0 ? `lutyuv=y=(val-16)*${(1 - o.dim).toFixed(3)}+16` : null,
    `scale=${W}:${H}:flags=bicubic`,
    'setsar=1',
  ].filter(Boolean).join(',');

  const bgL = `${label}bg`, fgL = `${label}fg`, bgO = `${label}bgo`, fgO = `${label}fgo`;
  return `split=2[${bgL}][${fgL}];[${bgL}]${bg}[${bgO}];[${fgL}]${fit}[${fgO}];`
       + `[${bgO}][${fgO}]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1,setsar=1`;
}

/**
 * Render the export's audio on its own, CHECK that the room actually went, and
 * try again if it did not. Returns a temp WAV, or null to leave the encode to
 * do the audio itself.
 *
 * This exists because of the `arnndn` defect described at voiceIsolationAf: the
 * filter silently does nothing on roughly half its runs, and no arrangement of
 * the graph makes it certain. What IS certain is a measurement, so the audio is
 * rendered first and read back before anything expensive happens.
 *
 * The audio is produced by exactly the graph the encode would have used — same
 * input arguments, same cut plan when pieces are being joined — so the track is
 * sample-for-sample the one the video expects, and nothing can drift.
 *
 * Each retry adds a pass, because that is the only lever that actually changes
 * arnndn's answer (see withVoicePasses). The bar is what the same chain gives
 * with the isolation removed, which is what lets an already-clean recording
 * through on the first render: there is nothing there to take out, no retry
 * would find any, and the loop would only burn time. Attempts are capped and the
 * best of them wins, so this always terminates.
 */
/*
 * The order the pass counts are tried in, most-likely-to-work first, because
 * every attempt is a full pass over the recording's audio and the first one
 * usually has to be the last one. Measured failure rates on the same recording:
 * one pass 19 of 30, two passes 1 of 30, three 1 of 40, four 21 of 40 (that many
 * starts flattening the voice, which the check sees as lost separation and
 * rejects). Two first therefore turns the common case into a single render;
 * one is still in the list because it is the cheapest and it does work on some
 * sources, and four is last as a long stop.
 */
const VOICE_PASS_LADDER = [2, 3, 1, 4];
const VOICE_WANTED_GAIN_DB = 8;    // an isolation run that worked is worth far more than this
async function renderVerifiedVoice(ctx, { inputArgs, cut, af, hasAudio, cwd, signal, onProgress, durSec }) {
  // only ever forward: if the voice cleaner fails part-way the older chain takes
  // over and counts from its own start, and the bar must not drop back with it
  let hi = -1;
  const tell = (p) => { if (!onProgress || !(p > hi)) return; hi = p; try { onProgress(p); } catch (e) {} };
  /*
   * DeepFilterNet first, wherever it is installed: every setting, Light to
   * Studio, goes through it (see deepfilter.js for what it replaced and why).
   * It is deterministic, so none of the checking below is needed for it. If it
   * is missing or fails, the ffmpeg chain carries on exactly as before.
   */
  if (af && hasAudio && deepfilter.splitChain(af) && deepfilter.binPath()) {
    try {
      const voice = await deepfilter.renderVoice(ctx, { inputArgs, cut, af, cwd, signal, onProgress: tell, durSec });
      if (voice) { tell(100); return voice; }
    } catch (e) {
      if (e && e.name === 'CancelledError') throw e;
      console.warn('[voice] DeepFilterNet failed; using the ffmpeg chain instead: ' + ((e && e.message) || e));
    }
  }
  if (!af || !hasAudio || !/arnndn/.test(af)) return null;
  const joining = !!(cut && cut.chain && cut.a);
  const stem = path.join(os.tmpdir(), `cws-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const made = [];
  const render = async (chain, out) => {
    const a = [...inputArgs];
    // (the cut plan's picture goes nowhere: ffmpeg refuses a graph that leaves it dangling)
    if (joining) a.push('-filter_complex', `${cut.chain};${cut.v ? `[${cut.v}]nullsink;` : ''}[${cut.a}]${chain}[aout]`, '-map', '[aout]');
    else a.push('-vn', '-af', chain);
    a.push('-ar', '48000', '-c:a', 'pcm_s16le', '-y', out);
    made.push(out);
    await ff.runFfmpeg(ctx.ffmpeg, a, { signal, cwd });
  };
  const drop = (f) => { try { fs.rmSync(f, { force: true }); } catch (e) {} };
  try {
    /*
     * The bar: what this same chain gives with the isolation taken out. Comparing
     * against that rather than against a fixed number is what lets an already-
     * clean recording through on the first go — there is nothing to remove, the
     * first render cannot beat the bar, and retrying would only burn time.
     */
    const bare = af.replace(/arnndn=.*?,atrim=start_sample=\d+,asetpts=[^,]*,?/g, '').replace(/^,|,$/g, '');
    const ref = await measureSeparation(ctx, { inputArgs, cut, af: bare });
    tell(15);

    let best = null, bestSep = -Infinity, tries = 0;
    for (const passes of VOICE_PASS_LADDER) {
      const out = `${stem}-${passes}.wav`;
      await render(withVoicePasses(af, passes), out);
      const sep = await measureSeparation(ctx, { inputArgs: ['-i', out] });
      tell(15 + Math.round((85 * ++tries) / VOICE_PASS_LADDER.length));
      if (sep == null) { best = out; break; }            // cannot read it back: take it
      if (sep > bestSep) { if (best) drop(best); best = out; bestSep = sep; } else drop(out);
      if (ref == null) break;                            // nothing to compare against
      if (bestSep >= ref + VOICE_WANTED_GAIN_DB) break;  // it worked
    }
    for (const f of made) if (f !== best) drop(f);
    return best;
  } catch (e) {
    for (const f of made) drop(f);
    return null;                                          // fall back to filtering inline
  }
}

/*
 * ►► THE VOICE IS PART OF THE BAR. ◄◄
 *
 * Studio sound renders the cleaned voice BEFORE the picture is touched, and
 * that render used to report nothing — so the studio's bar crept forward on
 * its own (tasks.js), parked on 73% and sat there for minutes while the voice
 * cleaner and then most of the encode ran underneath it. "It's on 73% for some
 * time!!" on a 10:32 export. Now the voice reports its own progress and has
 * the first slice of the export's bar; the encode has the rest.
 *
 * The slice is measured, on the Oracle server: a 2-minute 1080p export took
 * 87 s plain and 110 s with Studio sound, so the voice is ~20% of the export.
 * (Where the picture is encoded on a GPU the voice is relatively bigger; being
 * a little out changes the pace of the bar, never whether it moves.)
 */
const VOICE_SHARE = 22;
const voiceWillRender = (af, hasAudio) => !!(af && hasAudio
  && ((deepfilter.splitChain(af) && deepfilter.binPath()) || /arnndn/.test(af)));
function voiceThenPicture(onProgress, af, hasAudio) {
  if (!onProgress || !voiceWillRender(af, hasAudio)) return { voice: null, picture: onProgress };
  const clamp = (p) => Math.max(0, Math.min(100, Number(p) || 0));
  return {
    voice: (p) => onProgress(Math.round((clamp(p) * VOICE_SHARE) / 100)),
    picture: (p) => onProgress(Math.round(VOICE_SHARE + (clamp(p) * (100 - VOICE_SHARE)) / 100)),
  };
}

/**
 * Encode with GPU acceleration when available — VideoToolbox on macOS,
 * Intel QSV / NVENC / AMF (via -hwaccel auto + h264_qsv) on Windows/Linux —
 * automatically falling back to libx264 so it still works on any machine.
 */
async function encodeWithFallback(ctx, { inputArgs, cut, vfCore, af, dur, hasAudio, output, onProgress, cwd, quality, fps, signal }) {
  const q = qualityDef(quality);
  // 30 was hard-coded here, which quietly halved every 60fps recording. The
  // caller passes the source rate; 30 remains the answer when it cannot be read.
  const outFps = Number(fps) > 0 ? String(Number(fps)) : '30';
  const joining = !!(cut && cut.chain);

  /*
   * Voice isolation is checked before the picture is touched — see
   * renderVerifiedVoice. When it produces a track, the encode stops filtering
   * audio and simply plays that file: the expensive video work then happens
   * exactly once, over sound already known to be clean.
   */
  const bar = voiceThenPicture(onProgress, af, hasAudio);
  const voiceTrack = await renderVerifiedVoice(ctx, { inputArgs, cut, af, hasAudio, cwd, signal, onProgress: bar.voice, durSec: dur });
  onProgress = bar.picture;
  // Which input the checked track is: it goes on the end, after however many
  // the caller already had.
  const voiceIdx = inputArgs.filter((x) => x === '-i').length;
  /*
   * ffmpeg reads options positionally: anything before an `-i` belongs to that
   * input, anything after the last one belongs to the output. A trimmed clip
   * arrives here as `-ss S -i file -t D`, where that `-t` is the OUTPUT cap —
   * so simply appending `-i voiceTrack` would hand the cap to the new input
   * instead and leave the picture uncapped. Measured: an 18-second clip came out
   * with 18 s of sound under 21 s of video. The tail is therefore split off and
   * re-emitted after the new input, where it means what it always meant.
   */
  const lastI = inputArgs.lastIndexOf('-i');
  const headArgs = lastI >= 0 ? inputArgs.slice(0, lastI + 2) : inputArgs;
  const tailArgs = lastI >= 0 ? inputArgs.slice(lastI + 2) : [];

  // Build one command. When a cut plan is joining pieces the graph has to be a
  // -filter_complex (several branches feeding a concat), and -filter_complex
  // switches off ffmpeg's automatic stream selection — so audio must be mapped
  // by hand from the concat's own output label.
  const build = (head, fmt, codecArgs) => {
    const a = voiceTrack ? [...head, ...headArgs, '-i', voiceTrack, ...tailArgs] : [...head, ...inputArgs];
    if (joining) {
      let fc = `${cut.chain};[${cut.v}]${vfCore},format=${fmt}[vout]`;
      const cleaning = !!(af && hasAudio && cut.a && !voiceTrack);
      if (cleaning) fc += `;[${cut.a}]${af}[aout]`;
      // the checked voice plays instead of the joined sound, which then has to
      // go somewhere: ffmpeg refuses a graph with an output left dangling
      else if (voiceTrack && cut.a) fc += `;[${cut.a}]anullsink`;
      a.push('-filter_complex', fc, '-map', '[vout]');
      if (voiceTrack) a.push('-map', `${voiceIdx}:a`);
      else if (hasAudio && cut.a) a.push('-map', cleaning ? '[aout]' : `[${cut.a}]`);
    } else {
      a.push('-vf', `${vfCore},format=${fmt}`);
      // No -shortest: the checked track is one 10 ms frame shorter than the
      // picture (that is the delay compensation), and -shortest would cut the
      // video to match, throwing away the last frame of every export.
      if (voiceTrack) a.push('-map', '0:v:0', '-map', `${voiceIdx}:a:0`);
      else if (af && hasAudio) a.push('-af', af);
    }
    a.push('-r', outFps, ...codecArgs);
    if (hasAudio) a.push('-c:a', 'aac', '-b:a', '192k'); else a.push('-an');
    a.push('-movflags', '+faststart', '-y', output);
    return a;
  };
  const done = () => { if (voiceTrack) { try { fs.rmSync(voiceTrack, { force: true }); } catch (e) {} } };
  // 1) hardware attempt — VideoToolbox (macOS) or Quick Sync/NVENC/AMF (Win/Linux).
  //    Skipped on Windows/Linux while joining: QSV is unreliable behind a
  //    multi-branch filter graph (same reason exportShortReframed's blurred-pad
  //    path is software-only), and measured on the dev laptop it is SLOWER than
  //    x264 here anyway — a doomed attempt would just add a wasted encode plus a
  //    full decode-verify pass to every gap-closing export.
  if (!joining || process.platform === 'darwin') {
    try {
      const hw = process.platform === 'darwin'
        ? build(['-hwaccel', 'auto'], 'nv12', ['-c:v', 'h264_videotoolbox', '-q:v', '65'])
        : build(['-hwaccel', 'auto'], 'nv12', ['-c:v', 'h264_qsv', '-global_quality', String(q.qsv)]);
      await ff.runFfmpeg(ctx.ffmpeg, hw, { onProgress, totalDurationSec: dur, cwd });
      // QSV can exit 0 while still writing a corrupted stream (observed under GPU
      // encoder contention, e.g. two hardware encodes running at once) — a clean
      // exit code alone isn't proof the file is valid, so decode-check it before
      // trusting it. A quick -v error decode pass prints nothing for a healthy
      // file and floods with NAL/decode errors for a corrupted one.
      if (await isCleanEncode(ctx, output)) { done(); return; }
    } catch (e) { /* fall back to software */ }
  }
  // 2) software (works everywhere)
  /*
   * 'veryfast' was costing real, visible quality for speed the operator never
   * asked for — at the same CRF it spends noticeably more bitrate on the same
   * picture and softens fine detail (a lectern's edges, text on a screen).
   * 'medium' is the setting that makes "1080p" mean what people expect, and the
   * CRF comes from the tier so 4K is not judged by a 720p yardstick.
   */
  try {
    await ff.runFfmpeg(ctx.ffmpeg, build([], 'yuv420p', ['-c:v', 'libx264', '-preset', q.x264, '-crf', String(q.crf)]),
      { onProgress, totalDurationSec: dur, cwd });
  } finally { done(); }
}

/** Decode-only integrity check for a just-encoded file (see encodeWithFallback). */
async function isCleanEncode(ctx, output) {
  try {
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) return false;
    /*
     * ►► THIS CHECK WAS 30% OF EVERY HARDWARE EXPORT. ◄◄
     *
     * Measured on a real 30-second short: the encode took 24.6 s and proving it
     * was not garbage took 10.8 s more, because it decoded every frame AND every
     * sample in software.
     *
     * Two things make it twice as fast without making it any less suspicious:
     * the picture is decoded on the GPU (`-hwaccel auto`, which falls back to
     * software by itself if the GPU is busy — the very case this exists for),
     * and the sound is not decoded at all, because a corrupt QSV VIDEO stream is
     * what is being looked for.
     *
     * IT WAS CHECKED THAT IT STILL BITES. Against a good file and five kinds of
     * damaged one — single bytes, a 4 KB hole, a truncation, 10% of the stream
     * bit-flipped — the hardware and software decoders agreed on EVERY case,
     * catching the same ones and passing the same ones. `-skip_frame nokey`
     * would have been ten times faster again and missed corruption entirely,
     * which is why it is not used.
     */
    const err = await ff.runFfmpegCollect(ctx.ffmpeg,
      ['-v', 'error', '-hwaccel', 'auto', '-i', output, '-an', '-f', 'null', '-']);
    return !err || !err.trim();
  } catch (e) { return false; }
}

/**
 * Read key metadata from a media file.
 *
 * Remembered per file (path + size + modified time). The same recording is
 * probed again and again — opening it, its filmstrip, its waveform, every
 * thumbnail, every pass of every export — and each probe starts a 63 MB
 * ffprobe.exe: 0.4–0.7 s on an idle machine, and 2–12 s measured while other
 * ffmpeg work was running, which is where "Carry on" spent most of its wait.
 * A file that is rewritten has a new size or time, so it is probed afresh.
 */
const infoMemo = new Map();
async function getInfo(ctx, input) {
  let key = null;
  try { const st = fs.statSync(input); key = path.resolve(input) + '|' + st.size + '|' + st.mtimeMs; } catch (e) { /* let the probe say why */ }
  if (key && infoMemo.has(key)) return Object.assign({}, await infoMemo.get(key));
  const job = probeInfo(ctx, input);
  if (key) {
    infoMemo.set(key, job);
    job.catch(() => infoMemo.delete(key));
    if (infoMemo.size > 300) infoMemo.delete(infoMemo.keys().next().value);
  }
  return Object.assign({}, await job);
}
async function probeInfo(ctx, input) {
  const data = await ff.probe(ctx.ffprobe, input);
  const v = (data.streams || []).find((s) => s.codec_type === 'video');
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  let fps = 30;
  if (v && v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }
  const duration = parseFloat((data.format && data.format.duration) || (v && v.duration) || 0) || 0;
  return {
    path: input,
    durationSec: duration,
    durationLabel: hms(duration),
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    fps: Math.round(fps * 100) / 100,
    hasAudio: !!a,
    sizeBytes: parseInt((data.format && data.format.size) || 0, 10) || (fs.existsSync(input) ? fs.statSync(input).size : 0),
    vcodec: v ? v.codec_name : null,
    acodec: a ? a.codec_name : null,
    /*
     * The H.264 profile and level, for the one caller that has to MATCH them:
     * joining two files by stream copy (see appendByCopy). Whichever piece comes
     * first sets the decoder configuration, so a clip encoded High@4.1 in front
     * of a short encoded at something else makes the short's frames decode with
     * errors — which is exactly how the intro-on-the-front case kept failing its
     * own verification and falling back to a full re-encode.
     */
    vprofile: v && v.profile ? String(v.profile) : null,
    vlevel: v && Number.isFinite(v.level) ? v.level : null,
  };
}

/** Trim a clip to [startSec, endSec] with an accurate re-encode. */
async function trim(ctx, { input, startSec, endSec, fx, output, onProgress }) {
  const info = await getInfo(ctx, input);
  const start = Math.max(0, Number(startSec) || 0);
  const end = Math.min(info.durationSec || Number(endSec), Number(endSec));
  const dur = Math.max(0.05, end - start);
  // the clip's own look (see clipFx), when it has one
  const vf = fxVideo(fx), af = info.hasAudio ? fxAudio(fx) : '';
  const args = [
    '-ss', String(start), '-i', input, '-t', String(dur),
    ...(vf ? ['-vf', `${vf},format=yuv420p`] : []), ...(af ? ['-af', af] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-y', output,
  ];
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: dur });
  return output;
}

/** Reframe/scale a video into a social preset — center-crop, or (fill: 'blur')
 *  the whole picture over a blurred background of itself. */
async function exportForPlatform(ctx, { input, preset, fill, denoise, fadeIn, fadeOut, output, onProgress }) {
  const p = PRESETS[preset] || PRESETS['reel-9x16'];
  const info = await getInfo(ctx, input);
  const vfCore = fillChain(info.width, info.height, p.w, p.h, fill);
  const af = combineAf(await denoiseFilter(ctx, { input, denoise }), fadeFilter(fadeIn, fadeOut, info.durationSec));
  await encodeWithFallback(ctx, { inputArgs: ['-i', input], vfCore, af, dur: info.durationSec, hasAudio: info.hasAudio, output, onProgress });
  return output;
}

/** Save a single frame as a PNG (used for previews/thumbnails). */
async function thumbnail(ctx, { input, timeSec = 1, output, width = 640 }) {
  const args = [
    '-ss', String(Math.max(0, timeSec)), '-i', input,
    '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=${width}:-2`, '-y', output,
  ];
  await inPreviewLane(() => ff.runFfmpeg(ctx.ffmpeg, args, { preview: true }));
  return output;
}

/**
 * A short audio excerpt, optionally with the noise removal applied — the "hear
 * the difference" button. Rendering the real filter chain (rather than faking it
 * in the browser) is the point: what the operator judges by is exactly what the
 * export will do to every clip.
 */
async function audioSample(ctx, { input, startSec = 0, durationSec = 8, denoise, output }) {
  // Measured over the WHOLE recording, not just these 8 seconds: the export will
  // measure the whole clip too, and a sample tuned to a different floor would
  // not be the thing the operator is about to sign off on.
  const af = await denoiseFilter(ctx, { input, denoise });
  const inputArgs = ['-ss', String(Math.max(0, Number(startSec) || 0)), '-i', input,
    '-t', String(Math.max(0.5, Math.min(30, Number(durationSec) || 8)))];
  // The button's whole job is to be the truth about what the export will sound
  // like, so it goes through the same checked render (see renderVerifiedVoice) —
  // otherwise the preview could roll a clean take and the export a dirty one.
  const voiceTrack = await renderVerifiedVoice(ctx, { inputArgs, af, hasAudio: true });
  const args = voiceTrack ? ['-i', voiceTrack] : [...inputArgs, '-vn', ...(af ? ['-af', af] : [])];
  args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', output);
  try {
    await ff.runFfmpeg(ctx.ffmpeg, args, {});
  } finally {
    if (voiceTrack) { try { fs.rmSync(voiceTrack, { force: true }); } catch (e) {} }
  }
  return output;
}

/** Extract the audio track as an MP3. */
async function extractAudio(ctx, { input, output, onProgress }) {
  const info = await getInfo(ctx, input);
  if (!info.hasAudio) throw new Error('This video has no audio track to extract.');
  const args = ['-i', input, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-y', output];
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: info.durationSec });
  return output;
}

/**
 * AUTO-TRIM DEAD AIR: detect silent gaps and keep only the parts where someone
 * is speaking / there is sound. This is the "let AI cut it for me" feature.
 */
async function autoTrimSilence(ctx, { input, output, noiseDb = -30, minSilenceSec = 0.6, padSec = 0.15, onProgress }) {
  const info = await getInfo(ctx, input);
  if (!info.hasAudio) throw new Error('Auto-trim needs an audio track to find the quiet parts.');

  if (onProgress) onProgress(2);
  const detectArgs = ['-i', input, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, '-f', 'null', '-'];
  const log = await ff.runFfmpegCollect(ctx.ffmpeg, detectArgs);

  const silences = [];
  const re = /silence_start:\s*(-?\d+\.?\d*)[\s\S]*?silence_end:\s*(\d+\.?\d*)/g;
  let m;
  while ((m = re.exec(log)) !== null) {
    silences.push([Math.max(0, parseFloat(m[1])), parseFloat(m[2])]);
  }

  // Build the "keep" (loud) segments as the complement of the silent ranges.
  const D = info.durationSec;
  const keep = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    const segEnd = Math.max(cursor, s - 0) ;
    if (segEnd - cursor > 0.05) keep.push([Math.max(0, cursor - padSec), Math.min(D, s + padSec)]);
    cursor = e;
  }
  if (D - cursor > 0.05) keep.push([Math.max(0, cursor - padSec), D]);

  // Merge overlapping/adjacent segments produced by padding.
  const merged = [];
  for (const seg of keep.sort((a, b) => a[0] - b[0])) {
    if (merged.length && seg[0] <= merged[merged.length - 1][1] + 0.02) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], seg[1]);
    } else merged.push(seg.slice());
  }

  if (merged.length === 0) throw new Error('The whole clip looked silent — try a lower noise threshold.');

  const removed = Math.max(0, D - merged.reduce((acc, [s, e]) => acc + (e - s), 0));

  const sel = merged.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join('+');
  const filter =
    `[0:v]select='${sel}',setpts=N/FRAME_RATE/TB[v];` +
    `[0:a]aselect='${sel}',asetpts=N/SR/TB[a]`;
  const args = [
    '-i', input, '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', output,
  ];
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: merged.reduce((a, [s, e]) => a + (e - s), 0) });
  return { output, removedSeconds: Math.round(removed * 10) / 10, segments: merged.length };
}

/** Merge multiple clips into one, normalizing resolution and audio. */
async function merge(ctx, { inputs, output, width = 1920, height = 1080, fill, onProgress }) {
  if (!inputs || inputs.length < 2) throw new Error('Pick at least two clips to merge.');
  const infos = [];
  for (const i of inputs) infos.push(await getInfo(ctx, i));

  const args = [];
  inputs.forEach((i) => args.push('-i', i));

  // Add silent audio sources for any clip missing audio so concat stays balanced.
  let nextIdx = inputs.length;
  const audioLabel = infos.map((info, idx) => {
    if (info.hasAudio) return `[${idx}:a]`;
    args.push('-f', 'lavfi', '-t', String(Math.max(0.1, info.durationSec || 1)),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    return `[${nextIdx++}:a]`;
  });

  let fc = '';
  const vlabels = [], alabels = [];
  inputs.forEach((i, idx) => {
    fc += `[${idx}:v]${fillChain(infos[idx].width, infos[idx].height, width, height, fill == null ? 'bars' : fill, `m${idx}`)}` +
          `,fps=30,format=yuv420p[v${idx}];`;
    vlabels.push(`[v${idx}]`);
    fc += `${audioLabel[idx]}aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${idx}];`;
    alabels.push(`[a${idx}]`);
  });
  fc += vlabels.map((v, idx) => v + alabels[idx]).join('') + `concat=n=${inputs.length}:v=1:a=1[v][a]`;

  args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', output);

  const total = infos.reduce((a, i) => a + (i.durationSec || 0), 0);
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: total });
  return output;
}

/*
 * A CLIP'S LOOK — the studio's 🎛️ Video quality, set on one clip or on all of
 * them (CapCut's Filters / Adjust / Volume). It rides on the clip, so every
 * export of that clip carries it: the edited video, a short cut from it, a clip
 * added after it. The same recipes "Apply & export" has always used.
 *   { look: ''|vivid|warm|cool|bw|vintage, bri: -0.3..0.3, con: 0.5..1.8,
 *     sat: 0..2.5, sharp: 0..2, vol: 0..2 }
 */
const LOOKS = {
  bw: 'hue=s=0', warm: 'colorbalance=rm=0.12:gm=0.02:bm=-0.12', cool: 'colorbalance=rm=-0.12:bm=0.12',
  vivid: 'eq=saturation=1.5:contrast=1.12', vintage: 'curves=preset=vintage',
};
const numIn = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/** The look with anything left at "no change" dropped; null when nothing is changed. */
function clipFx(fx) {
  if (!fx || typeof fx !== 'object') return null;
  const o = {};
  if (LOOKS[fx.look]) o.look = fx.look;
  const bri = numIn(fx.bri, -0.3, 0.3, 0); if (Math.abs(bri) > 0.001) o.bri = +bri.toFixed(3);
  const con = numIn(fx.con, 0.5, 1.8, 1); if (Math.abs(con - 1) > 0.001) o.con = +con.toFixed(3);
  const sat = numIn(fx.sat, 0, 2.5, 1); if (Math.abs(sat - 1) > 0.001) o.sat = +sat.toFixed(3);
  const sharp = numIn(fx.sharp, 0, 2, 0); if (sharp > 0.001) o.sharp = +sharp.toFixed(2);
  const vol = numIn(fx.vol, 0, 2, 1); if (Math.abs(vol - 1) > 0.001) o.vol = +vol.toFixed(3);
  return Object.keys(o).length ? o : null;
}
/** The picture side of a look, as filter steps ('' for none). */
function fxVideo(fx) {
  const f = clipFx(fx); if (!f) return '';
  const vf = [];
  if (f.look) vf.push(LOOKS[f.look]);
  const eq = [];
  if (f.bri != null) eq.push('brightness=' + f.bri);
  if (f.con != null) eq.push('contrast=' + f.con);
  if (f.sat != null) eq.push('saturation=' + f.sat);
  if (eq.length) vf.push('eq=' + eq.join(':'));
  // after the grade, so it crisps the graded picture; luma only (no colour ringing)
  if (f.sharp != null) vf.push(`unsharp=5:5:${f.sharp.toFixed(2)}:5:5:0`);
  return vf.join(',');
}
/** The sound side ('' for none). */
const fxAudio = (fx) => { const f = clipFx(fx); return f && f.vol != null ? `volume=${f.vol}` : ''; };
const fxKey = (fx) => JSON.stringify(clipFx(fx));

/**
 * Normalise the kept pieces of a clip: sorted, clamped, non-overlapping, and
 * with anything shorter than a couple of frames dropped (an empty trim range
 * makes ffmpeg's concat filter fail). Pure, so it can be unit-tested.
 */
function normalizePieces(pieces, durationSec) {
  const D = durationSec > 0 ? durationSec : Infinity;
  const out = [];
  for (const p of (pieces || [])) {
    const a = Math.max(0, Math.min(D, Number(p.start) || 0));
    const b = Math.max(0, Math.min(D, Number(p.end) || 0));
    if (b - a < 0.08) continue; // ~2 frames — below this there is nothing to keep
    const t = transitionOf(p.trans);
    const q = t ? { start: a, end: b, trans: t } : { start: a, end: b };
    const fx = clipFx(p.fx);
    if (fx) q.fx = fx;
    out.push(q);
  }
  out.sort((x, y) => x.start - y.start);
  // merge pieces that touch/overlap so the concat filter never sees a duplicate
  // frame — unless the later one STARTS a transition: that join is the point —
  // or looks different (two halves of a split clip, one warm and one not)
  const merged = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && !p.trans && p.start <= last.end + 0.001 && fxKey(last.fx) === fxKey(p.fx)) last.end = Math.max(last.end, p.end);
    else {
      if (last && !p.trans && p.start < last.end) last.end = p.start;   // never the same frame twice
      merged.push(Object.assign({}, p));
    }
  }
  for (let i = merged.length - 1; i >= 0; i--) if (merged[i].end - merged[i].start < 0.04) merged.splice(i, 1);
  if (merged.length) delete merged[0].trans;   // nothing comes before the first piece
  return merged;
}

/*
 * TRANSITIONS BETWEEN CLIPS — CapCut's square between two clips.
 *
 * Each is one of ffmpeg's xfade transitions; the sound crosses over with
 * acrossfade for the same length. A transition OVERLAPS the end of one clip with
 * the start of the next, so the finished video is shorter by its length — the
 * studio re-times text, captions and music the same way (srcToOut, veditor.js).
 */
const TRANSITIONS = {
  fade: 'fade', dissolve: 'dissolve', fadeblack: 'fadeblack', fadewhite: 'fadewhite',
  slideleft: 'slideleft', slideright: 'slideright', slideup: 'slideup', slidedown: 'slidedown',
  wipeleft: 'wipeleft', wiperight: 'wiperight', zoomin: 'zoomin', circleopen: 'circleopen',
  hblur: 'hblur', pixelize: 'pixelize', smoothleft: 'smoothleft', radial: 'radial',
};
function transitionOf(t) {
  if (!t || !TRANSITIONS[t.type]) return null;
  const dur = Math.max(0.1, Math.min(3, Number(t.dur) || 0.5));
  return { type: t.type, dur };
}

/**
 * "CLOSE THE GAP", as something an export can do in its own single pass.
 *
 * Given the source ranges a clip keeps, this returns everything a caller needs to
 * cut the pauses out and join what's left back-to-back INSIDE the filter graph it
 * was going to run anyway — instead of rendering a joined intermediate first and
 * re-encoding it. One encode, no throwaway temp file, no second generation of
 * compression. Returns null when there is nothing to keep.
 *
 * Two things make it fast:
 *
 *  - The input is SEEKED to the first kept piece and capped at the last one, and
 *    the trim points are rebased onto that seek. Trimming from absolute source
 *    timestamps (what this used to do) makes ffmpeg decode the file from 00:00
 *    all the way to the piece — so closing a gap two hours into a sermon spent
 *    minutes decoding footage that was never going to be in the export, and each
 *    later short was slower than the one before it. Measured on a 480s 720p
 *    source with the pieces at 450s: 73.6s → 17.3s, and the two outputs are
 *    frame-identical (PSNR inf).
 *  - A single kept piece needs no concat at all — the caller just trims.
 *
 * `chain` ends in labels `[cutv]` (+ `[cuta]` when the source has audio) that the
 * caller feeds into its own scale/crop.
 */
function cutPlan(pieces, { durationSec, hasAudio, fps: fpsIn, noFx } = {}) {
  let ps = normalizePieces(pieces, durationSec);
  if (!ps.length) return null;
  // (frames pulled to TRACK the speaker want the footage, not the grade)
  if (noFx) ps = ps.map((p) => { const q = Object.assign({}, p); delete q.fx; return q; });
  const base = ps[0].start;
  const span = ps[ps.length - 1].end - base;
  const dur = ps.reduce((a, p) => a + (p.end - p.start), 0);
  const inputArgs = (input) => ['-ss', base.toFixed(3), '-i', input, '-t', span.toFixed(3)];
  // each piece's own look (see clipFx), right after it is cut out
  const vfx = (p) => { const f = fxVideo(p.fx); return f ? ',' + f : ''; };
  const afx = (p) => { const f = fxAudio(p.fx); return f ? ',' + f : ''; };
  const graded = ps.some((p) => p.fx);
  // Nothing removed → plain seek + trim, and the caller keeps its simple -vf path.
  if (ps.length === 1 && !graded) return { inputArgs, chain: null, v: '0:v', a: hasAudio ? '0:a' : null, dur, span, base, pieces: ps };

  let chain = '';
  ps.forEach((p, i) => {
    const s = (p.start - base).toFixed(3), e = (p.end - base).toFixed(3);
    chain += `[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS${vfx(p)}[cv${i}];`;
    if (hasAudio) chain += `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS${afx(p)}[ca${i}];`;
  });
  if (ps.length === 1) {
    chain += `[cv0]null[cutv]` + (hasAudio ? `;[ca0]anull[cuta]` : '');
    return { inputArgs, chain, v: 'cutv', a: hasAudio ? 'cuta' : null, dur, span, base, pieces: ps };
  }
  if (!ps.some((p) => p.trans)) {
    chain += ps.map((p, i) => (hasAudio ? `[cv${i}][ca${i}]` : `[cv${i}]`)).join('')
          + `concat=n=${ps.length}:v=1:a=${hasAudio ? 1 : 0}[cutv]` + (hasAudio ? '[cuta]' : '');
    return { inputArgs, chain, v: 'cutv', a: hasAudio ? 'cuta' : null, dur, span, base, pieces: ps };
  }
  /*
   * With transitions the pieces are joined one at a time, left to right: a join
   * that has one is an xfade (+ acrossfade), a join that does not is a plain
   * concat of the two. xfade wants both sides on one frame clock, so each piece
   * is put on the same constant rate first (a phone's variable-rate recording
   * would otherwise misplace the crossover).
   */
  const fps = Math.max(1, Math.round(Number(fpsIn) || 30));
  chain = '';
  ps.forEach((p, i) => {
    const s = (p.start - base).toFixed(3), e = (p.end - base).toFixed(3);
    chain += `[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS${vfx(p)},fps=${fps},settb=AVTB,format=yuv420p[cv${i}];`;
    if (hasAudio) chain += `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS${afx(p)},aresample=48000[ca${i}];`;
  });
  let v = 'cv0', a = hasAudio ? 'ca0' : null, outDur = ps[0].end - ps[0].start;
  for (let i = 1; i < ps.length; i++) {
    const len = ps[i].end - ps[i].start;
    const t = ps[i].trans;
    const nv = `jv${i}`, na = `ja${i}`;
    if (t) {
      // never longer than half of either side: a crossover needs both clips
      const d = Math.max(0.05, Math.min(t.dur, outDur / 2, len / 2));
      const off = Math.max(0, outDur - d);
      chain += `[${v}][cv${i}]xfade=transition=${TRANSITIONS[t.type]}:duration=${d.toFixed(3)}:offset=${off.toFixed(3)}[${nv}];`;
      if (hasAudio) chain += `[${a}][ca${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${na}];`;
      outDur = outDur + len - d;
    } else {
      chain += hasAudio ? `[${v}][${a}][cv${i}][ca${i}]concat=n=2:v=1:a=1[${nv}][${na}];` : `[${v}][cv${i}]concat=n=2:v=1:a=0[${nv}];`;
      outDur += len;
    }
    v = nv; if (hasAudio) a = na;
  }
  chain += `[${v}]null[cutv]` + (hasAudio ? `;[${a}]anull[cuta]` : '');
  return { inputArgs, chain, v: 'cutv', a: hasAudio ? 'cuta' : null, dur: outDur, span, base, pieces: ps };
}

/**
 * Cut a video down to just the given source ranges and join them back-to-back
 * into a standalone file. Exports don't need this any more — they fold the same
 * cut into their own pass via cutPlan() — but it stays as the joined-file
 * primitive behind video:joinPieces.
 */
async function joinPieces(ctx, { input, pieces, output, onProgress }) {
  const info = await getInfo(ctx, input);
  const plan = cutPlan(pieces, info);
  if (!plan) throw new Error('Nothing left to export — every part of this clip was removed.');
  // One piece and nothing removed → this is just a trim; don't pay for concat.
  if (!plan.chain) return trim(ctx, { input, startSec: plan.pieces[0].start, endSec: plan.pieces[0].end, output, onProgress });

  const args = [...plan.inputArgs(input), '-filter_complex', plan.chain, '-map', `[${plan.v}]`];
  if (plan.a) args.push('-map', `[${plan.a}]`, '-c:a', 'aac', '-b:a', '192k'); else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-movflags', '+faststart', '-y', output);
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: plan.dur });
  return output;
}

/**
 * Build a lightweight H.264 preview proxy. Electron's player can't decode some
 * codecs (notably HEVC/H.265), so we transcode a small, smooth H.264 copy just
 * for the preview player. The original full-quality file is still used for the
 * timeline, AI analysis and final export.
 */
/*
 * A PREVIEW, not an export. This used to go through encodeWithFallback — the
 * export path, with its voice-isolation pass, a GPU attempt and x264 'medium' —
 * which on a server with no GPU and half a CPU turned an hour of iPhone HEVC
 * into hours of encoding, long enough to run out of memory or out of the host's
 * request time, and the phone was left with "Preview unavailable" and nothing
 * to play. Nobody watches this file but the operator scrubbing a timeline: it
 * is encoded ultrafast at 720p, with a keyframe every second so a phone can
 * seek in it, and the original is still what every export is cut from.
 */
async function makeProxy(ctx, { input, output, onProgress }) {
  const info = await getInfo(ctx, input);
  const long = Math.max(info.width, info.height) || 1280;
  const f = long > 1280 ? 1280 / long : 1;
  const w = Math.max(2, Math.round(info.width * f / 2) * 2);
  const h = Math.max(2, Math.round(info.height * f / 2) * 2);
  const fps = Number(info.fps) > 0 ? Math.min(30, Number(info.fps)) : 30;
  const args = ['-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=${w}:${h},format=yuv420p`, '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '26',
    '-g', String(Math.round(fps)), '-keyint_min', String(Math.round(fps)),
    ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
    '-movflags', '+faststart', '-y', output];
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: info.durationSec, background: true });
  return output;
}

/** True if Chromium/Electron's <video> likely can't play this codec (needs a proxy). */
function needsProxy(info) {
  return /hevc|h265|hev1|hvc1|prores|mpeg2|vc1|wmv/i.test(info.vcodec || '');
}

/**
 * THE PICTURE PEOPLE SEE BEFORE THEY PRESS PLAY.
 *
 * Left alone, every platform picks its own thumbnail, and what it picks is
 * usually the first frame: a speaker mid-blink, or the tail of a camera cut.
 * The one frame a viewer actually judges the clip on is therefore chosen by
 * nobody. This lets it be chosen.
 *
 * Two things are produced, because the platforms want it two different ways:
 *
 *   • a JPEG beside the video, which is what YouTube, Facebook and TikTok all
 *     take when you upload a custom thumbnail by hand, and
 *   • the same picture embedded in the MP4 as cover art, which is what a file
 *     manager, a media player and some uploaders read straight out of the file.
 *
 * The video itself is never re-encoded: the streams are copied and only the
 * cover art is added, so a finished short is not put through a second
 * generation of compression for the sake of its own thumbnail.
 */
async function attachThumbnail(ctx, { input, imagePath, atSec = 0, output }) {
  const info = await getInfo(ctx, input);
  const dir = path.dirname(output || input);
  const base = path.basename(output || input).replace(/\.[^.]+$/, '');
  const jpg = path.join(dir, base + '.jpg');

  // 1. the picture: either the operator's own file, or the frame they chose
  if (imagePath && fs.existsSync(imagePath)) {
    await ff.runFfmpeg(ctx.ffmpeg, ['-i', imagePath,
      '-vf', `scale=${info.width}:${info.height}:force_original_aspect_ratio=increase,crop=${info.width}:${info.height}`,
      '-frames:v', '1', '-q:v', '2', '-y', jpg], {});
  } else {
    const at = Math.max(0, Math.min(atSec || 0, Math.max(0, (info.durationSec || 1) - 0.05)));
    await ff.runFfmpeg(ctx.ffmpeg, ['-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '2', '-y', jpg], {});
  }
  if (!fs.existsSync(jpg)) throw new Error('could not make the thumbnail picture');

  // 2. the same picture, carried inside the file
  const tmp = path.join(dir, base + '.thumb.mp4');
  try {
    await ff.runFfmpeg(ctx.ffmpeg, [
      '-i', input, '-i', jpg,
      '-map', '0', '-map', '1',
      '-c', 'copy', '-c:v:1', 'mjpeg',
      '-disposition:v:1', 'attached_pic',
      '-movflags', '+faststart',
      '-y', tmp,
    ], {});
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1000) {
      fs.rmSync(input, { force: true });
      fs.renameSync(tmp, input);
    } else {
      fs.rmSync(tmp, { force: true });
    }
  } catch (e) {
    // Cover art is a nicety; the JPEG beside the file is the part that matters,
    // and a container that will not carry one must not fail the export.
    try { fs.rmSync(tmp, { force: true }); } catch (er) {}
  }
  return { video: input, image: jpg };
}

/**
 * Extract sample frames from a clip range (for on-device face tracking).
 * With `pieces` the removed pauses are cut out here too, so the frames — and the
 * keyframes built from them — are on the JOINED clip's clock, exactly the footage
 * the export will contain. That's what lets tracking run without first rendering
 * a joined intermediate.
 */
/*
 * With `pairs`, every sample comes out TWICE: once at its own time and once
 * PAIR_DT (~a frame) later.
 *
 * That second picture is what makes "who is talking" answerable. Comparing one
 * sample against the NEXT sample means comparing across 1/6 of a second, which
 * is slower than speech — a mouth can open and shut again in between, so the
 * measurement aliases into noise and a man standing silent scores the same as a
 * man preaching. 33ms apart, a talking mouth has visibly moved and a closed one
 * has not. It costs one extra JPEG per sample and NO extra decoding: the
 * shifted copy is made inside the same pass by nudging the timestamps back
 * before re-sampling, so ffmpeg reads the file once and writes two sets of
 * stills.
 */
const PAIR_DT = 0.034;

async function extractFrames(ctx, { input, startSec, endSec, fps = 2, height = 360, outDir, pieces, pairs = false }) {
  fs.mkdirSync(outDir, { recursive: true });
  const cut = cutPlan(pieces, { hasAudio: false, noFx: true });
  const dur = cut ? cut.dur : Math.max(0.3, endSec - startSec);
  const pattern = path.join(outDir, 'f_%05d.jpg');
  const pairPattern = path.join(outDir, 'q_%05d.jpg');
  const chain = `fps=${fps},scale=-2:${height}`;
  const pairChain = `setpts=PTS-${PAIR_DT}/TB,${chain}`;
  const inArgs = cut ? cut.inputArgs(input) : ['-ss', String(startSec), '-i', input];
  const src = cut && cut.chain ? `${cut.chain};[${cut.v}]` : '[0:v]';
  /*
   * `-t` is an OUTPUT option, and with two outputs it has to be written on both.
   * Given once (as it used to be, tucked in after -i) it bounds only the first
   * one, and the second quietly keeps going to the end of the file — which, on
   * a four-hour convention recording, is a tracking job that never returns and
   * a temp folder filling with tens of thousands of stills. With a cut chain
   * the trim is inside the filtergraph, so no -t is wanted at all.
   */
  const outArgs = (label, pat) => [
    ...(label ? ['-map', label] : []),
    ...(cut && cut.chain ? [] : ['-t', String(dur)]),
    '-q:v', '4', '-y', pat,
  ];
  const args = pairs
    ? [...inArgs, '-filter_complex', `${src}split=2[pa][pb];[pa]${chain}[fo];[pb]${pairChain}[fq]`,
       ...outArgs('[fo]', pattern), ...outArgs('[fq]', pairPattern)]
    : cut && cut.chain
      ? [...inArgs, '-filter_complex', `${cut.chain};[${cut.v}]${chain}[fo]`, ...outArgs('[fo]', pattern)]
      : [...inArgs, '-vf', chain, ...outArgs(null, pattern)];
  const [, cuts] = await Promise.all([
    ff.runFfmpeg(ctx.ffmpeg, args, {}),
    detectSceneCuts(ctx, { input, startSec, dur, pieces }),
  ]);
  const files = fs.readdirSync(outDir).filter((f) => /^f_\d+\.jpg$/.test(f)).sort();
  const frames = files.map((f, i) => {
    const o = { t: (i + 0.5) / fps, path: path.join(outDir, f) };
    if (pairs) {
      const q = path.join(outDir, f.replace(/^f_/, 'q_'));
      if (fs.existsSync(q)) o.pairPath = q;
    }
    return o;
  });
  frames.cuts = cuts;
  return frames;
}

/**
 * Multi-camera church recordings hard-cut between angles and whip-pan to
 * re-frame — moments where the speaker's position TELEPORTS and the reframe
 * camera must snap instead of glide. A cheap low-res ffmpeg scene-score pass
 * finds those moments (clip-relative seconds). Returns [{t, score}]; failure
 * returns [] (tracking then behaves as before — single-shot assumption).
 */
async function detectSceneCuts(ctx, { input, startSec, dur, pieces }) {
  try {
    const cut = cutPlan(pieces, { hasAudio: false, noFx: true });
    // Each closed gap is itself a hard cut in the finished short, so scoring the
    // JOINED footage (not the original range) is what makes the crop snap at a
    // splice instead of gliding across it.
    const sceneVf = 'scale=-2:180,select=gt(scene\\,0.10),metadata=print';
    const args = cut && cut.chain
      ? [...cut.inputArgs(input), '-filter_complex', `${cut.chain};[${cut.v}]${sceneVf}[so]`, '-map', '[so]', '-f', 'null', '-']
      : ['-ss', String(startSec), '-t', String(dur), '-i', input, '-vf', sceneVf, '-f', 'null', '-'];
    const log = await ff.runFfmpegCollect(ctx.ffmpeg, args);
    const cuts = [];
    const re = /pts_time:(\d+\.?\d*)[\s\S]*?lavfi\.scene_score=(\d+\.?\d*)/g;
    let m;
    while ((m = re.exec(log)) !== null) cuts.push({ t: parseFloat(m[1]), score: parseFloat(m[2]) });
    return cuts;
  } catch (e) { return []; }
}

function clampN(v, a, b) { return Math.min(b, Math.max(a, v)); }

// The pan path is still simplified (Ramer–Douglas–Peucker: drop points the line
// already passes through) so the filter expression stays a sane length — but the
// cap is now about expression SIZE, not parser survival. buildLerpExpr emits a
// FLAT sum of time-gated ramps instead of the old nested-if chain, which the
// expression parser handled only to ~90 terms before dying with "Missing ')' or
// too many args"; measured, the flat form parses fine at 400+.
//
// That matters for framing, not just crashes: at 48 points RDP had to inflate its
// error tolerance to tens of pixels on a busy 45s clip, and those dropped corners
// were exactly the fast walks — the speaker drifted off-centre in the finished
// short even though the tracker had followed him correctly. 160 keeps the path
// faithful (RDP stays at its 2px tolerance on real clips) at ~8KB of expression.
const MAX_KEYFRAMES = 160;
function _verticalDist(p, a, b) {
  if (b[0] === a[0]) return Math.abs(p[1] - a[1]);
  const r = (p[0] - a[0]) / (b[0] - a[0]);
  const y_line = a[1] + (b[1] - a[1]) * r;
  return Math.abs(p[1] - y_line);
}
function simplifyKeyframes(kf, eps = 2, maxN = MAX_KEYFRAMES) {
  if (!kf || kf.length <= 2) return kf || [];
  let out = [];
  let currentEps = eps;
  
  // Adaptive RDP: if the simplified path has too many points for ffmpeg,
  // dynamically increase the epsilon (allowed pixel error) to filter out
  // smaller details first, preserving the most critical pan/boundary shapes.
  for (let iter = 0; iter < 30; iter++) {
    const keep = new Array(kf.length).fill(false);
    keep[0] = keep[kf.length - 1] = true;
    const stack = [[0, kf.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      let idx = -1, maxD = 0;
      for (let i = lo + 1; i < hi; i++) {
        const d = _verticalDist(kf[i], kf[lo], kf[hi]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > currentEps && idx > 0) {
        keep[idx] = true;
        stack.push([lo, idx], [idx, hi]);
      }
    }
    out = kf.filter((_, i) => keep[i]);
    if (out.length <= maxN) {
      break;
    }
    currentEps *= 1.4; // scale up tolerance
  }
  
  // Fallback safety net (highly unlikely with adaptive eps, but keeps type/length correct)
  if (out.length > maxN) {
    const step = (out.length - 1) / (maxN - 1), dec = [];
    for (let i = 0; i < maxN; i++) dec.push(out[Math.round(i * step)]);
    out = dec;
  }
  return out;
}


/**
 * Build a piecewise-linear ffmpeg expression f(t) from [t,value] keyframes.
 *
 * Emitted as a FLAT SUM of time-gated ramps — every term is zero except the one
 * segment containing t, so they add up to exactly that segment's value. The
 * older nested `if(lt(t,..),..,if(..))` chain expressed the same function but
 * nested one level per keyframe, and ffmpeg's parser gives out around 90 levels
 * ("Missing ')' or too many args"), which forced the pan path to be decimated
 * far more aggressively than framing accuracy could afford.
 *
 * The gates tile [−inf, t0) ∪ [t0,t1) ∪ … ∪ [tlast, +inf) with no gap and no
 * overlap: consecutive segments share an identically-formatted boundary string,
 * so each instant matches exactly one term. (A gap would sum to 0 and slam the
 * crop to the frame edge for a frame, so the tiling has to be exact.)
 */
function buildLerpExpr(kf, fallback) {
  if (!kf || !kf.length) return String(fallback || 0);
  kf = kf.slice().sort((a, b) => a[0] - b[0]);
  if (kf.length === 1) return String(kf[0][1]);
  const t = (v) => v.toFixed(3);
  const parts = [`(lt(t,${t(kf[0][0])})*${kf[0][1]})`];
  for (let i = 0; i < kf.length - 1; i++) {
    const [t0, v0] = kf[i], [t1, v1] = kf[i + 1];
    const dt = Math.max(1e-3, t1 - t0);
    parts.push(`(gte(t,${t(t0)})*lt(t,${t(t1)})*(${v0}+(${v1}-${v0})*(t-${t(t0)})/${t(dt)}))`);
  }
  const last = kf[kf.length - 1];
  parts.push(`(gte(t,${t(last[0])})*${last[1]})`);
  return parts.join('+');
}

/**
 * Export a highlight as a 9:16 (or other) short that FOLLOWS the speaker: a
 * time-varying crop window driven by face-tracking keyframes [{t,x}] (clip
 * relative, in SOURCE pixels), then scaled to the target preset.
 */
async function exportShortReframed(ctx, { input, startSec, endSec, preset = 'reel-9x16', quality, keyframes, pieces, fill, denoise, cover, fadeIn, fadeOut, motion, output, onProgress }) {
  const p = presetSize(preset, quality);
  const { info, cut, inputArgs, dur } = await shortSource(ctx, { input, startSec, endSec, pieces });
  const af = combineAf(await denoiseFilter(ctx, { input, denoise, startSec, endSec }), fadeFilter(fadeIn, fadeOut, dur));
  // "Show the whole picture over a blurred background" and "crop in and follow
  // the speaker" are opposite answers to the same question, and the first one
  // wins when it is asked for: there is no crop window to move, because nothing
  // is being cropped. (The UI turns auto-reframe off when blur fill is picked;
  // this is the belt to that pair of braces.)
  if (fillOpts(fill).mode !== 'crop') {
    await encodeWithFallback(ctx, { inputArgs, cut, vfCore: withMotion(withCover(fillChain(info.width, info.height, p.w, p.h, fill), info.width, info.height, cover), motion, p.w, p.h), af, dur, hasAudio: info.hasAudio, output, onProgress,
      quality, fps: outputFps(info) });
    return output;
  }
  // With gaps closed the pauses are cut out inside this same graph, so the crop
  // reads its source from the concat instead of straight off the input — and the
  // keyframes' clock (t=0 at the start of the JOINED clip) already matches it.
  const srcV = cut && cut.chain ? `[${cut.v}]` : '[0:v]';
  const cutPre = cut && cut.chain ? cut.chain + ';' : '';
  const targetAR = p.w / p.h, srcAR = info.width / info.height;

  let cropW, cropH, xExpr, yExpr;
  if (srcAR > targetAR) {
    cropH = info.height; cropW = Math.round(cropH * targetAR / 2) * 2;
    const maxX = info.width - cropW;
    // The camera wants crop x = face - cropW/2. When the speaker stands near the
    // EDGE of the recording that x falls OUTSIDE [0, maxX] — a plain crop would
    // pin at the boundary and leave them off-centre. Instead of clamping, extend
    // the canvas with a BLURRED fill (CapCut/OpusClip style) so the crop can
    // follow past the edge and the speaker stays centred no matter where they stand.
    const desired = (keyframes || []).map((k) => [k.t, Math.round(k.x - cropW / 2)]);
    const overshoot = desired.length ? Math.max(0, ...desired.map(([, x]) => Math.max(-x, x - maxX))) : 0;
    if (overshoot > 2) {
      const P = Math.min(Math.ceil(overshoot / 2) * 2 + 2, cropW); // pad per side (even px)
      const padW = info.width + 2 * P;
      const pts = simplifyKeyframes(desired.map(([t, x]) => [t, clampN(x + P, 0, padW - cropW)]));
      const xe = buildLerpExpr(pts, Math.round((padW - cropW) / 2));
      // bg = the same frame stretched to the padded width, cropped back to height,
      // heavily blurred and slightly darkened; fg = the untouched frame centred on it.
      // `srcA` is how the audio is REFERRED TO INSIDE the graph; `mapA` is how it
      // is mapped on the command line (a bare stream specifier, not a label).
      const srcA = cut && cut.a ? `[${cut.a}]` : '[0:a]';
      const mapA = cut && cut.a ? `[${cut.a}]` : '0:a';
      /*
       * ►► THIS GRAPH IS THE SHORTS EXPORT. ◄◄
       *
       * On real sermon footage the speaker walks to the edge, so nearly every
       * face-tracked short lands here rather than on the plain clamped crop
       * below. Measured on a 90-second short: ONE ffmpeg run of 173 s out of a
       * 186 s export. Two things were making it dear, and neither was the
       * picture the operator actually sees.
       *
       * 1. THE PAD WAS BLURRED AT FULL SIZE. It is blurred until nothing in it
       *    is legible — that is its entire job — so a 24px-radius blur has
       *    already thrown away everything finer than 24px before it is looked
       *    at. Shrinking first, blurring the small copy with a proportionally
       *    smaller radius and scaling that back up lands in the same place for
       *    a sixteenth of the pixels. The upscale is bilinear ON PURPOSE:
       *    lanczos on a blur is money spent sharpening something with no edges
       *    left in it.
       * 2. IT NEVER ASKED FOR THE GPU. "QSV is flaky behind a multi-branch
       *    filter graph" is why, and that was never re-tested. It was now: this
       *    graph encodes on Quick Sync and the result decodes clean. It is not
       *    TRUSTED on that basis — it is tried and then PROVED, exactly as
       *    encodeWithFallback does, and a failure falls through to software.
       *
       * Measured together on 20 s of the sermon: 38.5 s -> 13.0 s (2.96x), and
       * the speaker's own pixels are bit-for-bit the ones that were always
       * there, because the untouched frame is overlaid ON TOP of the blur.
       */
      const SHRINK = 4;
      const smallW = Math.max(2, Math.round(padW / SHRINK / 2) * 2);
      const bgChain = `scale=${smallW}:-2,`
        + `boxblur=luma_radius=${Math.max(1, Math.round(24 / SHRINK))}:luma_power=2`
        + `:chroma_radius=${Math.max(1, Math.round(12 / SHRINK))}:chroma_power=2,`
        + `scale=${padW}:-2:flags=bilinear,crop=${padW}:${info.height},eq=brightness=-0.06`;
      /*
       * The voice, cleaned and checked first — as encodeWithFallback does for
       * every other export — rather than the clean-up running inline here,
       * where the voice cleaner (deepfilter.js) never got to it and face-tracked
       * shorts kept the old sound. It goes in as one more input, AFTER the
       * clip's own (its `-t` stays the output's cap, see encodeWithFallback).
       */
      const bar = voiceThenPicture(onProgress, af, info.hasAudio);
      const voice = (af && info.hasAudio) ? await renderVerifiedVoice(ctx, { inputArgs, cut, af, hasAudio: true, onProgress: bar.voice, durSec: dur }) : null;
      // (its own name: a fall-through to the plain path below starts the bar over)
      const padProg = bar.picture;
      const lastI = inputArgs.lastIndexOf('-i');
      const ins = voice ? [...inputArgs.slice(0, lastI + 2), '-i', voice, ...inputArgs.slice(lastI + 2)] : inputArgs;
      const voiceIdx = inputArgs.filter((x) => x === '-i').length;
      const padGraph = (fmt) => {
        let fc = cutPre + `${srcV}split=2[bgs][fgs];[bgs]${bgChain}[bg];`
          + `[bg][fgs]overlay=${P}:0,crop=${cropW}:${cropH}:x='${xe}':y=0`
          + `,scale=${p.w}:${p.h}:flags=lanczos,setsar=1${motionChain(motion, p.w, p.h) ? ',' + motionChain(motion, p.w, p.h) : ''},format=${fmt}[vout]`;
        if (af && info.hasAudio && !voice) fc += `;${srcA}${af}[aout]`;
        // with the voice playing in, the cut plan's own sound is not used
        else if (voice && cut && cut.a) fc += `;[${cut.a}]anullsink`;
        return fc;
      };
      const padArgs = (head, fmt, codecArgs) => {
        const a = [...head, ...ins, '-filter_complex', padGraph(fmt), '-map', '[vout]'];
        if (info.hasAudio) a.push('-map', voice ? `${voiceIdx}:a` : (af ? '[aout]' : mapA), '-c:a', 'aac', '-b:a', '192k'); else a.push('-an');
        // outputFps, not a hard-coded 30: this path was halving every 60fps
        // recording exactly the way the main encode used to (see export-quality).
        a.push('-r', String(outputFps(info)), ...codecArgs, '-movflags', '+faststart', '-y', output);
        return a;
      };
      const qd = qualityDef(quality);
      /*
       * Joining pieces (gaps closed) puts a concat in front of all this, and
       * encodeWithFallback's measured finding is that Quick Sync behind THAT is
       * slower than x264 anyway — so a doomed attempt would only add a wasted
       * encode plus a verify. Same rule here, for the same reason.
       */
      const hwOk = !(cut && cut.chain);
      try {
      if (hwOk) {
        try {
          const hw = process.platform === 'darwin'
            ? padArgs(['-hwaccel', 'auto'], 'nv12', ['-c:v', 'h264_videotoolbox', '-q:v', '65'])
            : padArgs(['-hwaccel', 'auto'], 'nv12', ['-c:v', 'h264_qsv', '-global_quality', String(qd.qsv)]);
          await ff.runFfmpeg(ctx.ffmpeg, hw, { onProgress: padProg, totalDurationSec: dur });
          if (await isCleanEncode(ctx, output)) return output;
        } catch (e) { /* fall through to software */ }
      }
      try {
        // 'veryfast' stays, deliberately. This is the path a machine WITHOUT a
        // working hardware encoder takes, and moving it to 'medium' to match the
        // rest of the app would make those machines several times slower at the
        // exact moment they have no GPU to make up for it. The CRF now comes
        // from the quality tier, so 4K is no longer judged by a 1080p yardstick.
        await ff.runFfmpeg(ctx.ffmpeg,
          padArgs([], 'yuv420p', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(qd.crf)]),
          { onProgress: padProg, totalDurationSec: dur });
        return output;
      } catch (e) { /* fall through to the plain clamped path below */ }
      } finally {
        if (voice) { try { fs.rmSync(voice, { force: true }); } catch (e) {} }
      }
    }
    const pts = simplifyKeyframes(desired.map(([t, x]) => [t, clampN(x, 0, maxX)]));
    xExpr = buildLerpExpr(pts, Math.round(maxX / 2));
    yExpr = '0';
  } else {
    cropW = info.width; cropH = Math.round(cropW / targetAR / 2) * 2;
    const maxY = info.height - cropH;
    const pts = simplifyKeyframes((keyframes || []).map((k) => [k.t, clampN(Math.round(k.y != null ? k.y : maxY / 2), 0, maxY)]));
    yExpr = buildLerpExpr(pts, Math.round(maxY / 2));
    xExpr = '0';
  }
  const vfCore = withMotion(withCover(`crop=${cropW}:${cropH}:x='${xExpr}':y='${yExpr}',scale=${p.w}:${p.h}:flags=lanczos,setsar=1`, info.width, info.height, cover), motion, p.w, p.h);
  const enc = { quality, fps: outputFps(info) };
  try {
    await encodeWithFallback(ctx, { inputArgs, cut, vfCore, af, dur, hasAudio: info.hasAudio, output, onProgress, ...enc });
  } catch (e) {
    // If the dynamic reframe filter still fails for any reason, never leave the user
    // with nothing — fall back to a static centered crop of the same range.
    const staticVf = `scale=${p.w}:${p.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${p.w}:${p.h},setsar=1`;
    await encodeWithFallback(ctx, { inputArgs, cut, vfCore: withMotion(withCover(staticVf, info.width, info.height, cover), motion, p.w, p.h), af, dur, hasAudio: info.hasAudio, output, onProgress, ...enc });
  }
  return output;
}

/**
 * PICTURE-IN-PICTURE OVERLAY COMPOSITE (multi-lane render into ONE video).
 * Renders `base` full-frame as the background, then composites each overlay clip
 * on top as a scaled PiP box during its own timeline window — producing a single
 * exported MP4 (this is the real "second lane / overlay" render, not independent
 * shorts). Software libx264 is used deliberately (robust with filter_complex).
 *
 * An overlay is EITHER a piece of footage (this same recording, or a second video
 * the operator added to the timeline) OR a still picture. The two cannot be fed
 * to ffmpeg the same way: a photo is a SINGLE FRAME, so it has to be LOOPED into
 * a clip of the right length or `overlay` shows it for one thirtieth of a second
 * and the operator sees nothing at all. `still` (or a picture file extension)
 * picks the looping path.
 *
 * overlays: [{ src, srcStart, srcEnd, tlStart, x, y, wFrac, still, mute, opacity, key }]
 *   src            overlay's source file (this video, another video, or a picture)
 *   srcStart/End   which footage of src to show. A still has no "where", so it
 *                  uses only the LENGTH (srcEnd - srcStart) as its time on screen
 *   tlStart        WHEN (output-timeline seconds) the overlay appears
 *   x, y           overlay top-left as a fraction of the base frame (0..1)
 *   wFrac          overlay width as a fraction of the base width (height keeps aspect)
 *   still          force the looped-picture path (otherwise read from the extension)
 *   mute           drop this overlay's own sound
 *   opacity        0..1 for watermarks (default 1 = solid)
 *   key            { color '#rrggbb', sim, blend } to key out a green/blue screen
 *   cover          fill the whole frame, cropped to fit (an AI Montage cutaway)
 *   fade           seconds to fade in and out over (the montage's are 0.25)
 *   frame          a white frame around the picture, as a fraction of the width
 *                  (an AI Montage framed picture's 6 px), drawn outside its box
 * baseStart/baseEnd (optional): render only that RANGE of the base (used when a
 * short is being exported — its PiP overlays are composited into just its range;
 * tlStart is then relative to baseStart, i.e. to the output's own clock).
 */
/** A chroma key as the filter wants it, or null when there is none. */
function keyOf(k) {
  if (!k || !/^#?[0-9a-f]{6}$/i.test(String(k.color || ''))) return null;
  return {
    hex: String(k.color).replace('#', '').toUpperCase(),
    sim: clampN(Number(k.sim) || 0, 0.01, 0.6),
    blend: clampN(Number(k.blend) || 0, 0, 0.3),
  };
}
async function exportOverlayComposite(ctx, { base, overlays = [], output, baseStart, baseEnd, onProgress }) {
  if (!overlays.length) throw new Error('No overlay clips to composite.');
  const info = await getInfo(ctx, base);
  const hasRange = baseStart != null && baseEnd != null;
  const bs = hasRange ? Math.max(0, Number(baseStart) || 0) : 0;
  const BW = info.width, BH = info.height;
  const dur = hasRange ? Math.max(0.3, Number(baseEnd) - bs) : info.durationSec;
  const fps = Math.max(1, Math.min(60, Math.round(info.fps || 30)));

  const inputs = hasRange ? ['-ss', String(bs), '-t', String(dur), '-i', base] : ['-i', base];
  // Seek each overlay input to its OWN footage rather than opening the whole file
  // and trimming from absolute timestamps — otherwise a PiP taken from two hours
  // into a sermon makes ffmpeg decode those two hours before it draws a frame.
  const cuts = [];
  for (const o of overlays) {
    const still = o.still != null ? !!o.still : isStillImage(o.src);
    const ss = Math.max(0, Number(o.srcStart) || 0);
    const se = Math.max(ss + 0.1, Number(o.srcEnd) || ss + 1);
    // Whether an overlay brings sound with it is a fact about the FILE, and the
    // only way to know is to ask: mapping [n:a] on a silent input is a hard
    // ffmpeg error, so guessing wrong would fail the whole export.
    let hasAudio = false;
    if (!still && !o.mute) { try { hasAudio = !!(await getInfo(ctx, o.src)).hasAudio; } catch (e) { hasAudio = false; } }
    cuts.push({ ss, se, olen: se - ss, still, hasAudio });
  }
  cuts.forEach((c, i) => {
    if (c.still) inputs.push('-loop', '1', '-framerate', String(fps), '-t', c.olen.toFixed(3), '-i', overlays[i].src);
    else inputs.push('-ss', c.ss.toFixed(3), '-t', c.olen.toFixed(3), '-i', overlays[i].src);
  });
  // A silent bed, added ONLY when the base has no sound but an overlay does:
  // amix needs a first input as long as the picture, or the mix (and with it the
  // file) would end when the shortest overlay does.
  let silentIdx = null;
  if (!info.hasAudio && cuts.some((c) => c.hasAudio)) {
    silentIdx = 1 + cuts.length;
    inputs.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  const tlOf = (o, idx) => {
    const t = Number(o.tlStart);
    return Math.max(0, o.tlStart != null && !Number.isNaN(t) ? t : cuts[idx].ss);
  };

  const parts = [];
  let cur = '0:v';
  overlays.forEach((o, idx) => {
    const inIdx = idx + 1;
    const { olen, still } = cuts[idx];
    const tl = tlOf(o, idx);
    const tlEnd = tl + olen;
    const cover = !!o.cover;
    const w = Math.max(2, Math.round((clampN(Number(o.wFrac) || 0.34, 0.02, 1) * BW) / 2) * 2);
    const edge = !cover && Number(o.frame) > 0 ? Math.max(1, Math.round(clampN(Number(o.frame), 0, 0.05) * BW)) : 0;
    const x = cover ? 0 : Math.round(clampN(o.x != null ? Number(o.x) : 0.62, -1, 1) * BW) - edge;
    const y = cover ? 0 : Math.round(clampN(o.y != null ? Number(o.y) : 0.05, -1, 1) * BH) - edge;
    const op = clampN(o.opacity != null ? Number(o.opacity) : 1, 0.05, 1);
    // A picture is scaled with lanczos (it is a photo, not a moving frame) and
    // carried in RGBA so a logo's transparency survives to the overlay; footage
    // keeps its own format unless a fade-down opacity is asked for.
    let src = `[${inIdx}:v]`;
    const timing = [`trim=start=0:end=${olen.toFixed(3)}`, `setpts=PTS-STARTPTS+${tl.toFixed(3)}/TB`];
    /*
     * BLUR BEHIND: the picture over a blurred, darkened copy of itself that
     * fills the whole frame — a landscape photo in a 9:16 short, a portrait
     * clip in a 16:9 video — instead of over whatever is underneath.
     */
    if (o.bgBlur && !cover) {
      const bw = Math.max(2, Math.round(BW / 4 / 2) * 2), bh = Math.max(2, Math.round(BH / 4 / 2) * 2);
      parts.push(`[${inIdx}:v]${timing.join(',')},split[obg${idx}][ofg${idx}]`);
      parts.push(`[obg${idx}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:2,eq=brightness=-0.08,scale=${BW}:${BH},setsar=1[bgv${idx}]`);
      parts.push(`[${cur}][bgv${idx}]overlay=0:0:enable='between(t\\,${tl.toFixed(3)}\\,${tlEnd.toFixed(3)})':eof_action=pass[bb${idx}]`);
      cur = `bb${idx}`;
      src = `[ofg${idx}]`;
      timing.length = 0;
    }
    const fit = cover
      // the whole frame, the picture's middle — what the montage's cutaway is
      ? `scale=${BW}:${BH}:force_original_aspect_ratio=increase${still ? ':flags=lanczos' : ''},crop=${BW}:${BH}`
      : (still ? `scale=${w}:-2:flags=lanczos` : `scale=${w}:-2`);
    const chain = [...timing, fit, 'setsar=1'];
    if (edge) chain.push(`pad=iw+${2 * edge}:ih+${2 * edge}:${edge}:${edge}:white`);
    // Green screen: ffmpeg's own chromakey, the rule the preview's canvas copies
    // (veditor keyAlpha). Keyed before any fade-down so both apply.
    const key = keyOf(o.key);
    if (key) chain.push('format=yuva420p', `chromakey=color=0x${key.hex}:similarity=${key.sim.toFixed(3)}:blend=${key.blend.toFixed(3)}`);
    const fade = Math.min(clampN(Number(o.fade) || 0, 0, 2), olen / 2);
    if (still || op < 1 || key || fade > 0) chain.push('format=rgba');
    if (op < 1) chain.push(`colorchannelmixer=aa=${op.toFixed(3)}`);
    // in and out softly rather than cut (timestamps are the output's by now)
    if (fade > 0 && o.fadeIn !== false) chain.push(`fade=t=in:st=${tl.toFixed(3)}:d=${fade.toFixed(3)}:alpha=1`);
    if (fade > 0 && o.fadeOut !== false) chain.push(`fade=t=out:st=${(tlEnd - fade).toFixed(3)}:d=${fade.toFixed(3)}:alpha=1`);
    parts.push(`${src}${chain.join(',')}[ov${idx}]`);
    const out = (idx === overlays.length - 1) ? 'outv' : `t${idx}`;
    // composite it onto the running base, but only during its own window
    parts.push(`[${cur}][ov${idx}]overlay=${x}:${y}:enable='between(t\\,${tl.toFixed(3)}\\,${tlEnd.toFixed(3)})':eof_action=pass[${out}]`);
    cur = out;
  });

  /* ---- sound ----
   * A second video added to the overlay lane brings its own audio: the whole
   * point of overlaying the testimony clip is that you HEAR the testimony. Each
   * overlay's track is pushed to where it sits on the timeline (adelay) and
   * mixed under the base at full strength — normalize=0, because amix's default
   * divides every input by the number of inputs, which would silently halve the
   * sermon the moment a picture-in-picture appeared.
   */
  const audLabels = [];
  if (info.hasAudio) audLabels.push('0:a');
  else if (silentIdx != null) audLabels.push(`${silentIdx}:a`);
  cuts.forEach((c, idx) => {
    if (!c.hasAudio) return;
    const ms = Math.round(tlOf(overlays[idx], idx) * 1000);
    parts.push(`[${idx + 1}:a]asetpts=PTS-STARTPTS,adelay=${ms}:all=1[oa${idx}]`);
    audLabels.push(`oa${idx}`);
  });
  let amap = null;
  if (audLabels.length === 1) amap = audLabels[0] === '0:a' ? '0:a' : `[${audLabels[0]}]`;
  else if (audLabels.length > 1) {
    parts.push(`[${audLabels.join('][')}]amix=inputs=${audLabels.length}:duration=first:dropout_transition=0:normalize=0[outa]`);
    amap = '[outa]';
  }

  const filter = parts.join(';');
  const args = [...inputs, '-filter_complex', filter, '-map', '[outv]'];
  if (amap) args.push('-map', amap);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30', '-pix_fmt', 'yuv420p');
  if (amap) args.push('-c:a', 'aac', '-b:a', '192k'); else args.push('-an');
  // A looped still never ends on its own, so the OUTPUT is bounded too — belt to
  // the -t braces on each picture input.
  args.push('-t', dur.toFixed(3), '-movflags', '+faststart', '-y', output);
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: dur });
  return output;
}

/*
 * TEXT THAT ARRIVES. CapCut's text has an "In" animation, and a title that
 * simply blinks on reads as unfinished next to one that rises into place. Each
 * is the same three numbers the preview draws from (veditor's textAnimState):
 * how opaque, how far below its place, how large — on the same clock, so the
 * file moves the way the preview did. Every animated text also fades out over
 * its last quarter-second instead of vanishing.
 */
const TEXT_ANIMS = ['none', 'fade', 'rise', 'pop', 'zoom'];
const textAnimOf = (a) => (TEXT_ANIMS.includes(a) ? a : 'none');
/** How long the arrival and the leaving take for a text shown `len` seconds. */
function textAnimTimes(len) {
  const L = Math.max(0.05, Number(len) || 0);
  return { inD: Math.min(0.35, L / 3), outD: Math.min(0.25, L / 4) };
}
/** The scale a text is drawn at, `p` (0..1) of the way through its arrival. */
function textAnimScale(anim, p) {
  const q = Math.min(1, Math.max(0, p));
  if (anim === 'pop') return q < 0.7 ? 0.6 + 0.48 * (q / 0.7) : 1.08 - 0.08 * ((q - 0.7) / 0.3);
  if (anim === 'zoom') return 1.35 - 0.35 * q;
  return 1;
}
/** How far below its place a rising text starts, as a fraction of the frame height. */
const TEXT_RISE = 0.06;
/** The rate an animated text is drawn at: the video's own, within reason. */
const textFps = (info) => Math.min(60, Math.max(24, Math.round(Number(info && info.fps) || 30)));

/**
 * The filter steps that lay ONE text picture (a full-frame transparent PNG at
 * input `idx`) onto `base`, labelled `out`. A still text is the single overlay
 * it always was. An animated one becomes a short stream of that same picture —
 * the loop filter repeats the decoded frame, it is not read from disk again —
 * that exists only for the text's own window, so it costs nothing outside it.
 */
function textOverlaySteps({ idx, base, out, im, W, H, fps = 30 }) {
  const s = Math.max(0, Number(im.start) || 0);
  const e = Math.max(s + 0.05, Number(im.end) || s + 1);
  const f = (v) => Number(v).toFixed(3);
  const anim = textAnimOf(im.anim);
  const src = `[${idx}:v]scale=${W}:${H}:flags=lanczos,format=rgba`;
  if (anim === 'none') {
    // eof_action=repeat: a still image ends after one frame, and the overlay
    // must keep showing it for the whole window.
    return [`${src}[ov${idx}]`,
      `[${base}][ov${idx}]overlay=0:0:eof_action=repeat:enable='between(t\\,${f(s)}\\,${f(e)})'[${out}]`];
  }
  const { inD, outD } = textAnimTimes(e - s);
  const n = Math.max(1, Math.ceil((e - s) * fps));
  const P = `min(1\\,max(0\\,(t-${f(s)})/${f(inD)}))`;
  // settb first: a picture's own time base is 1/25 s, and timestamps rounded to
  // it would put a 30 fps arrival's frames up to 20 ms off the preview's clock.
  let chain = `${src},loop=loop=${n - 1}:size=1:start=0,settb=AVTB,setpts=N/${fps}/TB+${f(s)}/TB`
    + `,fade=t=in:st=${f(s)}:d=${f(inD)}:alpha=1,fade=t=out:st=${f(e - outD)}:d=${f(outD)}:alpha=1`;
  let x = '0', y = '0';
  if (anim === 'pop' || anim === 'zoom') {
    const K = anim === 'pop'
      ? `if(lt(${P}\\,0.7)\\,0.6+0.48*${P}/0.7\\,1.08-0.08*(${P}-0.7)/0.3)`
      : `(1.35-0.35*${P})`;
    chain += `,scale=w='max(2\\,trunc(iw*${K}/2)*2)':h='max(2\\,trunc(ih*${K}/2)*2)':eval=frame`;
    // Grown about the text's own centre, not the frame's: the point (cx, cy)
    // of the picture stays where it is while everything else scales round it.
    const cx = Math.min(1, Math.max(0, Number.isFinite(Number(im.cx)) ? Number(im.cx) : 0.5)) * W;
    const cy = Math.min(1, Math.max(0, Number.isFinite(Number(im.cy)) ? Number(im.cy) : 0.5)) * H;
    x = `'${f(cx)}*(1-w/W)'`; y = `'${f(cy)}*(1-h/H)'`;
  } else if (anim === 'rise') {
    y = `'${f(TEXT_RISE * H)}*pow(1-${P}\\,2)'`;
  }
  // eof_action=pass: the stream ends with the text's window, and from then on
  // the picture is left alone.
  return [`${chain}[ov${idx}]`, `[${base}][ov${idx}]overlay=x=${x}:y=${y}:eval=frame:eof_action=pass[${out}]`];
}

/**
 * Composite transparent PNG overlays (each already rendered at the picture's own
 * aspect ratio by the renderer) onto a video for their own time windows.
 *
 * This is how "add text" is burned in: the renderer rasterises the exact same
 * HTML/CSS the preview shows, so the words that land in the file are the words
 * the operator placed — same font, same wrap, same size, same backing box. All
 * this side does is stamp the finished picture on, which is why it can't drift.
 *
 * images: [{ path, start, end }] (times are seconds into THIS video)
 */
async function burnImageOverlays(ctx, { input, images = [], output, onProgress }) {
  if (!images.length) throw new Error('No overlay images to burn.');
  const info = await getInfo(ctx, input);
  const W = info.width, H = info.height;
  const dur = info.durationSec;

  const build = (fmt) => {
    const args = ['-i', input];
    images.forEach((im) => args.push('-i', im.path));
    const parts = [];
    let cur = '0:v';
    images.forEach((im, idx) => {
      // The PNG is authored at the export frame size; the scale in each step
      // guards against a source whose real pixels differ (same ratio, so
      // nothing is distorted).
      const out = (idx === images.length - 1) ? 'outv' : `t${idx}`;
      parts.push(...textOverlaySteps({ idx: idx + 1, base: cur, out, im, W, H, fps: textFps(info) }));
      cur = out;
    });
    parts.push(`[${cur}]format=${fmt}[vout]`);
    args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
    if (info.hasAudio) args.push('-map', '0:a');
    return args;
  };
  // Quality matches the caption burn: keep the source resolution AND frame rate,
  // near-visually-lossless settings, audio untouched.
  const tail = (info.hasAudio ? ['-c:a', 'copy'] : ['-an']).concat(['-movflags', '+faststart', '-y', output]);
  try {
    await ff.runFfmpeg(ctx.ffmpeg, [...build('nv12'), '-c:v', 'h264_qsv', '-global_quality', '20', ...tail],
      { onProgress, totalDurationSec: dur });
    if (await isCleanEncode(ctx, output)) return output;
  } catch (e) { /* hardware path unavailable or unhappy behind a filter graph */ }
  await ff.runFfmpeg(ctx.ffmpeg, [...build('yuv420p'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', ...tail],
    { onProgress, totalDurationSec: dur });
  return output;
}

/**
 * Composite a whole CAPTION TRACK onto a video in one pass.
 *
 * The renderer draws the captions with the very layout the preview shows and
 * hands them over as a strip of transparent frames — one per moment the picture
 * actually CHANGES, each with the length it holds for. Those frames are read
 * back as a single variable-rate video stream (ffmpeg's concat demuxer, which is
 * what `duration` directives are for) and overlaid once.
 *
 * Doing it that way is the whole point: an overlay filter PER caption would mean
 * a hundred inputs and a hundred filters in the graph for a three-minute short —
 * and a still image cannot animate, so every arrival would have to become its
 * own input too. One stream, one overlay, any number of lines.
 *
 * track: { band:{x,y,w,h}, fps, authorW, authorH, frames:[{file, dur}] }
 * — band and author sizes are in the frame the renderer drew for; if the video
 * turns out to be a different size, the whole track is scaled with it, so the
 * captions stay in the same place on the picture.
 */
async function burnCaptionTrack(ctx, { input, track, output, onProgress, images = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-captrk-'));
  try {
    return await burnCaptionFrames(ctx, { input, track: writeTrackFrames(track, dir), output, onProgress, images });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/**
 * The renderer's frames, on disk. A frame with no PNG is a GAP between caption
 * lines: they all share one fully transparent image, written once however many
 * gaps there are.
 */
function writeTrackFrames(track, dir) {
  const frames = (track && track.frames) || [];
  if (!frames.length) throw new Error('No captions to burn.');
  let blank = null;
  const written = frames.map((f, i) => {
    if (!f.png) {
      if (!blank) {
        blank = path.join(dir, 'gap.png');
        fs.writeFileSync(blank, transparentPng(track.band.w, track.band.h));
      }
      return { file: blank, dur: f.dur };
    }
    const p = path.join(dir, `c${String(i).padStart(5, '0')}.png`);
    fs.writeFileSync(p, Buffer.from(f.png));
    return { file: p, dur: f.dur };
  });
  return Object.assign({}, track, { frames: written });
}

/** A w×h fully transparent PNG, built by hand so no image library is needed —
 *  one filter byte and a run of zeroes per scanline is as small as a PNG gets. */
function transparentPng(w, h) {
  const zlib = require('zlib');
  const table = transparentPng._crc || (transparentPng._crc = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
    return t;
  })());
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 4)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/*
 * ►► THE TEXT AND THE CAPTIONS IN ONE PASS, NOT TWO. ◄◄
 *
 * Both are the same job — composite transparent pictures onto the video — and
 * they were two separate ffmpeg runs, each decoding and re-encoding the whole
 * short. Measured on a 30-second 9:16 short: 16.7 s for the text and 16.7 s for
 * the captions, to lay images on a picture that was already finished.
 *
 * Done together it is one decode and one encode, so it costs what ONE of them
 * cost. It is also better: every re-encode is a generation of quality thrown
 * away, and this removes one from every short that has both.
 *
 * `images` are the added-text overlays, full-frame and time-windowed, and they
 * go on FIRST — the same order the two passes ran in, so text sits under the
 * captions exactly as it did before.
 */
async function burnCaptionFrames(ctx, { input, track, output, onProgress, images = [] }) {
  const frames = (track && track.frames) || [];
  if (!frames.length) throw new Error('No captions to burn.');
  const info = await getInfo(ctx, input);
  const W = info.width, H = info.height;
  const aw = track.authorW || W, ah = track.authorH || H;
  const kx = W / aw, ky = H / ah;
  const b = track.band;
  // Even offsets and sizes: 4:2:0 chroma cannot land an overlay on an odd pixel.
  const bx = Math.max(0, Math.min(W - 2, even(Math.round(b.x * kx))));
  const by = Math.max(0, Math.min(H - 2, even(Math.round(b.y * ky))));
  const bw = Math.max(2, Math.min(W - bx, even(Math.round(b.w * kx))));
  const bh = Math.max(2, Math.min(H - by, even(Math.round(b.h * ky))));
  const scaled = bw !== b.w || bh !== b.h;
  const fps = Math.max(1, Math.min(60, Number(track.fps) || 30));

  // The concat list lives beside the PNGs and names them relatively, so no
  // Windows path ever has to survive ffmpeg's demuxer quoting.
  const dir = path.dirname(frames[0].file);
  const listPath = path.join(dir, 'captrack.txt');
  const lines = ['ffconcat version 1.0'];
  for (const f of frames) {
    lines.push(`file '${path.basename(f.file).replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${Math.max(1 / fps, Number(f.dur) || 1 / fps).toFixed(4)}`);
  }
  // The concat demuxer gives the LAST entry no duration of its own unless the
  // file is named once more — without this the final caption blinks out early.
  lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf-8');

  const pics = (images || []).filter((im) => im && im.path && fs.existsSync(im.path));
  const build = (fmt) => {
    const parts = [];
    /*
     * The added text, if there is any. Input 0 is the video and input 1 is the
     * caption strip, so these start at 2 — and each is laid on the running
     * picture for its own window, exactly as burnImageOverlays does it alone.
     */
    let base = '0:v';
    pics.forEach((im, i) => {
      parts.push(...textOverlaySteps({ idx: i + 2, base, out: `tb${i}`, im, W, H, fps: textFps(info) }));
      base = `tb${i}`;
    });
    parts.push(`[1:v]format=rgba,setpts=PTS-STARTPTS${scaled ? `,scale=${bw}:${bh}:flags=lanczos` : ''},fps=${fps}[ov]`);
    // eof_action=pass: when the captions run out the picture carries on
    // untouched — never truncated to the length of the caption track.
    parts.push(`[${base}][ov]overlay=${bx}:${by}:eof_action=pass[cap]`);
    parts.push(`[cap]format=${fmt}[vout]`);
    const args = ['-i', input, '-f', 'concat', '-safe', '0', '-i', listPath];
    pics.forEach((im) => args.push('-i', im.path));
    args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
    if (info.hasAudio) args.push('-map', '0:a');
    return args;
  };
  // Same quality contract as every other burn: the source resolution AND frame
  // rate are kept, the encode is near-visually-lossless, the audio is untouched,
  // and a Quick Sync output that exits 0 while writing garbage is caught and
  // redone in software.
  const tail = (info.hasAudio ? ['-c:a', 'copy'] : ['-an']).concat(['-movflags', '+faststart', '-y', output]);
  try {
    await ff.runFfmpeg(ctx.ffmpeg, [...build('nv12'), '-c:v', 'h264_qsv', '-global_quality', '20', ...tail],
      { onProgress, totalDurationSec: info.durationSec });
    if (await isCleanEncode(ctx, output)) return output;
  } catch (e) { /* hardware path unavailable or unhappy behind a filter graph */ }
  await ff.runFfmpeg(ctx.ffmpeg, [...build('yuv420p'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', ...tail],
    { onProgress, totalDurationSec: info.durationSec });
  return output;
}

/**
 * Generate a single horizontal filmstrip image for the timeline.
 * Uses fast input-seek to grab one frame per slice in parallel (rather than
 * decoding every frame), then tiles them — dramatically faster on long / HEVC /
 * high-fps videos.
 */
async function filmstrip(ctx, { input, count = 16, height = 90, output }) {
  const info = await getInfo(ctx, input);
  const D = info.durationSec || 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-strip-'));
  const frames = [];
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) * D / count;
    const f = path.join(dir, `t_${String(i).padStart(3, '0')}.png`);
    frames.push(f);
    // A long recording's tiles are tens of seconds apart, so the nearest
    // KEYFRAME is as good a picture as the exact moment — and grabbing it skips
    // decoding the frames in between: measured 0.18 s and 80 MB a tile on 4K
    // HEVC, against 2.6 s and 168 MB. Short videos keep the exact frame.
    const fast = D / count > 10 ? ['-noaccurate_seek', '-skip_frame', 'nokey'] : [];
    tasks.push(() => inPreviewLane(() => ff.runFfmpeg(ctx.ffmpeg,
      ['-hwaccel', 'auto', ...fast, '-ss', String(t), '-i', input, '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=-2:${height}`, '-y', f], { preview: true })));
  }
  await runLimited(tasks, machine.small() ? 1 : 6);
  const have = frames.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 0);
  try {
    if (have.length >= 2) {
      await ff.runFfmpeg(ctx.ffmpeg,
        ['-framerate', '25', '-start_number', '0', '-i', path.join(dir, 't_%03d.png'),
          '-vf', `tile=${have.length}x1`, '-frames:v', '1', '-y', output], {});
    } else if (have.length === 1) {
      fs.copyFileSync(have[0], output);
    } else {
      throw new Error('Could not extract thumbnails.');
    }
    return { path: output, count: have.length };
  } finally {
    try { frames.forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} }); fs.rmdirSync(dir); } catch (e) {}
  }
}

/**
 * The input args + cut plan for exporting one clip: `pieces` (set when the user
 * closed gaps) cuts the pauses out inside this very pass; without them it's a
 * plain seek to [startSec, endSec]. Shared by all three short exporters.
 */
async function shortSource(ctx, { input, startSec, endSec, pieces }) {
  const info = await getInfo(ctx, input);
  const cut = cutPlan(pieces, info);
  if (cut) return { info, cut, inputArgs: cut.inputArgs(input), dur: Math.max(0.3, cut.dur) };
  const start = Math.max(0, Number(startSec) || 0);
  const end = Math.min(info.durationSec || Number(endSec), Number(endSec));
  const dur = Math.max(0.3, end - start);
  return { info, cut: null, inputArgs: ['-ss', String(start), '-i', input, '-t', String(dur)], dur };
}

/** Export one highlight range as a trimmed, reframed short (trim + reshape in one pass). */
/*
 * KEYFRAMES — CapCut's zoom-and-move on a clip. Each keyframe says how far the
 * finished frame is pushed in (z, 1 = not at all) and which point of it the
 * push heads for (x, y, fractions of the frame); between two keyframes the
 * values glide with an ease in and out, and outside a clip's keyframes the
 * picture is left alone.
 *
 * It works on the FINISHED frame — after the crop to 9:16, the blur fill, the
 * cover — so a punch-in is a punch-in on exactly what the preview shows, and
 * the face-tracker's crop and a keyframed zoom simply stack.
 *
 * motion: [{ start, end, pts: [{ t, z, x, y }] }], all in OUTPUT seconds.
 *
 * Rendered as a scale that changes size every frame followed by a crop back to
 * the frame: the window is (1 - 1/z) * x of the way across the frame, so x = 0.5
 * pushes into the middle and x = 0 holds the left edge still.
 */
const MOTION_MAX_Z = 3;
const MOTION_MAX_POINTS = 64;
function cleanMotion(motion) {
  const out = [];
  let left = MOTION_MAX_POINTS;
  for (const m of Array.isArray(motion) ? motion : []) {
    const start = Number(m && m.start), end = Number(m && m.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const pts = (Array.isArray(m.pts) ? m.pts : [])
      .map((p) => ({
        t: Number(p.t),
        z: clampN(Number(p.z) || 1, 1, MOTION_MAX_Z),
        x: clampN(Number.isFinite(Number(p.x)) ? Number(p.x) : 0.5, 0, 1),
        y: clampN(Number.isFinite(Number(p.y)) ? Number(p.y) : 0.5, 0, 1),
      }))
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t)
      .filter((p, i, a) => i === 0 || p.t - a[i - 1].t > 1e-3)
      .slice(0, Math.max(0, left));
    if (!pts.length) continue;
    // a clip whose keyframes never leave "no zoom" has nothing to draw
    if (pts.every((p) => p.z <= 1.0005)) continue;
    left -= pts.length;
    out.push({ start, end, pts });
  }
  return out;
}
/** The value of `key` at the output clock, as an ffmpeg expression in t. */
function motionExpr(motion, key, dflt) {
  const f = (v) => Number(v).toFixed(4);
  const clip = (pts) => {
    let e = f(pts[pts.length - 1][key]);
    for (let i = pts.length - 2; i >= 0; i--) {
      const a = pts[i], b = pts[i + 1];
      if (Math.abs(b[key] - a[key]) < 1e-6) { e = `if(lt(t\\,${f(b.t)})\\,${f(a[key])}\\,${e})`; continue; }
      const p = `clip((t-${f(a.t)})/${f(Math.max(1e-3, b.t - a.t))}\\,0\\,1)`;
      e = `if(lt(t\\,${f(b.t)})\\,${f(a[key])}+${f(b[key] - a[key])}*${p}*${p}*(3-2*${p})\\,${e})`;
    }
    return `if(lt(t\\,${f(pts[0].t)})\\,${f(pts[0][key])}\\,${e})`;
  };
  let e = f(dflt);
  for (let i = motion.length - 1; i >= 0; i--) {
    const m = motion[i];
    e = `if(between(t\\,${f(m.start)}\\,${f(m.end)})\\,${clip(m.pts)}\\,${e})`;
  }
  return e;
}
/** Where a keyframed clip is at output time t — the same numbers as the filter. */
function motionAt(motion, t) {
  const m = cleanMotion(motion).find((x) => t >= x.start && t <= x.end);
  if (!m) return { z: 1, x: 0.5, y: 0.5 };
  const pts = m.pts;
  if (t <= pts[0].t) return { z: pts[0].z, x: pts[0].x, y: pts[0].y };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t < b.t) {
      const p = clampN((t - a.t) / Math.max(1e-3, b.t - a.t), 0, 1);
      const e = p * p * (3 - 2 * p);
      return { z: a.z + (b.z - a.z) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
    }
  }
  const l = pts[pts.length - 1];
  return { z: l.z, x: l.x, y: l.y };
}
/** The filter steps that push in and move, for a W×H frame; '' when there are none. */
function motionChain(motion, W, H) {
  const mo = cleanMotion(motion);
  if (!mo.length || !(W > 0) || !(H > 0)) return '';
  const Z = motionExpr(mo, 'z', 1), X = motionExpr(mo, 'x', 0.5), Y = motionExpr(mo, 'y', 0.5);
  const sw = `(trunc(${W}*(${Z})/2)*2)`, sh = `(trunc(${H}*(${Z})/2)*2)`;
  return `scale=w='${sw}':h='${sh}':eval=frame:flags=bicubic`
    + `,crop=${W}:${H}:x='(${sw}-${W})*(${X})':y='(${sh}-${H})*(${Y})'`;
}
/** vfCore with the keyframed motion appended, at the frame's own size. */
const withMotion = (vfCore, motion, W, H) => {
  const c = motionChain(motion, W, H);
  return c ? `${vfCore},${c}` : vfCore;
};

async function exportShort(ctx, { input, startSec, endSec, preset = 'reel-9x16', quality, pieces, fill, denoise, cover, fadeIn, fadeOut, motion, output, onProgress }) {
  const { info, cut, inputArgs, dur } = await shortSource(ctx, { input, startSec, endSec, pieces });
  // `preset: 'source'` keeps the recording's own SHAPE. It is what "Export
  // video" uses: an edited full-length service is not a social clip, and
  // reshaping an hour of 16:9 preaching into a 9:16 crop would be nonsense.
  // The quality tier still applies — it decides how many pixels that shape has.
  const p = preset === 'source' ? sourceSize(info, quality) : presetSize(preset, quality);
  const vfBase = preset === 'source'
    ? (p ? `scale=${p.w}:${p.h}:flags=lanczos,setsar=1` : 'setsar=1')
    : fillChain(info.width, info.height, p.w, p.h, fill);
  // keyframes work on the finished frame, so they need its size
  const fw = p ? p.w : Math.round(info.width / 2) * 2, fh = p ? p.h : Math.round(info.height / 2) * 2;
  const vfCore = withMotion(withCover(vfBase, info.width, info.height, cover), motion, fw, fh);
  const af = combineAf(await denoiseFilter(ctx, { input, denoise, startSec, endSec }), fadeFilter(fadeIn, fadeOut, dur));
  await encodeWithFallback(ctx, { inputArgs, cut, vfCore, af, dur, hasAudio: info.hasAudio, output, onProgress,
    quality, fps: outputFps(info) });
  return output;
}

/**
 * Export a short using a MANUAL pan/zoom crop (CapCut-style "edit framing"):
 * zoom >= 1 (1 = tightest fit for the target ratio, larger = zoomed further in),
 * offsetX/offsetY in [0,1] position the crop window's center within the source
 * (0.5,0.5 = centered). Used when the user drags/zooms the crop guide instead of
 * relying on face-tracking.
 */
async function exportShortFramed(ctx, { input, startSec, endSec, preset = 'reel-9x16', quality, zoom = 1, offsetX = 0.5, offsetY = 0.5, pieces, denoise, cover, fadeIn, fadeOut, motion, output, onProgress }) {
  const p = presetSize(preset, quality);
  const { info, cut, inputArgs, dur } = await shortSource(ctx, { input, startSec, endSec, pieces });
  const targetAR = p.w / p.h, srcAR = info.width / info.height;

  // Baseline crop (zoom=1) = the tightest crop that fully fills the target ratio.
  let baseW, baseH;
  if (srcAR > targetAR) { baseH = info.height; baseW = baseH * targetAR; }
  else { baseW = info.width; baseH = baseW / targetAR; }
  const z = clampN(Number(zoom) || 1, 1, Math.min(info.width / (baseW / 8), info.height / (baseH / 8)));
  let cropW = Math.max(16, Math.round(baseW / z / 2) * 2);
  let cropH = Math.max(16, Math.round(baseH / z / 2) * 2);
  cropW = Math.min(cropW, info.width); cropH = Math.min(cropH, info.height);
  const maxX = info.width - cropW, maxY = info.height - cropH;
  const cx = clampN(Math.round(clampN(Number(offsetX), 0, 1) * info.width - cropW / 2), 0, maxX);
  const cy = clampN(Math.round(clampN(Number(offsetY), 0, 1) * info.height - cropH / 2), 0, maxY);

  const vfCore = withMotion(withCover(`crop=${cropW}:${cropH}:${cx}:${cy},scale=${p.w}:${p.h}:flags=lanczos,setsar=1`, info.width, info.height, cover), motion, p.w, p.h);
  const af = combineAf(await denoiseFilter(ctx, { input, denoise, startSec, endSec }), fadeFilter(fadeIn, fadeOut, dur));
  await encodeWithFallback(ctx, { inputArgs, cut, vfCore, af, dur, hasAudio: info.hasAudio, output, onProgress,
    quality, fps: outputFps(info) });
  return { output, cropW, cropH, cropX: cx, cropY: cy, srcW: info.width, srcH: info.height };
}

/* ============================ SOUND EFFECTS ============================
 *
 * CapCut's Sounds → Effects, made HERE rather than downloaded: each is a
 * recipe for ffmpeg's own sound generators, so the studio carries no audio
 * files, nothing has a licence attached, and a server with no internet still
 * has all of them. Made once into the output folder's "Sound effects" and
 * reused from there.
 */
const SFX = {
  whoosh:    { name: 'Whoosh', dur: 0.9, src: "anoisesrc=c=pink:d=0.9:a=0.9", af: 'highpass=f=250,lowpass=f=3200,afade=t=in:d=0.4,afade=t=out:st=0.45:d=0.45,volume=2.2' },
  swish:     { name: 'Swish', dur: 0.45, src: "anoisesrc=c=white:d=0.45:a=0.7", af: 'highpass=f=1200,lowpass=f=7000,afade=t=in:d=0.12,afade=t=out:st=0.15:d=0.3,volume=1.6' },
  riser:     { name: 'Riser', dur: 2.2, src: "aevalsrc='0.35*sin(2*PI*(180*t+260*t*t))+0.12*(random(0)*2-1)*t/2.2':d=2.2", af: 'afade=t=in:d=1.6,afade=t=out:st=2.05:d=0.15' },
  impact:    { name: 'Impact', dur: 1.6, src: "aevalsrc='(0.95*sin(2*PI*52*t)+0.4*sin(2*PI*104*t))*exp(-3.2*t)+0.35*(random(0)*2-1)*exp(-14*t)':d=1.6", af: 'lowpass=f=900' },
  hit:       { name: 'Hit', dur: 0.45, src: "aevalsrc='(0.85*sin(2*PI*95*t)+0.35*(random(0)*2-1))*exp(-16*t)':d=0.45", af: 'lowpass=f=2500' },
  ding:      { name: 'Ding', dur: 1.8, src: "aevalsrc='0.42*(sin(2*PI*1318*t)+0.5*sin(2*PI*2636*t)+0.22*sin(2*PI*3954*t))*exp(-2.6*t)':d=1.8", af: 'afade=t=in:d=0.004' },
  chime:     { name: 'Chime', dur: 1.6, src: "aevalsrc='0.36*sin(2*PI*880*t)*exp(-3*t)+0.36*sin(2*PI*1320*(t-0.18))*exp(-3*(t-0.18))*gte(t,0.18)':d=1.6", af: 'afade=t=in:d=0.004' },
  pop:       { name: 'Pop', dur: 0.18, src: "aevalsrc='0.9*sin(2*PI*(520-700*t)*t)*exp(-32*t)':d=0.18", af: 'afade=t=in:d=0.002' },
  click:     { name: 'Click', dur: 0.08, src: "aevalsrc='(random(0)*2-1)*exp(-160*t)':d=0.08", af: 'highpass=f=1500,volume=1.4' },
  shutter:   { name: 'Camera', dur: 0.35, src: "aevalsrc='(random(0)*2-1)*(exp(-120*t)+exp(-120*abs(t-0.13))*gte(t,0.13))':d=0.35", af: 'highpass=f=900,lowpass=f=8000,volume=1.3' },
  drumroll:  { name: 'Drum roll', dur: 2.4, src: "aevalsrc='(random(0)*2-1)*0.42*(0.55+0.45*sin(2*PI*26*t))*min(1,0.35+t/1.6)':d=2.4", af: 'highpass=f=140,lowpass=f=1300,volume=2.4,afade=t=out:st=2.2:d=0.2' },
  heartbeat: { name: 'Heartbeat', dur: 1.4, src: "aevalsrc='0.95*sin(2*PI*58*t)*exp(-22*t)+0.75*sin(2*PI*52*(t-0.26))*exp(-22*(t-0.26))*gte(t,0.26)':d=1.4", af: 'lowpass=f=300,volume=1.6' },
  glitch:    { name: 'Glitch', dur: 0.6, src: "aevalsrc='0.5*sgn(sin(2*PI*(220+880*floor(random(0)*6))*t))*gt(sin(2*PI*14*t),-0.2)':d=0.6", af: 'lowpass=f=5000,afade=t=out:st=0.5:d=0.1,volume=0.8' },
  boing:     { name: 'Boing', dur: 0.8, src: "aevalsrc='0.6*sin(2*PI*(120*t+80*sin(2*PI*7*t)/(2*PI*7)))*exp(-3.5*t)':d=0.8", af: 'afade=t=in:d=0.005' },
  swoopdown: { name: 'Swoop down', dur: 1.0, src: "aevalsrc='0.4*sin(2*PI*(900*t-380*t*t))':d=1.0", af: 'afade=t=in:d=0.08,afade=t=out:st=0.6:d=0.4' },
  tick:      { name: 'Clock tick', dur: 2.0, src: "aevalsrc='0.7*(random(0)*2-1)*exp(-260*mod(t,0.5))':d=2.0", af: 'highpass=f=2000,volume=1.5' },
};
async function makeSfx(ctx, { kind, output }) {
  const r = SFX[kind];
  if (!r) throw new Error('Unknown sound effect: ' + kind);
  await ff.runFfmpeg(ctx.ffmpeg, ['-f', 'lavfi', '-i', r.src, '-af', `${r.af},aformat=channel_layouts=stereo`, '-ar', '48000',
    '-t', String(r.dur), '-c:a', 'aac', '-b:a', '160k', '-y', output]);
  return output;
}

/*
 * A voiceover, or any sound, put back into the picture at its own moment.
 * Each one is delayed to where it sits (`at`, seconds into THIS file) and mixed
 * over the existing sound — normalize off, so the speaker does not get quieter
 * every time a sound is added — and the picture is copied untouched.
 */
async function mixSounds(ctx, { input, sounds, output, onProgress }) {
  const info = await getInfo(ctx, input);
  const list = (sounds || []).filter((x) => x && x.path && Number(x.at) < (info.durationSec || Infinity));
  if (!list.length) { fs.copyFileSync(input, output); return output; }
  const args = ['-i', input];
  for (const x of list) args.push('-i', x.path);
  const parts = [];
  const mixIn = [];
  if (info.hasAudio) mixIn.push('[0:a]');
  else { parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${(info.durationSec || 0).toFixed(3)}[base]`); mixIn.push('[base]'); }
  list.forEach((x, i) => {
    const ms = Math.max(0, Math.round((Number(x.at) || 0) * 1000));
    const vol = Math.max(0, Math.min(4, Number(x.volume) == null || isNaN(Number(x.volume)) ? 1 : Number(x.volume)));
    // `from`: a sound that began before this export's first frame plays from
    // where the export joins it; `dur`: how much of it is on the timeline
    const from = Math.max(0, Number(x.from) || 0);
    const trim = (from > 0 || x.dur > 0)
      ? `atrim=start=${from.toFixed(3)}${x.dur > 0 ? ':end=' + (from + Number(x.dur)).toFixed(3) : ''},asetpts=PTS-STARTPTS,` : '';
    parts.push(`[${i + 1}:a]${trim}aresample=48000,aformat=channel_layouts=stereo,volume=${vol.toFixed(3)},adelay=${ms}|${ms}[s${i}]`);
    mixIn.push(`[s${i}]`);
  });
  // a limiter on the sum: a sound on top of a loud moment must not clip
  parts.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.89:level=false[aout]`);
  args.push('-filter_complex', parts.join(';'), '-map', '0:v?', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', output);
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: info.durationSec });
  return output;
}

/** A recording from the phone or the desk's microphone, made into an ordinary .m4a. */
async function saveRecording(ctx, { inputPath, output }) {
  await ff.runFfmpeg(ctx.ffmpeg, ['-i', inputPath, '-vn', '-ac', '1', '-ar', '48000', '-af', 'highpass=f=70',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', output]);
  return output;
}

/** Render a waveform PNG for the whole audio track (for the timeline's audio row). */
/*
 * showwavespic keeps EVERY sample until the end, then draws. At a sermon's own
 * 48 kHz in float that is 518 MB for 45 minutes — a whole small server, from a
 * picture 2,400 pixels wide. The picture needs a few thousand samples per
 * column at most, so the sound is brought down to a rate sized to its length
 * (about six million samples, 16-bit) in large frames first: the same drawing,
 * measured at 70 MB instead of 471 on a 45-minute stereo track.
 */
const WAVE_SAMPLES = 6e6;
async function waveform(ctx, { input, width = 1600, height = 90, color = '0x4f7cff', output }) {
  const info = await getInfo(ctx, input);
  if (!info.hasAudio) throw new Error('This video has no audio track.');
  const rate = Math.max(1000, Math.min(8000, Math.round(WAVE_SAMPLES / Math.max(1, info.durationSec || 1))));
  const args = ['-vn', '-sn', '-dn', '-i', input, '-filter_complex',
    `[0:a]aresample=${rate},aformat=sample_fmts=s16:channel_layouts=mono,asetnsamples=n=8192,`
    + `showwavespic=s=${width}x${height}:colors=${color}:scale=sqrt[v]`,
    '-map', '[v]', '-frames:v', '1', '-y', output];
  await inPreviewLane(() => ff.runFfmpeg(ctx.ffmpeg, args, { preview: true }));
  return output;
}

/**
 * De-shake a clip using ffmpeg's bundled vidstab filters (2-pass): pass 1
 * analyzes per-frame motion into a transforms file, pass 2 smooths it out.
 */
async function stabilize(ctx, { input, output, smoothing = 15, onProgress }) {
  const info = await getInfo(ctx, input);
  // Run from the .trf file's own directory and reference it by bare name — a
  // Windows drive-colon (C:\...) inside a filter option value breaks ffmpeg's
  // filtergraph parser (":" is the key:value separator), same class of bug as
  // the .ass caption burn path (see captioner.js burnCaptions).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-stab-'));
  const trfName = 'transforms.trf';
  try {
    await ff.runFfmpeg(ctx.ffmpeg, ['-i', input, '-vf', `vidstabdetect=shakiness=8:accuracy=15:result=${trfName}`,
      '-f', 'null', '-y', (process.platform === 'win32' ? 'NUL' : '/dev/null')],
      { onProgress: (p) => onProgress && onProgress(Math.round(p * 0.4)), totalDurationSec: info.durationSec, cwd: dir });
    const vfCore = `vidstabtransform=input=${trfName}:smoothing=${smoothing}:crop=black,unsharp=5:5:0.8:3:3:0.4`;
    await encodeWithFallback(ctx, {
      inputArgs: ['-i', input], vfCore, dur: info.durationSec, hasAudio: info.hasAudio, output,
      onProgress: (p) => onProgress && onProgress(40 + Math.round(p * 0.6)), cwd: dir,
    });
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  return output;
}

/** Reverse a clip's video + audio (CapCut-style clip reversal). */
async function reverseClip(ctx, { input, startSec, endSec, output, onProgress }) {
  const info = await getInfo(ctx, input);
  let clipPath = input, cleanup = null;
  if (startSec != null && endSec != null) {
    clipPath = path.join(os.tmpdir(), `mw-revsrc-${Date.now()}.mp4`);
    await trim(ctx, { input, startSec, endSec, output: clipPath });
    cleanup = clipPath;
  }
  const dur = (endSec != null && startSec != null) ? (endSec - startSec) : info.durationSec;
  /*
   * ffmpeg's reverse filter holds every frame of what it reverses: 90 MB a
   * second of 1080p, 370 MB a second of 4K. A few seconds was enough to take a
   * 512 MB server down (and a minute of 4K would take a desktop down too). So
   * the clip is reversed in pieces sized to a memory budget — the LAST piece
   * first, each one backwards — and the pieces are joined in that order, which
   * is the whole clip backwards. The sound is reversed in one go (it is small).
   */
  const fps = Math.max(1, Math.min(120, Number(info.fps) || 30));
  const frameMB = Math.max(0.1, ((info.width || 1920) * (info.height || 1080) * 1.5) / 1048576);
  const budgetMB = machine.small() ? 64 : 1500;
  const pieceSec = Math.max(0.25, Math.min(60, (budgetMB / frameMB) / fps));
  try {
    if (dur <= pieceSec) {
      const args = ['-i', clipPath, '-vf', 'reverse'];
      if (info.hasAudio) args.push('-af', 'areverse');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
      if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
      args.push('-movflags', '+faststart', '-y', output);
      await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: dur });
      return output;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rev-'));
    try {
      /*
       * Pieces are exact FRAME ranges, not times: each one starts half a frame
       * before its first frame and runs exactly its frame count, so no frame is
       * read twice at a join or skipped — and each piece is stamped afresh
       * (setpts on the frame number, passthrough timing) so none is duplicated
       * on the way out either.
       */
      const total = Math.max(1, Math.round(dur * fps));
      const per = Math.max(1, Math.floor(pieceSec * fps));
      const n = Math.ceil(total / per);
      const parts = [];
      for (let i = n - 1; i >= 0; i--) {
        const first = i * per, count = Math.min(per, total - first);
        if (count < 1) continue;
        const f = path.join(dir, `r${String(n - 1 - i).padStart(4, '0')}.mp4`);
        const ss = first === 0 ? 0 : (first - 0.5) / fps;
        // -t BEFORE -i: the piece has to END for the reverse filter, or it keeps
        // reading (and holding) to the end of the file
        await ff.runFfmpeg(ctx.ffmpeg, ['-ss', ss.toFixed(6), '-t', ((first === 0 ? count - 0.5 : count) / fps).toFixed(6), '-i', clipPath, '-an',
          // constant rate, not passthrough: ffmpeg 7 leaves a passthrough
          // piece's last frame without a duration, so each join overlapped the
          // next piece by one frame and a player dropped it (231 of 240 came out)
          '-vf', `reverse,setpts=N/(${fps}*TB)`, '-fps_mode', 'cfr', '-r', String(fps),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-y', f], {
          onProgress: onProgress ? (p) => onProgress(Math.round(((n - 1 - i) + p / 100) / (n + 1) * 100)) : undefined,
          totalDurationSec: count / fps,
        });
        parts.push(f);
      }
      const list = path.join(dir, 'parts.txt');
      fs.writeFileSync(list, parts.map((f) => `file '${path.basename(f)}'`).join('\n') + '\n');
      const args = ['-f', 'concat', '-safe', '0', '-i', list];
      if (info.hasAudio) args.push('-i', clipPath, '-map', '0:v', '-map', '1:a', '-af', 'areverse', '-c:a', 'aac', '-b:a', '192k');
      args.push('-c:v', 'copy', '-movflags', '+faststart', '-shortest', '-y', output);
      await ff.runFfmpeg(ctx.ffmpeg, args, { cwd: dir, onProgress: onProgress ? (p) => onProgress(Math.round((n + p / 100) / (n + 1) * 100)) : undefined, totalDurationSec: dur });
      return output;
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  } finally { if (cleanup) try { fs.unlinkSync(cleanup); } catch (e) {} }
}

/** Hold a single frame (at timeSec) as a still for holdSec seconds, exported as its own clip. */
async function freezeFrame(ctx, { input, timeSec, holdSec = 2, output, onProgress }) {
  const frame = path.join(os.tmpdir(), `mw-freeze-${Date.now()}.png`);
  await thumbnail(ctx, { input, timeSec, output: frame, width: 1920 });
  try {
    await ff.runFfmpeg(ctx.ffmpeg, ['-loop', '1', '-i', frame, '-t', String(Math.max(0.2, holdSec)),
      '-vf', 'format=yuv420p', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-an', '-movflags', '+faststart', '-y', output], { onProgress, totalDurationSec: holdSec });
  } finally { try { fs.unlinkSync(frame); } catch (e) {} }
  return output;
}

/**
 * Comprehensive edit pass: speed, volume, background music, fades, colour grade
 * (brightness/contrast/saturation), look presets, rotate/flip. Builds one
 * filtergraph and re-encodes.
 */
async function applyEdits(ctx, { input, output, edits = {}, onProgress }) {
  const info = await getInfo(ctx, input);
  const denoiseAf = await denoiseFilter(ctx, { input, denoise: edits.denoise });
  const speed = Math.min(100, Math.max(0.1, Number(edits.speed) || 1));
  const outDur = info.durationSec / speed;

  const vf = [];
  const rot = ((((edits.rotate || 0) % 360) + 360) % 360);
  if (rot === 90) vf.push('transpose=1'); else if (rot === 270) vf.push('transpose=2'); else if (rot === 180) vf.push('transpose=1,transpose=1');
  if (edits.flipH) vf.push('hflip');
  if (edits.flipV) vf.push('vflip');
  if (edits.look && LOOKS[edits.look]) vf.push(LOOKS[edits.look]);
  const eq = [];
  if (edits.brightness) eq.push('brightness=' + Number(edits.brightness));
  if (edits.contrast != null && Number(edits.contrast) !== 1) eq.push('contrast=' + Number(edits.contrast));
  if (edits.saturation != null && Number(edits.saturation) !== 1) eq.push('saturation=' + Number(edits.saturation));
  if (eq.length) vf.push('eq=' + eq.join(':'));
  // Sharpness: ffmpeg unsharp (luma), amount 0..2 → luma_amount. Applied after the
  // colour grade so it crisps the graded picture; chroma amount 0 (avoids colour ringing).
  const sharpen = Math.min(2, Math.max(0, Number(edits.sharpen) || 0));
  if (sharpen > 0) vf.push(`unsharp=5:5:${sharpen.toFixed(2)}:5:5:0`);
  if (speed !== 1) vf.push(`setpts=${(1 / speed).toFixed(5)}*PTS`);
  if (edits.fadeIn) vf.push(`fade=t=in:st=0:d=${Number(edits.fadeIn)}`);
  if (edits.fadeOut) vf.push(`fade=t=out:st=${Math.max(0, outDur - Number(edits.fadeOut)).toFixed(2)}:d=${Number(edits.fadeOut)}`);
  vf.push('format=yuv420p');

  const vol = edits.volume != null ? Number(edits.volume) : 1;
  const music = edits.musicPath && fs.existsSync(edits.musicPath) ? edits.musicPath : null;
  const musicVol = edits.musicVolume != null ? Number(edits.musicVolume) : 0.3;
  const atempoChain = (sp) => { const p = []; let s = sp; while (s > 2) { p.push('atempo=2.0'); s /= 2; } while (s < 0.5) { p.push('atempo=0.5'); s *= 2; } p.push('atempo=' + s.toFixed(4)); return p.join(','); };

  const args = ['-i', input];
  if (music) args.push('-stream_loop', '-1', '-i', music);
  // The cleaned voice is rendered first, as for every other export (see
  // renderVerifiedVoice) — not left to run inline, where neither the voice
  // cleaner nor the RNNoise check can happen.
  const bar = voiceThenPicture(onProgress, denoiseAf, info.hasAudio);
  const voice = denoiseAf && info.hasAudio ? await renderVerifiedVoice(ctx, { inputArgs: ['-i', input], af: denoiseAf, hasAudio: true, onProgress: bar.voice, durSec: info.durationSec }) : null;
  if (bar.picture) onProgress = bar.picture;
  const voiceIn = music ? 2 : 1;
  if (voice) args.push('-i', voice);

  let fc = `[0:v]${vf.join(',')}[v]`;
  const aOut = [];
  if (info.hasAudio) {
    const af = [];
    // Noise removal goes FIRST, on the untouched recording — before any speed
    // change or gain, so afftdn measures the room the microphone actually heard.
    if (denoiseAf && !voice) af.push(denoiseAf);
    if (speed !== 1) af.push(atempoChain(speed));
    if (vol !== 1) af.push('volume=' + vol);
    if (edits.fadeIn) af.push(`afade=t=in:st=0:d=${Number(edits.fadeIn)}`);
    if (edits.fadeOut) af.push(`afade=t=out:st=${Math.max(0, outDur - Number(edits.fadeOut)).toFixed(2)}:d=${Number(edits.fadeOut)}`);
    fc += `;[${voice ? voiceIn : 0}:a]${af.length ? af.join(',') : 'anull'}[a0]`;
    aOut.push('[a0]');
  }
  if (music) {
    fc += `;[1:a]volume=${musicVol},atrim=0:${outDur.toFixed(2)},afade=t=out:st=${Math.max(0, outDur - 1).toFixed(2)}:d=1[am]`;
    aOut.push('[am]');
  }
  const map = ['-map', '[v]'];
  if (aOut.length === 2) { fc += `;${aOut.join('')}amix=inputs=2:duration=first:dropout_transition=0[aout]`; map.push('-map', '[aout]'); }
  else if (aOut.length === 1) { map.push('-map', aOut[0]); }

  args.push('-filter_complex', fc, ...map, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
  if (aOut.length) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart', '-y', output);
  try {
    await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: outDur });
  } finally {
    if (voice) { try { fs.rmSync(voice, { force: true }); } catch (e) {} }
  }
  return output;
}

/** Mux an .srt caption file into the video as a soft subtitle track. */
async function addCaptions(ctx, { input, srt, output, onProgress }) {
  const info = await getInfo(ctx, input);
  const args = [
    '-i', input, '-i', srt,
    '-map', '0', '-map', '1',
    '-c', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng', '-y', output,
  ];
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: info.durationSec });
  return output;
}

/**
 * Where the quiet stretches are inside [startSec, endSec], as SOURCE-time ranges.
 *
 * Used by "remove pauses" on the AI shorts: the renderer turns each returned
 * range into a `cut` on the clip, which the existing close-the-gap export path
 * already knows how to drop. Nothing is encoded here — silencedetect only reads.
 *
 * `padSec` leaves a breath at each end of the pause so the join doesn't clip the
 * tail of a word or start the next one mid-syllable; `minSilenceSec` is the "long
 * enough" threshold — shorter pauses are natural speech rhythm and stay.
 */
async function detectSilences(ctx, { input, startSec = 0, endSec, noiseDb = -30, minSilenceSec = 0.7, padSec = 0.12, onProgress }) {
  const info = await getInfo(ctx, input);
  if (!info.hasAudio) return { silences: [], durationSec: info.durationSec, hasAudio: false };
  const from = Math.max(0, Number(startSec) || 0);
  const to = Math.min(info.durationSec, endSec == null ? info.durationSec : Number(endSec));
  const span = Math.max(0, to - from);
  if (span < 0.5) return { silences: [], durationSec: info.durationSec, hasAudio: true };
  if (onProgress) onProgress(3);

  const args = ['-ss', String(from), '-t', String(span), '-i', input, '-vn',
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, '-f', 'null', '-'];
  const log = await ff.runFfmpegCollect(ctx.ffmpeg, args);
  if (onProgress) onProgress(90);

  // silencedetect prints start/end pairs; a trailing silence has no end line, so
  // close it at the range end rather than dropping it.
  const out = [];
  const re = /silence_start:\s*(-?\d+\.?\d*)|silence_end:\s*(-?\d+\.?\d*)/g;
  let m, openAt = null;
  while ((m = re.exec(log)) !== null) {
    if (m[1] !== undefined) openAt = Math.max(0, parseFloat(m[1]));
    else if (openAt != null) { out.push([openAt, parseFloat(m[2])]); openAt = null; }
  }
  if (openAt != null) out.push([openAt, span]);

  const silences = out
    .map(([a, b]) => [from + a + padSec, from + b - padSec])
    .filter(([a, b]) => b - a >= 0.15)          // nothing left after padding — not worth a cut
    .map(([a, b]) => ({ start: Math.max(from, a), end: Math.min(to, b) }))
    .filter((s) => s.end - s.start >= 0.15);
  if (onProgress) onProgress(100);
  return { silences, durationSec: info.durationSec, hasAudio: true, removedSeconds: silences.reduce((a, s) => a + (s.end - s.start), 0) };
}

/**
 * Lay a background-music bed under a finished clip.
 *
 * Deliberately the LAST step of an export chain: the picture is already final,
 * so this pass copies the video stream untouched (`-c:v copy`) and only rebuilds
 * audio — seconds, not minutes, and no extra generation of compression on a clip
 * that has already been through reframing and caption burning.
 *
 * musicStartSec picks where in the song to start; the song loops to fill a clip
 * longer than itself. `duck` drops the music while someone is speaking
 * (sidechaincompress) so the sermon stays intelligible under the bed.
 */
async function mixMusic(ctx, { input, output, musicPath, musicVolume = 0.25, musicStartSec = 0, fadeIn = 0.6, fadeOut = 1.2, duck = true, voiceVolume = 1, onProgress }) {
  if (!musicPath || !fs.existsSync(musicPath)) throw new Error('That music file could not be found.');
  const info = await getInfo(ctx, input);
  const dur = info.durationSec || 0;
  const vol = Math.max(0, Math.min(2, Number(musicVolume)));
  const fi = Math.max(0, Math.min(dur / 2, Number(fadeIn) || 0));
  const fo = Math.max(0, Math.min(dur / 2, Number(fadeOut) || 0));
  const start = Math.max(0, Number(musicStartSec) || 0);

  const args = ['-i', input, '-ss', String(start), '-stream_loop', '-1', '-i', musicPath];
  // Trim the (looped) music to the clip, level it, and fade both ends.
  const mus = [
    `atrim=0:${dur.toFixed(3)}`, 'asetpts=PTS-STARTPTS',
    'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `volume=${vol.toFixed(3)}`,
  ];
  if (fi > 0) mus.push(`afade=t=in:st=0:d=${fi.toFixed(2)}`);
  if (fo > 0) mus.push(`afade=t=out:st=${Math.max(0, dur - fo).toFixed(2)}:d=${fo.toFixed(2)}`);

  let fc, amap;
  if (info.hasAudio) {
    const vv = Math.max(0, Math.min(3, Number(voiceVolume) || 1));
    const voice = `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${vv !== 1 ? `,volume=${vv.toFixed(3)}` : ''}`;
    if (duck) {
      // The voice drives the compressor's sidechain, so the bed steps back the
      // moment the preacher speaks and comes up again in the gaps.
      fc = `${voice},asplit=2[voice][key];[1:a]${mus.join(',')}[music];`
         + `[music][key]sidechaincompress=threshold=0.045:ratio=9:attack=15:release=420:makeup=1[ducked];`
         + `[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.97[aout]`;
    } else {
      fc = `${voice}[voice];[1:a]${mus.join(',')}[music];`
         + `[voice][music]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.97[aout]`;
    }
    amap = '[aout]';
  } else {
    fc = `[1:a]${mus.join(',')}[aout]`;
    amap = '[aout]';
  }

  args.push('-filter_complex', fc, '-map', '0:v', '-map', amap,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', '-y', output);
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: dur });
  return output;
}

/**
 * Stick extra clips (an outro sting, an intro bumper) onto a finished video.
 *
 * The appended clips are scaled/padded into the MAIN video's frame — a 16:9
 * outro dropped onto a 9:16 short letterboxes instead of stretching, which is
 * what every real editor does and what the church's outro card actually needs.
 * A clip with no sound gets silence so the concat stays balanced.
 */
/** A still picture, which needs looping into a clip rather than decoding as one. */
const STILL_RE = /\.(jpe?g|png|webp|bmp|tiff?|avif)$/i;
const isStillImage = (p) => STILL_RE.test(String(p || ''));

/* ===================== PUTTING THE OUTRO ON THE END =======================
 *
 * ►► ADDING FIVE SECONDS SHOULD NOT COST RE-ENCODING THIRTY. ◄◄
 *
 * Measured on a 30-second short with a 5-second outro card: 26 seconds, in
 * software, because the concat below runs BOTH files through one filter graph
 * and re-encodes the lot. The sermon is decoded and encoded again from scratch
 * so that a title card can follow it — and every one of those re-encodes is
 * also a generation of quality quietly thrown away, on the part of the video
 * that matters most.
 *
 * The fast path conforms only the CLIP (five seconds) to the short's own shape,
 * frame rate and sound, and then joins them with the concat demuxer and
 * `-c copy`. The short's own frames are then copied byte for byte: the outro
 * costs what the outro costs, and the sermon costs nothing at all.
 *
 * It is attempted, verified and abandoned rather than assumed. A stream copy
 * across two files needs their codec parameters to agree, and when they do not
 * the result can be a file that plays here and stutters on somebody's phone —
 * so the join is decode-checked exactly the way a hardware encode is
 * (isCleanEncode), and anything short of clean falls through to the full
 * re-encode below, which has not changed.
 */
async function conformClip(ctx, { path: src, W, H, fps, fill, durationSec, still, srcW, srcH, fx, output, signal, profile, level }) {
  const args = [];
  if (still) args.push('-loop', '1', '-framerate', String(fps), '-t', durationSec.toFixed(2));
  args.push('-i', src);
  // Silence for a card that has none, so every piece of the join has a track and
  // the copy does not have to invent one.
  args.push('-f', 'lavfi', '-t', String(Math.max(0.1, durationSec || 1)),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const chain = fillChain(srcW, srcH, W, H, fill == null ? 'bars' : fill, 'cf');
  const look = fxVideo(fx);
  args.push('-filter_complex', `[0:v]${look ? look + ',' : ''}${chain},fps=${fps},format=yuv420p,setsar=1[v]`, '-map', '[v]');
  args.push('-map', still ? '1:a' : '0:a?');
  if (!still && fxAudio(fx)) args.push('-af', fxAudio(fx));
  // No audio of its own: take the silence instead, so -map 0:a? cannot come up
  // empty and leave the piece track-less.
  // Match what the short was encoded as, so the join's decoder configuration is
  // the same one either way round. `level` comes back from ffprobe as 40 for 4.0.
  const prof = /baseline/i.test(profile || '') ? 'baseline'
    : /^main$/i.test(profile || '') ? 'main' : 'high';
  const lvl = Number.isFinite(level) && level > 0 ? (level / 10).toFixed(1) : '4.1';
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-profile:v', prof, '-level', lvl, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '90000', '-shortest', '-y', output);
  await ff.runFfmpeg(ctx.ffmpeg, args, { signal });
  return output;
}

/*
 * WHY IT GOES ROUND THROUGH MPEG-TS AND NOT STRAIGHT THROUGH THE CONCAT DEMUXER.
 *
 * The obvious join is `-f concat -c copy` over the two MP4s, and it is wrong in
 * a way that exits 0: MP4 carries its own timescale per track, the two files do
 * not have to agree, and when they disagree the copied timestamps are scaled by
 * the difference. Measured here, a 30-second short plus a 5-second outro came
 * out as a file claiming to be 205 SECONDS LONG — clean to decode, correct
 * frames, nonsense clock.
 *
 * MPEG-TS has one fixed 90 kHz clock and no edit lists, so remuxing each piece
 * into it (a copy, not an encode) makes them agree by construction. That is the
 * long-standing recipe for joining H.264 without re-encoding it, and the two
 * extra remuxes cost a fraction of a second because no picture is touched.
 */
async function appendByCopy(ctx, { input, output, list, position, fill, stillSec, main, tmpDir, signal }) {
  // Only when the short really does carry both streams: a silent export would
  // need one invented, and inventing it is what the re-encode path is for.
  if (!main.hasAudio) return false;
  /*
   * ►► ONLY ON THE END, AND THAT IS MEASURED, NOT ASSUMED. ◄◄
   *
   * Putting a card in FRONT of the short joins cleanly and comes out the right
   * length, but the finished file carries a DTS discontinuity at the join —
   * "non monotonically increasing dts" — which no combination of +genpts,
   * -avoid_negative_ts or -reset_timestamps removes, because it is the short's
   * own timestamps restarting behind the card. It plays here; a platform that
   * re-muxes it may well refuse it, and a caption that is right nine times and
   * rejected the tenth is worse than one that is simply slower.
   *
   * The studio only ever appends (see appendOutroTo — every route passes
   * position: 'end'), so this costs nothing today and the full re-encode below
   * handles an intro correctly if one is ever wanted.
   */
  if (position === 'start') return false;
  // H.264 in, H.264 out — the bitstream filters below only know that one.
  if (main.vcodec && !/^(h264|avc)/i.test(main.vcodec)) return false;
  const W = main.width, H = main.height;
  const fps = Math.max(1, Math.min(60, Math.round(main.fps || 30)));
  if (!W || !H) return false;
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const temps = [];
  const ts = async (src, idx) => {
    const out = path.join(tmpDir, `join-${stamp}-${idx}.ts`);
    temps.push(out);
    await ff.runFfmpeg(ctx.ffmpeg, ['-i', src, '-c', 'copy',
      '-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts', '-y', out], { signal });
    return out;
  };
  try {
    const pieces = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const still = isStillImage(c.path);
      const probe = await getInfo(ctx, c.path).catch(() => null);
      if (!still && !probe) return false;
      const secs = still ? Math.max(0.5, Number(c.durationSec) || Number(stillSec) || 4)
        : (probe.durationSec || 0);
      if (!secs) return false;
      const mp4 = path.join(tmpDir, `conform-${stamp}-${i}.mp4`);
      temps.push(mp4);
      await conformClip(ctx, { path: c.path, W, H, fps, fill, durationSec: secs, still,
        srcW: (probe && probe.width) || W, srcH: (probe && probe.height) || H, fx: c.fx, output: mp4, signal,
        profile: main.vprofile, level: main.vlevel });
      pieces.push({ file: mp4, secs });
    }
    const mainTs = await ts(input, 'main');
    const clipTs = [];
    for (let i = 0; i < pieces.length; i++) clipTs.push(await ts(pieces[i].file, i));
    const order = position === 'start' ? [...clipTs, mainTs] : [mainTs, ...clipTs];
    await ff.runFfmpeg(ctx.ffmpeg, ['-i', 'concat:' + order.join('|'), '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-y', output], { signal });

    /*
     * VERIFIED BOTH WAYS. A join that silently dropped a piece exits 0 and
     * decodes clean; so does one whose clock is wrong. Only the length says so,
     * and it has to be checked from above as well as below — the MP4-demuxer
     * version of this produced a 205-second file from 35 seconds of video and
     * a "is it at least as long as expected" test waved it through.
     */
    if (!(await isCleanEncode(ctx, output))) return false;
    const got = await getInfo(ctx, output).catch(() => null);
    const want = (main.durationSec || 0) + pieces.reduce((n, p) => n + p.secs, 0);
    if (!got || !want || Math.abs(got.durationSec - want) > Math.max(0.75, want * 0.02)) return false;
    return true;
  } catch (e) {
    return false;
  } finally {
    for (const f of temps) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  }
}

async function appendClips(ctx, { input, output, clips = [], position = 'end', fill, stillSec = 4, onProgress }) {
  // A clip is either a path or { path, durationSec } — the second form is how a
  // still picture says how long it should be on screen.
  const list = (clips || [])
    .map((c) => (typeof c === 'string' ? { path: c } : c))
    .filter((c) => c && c.path && fs.existsSync(c.path));
  if (!list.length) throw new Error('No clip to add — pick one from the library first.');
  /*
   * An end card is never CROPPED to fit — that cuts the words off it — and on
   * black bars a 16:9 card on a 9:16 short looks like a mistake. So when the
   * short itself was cropped (or nothing was said), the card goes on its own
   * blurred colours, the way CapCut does it; an explicit 'bars' or 'blur'
   * choice is kept as it is.
   */
  if (fill == null || fillOpts(fill).mode === 'crop') fill = { mode: 'blur' };
  const main = await getInfo(ctx, input);
  const W = main.width || 1080, H = main.height || 1920;
  const fps = Math.max(1, Math.min(60, Math.round(main.fps || 30)));

  /*
   * Try the copy first (see appendByCopy). It conforms only the clip being
   * added and joins without touching the short, which on a 30-second short with
   * a 5-second outro took the pass from 26 seconds to about four — and left the
   * sermon's own frames byte for byte as they were encoded. Anything it is not
   * certain of falls through to the full re-encode below.
   */
  try {
    const fast = await appendByCopy(ctx, {
      input, output, list, position, fill, stillSec, main,
      tmpDir: path.dirname(output),
    });
    if (fast) { if (onProgress) onProgress(100); return output; }
  } catch (e) { /* the re-encode below is always able to do it */ }

  const inputs = position === 'start' ? [...list, { path: input, main: true }] : [{ path: input, main: true }, ...list];
  const infos = [];
  for (const i of inputs) {
    if (isStillImage(i.path)) {
      // ffprobe reports no duration for a photo — it is a single frame until we
      // say otherwise, so the entry carries its own on-screen time.
      const probe = await getInfo(ctx, i.path).catch(() => ({ width: 0, height: 0 }));
      const secs = Math.max(0.5, Number(i.durationSec) || Number(stillSec) || 4);
      infos.push({ width: probe.width, height: probe.height, hasAudio: false, durationSec: secs, still: true });
    } else infos.push(await getInfo(ctx, i.path));
  }

  const args = [];
  inputs.forEach((i, idx) => {
    if (infos[idx].still) args.push('-loop', '1', '-framerate', String(fps), '-t', infos[idx].durationSec.toFixed(2));
    args.push('-i', i.path);
  });
  let nextIdx = inputs.length;
  const aLabel = infos.map((info, idx) => {
    if (info.hasAudio) return `[${idx}:a]`;
    args.push('-f', 'lavfi', '-t', String(Math.max(0.1, info.durationSec || 1)),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    return `[${nextIdx++}:a]`;
  });

  let fc = '';
  const v = [], a = [];
  inputs.forEach((i, idx) => {
    // Anything that isn't already the main video's shape gets the chosen fill:
    // a 16:9 outro card or photo on the end of a 9:16 short is exactly the case
    // black bars look worst in, and where its own blurred colours look best.
    const chain = i.main
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`
      // 'bars' (letterbox) is what this always did — keep it as the default so an
      // outro that already looks right is never silently cropped instead.
      : fillChain(infos[idx].width, infos[idx].height, W, H, fill == null ? 'bars' : fill, `c${idx}`);
    const look = i.main ? '' : fxVideo(i.fx), vol = i.main || !infos[idx].hasAudio ? '' : fxAudio(i.fx);
    fc += `[${idx}:v]${look ? look + ',' : ''}${chain},fps=${fps},format=yuv420p[v${idx}];`;
    v.push(`[v${idx}]`);
    fc += `${aLabel[idx]}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${vol ? ',' + vol : ''}[a${idx}];`;
    a.push(`[a${idx}]`);
  });
  fc += v.map((x, idx) => x + a[idx]).join('') + `concat=n=${inputs.length}:v=1:a=1[v][a]`;

  args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', output);
  const total = infos.reduce((s, i) => s + (i.durationSec || 0), 0);
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress, totalDurationSec: total });
  return output;
}

// Changes whenever what getInfo reports changes, so a kept copy of an older
// shape is never handed back (see media-cache.json and the video:info handler).
const INFO_SHAPE = require('crypto').createHash('sha1').update(probeInfo.toString()).digest('hex').slice(0, 8);

module.exports = {
  PRESETS, QUALITY, DEFAULT_QUALITY, VOICE_SHARE, qualityDef, presetSize, sourceSize, upscaleFactor, outputFps,
  setExportPrefs, getExportPrefs, allExportPrefs, loadExportPrefs, RATE_CRF, FPS_CHOICES, TRANSITIONS, transitionOf,
  SFX, makeSfx, mixSounds, saveRecording,
  getInfo, INFO_SHAPE, trim, exportForPlatform, thumbnail,
  extractAudio, autoTrimSilence, merge, joinPieces, normalizePieces, addCaptions, exportShort, filmstrip, makeProxy, needsProxy, applyEdits,
  extractFrames, detectSceneCuts, exportShortReframed, exportShortFramed, attachThumbnail, waveform, stabilize, reverseClip, freezeFrame, hms, cutPlan,
  exportOverlayComposite, burnImageOverlays, burnCaptionTrack,
  TEXT_ANIMS, textAnimOf, textAnimTimes, textAnimScale, TEXT_RISE, textOverlaySteps,
  cleanMotion, motionExpr, motionAt, motionChain, MOTION_MAX_Z, keyOf, inPreviewLane, transparentPng, writeTrackFrames, burnCaptionFrames,
  cropFirstChain, fillChain,
  simplifyKeyframes, buildLerpExpr, isCleanEncode,
  detectSilences, mixMusic, appendClips, audioSample,
  // background noise removal + background-blur fill (pure, unit-tested)
  noiseReductionAf, studioVoiceAf, noiseStrength, measureNoiseFloor, denoiseFilter, NOISE_LEVELS,
  rnnoiseModelPath, voiceIsolationAf, withVoicePasses, ffPath, measureSeparation, renderVerifiedVoice,
  fillChain, fillOpts, FILL_MODES, isStillImage,
  // covering captions that arrived burned into the recording (pure, unit-tested)
  coverChain, withCover,
  // a clip's own look — Video quality on one clip or all (pure, unit-tested)
  LOOKS, clipFx, fxVideo, fxAudio,
};
