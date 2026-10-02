'use strict';
/*
 * WAITING FOR THE PREACHER TO DRAW BREATH.
 *
 * This watches the level and sends a PHRASE the moment the speaker pauses, so a
 * short instruction — "next verse" — is recognised about half a second after
 * the words stop and nothing runs at all while nobody is talking.
 *
 * A preacher, though, does not pause. Measured on a real sermon this produced
 * phrases with a median length of 8.7 seconds, and a reference announced
 * mid-sentence waited all of that before anybody looked at it. So while the
 * speaking goes on it ALSO offers the last few seconds, again and again (see
 * liveWinMs), and the studio treats those look-backs differently from a
 * finished phrase. Between the two, both kinds of speaking are answered
 * promptly: the deliberate instruction and the sermon it is buried in.
 *
 * The threshold is not a fixed number, because a hall's noise floor is not a
 * fixed number. It tracks the quietest recent blocks and sits a fixed margin
 * above them, so the same code works in a silent room and under an air handler.
 *
 * The endpointer is deliberately separate from anything to do with microphones
 * (see `endpointer()` below) so test/voice-endpoint.test.js can push made-up
 * level readings through it and check where it thinks phrases start and stop
 * without needing a sound card.
 */

/* Everything is in blocks of BLOCK_MS, which is what the worklet posts. */
const BLOCK_MS = 32;
/*
 * How flat a stretch of sound has to be before it is treated as the room rather
 * than as somebody talking. Speech swings twenty dB and more between a vowel and
 * the gap after it; a fan does not move two. Twelve is comfortably between them
 * and nowhere near either.
 */
const STEADY_DB = 12;
const DEFAULTS = {
  startMs: 130,        // this much sound before it counts as someone speaking
  /*
   * How long a silence has to last before the phrase counts as finished. It is
   * dead time on every instruction, so it is as short as it can be WITHOUT
   * splitting a sentence at a breath — and splitting is the expensive failure:
   * "turn with me to John chapter three … verse sixteen" torn in half puts
   * John 3:1 on the wall instead of 3:16.
   *
   * Measured against breaths of 200, 300 and 400 ms: 460 rides through all
   * three, 400 splits on a 400 ms pause, 320 splits on 300. Preachers pause for
   * effect, so the margin stays.
   */
  hangoverMs: 460,
  minPhraseMs: 320,    // shorter than this is a cough, a door, a chair
  maxPhraseMs: 8000,   // a preacher in full flow: cut it and listen to the rest (the
                       // look-backs below already cover what is being said meanwhile)
  preRollMs: 220,      // keep a little of what came BEFORE the trigger
  marginDb: 9,         // how far over the room's own noise a voice has to be
  floorFloor: 1e-4,    // never chase the threshold below this in a silent room
  /*
   * The way back when a room genuinely gets LOUDER. The floor normally only
   * learns from blocks below the threshold (see push), which is what stops
   * continuous preaching from teaching it that speech is silence. But if an air
   * handler starts, nothing is ever below the threshold again, and without this
   * the floor would stay where it was for ever and hear the hum as a sermon.
   * After this long with nothing learnt, a level that has been FLAT across the
   * whole window (see STEADY_DB) is taken as the room's new floor. Flatness is
   * what keeps this from undoing the fix above: a hum is flat, a voice is not.
   * Measured: a hall that gains a fan is mistaken for speech for 15 s, then
   * settles, and somebody talking over that fan is still heard.
   */
  relearnMs: 8000,
  /*
   * WAITING FOR THE PAUSE IS NOT ENOUGH, BECAUSE PREACHING HAS NO PAUSES.
   *
   * The endpointer above is right about short instructions: somebody says
   * "next verse", stops, and it fires 460 ms later. But measured on two
   * minutes of a real sermon it produced FOURTEEN phrases with a median length
   * of 8.7 seconds, most of them hitting the 12-second cap — because a
   * preacher in full flow does not draw breath for half a second. So a
   * reference announced mid-sentence waited up to twelve seconds before
   * anybody even looked at it, and a quotation arrived diluted inside twelve
   * seconds of other words, where the matcher (which weighs how much of what
   * was said is the quotation) could not see it. On that same two minutes the
   * shipping design found NONE of the three things the preacher put on the
   * wall; a rolling look-back found two, and the third is beyond the model.
   *
   * So while somebody is still talking, the last few seconds are offered for
   * recognition over and over, and the endpointer keeps its job of catching
   * the end of a phrase promptly. A look-back is marked `partial`, and the
   * studio treats it differently: it is allowed to name a passage, never to
   * step the screen, because the same words appear in several overlapping
   * look-backs and "next verse" must not mean three verses.
   */
  liveWinMs: 6000,     // how much recent speech one look-back covers
  liveHopMs: 1200,     // and how often one is offered while the speaking goes on
  liveMinMs: 1500,     // ...once there is at least this much of the phrase to look at
  /*
   * THE SECOND, FASTER CHANNEL — off unless somebody switches it on.
   *
   * The pace above is a compromise between hearing things promptly and what
   * the engine doing the listening can afford; with the cloud ear it is one
   * look every 6.7 seconds, which is right for a free allowance that has to
   * last a service and far too slow for the one moment when the studio knows
   * a specific word is seconds away — the last word of the verse on the wall.
   *
   * So there is a second look-back with its own pace, which the studio arms
   * only for those few seconds (see close-follow in present.js). It is short
   * on purpose: four seconds is more than enough to carry the end of a
   * sentence, and a short clip is what makes the local model quick.
   */
  closeWinMs: 4500,
  closeHopMs: 1100,
};

