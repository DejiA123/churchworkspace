'use strict';
/*
 * THE BROADCAST CAPTURE ENGINE — program canvas + program sound in, fragmented
 * MP4 (H.264 + AAC) out.
 *
 * This code used to live inside live.js, which meant it ran on the renderer's
 * MAIN thread: the same thread that composites the program, draws the preview
 * monitor, paints sixteen thumbnails, runs the mixer meters and answers every
 * click on the desk. Everything below — collecting frames, pacing them onto a
 * constant grid, driving two encoders and muxing the result — had to take its
 * turn behind all of that.
 *
 * That was the ceiling on smoothness, and it was measured, repeatedly:
 *
 *   - 15-20% of drawn frames never reached the encoder at 720p on a loaded
 *     machine, ~25% at 1080p to three platforms;
 *   - the pacer could only fill a missed slot while the encoder had headroom,
 *     so exactly when the machine was struggling the stream went back to being
 *     VARIABLE frame rate — which is what makes a platform re-time the picture
 *     and STRETCH THE SOUND TO MATCH. Facebook tolerates it. YouTube does not,
 *     and "1080p sounds nasty on YouTube but 720p is fine" is that ceiling
 *     described from the pew;
 *   - and the preview monitor stuttered, because the compositor was sharing a
 *     thread with a live H.264 encoder.
 *
 * So the engine is extracted into ONE file that can run in either place, and
 * capture-worker.js runs it on a worker thread. Nothing about the timing logic
 * changed in the move — it is the same code, in the same order, reading the
 * same clock — because that logic took several rounds of measurement to get
 * right and re-deriving it on a new thread would have thrown that away. What
 * changed is only WHICH thread it is on, and therefore how much of it actually
 * gets to run.
 *
 * Two properties made the move safe rather than merely appealing:
 *
 *   1. BOTH pumps still read on the SAME thread as each other. The one-clock
 *      estimate below relies on the picture and the sound sharing whatever
 *      delivery delay their thread is under, so the delay cancels between
 *      them. Splitting them across two threads would place one perfectly and
 *      leave the other behind by the whole of the other thread's delay. So the
 *      sound goes to the worker too — the capture worklet's port is routed
 *      straight through to it (see capture-audio-worklet.js).
 *   2. A worker has its own `performance.now()` origin, and nothing here reads
 *      a clock the main thread also reads. Every timestamp that leaves this
 *      file is relative to the capture's own start.
 *
 * Loaded as a plain script in both hosts (`<script>` in index.html for the
 * in-page fallback, `importScripts` in the worker), so it needs `Mp4Muxer` and
 * `H264Filler` as globals and nothing else from its host.
 */
