/*
 * PROGRAM AUDIO CAPTURE — on the audio thread, where nothing can starve it.
 *
 * The broadcast used to take its sound from a MediaStreamTrackProcessor read on
 * the renderer's MAIN thread, and that thread is also compositing the program,
 * collecting video frames and driving the encoder. A reader like that hands
 * back ONE ~10 ms buffer per turn of the event loop, so the sound it can
 * collect is capped by how often that loop comes round. Measured on the
 * development laptop while streaming 1080p: the loop turned 23 times a second
 * and the reader managed 40 buffers a second against the 100 WebAudio was
 * producing — SIX SECONDS OUT OF EVERY TEN OF THE SERMON WERE THROWN AWAY,
 * which is exactly the "the sound is weird and choppy" a church then hears.
 * (At 720p the same machine kept up, which is why it went unnoticed.)
 *
 * This processor runs on the audio render thread, which is real-time and cannot
 * be blocked by anything the main thread is doing. It accumulates a whole
 * chunk — 100 ms by default — and posts it once, so the main thread receives
 * TEN messages a second instead of a hundred reads, and can absorb them even
 * while it is busy. Nothing is dropped: the audio thread always runs.
 *
 * The timestamp travels with the samples and is a running FRAME COUNT, not a
 * clock reading, so the timeline is gap-free by construction and immune to
 * however late the main thread gets round to the message.
 */
class ProgramCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const ms = Math.max(20, Math.min(500, Number(o.chunkMs) || 100));
    this.size = Math.max(128, Math.round((ms * sampleRate) / 1000));
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.n = 0;
    this.startFrame = -1;
    this.running = true;
    /*
     * WHERE THE SOUND IS POSTED TO.
     *
     * Normally this processor's own port, which lands on the renderer's main
     * thread. But the broadcast capture runs on a worker now (see
     * capture-worker.js), and the engine there estimates the picture's and the
     * sound's clock epochs from when each ARRIVES — which only cancels the
     * reading thread's delay if both arrive on the SAME thread. So the main
     * thread hands this processor a port to the worker and the sound goes
     * straight there, never touching the renderer at all.
     *
     * If a host cannot transfer a port in (an older Chromium, a test harness),
     * `out` simply stays null and everything behaves exactly as before.
     */
    this.out = null;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.cmd === 'stop') { this.running = false; return; }
      if (d.cmd === 'route') {
        this.out = d.port || null;
        // Acknowledged on the ORIGINAL port, so the main thread learns whether
        // the routing took rather than assuming it did.
        try { this.port.postMessage({ routed: !!this.out }); } catch (err) {}
      }
    };
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    const L = input && input[0] ? input[0] : null;
    const R = input && input[1] ? input[1] : L;
    // A disconnected or silent input still has to advance the timeline, or the
    // sound would close up its own silences and walk ahead of the picture.
    const len = L ? L.length : 128;
    if (this.startFrame < 0) this.startFrame = currentFrame;
    for (let i = 0; i < len; i++) {
      this.left[this.n] = L ? L[i] : 0;
      this.right[this.n] = R ? R[i] : (L ? L[i] : 0);
      if (++this.n === this.size) this.flush();
    }
    return true;
  }

  flush() {
    // One transferable buffer, planar: all of the left channel then all of the
    // right, which is exactly the layout AudioData's 'f32-planar' wants.
    const out = new Float32Array(this.size * 2);
    out.set(this.left, 0);
    out.set(this.right, this.size);
    (this.out || this.port).postMessage({ frames: this.size, startFrame: this.startFrame, buf: out.buffer }, [out.buffer]);
    this.startFrame += this.size;
    this.n = 0;
  }
}

registerProcessor('mw-program-capture', ProgramCaptureProcessor);
