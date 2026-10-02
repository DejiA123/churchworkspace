'use strict';
/*
 * LISTENING TO AN NDI FEED, OUTSIDE GO LIVE.
 *
 * Presentation's 🎤 Listen opens a microphone with getUserMedia, which can only
 * ever reach a device Windows knows about — a USB interface, a webcam, the PC's
 * own microphone. NDI is not a device. It is a network protocol, and until now
 * only the Go Live switcher spoke it.
 *
 * That mattered because of where a church's sound actually is. A room running
 * Ableton with the official "NDI Output" VST on the master, or a vMix desk
 * publishing "vMix Audio - Master", has NO sound card carrying the service —
 * the preacher exists on the network and nowhere else. Pointed at the only
 * device Windows offers, Listen heard an empty room and looked broken.
 *
 * So this module makes an NDI source available as an ordinary MediaStream that
 * anything in the app can consume. It reuses the pieces Go Live already proved:
 * the same main-process receiver (ndi:start), the same two-port bridge, and the
 * same jitter-buffered AudioWorklet (ndi-audio-worklet.js) that locks the
 * sender's clock to ours rather than letting a service drift.
 *
 * WHY IT HANDS BACK A MediaStream rather than raw samples: the ear runs its
 * AudioContext at 16 kHz, which is whisper's rate, and NDI arrives at 48. Going
 * through a MediaStream lets Chromium's own resampler do that conversion.
 * Downsampling 48k to 16k by hand needs a proper anti-alias filter — do it with
 * bare linear interpolation and every consonant above 8 kHz folds back into the
 * speech as a hiss, which is precisely the band whisper listens hardest to.
 */
