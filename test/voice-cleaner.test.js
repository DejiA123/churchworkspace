'use strict';
/*
 * 🎙️ THE VOICE CLEANER — "it is nasty, not clean: a low-quality sound, a
 * squeak thing."
 *
 * Studio sound and Remove background noise now run on DeepFilterNet
 * (src/main/deepfilter.js). This holds it to the two complaints, on the real
 * recorded voice in test/fixtures, dirtied the way a church camera dirties it:
 *
 *   THE SQUEAK ........ spectral subtraction leaves the room as short chirps in
 *                       the pauses ("musical noise"): isolated peaks standing
 *                       12 dB over everything around them. Counted, per level.
 *   LOW QUALITY ....... the top of the voice (4-12 kHz, where the consonants
 *                       and the air are) must not go with the hiss; and the
 *                       voice must not move away from the dry original.
 *
 * Plus what any audio change here has to keep: the room actually goes, every
 * level removes at least as much as the one below, the track is the same
 * length to the sample and does not move against the picture, the same input
 * gives the same output every time, and a long recording split across the
 * cores joins without a seam.
 *
 * (The numbers that chose the levels are PESQ/STOI, measured outside this
 * test — see the table at the top of deepfilter.js.)
 *
 *   npm run test:voiceclean
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const deepfilter = require('../src/main/deepfilter');
const ctx = { ffmpeg, ffprobe };

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

if (!deepfilter.binPath()) {
  console.log('\n  SKIP — no voice cleaner on this machine. Run: node scripts/fetch-deepfilter.js\n');
  process.exit(0);
}

const SR = 48000;
const W = path.join(os.tmpdir(), 'mw-voice-cleaner');
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W, { recursive: true });
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true });
function pcm(file) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28, windowsHide: true });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const dB = (x) => 10 * Math.log10(x + 1e-20);

/* ------------------------------ an STFT ------------------------------ */
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
        const a = i + k, b = a + len / 2;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
const NF = 1024, HOP = 256, HZ = SR / NF;
function stft(p) {
  const win = new Float64Array(NF).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF));
  const out = [];
  for (let s = 0; s + NF <= p.length; s += HOP) {
    const re = new Float64Array(NF), im = new Float64Array(NF);
    for (let i = 0; i < NF; i++) re[i] = p[s + i] * win[i];
    fft(re, im);
    const row = new Float64Array(NF / 2);
    for (let k = 0; k < NF / 2; k++) row[k] = re[k] * re[k] + im[k] * im[k];
    out.push(row);
  }
  return out;
}
const bandSum = (row, lo, hi) => { let s = 0; for (let k = Math.round(lo / HZ); k < Math.round(hi / HZ); k++) s += row[k]; return s; };

