'use strict';
/*
 * NDI sender worker thread. One thread serves every NDI output.
 *
 * Sending is where the CPU goes: NDIlib_send_send_video_v2 compresses the frame
 * (SpeedHQ) before it hits the wire, and at 1080p that is far too much work to
 * do on the main process while an operator is trying to advance slides. So the
 * main thread only captures — the pixels arrive here as a TRANSFERRED
 * ArrayBuffer (zero copy) and this thread does the compressing and sending.
 *
 * THE CLOCK LIVES HERE. A slide that is not moving paints once and then never
 * again, but an NDI receiver needs a frame every interval or it decides the
 * source has gone away. Re-sending used to mean the main process copying the
 * whole 1080p bitmap (7.8 MB) and posting it thirty times a second for a
 * picture that had not changed — 235 MB/s of pure book-keeping on the process
 * that also has to keep the service running. The last frame is simply KEPT here
 * instead: main sends a frame only when a new one is painted, and this thread
 * re-sends what it already holds until then. A still slide costs the main
 * process nothing at all.
 *
 * Messages in:
 *   { cmd:'open',  id, name, fps, groups }  create a sender named <name>
 *   { cmd:'frame', id, buf, w, h, stride }  one BGRA frame (buf is transferred)
 *   { cmd:'close', id }
 *   { cmd:'stop' }
 * Messages out:
 *   { kind:'open', id, ok, error }
 *   { kind:'status', id, connections, w, h, sent }   ~1 Hz, so the UI can say "2 receivers"
 *   { kind:'error', id, message }
 */
const { parentPort, workerData } = require('worker_threads');
const { loadNdi } = require('./ndi-ffi');

/*
 * 'BGRA' / 'BGRX' as little-endian FourCCs — the exact byte order Electron's
 * nativeImage/paint bitmaps come back in, so no pixel conversion is needed.
 *
 * The X matters. BGRA tells the SDK the frame HAS an alpha channel, and NDI
 * then compresses it as SpeedHQ 4:2:2:4 — a whole extra plane of work per
 * frame, on every frame, for an alpha channel a normal lyrics feed does not
 * have. BGRX is the same bytes with "ignore the fourth one" attached, and it
 * takes the ordinary 4:2:2 path. Only a KEYABLE feed pays for BGRA, because
 * only a keyable feed is using the alpha for anything.
 */
const FOURCC_BGRA = 0x41524742;
const FOURCC_BGRX = 0x58524742;

let ndi = null;
const senders = new Map();   // id -> { ptr, name, fps, w, h, last, timer, sent }

try {
  ndi = loadNdi(workerData.dllPath);
  if (!ndi.F.init()) throw new Error('NDIlib_initialize() failed.');
} catch (e) {
  parentPort.postMessage({ kind: 'error', message: String((e && e.message) || e) });
  process.exit(0);
}

function open(m) {
  try {
    if (senders.has(m.id)) close(m.id);
    // clock_video:false — NDI would otherwise BLOCK inside send_video to pace
    // the stream, and the pacing is already done by the timer below. Blocking
    // here would just make the queue back up on a slow frame.
    const ptr = ndi.F.send_create({ p_ndi_name: m.name, p_groups: m.groups || null, clock_video: false, clock_audio: false });
    if (!ptr) throw new Error('NDIlib_send_create returned null — is the name already in use?');
    const s = { ptr, name: m.name, fps: m.fps || 30, alpha: !!m.alpha,
      last: null, held: null, sent: 0, lastSentAt: 0, sendMs: 0 };
    senders.set(m.id, s);
    /*
     * The steady clock: whatever the page is doing, a receiver gets a frame
     * every interval. A frame that has just been sent on arrival is not sent
     * again by the tick that follows it.
     *
     * The timer POLLS at a quarter of the interval instead of running at the
     * interval itself, because Windows' default timer resolution is 15.6 ms:
     * a setInterval(33) does not fire every 33 ms, it fires on the next 15.6 ms
     * boundary at 46.8 ms — a "30fps" feed delivered at 21. Polling finer and
     * sending when the frame is DUE lands on 31.2 ms instead, which is the
     * nearest a millisecond-quantised machine can get to 30fps.
     */
    const interval = Math.max(8, Math.round(1000 / s.fps));
    const due = interval * 0.75;
    s.timer = setInterval(() => {
      if (!s.last || Date.now() - s.lastSentAt < due) return;
      send(m.id, s, s.last);
    }, Math.max(2, Math.round(interval / 4)));
    parentPort.postMessage({ kind: 'open', id: m.id, ok: true, name: m.name });
  } catch (e) {
    parentPort.postMessage({ kind: 'open', id: m.id, ok: false, error: String((e && e.message) || e) });
  }
}

