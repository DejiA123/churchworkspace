'use strict';
/*
 * Does the sound sit on the picture in a file the app produced?
 *
 * ONE copy of this measurement, shared by every test that asks the question.
 * There used to be two, and they drifted: the same three mistakes below had to
 * be found twice, and a broadcast that was actually in sync was reported as
 * two seconds out.
 *
 * The program input (`__test.addAvPulse`) flashes white and beeps in the SAME
 * tick, so the source carries no offset of its own and whatever gap turns up
 * here belongs to the app — through the compositor, the encoder, the hub and
 * the push.
 *
 * Three things this gets right, each of which produced a confident wrong
 * answer when it was got wrong:
 *
 *  1. PAIRING BY CORRELATION, not by nearest neighbour. When a machine drops
 *     frames, some flashes never reach the stream at all, and the nearest beep
 *     to a surviving flash can belong to a different pulse entirely — which
 *     invents a 680 ms error sitting next to a perfectly good average. Slide
 *     one train against the other instead and keep the shift that lines up the
 *     most pulses; missing entries simply do not vote.
 *
 *  2. UNEVENLY SPACED PULSES (addAvPulse's job). Against an evenly spaced
 *     train that slide has no unique answer: "the sound is 0.8s late" and "the
 *     sound is 1.2s early" fit a 2s-spaced recording equally well, and the
 *     measurement quietly reports whichever is nearer zero.
 *
 *  3. ONE TIMELINE FOR BOTH TRAINS. Decoding throws timestamps away, so each
 *     extraction has to be made to start at the file's zero:
 *       • video — `fps=N` already pads the head, duplicating the first frame
 *         back to time zero, so a frame index IS absolute time. Verified, not
 *         assumed: a stream whose video starts 1.9s in still yields the file's
 *         whole duration in frames. Adding the stream's own start_time on top
 *         (the obvious-looking correction) counts it twice and reports a
 *         perfectly aligned broadcast as ~2s out of sync.
 *       • audio — `first_pts=0` pads it the same way deliberately, and
 *         `async=1` fills any hole in the MIDDLE rather than closing it up. A
 *         dropout that shortened the audio would otherwise slide every later
 *         beep earlier and read as the sync drifting away.
 *     (The two streams starting at different points in a file is normal: a
 *     live push begins with whichever packet lands first, and a destination
 *     that joins mid-service starts its video at the next keyframe.)
 */
const { execFileSync } = require('child_process');

const VFPS = 60;   // resample the picture finer than its own frame rate

/** Times (s) where a series crosses `thr` upward, de-bounced to one per pulse. */
function risingEdges(series, rate, thr) {
  const out = [];
  let armed = true;
  for (let i = 1; i < series.length; i++) {
    if (armed && series[i] >= thr && series[i - 1] < thr) { out.push(i / rate); armed = false; }
    if (!armed && series[i] < thr * 0.5) armed = true;
  }
  return out;
}

function flashTimes(ff, file) {
  try {
    const b = execFileSync(ff, ['-v', 'error', '-i', file, '-vf', `fps=${VFPS},scale=16:9,format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
    const per = 16 * 9, lum = [];
    for (let i = 0; i + per <= b.length; i += per) {
      let s = 0; for (let j = 0; j < per; j++) s += b[i + j];
      lum.push(s / per);
    }
    return risingEdges(lum, VFPS, 90);      // dark → white
  } catch (e) { return []; }
}

function beepTimes(ff, file, sr = 48000) {
  try {
    const b = execFileSync(ff, ['-v', 'error', '-i', file, '-vn', '-af', 'aresample=async=1:first_pts=0',
      '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
    const pcm = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
    const hop = Math.round(sr / 1000), env = [];      // 1ms envelope
    for (let i = 0; i + hop <= pcm.length; i += hop) {
      let m = 0; for (let j = 0; j < hop; j++) m = Math.max(m, Math.abs(pcm[i + j]));
      env.push(m);
    }
    return risingEdges(env, 1000, 0.12);
  } catch (e) { return []; }
}

const stats = (a) => {
  if (!a.length) return { n: 0, mean: 0, sd: 0, max: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return {
    n: a.length, mean,
    sd: Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length),
    max: Math.max(...a.map(Math.abs)),
  };
};

/**
 * @returns {{shiftMs, meanMs, hits, flashes, beeps, sd, maxMs, driftMsPerMin}}
 *   shiftMs < 0 means the SOUND ARRIVES EARLY (ahead of the picture), which is
 *   the direction people notice soonest — ITU-R BT.1359 puts detectability at
 *   45 ms for sound leading against 125 ms for sound lagging.
 */
function avOffset(ff, file, { search = 2.0, tol = 0.05 } = {}) {
  const flashes = flashTimes(ff, file);
  const beeps = beepTimes(ff, file);
  let shift = 0, hits = -1;
  for (let s = -search; s <= search; s += 0.005) {
    let h = 0;
    for (const f of flashes) if (beeps.some((b) => Math.abs(b - (f + s)) <= tol)) h++;
    if (h > hits) { hits = h; shift = s; }
  }
  const resid = [], at = [];
  for (const f of flashes) {
    let near = null;
    for (const b of beeps) {
      const d = b - (f + shift);
      if (Math.abs(d) <= tol && (near == null || Math.abs(d) < Math.abs(near))) near = d;
    }
    if (near != null) { resid.push((shift + near) * 1000); at.push(f); }
  }
  // Least-squares slope of the residual against time. A broadcast whose sound
  // slides away from the picture over an hour is a different fault from one
  // that is simply offset, and only the slope tells them apart. Fitted to a
  // dozen pulses read off a 60fps grid it resolves about ±40 ms/min and no
  // better — a net for a gross regression, not a precision instrument.
  let drift = 0;
  if (resid.length >= 4) {
    const mt = at.reduce((a, b) => a + b, 0) / at.length;
    const mr = resid.reduce((a, b) => a + b, 0) / resid.length;
    let num = 0, den = 0;
    for (let i = 0; i < resid.length; i++) { num += (at[i] - mt) * (resid[i] - mr); den += (at[i] - mt) ** 2; }
    drift = den ? (num / den) * 60 : 0;
  }
  const rs = stats(resid);
  return {
    shiftMs: shift * 1000, meanMs: rs.mean, hits, flashes, beeps,
    sd: rs.sd, maxMs: rs.max, driftMsPerMin: drift,
  };
}

/** One-line summary plus the raw trains, which are what you read when it disagrees with you. */
function report(av, label) {
  console.log(`    ${label} flashes: ` + av.flashes.map((x) => x.toFixed(2)).join(' '));
  console.log(`    ${label} beeps:   ` + av.beeps.map((x) => x.toFixed(2)).join(' '));
  console.log(`    ${av.flashes.length} flashes, ${av.beeps.length} beeps · A/V offset ${av.shiftMs.toFixed(0)} ms `
    + `(${av.hits} pulses agree, spread ±${av.sd.toFixed(0)} ms, drift ${av.driftMsPerMin.toFixed(0)} ms/min)`);
}

module.exports = { avOffset, report, flashTimes, beepTimes, risingEdges, VFPS };