/**
 * The pause-spotter, as a plain function of levels in and events out.
 *
 * Feed it one RMS per block; it returns null, or `{ start, end }` block indexes
 * describing a phrase that has just finished. Pure and synchronous, so the
 * tests can drive it with numbers.
 */
function endpointer(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const blocks = (ms) => Math.max(1, Math.round(ms / BLOCK_MS));
  const need = blocks(o.startMs), hang = blocks(o.hangoverMs);
  const minLen = blocks(o.minPhraseMs), maxLen = blocks(o.maxPhraseMs), pre = blocks(o.preRollMs);
  let i = -1;                 // block counter
  let quiet = [];             // recent quiet levels, for the noise floor
  let lastLearn = -1e9;       // …and when one of them was last actually learnt
  /*
   * How much the level MOVES over the last `relearnMs`, kept as two half-buckets
   * so it costs two numbers rather than a window of them. It answers one
   * question, asked in push(): is this sound a ROOM or is it a VOICE?
   */
  let bMin = Infinity, bMax = 0, bAt = 0, pMin = Infinity, pMax = 0;
  let floor = o.floorFloor;
  let loudRun = 0, quietRun = 0;
  let speaking = false, startAt = 0;

  let lastLook = -1e9;              // block number of the last look-back offered
  let lastClose = -1e9;             // …and of the last FAST one (see lookClose)
  let closeOn = false;
  return {
    get speaking() { return speaking; },
    get threshold() { return floor * Math.pow(10, o.marginDb / 20); },
    /**
     * A rolling look-back, or null. Call after push(): while somebody is
     * speaking and enough of the phrase has gone by, this returns the same
     * `{start, end}` shape describing the last few seconds, so the caller turns
     * it into samples exactly the way it turns a finished phrase into samples.
     */
    look() {
      if (!speaking) return null;
      const since = i - startAt;
      if (since < blocks(o.liveMinMs)) return null;
      if (i - lastLook < blocks(o.liveHopMs)) return null;
      lastLook = i;
      /*
       * REACHING BACK PAST THE START OF THE PHRASE, OR NOT.
       *
       * Clamping to `startAt` is right for the local engine: its look-back is
       * six seconds and its phrases run to eight, so the clamp almost never
       * bites, and when it does it is keeping silence out of a short window
       * that cannot spare the room.
       *
       * It is wrong for the cloud engine, and quietly so. There the window is
       * twelve seconds and the whole pacing argument rests on consecutive
       * windows overlapping by five — but a phrase boundary resets `startAt`,
       * so the first window after one carries two and a half seconds instead of
       * twelve and the overlap at that exact moment is nothing. A reference
       * spoken across a boundary would be cut in half in every window it
       * appeared in. Since a boundary arrives every time somebody has been
       * talking for a while, that is not a rare case; it is a metronome.
       *
       * What is being reached back into is the ear's own ring buffer, which is
       * sized for it, so the worst that can be picked up is a little of the
       * room before the speaker started — which a full-size model handles
       * without noticing.
       */
      const earliest = o.lookAcrossPhrases ? 0 : startAt;
      return { start: Math.max(earliest, i - blocks(o.liveWinMs)), end: i, partial: true };
    },
    /**
     * The fast channel. Same shape, its own clock, and it reaches back across
     * a phrase boundary always — a reader does not pause at a verse end, but
     * the endpointer may well decide they did, and the words this is looking
     * for are the ones either side of that decision.
     */
    lookClose() {
      if (!closeOn || !speaking) return null;
      if (i - lastClose < blocks(o.closeHopMs)) return null;
      lastClose = i;
      return { start: Math.max(0, i - blocks(o.closeWinMs)), end: i, close: true, partial: true };
    },
    setClose(on) { closeOn = !!on; if (!on) lastClose = -1e9; },
    get close() { return closeOn; },
    /** One block's RMS in; a finished phrase out, or null. */
    push(rms) {
      i++;
      const th = floor * Math.pow(10, o.marginDb / 20);
      const loud = rms > th;
      bMin = Math.min(bMin, rms); bMax = Math.max(bMax, rms);
      if (i - bAt >= blocks(o.relearnMs)) { pMin = bMin; pMax = bMax; bMin = Infinity; bMax = 0; bAt = i; }
      const rMin = Math.min(pMin, bMin), rMax = Math.max(pMax, bMax);
      // Flat to within STEADY_DB across the whole window: a fan, a hum, a PA
      // hiss — never a person talking.
      const steady = rMax <= rMin * Math.pow(10, STEADY_DB / 20);
      if (!speaking) {
        /*
         * The floor only learns while nobody is speaking, otherwise the voice
         * would drag it up behind itself and the phrase would end mid-sentence.
         *
         * ►► AND ONLY FROM BLOCKS THAT ARE ACTUALLY QUIET. ◄◄
         *
         * "While nobody is speaking" turned out not to mean "while the room is
         * quiet", and the gap between those two is a bug that KILLS THE FEATURE
         * OUTRIGHT partway through a sermon.
         *
         * Here is the path. A preacher in full flow never pauses long enough to
         * end a phrase, so phrases end at the length cap instead — and at that
         * moment the speaker is still talking. `speaking` goes false, and the
         * next few blocks, which are loud mid-word speech, were fed to the
         * noise floor as though they were the room. Only about four blocks get
         * sampled before speech is detected again, so the effect is small; but
         * it happens at every cap, the buffer holds sixty samples, and nothing
         * ever puts a quiet one back while the preaching continues. After
         * roughly eleven caps the 30th percentile of the buffer IS speech
         * level, the threshold sits 9 dB above THAT, and from then on nothing
         * in the hall is ever loud enough to count as speaking again.
         *
         * Listen does not fail noisily when this happens. It stops having any
         * opinion at all: no phrases, no look-backs, no transcript, a level
         * meter that still moves. Driven with continuous speech the shipping
         * settings went deaf after 84 seconds of 600.
         *
         * So a block only teaches the floor when it is below the threshold —
         * which is the thing "the quietest recent blocks" was always meant to
         * mean. `relearnMs` is the way back for the opposite case: if a room
         * genuinely gets louder (an air handler starts, a PA is turned up)
         * nothing is ever below threshold again, and without a valve the floor
         * would be stuck too low for ever, hearing the hum as speech.
         */
        const learn = () => {
          lastLearn = i;
          quiet.push(rms);
          if (quiet.length > 60) quiet.shift();
          const sorted = quiet.slice().sort((a, b) => a - b);
          floor = Math.max(o.floorFloor, sorted[Math.floor(sorted.length * 0.3)] || o.floorFloor);
        };
        if (!loud) learn();
        else if (steady && i - lastLearn > blocks(o.relearnMs)) {
          /*
           * THE VALVE, AND WHY IT ASKS WHETHER THE LEVEL IS STEADY.
           *
           * A first attempt at this opened the valve on time alone — nothing
           * learnt for eight seconds, so take the next block whatever it is.
           * That quietly rebuilds the very bug above, just more slowly: during
           * continuous preaching nothing is ever below the threshold, so the
           * valve fires at every phrase cap and feeds the floor one block of
           * speech each time, until twenty of them have gone in and it is deaf
           * again. A bug that takes six minutes instead of ninety seconds to
           * kill the feature is not a fixed bug, it is a harder one to find.
           *
           * What actually separates the two cases is not how long it has been,
           * it is whether the sound MOVES. A hall with a fan in it sits inside a
           * couple of dB for minutes; speech swings twenty or more between a
           * vowel and the gap after it. So the valve only opens on a level that
           * has been flat across the whole window — which speech never is — and
           * when it does open it throws the old buffer away rather than
           * out-voting it sixty times, because by then the old buffer describes
           * a room that no longer exists.
           */
          quiet.length = 0;
          learn();
        }
      }
      if (loud) { loudRun++; quietRun = 0; } else { quietRun++; loudRun = 0; }

      if (!speaking && loudRun >= need) {
        speaking = true;
        startAt = Math.max(0, i - loudRun - pre);
        return null;
      }
      if (speaking) {
        const len = i - startAt;
        if (quietRun >= hang || len >= maxLen) {
          speaking = false;
          /*
           * A PHRASE THAT ENDED, AND A PHRASE THAT WAS CUT, ARE NOT THE SAME
           * THING — and until now they arrived looking identical.
           *
           * Ending on silence means somebody stopped talking, which is what a
           * deliberate instruction looks like: "Next verse." Ending on `maxLen`
           * means a preacher in full flow has simply been talking for eight
           * seconds and the ear had to cut somewhere. That second kind is not
           * an instruction anybody gave; it is the middle of a sentence with a
           * hard edge on it.
           *
           * Nothing here behaves differently — the same samples go the same
           * way, so the local path is byte for byte what it was. `capped` is
           * for the CLOUD engine's allowance: a finished phrase is allowed to
           * spend into the reserve because there is no second chance at it,
           * and an arbitrary eight-second cut, which recurs every eight
           * seconds for the length of a sermon, very much is not.
           */
          const capped = !(quietRun >= hang);
          const end = capped ? i : i - quietRun + blocks(120);
          loudRun = 0; quietRun = 0;
          const phrase = { start: startAt, end: Math.max(startAt + 1, end), capped };
          return (phrase.end - phrase.start) >= minLen ? phrase : null;
        }
      }
      return null;
    },
  };
}