window.NdiListen = (() => {
  const TARGET_MS = 80;   // a touch deeper than Go Live's: nothing here is lip-synced

  /* One bridge for every receiver this module opens. The main process hands
   * over two MessagePorts per source — video and audio travel separately so a
   * multi-megabyte frame can never hold a two-kilobyte audio packet up behind
   * it — and each receiver claims its own by id. Go Live keeps a bridge of its
   * own for its inputs; the ids never collide, so the two ignore each other. */
  const handlers = new Map();   // id -> (msg) => void
  const portsById = new Map();  // id -> MessagePort[]

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || !d.__ndiPort || !ev.ports || !ev.ports.length) return;
    const id = d.id;
    if (!handlers.has(id)) return;          // not one of ours
    closePorts(id);
    const ports = [...ev.ports];
    portsById.set(id, ports);
    for (const port of ports) {
      port.onmessage = (m) => {
        const fn = handlers.get(id);
        if (fn && m.data) fn(m.data);
      };
      port.start();
    }
  });

  function closePorts(id) {
    const ports = portsById.get(id);
    if (!ports) return;
    for (const p of ports) { try { p.onmessage = null; p.close(); } catch (e) {} }
    portsById.delete(id);
  }

  /** Is NDI usable on this computer at all? */
  async function available() {
    try {
      const s = await window.api.live.ndiStatus();
      return { ok: !!(s && s.available), error: (s && s.error) || '' };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  /** Everything currently publishing on the network. */
  async function sources() {
    try { return (await window.api.live.ndiSources()) || []; } catch (e) { return []; }
  }

  /** A stable name for a source, used as the saved setting. */
  function nameOf(src) {
    return (src && (src.display || src.stream || src.name)) || '';
  }

  /** …and back again, so a saved choice survives a restart. */
  function findByName(list, name) {
    if (!name) return null;
    return (list || []).find((s) => nameOf(s) === name) || null;
  }

  /*
   * Rate conversion, used ONLY when the sender's rate differs from this
   * AudioContext's — normally it does not (both are 48 kHz) and this is a
   * straight pass-through. It is deliberately not the 48→16 conversion: that
   * one is a real downsample and belongs to Chromium's resampler, on the other
   * side of the MediaStream.
   *
   * This used to be bare per-packet linear interpolation — the same function
   * Go Live had, with the same two faults: the read phase restarted at zero on
   * every packet (broadband distortion that measured LOUDER THAN THE SIGNAL
   * above 3 kHz) and the output length was rounded per packet (drift). It was
   * invisible here for the same reason it was invisible there: both ends are
   * normally 48 kHz, so the function returned early and never ran. A 44.1 kHz
   * sender — some desks, some plug-ins — got the broken path, and what it feeds
   * is whisper, which listens hardest at exactly the frequencies the aliasing
   * lands on. See audio-resampler.js.
   *
   * ONE CONVERTER PER STREAM, because its phase and history ARE the fix; a
   * shared one would interleave two senders' state.
   */
  function makeResample(fromRate, toRate) {
    if (!fromRate || fromRate === toRate) return null;
    const rs = AudioResampler.make(fromRate, toRate);
    return (l, r) => rs.process(l, r);
  }

  /*
   * The samples arrive as BYTES (a Uint8Array over the receiver's buffer) and
   * have to be REINTERPRETED as floats, not converted. `new Float32Array(u8)`
   * is a conversion: it reads each byte as a number 0-255 and makes a float of
   * it, which is silent nonsense that measures a hundred times full scale and
   * sounds like nothing at all. The byteOffset matters too — the view need not
   * start at the beginning of its buffer.
   */
  const floats = (x) => (x instanceof Float32Array ? x
    : new Float32Array(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)));

  let seq = 0;

  /**
   * Receive `source` and hand back a live MediaStream of its sound.
   *
   * Resolves once the receiver is running, NOT once sound has arrived — an NDI
   * sender that is present but silent is a perfectly ordinary state, and making
   * the caller wait for a sample would hang on a quiet room.
   */
  async function openStream(source, opts) {
    const id = 'ndil' + (++seq) + '-' + Date.now();
    const ac = new AudioContext();
    let node = null, stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      handlers.delete(id);
      closePorts(id);
      try { window.api.live.ndiStop(id); } catch (e) {}
      try { if (node) node.disconnect(); } catch (e) {}
      try { ac.close(); } catch (e) {}
    };

    try {
      await ac.audioWorklet.addModule('ndi-audio-worklet.js');
      node = new AudioWorkletNode(ac, 'ndi-audio', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { targetMs: (opts && opts.targetMs) || TARGET_MS },
      });
      const dest = ac.createMediaStreamDestination();
      node.connect(dest);

      const state = { packets: 0, lastAt: 0, rate: 0 };
      // Built on the FIRST packet, because that is when the sender's rate is
      // finally known, and rebuilt only if that rate genuinely changes. Null
      // means the rates match and nothing needs converting at all.
      let conv = null, convFrom = -1;
      handlers.set(id, (msg) => {
        if (stopped || msg.kind !== 'audio') return;
        state.packets++;
        state.lastAt = performance.now();
        state.rate = msg.sampleRate || 0;
        if (convFrom !== msg.sampleRate) {
          convFrom = msg.sampleRate;
          conv = makeResample(msg.sampleRate, ac.sampleRate);
        }
        let l = floats(msg.left), r = floats(msg.right);
        if (conv) { const o = conv(l, r); l = o.l; r = o.r; }
        // A converter warming up its history can legitimately return nothing
        // for the first packet; an empty transfer would be a wasted message.
        if (!l.length) return;
        try { node.port.postMessage({ l, r }, [l.buffer, r.buffer]); } catch (e) {}
      });

      // audioOnly, because a video feed nobody is going to draw is pure cost in
      // three processes at once — and the sources this exists for (an Ableton
      // VST, a mixer's master bus) have no picture in the first place.
      await window.api.live.ndiStart(id, source, { audioOnly: true });
      return { id, stream: dest.stream, stop, state };
    } catch (e) {
      stop();
      throw e;
    }
  }

  return { available, sources, openStream, nameOf, findByName };
})();