const ASYNC = !!(ndi.F && ndi.F.send_video_async);

function send(id, s, f) {
  const t0 = Date.now();
  try {
    const frame = {
      xres: f.w, yres: f.h,
      FourCC: s.alpha ? FOURCC_BGRA : FOURCC_BGRX,
      frame_rate_N: Math.round((s.fps || 30) * 1000), frame_rate_D: 1000,
      picture_aspect_ratio: 0,          // 0 = derive from xres/yres
      frame_format_type: 1,             // progressive
      timecode: -1,                     // let the SDK stamp it (NDIlib_send_timecode_synthesize)
      p_data: f.buf,
      line_stride_in_bytes: f.stride,
      p_metadata: null,
      timestamp: 0,
    };
    if (ASYNC) {
      // The SDK reads this buffer AFTER the call returns, and only guarantees
      // it is finished with it once the NEXT async send has been made. Holding
      // the previous frame until then is that guarantee — dropping it here is
      // how an async sender ends up transmitting torn or freed memory.
      ndi.F.send_video_async(s.ptr, frame);
      s.held = f;
    } else {
      ndi.F.send_video(s.ptr, frame);
    }
    s.w = f.w; s.h = f.h; s.sent++;
    s.lastSentAt = Date.now();
    // A rolling average, so the panel can say what this machine can actually
    // manage rather than what the dropdown promised.
    s.sendMs = s.sendMs ? s.sendMs * 0.9 + (s.lastSentAt - t0) * 0.1 : (s.lastSentAt - t0);
  } catch (e) {
    parentPort.postMessage({ kind: 'error', id, message: String((e && e.message) || e) });
  }
}

function frame(m) {
  const s = senders.get(m.id);
  if (!s) return;
  // Kept, not copied: the same bytes are handed over again for as long as the
  // picture on the slide has not changed.
  s.last = { buf: Buffer.from(m.buf), w: m.w, h: m.h, stride: m.stride || m.w * 4 };
  send(m.id, s, s.last);
}

function close(id) {
  const s = senders.get(id);
  senders.delete(id);
  if (s) {
    clearInterval(s.timer);
    // An async send may still be reading the last buffer. Destroying the sender
    // first makes the SDK finish with it, and only then is it safe to let go.
    try { ndi.F.send_destroy(s.ptr); } catch (e) {}
    s.last = null; s.held = null;
  }
}

parentPort.on('message', (m) => {
  if (!m) return;
  if (m.cmd === 'open') return open(m);
  if (m.cmd === 'frame') return frame(m);
  if (m.cmd === 'close') return close(m.id);
  if (m.cmd === 'stop') {
    for (const id of Array.from(senders.keys())) close(id);
    clearInterval(statusTimer);
    process.exit(0);
  }
});

// How many receivers are watching — an operator needs to know their stream box
// actually picked the feed up before the service starts.
const statusTimer = setInterval(() => {
  for (const [id, s] of senders) {
    let n = 0;
    try { n = ndi.F.send_get_no_connections(s.ptr, 0); } catch (e) {}
    parentPort.postMessage({ kind: 'status', id, connections: n, w: s.w || 0, h: s.h || 0,
      sent: s.sent || 0, sendMs: Math.round((s.sendMs || 0) * 10) / 10 });
  }
}, 1000);
