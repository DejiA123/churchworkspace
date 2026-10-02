'use strict';
/*
 * MAKING THE BITRATE ON THE WIRE ACTUALLY BE THE BITRATE WE PROMISED.
 *
 * A platform judges a live stream by how many bits per second arrive. It does
 * not know, or care, what the encoder was CONFIGURED to send. Those two numbers
 * are not the same, and on the exact content a church streams they are not even
 * close. Measured on the development machine, 10 seconds of a completely still
 * lyric slide at 1920x1080, asked for 6000 kbps in constant-bitrate mode:
 *
 *     hardware (Media Foundation)      5400 kbps      90% of ask
 *     software (Chromium's openh264)    104 kbps       2% of ask
 *
 * Both are "correct" compression: a still picture genuinely costs almost
 * nothing to encode. But a platform reading 104 kbps off the wire says the
 * stream is broken, and it is right to — that is not a picture anyone can
 * re-time, buffer or transcode reliably.
 *
 * This is a solved problem in H.264 and every broadcast encoder does it. x264's
 * `nal-hrd=cbr` and NVENC's CBR mode both PAD each access unit up to the
 * promised rate with FILLER DATA — NAL unit type 12, whose entire purpose in
 * the standard is to be thrown away by the decoder. OBS streams a static scene
 * at exactly its configured bitrate for precisely this reason, which is why an
 * OBS user never sees the low-bitrate warning on a slide and this app's users
 * saw it every service.
 *
 * WebCodecs has no such setting. It hands back the chunk it made and that is
 * that. So the padding is done here, between the encoder and the muxer, on the
 * chunk's own bytes — which is the same place x264 does it, one layer up.
 *
 * WHY THIS IS SAFE. Filler NALs are defined by the standard as ignorable and
 * must follow the last coded slice of the access unit, which is where these go.
 * They survive `-c copy` through the whole chain this app uses (fragmented MP4
 * in, MPEG-TS in the middle, FLV out to the platform) because a copy moves
 * packet bytes verbatim. Nothing decodes differently; only the byte count
 * changes, which is the entire point.
 *
 * WHEN IT IS NOT SAFE, IT DOES NOT HAPPEN. The chunk is verified to be
 * length-prefixed AVCC before a single byte is added, and if it ever isn't, the
 * padder switches itself off for the rest of the broadcast and says so. A
 * stream that is slightly under-rated is a warning; a stream with a malformed
 * access unit in it is a dead broadcast.
 *
 * WHAT IT COSTS. Exactly the bitrate that was asked for, which the pre-flight
 * check (uplink.js) has already established the line can carry — that is the
 * contract, and it is why padding is only ever turned on for a rate chosen to
 * fit. It is NOT turned on for a recording-only session: a recording has no
 * platform to satisfy and no reason to carry a gigabyte of nothing.
 */