globalThis.CaptureEngine = (() => {

  /**
   * Start capturing. `opts`:
   *   cfg            — width, height, fps, videoKbps, audioKbps, codec, accel,
   *                    sampleRate, padKbps, padFloorKbps
   *   video          — ReadableStream of VideoFrame (the program canvas)
   *   fromWorklet    — true when the host will call `eng.feedAudio(msg)` with
   *                    {frames, startFrame, buf} from capture-audio-worklet.js
   *                    (preferred: the audio render thread cannot be starved by
   *                    anything either host does). The host owns the port, not
   *                    this engine, so ONE long-lived port can serve a whole
   *                    run of capture sessions.
   *   audio          — …or a ReadableStream of AudioData, if there is no worklet
   *   onChunk(buf)   — one piece of fragmented MP4, in order
   *   onFail(err)    — the capture has given up; the host falls back
   */
  function create(opts) {
    const cfg = opts.cfg || {};
    const onChunk = opts.onChunk;
    const eng = { state: 'recording', onstop: null, onerror: null, mimeType: 'video/mp4;codecs=h264,aac' };
    // Keyframe cadence, in SECONDS. Platforms want one every ~2s and reject
    // anything past 4s; counting frames instead of seconds makes the interval
    // stretch exactly when the machine is struggling and can least afford to be
    // told its connection is bad. `keyAt` is the timestamp of the last one.
    const KEY_SEC = 2;
    let keyAt = null, startSec = null;
    let stopping = false, failed = false, frames = 0;
    let muxer, vEnc, aEnc, vReader, aReader;
    // The exact video configuration in force, kept because auto-fit re-rates
    // the encoder in place mid-broadcast (eng.setBitrate below).
    let vCfg = null;
    // The constant-rate pacer and the picture it is holding. Declared out here
    // because eng.stop() below has to be able to shut them down — a `const`
    // inside the try block would be invisible to it and the interval would run
    // on after the broadcast ended.
    let pacer = 0, pending = null;
    // The program-audio tap on the audio thread, when this machine could build
    // one. Without it the sound is read as a stream, exactly as it always was.
    const fromWorklet = !!opts.fromWorklet;

    /* ===================== ONE CLOCK FOR BOTH TRACKS ======================
     *
     * The picture and the sound reach this function stamped on DIFFERENT
     * Chromium clocks — canvas frames count from when the capture stream was
     * made, WebAudio buffers count from when the machine booted. Letting the
     * muxer rebase each track to its own first sample (its 'offset' mode)
     * quietly assumes those two first samples happened at the same instant.
     * Nothing guarantees that: whichever pump is held up at the start — a
     * hardware encoder initialising, a thread busy building the broadcast —
     * hands over its first sample late, and EVERY later sample inherits that
     * error for the rest of the service. Measured directly, that gap was tens
     * of milliseconds rather than the seconds first suspected (the seconds
     * turned out to be a fault in how the broadcast was being MEASURED), so
     * this is a guard against a real but small error, not the repair for the
     * big one — that was the audio timeline, below.
     *
     * So both tracks are moved onto this thread's own clock first. For any
     * item, `timestamp - arrival` is that track's clock epoch minus however
     * long delivery took; delivery is never negative, so the LARGEST value a
     * track produces is its epoch. Encoded chunks are held for a moment at the
     * start until both epochs are known, then written with timestamps that
     * mean the same thing on both tracks.
     *
     * BOTH epochs are estimated the same way on purpose, and neither is taken
     * from anything absolute. The two pumps read on ONE thread — which is
     * exactly why the sound had to come to the worker as well — so whatever
     * holds one up holds the other up by about as much, and estimating them
     * identically lets that shared delay cancel between them. Measuring one
     * exactly and the other by arrival would place that one perfectly and
     * leave the other behind by the whole shared delay, on exactly the
     * overloaded machine least able to afford it. What has to be right here is
     * the two AGREEING, not either being absolute.
     */
    const PRIME_MS = 250;    // ceiling, not a wait — see the arrival gate below
    const PRIME_CAP_MS = 4000; // …but never wait forever on a track that is silent
    const clk = {
      t0: performance.now(), vEpoch: -Infinity, aEpoch: -Infinity,
      vSeen: 0, aSeen: 0, vShed: 0, ready: false, held: [], heldV: false, heldA: false,
      base: null, lastV: null, lastA: null,
      vArr: 0, aArr: 0, vFirstTs: null, aFirstTs: null,
      // Enough to tell "audio never reached us" from "audio reached us and the
      // timeline lost it on the way out" — the two have completely different
      // fixes, and both look like the sound sliding ahead of the picture.
      aInFirst: null, aInLast: null, aFrames: 0, aLastAt: 0,
      aOutFirst: null, aOutLast: null, aOut: 0, vOutFirst: null, vOutLast: null, vOut: 0,
      // How well the constant-rate grid is actually being held. A broadcast
      // with `missed` climbing is one a platform sees as variable frame rate —
      // which is the thing that makes it re-time the picture and stretch the
      // sound to match.
      paced: 0, filled: 0, missed: 0,
    };
    /*
     * Priming waits on ARRIVALS, not on encoded chunks, and the difference is
     * seconds of a service.
     *
     * Both epochs are known as soon as each track has delivered anything at
     * all, which happens within a frame or two of the capture starting. The
     * ENCODER is a different story: a software H.264 encoder on a busy machine
     * can take seconds to hand back its first chunk. Waiting for that before
     * letting anything through held the whole broadcast — measured as a
     * recording that started 8 seconds late and lost the opening of the take.
     * So the moment both tracks have been HEARD FROM, everything flows.
     */
    /*
     * …AND ONCE THE BROADCAST IS FLOWING, THE EPOCHS ARE FROZEN.
     *
     * This used to go on raising each epoch for the whole service, every time
     * a buffer happened to arrive with a larger `timestamp - arrival` than any
     * before it. That is harmless for a clock that runs at the same rate as
     * this thread's — its largest value is found in the first second and never
     * beaten. It is NOT harmless for the sound. The sound's timestamps are a
     * running sample count, i.e. the SOUND CARD's clock, and a card that runs
     * fast against `performance.now()` produces a `timestamp - arrival` that
     * grows without end. Every new maximum then pulled every later audio
     * timestamp back by the difference, so the sound's timeline was quietly
     * re-stamped onto the system clock while its SAMPLES stayed on the card's.
     * The broadcast then claimed less time than the sound it carried.
     *
     * That is exactly what YouTube was cutting out. Measured in a real church
     * service as it came back off YouTube (2026-09-25): clean for two minutes,
     * then ~18 splices a second, every one of them locked to a 64 ms grid —
     * three AAC frames, the pattern of millisecond timestamps on 21.33 ms
     * frames — and the grid itself 1214 ppm short: YouTube was discarding
     * 0.12% of the sound, two samples at a time, at the frame joins, to make
     * the audio fit the time the timestamps said it occupied. That card was
     * 0.12% fast. Facebook ignores the discrepancy, which is why it never
     * crackled there. A sound track whose timestamps ARE its sample count
     * cannot be "too long" for anything downstream.
     *
     * So the epochs are measured once, while priming — which is what they are
     * for — and then left alone. Any error in that first estimate is a few
     * milliseconds of FIXED offset between the two tracks, never a rate.
     */
    const noteArrival = (key, tsUs) => {
      // Frozen per TRACK, and only once that track has actually been measured:
      // priming can give up waiting on a silent track (PRIME_CAP_MS), and a
      // track whose first sound arrives after that must still get an epoch —
      // one frozen at -Infinity would stamp every chunk it ever produced at
      // infinity. So a track keeps refining through its first few arrivals
      // even after the other has started flowing, then stops for good.
      const n = key === 'vEpoch' ? clk.vArr : clk.aArr;
      if (!clk.ready || n < 3) {
        const off = tsUs / 1000 - performance.now();
        if (off > clk[key]) clk[key] = off;
      }
      if (key === 'vEpoch') { clk.vArr++; if (clk.vFirstTs == null) clk.vFirstTs = tsUs; }
      else { clk.aArr++; if (clk.aFirstTs == null) clk.aFirstTs = tsUs; }
      // A FEW arrivals each, not a fixed wait. The epoch is the largest
      // `timestamp - arrival` a track produces, so a handful of samples is
      // enough to avoid latching onto one unusually late delivery — about
      // 100ms in practice. Waiting a fixed 300ms instead bought roughly 15ms
      // of accuracy and cost seconds off the front of a recording on a machine
      // whose encoder is slow to start, which is a bad trade in any church.
      if (!clk.ready && clk.vArr > 0 && clk.aArr > 0 &&
          (Math.min(clk.vArr, clk.aArr) >= 3 || performance.now() - clk.t0 >= PRIME_MS)) flushHeld();
    };

    /* ---------------- the sound's own timeline, holes and all --------------
     *
     * The AAC encoder stamps what it hands back by COUNTING SAMPLES, not by
     * reading the clock. Feed it sound that a busy moment left holes in and it
     * hands back one solid block with the holes closed up — so every later
     * word slides earlier and the sound walks away from the picture for the
     * rest of the service, getting worse the longer it runs. Measured on this
     * laptop before the fix: 1.6s of sound lost in 25s, and the beeps arriving
     * a full second ahead of the flashes by the end.
     *
     * So an encoded chunk is placed by where its samples came from, not by
     * what the encoder called them: `aMap` remembers the arrival timestamp of
     * each buffer against the running sample count, and each chunk is looked
     * up in it. A hole then stays a hole — a moment of silence in the right
     * place, which is recoverable — instead of a permanent shift.
     */
    const aMap = [];
    let aInPos = 0, aOutPos = 0;
    const noteAudioIn = (ad) => {
      aMap.push({ pos: aInPos, ts: ad.timestamp });
      aInPos += ad.numberOfFrames || 0;
      if (aMap.length > 4000) aMap.splice(0, aMap.length - 2000);
    };
    const audioChunkTs = (chunk) => {
      const sr = cfg.sampleRate || 48000;
      const n = chunk.duration ? Math.round((chunk.duration * sr) / 1e6) : 1024;
      while (aMap.length > 1 && aMap[1].pos <= aOutPos) aMap.shift();
      const e = aMap[0];
      const ts = e ? e.ts + ((aOutPos - e.pos) / sr) * 1e6 : chunk.timestamp;
      aOutPos += n;
      return ts;
    };
    /* ============== THE SOUND IS PUT ON REAL TIME, NOT THE CARD'S ==============
     *
     * The picture is stamped by the pacer on a grid run from `performance.now()`
     * — the system clock, which is real time. The sound is counted in samples
     * of the sound card's clock, and "48000 Hz" on a card is never exactly
     * 48000 real samples a second. The church that reported "fine for two
     * minutes, then crackling, on YouTube" was streaming from a machine whose
     * card ran 0.12% FAST: 48 058 samples for every real second.
     *
     * Two earlier answers to that were wrong, and why is the whole design:
     *
     *  - Before v2.75 the capture re-stamped the sound onto the system clock
     *    and kept all its samples, so the broadcast CLAIMED less time than the
     *    sound it carried. Measured off the church's own YouTube stream:
     *    YouTube threw the surplus away, two samples at a time at the AAC frame
     *    joins, ~18 splices a second, 1214 ppm in all. That is the crackle.
     *  - v2.75 stamped the sound by its samples and ran the PICTURE at the
     *    card's rate to match. Internally consistent — and the whole broadcast
     *    then ran 0.12% faster than real time. A live platform plays out in
     *    real time; it cannot take 1.0012 seconds of programme every second
     *    for ever, and on the next service the crackle was exactly the same.
     *
     * A live stream has to carry exactly one second of picture AND one second
     * of sound per second of real time, with timestamps that say so. So the
     * card's sound is RESAMPLED onto real time before it is encoded — what
     * OBS and vMix do, what any mixing desk does with an unlocked input. The
     * correction is the card's error and nothing more, 0.12% here: two cents
     * of pitch, applied smoothly, with a sinc kernel whose response is flat to
     * ~20 kHz wherever it lands between samples. Nothing a listener can hear;
     * everything a platform needs. The picture stays on real time.
     */
    const SR = cfg.sampleRate || 48000;
    const MAX_TRIM = 6e-3;          // 0.6%: far past any real card, short of nonsense
    // Both thresholds are overridable ONLY so a test can watch the correction
    // engage sooner. Nothing in the app passes them.
    const TRIM_AFTER_MS = cfg.driftAfterMs == null ? 30000 : cfg.driftAfterMs;
    let audioRate = 1;              // card samples per real sample, once trusted
    let aRateStart = 0, aRateSpan = 0, aRateMeas = 0, aTrusted = false;
    // TEST ONLY: behave as if the card were this far out, from the first
    // sample, so a real-app suite on an honest card still drives the real
    // resampler and the real AAC encoder through a 0.12% correction.
    if (cfg.forceCardPpm) { audioRate = 1 + cfg.forceCardPpm * 1e-6; aTrusted = true; }
    // The first seconds of a capture are not a clock. Whatever backlog the
    // audio thread had in hand arrives in a burst — samples with almost no time
    // beside them — and an estimate that starts there carries that burst as a
    // FIXED surplus for ever, decaying only as 1/baseline. Measured before this
    // guard: the estimate read 370 ppm at 30 s and was still 89 ppm at 135 s,
    // decaying exactly as 1/t, which is the signature of a constant surplus
    // rather than of a rate.
    const SETTLE_MS = 5000;
    let vClockMs = 0, vClockAt = 0;
    /** The pacer's clock: real time. (It used to run at the card's rate — see above.) */
    const paceClockMs = () => {
      const now = performance.now();
      if (!vClockAt) { vClockAt = now; return vClockMs; }
      vClockMs += now - vClockAt;
      vClockAt = now;
      return vClockMs;
    };
    /**
     * One buffer of sound arrived: re-estimate how fast the card really runs.
     *
     * WHAT IS MEASURED. Every buffer says where it sits on the card's clock
     * (its sample count) and arrives at a moment on this thread's clock. The
     * difference between the two — `sample time - arrival` — moves at exactly
     * the rate the two clocks disagree, minus however late that buffer was
     * delivered. So the drift is the SLOPE of that difference over time.
     *
     * WHY THE LEAST-DELAYED BUFFER OF EACH WINDOW. Delivery delay only ever
     * makes a buffer late, never early, so in every 5-second window the buffer
     * with the LARGEST `sample time - arrival` is the one that was delivered
     * soonest — and the soonest delivery of fifty is almost the same from one
     * window to the next. Fitting a line through those per-window maxima
     * reads the clocks, not the thread's workload. ("Samples so far / time so
     * far", which this replaced, was fooled by one late buffer: -99 ppm of
     * "correction" on a perfect card in simulation.)
     *
     * THE ESTIMATE IS ONLY ACTED ON ONCE IT HAS OUTGROWN ITS OWN NOISE: the
     * drift it has measured, accumulated over the baseline it was measured on,
     * must exceed 25 ms — a figure delivery jitter cannot manufacture. A card
     * 50 ppm out is picked up about eight minutes in; the 0.12%-fast card of
     * the church that reported this, inside thirty seconds.
     */
    const EVIDENCE_S = cfg.driftEvidenceS == null ? 0.025 : cfg.driftEvidenceS;
    const RATE_WIN_MS = 5000;
    const ratePts = [];             // per-window {t, off}: least-delayed buffer of each window
    let winFrom = 0, winMax = -Infinity, winAt = 0;
    const noteAudioRate = (tsUs) => {
      if (cfg.forceCardPpm) return;
      const now = performance.now();
      if (!aRateStart) aRateStart = now;
      if (now - aRateStart < SETTLE_MS) return;              // see SETTLE_MS
      const off = tsUs / 1000 - now;
      if (!winFrom) winFrom = now;
      if (off > winMax) { winMax = off; winAt = now; }
      if (now - winFrom < RATE_WIN_MS) return;
      /*
       * A STALL OF THE AUDIO THREAD IS NOT EVIDENCE ABOUT THE CRYSTAL. If the
       * card's clock genuinely stopped for a moment (the context suspended,
       * the machine hung) the sample time falls behind for good: a STEP, not
       * a slope. A window whose best buffer lands far off the line so far
       * starts the baseline again rather than bending it.
       */
      if (ratePts.length >= 2) {
        const a = ratePts[0], b = ratePts[ratePts.length - 1];
        const pred = b.off + ((b.off - a.off) / Math.max(1, b.t - a.t)) * (winAt - b.t);
        if (Math.abs(winMax - pred) > 20) ratePts.length = 0;
      }
      ratePts.push({ t: winAt, off: winMax });
      if (ratePts.length > 720) ratePts.shift();             // an hour of windows
      winFrom = now; winMax = -Infinity;
      if (ratePts.length < 3) return;
      const span = ratePts[ratePts.length - 1].t - ratePts[0].t;
      aRateSpan = span;
      if (span < TRIM_AFTER_MS) return;
      let mt = 0, mo = 0;
      for (const p of ratePts) { mt += p.t; mo += p.off; }
      mt /= ratePts.length; mo /= ratePts.length;
      let num = 0, den = 0;
      for (const p of ratePts) { num += (p.t - mt) * (p.off - mo); den += (p.t - mt) * (p.t - mt); }
      const drift = den ? num / den : 0;                     // card ms gained per real ms
      const meas = 1 + drift;
      if (!(meas > 0.9 && meas < 1.1)) return;               // not a crystal; leave it alone
      // What the estimator currently BELIEVES, reported whether or not it has
      // earned the right to act on it.
      aRateMeas = meas;
      if (!aTrusted && Math.abs(drift) * span < EVIDENCE_S * 1000) return;
      aTrusted = true;
      audioRate = Math.min(1 + MAX_TRIM, Math.max(1 - MAX_TRIM, meas));
    };

    /* ------------------------ the resampler itself ------------------------ *
     * Variable-ratio windowed sinc: 32 taps, Kaiser beta 8.6, 256 phases with
     * linear interpolation between them, every phase normalised to unity DC.
     * At a ratio of exactly 1 the phase never moves off zero and the kernel
     * is a unit impulse — the sound passes through bit for bit until there is
     * a card error to correct. (The same kernel as ndi-audio-worklet.js; an
     * AudioWorklet and a worker cannot share a script, so it is repeated.)
     */
    const RS_TAPS = 32, RS_HALF = 16, RS_PHASES = 256;
    const rsKernel = (() => {
      const I0 = (x) => { let sum = 1, term = 1; const q = (x * x) / 4; for (let k = 1; k < 64; k++) { term *= q / (k * k); sum += term; if (term < sum * 1e-13) break; } return sum; };
      const BETA = 8.6, i0b = I0(BETA);
      const tbl = new Float32Array((RS_PHASES + 1) * RS_TAPS);
      for (let p = 0; p <= RS_PHASES; p++) {
        let sum = 0;
        for (let t = 0; t < RS_TAPS; t++) {
          const x = t - (RS_HALF - 1) - p / RS_PHASES;
          const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
          const r = x / RS_HALF;
          const w = r <= -1 || r >= 1 ? 0 : I0(BETA * Math.sqrt(1 - r * r)) / i0b;
          tbl[p * RS_TAPS + t] = sinc * w; sum += sinc * w;
        }
        if (sum) for (let t = 0; t < RS_TAPS; t++) tbl[p * RS_TAPS + t] /= sum;
      }
      return tbl;
    })();
    const rs = {
      tailL: new Float32Array(RS_TAPS), tailR: new Float32Array(RS_TAPS),
      pos: RS_HALF - 1,            // read position inside [tail | chunk]
      step: 1,                     // input samples per output sample, in force
      inTotal: 0, outTotal: 0,     // samples taken in / handed to the encoder
      catchPpm: 0,
    };
    /**
     * Resample one chunk of the card's sound onto real time. The step aims the
     * OUTPUT count at where real time says it should be — input / card rate —
     * so a card error is removed at its own rate, and the offset that built up
     * before the estimate was trusted is folded back in over ~10 s. The step
     * moves at most 0.005% per chunk, so the pitch never lurches.
     */
    const resampleChunk = (L, R, n) => {
      const due = (rs.inTotal + n) / audioRate;              // output samples real time has earned
      const err = rs.outTotal + n / rs.step - due;           // + : we would produce too many
      const catchUp = Math.max(-0.0015, Math.min(0.0015, err / (SR * 10)));
      rs.catchPpm = catchUp * 1e6;
      const want = Math.min(1 + MAX_TRIM, Math.max(1 - MAX_TRIM, audioRate * (1 + catchUp)));
      rs.step += Math.max(-5e-5, Math.min(5e-5, want - rs.step));
      const len = RS_TAPS + n;
      const xL = new Float32Array(len), xR = new Float32Array(len);
      xL.set(rs.tailL, 0); xL.set(L, RS_TAPS);
      xR.set(rs.tailR, 0); xR.set(R, RS_TAPS);
      const limit = len - 1 - RS_HALF;                       // furthest index a kernel may touch
      const count = Math.max(0, Math.ceil((limit - rs.pos) / rs.step));
      const out = new Float32Array(count * 2);               // planar: L then R
      const K = rsKernel;
      let p = rs.pos;
      for (let i = 0; i < count; i++, p += rs.step) {
        const base = Math.floor(p);
        const pf = (p - base) * RS_PHASES;
        const p0 = pf | 0, a = pf - p0;
        const r0 = p0 * RS_TAPS, r1 = r0 + RS_TAPS;
        const start = base - (RS_HALF - 1);
        let sl = 0, sr = 0;
        for (let t = 0; t < RS_TAPS; t++) {
          const k0 = K[r0 + t];
          const c = k0 + a * (K[r1 + t] - k0);
          sl += xL[start + t] * c; sr += xR[start + t] * c;
        }
        out[i] = sl; out[count + i] = sr;
      }
      rs.tailL.set(xL.subarray(len - RS_TAPS)); rs.tailR.set(xR.subarray(len - RS_TAPS));
      rs.pos = p - n;
      rs.inTotal += n;
      const startOut = rs.outTotal;
      rs.outTotal += count;
      return { out, count, startOut };
    };
    // µs on this thread's clock. Never negative: performance.now() has been
    // running since this context was created, long before any capture starts.
    const oneClock = (key, tsUs) => Math.max(0, Math.round(tsUs - clk[key] * 1000));
    /*
     * The picture goes out at the rate it was promised at, not at the rate a
     * still slide happens to compress to. See h264-filler.js — on this very
     * machine a motionless 1080p verse asked for 6000 kbps and left the
     * software encoder at 104, which is the whole of YouTube's "your bitrate
     * is lower than recommended" warning in one number.
     *
     * `padKbps` is 0 for a recording-only session: nothing is watching a file
     * for a steady rate, and a service is long enough that the difference is
     * measured in gigabytes.
     */
    const Filler = globalThis.H264Filler;
    let filler = (cfg.padKbps && Filler)
      ? Filler.create({ targetKbps: cfg.padKbps, fps: cfg.fps }) : null;
    /*
     * …and it can be switched on LATER, without restarting the capture: a
     * recording that started first has no pad, and the moment a platform joins
     * it needs one. See upgradeCaptureForStream.
     */
    eng.setPad = (kbps, floorKbps) => {
      const want = Math.max(0, Math.round(kbps) || 0);
      if (floorKbps != null) cfg.padFloorKbps = Math.max(0, Math.round(floorKbps) || 0);
      if (!want) { if (filler) filler.suspend(); return false; }
      if (!Filler) return false;
      if (!filler || filler.disabled) filler = Filler.create({ targetKbps: want, fps: cfg.fps });
      else { filler.retarget(want); filler.resume(); }
      cfg.padKbps = want;
      return !filler.disabled;
    };
    const writeChunk = (kind, chunk, meta, ts) => {
      if (kind !== 'v') { muxer.addAudioChunk(chunk, meta, ts); return; }
      if (!filler || filler.disabled) { muxer.addVideoChunk(chunk, meta, ts); return; }
      // ONE buffer, ONE copy — the encoder writes straight into the array that
      // will also carry the filler. See padChunk: materialising the chunk first
      // and copying it again cost real frames off the compositor.
      const out = filler.padChunk(chunk.byteLength, (view) => chunk.copyTo(view));
      // Duration is normally set by the pacer; a chunk without one would be
      // rejected outright by the muxer, so the frame's own slot stands in.
      muxer.addVideoChunkRaw(out, chunk.type, ts,
        chunk.duration || Math.round(1e6 / (cfg.fps || 30)), meta);
    };
    eng.fillerStats = () => (filler ? filler.stats() : null);
    /*
     * Nothing may ever be written EARLIER than the first thing written.
     *
     * The muxer rebases both tracks by the smaller of their two first
     * timestamps, and it learns each track's first only when that track turns
     * up. Priming normally waits for both, but a GPU encoder that produces
     * nothing for seconds (Media Foundation's first-use init on a loaded
     * integrated chip) forces the flush to go ahead with sound alone — and
     * then the picture arrives carrying timestamps from BEFORE it, the shared
     * base moves down, and every sound sample already written jumps by the
     * difference. Seconds of it. Holding the floor makes the base
     * unmoveable; the cost is that a few frames from before the broadcast
     * began are squashed together at the start, which nobody will ever see.
     */
    const atFloor = (kind, ts) => {
      const key = kind === 'v' ? 'lastV' : 'lastA';
      const t = Math.max(ts, clk.base == null ? ts : clk.base, clk[key] == null ? ts : clk[key] + 1);
      clk[key] = t;
      return t;
    };
    const flushHeld = () => {
      if (clk.ready) return;
      clk.ready = true;
      // The floor is the earliest moment either track could possibly have
      // produced — its FIRST ARRIVAL. Nothing encoded can predate the picture
      // or sound it was made from, so no later chunk can duck under this, and
      // the muxer's shared base is fixed from here on.
      const cand = [];
      if (clk.vFirstTs != null) cand.push(oneClock('vEpoch', clk.vFirstTs));
      if (clk.aFirstTs != null) cand.push(oneClock('aEpoch', clk.aFirstTs));
      const items = clk.held.map((h) => ({ ...h, ts: oneClock(h.kind === 'v' ? 'vEpoch' : 'aEpoch', h.raw) }));
      clk.held = [];
      for (const it of items) cand.push(it.ts);
      if (cand.length) clk.base = Math.min.apply(null, cand);
      // In timestamp order, so the earliest sample is written first. Sorting
      // is stable, so each track keeps its own order.
      items.sort((a, b) => a.ts - b.ts);
      for (const it of items) writeChunk(it.kind, it.chunk, it.meta, atFloor(it.kind, it.ts));
    };
    const emitChunk = (kind, chunk, meta, raw) => {
      if (kind === 'a') { if (clk.aOutFirst == null) clk.aOutFirst = raw; clk.aOutLast = raw; clk.aOut++; }
      else { if (clk.vOutFirst == null) clk.vOutFirst = raw; clk.vOutLast = raw; clk.vOut++; }
      if (clk.ready) {
        writeChunk(kind, chunk, meta, atFloor(kind, oneClock(kind === 'v' ? 'vEpoch' : 'aEpoch', raw)));
        return;
      }
      clk.held.push({ kind, chunk, meta, raw });
      if (kind === 'v') clk.heldV = true; else clk.heldA = true;
    };
    const primeTimer = setTimeout(() => { if (!failed) { try { flushHeld(); } catch (e) { fail(e); } } }, PRIME_CAP_MS);

    const fail = (e) => {
      if (failed || stopping) return;
      failed = true;
      // GPU capture on this machine is not dependable — the host restarts the
      // session on the proven MediaRecorder path and stays there.
      if (opts.onFail) { try { opts.onFail(e); } catch (e2) {} }
      if (eng.onerror) { try { eng.onerror(e); } catch (e2) {} }
    };

    try {
      let muxPos = 0; // fragmented output must be append-only — a backpatch can't be streamed
      muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.StreamTarget({
          onData: (data, position) => {
            if (failed) return;
            if (position !== muxPos) { fail(new Error('non-sequential mux write at ' + position)); return; }
            muxPos += data.length;
            onChunk(data.slice().buffer);
          },
        }),
        fastStart: 'fragmented',
        // ONE shared offset, because by this point both tracks are already on
        // the same clock (see above) and the gap between them is the real one.
        // Rebasing each track separately ('offset') is what put the sound ~700
        // ms ahead of the picture. This mode must never be used with the raw
        // WebCodecs timestamps: those two clocks are HOURS apart, and a shared
        // offset then leaves every downstream ffmpeg buffering video forever,
        // waiting for the timelines to meet.
        firstTimestampBehavior: 'cross-track-offset',
        video: { codec: 'avc', width: cfg.width, height: cfg.height, frameRate: cfg.fps },
        audio: { codec: 'aac', sampleRate: cfg.sampleRate, numberOfChannels: 2 },
      });
      vEnc = new VideoEncoder({
        output: (chunk, meta) => { try { emitChunk('v', chunk, meta, chunk.timestamp); } catch (e) { fail(e); } },
        error: fail,
      });
      vCfg = {
        codec: cfg.codec, width: cfg.width, height: cfg.height,
        bitrate: cfg.videoKbps * 1000, bitrateMode: 'constant', framerate: cfg.fps,
        // Ask for exactly what wcSupport established this machine will accept at
        // this size and rate. Demanding hardware here after it already answered
        // no is how the whole session ends up back on MediaRecorder.
        hardwareAcceleration: cfg.accel === 'software' ? 'no-preference' : 'prefer-hardware',
        latencyMode: 'realtime', avc: { format: 'avc' },
      };
      vEnc.configure(vCfg);
      aEnc = new AudioEncoder({
        output: (chunk, meta) => { try { emitChunk('a', chunk, meta, audioChunkTs(chunk)); } catch (e) { fail(e); } },
        error: fail,
      });
      aEnc.configure({ codec: 'mp4a.40.2', sampleRate: cfg.sampleRate, numberOfChannels: 2, bitrate: (cfg.audioKbps || 128) * 1000 });

      /*
       * Each pump has a queue in front of it that throws work away when the
       * thread it reads on is busy. The defaults are far too shallow for a
       * machine under broadcast load, but the right depth is not the same for
       * the two of them.
       *
       * Sound: THREE SECONDS. The default holds about ten 10ms buffers, so any
       * moment the thread is busy for longer than a tenth of a second loses
       * sound — measured at 1.6 SECONDS lost in a 25s broadcast back when this
       * ran on the renderer's main thread. Three seconds of cushion costs
       * about a megabyte and rides out anything short of a genuine freeze.
       * Late sound is still every word the preacher said, so it is always
       * worth keeping. (This is only the BACKSTOP: the sound normally arrives
       * on `audioPort` from a worklet on the audio render thread, which cannot
       * be starved at all.)
       *
       * Picture: FOUR FRAMES, not three seconds. A frame the thread was too
       * busy to collect is simply missing from the broadcast — the platform
       * was promised 30fps and got 25.4 (measured) — so a small cushion buys
       * back a real frame rate. It stays small on purpose: a picture held
       * longer than that is old news on a live stream, and the encoder shed
       * below is the backstop for a machine that genuinely cannot keep up.
       */
      vReader = opts.video.getReader();
      if (!fromWorklet && opts.audio) aReader = opts.audio.getReader();
      /* ================== A CONSTANT FRAME RATE ON THE WIRE ==================
       *
       * The compositor draws when it can. A canvas capture therefore produces
       * frames whenever they happen, and encoding each one as it arrives sends
       * the platform a stream that CLAIMS 30fps and delivers something else.
       * Measured on a real 1080p two-platform broadcast, in the file the
       * platform actually received:
       *
       *     median gap 34 ms  ·  p90 100 ms  ·  p99 200 ms  ·  WORST 4033 ms
       *     43% of frames arrived more than 50 ms after the one before
       *
       * A four-second freeze in a "30fps" stream is what a congregation sees as
       * juddering video — and it is why the SOUND goes strange too, because a
       * platform that re-times a variable stream onto its own clock stretches
       * the audio to match. Facebook tolerates it. YouTube does not, which is
       * exactly the shape of "Facebook is perfect and YouTube is a mess".
       *
       * So the encoder is driven by a CLOCK, not by frame arrivals: every
       * 1/fps, whatever the newest picture is gets encoded on an exact grid,
       * and if the compositor has not managed a new one the previous picture is
       * sent again. A duplicate of an unchanged frame costs the encoder almost
       * nothing (it is a handful of skipped macroblocks), and what leaves the
       * building is a stream whose timing is perfect even when the machine's is
       * not. This is what OBS and vMix do, and why their output is accepted by
       * every platform on modest hardware.
       */
      const frameUs = 1e6 / (cfg.fps || 30);
      /*
       * How far the paced picture is stamped AHEAD of the slot it is sent in.
       *
       * A picture handed to the pacer has already spent time being drawn,
       * captured and collected, while the sound is stamped by the audio thread
       * at the moment the samples existed. That difference is real and it is
       * measurable on air: with no correction the A/V pulse measured 105 ms of
       * SOUND LAGGING the picture; stamping the picture a frame EARLIER made it
       * worse (120 ms), which is what fixed the direction. Unlike a
       * millisecond figure, frames scale with the production rate.
       *
       * IT DEPENDS ON WHICH THREAD IS COLLECTING, and that is not a detail —
       * the whole quantity is a collection delay. Behind the compositor on the
       * renderer's main thread, two frames was measured right. On the worker
       * the picture reaches the encoder sooner, so two frames is no longer
       * enough of a lead and the sound lands LATE. Measured end to end on a
       * real RTMP ingest at 720p30 (`npm run test:streamtiming`; positive =
       * sound lagging the picture, which is the direction people notice last):
       *
       *     main thread, lead 2    ->   -5 ms          (what shipped before)
       *     worker,      lead 1    ->  +60 ms
       *     worker,      lead 2    ->  +40 ms
       *     worker,      lead 2.5  ->  +15, +45, -25   (mean +12)
       *     worker,      lead 3    ->  -10, -35        (mean -22)
       *
       * RUN-TO-RUN SPREAD IS ABOUT ±30 ms — wider than one whole frame at
       * 30fps — so "about two and a half frames" is as precise as this can
       * honestly be made, and a fractional lead is not false precision but the
       * admission that the answer sits between two frames. 2.5 is preferred
       * over 3 because it centres on the tolerant side: ITU-R BT.1359 puts the
       * perceptible threshold at 45 ms for sound LEADING and 125 ms for sound
       * lagging, and 2.5's worst observed reading was -25 ms leading against
       * 3's -35 ms.
       */
      const PACER_LEAD_FRAMES = cfg.pacerLeadFrames == null ? 2 : cfg.pacerLeadFrames;
      let baseTs = null, baseNow = 0, lastSlot = -1, lastPaced = null;
      const MAX_FILL = Math.ceil((cfg.fps || 30) * 1.5); // never burst more than 1.5s of catch-up

      (async () => {
        for (;;) {
          const { value: frame, done } = await vReader.read();
          if (done || stopping || failed) { if (frame) frame.close(); break; }
          // Read the clock from EVERY frame that arrives — a frame the pacer
          // never gets round to still says exactly as much about when the
          // picture clock started.
          noteArrival('vEpoch', frame.timestamp || 0);
          clk.vSeen++;
          if (baseTs == null) {
            baseTs = frame.timestamp || 0; baseNow = performance.now();
            vClockMs = 0; vClockAt = baseNow;   // the paced clock starts here
          }
          if (pending) { try { pending.close(); } catch (e) {} clk.vShed++; }
          pending = frame;     // closed when replaced, or by the pacer's stop
        }
      })();

      const paceOne = (slot) => {
        const src = pending;
        if (!src) return;
        // The grid: video time advances at exactly real time, so it can never
        // drift away from the sound no matter how the compositor behaves.
        // PACER_LEAD_FRAMES is measured, not guessed — see its declaration.
        const ts = Math.round(baseTs + (slot + PACER_LEAD_FRAMES) * frameUs);
        const tSec = ts / 1e6;
        if (startSec == null) startSec = tSec;
        /*
         * Keyframes on the CLOCK, not on a frame count, and every half second
         * for the first two seconds. Everything downstream — each destination's
         * ffmpeg, the recording, the platform — decides what this feed IS from
         * its opening moments and cannot decide anything until a keyframe has
         * gone past.
         */
        const need = tSec - startSec < 2 ? 0.5 : KEY_SEC;
        const isKey = keyAt == null || tSec - keyAt >= need || tSec < keyAt;
        if (isKey) keyAt = tSec;
        // A view of the same picture stamped onto the grid — no pixels copied.
        let gf = null;
        try {
          gf = new VideoFrame(src, { timestamp: ts, duration: Math.round(frameUs) });
          vEnc.encode(gf, { keyFrame: isKey });
          frames++;
        } catch (e) { fail(e); }
        if (gf) { try { gf.close(); } catch (e) {} }
      };

      pacer = setInterval(() => {
        if (stopping || failed || baseTs == null || !pending) return;
        // A stalled encoder must shed rather than balloon its queue — the one
        // case where a gap in the grid is the lesser evil.
        if (vEnc.encodeQueueSize > 8) { clk.vShed++; return; }
        /*
         * Slots come from the wall clock, so a stall never leaves a hole in the
         * grid. (Anchoring them to each frame's own timestamp instead was tried
         * and measured: the sound sat 15 ms better but a stalled capture put a
         * 2.1-SECOND gap back into the stream, which is the fault being fixed.)
         *
         * The one-frame lead in `paceOne` is what pays for the sound, and it is
         * not a fudge: a picture handed over at slot k was DRAWN before slot k,
         * because collecting it took time. Stamping it at its collection moment
         * is what put an extra 35 ms of sound-lag on air.
         */
        const slot = Math.floor((paceClockMs() * 1000) / frameUs);
        if (lastSlot < 0) lastSlot = slot - 1;
        if (slot <= lastSlot) return;
        /*
         * Filling a missed slot with a repeat of the last picture is what keeps
         * the rate constant — but it is also EXTRA ENCODING, and on a machine
         * that is already behind, extra encoding is the last thing to hand it.
         * Measured on the two-core laptop back when this ran on the renderer's
         * main thread: filling unconditionally at 1080p made the encoder shed
         * MORE real frames than it gained in duplicates.
         *
         * So the grid is filled only while the encoder has headroom. On a
         * worker that headroom is nearly always there — which is much of the
         * point of the move: the SAME rule now fills the grid on a machine
         * where it used to give up, so a platform gets an exactly constant
         * frame rate instead of a variable one it has to re-time (and stretch
         * the sound to match). A machine that genuinely cannot keep up still
         * sends what it can, and is never made worse by this.
         */
        const newPicture = pending !== lastPaced;
        const canFill = vEnc.encodeQueueSize <= 2;
        if (!newPicture && !canFill) { clk.missed += slot - lastSlot; return; }
        const fill = Math.min(slot - lastSlot, canFill ? MAX_FILL : 1);
        // Slots that elapsed and are not being filled are HOLES IN THE GRID,
        // and they count whether or not a new picture arrived. Counting them
        // only in the no-new-picture branch above under-reported the very thing
        // this number exists to report: with the encoder busy (queue 3-8) and a
        // new picture in hand, `fill` is capped at 1, so several slots could go
        // by leaving a real gap that nothing recorded.
        if (slot - lastSlot > fill) clk.missed += (slot - lastSlot) - fill;
        clk.paced += fill;
        if (!newPicture) clk.filled += fill;
        for (let i = fill; i >= 1; i--) paceOne(slot - i + 1);
        lastPaced = pending;
        lastSlot = slot;
      }, Math.max(4, Math.round(1000 / (cfg.fps || 30) / 3)));
      /**
       * One buffer of the card's sound: measure the card against real time,
       * resample onto real time, then encode. `cardTsUs` is where the buffer
       * sits on the CARD's clock (its sample count) — the estimator needs
       * that, not the resampled timeline, or it would be measuring its own
       * correction.
       */
      const takeProgram = (L, R, n, cardTsUs) => {
        noteAudioRate(cardTsUs);
        const r = resampleChunk(L, R, n);
        if (!r.count) return true;
        return takeAudio(new AudioData({
          format: 'f32-planar', sampleRate: SR,
          numberOfFrames: r.count, numberOfChannels: 2,
          // A running count of the samples actually encoded, on REAL time:
          // gap-free by construction, and one second per second of the clock.
          timestamp: Math.round((r.startOut / SR) * 1e6),
          data: r.out,
        }));
      };
      /** One buffer of program sound, already on real time, into the encoder. */
      const takeAudio = (ad) => {
        noteArrival('aEpoch', ad.timestamp || 0);
        clk.aSeen++;
        if (clk.aInFirst == null) clk.aInFirst = ad.timestamp;
        clk.aInLast = ad.timestamp; clk.aFrames += ad.numberOfFrames || 0;
        clk.aLastAt = performance.now();
        noteAudioIn(ad);
        try { aEnc.encode(ad); } catch (e) { ad.close(); fail(e); return false; }
        ad.close();
        return true;
      };

      if (fromWorklet) {
        /*
         * The audio thread hands over a whole 100 ms at a time (see
         * capture-audio-worklet.js). That is the difference between collecting
         * every second of the service and collecting four tenths of it: this
         * thread only has to come round ten times a second instead of a
         * hundred, and while it is busy the messages queue rather than
         * evaporate.
         *
         * The HOST owns the port and calls this — so one port, routed once,
         * can serve every capture session in a run without a new handshake
         * (and without a backlog piling up between sessions).
         */
        eng.feedAudio = (m) => {
          if (!m || !m.buf || stopping || failed) return;
          const f = new Float32Array(m.buf);
          const n = m.frames;
          try {
            takeProgram(f.subarray(0, n), f.subarray(n, 2 * n), n, (m.startFrame / SR) * 1e6);
          } catch (e) { fail(e); }
        };
      } else if (aReader) {
        (async () => {
          for (;;) {
            const { value: ad, done } = await aReader.read();
            if (done || stopping || failed) { if (ad) ad.close(); break; }
            const n = ad.numberOfFrames || 0;
            const L = new Float32Array(n), R = new Float32Array(n);
            try {
              ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
              ad.copyTo(R, { planeIndex: ad.numberOfChannels > 1 ? 1 : 0, format: 'f32-planar' });
            } catch (e) { ad.close(); fail(e); break; }
            const ts = ad.timestamp || 0;
            ad.close();
            if (!takeProgram(L, R, n, ts)) break;
          }
        })();
      }
    } catch (e) { fail(e); throw e; }

    eng.stop = async () => {
      if (eng.state === 'inactive') return;
      eng.state = 'inactive';
      stopping = true;
      clearTimeout(primeTimer);
      clearInterval(pacer);
      if (pending) { try { pending.close(); } catch (e) {} pending = null; }
      try { await vReader.cancel(); } catch (e) {}
      try { if (aReader) await aReader.cancel(); } catch (e) {}
      try { if (vEnc.state === 'configured') await vEnc.flush(); } catch (e) {}
      try { if (aEnc.state === 'configured') await aEnc.flush(); } catch (e) {}
      // a broadcast shorter than the priming window still has to reach the file
      try { flushHeld(); } catch (e) {}
      try { vEnc.close(); } catch (e) {}
      try { aEnc.close(); } catch (e) {}
      try { muxer.finalize(); } catch (e) {}
      if (eng.onstop) { try { eng.onstop(); } catch (e) {} }
    };
    /**
     * AUTO-FIT: run the picture at a different bitrate, WITHOUT interrupting
     * anything.
     *
     * This is the whole point of owning the encoder in the app. The hub
     * cannot do it (its bitrate is an argument to a running ffmpeg — changing
     * it means restarting, and every destination sees that); WebCodecs can be
     * re-configured in place, and the frames already queued finish at the old
     * rate before the new one takes over.
     *
     * Only the BITRATE moves. Size, frame rate, codec and profile stay exactly
     * as they were, so the picture the platform is decoding never changes
     * shape — a resolution change mid-broadcast is a re-negotiation, and that
     * IS the stutter this exists to remove. The next frame is forced to be a
     * keyframe so the platform gets a clean starting point at the new rate.
     */
    eng.setBitrate = (kbps) => {
      const want = Math.max(100, Math.round(kbps || 0)) * 1000;
      if (!vCfg || !vEnc || vEnc.state !== 'configured' || stopping || failed) return false;
      if (want === vCfg.bitrate) return true;
      try {
        vCfg = { ...vCfg, bitrate: want };
        vEnc.configure(vCfg);
        keyAt = null;        // …and start the new rate on a keyframe
        eng.videoKbps = Math.round(want / 1000);
        /*
         * The pad follows the encoder — and stands down entirely while the
         * encoder is running BELOW WHAT THE PLATFORM CHARGES for this picture,
         * not below the rate the broadcast was planned at. With the plan at
         * 4770 and YouTube's price 4500, one auto-fit step used to put the pad
         * away while the stream was still perfectly affordable, and a
         * motionless verse slide instantly collapsed to what it really
         * compresses to — 187 kbps on this machine's software encoder. That is
         * the whole low-bitrate warning, arriving in the middle of a service
         * that started clean.
         *
         * Between the platform's price and the plan, padding is exactly right:
         * it costs a few hundred kbps the line has already been shown to carry
         * and it keeps the stream compliant. Below the price it is switched
         * off — there the line HAS given up, filler cannot answer a complaint
         * about the picture SIZE, and insisting cost a measured 5-second
         * freeze and a keyframe gap past what platforms accept.
         */
        if (filler && !filler.disabled) {
          const floor = cfg.padFloorKbps || cfg.padKbps || 0;
          if (eng.videoKbps < floor) filler.suspend(); else filler.resume();
          filler.retarget(eng.videoKbps);
        }
        return true;
      } catch (e) { return false; }
    };
    eng.videoKbps = cfg.videoKbps;
    /** What the two clocks were measured to be, and what the pumps saw. */
    eng.clockDiag = () => ({
      vEpochMs: clk.vEpoch, aEpochMs: clk.aEpoch, primed: clk.ready,
      vSeen: clk.vSeen, aSeen: clk.aSeen, vShed: clk.vShed, held: clk.held.length,
      wallMs: clk.aLastAt ? clk.aLastAt - clk.t0 : 0,
      // seconds of sound that arrived, versus the span its own timestamps
      // claim, versus the span the ENCODER then handed to the muxer
      aDeliveredS: clk.aFrames / (cfg.sampleRate || 48000),
      aInSpanS: clk.aInFirst == null ? 0 : (clk.aInLast - clk.aInFirst) / 1e6,
      aOutSpanS: clk.aOutFirst == null ? 0 : (clk.aOutLast - clk.aOutFirst) / 1e6,
      vOutSpanS: clk.vOutFirst == null ? 0 : (clk.vOutLast - clk.vOutFirst) / 1e6,
      aOut: clk.aOut, vOut: clk.vOut,
      // Whether the constant-rate grid is actually being held (see clk above).
      paced: clk.paced, filledSlots: clk.filled, missedSlots: clk.missed,
      // The sound card's rate against real time, and the resampling now
      // taking it off the sound (see "THE SOUND IS PUT ON REAL TIME").
      audioRate, audioRatePpm: aTrusted ? (audioRate - 1) * 1e6 : 0,
      audioMeasPpm: aRateMeas ? (aRateMeas - 1) * 1e6 : null,
      audioRateBaselineS: aRateSpan / 1000,
      resampleStepPpm: (rs.step - 1) * 1e6, resampleCatchPpm: rs.catchPpm,
      audioInS: rs.inTotal / SR, audioOutS: rs.outTotal / SR,
      queue: vEnc && vEnc.state === 'configured' ? vEnc.encodeQueueSize : -1,
    });
    return eng;
  }

  return { create };
})();
