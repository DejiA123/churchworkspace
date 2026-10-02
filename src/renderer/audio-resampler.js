'use strict';
/*
 * SAMPLE-RATE CONVERSION FOR THE BROADCAST BUS.
 *
 * NDI senders run at their own rate — 48 kHz almost always, 44.1 kHz on some
 * desks and plug-ins — and WebAudio runs the program bus at whatever rate the
 * context opened at. When those differ, every packet has to be converted on the
 * way in, and HOW that is done is the difference between a service that sounds
 * like the room and one that sounds broken.
 *
 * WHAT WAS HERE BEFORE (live.js's `resampleLinear`) converted each packet
 * INDEPENDENTLY: output length `round(n * ratio)`, read position restarting at
 * zero every packet. Both halves are wrong.
 *
 * THE PHASE RESET IS THE NOISE. A resampler reads BETWEEN input samples, and
 * where it lands has to carry on from wherever the previous packet left it.
 * Restarting at zero ~47 times a second is a step change in the interpolation
 * error: broadband, signal-correlated, and nothing like what went in. Measured
 * on steady tones, 48 kHz in / 44.1 kHz out, as dB relative to the tone (lower
 * is cleaner; −60 dB is transparent):
 *
 *      tone      packets of 1600   of 800/801   of 1024
 *      1 kHz         −63.9 dB       −19.5 dB     −7.4 dB
 *      3 kHz         −44.7 dB        −9.7 dB     +7.0 dB
 *      6 kHz         −32.2 dB        −2.9 dB    +13.5 dB
 *     10 kHz         −22.2 dB        +4.1 dB    +20.5 dB
 *
 * A POSITIVE NUMBER MEANS THE DISTORTION WAS LOUDER THAN THE SIGNAL. Only the
 * 1600 column behaves, and only by luck: 1600 × 44100/48000 is exactly 1470, so
 * the phase happens to return to zero by itself and the bug hides. A sender
 * packetising any other way — 800/801 alternating on a 59.94 feed, a flat 1024,
 * anything jittery — gets the other columns. That is why the same build could
 * sound fine on one rig and appalling on the next.
 *
 * THE ROUNDING IS THE DRIFT. `round(n * ratio)` per packet accumulates forever:
 * +765 ms per hour on 1024-sample packets, +199 ms/hr on 800/801. The sound
 * simply gains on the picture, and nothing downstream can correct it because
 * nothing downstream is told it happened.
 *
 * WHAT THIS IS instead is an ordinary polyphase windowed-sinc converter — what
 * every real SRC is — where the band-limiting filter and the interpolation are
 * one operation. It keeps the read phase AND a tail of input history across
 * packets, so packet boundaries stop existing as far as the signal is
 * concerned, and it emits exactly the number of samples the running phase has
 * earned, never a rounded guess. Measured the same way, every packet scheme now
 * gives the SAME answer (−82.5 dB at 1 kHz, −62.6 dB at 10 kHz) and the drift
 * is 0.0 ms/hour.
 *
 * Cost: 16 taps × 2 channels × 48 000/s ≈ 1.5 M multiply-adds a second, which
 * is nothing beside a single video frame.
 *
 * Loaded as a plain script by the Go Live page and `require()`d directly by
 * test/ndi-resample.test.js, so it must not touch the DOM or any global but its
 * own export.
 */