/* ------------------------- the dry voice's map ------------------------- */
const DRY = path.join(__dirname, 'fixtures', 'sermon-dry.flac');
const REF = path.join(W, 'ref.wav');
run(['-i', DRY, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', REF]);
const ref = pcm(REF);
const RS = stft(ref);
const refE = RS.map((r) => dB(bandSum(r, 300, 8000)));
const top = [...refE].sort((a, b) => a - b)[Math.floor(refE.length * 0.9)];
const SPEECH = refE.map((e) => e > top - 20);   // frames where the reading speaks
const PAUSE = refE.map((e) => e < top - 45);    // frames where the dry voice is silent

/** What a listener would hear wrong with `file`, against the dry voice. */
function measure(file) {
  const x = pcm(file);
  const S = stft(x);
  const n = Math.min(S.length, RS.length);
  // gain-match on the speech, so a level change (loudnorm) is not counted
  let g = 0, c = 0;
  for (let f = 0; f < n; f++) if (SPEECH[f]) { g += dB(bandSum(S[f], 300, 8000)) - refE[f]; c++; }
  g /= c || 1;
  const k = Math.pow(10, -g / 10);
  // the room: the pauses against the speech
  let ps = 0, pc = 0, ss = 0, sc = 0;
  for (let f = 0; f < n; f++) {
    const e = bandSum(S[f], 300, 8000) * k;
    if (PAUSE[f]) { ps += e; pc++; } else if (SPEECH[f]) { ss += e; sc++; }
  }
  const room = dB(ps / pc) - dB(ss / sc);
  // the top end: 4-12 kHz against 0.3-4 kHz on the speech, relative to the dry voice
  const tilt = (SS, rows) => { let h = 0, l = 0; for (const f of rows) { h += bandSum(SS[f], 4000, 12000); l += bandSum(SS[f], 300, 4000); } return dB(h) - dB(l); };
  const sp = []; for (let f = 0; f < n; f++) if (SPEECH[f]) sp.push(f);
  const topEnd = tilt(S, sp) - tilt(RS, sp);
  // the squeak: in the pauses, points standing 12 dB over the median of their
  // neighbourhood (5 bins x 7 frames) — the chirps of musical noise
  const k0 = Math.round(300 / HZ), k1 = Math.round(8000 / HZ);
  let spikes = 0, pts = 0;
  const nb = [];
  for (let f = 3; f < n - 3; f++) {
    if (!PAUSE[f]) continue;
    for (let b = k0 + 2; b < k1 - 2; b++) {
      nb.length = 0;
      for (let df = -3; df <= 3; df++) for (let db2 = -2; db2 <= 2; db2++) nb.push(S[f + df][b + db2]);
      nb.sort((u, v) => u - v);
      if (dB(S[f][b]) - dB(nb[17]) > 12) spikes++;
      pts++;
    }
  }
  return { room, topEnd, squeak: 100 * spikes / (pts || 1), samples: x.length };
}

/* ------------------------- the dirty recording ------------------------- */
const DUR = ref.length / SR;
const SPOILED = path.join(W, 'spoiled.wav');
run(['-i', REF, '-af', 'aecho=0.85:0.8:37|71|113|173:0.30|0.22|0.16|0.11,equalizer=f=300:t=q:w=1.4:g=5,highpass=f=70',
  '-c:a', 'pcm_s16le', path.join(W, 'wet.wav')]);
run(['-i', path.join(W, 'wet.wav'),
  '-f', 'lavfi', '-t', String(DUR), '-i', `anoisesrc=color=white:amplitude=0.05:sample_rate=${SR}:seed=1`,
  '-f', 'lavfi', '-t', String(DUR), '-i', `anoisesrc=color=brown:amplitude=0.9:sample_rate=${SR}:seed=2`,
  '-f', 'lavfi', '-t', String(DUR), '-i', `sine=frequency=50:sample_rate=${SR}`,
  '-filter_complex',
  '[1:a]volume=0.030[hiss];[2:a]lowpass=f=320,volume=0.16[hvac];[3:a]volume=0.003[h1];' +
  '[0:a][hiss][hvac][h1]amix=inputs=4:duration=first:normalize=0,volume=0.30,' +
  `aformat=sample_fmts=s16:sample_rates=${SR}:channel_layouts=mono[o]`,
  '-map', '[o]', '-c:a', 'pcm_s16le', SPOILED]);

async function render(denoise, extra = {}) {
  const af = await video.denoiseFilter(ctx, { input: SPOILED, denoise });
  const t = extra.pieceSec
    ? await deepfilter.renderVoice(ctx, { inputArgs: ['-i', SPOILED], af, pieceSec: extra.pieceSec })
    : await video.renderVerifiedVoice(ctx, { inputArgs: ['-i', SPOILED], af, hasAudio: true });
  const out = path.join(W, `${denoise}${extra.pieceSec ? '-pieces' : ''}${extra.tag || ''}.wav`);
  fs.renameSync(t, out);
  return out;
}
function lag(aFile, bFile) {
  const a = pcm(aFile), b = pcm(bFile), from = 6 * SR, len = 3 * SR;
  let best = 0, bs = -Infinity;
  for (let L = -2000; L <= 2000; L++) {
    let s = 0; for (let i = 0; i < len; i += 3) s += a[from + i] * (b[from + i + L] || 0);
    if (s > bs) { bs = s; best = L; }
  }
  return best;
}

(async () => {
  console.log('\n== THE VOICE CLEANER: clean, not squeaky ==\n');
  const before = measure(SPOILED);
  console.log(`      untouched : room ${before.room.toFixed(1)} dB, top end ${before.topEnd.toFixed(1)} dB, squeak ${before.squeak.toFixed(2)}%`);

  // what Studio sound did on the server, where the RNNoise model never was:
  // the ffmpeg chain with afftdn in the clean-up's place
  const oldAf = video.studioVoiceAf('strong', { floorDb: await video.measureNoiseFloor(ctx, SPOILED) })
    .replace(/anull@dfn_studio,[\s\S]*?,anull@dfn_end/, video.noiseReductionAf('strong', { floorDb: await video.measureNoiseFloor(ctx, SPOILED) }));
  const OLD = path.join(W, 'old-server-studio.wav');
  run(['-i', SPOILED, '-af', oldAf, '-c:a', 'pcm_s16le', OLD]);
  const old = measure(OLD);
  console.log(`      the old server Studio sound: room ${old.room.toFixed(1)} dB, top end ${old.topEnd.toFixed(1)} dB, squeak ${old.squeak.toFixed(2)}%`);

  const levels = ['light', 'medium', 'strong', 'max', 'studio'];
  const got = {};
  for (const l of levels) {
    const f = await render(l);
    got[l] = { file: f, ...measure(f) };
    console.log(`      ${l.padEnd(9)} : room ${got[l].room.toFixed(1)} dB, top end ${got[l].topEnd.toFixed(1)} dB, squeak ${got[l].squeak.toFixed(2)}%`);
  }
  console.log('');

  for (const l of levels) {
    const r = got[l];
    check(`${l}: the room goes (at least 8 dB further down than untouched)`, r.room <= before.room - 8,
      `${before.room.toFixed(1)} → ${r.room.toFixed(1)} dB`);
    check(`${l}: NO SQUEAK — the pauses carry no more chirps than the untouched room`, r.squeak <= Math.max(0.5, before.squeak * 3),
      `${r.squeak.toFixed(2)}% (untouched ${before.squeak.toFixed(2)}%)`);
    check(`${l}: NOT MUFFLED — the top of the voice stays (within 3 dB of the dry voice)`, r.topEnd >= -3,
      `${r.topEnd.toFixed(1)} dB`);
    check(`${l}: the same length, to the sample`, r.samples === pcm(SPOILED).length, `${pcm(SPOILED).length} → ${r.samples}`);
  }
  for (let i = 1; i < 4; i++) {
    check(`${levels[i]} takes at least as much of the room as ${levels[i - 1]}`, got[levels[i]].room <= got[levels[i - 1]].room + 1,
      `${got[levels[i - 1]].room.toFixed(1)} → ${got[levels[i]].room.toFixed(1)} dB`);
  }
  check('Studio sound beats what the server used to do: more of the room gone', got.studio.room < old.room - 5,
    `${old.room.toFixed(1)} → ${got.studio.room.toFixed(1)} dB`);
  check('…and the top of the voice kept where the old chain lost it', got.studio.topEnd > old.topEnd + 3,
    `${old.topEnd.toFixed(1)} → ${got.studio.topEnd.toFixed(1)} dB`);
  const shift = lag(REF, got.studio.file);
  check('the voice does not move against the picture (< 1 ms)', Math.abs(shift) <= 48, `${shift} samples`);

  const again = await render('medium', { tag: '-again' });
  check('the same recording comes back the same, every time', md5(again) === md5(got.medium.file));

  /* a whole service is split across the cores — the joins must not show */
  const pieces = await render('medium', { pieceSec: 7 });
  const a = pcm(got.medium.file), b = pcm(pieces);
  check('in pieces: still the same length, to the sample', a.length === b.length, `${a.length} vs ${b.length}`);
  const level = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return s / Math.max(1, i1 - i0); };
  const sig = level(a, 0, a.length);
  for (const at of [7, 14]) {
    const i0 = at * SR - SR / 4, i1 = at * SR + SR / 4;
    let d = 0; for (let i = i0; i < i1; i++) d += (a[i] - b[i]) ** 2;
    d /= (i1 - i0);
    check(`the join at ${at} s is seamless (> 25 dB below the voice)`, dB(d) - dB(sig) < -25, `${(dB(d) - dB(sig)).toFixed(1)} dB`);
  }

  /* without the cleaner nothing changes: the markers are no-ops in ffmpeg */
  const chain = video.noiseReductionAf('medium', { floorDb: -45 });
  const P1 = path.join(W, 'plain.wav'), P2 = path.join(W, 'bracketed.wav');
  run(['-i', SPOILED, '-af', chain, '-c:a', 'pcm_s16le', P1]);
  run(['-i', SPOILED, '-af', deepfilter.bracket('medium', chain), '-c:a', 'pcm_s16le', P2]);
  check('the fallback chain runs exactly as before where the cleaner is not used', md5(P1) === md5(P2));

  /* ===================== THROUGH THE REAL EXPORTS =====================
   * Found by a review before this shipped: the level depended on the route,
   * a short with closed gaps fell back to the old chain, face-tracked shorts
   * never reached the cleaner at all, and audio starting after the picture
   * drifted. Each export below is watched: did the cleaner make its sound, and
   * did any encode still carry the old clean-up inline? */
  console.log('\n== …through the exports ==\n');
  const ffm = require('../src/main/ffmpeg');
  const seen = { cleaned: 0, inline: 0 };
  const realRender = deepfilter.renderVoice, realRun = ffm.runFfmpeg;
  deepfilter.renderVoice = async (...a) => { const v = await realRender(...a); if (v) seen.cleaned++; return v; };
  ffm.runFfmpeg = (bin, args, o) => { if (args.some((x) => /afftdn|arnndn/.test(String(x)))) seen.inline++; return realRun(bin, args, o); };
  const watch = async (fn) => { seen.cleaned = 0; seen.inline = 0; await fn(); return { ...seen }; };

  /* Read the channels AS THEY ARE: ffmpeg's -ac 1 folds a stereo AAC track to
   * one channel by SUMMING at 0.707 each, which reads an untouched dual-mono
   * export 3 dB hot (an export peaking at -1 dBFS "peaked" at +2). */
  const peakOf = (f) => {
    const b = execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-vn', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
    const p = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
    let m = 0; for (const v of p) m = Math.max(m, Math.abs(v)); return m;
  };
  /** How loud the voice is: EBU R128 integrated loudness (gated, so the pauses do not count), of the first channel. */
  const speechDb = (f) => {
    const r = require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', f, '-vn', '-af', 'pan=mono|c0=c0,ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' });
    const tail = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
    return parseFloat((/I:\s*(-?[\d.]+) LUFS/.exec(tail) || [0, 'NaN'])[1]);
  };
  // a loud stereo recording (voice peaking at -1 dBFS, the same on both sides), and a mono one
  const vol = execFileSync(ffmpeg, ['-hide_banner', '-i', SPOILED, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const mkVid = (out, aChain) => run(['-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${DUR.toFixed(2)}`, '-i', SPOILED,
    '-filter_complex', `[1:a]${aChain}[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '256k', '-shortest', out]);
  const peakNow = (() => { const r = require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-i', SPOILED, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }); return parseFloat((/max_volume:\s*(-?[\d.]+)/.exec(r.stderr) || [0, '0'])[1]); })();
  void vol;
  const LOUD = path.join(W, 'loud-stereo.mp4'), MONO = path.join(W, 'quiet-mono.mp4');
  mkVid(LOUD, `volume=${(-1 - peakNow).toFixed(2)}dB,pan=stereo|c0=c0|c1=c0`);
  mkVid(MONO, 'anull');
  const out = (n) => path.join(W, n + '.mp4');

  for (const [name, src] of [['loud stereo', LOUD], ['mono', MONO]]) {
    // the two kinds of route: a clip (-ss … -t) and the whole video (-i)
    await video.exportShort(ctx, { input: src, startSec: 0, endSec: DUR, preset: 'reel-9x16', output: out('plain-clip') });
    const s1 = await watch(() => video.exportShort(ctx, { input: src, startSec: 0, endSec: DUR, preset: 'reel-9x16', denoise: 'light', output: out('clean-clip') }));
    await video.exportForPlatform(ctx, { input: src, preset: 'reel-9x16', output: out('plain-whole') });
    const s2 = await watch(() => video.exportForPlatform(ctx, { input: src, preset: 'reel-9x16', denoise: 'light', output: out('clean-whole') }));
    for (const [route, a, b, st] of [['a clip', 'plain-clip', 'clean-clip', s1], ['the whole video', 'plain-whole', 'clean-whole', s2]]) {
      const d = speechDb(out(b)) - speechDb(out(a));
      check(`${name}, ${route}: cleaned by the network`, st.cleaned === 1 && st.inline === 0, JSON.stringify(st));
      check(`${name}, ${route}: the voice keeps its level (within 1.5 dB)`, Math.abs(d) <= 1.5, `${d >= 0 ? '+' : ''}${d.toFixed(2)} dB`);
      check(`${name}, ${route}: nothing clips`, peakOf(out(b)) < 0.999, `peak ${(20 * Math.log10(peakOf(out(b)))).toFixed(2)} dBFS`);
    }
  }

  /*
   * THE BAR MOVES WHILE THE VOICE IS CLEANED. A 10:32 export sat on 73% for
   * minutes on the server: the voice render reported nothing, the studio's
   * bar crept ahead on its own and parked. The voice now owns the first slice
   * of the export's progress and the picture the rest, so the numbers start
   * low, pass through the voice's slice, and only ever go up.
   */
  {
    const seenPct = [];
    await video.exportShort(ctx, { input: LOUD, startSec: 0, endSec: DUR, preset: 'reel-9x16', denoise: 'studio', output: out('bar-clip'),
      onProgress: (p) => seenPct.push(p) });
    const inVoice = seenPct.filter((p) => p > 0 && p < video.VOICE_SHARE);
    check('the export\'s bar moves while the voice is being cleaned (before the picture starts)', inVoice.length >= 3,
      `${inVoice.length} steps under ${video.VOICE_SHARE}%: ${seenPct.slice(0, 12).join(', ')}…`);
    check('…the picture then carries it the rest of the way', seenPct.some((p) => p >= 90), `last ${seenPct[seenPct.length - 1]}`);
    const back = seenPct.findIndex((p, i) => i > 0 && p < seenPct[i - 1] && p < video.VOICE_SHARE);
    check('…and it never goes back into the voice\'s slice once past it', back < 0, back < 0 ? '' : `at step ${back}: ${seenPct.slice(Math.max(0, back - 3), back + 2).join(', ')}`);
  }

  // a short with a pause closed (two pieces joined) — a cut plan
  const sCut = await watch(() => video.exportShort(ctx, { input: LOUD, startSec: 1, endSec: 17, preset: 'reel-9x16', denoise: 'light',
    pieces: [{ start: 1, end: 8 }, { start: 11, end: 17 }], output: out('clean-cut') }));
  check('a short with a gap closed is cleaned by the network, not the old chain', sCut.cleaned === 1 && sCut.inline === 0, JSON.stringify(sCut));
  const cutLen = (await video.getInfo(ctx, out('clean-cut'))).durationSec;
  check('…and it is the joined length', Math.abs(cutLen - 13) < 0.2, `${cutLen.toFixed(2)} s`);

  // a face-tracked short whose speaker walks past the frame edge (the padded path)
  const sRf = await watch(() => video.exportShortReframed(ctx, { input: LOUD, startSec: 0, endSec: 10, preset: 'reel-9x16', denoise: 'light',
    keyframes: [{ t: 0, x: -60 }, { t: 9, x: 980 }], output: out('clean-reframed') }));
  check('a face-tracked short (walking out of frame) is cleaned by the network', sRf.cleaned >= 1 && sRf.inline === 0, JSON.stringify(sRf));
  const rfInfo = await video.getInfo(ctx, out('clean-reframed'));
  check('…with its sound and its length', rfInfo.hasAudio && Math.abs(rfInfo.durationSec - 10) < 0.2, `${rfInfo.durationSec.toFixed(2)} s, audio ${rfInfo.hasAudio}`);

  // sound that starts after the picture (a capture box's file): still in sync
  const LATE = path.join(W, 'late-audio.mp4');
  run(['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${(DUR + 0.5).toFixed(2)}`, '-itsoffset', '0.478', '-i', SPOILED,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', LATE]);
  await video.exportForPlatform(ctx, { input: LATE, preset: 'reel-9x16', output: out('late-plain') });
  await video.exportForPlatform(ctx, { input: LATE, preset: 'reel-9x16', denoise: 'medium', output: out('late-clean') });
  // read both on the picture's clock (first_pts=0 honours where the sound starts)
  const onClock = (f) => { const o = path.join(W, path.basename(f) + '.clock.wav'); run(['-i', f, '-vn', '-af', 'aresample=first_pts=0', '-ac', '1', '-ar', String(SR), o]); return o; };
  const late = lag(onClock(out('late-plain')), onClock(out('late-clean')));
  check('sound that starts after the picture stays in sync (< 2 ms)', Math.abs(late) <= 96, `${late} samples (${(late / 48).toFixed(1)} ms)`);
  deepfilter.renderVoice = realRender; ffm.runFfmpeg = realRun;

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
