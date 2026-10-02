'use strict';
/*
 * THE BROADCAST CAPTURE, ON ITS OWN THREAD.
 *
 * This worker exists for one reason: the renderer's main thread cannot do two
 * real-time jobs at once. It composites the program, draws the preview monitor,
 * repaints every source thumbnail, runs the mixer meters and answers the desk —
 * and it was ALSO collecting every frame of the broadcast, pacing them onto a
 * constant grid, driving an H.264 encoder and an AAC encoder, and muxing the
 * result. Measured on the development laptop at 1080p to three platforms:
 *
 *     the compositor drew 28.6 fps · the encoder collected 23.0
 *     each platform received 21.4 of 30 · keyframes up to 6.0s apart
 *
 * Frames were being drawn and then thrown away before anything encoded them,
 * and the pacer — the thing that guarantees a platform a constant frame rate —
 * stands down when the encoder has no headroom, which on a busy main thread is
 * most of the time. A platform receiving a stream that CLAIMS 30fps and
 * delivers a variable one re-times it onto its own clock, and re-timing the
 * picture stretches the SOUND to match. That is the whole of "Facebook is
 * perfect and YouTube's audio goes weird at 1080p" — and it is also why the
 * preview monitor stuttered, since the compositor was sharing a thread with a
 * live encoder.
 *
 * Everything the capture does now happens here instead. The main thread's only
 * remaining job is to hand over two things at the start — the program canvas's
 * frame stream and a port to the audio tap — and then to pass the finished
 * fragments to the hub. Both of those are cheap.
 *
 * WHY THE SOUND COMES HERE TOO, rather than staying where it was: the engine
 * estimates both tracks' clock epochs from when their samples ARRIVE, so that
 * whatever delay the reading thread is under cancels between them (see
 * capture-engine.js). That only holds while both pumps read on the SAME
 * thread. Leaving the audio on the main thread would place the picture
 * perfectly and leave the sound behind by the whole of the main thread's delay
 * — on exactly the loaded machine least able to afford it.
 */

importScripts('vendor/mp4-muxer.js', 'h264-filler.js', 'capture-engine.js');

let eng = null;
let diagTimer = 0;
/*
 * Which capture session everything below belongs to. The worker outlives any
 * one broadcast, so every message it sends is stamped and the main thread
 * ignores anything from a session it has already finished with — otherwise a
 * closing fragment from the old session could be counted against the new one.
 */
let sid = 0;
/*
 * ONE audio port for the whole run, not one per broadcast.
 *
 * The program-audio worklet is created when Go Live first builds its audio
 * graph and stays connected for the life of the app, so routing it here once
 * means a second, third or tenth broadcast needs no handshake — and, more
 * importantly, nothing piles up on an unread port between broadcasts. While no
 * capture is running the buffers are simply dropped on arrival, which costs a
 * few discarded kilobytes a second and keeps the timeline of the NEXT
 * broadcast starting where that broadcast starts.
 */
let audioPort = null;

/*
 * The main thread reads `clockDiag()` and `fillerStats()` synchronously — the
 * auto-fit banner, the "is there a picture in this stream yet?" gate before a
 * destination is told to go live, and the test hooks all do. Asking across a
 * thread boundary cannot be synchronous, so the worker PUSHES a snapshot on a
 * slow timer and the main thread reads its own copy. Nothing here is used for
 * a decision that a tenth of a second of staleness could change: the picture
 * gate polls for seconds, and the banners are judged over fifteen.
 */
const DIAG_MS = 120;

function pushDiag() {
  if (!eng) return;
  try {
    self.postMessage({
      t: 'diag', sid,
      clock: eng.clockDiag(),
      filler: eng.fillerStats(),
      videoKbps: eng.videoKbps,
      state: eng.state,
    });
  } catch (e) {}
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  switch (m.cmd) {
    case 'attachAudio': {
      audioPort = m.port || null;
      if (audioPort) {
        audioPort.onmessage = (e) => { if (eng && eng.feedAudio) eng.feedAudio(e.data); };
        try { audioPort.start(); } catch (e) {}
      }
      self.postMessage({ t: 'audioAttached', ok: !!audioPort });
      break;
    }
    case 'start': {
      clearInterval(diagTimer); diagTimer = 0;
      sid = m.sid || 0;
      try {
        eng = CaptureEngine.create({
          cfg: m.cfg,
          video: m.video,
          fromWorklet: !!(m.fromWorklet && audioPort),
          audio: m.audio || null,
          onChunk: ((mine) => (buf) => {
            // Stamped with the session that made it, so a fragment flushed
            // after a restart cannot be fed to the new session's hub.
            self.postMessage({ t: 'chunk', sid: mine, buf }, [buf]);
          })(sid),
          // A capture that gives up has to say so on the main thread, which is
          // the only place that can start the fallback session.
          onFail: ((mine) => (e) => {
            self.postMessage({ t: 'fail', sid: mine, message: (e && e.message) || String(e) });
          })(sid),
        });
        diagTimer = setInterval(pushDiag, DIAG_MS);
        self.postMessage({ t: 'started', sid, mimeType: eng.mimeType, videoKbps: eng.videoKbps });
      } catch (e) {
        // Thrown out of create() — the encoder would not configure at all.
        eng = null;
        self.postMessage({ t: 'fail', sid, message: (e && e.message) || String(e), fatal: true });
      }
      break;
    }
    case 'setBitrate': {
      // The main thread has already answered the hub optimistically; a REFUSAL
      // is what has to travel back, so the hub stops believing it is sending
      // less than it is.
      const ok = !!(eng && eng.setBitrate(m.kbps));
      self.postMessage({ t: 'rate', sid, kbps: m.kbps, ok });
      pushDiag();
      break;
    }
    case 'setPad': {
      if (eng) eng.setPad(m.kbps, m.floorKbps);
      pushDiag();
      break;
    }
    case 'stop': {
      clearInterval(diagTimer); diagTimer = 0;
      const cur = eng;
      const done = () => {
        pushDiag();
        // Released only after the flush, so a late chunk still has somewhere
        // to go; from here the audio port drops what it receives until the
        // next broadcast asks for it.
        if (eng === cur) eng = null;
        self.postMessage({ t: 'stopped', sid: m.sid || sid });
      };
      if (!cur) { done(); break; }
      // stop() flushes both encoders and finalises the muxer, so the last
      // fragments still go out ahead of the 'stopped' message.
      Promise.resolve(cur.stop()).then(done, done);
      break;
    }
    default: break;
  }
};
