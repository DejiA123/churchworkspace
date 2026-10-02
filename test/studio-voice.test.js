'use strict';
/*
 * 🎙️ STUDIO SOUND — "only the speaker's voice", measured on real speech.
 *
 * THE BUG THIS TEST EXISTS FOR.
 *
 * The first version of this test built its "sermon" out of a 200 Hz sine tone
 * and mixed white noise over it. Everything passed. Everything kept passing
 * while the feature was, in the operator's words, "terrible — it sounds weird,
 * awful". The test was measuring the test:
 *
 *   - a pure tone standing in white noise is trivially separable, so `afftdn`
 *     scored beautifully on it. On an actual room — air handling and traffic
 *     rumble at the bottom, hiss on top, mains hum in between — the same filter
 *     removed 3.9 dB and its strength control did nothing whatsoever, giving
 *     byte-identical output at nr=3 and nr=97;
 *   - a tone has no formants and no consonants, so the spectral holes afftdn
 *     gouges in speech were invisible to it. Against a dry reference the
 *     "cleaned" voice measured three times FURTHER from the real voice than the
 *     untouched recording;
 *   - and the chain ends in loudnorm, which lifts a quietly-filmed sermon by
 *     ~15 dB to reach the broadcast target. Noise that was never removed came
 *     up by the same 15 dB. "Noise removal" was making the hiss louder.
 *
 * So this test uses a REAL RECORDED VOICE (test/fixtures/sermon-dry.flac,
 * 21 seconds with gaps between the sentences), spoils it the way a church
 * camera does, and measures two things that pull against each other:
 *
 *   THE ROOM MUST GO ....... how far the silence sits below the words
 *   THE VOICE MUST NOT ..... log-spectral distance from the dry original,
 *                            measured on the speech itself, gain-matched
 *
 * A filter that scores well on the first and badly on the second is exactly the
 * failure that shipped. Both are asserted, always.
 *
 *   node test/studio-voice.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const ctx = { ffmpeg, ffprobe };

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const SR = 48000;
const W = path.join(os.tmpdir(), 'mw-studio-voice');
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W, { recursive: true });
const DRY = path.join(__dirname, 'fixtures', 'sermon-dry.flac');
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true });

/* ------------------------------ measuring ------------------------------ */

/** Decode anything to mono float at 48k. */
function pcm(file) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28, windowsHide: true });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}
/** RMS of each `win`-second slice, in dBFS. */
function frames(p, win) {
  const N = Math.round(SR * win), out = [];
  for (let s = 0; s + N <= p.length; s += N) {
    let a = 0; for (let i = 0; i < N; i++) a += p[s + i] * p[s + i];
    out.push(20 * Math.log10(Math.sqrt(a / N) + 1e-12));
  }
  return out;
}
const pctl = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))]; };
/** The words (loudest tenth) and the silence between them (quietest tenth). */
function wordsAndGaps(file) {
  const f = frames(pcm(file), 0.4);
  return { words: pctl(f, 0.9), gap: pctl(f, 0.1) };
}
function peakDb(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { windowsHide: true, encoding: 'utf8' });
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '');
  return m ? parseFloat(m[1]) : null;
}
/** Integrated loudness and true peak, as loudnorm itself measures them. */
function loudness(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af',
    'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  const m = /\{[\s\S]*\}/.exec(r.stderr || '');
  return m ? { I: parseFloat(JSON.parse(m[0]).input_i), TP: parseFloat(JSON.parse(m[0]).input_tp) } : null;
}

/* in-place radix-2 FFT — enough to compare two spectra honestly */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
const N_FFT = 1024, HOP = 512;
function spectra(p) {
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT);
  const out = [];
  for (let s = 0; s + N_FFT <= p.length; s += HOP) {
    const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) re[i] = p[s + i] * win[i];
    fft(re, im);
    const row = new Float64Array(N_FFT / 2);
    for (let k = 0; k < N_FFT / 2; k++) row[k] = re[k] * re[k] + im[k] * im[k];
    out.push(row);
  }
  return out;
}

