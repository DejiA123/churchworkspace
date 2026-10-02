'use strict';
/**
 * NDI receiver — one utilityProcess per live NDI input.
 *
 * WHY A SEPARATE PROCESS, AND NOT A WORKER THREAD IN MAIN
 *
 * A received NDI frame has to reach the RENDERER, where the switcher composites
 * it. That means it must cross a process boundary, and crossing one costs a
 * serialize + copy of the whole frame — measured on the development machine at
 * ~1.45 ms per megabyte, i.e. ~11 ms for one 1080p RGBA frame and ~46 ms for a
 * 4K one. Whichever process performs `postMessage` pays that bill.
 *
 * The previous design paid it, and worse, ON THE MAIN PROCESS: the receiver ran
 * as a worker thread inside main, handed each frame to main, and main encoded it
 * to JPEG (nativeImage.toJPEG — 16.6 ms for 1080p, 51 ms for 4K) before sending
 * it on. One 1080p30 NDI input therefore consumed ~64% of the main process, and
 * a 4K one asked for 205% — more than exists.
 *
 * That is not merely slow: THE MAIN PROCESS IS ALSO WHAT FEEDS THE ENCODER.
 * `live:chunk` lands there and hub.write() pushes it into ffmpeg's stdin. While
 * main sat inside a 51 ms JPEG encode, the broadcast got nothing, so the stream
 * stuttered and the picture fell steadily further behind the sound (audio frames
 * are tiny and sailed through unimpeded) — exactly the reported fault.
 *
 * So the pixels never touch main at all now. Electron's MessageChannelMain gives
 * one port to this process and the other to the renderer; the two then talk
 * DIRECTLY, and main is left free to do nothing but shovel encoded chunks. The
 * same measurement harness puts main's stall at ~1% with this arrangement.
 *
 * Frames go out in the sender's own UYVY (4:2:2, 2 bytes/pixel) wherever the
 * source is opaque, which is nearly always. That halves the bytes against BGRA —
 * the difference between 4K30 costing 68% of this process and 141% of it (i.e.
 * not working) — and it is also NDI's native wire format, so the SDK does no
 * colour conversion either. The renderer turns UYVY into RGB in a shader, on the
 * GPU, for free. Sources that really do carry alpha arrive as BGRA and take the
 * plain path.
 *
 * Messages posted down the renderer port:
 *   { kind:'video', id, w, h, ts, fmt:'uyvy'|'bgra', buf }
 *   { kind:'audio', id, sampleRate, frames, ts, left, right }
 * and to main over parentPort (small, control-plane only):
 *   { kind:'status', connections } | { kind:'error', message } | { kind:'stopped' }
 */
const { loadNdi } = require('./ndi-ffi');
const { downmixPairs, newMixState } = require('./ndi-mix');
// Last reported downmix shape, so the report below is sent on CHANGE only.
let lastMix = { active: -1, pairs: -1 };

const BW_AUDIO_ONLY = 10, BW_LOWEST = 0, BW_HIGHEST = 100;
// NDIlib_recv_color_format_UYVY_BGRA: UYVY for opaque sources, BGRA when the
// sender genuinely has an alpha channel. Both are handled downstream.
const COLOR_UYVY_BGRA = 1;

const fourcc = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const FOURCC_UYVY = fourcc('UYVY');
const FOURCC_BGRA = fourcc('BGRA');
const FOURCC_BGRX = fourcc('BGRX');
const FOURCC_RGBA = fourcc('RGBA');
const FOURCC_RGBX = fourcc('RGBX');

let ndi = null, recv = null, vframe = null, aframe = null;
let running = false;
// TWO ports to the renderer, deliberately. Video frames are megabytes and audio
// packets are a couple of kilobytes; sharing one channel puts every audio packet
// behind whatever video frame is already in the pipe, and the renderer's audio
// worklet then runs dry — which is audible as a dropout, not a statistic. On
// separate channels the sound can never be held up by the picture.
let vPort = null, aPort = null;
let cfg = null;               // { id, source, opts }
let fpsCap = 0;               // 0 = deliver every frame the sender produces
let fpsCredit = 0;            // see admitFrame()
let lastArrivalAt = 0, arrivalEma = 0;
// Which stereo pairs of a multichannel NDI feed are actually carrying sound,
// kept across packets so the mix divisor cannot flap between buffers.
const mixState = newMixState();

