'use strict';
/*
 * Turning an NDI sender's channels into the stereo pair the mixer works with.
 *
 * This lives in its own file because it is the one piece of the NDI receive
 * path that is pure arithmetic — no FFI, no worker, no hardware — and it is
 * also the piece that can quietly ruin a service. It can therefore be tested
 * against real numbers (test/broadcast-audio.test.js) instead of being trusted.
 *
 * WHY IT IS NOT JUST "TAKE CHANNELS 1 AND 2"
 *
 * Real senders put the programme on higher pairs. Ableton's NDI Output VST set
 * to "Stereo, 3-4" publishes four channels whose first pair is SILENT; taking
 * only channels 1-2 receives nothing at all, which is what happened at an
 * actual church install. Every pair has to be listened to.
 *
 * WHY IT IS NOT JUST "ADD THEM UP" EITHER
 *
 * Adding pairs is right when only one of them carries sound and catastrophic
 * when two do — a desk publishing the same feed on 1-2 and 3-4 is an ordinary
 * way to patch one, and the sum is then double, i.e. everything above half
 * scale hard-clips. That clip used to happen HERE, in the main process, before
 * the mixer, the fader or the limiter ever saw the sound: a square wave, the
 * harsh buzz a church hears the moment the congregation starts singing, and
 * nothing downstream can undo it.
 *
 * So the pairs that are actually carrying something are AVERAGED. Which pairs
 * those are is remembered across packets with a slow decay, never decided per
 * packet: a per-packet decision would change the divisor between one buffer and
 * the next, and a divisor that flickers is an audible pumping of the whole mix
 * during quiet passages. A pair that has been silent for about three seconds
 * stops counting; a momentary gap in one feed cannot suddenly double the other.
 */

const SILENCE = 1e-4;      // −80 dBFS: below this a pair is not carrying anything
const HALF_LIFE_S = 0.5;   // ⇒ ~3 s of silence before a pair drops out of the mix

/** Per-sender memory of which pairs have been heard from. */
function newMixState() { return { pairPeak: null, gain: null }; }

/**
 * @param floats  interleaved-by-channel plane data (channel c starts at c*perChan)
 * @param out     { left, right } Float32Array(ns), zero-filled
 * @returns       { pairs, active, gain } — what it did, for tests and diagnostics
 */
function downmixPairs(floats, { channels, samples, perChan, sampleRate }, out, state) {
  const ch = channels, ns = samples;
  const left = out.left, right = out.right;
  if (ch === 1) {
    for (let i = 0; i < ns; i++) { left[i] = floats[i]; right[i] = floats[i]; }
    return { pairs: 1, active: 1, gain: 1 };
  }
  const pairs = Math.ceil(ch / 2);
  if (!state.pairPeak || state.pairPeak.length !== pairs) state.pairPeak = new Float32Array(pairs);
  const peaks = state.pairPeak;
  const decay = Math.pow(0.5, ns / (sampleRate || 48000) / HALF_LIFE_S);
  for (let p = 0, pi = 0; p < ch; p += 2, pi++) {
    const lBase = p * perChan;
    const rBase = (p + 1 < ch ? p + 1 : p) * perChan; // odd channel count: last one to both sides
    let peak = 0;
    for (let i = 0; i < ns; i++) {
      const l = floats[lBase + i], r = floats[rBase + i];
      left[i] += l; right[i] += r;
      const la = l < 0 ? -l : l, ra = r < 0 ? -r : r;
      if (la > peak) peak = la;
      if (ra > peak) peak = ra;
    }
    peaks[pi] = Math.max(peak, peaks[pi] * decay);
  }
  let active = 0;
  for (let pi = 0; pi < pairs; pi++) if (peaks[pi] > SILENCE) active++;
  const gain = active > 1 ? 1 / active : 1;
  /*
   * When the divisor DOES change, it glides across this packet rather than
   * stepping between two samples. A 6 dB step in the middle of a waveform is
   * a click on its own, and the one moment it happens — a second pair starting
   * or stopping — is exactly when the sound is already changing.
   */
  const from = state.gain == null ? gain : state.gain;
  state.gain = gain;
  if (from !== gain) {
    const d = (gain - from) / ns;
    for (let i = 0; i < ns; i++) { const g = from + d * (i + 1); left[i] *= g; right[i] *= g; }
  } else if (gain !== 1) {
    for (let i = 0; i < ns; i++) { left[i] *= gain; right[i] *= gain; }
  }
  return { pairs, active, gain };
}

module.exports = { downmixPairs, newMixState, SILENCE, HALF_LIFE_S };
