'use strict';
/*
 * DOES THE BROADCAST CARRY EXACTLY ONE SECOND OF SOUND PER SECOND OF REAL TIME?
 *
 * "It sounds fine, then a few minutes in it crackles — on YouTube." Taken off
 * YouTube from a real service (2026-09-25) the crackle was ~18 splices a second,
 * every one locked to a 64 ms grid (three AAC frames), the grid itself 1214 ppm
 * short: YouTube was DISCARDING 0.12% of the sound at the frame joins.
 *
 * The church's sound card ran 0.12% fast — 48 058 samples per real second. Two
 * repairs were tried before the right one, and this file exists so neither can
 * come back:
 *
 *   - Up to v2.74 the capture stamped the sound on the system clock but kept
 *     every sample, so the stream CLAIMED less time than the sound it carried.
 *   - v2.75.0 stamped the sound by its samples and ran the picture at the
 *     card's rate: consistent, but the whole broadcast then ran 0.12% faster
 *     than real time, and a live platform, which plays out in real time, cut
 *     the same 0.12% back out. "Exactly the same issue."
 *
 * What a live stream needs: one second of sound AND one second of picture per
 * second of REAL time, timestamps that say so, and every AAC frame exactly one
 * frame after the last. So the card's sound is resampled onto real time before
 * it is encoded (capture-engine.js, "THE SOUND IS PUT ON REAL TIME").
 *
 * This drives the REAL capture-engine.js in Node under a simulated clock,
 * against simulated sound cards exactly as wrong as the church's — ten minutes
 * of broadcast in seconds, deterministically — with a real tone going through
 * so the resampling can be heard as well as counted. Asserted for cards 1214
 * ppm fast, 300 fast, 300 slow and exact:
 *   1. every AAC frame is stamped exactly 1024 samples after the one before;
 *   2. the sound's timeline spans exactly the sound it carries;
 *   3. the SOUND advances at real time (one second per second of the clock);
 *   4. the PICTURE advances at real time;
 *   5. so the gap between them stops growing, and stays inside lip-sync;
 *   6. and the tone comes out of the correction clean, start to finish.
 *
 *   npm run test:captureclock        (MW_ENGINE=<path> runs another copy of
 *                                     the engine, e.g. a shipped app.asar's)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE = process.env.MW_ENGINE || path.join(__dirname, '..', 'src', 'renderer', 'capture-engine.js');
const SR = 48000, FPS = 30, AAC = 1024, CHUNK = 4800;   // the capture worklet posts 100 ms at a time
const RUN_S = Number(process.env.MW_RUN_S || 600);
const TONE = 997;                                       // Hz, at the CARD's rate

let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

/** Deterministic pseudo-random delivery delays. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** Least-squares line: { slope, at(x) }. */
function fit(xs, ys) {
  const n = xs.length; let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = num / den;
  return { slope, at: (x) => my + slope * (x - mx) };
}

/** THD+N (dB) of one window against a sine of free frequency (±1%). */
function thdN(x, s, W, f0) {
  const one = (f) => {
    const w = 2 * Math.PI * f / SR;
    let ss = 0, sc = 0, cc = 0, ys = 0, yc = 0, yy = 0;
    for (let i = 0; i < W; i++) { const y = x[s + i], si = Math.sin(w * i), co = Math.cos(w * i); ss += si * si; sc += si * co; cc += co * co; ys += y * si; yc += y * co; yy += y * y; }
    const det = ss * cc - sc * sc;
    const a = (ys * cc - yc * sc) / det, b = (yc * ss - ys * sc) / det;
    return { res: Math.max(1e-20, yy - (a * ys + b * yc)), yy };
  };
  let lo = f0 * 0.99, hi = f0 * 1.01, best = lo, bestR = Infinity;
  for (let k = 0; k <= 40; k++) { const f = lo + (hi - lo) * k / 40; const r = one(f).res; if (r < bestR) { bestR = r; best = f; } }
  let a = best - (hi - lo) / 40, c = best + (hi - lo) / 40;
  for (let it = 0; it < 30; it++) { const m1 = a + (c - a) * 0.382, m2 = a + (c - a) * 0.618; if (one(m1).res < one(m2).res) c = m2; else a = m1; }
  const r = one((a + c) / 2);
  return 10 * Math.log10(r.res / r.yy);
}