const toMain = (m) => { try { process.parentPort.postMessage(m); } catch (e) {} };

process.parentPort.on('message', (e) => {
  const m = (e && e.data) || {};
  if (m.cmd === 'port') {
    vPort = e.ports[0]; aPort = e.ports[1] || e.ports[0];
    try { vPort.start(); if (aPort !== vPort) aPort.start(); } catch (er) {}
    return;
  }
  if (m.cmd === 'start') { start(m); return; }
  // The compositor only draws so fast; delivering faster than it draws is pure
  // cost on this process and on the renderer, so it tells us its rate.
  if (m.cmd === 'fps') { setFpsCap(m.fps); return; }
  if (m.cmd === 'stop') { running = false; return; }
});

function setFpsCap(fps) {
  fpsCap = Number(fps) || 0;
  fpsCredit = 0;
}

/*
 * Should this frame be delivered to the renderer?
 *
 * The compositor draws at a fixed rate, and a frame it will never draw still
 * costs a full copy here and another one in the renderer. So a 60fps camera
 * feeding a 30fps production is worth halving at the source. The cap must not
 * touch a MATCHED source, though, and that is the ordinary case.
 *
 * This used to enforce a MINIMUM INTERVAL between deliveries (frame period minus
 * 2 ms). Arrival times jitter by more than that — timer granularity, the
 * network, the SDK's own threading — so every marginally early frame was thrown
 * away. Measured against a sender locked to the production rate, it discarded
 * 6-7 frames a second in BOTH directions: 53.7 delivered of 60 sent at 1080p60,
 * and 23.1 of 30 at 1080p30, while the same feed uncapped ran at a clean 60.4.
 * A tenth to a fifth of all frames dropped, on a source that needed no
 * decimation whatsoever, is precisely the judder being complained about.
 *
 * Counting frames instead of measuring clocks is immune to that jitter: take
 * `target/source` credit per arrival and spend a whole credit per delivery,
 * which decimates by the exact ratio and spaces the survivors evenly. Same
 * technique as a sample-rate converter.
 */
function admitFrame(srcFps) {
  if (!fpsCap) return true;
  // Within touching distance of the production rate: pass everything. Trimming
  // here could only ever cost a frame the compositor was about to draw.
  if (!srcFps || srcFps <= fpsCap * 1.15) return true;
  fpsCredit += fpsCap / srcFps;
  if (fpsCredit < 1) return false;
  fpsCredit -= 1;
  if (fpsCredit > 1) fpsCredit = 1;   // never bank more than one frame of credit
  return true;
}

function start(m) {
  cfg = m;
  const { dllPath, source, opts } = m;
  try {
    ndi = loadNdi(dllPath);
    ndi.F.init();
    const bandwidth = opts.audioOnly ? BW_AUDIO_ONLY : (opts.lowBandwidth ? BW_LOWEST : BW_HIGHEST);
    recv = ndi.F.recv_create({
      source_to_connect_to: { p_ndi_name: source.name, p_url_address: source.url || null },
      color_format: COLOR_UYVY_BGRA,
      bandwidth,
      allow_video_fields: false,
      p_ndi_recv_name: 'Church Work Space',
    });
    if (!recv) throw new Error('Could not open the NDI receiver.');
    vframe = ndi.koffi.alloc(ndi.T.video, 1);
    aframe = ndi.koffi.alloc(ndi.T.audio, 1);
  } catch (e) {
    toMain({ kind: 'error', message: String((e && e.message) || e) });
    return;
  }
  setFpsCap(opts.fpsCap);
  running = true;
  setImmediate(tick);
}

let lastStatusAt = 0;

/*
 * Drain everything the SDK has queued, then yield with setImmediate so the
 * 'stop' and 'fps' messages still get processed.
 *
 * Handling only ONE frame per turn of the loop is what made the sound break up
 * at 4K: video and audio come off the SAME capture, handing a 16 MB video frame
 * to the renderer takes ~20 ms, and every audio packet that arrived meanwhile
 * then had to wait its own separate turn behind it. The audio worklet ran dry
 * waiting. Draining takes all of them in one pass instead, so a big picture
 * never rations the sound. The first call still blocks (parking the process
 * when the source is idle rather than spinning); the rest are pure polls.
 */
const DRAIN_BUDGET = 16;

