'use strict';
/*
 * AudioWorklet processor for NDI audio inputs. Runs on the audio render thread
 * so heavy main-thread work (canvas compositing, JPEG draws) can never glitch
 * it. It holds a small cushion of what the sender has sent and plays it out at
 * the graph's sample rate.
 *
 * TWO CLOCKS, AND WHY THIS IS A RESAMPLER
 *
 * The sender's audio clock (Ableton's interface, a desk, a camera) and this
 * machine's sound card are two different crystals. "48000 Hz" on one is never
 * exactly 48000 Hz on the other, so a buffer read at exactly the rate it is
 * written drifts one way for the whole service and eventually runs dry or
 * overflows. The read position therefore moves at a rate very slightly
 * different from 1 — the sender's rate measured in the card's samples — and
 * lands between input samples, which is what makes this a resampler.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT CRACKLED A FEW MINUTES IN
 *
 * The read rate used to be decided afresh every 128 samples from the buffer's
 * depth at that instant: exactly 1.0 inside a band of ±35% of the target, and
 * a full ±2% the moment the depth left it. A fixed offset between the two
 * clocks carries the depth steadily toward one edge of that band — at 100 ppm
 * it takes about three and a half minutes — and from then on for the rest of
 * the service it sits ON the edge, where delivery jitter knocks the rate
 * between 1.00 and 0.98 (or 1.02) several times a second. Each flip is a
 * 34-cent pitch lurch for a few milliseconds. Simulated with the real file:
 * a spotless tone for the first three minutes, then the same tone with
 * distortion 13 dB below it, over and over, until the service ended.
 * "It sounds fine and then it crackles" is that sentence exactly.
 *
 * WHAT IT IS NOW
 *
 *  - The rate follows a SMOOTH control loop: the depth is averaged over about
 *    a second (so a burst of delivery is not mistaken for a clock), and a
 *    proportional-integral controller turns the averaged error into a read
 *    rate that never moves more than ±0.5% from the sender's nominal rate —
 *    a church PC's card was measured 0.12% out, so the room is needed — and
 *    it moves slowly, which is what makes it inaudible. The integral
 *    term converges on the true offset between the two crystals, so in steady
 *    state the rate simply IS that offset and stops moving at all.
 *  - Reading between samples is done with a 32-tap windowed-sinc kernel,
 *    interpolated between 256 precomputed phases. Its response is flat to
 *    ~20 kHz whatever the fractional position, so a read position that crawls
 *    forever — which a real clock offset guarantees — changes nothing you can
 *    hear. (The four-point cubic this replaced was a filter whose treble
 *    depended on the position, which is why the old design froze the rate in
 *    a band at all; that freeze is what put the flips back in.) The same
 *    kernel also does any genuine rate conversion (a 44.1 kHz sender into a
 *    48 kHz bus), so there is one converter in the path, not two.
 *  - The two events that cannot be smoothed are softened instead. Running
 *    dry fades out over what is left rather than stopping dead, and fades in
 *    again on resume; a backlog too big to slew away is skipped with a short
 *    crossfade. A hard edge in a waveform is a click; a 5 ms fade is not.
 *
 * WHERE THE SOUND COMES FROM
 *
 * Normally straight from the NDI receiver process: live.js hands this
 * processor the receiver's audio MessagePort (`{cmd:'route', port}`), so the
 * sound never passes through the renderer's main thread, which is compositing
 * video and is the one thing on the machine that can stall for 100 ms at a
 * time. If a host cannot transfer a port, the main thread relays packets as
 * `{l, r, sr}` exactly as it always did.
 *
 * The cushion ADAPTS, as before: it grows 30 ms each time the sound actually
 * runs out (cap 260) and gives 10 ms back per clean half-minute. Its live depth is
 * reported to the renderer ~8x/s — that IS the input's audio latency, which
 * the A/V sync controller needs as a real number, not a guess.
 *
 * Loaded same-origin (see live.js ensureNdiWorklet) so it satisfies the app's
 * script-src 'self' CSP — a blob: URL would be blocked.
 */
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/* ------------------------------ the kernel ------------------------------ */
const TAPS = 32;          // 16 input samples either side of the read position
const HALF = TAPS / 2;
const PHASES = 256;       // precomputed sub-sample positions (interpolated between)

