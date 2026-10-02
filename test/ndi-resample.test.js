'use strict';
/*
 * THE SOUND COMING OFF AN NDI FEED, MEASURED — not asserted.
 *
 * The complaint: "the audio is shocking on the stream, and the video does not
 * match the audio — one of them is faster."
 *
 * Both halves came out of one function. NDI senders run at their own rate
 * (48 kHz almost always); WebAudio runs the program bus at whatever rate the
 * sound card opened at. When those differ every packet is rate-converted on the
 * way in, and the old converter (`resampleLinear` in live.js) did it ONE PACKET
 * AT A TIME: read position restarting at zero each packet, output length
 * `round(n * ratio)` each packet.
 *
 *   - the restarting read position is the NOISE. It re-aligns the output to the
 *     input grid ~47 times a second; the interpolation error steps with it, and
 *     that error is broadband and signal-correlated.
 *   - the rounded length is the DRIFT. The error accumulates for the whole
 *     service, and nothing downstream is told, so nothing downstream can undo
 *     it: the sound simply gains on the picture.
 *
 * This test does not reason about any of that, it MEASURES it, on the real
 * shipping module, against the old algorithm reproduced verbatim below.
 *
 * WHY PACKET SIZE IS EVERY OTHER COLUMN: 1600 samples at 48 kHz becomes exactly
 * 1470 at 44.1 kHz, so with that one sender the phase returns to zero by itself
 * and the bug HIDES. Every other packetisation exposes it. That is why the same
 * build could sound perfect on one rig and appalling on the next, and it is why
 * the strongest assertion here is that the new converter gives the SAME answer
 * for all four — a converter whose quality depends on how the sender chose to
 * chop up its audio is a converter that is not working.
 *
 *   node test/ndi-resample.test.js
 */
const path = require('path');
const AudioResampler = require(path.join(__dirname, '..', 'src', 'renderer', 'audio-resampler.js'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

/* ---- THE OLD ALGORITHM, verbatim from live.js before the fix ---- */
function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, last), f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/* ---- signals and measurement ---- */
const tone = (freq, secs, sr) => {
  const n = Math.round(secs * sr), a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * freq * (i / sr));
  return a;
};
/** Energy at exactly `freq`, by Goertzel — independent of everything else. */
function goertzelMag(x, freq, sr) {
  const w = 2 * Math.PI * freq / sr, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return 2 * Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / x.length;
}
/** Everything that is NOT the tone, in dB relative to the tone. */
function thdN(x, freq, sr) {
  let tot = 0;
  for (let i = 0; i < x.length; i++) tot += x[i] * x[i];
  tot /= x.length;
  const a = goertzelMag(x, freq, sr), fund = (a * a) / 2;
  return 10 * Math.log10(Math.max(tot - fund, 1e-20) / Math.max(fund, 1e-20));
}
const trim = (x) => x.subarray(Math.round(x.length * 0.15), Math.round(x.length * 0.85));

/*
 * The four ways a real sender packetises 48 kHz audio. Only the first divides
 * evenly into 44.1 kHz, which is exactly why it is the only one the old code
 * survived.
 */
const schemes = () => ({
  '1600 (30fps-locked)': () => 1600,
  '800/801 (59.94-locked)': (() => { let i = 0; return () => (i++ % 2 ? 801 : 800); })(),
  '1024 (flat)': () => 1024,
  '1500-1700 (jittery)': (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return 1500 + (s % 201); }; })(),
});

function runOld(sig, sizeFn, fr, to) {
  const out = []; let total = 0;
  for (let p = 0; p < sig.length; ) {
    const n = Math.min(sizeFn(), sig.length - p);
    const o = resampleLinear(Float32Array.from(sig.subarray(p, p + n)), fr, to);
    out.push(o); total += o.length; p += n;
  }
  const all = new Float32Array(total); let o = 0;
  for (const c of out) { all.set(c, o); o += c.length; }
  return all;
}
function runNew(sig, sizeFn, fr, to) {
  const rs = AudioResampler.make(fr, to);
  const out = []; let total = 0;
  for (let p = 0; p < sig.length; ) {
    const n = Math.min(sizeFn(), sig.length - p);
    const s = Float32Array.from(sig.subarray(p, p + n));
    const o = rs.process(s, s);
    out.push(o.l); total += o.l.length; p += n;
  }
  const all = new Float32Array(total); let o = 0;
  for (const c of out) { all.set(c, o); o += c.length; }
  return all;
}

const FR = 48000, TO = 44100;

