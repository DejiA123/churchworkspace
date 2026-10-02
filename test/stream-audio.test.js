'use strict';
/*
 * REAL measurement for the complaint:
 *
 *   "I streamed to Facebook and YouTube at the same time. The sound on YouTube
 *    had itching, crusty sounds."
 *
 * The cause was in ProgramHub._fanOut. When a destination's upload could not keep
 * up, the hub dropped WHOLE WRITE BUFFERS out of the middle of that destination's
 * MPEG-TS. That cuts the stream at an arbitrary byte offset — straight through a
 * 188-byte transport packet, and through the AAC frame inside it. The platform
 * did not receive "less stream", it received CORRUPT stream, and corrupt AAC is
 * precisely a crackle. Streaming to two platforms doubles the upstream you need,
 * so on ordinary church broadband one destination always backs up first — which
 * is why one platform sounded fine and the other did not.
 *
 * This test does not reason about that, it MEASURES it:
 *   • a real MPEG-TS is built by the real ffmpeg, carrying a pure 1 kHz tone,
 *   • it is put through the OLD shedding behaviour and the NEW one,
 *   • both results are decoded back to raw PCM, and the CLICKS ARE COUNTED.
 *
 * A click is objective here: consecutive samples of a 1 kHz sine at 48 kHz can
 * differ by at most sin(2π·1000/48000) ≈ 0.131 of the amplitude. Anything past
 * that is not the tone — it is a splice, and it is what the church hears.
 *
 *   npm run test:streamaudio
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { TsShedder, ProgramHub, OUT_SAMPLE_RATE, AUDIO_RESAMPLE, SHED_BACKLOG } = require('../src/main/livestream');

const WORK = path.join(os.tmpdir(), 'mw-streamaudio-test');
fs.mkdirSync(WORK, { recursive: true });

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

const TONE_HZ = 1000;
const DUR = 20;
const SRC_TS = path.join(WORK, 'program.ts');

/* ---- a real broadcast intermediate, built exactly as the hub builds one ---- */
function buildTs() {
  if (fs.existsSync(SRC_TS) && fs.statSync(SRC_TS).size > 500000) return;
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${DUR}`,
    '-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=${OUT_SAMPLE_RATE}:duration=${DUR}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2',
    // the same broadcast shaping the hub uses
    '-mpegts_flags', '+resend_headers', '-pat_period', '0.2', '-flush_packets', '1',
    '-f', 'mpegts', SRC_TS], { stdio: 'ignore' });
}

/** Decode a TS to mono float32 PCM. Returns null when it is too broken to open. */
function decodePcm(file) {
  try {
    const buf = execFileSync(ffmpeg, ['-v', 'error', '-err_detect', 'ignore_err',
      '-i', file, '-vn', '-ac', '1', '-ar', String(OUT_SAMPLE_RATE),
      '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  } catch (e) { return null; }
}

/**
 * Count sample-to-sample jumps a clean 1 kHz sine cannot produce.
 * Also reports the loudest jump, which is what "crusty" actually is.
 */
function clicks(pcm) {
  if (!pcm || pcm.length < 100) return { count: 0, worst: 0, samples: 0, rms: 0 };
  // measure the tone's own amplitude so the threshold scales with the signal
  let sq = 0;
  for (let i = 0; i < pcm.length; i++) sq += pcm[i] * pcm[i];
  const rms = Math.sqrt(sq / pcm.length);
  const amp = rms * Math.SQRT2;
  const maxStep = amp * Math.sin(2 * Math.PI * TONE_HZ / OUT_SAMPLE_RATE);
  const limit = Math.max(0.02, maxStep * 2.5);   // generous: only real splices trip it
  let count = 0, worst = 0;
  for (let i = 1; i < pcm.length; i++) {
    const d = Math.abs(pcm[i] - pcm[i - 1]);
    if (d > limit) count++;
    if (d > worst) worst = d;
  }
  return { count, worst, samples: pcm.length, rms, limit };
}

/** How much of the decoded audio is NOT the 1 kHz tone (Goertzel at the tone). */
function tonePurity(pcm) {
  if (!pcm || pcm.length < 4096) return 0;
  const N = Math.min(pcm.length, OUT_SAMPLE_RATE * 8);
  const k = Math.round(N * TONE_HZ / OUT_SAMPLE_RATE);
  const w = 2 * Math.PI * k / N, cw = Math.cos(w), coeff = 2 * cw;
  let s0 = 0, s1 = 0, s2 = 0, total = 0;
  for (let i = 0; i < N; i++) {
    s0 = pcm[i] + coeff * s1 - s2; s2 = s1; s1 = s0;
    total += pcm[i] * pcm[i];
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return total > 0 ? Math.min(1, power / (total * N / 2)) : 0;
}

/* ---- the two shedding behaviours, fed the identical byte stream ---- */

/** OLD: drop whole write buffers, at whatever byte offset they happened to fall. */
function shedOld(ts, chunkSize, shedEvery) {
  const out = [];
  let n = 0;
  for (let i = 0; i < ts.length; i += chunkSize) {
    const chunk = ts.subarray(i, i + chunkSize);
    n++;
    if (n % shedEvery === 0) continue;   // this is the whole of the old policy
    out.push(chunk);
  }
  return Buffer.concat(out);
}

/**
 * NEW: packet-aligned, audio-last, whole-GOP shedding — driven exactly the way
 * ProgramHub._fanOut drives it. `filteredBytes` records only what came back OUT
 * of the filter (the raw pass-through writes are byte-exact copies of the source
 * and say nothing about the filter's own alignment).
 */
function shedNew(ts, chunkSize, shedEvery) {
  const sh = new TsShedder();
  const out = [];
  let n = 0, filteredBytes = 0, filteredAligned = true;
  for (let i = 0; i < ts.length; i += chunkSize) {
    const chunk = Buffer.from(ts.subarray(i, i + chunkSize));
    n++;
    const under = n % shedEvery === 0;
    if (under || sh.active) {
      const kept = sh.filter(chunk, { shed: under, dropAudio: false });
      if (kept && kept.length) {
        if (kept.length % 188 !== 0) filteredAligned = false;
        filteredBytes += kept.length;
        out.push(kept);
      }
    } else out.push(chunk);
  }
  const buf = Buffer.concat(out);
  buf.filteredBytes = filteredBytes;
  buf.filteredAligned = filteredAligned;
  return buf;
}

(async () => {
  console.log('\n[0] A real broadcast MPEG-TS carrying a pure 1 kHz tone');
  buildTs();
  const ts = fs.readFileSync(SRC_TS);
  log(ts.length > 500000, 'built the program stream', `${(ts.length / 1e6).toFixed(1)} MB, ${DUR}s`);
  const clean = decodePcm(SRC_TS);
  const cleanC = clicks(clean);
  log(!!clean && clean.length > OUT_SAMPLE_RATE * 15, 'it decodes to real audio', `${clean ? (clean.length / OUT_SAMPLE_RATE).toFixed(1) : 0}s`);
  log(cleanC.count === 0, 'and the untouched stream has ZERO clicks — the baseline is genuinely clean',
    `${cleanC.count} clicks, worst step ${cleanC.worst.toFixed(4)} (limit ${cleanC.limit.toFixed(4)})`);
  log(tonePurity(clean) > 0.9, 'it really is a pure tone (so anything else that shows up is damage)',
    (tonePurity(clean) * 100).toFixed(1) + '% of energy at 1 kHz');

  /* ---- the scenario: a destination that cannot keep up ---- */
  console.log('\n[1] A destination short on upload — the OLD behaviour vs the NEW one');
  const CHUNK = 64 * 1024, EVERY = 6;   // ~1 write in 6 shed: a genuinely struggling link
  const oldBuf = shedOld(ts, CHUNK, EVERY);
  const newBuf = shedNew(ts, CHUNK, EVERY);
  const oldFile = path.join(WORK, 'old.ts'), newFile = path.join(WORK, 'new.ts');
  fs.writeFileSync(oldFile, oldBuf);
  fs.writeFileSync(newFile, newBuf);
  log(true, 'same input, same pressure, two policies',
    `old kept ${(oldBuf.length / 1e6).toFixed(1)}MB, new kept ${(newBuf.length / 1e6).toFixed(1)}MB of ${(ts.length / 1e6).toFixed(1)}MB`);
  log(newBuf.filteredAligned && newBuf.filteredBytes % 188 === 0,
    'THE FIX: every byte the new policy sheds through is a whole transport packet, never half of one',
    `${newBuf.filteredBytes} filtered bytes = ${newBuf.filteredBytes / 188} packets, every write aligned`);
  log(oldBuf.length % 188 !== 0, 'where the old policy cut wherever the write buffer happened to end — mid-packet, mid-AAC-frame',
    `${oldBuf.length} bytes = ${(oldBuf.length / 188).toFixed(2)} packets`);

  const oldPcm = decodePcm(oldFile), newPcm = decodePcm(newFile);
  const oldC = clicks(oldPcm), newC = clicks(newPcm);
  const newPure = tonePurity(newPcm), oldPure = tonePurity(oldPcm);
  console.log(`    old: ${(oldPure * 100).toFixed(1)}% of the sound is still the tone · ${(oldC.samples / OUT_SAMPLE_RATE).toFixed(1)}s survived · ${oldC.count} splices`);
  console.log(`    new: ${(newPure * 100).toFixed(1)}% of the sound is still the tone · ${(newC.samples / OUT_SAMPLE_RATE).toFixed(1)}s survived · ${newC.count} splices`);
  /*
   * Tone purity is the honest damage metric here, more than a click count. Under
   * the old policy the AAC frames are so mangled that the decoder throws most of
   * them away rather than turning them into clicks — what the church actually
   * hears is garbled bursts and dropouts. "How much of what came out is still
   * the sound that went in" measures that directly, and the gap is enormous.
   */
  log(oldPure < 0.5, 'the OLD behaviour really does destroy the sound — the reported bug, reproduced and measured',
    `only ${(oldPure * 100).toFixed(1)}% of the received audio is still the tone that was sent`);
  log(newPure > 0.95, 'THE FIX: the sound arrives essentially untouched',
    `${(newPure * 100).toFixed(1)}% still the tone (was ${(oldPure * 100).toFixed(1)}%)`);
  log(newC.count === 0, 'with no audible splices in it', `${newC.count} clicks`);
  log(newC.samples >= cleanC.samples * 0.98, 'and ALL of the audio arrives, not a shortened stream',
    `${(newC.samples / OUT_SAMPLE_RATE).toFixed(1)}s of ${(cleanC.samples / OUT_SAMPLE_RATE).toFixed(1)}s`);
  log(oldC.samples < cleanC.samples * 0.98, 'where the old one lost whole seconds of audio outright',
    `${(oldC.samples / OUT_SAMPLE_RATE).toFixed(1)}s of ${(cleanC.samples / OUT_SAMPLE_RATE).toFixed(1)}s`);

  console.log('\n[2] What gets sacrificed instead: picture, in whole keyframe-to-keyframe pieces');
  const probeV = (f) => {
    try {
      const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
        '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f], { encoding: 'utf8' });
      return parseInt(out.trim(), 10) || 0;
    } catch (e) { return 0; }
  };
  const vClean = probeV(SRC_TS), vNew = probeV(newFile);
  log(vNew < vClean * 0.95, 'video really was shed (that is where the bandwidth was saved)',
    `${vNew} of ${vClean} video packets kept`);
  log(vNew > 0, 'but picture keeps coming back — the destination is never left blank', `${vNew} packets`);
  // Audio packets must be untouched at this pressure level.
  const probeA = (f) => {
    try {
      const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-count_packets',
        '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f], { encoding: 'utf8' });
      return parseInt(out.trim(), 10) || 0;
    } catch (e) { return 0; }
  };
  const aClean = probeA(SRC_TS), aNew = probeA(newFile), aOld = probeA(oldFile);
  log(aNew >= aClean * 0.99, 'EVERY audio frame survives — sound is shed last, and it never came to that',
    `${aNew} of ${aClean} audio frames (old policy: ${aOld})`);
  log(aOld < aClean * 0.9, 'the old policy threw audio frames away as collateral', `${aOld} of ${aClean}`);

  console.log('\n[3] Last resort: when even sound has to go, it still goes cleanly');
  const sh = new TsShedder();
  const parts = [];
  for (let i = 0; i < ts.length; i += CHUNK) {
    const kept = sh.filter(Buffer.from(ts.subarray(i, i + CHUNK)), { shed: true, dropAudio: true });
    if (kept && kept.length) parts.push(kept);
  }
  const starved = Buffer.concat(parts);
  log(starved.length % 188 === 0, 'still packet-aligned when everything is being shed', `${starved.length} bytes`);
  log(starved.length < ts.length * 0.2, 'and it really does shed nearly everything', `${(starved.length / ts.length * 100).toFixed(1)}% kept`);
  log(sh.audioPids.size > 0 && sh.videoPids.size > 0,
    'it learned the stream layout from the real PAT/PMT rather than assuming PIDs',
    `video PID(s) ${[...sh.videoPids].join(',')} · audio PID(s) ${[...sh.audioPids].join(',')}`);

  console.log('\n[4] The hub wiring: per-destination, and it says something');
  const hub = new ProgramHub();
  hub.cfg = { width: 1280, height: 720, videoKbps: 2500, audioKbps: 128, fps: 30, format: 'mp4' };
  const events = [];
  hub.onEvent = (id, type, payload) => events.push({ id, type, payload });
  // two destinations, one of which is backed up
  const mk = (id, backlog) => {
    const written = [];
    const o = {
      id, kind: 'rtmp', q: {}, fps: 30, dropped: 0, shedder: new TsShedder(), shedding: false,
      stopping: false, proc: { stdin: { writableLength: backlog, write: (b) => { written.push(b); return true; } } },
    };
    o._written = written;
    hub.outputs.set(id, o);
    return o;
  };
  const fast = mk('fast', 0);
  const slow = mk('slow', SHED_BACKLOG + 1);
  for (let i = 0; i < ts.length; i += CHUNK) hub._fanOut(Buffer.from(ts.subarray(i, i + CHUNK)));
  const fastBytes = fast._written.reduce((a, b) => a + b.length, 0);
  const slowBytes = slow._written.reduce((a, b) => a + b.length, 0);
  /*
   * "The whole stream" means EVERY BYTE A CONSUMER COULD DECODE, which is not
   * quite every byte in the file.
   *
   * This used to assert `fastBytes === ts.length`, and it was right when it was
   * written. _fanOut has since grown the keyframe gate (see _hasKeyframeYet):
   * nothing is fanned out until two random-access points have gone past, and
   * the held bytes are then replayed FROM THE FIRST ONE — because a destination
   * handed the undecodable trickle before it probes a video stream with no
   * picture parameters in it and streams the whole service as audio only.
   *
   * Measured here: the first keyframe starts 564 bytes in (3 transport packets),
   * so a healthy destination receives 4386416 of 4386980 bytes. The 564 it never
   * sees are exactly the preamble it could not have decoded.
   *
   * What the assertion is really about is that the healthy destination is not
   * SHED — that the one struggling link does not cost the other one its picture
   * — so that is what it now measures, alongside the byte count being complete
   * from the keyframe on.
   */
  log(fast.dropped === 0 && fastBytes === ts.length - hub._firstKeyAt,
    'the destination that is keeping up gets the whole stream, untouched',
    `${(fastBytes / 1e6).toFixed(1)}MB, 0 shed, missing only the ${hub._firstKeyAt}-byte pre-keyframe preamble`);
  log(slowBytes < fastBytes * 0.6, 'the one that is behind gets a reduced stream', `${(slowBytes / 1e6).toFixed(1)}MB`);
  const slowPcm = (() => {
    const f = path.join(WORK, 'slow.ts');
    fs.writeFileSync(f, Buffer.concat(slow._written));
    return decodePcm(f);
  })();
  const slowC = clicks(slowPcm);
  log(slowC.count === 0 && slowC.samples >= cleanC.samples * 0.98,
    'and its SOUND is still complete and click-free — the whole point',
    `${slowC.count} clicks, ${(slowC.samples / OUT_SAMPLE_RATE).toFixed(1)}s`);
  const bw = events.filter((e) => e.type === 'bandwidth');
  log(bw.length > 0 && bw[0].id === 'slow', 'the operator is TOLD which destination is short on bandwidth',
    bw.length ? `"Destination … ${bw[0].payload.message}"` : 'no event');
  log(!events.some((e) => e.type === 'bandwidth' && e.id === 'fast'), 'and the healthy destination is not blamed for it');

  /*
   * "On fast internet, YouTube still said poor connection."
   *
   * A destination's backlog does not only grow when the upload is slow. It grows
   * just as readily when that destination's own ffmpeg cannot READ fast enough —
   * which is what happens to one that is re-encoding in software while the hub
   * already holds the GPU. The platform sees data arriving late and in gaps and
   * says the same thing either way, so the operator goes and tests their
   * broadband and finds nothing wrong with it.
   */
  console.log('\n[4b] Telling "not enough upload" apart from "not enough computer"');
  const h3 = new ProgramHub();
  h3.cfg = { width: 1280, height: 720, videoKbps: 2500, audioKbps: 128, fps: 30, format: 'mp4' };
  const ev3 = [];
  h3.onEvent = (id, type, payload) => ev3.push({ id, type, payload });
  const mkOut = (id, copying) => {
    const o = {
      id, kind: 'rtmp', q: {}, fps: 30, dropped: 0, shedder: new TsShedder(), shedding: false,
      stopping: false, copying, slowTicks: 0, slowWarned: false,
      proc: { stdin: { writableLength: SHED_BACKLOG + 1, write: () => true } },
    };
    h3.outputs.set(id, o);
    return o;
  };
  mkOut('copyDest', true);
  mkOut('reencDest', false);
  /*
   * FEED UNTIL THE KEYFRAME GATE OPENS, then look at what was said.
   *
   * This was one _fanOut of a single 64 KB chunk, and it silently stopped
   * testing anything the day _fanOut grew that gate: the bar is TWO
   * random-access points (see _hasKeyframeYet) and one chunk of this stream
   * carries one, so every call returned at the gate, the per-destination loop
   * never ran, and the assertions below were reading an empty event list.
   *
   * The gate is not what this section is about — which destination is behind
   * and WHY is — so the stream is fed until it opens, which is what happens on
   * air anyway. Both destinations are backed up from the first byte, so the
   * call that opens the gate is also the one that reports them.
   */
  for (let i = 0; i < ts.length && !h3._sawVideo; i += CHUNK) {
    h3._fanOut(Buffer.from(ts.subarray(i, i + CHUNK)));
  }
  const upMsg = ev3.find((e) => e.id === 'copyDest' && e.type === 'bandwidth');
  const cpuMsg = ev3.find((e) => e.id === 'reencDest' && e.type === 'bandwidth');
  log(upMsg && upMsg.payload.reason === 'upload' && /upload speed/i.test(upMsg.payload.message),
    'a COPIED destination falling behind is reported as an upload problem', upMsg && upMsg.payload.reason);
  log(cpuMsg && cpuMsg.payload.reason === 'encode' && /same quality/i.test(cpuMsg.payload.message),
    'THE FIX for "fast internet, poor connection": a RE-ENCODING one is reported as a computer problem, with the actual remedy',
    cpuMsg && `${cpuMsg.payload.reason} — "…${cpuMsg.payload.message.slice(-60)}"`);

  console.log('\n[5] Sound is not needlessly re-encoded any more');
  const h2 = new ProgramHub();
  h2.cfg = { width: 1280, height: 720, videoKbps: 2500, audioKbps: 128, fps: 30, format: 'mp4' };
  const at = (kbps) => h2._canCopyAudio({ kind: 'rtmp', q: { audioKbps: kbps }, fps: 30 });
  log(at(128) === true, 'a destination asking for the same bitrate copies (it always did)');
  log(at(96) === true, 'THE FIX: 128k hub → 96k destination now COPIES instead of decode-resample-re-encode',
    'no generation loss on a stream that is already lossy');
  log(at(32) === false, 'but a genuinely low-bitrate destination still gets its own encode');
  log(AUDIO_RESAMPLE.includes('async'), 'and anything that does re-encode absorbs timestamp gaps instead of clicking on them', AUDIO_RESAMPLE);
  log(OUT_SAMPLE_RATE === 48000, 'the whole chain stays at the source sample rate — no resample of the service', OUT_SAMPLE_RATE + ' Hz');

  console.log('\n============  STREAM AUDIO test ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