function besselI0(x) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) { term *= q / (k * k); sum += term; if (term < sum * 1e-13) break; }
  return sum;
}

/**
 * Kaiser-windowed sinc, one row per phase plus a closing row (phase 1.0) so a
 * read can interpolate between rows without a special case. `cutoff` is in
 * cycles per INPUT sample; 0.5 keeps the whole band, and at phase 0 the kernel
 * is then an exact unit impulse — a read that lands on a sample returns it.
 * Each row is normalised to unity DC gain, so the level cannot ripple as the
 * phase rotates.
 */
function buildKernel(cutoff) {
  const BETA = 8.6;                       // ~ -85 dB side lobes
  const i0b = besselI0(BETA);
  const tbl = new Float32Array((PHASES + 1) * TAPS);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let t = 0; t < TAPS; t++) {
      const x = t - (HALF - 1) - frac;     // this tap's distance from the read position
      const a = 2 * cutoff * x;
      const sinc = Math.abs(a) < 1e-9 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
      const r = x / HALF;
      const w = r <= -1 || r >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
      const v = sinc * w;
      tbl[p * TAPS + t] = v;
      sum += v;
    }
    if (sum) for (let t = 0; t < TAPS; t++) tbl[p * TAPS + t] /= sum;
  }
  return tbl;
}
const kernels = new Map();
function kernelFor(step) {
  // Reading faster than 1 input sample per output sample is DOWNsampling and
  // must band-limit to the output's Nyquist or the top octave folds back. The
  // ±0.2% clock trim alone never needs that (it would fold only 24.00-24.05
  // kHz), so anything within half a percent keeps the full band.
  const cutoff = step <= 1.005 ? 0.5 : (0.5 / step) * 0.96;
  const key = cutoff.toFixed(5);
  let k = kernels.get(key);
  if (!k) { k = buildKernel(cutoff); kernels.set(key, k); }
  return k;
}
kernelFor(1);             // built at load, not on the audio thread's first packet

/* ------------------------------ the loop -------------------------------- */
const LEVEL_TAU_S = 1.0;  // depth is averaged over about this long
const KP = 0.05;          // per second of depth error
const KI = 0.001;         // per second² — ζ ≈ 0.8, time constant ~40 s
const MAX_TRIM = 0.005;   // ±0.5%: a real church PC's card was 0.12% out; 8.6 cents at the very edge
const SKIP_S = 0.15;      // a backlog beyond target + this is skipped, not slewed
const FADE = 240;         // 5 ms at 48 kHz: the edge of a dropout or a skip
const XFADE = 480;        // 10 ms crossfade when skipping a backlog
const STARTUP_S = 10;     // dropouts this soon after the first sound do not grow the cushion

class NdiAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    // Ring, MIRRORED: every sample is written twice, `size` apart, so the 32
    // taps of a read are always one contiguous run with no wrap to test.
    this.size = 1 << 18;                  // 5.4 s at 48 kHz
    this.mask = this.size - 1;
    this.L = new Float32Array(this.size * 2);
    this.R = new Float32Array(this.size * 2);
    this.wr = 0;              // total input samples written (absolute)
    this.wi = 0;              // write index in the ring
    this.rd = HALF - 1;       // read position, absolute input samples, FRACTIONAL
    this.srcRate = sampleRate;
    this.nominal = 1;         // input samples per output sample, before any trim
    this.kernel = kernelFor(1);
    this.primed = false;      // wait for the cushion before starting to play
    this.everPrimed = false;
    this.fadeIn = 0;          // samples of fade-in still to apply after a (re)start
    this.xf = null;           // an in-progress skip: { pos, n }
    this.underruns = 0;       // samples of silence output because nothing had arrived
    this.underrunEvents = 0;
    this.startupDropouts = 0; // of which in the first STARTUP_S (see onUnderrun)
    this.firstPrimedAt = -1;
    this.skips = 0;
    this.played = 0;          // our own clock, in samples (works under test too)
    this.lastUnderrunAt = 0;
    this.lastSkipAt = -1e9;
    this.lastShrinkAt = 0;
    this.minTarget = clamp(Number(o.targetMs) || 60, 20, 400);
    this.maxTarget = 260;
    this.setTarget(this.minTarget);
    this.maxTrim = MAX_TRIM;
    this.level = 0;           // averaged depth, seconds
    this.integ = 0;           // the integral term: converges on the clock offset
    this.trim = 0;            // the trim in force (reported, ppm)
    this.rx = 0; this.fed = 0; this.maxGap = 0; this.lastRxAt = -1; this.arrN = 0;
    this.lastTs = 0; this.maxTsGap = 0; this.lastAt = 0; this.maxAtGap = 0;
    this.src = null;          // the receiver's own port, when routed here
    this.reportEvery = Math.max(1, Math.round(sampleRate / 128 / 8)); // ~8 Hz
    this.tick = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.cmd === 'target') { this.setTarget(d.targetMs); return; }
      if (d.cmd === 'reset') { this.rd = this.wr + HALF - 1; this.primed = false; return; }
      if (d.cmd === 'route') { this.route(d.port); return; }
      if (d.cmd === 'close') { this.closeSrc(); return; }
      const l = d.l, r = d.r;
      if (!l || !r) return;
      this.push(l, r, d.sr);
    };
  }

  /* ------------------------- where packets come from ------------------------ */
  route(port) {
    this.closeSrc();
    this.src = port || null;
    if (this.src) {
      this.src.onmessage = (e) => this.onPacket(e.data);
      try { this.src.start(); } catch (err) {}
    }
    // Acknowledged on the node's own port, so the main thread KNOWS the sound
    // is coming here rather than assuming it.
    try { this.port.postMessage({ routed: !!this.src }); } catch (err) {}
  }
  closeSrc() {
    if (!this.src) return;
    try { this.src.onmessage = null; this.src.close(); } catch (e) {}
    this.src = null;
  }
  /** A packet straight from the NDI receiver process (see ndi-proc.js). */
  onPacket(m) {
    if (!m) return;
    if (m.kind === 'mix') {                // what the downmix did: the main thread reports it
      try { this.port.postMessage(m); } catch (e) {}
      return;
    }
    if (m.kind !== 'audio' || !m.left || !m.right) return;
    const l = floats(m.left), r = floats(m.right);
    /*
     * Where a delivery gap happened. `ts` is the SENDER's clock (100 ns
     * units), `at` the receiver process's; `maxGap` below is our own. A gap in
     * all three is the sender; in `at` and ours but not `ts`, the receiver
     * process; only in ours, the hop from that process to this thread.
     */
    if (m.ts) { if (this.lastTs) this.maxTsGap = Math.max(this.maxTsGap, (m.ts - this.lastTs) / 1e4); this.lastTs = m.ts; }
    if (m.at) { if (this.lastAt) this.maxAtGap = Math.max(this.maxAtGap, m.at - this.lastAt); this.lastAt = m.at; }
    // The sender's timestamp and the moment it reached us, on the context's
    // clock, for the A/V sync controller. A few a second is plenty — it keeps
    // a median of forty.
    if (m.ts && (++this.arrN % 3 === 0)) {
      try { this.port.postMessage({ arr: 1, ts: m.ts, ct: nowS(this) }); } catch (e) {}
    }
    this.push(l, r, m.sampleRate);
  }

  setTarget(ms) {
    this.targetMs = clamp(Number(ms) || 60, 10, 400);
    this.target = this.targetMs / 1000;   // seconds
  }
  /*
   * The sound ran out: carry a bigger cushion so it does not happen again.
   *
   * EXCEPT while the feed is still settling. The first seconds of a receiver
   * are not the network: the NDI connection is negotiating, and on a two-core
   * machine the broadcast's encoders are starting in the same moment. Measured
   * in test:ndi-longrun: five dropouts in the first five seconds and none in
   * the six minutes after — but each had grown the cushion, to 210 ms, and it
   * then took a quarter of an hour to give that back. Every one of those
   * minutes the sound sat later than wherever the operator had set lip-sync.
   * So a dropout inside the first STARTUP_S is counted and reported, and does
   * not grow the cushion; one after it does.
   */
  onUnderrun() {
    this.underrunEvents++;
    const t = this.played / sampleRate;
    this.lastUnderrunAt = t;
    this.lastShrinkAt = t;
    if (this.firstPrimedAt >= 0 && t - this.firstPrimedAt < STARTUP_S) { this.startupDropouts++; return; }
    if (this.targetMs < this.maxTarget) this.setTarget(Math.min(this.maxTarget, this.targetMs + 30));
  }
  /** Clean for a long stretch: give the latency back, slowly. */
  maybeShrink() {
    if (this.targetMs <= this.minTarget) return;
    const t = this.played / sampleRate;
    if (t - this.lastShrinkAt < 30) return;
    this.lastShrinkAt = t;
    this.setTarget(Math.max(this.minTarget, this.targetMs - 10));
  }

  push(l, r, sr) {
    const rate = Number(sr) || sampleRate;
    if (rate !== this.srcRate) this.setSourceRate(rate);
    const n = l.length;
    const size = this.size, mask = this.mask, Lb = this.L, Rb = this.R;
    let w = this.wi;
    for (let i = 0; i < n; i++) {
      const a = l[i], b = r[i];
      Lb[w] = a; Lb[w + size] = a;
      Rb[w] = b; Rb[w + size] = b;
      w = (w + 1) & mask;
    }
    this.wi = w;
    this.wr += n;
    this.rx++; this.fed += n;
    const now = this.played;
    if (this.lastRxAt >= 0) this.maxGap = Math.max(this.maxGap, now - this.lastRxAt);
    this.lastRxAt = now;
    // Overflow (the reader stalled for seconds): keep the NEWEST audio.
    if (this.wr - this.rd > size - 8192) {
      this.rd = this.wr - this.target * this.srcRate;
      this.xf = null;
      this.fadeIn = FADE;
    }
  }

  /** A sender that changes rate starts a fresh stream: old samples are another rate's. */
  setSourceRate(rate) {
    this.srcRate = rate;
    this.nominal = rate / sampleRate;
    this.kernel = kernelFor(this.nominal);
    this.rd = this.wr + HALF - 1;
    this.primed = false; this.xf = null; this.integ = 0; this.level = 0;
  }

  /** Depth held, in seconds of the sender's audio. */
  depth() { return Math.max(0, (this.wr - this.rd) / this.srcRate); }

  /** One interpolated stereo sample at absolute input position `pos`. */
  read(pos, out, i, gain) {
    const base = Math.floor(pos);
    const f = pos - base;
    const pf = f * PHASES;
    const p0 = pf | 0;
    const a = pf - p0;
    const K = this.kernel;
    const r0 = p0 * TAPS, r1 = r0 + TAPS;
    let idx = (base - (HALF - 1)) % this.size;
    if (idx < 0) idx += this.size;
    const Lb = this.L, Rb = this.R;
    let sl = 0, sr = 0;
    for (let t = 0; t < TAPS; t++) {
      const k0 = K[r0 + t];
      const c = k0 + a * (K[r1 + t] - k0);
      sl += Lb[idx + t] * c;
      sr += Rb[idx + t] * c;
    }
    out[0][i] = sl * gain;
    out[1][i] = sr * gain;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const pair = [L, R];
    const n = L.length;
    this.played += n;
    this.maybeShrink();
    const sr = this.srcRate;
    const dt = n / sampleRate;

    if (!this.primed) {
      // Starting up, wait for the whole cushion; RESUMING after running dry,
      // half of it (the loop quietly refills the rest). Three quarters was
      // tried first: with the cushion grown to 260 ms that made every dropout
      // ~200 ms of silence on its own, measured in test:ndi-longrun.
      const need = (this.everPrimed ? Math.max(0.03, 0.5 * this.target) : this.target) * sr + HALF + 1;
      const have = this.wr - this.rd;
      if (have >= need) {
        // The very first time, a backlog that arrived before anything was
        // playing is simply skipped: nothing has been heard yet to click.
        if (!this.everPrimed && have > this.target * sr + HALF) this.rd = this.wr - this.target * sr;
        if (!this.everPrimed) { this.level = this.depth(); this.firstPrimedAt = this.played / sampleRate; }
        this.primed = true; this.everPrimed = true; this.fadeIn = FADE;
      } else {
        for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; }
        this.report();
        return true;
      }
    }

    /* The loop. Depth averaged over ~1 s, then PI on the error. */
    const d = this.depth();
    this.level += (d - this.level) * (1 - Math.exp(-dt / LEVEL_TAU_S));
    const err = this.level - this.target;
    /*
     * The integral term is the loop's estimate of the offset between the two
     * crystals, so it may only learn from what a clock offset looks like: a
     * small, slow error. A refill after a dropout, a skip, or the chaos of a
     * connection starting are big errors of the loop's own making — learning
     * from them wound the estimate to -1000 ppm against a true +200 in
     * test:ndi-longrun, and it took minutes to unwind. Big errors are left to
     * the proportional term alone (which at 20 ms already asks for 1000 ppm,
     * more than any crystal needs); the integral only ever refines.
     */
    const t = this.played / sampleRate;
    const settled = t - this.lastUnderrunAt > 5 && t - this.lastSkipAt > 5
      && this.firstPrimedAt >= 0 && t - this.firstPrimedAt > STARTUP_S;
    if (settled && Math.abs(err) < 0.02) this.integ = clamp(this.integ + KI * err * dt, -MAX_TRIM, MAX_TRIM);
    this.trim = clamp(KP * err + this.integ, -MAX_TRIM, MAX_TRIM);
    const step = this.nominal * (1 + this.trim);

    // A backlog far beyond the cushion (a burst after a stall at the SENDER)
    // would take minutes to slew away at 0.2%: skip it, crossfaded.
    if (!this.xf && d - this.target > SKIP_S) {
      this.xf = { pos: this.wr - this.target * sr, n: 0 };
      this.skips++;
      this.lastSkipAt = this.played / sampleRate;
    }

    // Will this block run dry? Then play what there is and fade it out.
    const lastReadable = this.wr - HALF - 1;
    let avail = n;
    if (this.rd + (n - 1) * step > lastReadable) {
      avail = Math.max(0, Math.floor((lastReadable - this.rd) / step) + 1);
    }
    for (let i = 0; i < avail; i++) {
      let g = 1;
      if (this.fadeIn > 0) { g = 0.5 - 0.5 * Math.cos(Math.PI * (1 - this.fadeIn / FADE)); this.fadeIn--; }
      if (avail < n) {                    // the tail of what we have: fade to nothing
        const left = avail - i;
        if (left <= FADE) g *= 0.5 - 0.5 * Math.cos(Math.PI * (left / Math.min(FADE, avail)));
      }
      if (this.xf) {
        const w = 0.5 - 0.5 * Math.cos(Math.PI * (this.xf.n / XFADE));
        this.read(this.rd, pair, i, g * (1 - w));
        const l0 = L[i], r0 = R[i];
        this.read(this.xf.pos, pair, i, g * w);
        L[i] += l0; R[i] += r0;
        this.xf.pos += step;
        if (++this.xf.n >= XFADE) { this.rd = this.xf.pos; this.xf = null; this.level = this.depth(); continue; }
      } else {
        this.read(this.rd, pair, i, g);
      }
      this.rd += step;
    }
    if (avail < n) {
      for (let i = avail; i < n; i++) { L[i] = 0; R[i] = 0; }
      this.underruns += n - avail;
      if (this.xf) { this.rd = this.xf.pos; this.xf = null; }
      this.primed = false;                // wait for sound again; nothing is discarded
      this.onUnderrun();
    }
    this.report();
    return true;
  }

  report() {
    if (++this.tick < this.reportEvery) return;
    this.tick = 0;
    try {
      this.port.postMessage({
        queueMs: this.depth() * 1000,
        targetMs: this.targetMs,
        underruns: this.underruns,
        underrunEvents: this.underrunEvents,
        startupDropouts: this.startupDropouts,
        skips: this.skips,
        trimPpm: Math.round(this.trim * 1e6),
        clockPpm: Math.round(this.integ * 1e6),
        rx: this.rx, fed: this.fed, srcRate: this.srcRate,
        maxGapMs: (this.maxGap / sampleRate) * 1000,
        senderGapMs: this.maxTsGap, receiverGapMs: this.maxAtGap,
        routed: !!this.src,
      });
    } catch (e) { /* the port can close mid-teardown */ }
  }
}

/** A packet's samples, from whatever the transport made of a Float32Array. */
function floats(v) {
  if (v instanceof Float32Array) return v;
  const buf = v.buffer || v;
  const off = v.byteOffset || 0, len = v.byteLength != null ? v.byteLength : buf.byteLength;
  if (off % 4 === 0) return new Float32Array(buf, off, len >> 2);
  return new Float32Array(buf.slice(off, off + len));
}
/** The context's clock, as the audio thread sees it (tests have no currentTime). */
function nowS(p) { return typeof currentTime === 'number' ? currentTime : p.played / sampleRate; }

registerProcessor('ndi-audio', NdiAudioProcessor);