globalThis.H264Filler = (() => {
  /* A filler NAL is a 4-byte big-endian length, then the NAL header byte
   * (forbidden_zero=0, nal_ref_idc=0, nal_unit_type=12 → 0x0C), then
   * filler_payload — 0xFF bytes — then rbsp_trailing_bits (0x80). So the
   * smallest one that can exist is 6 bytes on the wire. */
  const LEN_PREFIX = 4;
  const NAL_FILLER = 0x0c;
  const MIN_FILLER = LEN_PREFIX + 2;

  /**
   * Is this chunk really 4-byte-length-prefixed AVCC?
   *
   * Walked in full rather than sampled: a chunk that ALMOST parses is the
   * dangerous case, because appending to it produces a stream that fails
   * somewhere downstream, hours later, on one platform.
   */
  function isAvcc(bytes) {
    const n = bytes.length;
    if (n < LEN_PREFIX + 1) return false;
    let p = 0;
    while (p + LEN_PREFIX <= n) {
      const len = (bytes[p] << 24 >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3];
      if (len <= 0) return false;
      p += LEN_PREFIX + len;
      if (p > n) return false;
    }
    return p === n;
  }

  /** Write a `total`-byte filler NAL (length prefix included) at `at`. */
  function writeFiller(buf, at, total) {
    const payload = total - LEN_PREFIX;
    buf[at] = (payload >>> 24) & 0xff;
    buf[at + 1] = (payload >>> 16) & 0xff;
    buf[at + 2] = (payload >>> 8) & 0xff;
    buf[at + 3] = payload & 0xff;
    buf[at + LEN_PREFIX] = NAL_FILLER;
    buf.fill(0xff, at + LEN_PREFIX + 1, at + total - 1);
    buf[at + total - 1] = 0x80;       // rbsp_stop_one_bit
  }

  /** `total` bytes of filler NAL on their own — the shape, for the tests. */
  function fillerNal(total) {
    const out = new Uint8Array(total);
    writeFiller(out, 0, total);
    return out;
  }

  /**
   * A constant-bitrate top-up, running as a leaky bucket.
   *
   * Every frame earns one frame's worth of the promised rate and spends what
   * the encoder actually produced; whatever is left over is added as filler.
   * Credit is capped both ways on purpose:
   *
   *   - CREDIT_SEC caps how much a quiet passage can bank. Without it, ten
   *     minutes of a still slide would bank ten minutes of bits and then dump
   *     them onto the line the moment somebody walked on stage — a burst is
   *     the one thing a full church line cannot absorb.
   *   - DEBT_SEC caps how far an over-shooting burst can borrow. Without it a
   *     single busy passage switches padding off for the rest of the service
   *     and the warning comes back for the sermon.
   *
   * BURST_FRAMES caps a single frame's filler so the top-up is spread over the
   * next few frames instead of landing in one packet, which is what keeps the
   * shed logic downstream (see TsShedder) reading a smooth feed.
   */
  const CREDIT_SEC = 1.0;
  const DEBT_SEC = 2.0;
  const BURST_FRAMES = 3;

  function create({ targetKbps, fps }) {
    let rate = Math.max(0, Number(targetKbps) || 0) * 1000 / 8;   // bytes per second
    const rateFps = Math.max(1, Number(fps) || 30);
    let perFrame = rate / rateFps;
    const st = {
      owed: 0, padded: 0, coded: 0, frames: 0, off: !rate, reason: rate ? '' : 'no target rate',
      paused: false,
    };

    return {
      get disabled() { return st.off; },
      get paused() { return st.paused; },
      get reason() { return st.reason; },
      get targetKbps() { return Math.round((rate * 8) / 1000); },
      /*
       * STAND DOWN WHILE THE LINE IS THE PROBLEM.
       *
       * Auto-fit only ever lowers the rate because the upload cannot carry it.
       * Padding through that spends the whole of a reduced budget on bytes that
       * are not picture, on the one connection that has already proved it has
       * nothing spare — measured, it is what turns a stream the app was coping
       * with into one that sheds frames and drifts past the platform's keyframe
       * limit.
       *
       * And it buys nothing even in its own terms: the low-bitrate warning is
       * about the picture SIZE being more than the bitrate pays for, and the
       * size has not changed. Filler cannot answer it. The honest answer on a
       * line like that is a smaller picture, which is what the on-air banner
       * says. So the pad waits, and comes back when the line gives the rate
       * back. Banked credit is dropped on the way out, never spent into the
       * congestion that caused this.
       */
      suspend() { if (!st.paused) { st.paused = true; st.owed = Math.min(st.owed, 0); } },
      resume() { st.paused = false; },
      /**
       * Follow the encoder when auto-fit re-rates it mid-broadcast.
       *
       * Banked credit is dropped on the way DOWN and only on the way down: the
       * rate came off because the line is full, and spending a second of
       * banked bits into a congested line is the one thing that would make the
       * judder it was lowered to prevent measurably worse.
       */
      retarget(kbps) {
        const next = Math.max(0, Number(kbps) || 0) * 1000 / 8;
        if (next < rate) st.owed = Math.min(st.owed, 0);
        rate = next;
        perFrame = rate / rateFps;
        if (!rate) { st.off = true; st.reason = 'target rate withdrawn'; }
      },
      /** Bytes of real picture + bytes of filler this padder has seen/added. */
      stats() {
        return { coded: st.coded, padded: st.padded, frames: st.frames, off: st.off, reason: st.reason,
          paused: st.paused,
          // what the wire is actually carrying, which is the number the
          // platform is about to compare against its recommendation
          kbps: st.frames ? ((st.coded + st.padded) * 8) / (st.frames / rateFps) / 1000 : 0 };
      },
      /** Turn it off for good — used when the encoder is restarted onto a path
       *  whose bytes we have not verified. */
      stop(why) { st.off = true; if (why) st.reason = why; },

      /** How much filler this frame earns. Bookkeeping only — no bytes moved. */
      owedFor(len) {
        st.frames++;
        st.coded += len;
        st.owed += perFrame - len;
        if (st.owed > rate * CREDIT_SEC) st.owed = rate * CREDIT_SEC;
        if (st.owed < -rate * DEBT_SEC) st.owed = -rate * DEBT_SEC;
        const want = Math.min(Math.floor(st.owed), Math.floor(perFrame * BURST_FRAMES));
        return want < MIN_FILLER ? 0 : want;
      },

      /**
       * Give it the encoder's bytes, get back the bytes to mux.
       *
       * Returns the SAME array when nothing needs adding, so the common case
       * (a busy picture already at rate) costs one comparison and no copy.
       */
      pad(bytes) {
        if (st.off || st.paused || !bytes || !bytes.length) return bytes;
        const want = this.owedFor(bytes.length);
        if (!want) return bytes;
        // Verified once per frame: cheap next to encoding one, and the only
        // thing standing between a bad assumption and a corrupt broadcast.
        if (!isAvcc(bytes)) {
          st.off = true;
          st.reason = 'the encoder did not hand back length-prefixed H.264';
          return bytes;
        }
        const out = new Uint8Array(bytes.length + want);
        out.set(bytes, 0);
        writeFiller(out, bytes.length, want);
        st.owed -= want;
        st.padded += want;
        return out;
      },

      /**
       * The on-air path: ONE buffer, ONE copy.
       *
       * `pad()` above is the readable form and the one the tests drive, but it
       * costs a second full copy of every frame — the caller has to materialise
       * the chunk before handing it over, and then it is copied again into the
       * padded buffer. On a machine already compositing a service and feeding
       * seven destinations that showed up as real frames off the compositor
       * (measured: 29fps → 23), and a broadcast must never pay for its own
       * bookkeeping. So the destination buffer is sized first and the encoder
       * is asked to write straight into it.
       *
       * `copyInto(view)` must fill `view` with exactly the chunk's bytes —
       * `EncodedVideoChunk.copyTo` does precisely that.
       */
      padChunk(len, copyInto) {
        const want = (st.off || st.paused || !len) ? 0 : this.owedFor(len);
        const out = new Uint8Array(len + want);
        copyInto(want ? out.subarray(0, len) : out);
        if (!want) return out;
        if (!isAvcc(out.subarray(0, len))) {
          st.off = true;
          st.reason = 'the encoder did not hand back length-prefixed H.264';
          return out.subarray(0, len);
        }
        writeFiller(out, len, want);
        st.owed -= want;
        st.padded += want;
        return out;
      },
    };
  }

  return { create, isAvcc, fillerNal, MIN_FILLER, CREDIT_SEC, DEBT_SEC, BURST_FRAMES };
})();