/**
 * The real ear: microphone in, finished phrases out as 16 kHz mono Int16.
 *
 * `onPhrase(int16)` fires once per phrase. `onLevel(rms, speaking)` fires every
 * block so the studio can show a meter — an operator who can see the bar move
 * knows the microphone is live, which is the first thing they will ask.
 */
async function createEar({ onPhrase, onClose, onLevel, onError, deviceId = null, stream: given = null, opts = {} } = {}) {
  const rate = 16000;                 // whisper's rate; asking for it here avoids resampling later
  const ac = new AudioContext({ sampleRate: rate });
  let stream = null, node = null, src = null, stopped = false;
  const ep = endpointer(opts);
  // Recent blocks, with the absolute number of the first one still held. The
  // endpointer talks in absolute block numbers, so keeping this makes turning a
  // phrase into samples a subtraction rather than a puzzle.
  const keep = [];
  let keepFrom = 0, blockNo = -1;
  /*
   * THE RING HAS TO BE LONGER THAN THE LONGEST THING THAT CAN BE ASKED FOR.
   *
   * This was `maxPhraseMs + 3000`, which was right while a look-back was always
   * six seconds: the longest span anyone could ask for was an eight-second
   * phrase. The cloud engine asks for TWELVE-second look-backs (see cadence()
   * in cloudspeech.js — the overlap is what decides whether a spoken reference
   * survives a window boundary), and a ring that only holds eleven seconds does
   * not report that: `samplesOf` clamps to what it has and hands back a shorter
   * clip, so the overlap the whole pacing argument rests on would quietly not
   * exist. Sizing it from the settings actually in force is the only version of
   * this that cannot drift.
   */
  const o = Object.assign({}, DEFAULTS, opts);
  const maxKeep = Math.ceil((Math.max(o.maxPhraseMs, o.liveWinMs) + 3000) / BLOCK_MS);

  try {
    /*
     * A stream can be handed in rather than opened here — that is how an NDI
     * feed is listened to (see ndi-listen.js). The church's sound is often on
     * the network and nowhere else: a room running Ableton's NDI Output VST, or
     * a vMix desk publishing its master bus, has no sound card carrying the
     * service at all, so getUserMedia can only ever offer the wrong thing.
     *
     * None of the getUserMedia processing applies to such a stream, and it does
     * not need it: what arrives is a desk feed that has already been through a
     * mixer, not an open microphone in a hall.
     */
    stream = given || await navigator.mediaDevices.getUserMedia({
      audio: Object.assign({
        channelCount: 1,
        // The room is the thing being spoken in, not a thing to cancel: echo
        // cancellation is tuned for a caller listening to a far end and eats
        // into a preacher on an open mic. Noise suppression and levelling do
        // help whisper, so they stay on.
        echoCancellation: false, noiseSuppression: true, autoGainControl: true,
      }, deviceId ? { deviceId: { exact: deviceId } } : {}),
      video: false,
    });
    await ac.audioWorklet.addModule('voice-worklet.js');
    src = ac.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ac, 'voice-ear', { processorOptions: { blockMs: BLOCK_MS }, numberOfOutputs: 0 });
    /** Blocks [start..end] of the ring, as 16-bit samples. */
    const samplesOf = (span) => {
      const from = Math.max(0, span.start - keepFrom);
      const to = Math.min(keep.length, span.end - keepFrom + 1);
      const slice = keep.slice(from, Math.max(from + 1, to));
      if (!slice.length) return null;
      let n = 0; for (const b of slice) n += b.length;
      const out = new Int16Array(n);
      let k = 0;
      for (const b of slice) {
        for (let j = 0; j < b.length; j++) {
          const v = Math.max(-1, Math.min(1, b[j]));
          out[k++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
      }
      return out;
    };
    node.port.onmessage = (e) => {
      if (stopped) return;
      const { pcm, rms } = e.data;
      blockNo++;
      keep.push(pcm);
      while (keep.length > maxKeep) { keep.shift(); keepFrom++; }
      if (onLevel) onLevel(rms, ep.speaking);
      const phrase = ep.push(rms);
      if (phrase) {
        const out = samplesOf(phrase);
        if (out && onPhrase) onPhrase(out, { partial: false, capped: !!phrase.capped });
        return;
      }
      // Still talking: offer the last few seconds again, so a reference said
      // mid-sentence does not wait for a pause that is not coming.
      const look = ep.look();
      if (look) {
        const out = samplesOf(look);
        if (out && onPhrase) onPhrase(out, { partial: true });
      }
      /*
       * …and, only while the studio has armed it, a shorter one far more often.
       * It is offered SEPARATELY rather than folded into the line above so the
       * studio can send it somewhere else entirely: these go to the model on
       * this PC and never to the cloud. See close-follow in present.js.
       */
      const close = ep.lookClose();
      if (close && onClose) {
        const out = samplesOf(close);
        if (out) onClose(out);
      }
    };
    src.connect(node);
  } catch (e) {
    // Only a stream this function opened is this function's to close. One
    // handed in belongs to whoever made it, and stopping its tracks here would
    // tear down an NDI receiver the caller still owns.
    try { if (stream && !given) stream.getTracks().forEach((t) => t.stop()); } catch (e2) {}
    try { await ac.close(); } catch (e2) {}
    if (onError) onError(e);
    throw e;
  }

  return {
    get sampleRate() { return rate; },
    get speaking() { return ep.speaking; },
    /** Arm or stand down the fast local look-back. Free when off. */
    setCloseLook(on) { try { ep.setClose(on); } catch (e) {} },
    get closeLook() { return !!ep.close; },
    stop() {
      stopped = true;
      try { node && node.port.postMessage({ cmd: 'stop' }); } catch (e) {}
      try { src && src.disconnect(); } catch (e) {}
      try { if (stream && !given) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      try { ac.close(); } catch (e) {}
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { endpointer, createEar, BLOCK_MS, DEFAULTS };
if (typeof window !== 'undefined') window.VoiceEar = { endpointer, createEar, BLOCK_MS, DEFAULTS };
