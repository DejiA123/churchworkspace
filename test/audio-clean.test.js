'use strict';
/*
 * BACKGROUND NOISE REMOVAL — measured on real audio, not described.
 *
 * The ask: "an option to remove background sound of the audio, just in case
 * there is a lot of background noise in a video, and I can choose how strong I
 * want it to be."
 *
 * Two things have to be true, and they pull against each other:
 *   1. each strength really removes MORE noise than the one below it, and
 *   2. none of them eat the voice.
 *
 * So this builds a file that has both, separately measurable: a "voice" of two
 * harmonics (220 Hz + 660 Hz) that speaks in 2-second bursts, over continuous
 * white noise. Between the bursts there is nothing but noise — measure the RMS
 * there and you have measured the room. During a burst, a Goertzel filter reads
 * the energy AT those two frequencies — measure that and you have measured the
 * voice, independently of how much noise is sitting on top of it.
 *
 * Then: noise must fall monotonically with strength, the voice must survive
 * every level, and the file must come out exactly as long as it went in (an
 * audio filter that shifts time would put every caption and every cut out of
 * sync — the one failure that would be worse than the noise).
 *
 *   node test/audio-clean.test.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const ff = require('../src/main/ffmpeg');

const ctx = { ffmpeg, ffprobe };
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const SR = 48000;
const DUR = 12;
const F1 = 220, F2 = 660;      // the "voice"
const CYCLE = 4;               // 2s of voice, then 2s of noise only

/** Decode any media to mono float32 at SR. */
function pcm(file) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}
function rms(p, fromSec, toSec) {
  const a = Math.max(0, Math.floor(fromSec * SR)), b = Math.min(p.length, Math.floor(toSec * SR));
  let s = 0; for (let i = a; i < b; i++) s += p[i] * p[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
/** Energy at exactly `hz` over [fromSec,toSec) — a Goertzel filter. */
function toneEnergy(p, hz, fromSec, toSec) {
  const a = Math.max(0, Math.floor(fromSec * SR)), b = Math.min(p.length, Math.floor(toSec * SR));
  const n = b - a; if (n < 64) return 0;
  const w = 2 * Math.PI * hz / SR, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { s0 = p[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / n;
}
/** Averages over the three voice bursts / the three noise-only gaps. */
const voiceWindows = [[0.3, 1.8], [4.3, 5.8], [8.3, 9.8]];
const noiseWindows = [[2.3, 3.8], [6.3, 7.8], [10.3, 11.8]];
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const noiseOf = (p) => avg(noiseWindows.map(([a, b]) => rms(p, a, b)));
const voiceOf = (p) => avg(voiceWindows.map(([a, b]) => toneEnergy(p, F1, a, b) + toneEnergy(p, F2, a, b)));
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

(async () => {
  const dir = path.join(os.tmpdir(), 'mw-audioclean-test');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'noisy.mp4');

  /* ---- a noisy "sermon": harmonic voice in bursts + constant white noise ---- */
  await ff.runFfmpeg(ffmpeg, [
    '-f', 'lavfi', '-i', `color=c=gray:s=320x180:d=${DUR}:r=15`,
    '-f', 'lavfi', '-i', `sine=frequency=${F1}:sample_rate=${SR}:duration=${DUR}`,
    '-f', 'lavfi', '-i', `sine=frequency=${F2}:sample_rate=${SR}:duration=${DUR}`,
    '-f', 'lavfi', '-i', `anoisesrc=color=white:amplitude=0.05:sample_rate=${SR}:duration=${DUR}`,
    '-filter_complex',
    `[1:a][2:a]amix=inputs=2:normalize=0,volume='if(lt(mod(t,${CYCLE}),2),0.8,0)':eval=frame[spk];`
    + `[spk][3:a]amix=inputs=2:normalize=0[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-f', 'matroska', '-y', src], {});

  const base = pcm(src);
  const n0 = noiseOf(base), v0 = voiceOf(base);
  check('the test file really is noisy (noise floor is audible)', db(n0) > -40, `${db(n0).toFixed(1)} dBFS between bursts`);
  check('the test file really has a voice', v0 > 0.02, `tone energy ${v0.toFixed(4)}`);

  /* ================= the pure filter builder ================= */
  check('"off" adds nothing to the graph', video.noiseReductionAf(0) === null && video.noiseReductionAf(null) === null && video.noiseReductionAf('off') === null);
  const levels = ['light', 'medium', 'strong', 'max'];
  for (const l of levels) {
    const af = video.noiseReductionAf(l);
    check(`"${l}" builds a chain with rumble + spectral removal`, !!af && af.includes('highpass') && af.includes('afftdn'), af ? af.slice(0, 58) + '…' : 'null');
  }
  check('a 0-100 number works as well as a name', video.noiseReductionAf(50) === video.noiseReductionAf(0.5));
  check('out-of-range values are clamped, not passed to ffmpeg', video.noiseReductionAf(400) === video.noiseReductionAf('max'));
  // noise TRACKING is the trap: it reads like the right idea and does nothing.
  check('afftdn noise-tracking (tn) is NOT used — measured, it removes 0.2 dB',
    !video.noiseReductionAf('max').includes('tn='), video.noiseReductionAf('max'));

  /* ================= the room measurement the strength depends on ========= */
  const floor = await video.measureNoiseFloor(ctx, src);
  check('the room tone is measured from the recording itself', floor != null && Math.abs(floor - db(n0)) < 4,
    `measured ${floor == null ? 'null' : floor.toFixed(1)} dB, true noise ${db(n0).toFixed(1)} dB`);
  const quiet = path.join(dir, 'quiet.wav');
  await ff.runFfmpeg(ffmpeg, ['-i', src, '-af', 'volume=0.1', '-c:a', 'pcm_s16le', '-y', quiet], {});
  const qFloor = await video.measureNoiseFloor(ctx, quiet);
  check('a QUIETER room measures ~20 dB lower (the number is not hard-coded)',
    qFloor != null && Math.abs((qFloor - floor) - (-20)) < 3, `${floor.toFixed(1)} dB -> ${qFloor.toFixed(1)} dB`);
  check('and the filter follows it: a quiet room gets a lower noise floor',
    video.noiseReductionAf('max', { floorDb: qFloor }) !== video.noiseReductionAf('max', { floorDb: floor }),
    `${video.noiseReductionAf('max', { floorDb: qFloor })} vs ${video.noiseReductionAf('max', { floorDb: floor })}`);

  /* ================= what each level actually does ================= */
  const results = [];
  for (const level of levels) {
    const out = path.join(dir, `clean-${level}.mkv`);
    const af = await video.denoiseFilter(ctx, { input: src, denoise: level });
    await ff.runFfmpeg(ffmpeg, ['-i', src, '-af', af, '-c:a', 'pcm_s16le', '-c:v', 'copy', '-y', out], {});
    const p = pcm(out);
    const n = noiseOf(p), v = voiceOf(p);
    results.push({ level, n, v, out, af });
    console.log(`     ${level.padEnd(7)} noise ${(20 * Math.log10(n / n0)).toFixed(1)} dB removed, voice kept ${(100 * v / v0).toFixed(0)}%   [${af}]`);
  }

  // "Light" is meant to be gentle, but it still has to DO something audible —
  // 6 dB is the point where a listener says "that's quieter", not "is it on?"
  for (const r of results) {
    check(`${r.level}: the background noise really is reduced (>= 6 dB)`, 20 * Math.log10(r.n / n0) <= -6,
      `${(20 * Math.log10(r.n / n0)).toFixed(1)} dB removed`);
  }
  for (let i = 1; i < results.length; i++) {
    check(`${results[i].level} removes MORE noise than ${results[i - 1].level}`,
      results[i].n < results[i - 1].n, `${db(results[i - 1].n).toFixed(1)} -> ${db(results[i].n).toFixed(1)} dB`);
  }
  // the voice survives every setting — this is the half that stops the feature
  // from being "make it quieter"
  for (const r of results) {
    check(`${r.level}: the VOICE survives (>=70% of its energy)`, r.v >= v0 * 0.7, `${(100 * r.v / v0).toFixed(0)}% kept`);
  }
  const gentlest = results[0], hardest = results[results.length - 1];
  check('every level treats the voice the same — strength only moves the NOISE',
    Math.abs(gentlest.v - hardest.v) / v0 < 0.05,
    `light ${(100 * gentlest.v / v0).toFixed(1)}% vs max ${(100 * hardest.v / v0).toFixed(1)}%`);
  check('maximum takes the room out properly (>= 30 dB down)', 20 * Math.log10(hardest.n / n0) <= -30,
    `${(20 * Math.log10(hardest.n / n0)).toFixed(1)} dB`);
  check('the four levels are meaningfully far apart (>= 5 dB between each)',
    results.every((r, i) => i === 0 || 20 * Math.log10(r.n / results[i - 1].n) <= -5),
    results.map((r) => (20 * Math.log10(r.n / n0)).toFixed(0) + 'dB').join(' / '));

  /* ================= timing: nothing may shift ================= */
  const srcInfo = await video.getInfo(ctx, src);
  for (const r of results) {
    const i = await video.getInfo(ctx, r.out);
    check(`${r.level}: the audio is not shifted or shortened (same length)`,
      Math.abs(i.durationSec - srcInfo.durationSec) < 0.05, `${srcInfo.durationSec.toFixed(3)}s -> ${i.durationSec.toFixed(3)}s`);
  }
  // and the voice bursts are still exactly where they were
  const pMax = pcm(hardest.out);
  // 0.12 is above the noise (0.05) and below the voice burst (~0.24), so this
  // finds the first WORD in both files — not the first noise sample, which the
  // cleaned version no longer has.
  const burstStart = (p) => { const thr = 0.15; for (let i = 0; i < p.length; i++) if (Math.abs(p[i]) > thr) return i / SR; return -1; };
  check('the first word still starts at the same moment (< 30ms drift)',
    Math.abs(burstStart(pMax) - burstStart(base)) < 0.03, `${burstStart(base).toFixed(3)}s -> ${burstStart(pMax).toFixed(3)}s`);

  /* ================= through the REAL export path =================
   * On a REAL voice. An export runs the voice cleaner (src/main/deepfilter.js),
   * a network trained on speech, and it rightly hears two steady tones as a hum
   * and takes them out with the room — the same reason studio-voice.test.js
   * stopped measuring tones. The chains above are still checked on the tones,
   * because they are the fallback and they run inline. */
  const real = path.join(dir, 'real-noisy.mp4');
  await ff.runFfmpeg(ffmpeg, [
    '-f', 'lavfi', '-i', `color=c=gray:s=320x180:d=${DUR}:r=15`,
    '-i', path.join(__dirname, 'fixtures', 'sermon-dry.flac'),
    '-f', 'lavfi', '-i', `anoisesrc=color=white:amplitude=0.05:sample_rate=${SR}:duration=${DUR}:seed=7`,
    '-filter_complex', `[1:a]aresample=${SR},atrim=0:${DUR},apad=whole_dur=${DUR}[v];[v][2:a]amix=inputs=2:duration=first:normalize=0[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '192k', '-t', String(DUR), '-y', real,
  ], {});
  // where the reading speaks and where it pauses, from the dry voice itself
  const dry = pcm(path.join(__dirname, 'fixtures', 'sermon-dry.flac')).subarray(0, DUR * SR);
  const tenths = Array.from({ length: DUR * 10 }, (_, i) => db(rms(dry, i / 10, (i + 1) / 10)));
  const loud = [...tenths].sort((a, b) => a - b)[Math.floor(tenths.length * 0.9)];
  const speaking = tenths.map((d, i) => (d > loud - 15 ? i : -1)).filter((i) => i >= 0);
  const pausing = tenths.map((d, i) => (d < loud - 45 ? i : -1)).filter((i) => i >= 0);
  const over = (p, idx) => Math.sqrt(avg(idx.map((i) => rms(p, i / 10, (i + 1) / 10) ** 2)));
  const pr = pcm(real);
  const rn0 = over(pr, pausing), rv0 = over(pr, speaking);

  const outShort = path.join(dir, 'short-clean.mp4');
  await video.exportShort(ctx, { input: real, startSec: 0, endSec: DUR, preset: 'reel-9x16', denoise: 'strong', output: outShort });
  const ps = pcm(outShort);
  check('exporting a short with noise removal ON really cleans it', over(ps, pausing) < rn0 * 0.5,
    `${db(rn0).toFixed(1)} -> ${db(over(ps, pausing)).toFixed(1)} dB in the pauses`);
  check('…and the voice is still there afterwards', over(ps, speaking) >= rv0 * 0.6,
    `${(100 * over(ps, speaking) / rv0).toFixed(0)}% of the speech kept`);
  const si = await video.getInfo(ctx, outShort);
  check('…and the short is the right length', Math.abs(si.durationSec - DUR) < 0.3, `${si.durationSec.toFixed(2)}s`);

  const outPlain = path.join(dir, 'short-plain.mp4');
  await video.exportShort(ctx, { input: real, startSec: 0, endSec: DUR, preset: 'reel-9x16', output: outPlain });
  check('CONTROL: with the option OFF the noise is left alone', over(pcm(outPlain), pausing) > rn0 * 0.7,
    `${db(over(pcm(outPlain), pausing)).toFixed(1)} dB vs original ${db(rn0).toFixed(1)} dB`);

  /* ---- the "hear the difference" sample the button plays ---- */
  const rawS = await video.audioSample(ctx, { input: src, startSec: 0, durationSec: 6, denoise: null, output: path.join(dir, 'listen-raw.m4a') });
  const cleanS = await video.audioSample(ctx, { input: src, startSec: 0, durationSec: 6, denoise: 'max', output: path.join(dir, 'listen-clean.m4a') });
  check('the A/B sample renders both versions', fs.existsSync(rawS) && fs.existsSync(cleanS));
  check('the A/B sample is audibly different (that is the point of the button)',
    noiseOf(pcm(cleanS)) < noiseOf(pcm(rawS)) * 0.6,
    `${db(noiseOf(pcm(rawS))).toFixed(1)} -> ${db(noiseOf(pcm(cleanS))).toFixed(1)} dB`);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
