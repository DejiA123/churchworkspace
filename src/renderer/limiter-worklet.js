'use strict';
/*
 * The broadcast limiter — the last thing that touches the sound before it
 * leaves the building.
 *
 * WHY A WORKLET AND NOT DynamicsCompressorNode
 *
 * The web platform's compressor is a musical compressor: it reacts AFTER the
 * sound has already arrived, it applies its own hidden make-up gain, and its
 * detector follows loudness rather than peaks. That is fine for smoothing a
 * mix and useless as a safety net: the transient that matters — the first
 * consonant of a sung line, a snare, a hand on a mic — is through and into the
 * encoder before the gain has moved. The encoder then has to represent a
 * waveform that goes past full scale, and what the congregation hears on the
 * stream is the crunch of that, worst exactly when the room is loudest.
 *
 * So this is a LOOK-AHEAD limiter. The sound is held back by a few
 * milliseconds while the same few milliseconds are examined; by the time a
 * peak reaches the output the gain is ALREADY where it needs to be, and it got
 * there on a smooth ramp instead of a step (a step in gain is itself a click).
 * Nothing is ever amplified — the gain only ever goes down and comes back to
 * 1.0 — so a mix that never approaches the ceiling passes through bit for bit.
 *
 * THE CEILING IS A PROMISE. After the gain is applied the samples are clamped
 * anyway. With look-ahead working, that clamp should never do anything, so it
 * COUNTS the times it fires and reports them: a non-zero count is the limiter
 * telling on itself, not a silent fallback. (Real cause if it ever happens:
 * inter-sample content or a rate the smoother could not follow.)
 *
 * The ceiling defaults to -1 dBFS rather than 0. A stream is re-encoded at the
 * other end by the platform, and a lossy encoder's reconstructed waveform
 * overshoots the samples it was given; leaving a decibel of room is what stops
 * that overshoot becoming distortion on someone's phone.
 */

const dbToLin = (db) => Math.pow(10, db / 20);
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

class ProgramLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.chans = 2;
    // Look-ahead: how far ahead the detector can see, and therefore how long
    // the gain has to get out of the way. 5 ms is the broadcast-standard trade:
    // long enough to ramp without audible distortion, short enough that the
    // extra delay is nowhere near lip-sync territory.
    this.lookMs = clamp(Number(o.lookMs) || 5, 1, 20);
    this.look = Math.max(8, Math.round(sampleRate * (this.lookMs / 1000)));
    this.size = 1 << Math.ceil(Math.log2(this.look + 256));
    this.mask = this.size - 1;
    this.buf = [];
    for (let c = 0; c < this.chans; c++) this.buf.push(new Float32Array(this.size));
    this.wr = 0;

    /* Sliding minimum of the required gain over the look-ahead window, kept as
     * a monotonic queue: each sample enters once and leaves once, so the cost
     * does not grow with the window. A plain "scan the window" would be a few
     * hundred comparisons PER SAMPLE on the audio thread. */
    this.qv = new Float32Array(this.size);   // values, increasing
    this.qi = new Int32Array(this.size);     // the absolute sample index each came from
    this.qh = 0; this.qt = 0;                // head, tail

    /* The attack ramp, and why it is a moving AVERAGE rather than a filter.
     *
     * The window minimum above already steps down `look` samples before the
     * peak that needs it. Averaging that step over exactly `look` samples turns
     * it into a straight line that arrives at the required value at the very
     * sample the peak does — no sooner (which would duck the sound early) and
     * never later (which is the whole failure mode). It is also provably safe:
     * every value inside the average is a minimum taken over a window that
     * CONTAINS the sample being output, so the average can never exceed what
     * that sample needs. An exponential smoother has no such property — it only
     * approaches its target, so a fast enough peak always gets through, and the
     * clamp at the end of process() had to catch hundreds of samples per second
     * to hold the ceiling. That is a clipper wearing a limiter's coat. */
    // Float64 and an exact re-sum once per lap: a running total kept in a
    // different precision from the array it totals drifts, and here a drift of
    // one part in 10^7 is the difference between "the ceiling held" and "the
    // ceiling held and the safety clamp had to help".
    this.avg = new Float64Array(this.look + 1);
    this.avg.fill(1);
    this.avgSum = this.look + 1;
    this.avgPos = 0;
    this.avgPrimed = false;
    this.env = 1;                            // release-limited window minimum
    this.gain = 1;
    this.n = 0;                              // absolute samples processed

    this.setOpts(o);

    // Metering. The UI needs the numbers that let an operator SEE what the
    // limiter is doing, which is the difference between trusting it and
    // switching it off because nothing seems to happen.
    this.grMax = 0;        // most gain reduction in this reporting window (dB)
    this.inPeak = 0;       // loudest input sample
    this.outPeak = 0;      // loudest output sample
    this.hardClips = 0;    // times the guarantee clamp actually had to act
    this.overs = 0;        // input samples that would have exceeded the ceiling
    this.blocks = 0;
    this.reportEvery = 12; // ~32 ms at 128 frames/block

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.cmd === 'opts') this.setOpts(d);
      else if (d.cmd === 'resetStats') { this.hardClips = 0; this.overs = 0; }
    };
  }

  setOpts(o) {
    if (o.ceilingDb != null) this.ceilingDb = clamp(Number(o.ceilingDb), -12, 0);
    if (this.ceilingDb == null) this.ceilingDb = -1;
    this.ceiling = dbToLin(this.ceilingDb);
    // Drive pushes the mix INTO the limiter before the ceiling is applied. At
    // 0 dB (the default) this is a pure safety net that does nothing until the
    // mix would have clipped; above it, the limiter starts holding the loud
    // parts down and the service sounds more even on a phone speaker.
    if (o.driveDb != null) this.driveDb = clamp(Number(o.driveDb), 0, 12);
    if (this.driveDb == null) this.driveDb = 0;
    this.drive = dbToLin(this.driveDb);
    // Release. Too fast and a sustained loud passage is pumped up and down
    // between syllables; too slow and one snare hit ducks the next ten seconds
    // of the sermon. 120 ms is a middle that suits speech and a band alike.
    if (o.releaseMs != null) this.releaseMs = clamp(Number(o.releaseMs), 20, 2000);
    if (this.releaseMs == null) this.releaseMs = 120;
    this.relCoef = 1 - Math.exp(-1 / (sampleRate * (this.releaseMs / 1000)));
    // There is no attack dial on purpose: the attack IS the look-ahead. See the
    // moving-average note in the constructor.
    this.bypass = !!o.bypass;
  }

  /** Push one required-gain value; keep the queue increasing. */
  _push(v, idx) {
    let t = this.qt;
    while (t !== this.qh) {
      const p = (t - 1) & this.mask;
      if (this.qv[p] <= v) break;
      t = p;
    }
    this.qv[t] = v; this.qi[t] = idx;
    this.qt = (t + 1) & this.mask;
  }
  /** Drop anything that has fallen out of the window ending at `idx`. */
  _pop(idx) {
    while (this.qh !== this.qt && this.qi[this.qh] < idx) this.qh = (this.qh + 1) & this.mask;
  }

  process(inputs, outputs) {
    const inp = inputs[0] || [];
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    const iL = inp[0] || null;
    const iR = inp[1] || iL;
    const ceiling = this.ceiling;
    const drive = this.drive;
    const bufL = this.buf[0], bufR = this.buf[1];

    for (let i = 0; i < n; i++) {
      const l = (iL ? iL[i] : 0) * drive;
      const r = (iR ? iR[i] : 0) * drive;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      const peak = al > ar ? al : ar;
      if (peak > this.inPeak) this.inPeak = peak;
      if (peak > ceiling) this.overs++;

      // write into the delay line
      const w = this.wr & this.mask;
      bufL[w] = l; bufR[w] = r;
      this.wr++;

      // the gain this sample will need when it comes out, look-ahead later
      const req = peak > ceiling ? ceiling / peak : 1;
      this._push(req, this.n);

      // Read the sample that entered `look` samples ago; the window minimum
      // now covers everything from that sample up to the newest one — i.e.
      // exactly the future of the sample about to leave.
      const outIdx = this.n - this.look;
      let y0 = 0, y1 = 0;
      if (outIdx >= 0) {
        this._pop(outIdx);
        const target = this.qh === this.qt ? 1 : this.qv[this.qh];
        // Fall to whatever the next few milliseconds demand at once; come back
        // up only at the release rate, so one snare hit does not duck the next
        // ten seconds of the sermon and a sustained passage is not chopped
        // between syllables.
        const rise = this.env + (1 - this.env) * this.relCoef;
        this.env = target < rise ? target : rise;
        if (!this.avgPrimed) {
          /* The averaging window has no past on the very first output sample,
           * and filling it with 1.0 would be a LIE about that past: the samples
           * "before" it are the ones whose look-ahead windows already contain
           * the loud opening, so their true value is low, not 1. Seeding the
           * whole window with the first real value tells the truth and keeps
           * the ceiling guaranteed from sample zero — otherwise a broadcast
           * that opens on a loud chord clips for its first five milliseconds. */
          this.avg.fill(this.env);
          this.avgSum = this.env * (this.look + 1);
          this.avgPrimed = true;
        } else {
          this.avgSum += this.env - this.avg[this.avgPos];
          this.avg[this.avgPos] = this.env;
          this.avgPos = this.avgPos + 1 > this.look ? 0 : this.avgPos + 1;
          if (this.avgPos === 0) {           // one lap: re-total exactly
            let s = 0;
            for (let k = 0; k <= this.look; k++) s += this.avg[k];
            this.avgSum = s;
          }
        }
        this.gain = this.avgSum / (this.look + 1);
        const rd = (this.wr - 1 - this.look) & this.mask;
        y0 = bufL[rd] * this.gain;
        y1 = bufR[rd] * this.gain;
        const gr = this.gain < 1 ? -20 * Math.log10(this.gain) : 0;
        if (gr > this.grMax) this.grMax = gr;
      }
      /* The promise. Look-ahead means this should be a no-op; when it is not,
       * say so rather than hiding it — but only count an overshoot bigger than
       * one step of 16-bit audio, since an excess of 10⁻¹² is arithmetic, not
       * a sound anything could ever reproduce. */
      const tol = ceiling + 3e-5;
      if (y0 > ceiling) { if (y0 > tol) this.hardClips++; y0 = ceiling; }
      else if (y0 < -ceiling) { if (y0 < -tol) this.hardClips++; y0 = -ceiling; }
      if (y1 > ceiling) { if (y1 > tol) this.hardClips++; y1 = ceiling; }
      else if (y1 < -ceiling) { if (y1 < -tol) this.hardClips++; y1 = -ceiling; }

      if (this.bypass) { y0 = iL ? iL[i] : 0; y1 = iR ? iR[i] : 0; }
      oL[i] = y0; oR[i] = y1;
      const ao = (y0 < 0 ? -y0 : y0), ao1 = (y1 < 0 ? -y1 : y1);
      if (ao > this.outPeak) this.outPeak = ao;
      if (ao1 > this.outPeak) this.outPeak = ao1;
      this.n++;
    }

    if (++this.blocks >= this.reportEvery) {
      this.blocks = 0;
      try {
        this.port.postMessage({
          grDb: this.grMax, inPeak: this.inPeak, outPeak: this.outPeak,
          hardClips: this.hardClips, overs: this.overs,
          ceilingDb: this.ceilingDb, driveDb: this.driveDb, latencyMs: this.lookMs,
        });
      } catch (e) { /* the port can close mid-teardown */ }
      this.grMax = 0; this.inPeak = 0; this.outPeak = 0;
    }
    return true;
  }
}

registerProcessor('program-limiter', ProgramLimiter);