async function runCard(ppm, seed) {
  /* ---------------- a fake clock and fake timers ---------------- */
  let now = 1000;                 // ms on the worker's performance.now()
  let timerSeq = 0;
  const timers = new Map();       // id -> {at, every, fn}
  const setT = (fn, ms, every) => { const id = ++timerSeq; timers.set(id, { at: now + Math.max(1, ms || 0), every, fn }); return id; };
  const runTimers = () => {
    for (;;) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= now && (!due || t.at < due[1].at)) due = [id, t];
      if (!due) return;
      const [id, t] = due;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
    }
  };

  /* ---------------- WebCodecs + muxer, recorded ---------------- */
  const audioTs = [], audioAt = [], videoTs = [], videoAt = [];
  const encIn = [];                                  // {now, ts} of each buffer handed to the AAC encoder
  const heard = new Float32Array(SR * (RUN_S + 10)); // what the encoder was given, left channel
  let heardN = 0;
  class VideoFrame { constructor(src, init) { this.timestamp = (init && init.timestamp != null) ? init.timestamp : src.timestamp; this.duration = init && init.duration; } close() {} }
  class AudioData {
    constructor(o) { this.timestamp = o.timestamp; this.numberOfFrames = o.numberOfFrames; this.data = o.data; }
    close() {}
  }
  class VideoEncoder {
    constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.encodeQueueSize = 0; }
    configure() { this.state = 'configured'; }
    encode(f, o) {
      this.encodeQueueSize++;
      const ts = f.timestamp, dur = f.duration, key = !!(o && o.keyFrame);
      setT(() => { this.encodeQueueSize--; this.output({ timestamp: ts, duration: dur, type: key ? 'key' : 'delta', byteLength: 64, copyTo() {} }, {}); }, 4);
    }
    async flush() {} close() { this.state = 'closed'; }
  }
  class AudioEncoder {
    constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.held = 0; this.pos = 0; }
    configure() { this.state = 'configured'; }
    encode(ad) {
      encIn.push({ now, ts: ad.timestamp });
      const n = ad.numberOfFrames;
      if (ad.data && heardN + n <= heard.length) { heard.set(ad.data.subarray(0, n), heardN); heardN += n; }
      // An AAC encoder hands back one 1024-sample frame per 1024 samples in,
      // stamped by counting — which is exactly why the engine re-places them.
      this.held += n;
      while (this.held >= AAC) {
        this.held -= AAC;
        const ts = Math.round((this.pos / SR) * 1e6); this.pos += AAC;
        setT(() => this.output({ timestamp: ts, duration: Math.round((AAC / SR) * 1e6), byteLength: 400 }, {}), 1);
      }
    }
    async flush() {} close() { this.state = 'closed'; }
  }
  const Mp4Muxer = {
    StreamTarget: class { constructor(o) { this.o = o; } },
    Muxer: class {
      addAudioChunk(c, m, ts) { audioTs.push(ts); audioAt.push(now); }
      addVideoChunk(c, m, ts) { videoTs.push(ts); videoAt.push(now - 4); }   // paced 4 ms earlier (the encoder delay)
      addVideoChunkRaw(b, type, ts) { videoTs.push(ts); videoAt.push(now - 4); }
      finalize() {}
    },
  };

  /* ---------------- the program canvas, as a stream ---------------- */
  const vq = [], waiters = [];
  const video = { getReader: () => ({
    read: () => (vq.length ? Promise.resolve({ value: vq.shift(), done: false }) : new Promise((r) => waiters.push(r))),
    cancel: async () => {},
  }) };
  const pushFrame = (f) => { const w = waiters.shift(); if (w) w({ value: f, done: false }); else vq.push(f); };

  const sandbox = {
    performance: { now: () => now },
    setInterval: (fn, ms) => setT(fn, ms, Math.max(1, ms)),
    setTimeout: (fn, ms) => setT(fn, ms, 0),
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
    VideoFrame, AudioData, VideoEncoder, AudioEncoder, Mp4Muxer,
    Float32Array, Math, Promise, Error, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ENGINE, 'utf-8'), sandbox, { filename: 'capture-engine.js' });

  const eng = sandbox.CaptureEngine.create({
    cfg: { width: 1280, height: 720, fps: FPS, videoKbps: 2500, audioKbps: 160, codec: 'avc1.4d401f', sampleRate: SR, padKbps: 0, pacerLeadFrames: 2.5 },
    video, fromWorklet: true, onChunk: () => {}, onFail: (e) => { throw e; },
  });

  /* ---------------- run the service ---------------- */
  const R = rng(seed);
  const t0 = now;
  const cardRate = SR * (1 + ppm * 1e-6);      // samples the card really makes per system second
  let made = 0, posted = 0;                    // samples produced / posted by the capture worklet
  const inbox = [];                            // audio messages in flight to the worker
  let nextFrameAt = t0 + 5, canvasTs = 7777e3; // canvas timestamps: their own clock, same rate as ours
  const dph = 2 * Math.PI * TONE / SR;         // the tone, in the CARD's samples
  const endAt = t0 + RUN_S * 1000;
  let maxStep = 0;
  for (; now < endAt; now += 1) {
    made = Math.floor(((now - t0) / 1000) * cardRate);
    while (made - posted >= CHUNK) {
      // The worklet posts 100 ms; delivery to the worker takes 0.2-3 ms, and
      // now and then the worker is busy for tens of milliseconds.
      const delay = R() < 0.02 ? 10 + R() * 40 : 0.2 + R() * 2.8;
      const buf = new Float32Array(CHUNK * 2);
      for (let i = 0; i < CHUNK; i++) { const v = 0.5 * Math.sin(dph * ((posted + i) % 4800000)); buf[i] = v; buf[CHUNK + i] = v; }
      inbox.push({ at: now + delay, msg: { frames: CHUNK, startFrame: posted, buf: buf.buffer } });
      posted += CHUNK;
    }
    for (let i = 0; i < inbox.length;) {
      if (inbox[i].at <= now) { eng.feedAudio(inbox[i].msg); inbox.splice(i, 1); } else i++;
    }
    if (now >= nextFrameAt) {
      canvasTs += (1000 / FPS) * 1000;
      pushFrame(new VideoFrame({ timestamp: canvasTs }, {}));
      nextFrameAt += 1000 / FPS + (R() - 0.5) * 6;   // a compositor with a little jitter
    }
    runTimers();
    if (now % 1000 === 0) { const d = eng.clockDiag(); maxStep = Math.max(maxStep, Math.abs(d.resampleStepPpm || 0)); }
    await null; await null;                    // let the engine's promise chains run
  }
  const diag = eng.clockDiag();
  const rel = (arr) => arr.map((x) => (x - t0) / 1000);
  return { audioTs, audioAt: rel(audioAt), videoTs, videoAt: rel(videoAt), encIn: encIn.map((e) => ({ t: (e.now - t0) / 1000, ts: e.ts })), heard: heard.subarray(0, heardN), diag, maxStep };
}