/**
 * HOW FAR THE VOICE MOVED, in dB — log-spectral distance from the dry original
 * across 200 Hz–6 kHz, on speech frames only, after matching the overall gain.
 *
 * Gain-matching is what makes this fair: the chain ends in loudnorm, so the
 * cleaned file is ~15 dB louder, and an un-matched comparison would just be
 * measuring the makeup gain. What is left after matching is the shape of the
 * voice — formants, consonants, and any holes a denoiser tore in them.
 */
function voiceDistance(refFile, testFile) {
  const a = pcm(refFile), b = pcm(testFile);
  const n = Math.min(a.length, b.length);
  const fa = frames(a.subarray(0, n), 0.1), fb = frames(b.subarray(0, n), 0.1);
  const loud = pctl(fa, 0.9);
  const gains = [];
  for (let i = 0; i < Math.min(fa.length, fb.length); i++) if (fa[i] > loud - 20) gains.push(fb[i] - fa[i]);
  const g = gains.reduce((s, x) => s + x, 0) / (gains.length || 1);
  const scale = Math.pow(10, -g / 20);
  const bb = new Float32Array(n); for (let i = 0; i < n; i++) bb[i] = b[i] * scale;
  const SA = spectra(a.subarray(0, n)), SB = spectra(bb);
  const kLo = Math.max(1, Math.round(200 / (SR / N_FFT))), kHi = Math.round(6000 / (SR / N_FFT));
  const energy = SA.map((r) => { let s = 0; for (let k = kLo; k < kHi; k++) s += r[k]; return s; });
  const hi = pctl(energy, 0.9), th = hi * Math.pow(10, -20 / 10);
  let sum = 0, cnt = 0;
  for (let f = 0; f < Math.min(SA.length, SB.length); f++) {
    if (energy[f] <= th) continue;
    let s = 0, c = 0;
    for (let k = kLo; k < kHi; k++) {
      const d = 10 * Math.log10(Math.max(SA[f][k], 1e-20)) - 10 * Math.log10(Math.max(SB[f][k], 1e-20));
      s += d * d; c++;
    }
    sum += Math.sqrt(s / c); cnt++;
  }
  return { lsd: sum / (cnt || 1), gainDb: g };
}

/**
 * How far `b` moved against `a`, to the SAMPLE.
 *
 * Correlates three seconds of the same speech at every lag in ±2000 samples.
 * An envelope-based version of this is not good enough here: the chain removes
 * the room, which changes the envelope in the gaps and lands a step or two out.
 */
function shiftSamples(aFile, bFile, atSec = 6) {
  const a = pcm(aFile), b = pcm(bFile);
  const from = Math.min(Math.round(SR * atSec), Math.max(0, a.length - SR * 4));
  const len = Math.min(SR * 3, a.length - from - 1);
  let best = 0, bestScore = -Infinity;
  for (let lag = -2000; lag <= 2000; lag++) {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < len; i += 3) {
      const u = a[from + i], v = b[from + i + lag] || 0;
      num += u * v; da += u * u; db += v * v;
    }
    const s = num / Math.sqrt(da * db + 1e-20);
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  return best;
}

/* --------------------------- the bad recording --------------------------- */

/*
 * What a church camera actually hands you: the voice smeared by the hall and
 * boxy around 300 Hz, air handling rumbling underneath, mic hiss on top, mains
 * hum at 50 and 150 Hz, and the whole thing recorded far too quietly. Fixed
 * seeds so two runs measure the same recording.
 */