function tick() {
  if (!running) return cleanup();
  let wait = 90;
  for (let n = 0; n < DRAIN_BUDGET && running; n++) {
    let type = 0;
    try { type = ndi.F.recv_capture(recv, vframe, aframe, null, wait); }
    catch (e) { break; /* transient */ }
    if (!running) return cleanup();
    if (type === 0) break;                  // nothing left queued
    try {
      if (type === 1) handleVideo();
      else if (type === 2) handleAudio();
    } catch (e) { /* never let one bad frame kill the loop */ }
    wait = 0;                               // everything after the first is a drain
  }

  const now = Date.now();
  if (now - lastStatusAt > 1000) {
    lastStatusAt = now;
    let conns = 0;
    try { conns = ndi.F.recv_get_no_connections(recv, 0); } catch (e) {}
    toMain({ kind: 'status', connections: conns, delivered: nDelivered, capped: nCapped, superseded: nSuperseded, audioSamples: nAudioSamples });
  }
  setImmediate(tick);
}

/*
 * How many video frames the SDK still holds for us AFTER the one just captured.
 * Anything above zero means the picture in hand has already been superseded.
 *
 * NDIlib_recv_get_queue arrived in NDI 4; on an older runtime the binding is
 * null, we cannot know, and every frame is delivered exactly as it was before.
 * The struct is allocated once — this runs per frame.
 */
let qframe = null;
// Why frames did not reach the renderer, reported on the 1 Hz status heartbeat.
// Without these a shortfall in delivered fps is unattributable — the frame could
// have been rejected by the rate cap, dropped as already superseded, or never
// have been sent at all — and each has a different fix.
let nDelivered = 0, nCapped = 0, nSuperseded = 0;
// Audio samples taken off the SDK — against what the sender sent and what the
// worklet received, it says which hop lost sound.
let nAudioSamples = 0;

function videoQueueDepth() {
  const { koffi, F, T } = ndi;
  if (!F.recv_get_queue) return 0;
  try {
    if (!qframe) qframe = koffi.alloc(T.recvQueue, 1);
    F.recv_get_queue(recv, qframe);
    return koffi.decode(qframe, T.recvQueue).video_frames | 0;
  } catch (e) { return 0; }
}

function handleVideo() {
  const { koffi, F, T, arrType } = ndi;
  const v = koffi.decode(vframe, T.video);
  try {
    const w = v.xres, h = v.yres, stride = v.line_stride_in_bytes;
    if (!w || !h || !v.p_data) return;

    // The rate the SENDER declares. Some senders leave it at zero, so keep a
    // smoothed measure of how fast frames actually ARRIVE as a fallback. Note
    // this is measured before any drop decision, so it cannot feed back on
    // itself the way measuring the DELIVERED rate would.
    const now = Date.now();
    if (lastArrivalAt) {
      const dt = now - lastArrivalAt;
      if (dt > 0 && dt < 1000) arrivalEma = arrivalEma ? arrivalEma * 0.9 + dt * 0.1 : dt;
    }
    lastArrivalAt = now;
    const declaredFps = v.frame_rate_D > 0 ? v.frame_rate_N / v.frame_rate_D : 0;
    const srcFps = declaredFps || (arrivalEma > 0 ? 1000 / arrivalEma : 0);

    // Both of these drop the frame BEFORE the copy — an unwanted frame must cost
    // nothing at all. `finally` frees it and the drain loop takes the next one.
    if (!admitFrame(srcFps)) { nCapped++; return; }
    if (!vPort) return;                      // renderer not attached yet
    // recv_capture returns the OLDEST frame the SDK is holding, so if more are
    // already queued behind this one it is stale by definition. Skipping to the
    // newest is what stops the picture sliding later and later behind the sound
    // whenever this process briefly falls behind (a 4K frame costs ~20 ms to
    // hand over, so it does not take much). Latency stays bounded instead of
    // accumulating for the rest of the service.
    if (videoQueueDepth() > 0) { nSuperseded++; return; }
    nDelivered++;

    const cc = v.FourCC;
    let fmt, bytesPerPx;
    if (cc === FOURCC_UYVY) { fmt = 'uyvy'; bytesPerPx = 2; }
    else if (cc === FOURCC_BGRA || cc === FOURCC_BGRX) { fmt = 'bgra'; bytesPerPx = 4; }
    else if (cc === FOURCC_RGBA || cc === FOURCC_RGBX) { fmt = 'rgba'; bytesPerPx = 4; }
    else return;                             // a format we cannot describe downstream

    const rowBytes = w * bytesPerPx;
    // koffi.decode already copies the pixels into a V8-owned typed array, and
    // for the usual tightly-packed frame that array IS the payload — the extra
    // .slice() this used to do was a second full copy of every frame (16.6 MB
    // at 4K, three times a frame in total once postMessage takes its own). Only
    // a padded stride needs the row-by-row repack.
    const u8 = koffi.decode(v.p_data, arrType('uint8_t', stride * h));
    let out;
    if (stride === rowBytes) {
      out = u8;
    } else {
      out = Buffer.allocUnsafe(rowBytes * h);
      const src = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
      for (let y = 0; y < h; y++) src.copy(out, y * rowBytes, y * stride, y * stride + rowBytes);
    }
    // ts = the SDK's own send timestamp (100 ns units). Video and audio from one
    // sender share this clock, so comparing them tells the renderer exactly how
    // much further behind one path is than the other — the basis of A/V sync.
    //
    // `srcFps` is the SOURCE's rate, which is deliberately NOT the rate we are
    // delivering at: the renderer sizes the production rate from it, and sizing
    // that from what actually arrives would be a feedback loop — our own cap
    // would depress the measurement, which would lower the cap, and a 60fps
    // camera would ratchet itself down to nothing.
    vPort.postMessage({ kind: 'video', id: cfg.id, w, h, fmt, srcFps, ts: Number(v.timestamp) || 0, buf: out });
  } finally {
    F.recv_free_video(recv, vframe);
  }
}