function analyse(name, ppm, r) {
  const a = r.audioTs, v = r.videoTs;
  const frameUs = (AAC / SR) * 1e6;
  let bad = 0, worst = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1] - frameUs;
    if (Math.abs(d) > 2) bad++;
    if (Math.abs(d) > Math.abs(worst)) worst = d;
  }
  const claimed = (a[a.length - 1] - a[0]) / 1e6;
  const carried = ((a.length - 1) * AAC) / SR;
  const shortPpm = (1 - claimed / carried) * 1e6;

  // Each track's timestamps against the real time they were written at, over
  // the last five minutes: the slope is how fast that track's timeline runs.
  const lateFrom = RUN_S - 300;
  const pick = (ts, at) => { const xs = [], ys = []; for (let i = 0; i < ts.length; i++) if (at[i] >= lateFrom) { xs.push(at[i]); ys.push(ts[i] / 1e6); } return fit(xs, ys); };
  const enc = r.encIn.filter((e) => e.t >= lateFrom);
  const aSound = fit(enc.map((e) => e.t), enc.map((e) => e.ts / 1e6));
  const aLine = pick(a, r.audioAt);
  const vLine = pick(v, r.videoAt);
  const tA = lateFrom + 5, tB = RUN_S - 5;
  const gapA = (aLine.at(tA) - vLine.at(tA)) * 1000, gapB = (aLine.at(tB) - vLine.at(tB)) * 1000;

  // The tone, through the correction: from 5 s in to the end, every ~2 s.
  const W = 2048, h = r.heard;
  const thd = [];
  for (let s0 = SR * 5; s0 + W < h.length; s0 += SR * 2) thd.push(thdN(h, s0, W, TONE));
  thd.sort((p, q) => p - q);
  const tMed = thd[thd.length >> 1], tWorst = thd[thd.length - 1];

  console.log(`\n[${name}] card ${ppm >= 0 ? '+' : ''}${ppm} ppm against real time, ${RUN_S}s`);
  console.log(`    ${a.length} AAC frames, ${v.length} video frames · correction ${(r.diag.audioRatePpm || 0).toFixed(0)} ppm`
    + ` (card measured at ${r.diag.audioMeasPpm == null ? '—' : r.diag.audioMeasPpm.toFixed(0)} ppm) · largest step ${r.maxStep.toFixed(0)} ppm`);
  check(bad === 0, 'every AAC frame is stamped exactly 1024 samples after the one before',
    `${bad} of ${a.length - 1} joins off by >2 µs (worst ${worst.toFixed(1)} µs)`);
  check(Math.abs(shortPpm) < 1, 'the sound\'s timeline spans exactly the sound it carries (nothing for a platform to cut)',
    `timestamps claim ${claimed.toFixed(3)} s for ${carried.toFixed(3)} s of sound (${shortPpm.toFixed(0)} ppm short)`);
  check(Math.abs(aSound.slope - 1) < 30e-6, 'the SOUND advances one second per second of real time',
    `${((aSound.slope - 1) * 1e6).toFixed(1)} ppm off real time (the card is ${ppm >= 0 ? '+' : ''}${ppm})`);
  check(Math.abs(vLine.slope - 1) < 30e-6, 'the PICTURE advances one second per second of real time',
    `${((vLine.slope - 1) * 1e6).toFixed(1)} ppm off real time`);
  check(Math.abs(gapB - gapA) < 10, 'so the gap between sound and picture has stopped growing',
    `${gapA.toFixed(0)} ms at ${tA}s, ${gapB.toFixed(0)} ms at ${tB}s`);
  check(Math.abs(gapB) < 80, 'and what is left of it is inside lip-sync tolerance', `${gapB.toFixed(0)} ms`);
  check(tWorst < -70, 'the tone comes out of the correction clean, start to finish (no splice, no click, no warble)',
    `THD+N median ${tMed.toFixed(1)} dB, worst ${tWorst.toFixed(1)} dB over ${thd.length} windows`);
  check(r.maxStep <= Math.abs(ppm) + 3500, 'and the correction never pulls the pitch further than it must',
    `largest step ${r.maxStep.toFixed(0)} ppm (${(1200 * Math.log2(1 + r.maxStep * 1e-6)).toFixed(1)} cents)`);
}

(async () => {
  console.log('== CAPTURE CLOCK: one second of sound per second of real time? ==');
  console.log('   engine: ' + path.relative(process.cwd(), ENGINE));
  const cards = [['the church PC (as measured off YouTube)', 1214], ['a fast card', 300], ['a slow card', -300], ['an exact card', 0]];
  let seed = 7;
  for (const [name, ppm] of cards) analyse(name, ppm, await runCard(ppm, seed++));
  console.log(`\n==== capture clock: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