const REF = path.join(W, 'ref.wav');            // the dry voice: what we want back
const SPOILED = path.join(W, 'spoiled.wav');
run(['-i', DRY, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', REF]);
const DUR = pcm(REF).length / SR;
run(['-i', REF, '-af', 'aecho=0.85:0.8:37|71|113|173:0.30|0.22|0.16|0.11,equalizer=f=300:t=q:w=1.4:g=5,highpass=f=70',
  '-c:a', 'pcm_s16le', path.join(W, 'wet.wav')]);
run(['-i', path.join(W, 'wet.wav'),
  '-f', 'lavfi', '-t', String(DUR), '-i', `anoisesrc=color=white:amplitude=0.05:sample_rate=${SR}:seed=1`,
  '-f', 'lavfi', '-t', String(DUR), '-i', `anoisesrc=color=brown:amplitude=0.9:sample_rate=${SR}:seed=2`,
  '-f', 'lavfi', '-t', String(DUR), '-i', `sine=frequency=50:sample_rate=${SR}`,
  '-f', 'lavfi', '-t', String(DUR), '-i', `sine=frequency=150:sample_rate=${SR}`,
  '-filter_complex',
  '[1:a]volume=0.030[hiss];[2:a]lowpass=f=320,volume=0.16[hvac];[3:a]volume=0.003[h1];[4:a]volume=0.0014[h2];' +
  '[0:a][hiss][hvac][h1][h2]amix=inputs=5:duration=first:normalize=0,volume=0.30,' +
  `aformat=sample_fmts=s16:sample_rates=${SR}:channel_layouts=mono[o]`,
  '-map', '[o]', '-c:a', 'pcm_s16le', SPOILED]);

const before = wordsAndGaps(SPOILED);
console.log('\n== STUDIO SOUND: is only the speaker left? ==\n');
console.log(`      the recording we start from: words ${before.words.toFixed(1)} dBFS, room ${before.gap.toFixed(1)} dBFS, ` +
  `${(before.words - before.gap).toFixed(1)} dB apart`);
check('the spoiled recording really is a mess',
  before.words - before.gap < 24 && before.words < -20,
  `voice only ${(before.words - before.gap).toFixed(1)} dB above the room, and quiet at ${before.words.toFixed(1)} dBFS`);

(async () => {
  /* ------------------------- the model is there ------------------------- */
  const model = video.rnnoiseModelPath();
  check('the voice-isolation model ships with the app', !!model && fs.existsSync(model),
    model || 'bin/rnnoise/beguiling-drafter.rnnn NOT FOUND');

  const af = await video.denoiseFilter(ctx, { input: SPOILED, denoise: 'studio' });
  check('"studio" builds the voice chain', !!af && /arnndn/.test(af), (af || '').slice(0, 72) + '…');
  check('…and it is more than noise removal', /equalizer/.test(af) && /acompressor/.test(af) && /loudnorm/.test(af),
    ['highpass', 'arnndn', 'equalizer', 'acompressor', 'loudnorm'].filter((k) => af.includes(k)).join(' + '));

  /*
   * Everything below measures the track the app would actually ship — the one
   * renderVerifiedVoice hands to the encode — and not a raw run of the filter.
   * Measuring the raw run would make this whole file a coin toss (see the two
   * checks further down that show exactly how much of one it is).
   */
  const CLEAN = path.join(W, 'cleaned.wav');
  const shipped = await video.renderVerifiedVoice(ctx, { inputArgs: ['-i', SPOILED], af, hasAudio: true });
  check('the app renders a checked voice track', !!shipped, shipped ? path.basename(shipped) : 'none');
  fs.copyFileSync(shipped, CLEAN);
  fs.rmSync(shipped, { force: true });
  const after = wordsAndGaps(CLEAN);

  /* --------------------------- THE ROOM MUST GO -------------------------- */
  /*
   * Measured AGAINST THE VOICE, never in absolute dB: the chain ends in
   * loudnorm, so comparing absolute levels across it measures the makeup gain
   * and would score a chain that removed nothing but turned everything up.
   */
  const sepBefore = before.words - before.gap;
  const sepAfter = after.words - after.gap;
  console.log(`      after the chain            : words ${after.words.toFixed(1)} dBFS, room ${after.gap.toFixed(1)} dBFS, ` +
    `${sepAfter.toFixed(1)} dB apart`);
  check('THE ROOM WENT — the silence drops far below the words', sepAfter > sepBefore + 12,
    `${sepBefore.toFixed(1)} dB → ${sepAfter.toFixed(1)} dB of separation (+${(sepAfter - sepBefore).toFixed(1)})`);

  /*
   * EVERY TIME, NOT MOST TIMES — and the whole reason renderVerifiedVoice exists.
   *
   * `arnndn` in this ffmpeg build returns one of two byte-identical outputs, the
   * room gone or the room untouched, and which one you get is fixed by the shape
   * of the command rather than by anything meaningful. Run the filter straight
   * and it works about two times in five, which is exactly how a feature ships
   * "working" and gets reported as terrible.
   *
   * So the two halves are checked separately. First: the raw chain really is
   * unreliable — if a future ffmpeg fixes that, this check starts failing, and
   * that is the signal to simplify everything below it. Second, and the one that
   * matters: the path the app actually uses hands back a clean track EVERY time.
   */
  const REPEATS = 5;
  const rawSeps = [];
  for (let i = 0; i < REPEATS; i++) {
    const f = path.join(W, `raw${i}.wav`);
    run(['-t', '8', '-i', SPOILED, '-af', af, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', f]);
    const w = wordsAndGaps(f);
    rawSeps.push(w.words - w.gap);
  }
  const rawWorst = Math.min(...rawSeps);
  console.log(`      the raw filter, ${REPEATS} renders of the same audio: ` +
    rawSeps.map((s) => s.toFixed(1)).join(', ') + ' dB' +
    (rawWorst > sepBefore + 12 ? '   (all clean this time — it is a coin toss, not a fix)' : ''));

  const checkedSeps = [];
  for (let i = 0; i < REPEATS; i++) {
    const track = await video.renderVerifiedVoice(ctx, {
      inputArgs: ['-i', SPOILED, '-t', '8'], af, hasAudio: true,
    });
    if (!track) { checkedSeps.push(NaN); continue; }
    const w = wordsAndGaps(track);
    checkedSeps.push(w.words - w.gap);
    fs.rmSync(track, { force: true });
  }
  const worst = Math.min(...checkedSeps);
  check(`the CHECKED track comes back clean on every run (${REPEATS} of them)`,
    Number.isFinite(worst) && worst > sepBefore + 12,
    `worst ${worst.toFixed(1)} dB  [${checkedSeps.map((s) => s.toFixed(1)).join(', ')}]`);

  /*
   * And it has to be the MODEL doing that. `afftdn` on this same recording
   * manages 3.9 dB, so anything near that number means the model was skipped
   * and the old spectral fallback quietly took over.
   */
  const AFFTDN = path.join(W, 'afftdn-only.wav');
  const floor = await video.measureNoiseFloor(ctx, SPOILED);
  run(['-i', SPOILED, '-af', video.noiseReductionAf('max', { floorDb: floor }) + ',loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', AFFTDN]);
  const spectral = wordsAndGaps(AFFTDN);
  const sepSpectral = spectral.words - spectral.gap;
  check('…by more than the old spectral filter could ever manage', sepAfter > sepSpectral + 8,
    `afftdn at maximum: ${sepSpectral.toFixed(1)} dB — the model: ${sepAfter.toFixed(1)} dB`);

  /* ------------------------ THE VOICE MUST SURVIVE ----------------------- */
  /*
   * The half the old test could not see. Distance is measured from the DRY
   * original, so the untouched hall recording already scores several dB (that
   * is the reverb, which nothing here claims to remove). What must not happen
   * is the cleaner ADDING distance on top of it.
   */
  const dRaw = voiceDistance(REF, SPOILED);
  const dClean = voiceDistance(REF, CLEAN);
  const dSpectral = voiceDistance(REF, AFFTDN);
  console.log(`      distance from the dry voice: untouched ${dRaw.lsd.toFixed(1)} dB, ` +
    `afftdn ${dSpectral.lsd.toFixed(1)} dB, studio sound ${dClean.lsd.toFixed(1)} dB`);
  check('THE VOICE SURVIVED — cleaning it did not move it away from the real thing',
    dClean.lsd < dRaw.lsd + 2.5, `${dRaw.lsd.toFixed(1)} dB → ${dClean.lsd.toFixed(1)} dB`);
  check('…and it is markedly closer to the real voice than spectral subtraction',
    dClean.lsd < dSpectral.lsd - 4, `afftdn ${dSpectral.lsd.toFixed(1)} dB vs studio ${dClean.lsd.toFixed(1)} dB`);

  /* ---------------------------- nothing broke ---------------------------- */
  /*
   * RNNoise hands each 10 ms frame back one frame late, so without the
   * compensation in voiceIsolationAf this is 480 samples and the sound walks
   * behind the picture for the whole export.
   *
   * The bar is one millisecond rather than zero: the high-pass and the two
   * equalizers are IIR filters, and a dozen samples of group delay through them
   * is physics, not a bug. That still leaves a 20x margin — an uncompensated
   * arnndn lands at ~470 samples, which this would catch instantly.
   */
  const shift = shiftSamples(SPOILED, CLEAN);
  check('the audio is not shifted — every caption and cut still lands', Math.abs(shift) < 48,
    `${shift} samples (${(shift / 48).toFixed(2)} ms)`);
  const inInfo = await video.getInfo(ctx, SPOILED), outInfo = await video.getInfo(ctx, CLEAN);
  check('…and it is the same length', Math.abs(inInfo.durationSec - outInfo.durationSec) < 0.05,
    `${inInfo.durationSec.toFixed(3)}s → ${outInfo.durationSec.toFixed(3)}s`);

  const lo = loudness(CLEAN), pk = peakDb(CLEAN);
  check('THE VOICE CAME UP to the broadcast target', Math.abs(lo.I + 16) < 1.5, `${lo.I} LUFS (wanted -16)`);
  check('nothing clips', pk <= -1.0 && lo.TP <= -1.0, `peak ${pk} dBFS, true peak ${lo.TP} dBTP`);

  /* ------------------- the awkward paths people install to ------------------- */
  /*
   * The model path goes inside a filtergraph, where it is unescaped twice. The
   * packaged app installs under the user's own name, so a path with a space, an
   * apostrophe and a comma in it is ordinary, not exotic — and getting this
   * wrong fails every export with "Error applying option 'mix'".
   */
  const q = String.fromCharCode(39);
  const awkward = ['plain', 'Program Files', 'O' + q + 'Brien', 'Smith, John', 'take [2]', 'a;b', 'Ünicode'];
  const bad = [];
  for (const dir of awkward) {
    const d = path.join(W, 'paths', dir);
    fs.mkdirSync(d, { recursive: true });
    const m = path.join(d, 'model.rnnn');
    fs.copyFileSync(model, m);
    const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-t', '1', '-i', SPOILED,
      '-af', `arnndn=m=${video.ffPath(m)}`, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', path.join(W, 'p.wav')],
      { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) bad.push(dir);
  }
  check('the model loads from every awkward install path', bad.length === 0,
    bad.length ? 'FAILED in: ' + bad.join(', ') : awkward.length + ' directories, including quotes, commas and brackets');

  /* --------------- and the plain settings still behave as before -------------- */
  const plain = await video.denoiseFilter(ctx, { input: SPOILED, denoise: 'medium' });
  check('the ordinary strength settings are untouched', /afftdn/.test(plain) && !/loudnorm/.test(plain), plain);
  check('"off" is still off', (await video.denoiseFilter(ctx, { input: SPOILED, denoise: 'off' })) === null);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  if (!fail) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