function handleAudio() {
  const { koffi, F, T, arrType } = ndi;
  const a = koffi.decode(aframe, T.audio);
  try {
    const ch = a.no_channels, ns = a.no_samples, stride = a.channel_stride_in_bytes;
    nAudioSamples += ns || 0;
    if (!ch || !ns || !a.p_data || !aPort) return;
    const perChan = stride / 4;
    const floats = koffi.decode(a.p_data, arrType('float', perChan * ch)); // owned V8 copy
    const left = new Float32Array(ns);   // zero-filled
    const right = new Float32Array(ns);
    // Channels → the stereo pair the mixer works with. Every pair is listened
    // to (senders put the programme on 3-4 as readily as 1-2) and the ones
    // actually carrying sound are AVERAGED, not summed — see src/main/ndi-mix.js
    // for why summing them used to hard-clip a singing congregation into a
    // square wave before the mixer ever saw it.
    const mix = downmixPairs(floats, { channels: ch, samples: ns, perChan, sampleRate: a.sample_rate },
      { left, right }, mixState);
    /*
     * WHAT THE DOWNMIX DID, REPORTED — it used to be thrown away.
     *
     * When more than one pair is carrying sound they are AVERAGED, so the
     * programme comes through at 1/active of its level and with the other
     * pair mixed into it. That is the right thing to do with an ambiguous
     * feed, but it is not something to do SILENTLY: an Ableton VST set to
     * publish two pairs, or anything bleeding onto 1-2 above -80 dBFS, makes
     * the service 6 dB quiet and carries content nobody meant to send, and
     * there was no way for an operator to find that out. Sent only when it
     * CHANGES — this runs ~47 times a second.
     */
    if (mix && (mix.active !== lastMix.active || mix.pairs !== lastMix.pairs)) {
      lastMix = { active: mix.active, pairs: mix.pairs };
      aPort.postMessage({ kind: 'mix', id: cfg.id, channels: ch,
                          pairs: mix.pairs, active: mix.active, gain: mix.gain });
    }
    aPort.postMessage({
      kind: 'audio', id: cfg.id, sampleRate: a.sample_rate, frames: ns,
      // `at`: when THIS process captured it. Against the sender's `ts` and the
      // moment the worklet received it, it says which hop a gap happened on.
      ts: Number(a.timestamp) || 0, at: Date.now(), left: Buffer.from(left.buffer), right: Buffer.from(right.buffer),
    });
  } finally {
    F.recv_free_audio(recv, aframe);
  }
}

function cleanup() {
  try { if (recv) ndi.F.recv_destroy(recv); } catch (e) {}
  recv = null;
  toMain({ kind: 'stopped' });
  setTimeout(() => process.exit(0), 50);
}