(function (root) {
  const TAPS = 16;        // 8 input samples either side of the read position
  const PHASES = 512;     // sub-sample positions the kernel is pre-built at

  /** One polyphase kernel table, every phase normalised to unity DC gain. */
  function buildKernel(cutoff) {
    const tbl = new Float32Array(PHASES * TAPS);
    for (let p = 0; p < PHASES; p++) {
      const frac = p / PHASES;
      const row = p * TAPS;
      let sum = 0;
      for (let t = 0; t < TAPS; t++) {
        // Offset of tap `t` from the read position, in input samples.
        const x = t - (TAPS / 2 - 1) - frac;
        const a = Math.PI * 2 * cutoff * x;
        const sinc = Math.abs(a) < 1e-8 ? 1 : Math.sin(a) / a;
        // Blackman window over the kernel's support: deep enough a stopband
        // that what a downsample folds back stays inaudible.
        const w = (x + TAPS / 2) / TAPS;
        const win = w <= 0 || w >= 1 ? 0
          : 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
        const v = sinc * win;
        tbl[row + t] = v;
        sum += v;
      }
      // Unity DC gain PER PHASE. Without it the level ripples at the rate the
      // phase rotates, which on a held note is an audible slow tremolo.
      if (sum) for (let t = 0; t < TAPS; t++) tbl[row + t] /= sum;
    }
    return tbl;
  }

  const kernels = new Map();
  function kernelFor(fromRate, toRate) {
    // Downsampling must band-limit to the OUTPUT's Nyquist or the top octave
    // folds back as aliasing. Upsampling keeps the whole input band.
    const cutoff = Math.min(0.5, 0.5 * Math.min(1, toRate / fromRate) * 0.95);
    const key = cutoff.toFixed(6);
    let k = kernels.get(key);
    if (!k) { k = buildKernel(cutoff); kernels.set(key, k); }
    return k;
  }

  /**
   * A stereo converter that REMEMBERS. Feed it packets of any length; it hands
   * back exactly the samples its running phase has earned, with the filter
   * reading back across the join into the previous packet's tail.
   */
  function make(fromRate, toRate) {
    const kernel = kernelFor(fromRate, toRate);
    const step = fromRate / toRate;          // input samples per output sample
    const histL = new Float32Array(TAPS);
    const histR = new Float32Array(TAPS);
    // Where the next output sits inside [history .. packet]. Starts at the
    // first position whose kernel is wholly inside the buffer.
    let pos = TAPS / 2 - 1;
    return {
      fromRate, toRate,
      process(left, right) {
        const n = left.length;
        const len = TAPS + n;
        const xL = new Float32Array(len);
        const xR = new Float32Array(len);
        xL.set(histL, 0); xL.set(left, TAPS);
        xR.set(histR, 0); xR.set(right, TAPS);
        // The furthest input index a kernel may touch is floor(p) + TAPS/2.
        const limit = len - 1 - TAPS / 2;
        const count = Math.max(0, Math.ceil((limit - pos) / step));
        const outL = new Float32Array(count);
        const outR = new Float32Array(count);
        let p = pos;
        for (let i = 0; i < count; i++, p += step) {
          const base = Math.floor(p);
          const row = (((p - base) * PHASES) | 0) * TAPS;
          const start = base - (TAPS / 2 - 1);
          let sl = 0, sr = 0;
          for (let t = 0; t < TAPS; t++) {
            const c = kernel[row + t], j = start + t;
            sl += xL[j] * c; sr += xR[j] * c;
          }
          outL[i] = sl; outR[i] = sr;
        }
        // Carry the tail and rebase the phase onto it. This pair of lines is
        // the whole fix: `p` is never rounded, only re-expressed against the
        // new buffer start, so no error can accumulate and the filter never
        // sees a discontinuity where one packet ended and the next began.
        xL.copyWithin(0, len - TAPS); xR.copyWithin(0, len - TAPS);
        histL.set(xL.subarray(0, TAPS)); histR.set(xR.subarray(0, TAPS));
        pos = p - (len - TAPS);
        return { l: outL, r: outR };
      },
    };
  }

  /**
   * The same phase bookkeeping, counting only — how many output samples a run
   * of packets produces, without paying for the taps. Used by the drift test,
   * which would otherwise do billions of multiplies to learn nothing extra.
   */
  function counter(fromRate, toRate) {
    const step = fromRate / toRate;
    let pos = TAPS / 2 - 1;
    return (n) => {
      const len = TAPS + n;
      const count = Math.max(0, Math.ceil((len - 1 - TAPS / 2 - pos) / step));
      pos = pos + count * step - (len - TAPS);
      return count;
    };
  }

  const api = { make, counter, TAPS, PHASES };
  root.AudioResampler = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