/* ===================================================================== */
head('[A] DISTORTION — 48 kHz NDI onto a 44.1 kHz bus');
console.log('    (dB relative to the tone. Lower is cleaner; -60 dB is transparent;');
console.log('     a POSITIVE number means the distortion was louder than the signal.)');
console.log('    tone      packets                       OLD         NEW');
{
  // A converter that works does not care how the sender chopped up the audio.
  const spread = {};
  for (const f of [1000, 3000, 6000, 10000]) {
    const S = schemes();
    const news = [];
    for (const [name, fn] of Object.entries(S)) {
      const sig = tone(f, 1.5, FR);
      const a = thdN(trim(runOld(sig, fn, FR, TO)), f, TO);
      const b = thdN(trim(runNew(sig, fn, FR, TO)), f, TO);
      news.push(b);
      console.log(`    ${(f + ' Hz').padEnd(10)}${name.padEnd(28)}${a.toFixed(1).padStart(7)}    ${b.toFixed(1).padStart(8)}`);
    }
    spread[f] = Math.max(...news) - Math.min(...news);
  }

  for (const f of [1000, 3000, 6000, 10000]) {
    check(`packet size no longer changes the sound at ${f} Hz`,
      spread[f] < 1.0, `spread across all four senders = ${spread[f].toFixed(2)} dB`);
  }

  // Absolute quality, on the packetisation that used to be catastrophic.
  const S = schemes();
  for (const [f, limit] of [[1000, -75], [3000, -68], [6000, -62], [10000, -55]]) {
    const sig = tone(f, 1.5, FR);
    const b = thdN(trim(runNew(sig, S['1024 (flat)'], FR, TO)), f, TO);
    check(`${f} Hz is clean through a 1024-sample sender`, b < limit,
      `${b.toFixed(1)} dB (must be under ${limit})`);
  }

  // …and that it is a genuine improvement, not a differently-shaped failure.
  const S2 = schemes(), S3 = schemes();
  const sig = tone(6000, 1.5, FR);
  const oldDb = thdN(trim(runOld(sig, S2['1024 (flat)'], FR, TO)), 6000, TO);
  const newDb = thdN(trim(runNew(sig, S3['1024 (flat)'], FR, TO)), 6000, TO);
  check('the old code really was worse than useless here', oldDb > 0,
    `old = ${oldDb.toFixed(1)} dB — distortion LOUDER than the tone`);
  check('the fix is worth more than 60 dB', oldDb - newDb > 60,
    `${(oldDb - newDb).toFixed(1)} dB better`);
}

/* ===================================================================== */
head('[B] DRIFT — does the sound gain on the picture over a service?');
console.log('    packets                        OLD             NEW');
{
  const S = schemes();
  const results = {};
  for (const [name, fn] of Object.entries(S)) {
    const target = 3600 * FR;                 // one hour of service
    const count = AudioResampler.counter(FR, TO);
    let inS = 0, oldOut = 0, newOut = 0;
    while (inS < target) {
      const n = Math.min(fn(), target - inS);
      inS += n;
      oldOut += Math.max(1, Math.round(n * (TO / FR)));
      newOut += count(n);
    }
    const want = target * (TO / FR);
    const oms = ((oldOut - want) / TO) * 1000, nms = ((newOut - want) / TO) * 1000;
    results[name] = nms;
    console.log(`    ${name.padEnd(29)}${(oms >= 0 ? '+' : '') + oms.toFixed(0) + ' ms'}`.padEnd(50) +
                `${(nms >= 0 ? '+' : '') + nms.toFixed(2) + ' ms'}`);
  }
  for (const [name, nms] of Object.entries(results)) {
    // A frame at 60fps is 16.7 ms. Anything under a millisecond an hour is not
    // a sync error, it is arithmetic noise.
    check(`no drift over an hour — ${name}`, Math.abs(nms) < 1,
      `${nms.toFixed(2)} ms per hour`);
  }
}

/* ===================================================================== */
head('[C] THE CASES THAT MUST NOT REGRESS');
{
  // 44.1 kHz senders exist too (some desks, some plug-ins) — upsampling has to
  // be as clean as downsampling.
  const S = schemes();
  const sig = tone(3000, 1.5, 44100);
  const up = runNew(sig, S['1024 (flat)'], 44100, 48000);
  const db = thdN(trim(up), 3000, 48000);
  check('a 44.1 kHz sender onto a 48 kHz bus is clean too', db < -68, `${db.toFixed(1)} dB`);

  /*
   * Equal rates. feedNdiAudio skips the converter entirely in this case (the
   * ordinary one), but the module must still be honest if it is ever handed it:
   * a matched-rate run is an all-pass with a FIXED whole-sample group delay, so
   * the test finds that delay rather than assuming it, and then demands the
   * waveform back. A converter that coloured the sound at ratio 1:1 would be
   * colouring it at every other ratio too.
   */
  const rs = AudioResampler.make(48000, 48000);
  const a = new Float32Array(4096);
  for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin(i * 0.1) + 0.3 * Math.sin(i * 0.017);
  const same = rs.process(a, a);
  let bestLag = 0, bestErr = Infinity;
  for (let lag = 0; lag <= 24; lag++) {
    let worst = 0;
    for (let i = 64; i < a.length - 64 && i + lag < same.l.length; i++) {
      worst = Math.max(worst, Math.abs(same.l[i + lag] - a[i]));
    }
    if (worst < bestErr) { bestErr = worst; bestLag = lag; }
  }
  check('equal rates pass through essentially untouched', bestErr < 0.02,
    `worst sample error ${bestErr.toExponential(2)} at a fixed ${bestLag}-sample delay`);

  // A converter that emits nothing, or emits a wildly wrong count, would show
  // up as silence or as a permanently growing delay.
  const rs2 = AudioResampler.make(FR, TO);
  let got = 0;
  const one = new Float32Array(1024);
  for (let i = 0; i < 100; i++) got += rs2.process(one, one).l.length;
  const want = 100 * 1024 * (TO / FR);
  check('it produces the right number of samples', Math.abs(got - want) < 20,
    `${got} samples for ${want.toFixed(0)} expected`);

  // Odd and tiny packets must not throw or corrupt the phase.
  const rs3 = AudioResampler.make(FR, TO);
  let ok = true, tot = 0, fed = 0;
  for (const n of [1, 2, 3, 7, 1, 960, 1, 1601, 5]) {
    try { const o = rs3.process(new Float32Array(n), new Float32Array(n)); tot += o.l.length; fed += n; }
    catch (e) { ok = false; }
  }
  check('tiny and odd packet sizes are handled', ok && Math.abs(tot - fed * (TO / FR)) < 20,
    `${fed} in -> ${tot} out`);
}

console.log(`\n==== NDI resampling: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
