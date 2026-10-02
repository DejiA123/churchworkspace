'use strict';
/*
 * THE EAR BEHIND 🎤 LISTEN.
 *
 * The renderer holds the microphone (that is where getUserMedia lives) and does
 * the listening-for-a-pause part, because that is cheap and has to be instant.
 * What it cannot do is run a speech model, so when a phrase finishes it hands
 * the raw samples here: this module writes them out and asks whisper what was
 * said, then asks voiceref.js whether that was an instruction for the screen.
 *
 * A FINISHED PHRASE, AND ALSO THE LAST FEW SECONDS, OVER AND OVER.
 *
 * This used to run only when the speaker paused, on the reasoning that nothing
 * should run while nobody is talking. That is right about short instructions
 * and wrong about preaching: measured on a real sermon, waiting for a pause
 * produced phrases with a MEDIAN LENGTH OF 8.7 SECONDS, most of them hitting
 * the 12-second cap, so a reference announced mid-sentence waited that long
 * before anybody looked at it — and none of the three passages the preacher put
 * on the wall in those two minutes was found at all. voiceear.js now also
 * offers the last few seconds while the speaking goes on (see liveWinMs there),
 * which found two of the three and cut the wait to a couple of seconds.
 *
 * What made a single phrase slow was none of the above: see audioCtxFor below.
 * whisper encodes a thirty-second window whatever it is given, and on a
 * two-second instruction 766 ms of the 1.3 s went on encoding silence.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const captioner = require('./captioner');
const voiceref = require('./voiceref');
const whisperfast = require('./whisperfast');
const cloudspeech = require('./cloudspeech');
const { wavBuffer } = require('./wav');

const SAMPLE_RATE = 16000;         // what whisper wants; the renderer resamples to it
const MAX_SECONDS = 20;            // a phrase longer than this is a sermon, not an instruction

/*
 * WHICH MODEL, AND WHY IT IS NO LONGER THE SMALL ONE.
 *
 * `tiny.en` was chosen by measuring 22 spoken references — and it got all 22
 * right, a second faster than `base.en`. What that measurement could not see is
 * that every one of those references was said by the Windows speech
 * synthesiser: close-miked, unaccented, no room, no PA, no congregation. A
 * preacher in a hall is none of those things, and on ten minutes of a real
 * recorded sermon the two models are not close:
 *
 *                                    tiny.en      base.en
 *      whisper repeating itself      46 / 298     12 / 298
 *      verses put up wrongly          1            0
 *      "Acts chapter 6" heard as     "Acts of the Six"   "Acts chapter 6"
 *      "the field of the slothful"   "the feet of the slough"  "the field of the sloth"
 *
 * The one that fires a wrong verse into a service, and hears a spoken reference
 * as something else entirely, is not the fast one — it is the wrong one. base.en
 * costs about 700 ms more on a short instruction (measured on a 2017 laptop:
 * 299 ms against 1032 ms) and about 600 ms more on a rolling look-back, which
 * is well inside the time it takes to say the next sentence.
 */
/*
 * 'auto' rather than a pinned id — see resolveModel below. It climbs to Small
 * when a church has downloaded one and stays on the bundled Base otherwise,
 * and it never picks Medium by itself: Listen runs about forty times a minute
 * on the rolling look-backs, and Medium is ~3x slower than Base.
 */
const DEFAULT_MODEL = 'auto';

/** A 16-bit mono WAV around raw PCM — see wav.js for the header itself. */
function writeWav(file, pcm16, rate = SAMPLE_RATE) {
  fs.writeFileSync(file, wavBuffer(pcm16, rate));
  return file;
}

/**
 * Which model to listen with, and where its engine is.
 * Returns null when the speech engine is not installed, so the studio can say so
 * instead of failing silently once somebody presses the button.
 */
/**
 * WHICH MODEL LISTEN ACTUALLY USES — resolved, not assumed.
 *
 * This was pinned to `base.en`, and pinned is the wrong word for what it did:
 * a church that downloads Small for nicer captions got no benefit here at all,
 * even though the comment above says in as many words that a bigger model is
 * the single biggest accuracy lever there is. Listen went on using the bundled
 * one for ever.
 *
 * The ladder is CAPTIONER'S OWN — `pickScanModel` / `SCAN_AUTO` — and it is
 * reused rather than reinvented because the trade-off is identical to the one
 * it was written for:
 *
 *   • AUTOMATIC CLIMBS TO SMALL, NEVER TO MEDIUM. Listen does not run once: the
 *     rolling look-backs ask it roughly forty times a minute, and Medium is
 *     about 3x slower than Base. A church that downloaded Medium for captions
 *     must not discover that Listen has quietly fallen a sentence behind the
 *     preacher.
 *   • AN EXPLICIT ID IS AN INSTRUCTION and is honoured, Medium included.
 *
 * Resolving here rather than deeper down matters for one specific reason: the
 * resident fast path (whisperfast) takes a model id too, and handing it the
 * unresolved 'auto' would send it through captioner's `bestModel()`, which has
 * no Medium cap — so the two halves of this module would load DIFFERENT models
 * and the answer would depend on which path a phrase happened to take.
 */
function resolveModel(modelId) {
  // A named model is honoured as given — checked against the real list rather
  // than by looking for a dot in the id, because `large-v3-turbo` has none and
  // a dot test would quietly demote it to whatever automatic chose.
  /*
   * …and only when it is actually INSTALLED, which is not the same question.
   *
   * Honouring the mere NAME made engine() lie: `modelFor` cannot find a file
   * that was never downloaded, so it fell back to bestModel() and loaded
   * Medium while this function went on reporting Turbo. The picker shows that
   * reported id as "what you are being heard with", so the studio would have
   * claimed Turbo while Medium ran — and Medium is 3.2x SLOWER than real time,
   * so Listen would quietly fall behind the preacher with nothing on screen to
   * say why. An uninstalled choice falls through to the ladder instead, which
   * is both honest and usable.
   */
  if (modelId && modelId !== 'auto') {
    let installed = false;
    try { installed = (captioner.models() || []).some((m) => m.id === modelId && m.installed); } catch (e) {}
    if (installed) return modelId;
  }
  let ids = [];
  try { ids = (captioner.models() || []).filter((m) => m.installed).map((m) => m.id); } catch (e) {}
  try { return captioner.pickScanModel(ids, null); } catch (e) { return 'base.en'; }
}

function engine(modelId = DEFAULT_MODEL) {
  const p = captioner.whisperPaths();
  if (!p.cliFound) return null;
  const want = resolveModel(modelId);
  const model = captioner.modelFor ? captioner.modelFor(want) : null;
  const file = model || p.modelTiny || p.model;
  if (!file || !fs.existsSync(file)) return null;
  return { cli: p.cli, model: file, modelId: want };
}

/**
 * HOW MUCH OF THE ENCODER'S WINDOW THIS PHRASE ACTUALLY NEEDS.
 *
 * whisper encodes a THIRTY SECOND window no matter what it is given. Measured
 * on "Next verse." — 1.2 seconds of speech — the breakdown was:
 *
 *      encode ....... 766 ms      <- almost all of it spent on silent padding
 *      model load ... 233 ms
 *      decode ........ 26 ms
 *      mel ............ 7 ms
 *
 * So the slow part was never the recognising, it was encoding 29 seconds of
 * nothing. `--audio-ctx` shortens that window. The full context is 1500 for
 * 30 s, so a phrase needs about 50 per second of speech; the multiplier and the
 * floor are margin.
 *
 * THE MARGIN IS NOT DECORATION. Measured on 22 spoken instructions, every
 * context from 1500 down to 192 got all 22 right — and then 128 got 15, because
 * a window that is too short does not fail, it LOOPS: "Turn with me to John
 * chapter 3, 3, 3, 3, 3, 3…" for a hundred repetitions, which parses as a
 * confident, wrong "John 3". A cliff that steep, with no error to catch, is why
 * the floor sits at 256 rather than at the last value that happened to work.
 */
const AUDIO_CTX_PER_SECOND = 50;
const AUDIO_CTX_FLOOR = 256;
const AUDIO_CTX_FULL = 1500;
function audioCtxFor(seconds) {
  const need = Math.ceil(Math.max(0, seconds) * AUDIO_CTX_PER_SECOND * 1.4) + 64;
  return Math.max(AUDIO_CTX_FLOOR, Math.min(AUDIO_CTX_FULL, need));
}

/** Run whisper on one phrase. Resolves to the plain text it heard. */
function transcribeFile(cli, model, wav, { signal, threads, audioCtx, fallback = true } = {}) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(cli);
    captioner.ensureExecutable(cli);
    const env = Object.assign({}, process.env);
    if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = [dir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
      env.DYLD_FALLBACK_LIBRARY_PATH = [dir, env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':');
    } else if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
    // -nt plain text, greedy decode, non-speech tokens suppressed so a cough
    // cannot arrive as "(coughing)" and be parsed as anything.
    const args = ['-m', model, '-f', wav, '-l', 'en', '-nt', '-bs', '1', '-bo', '1', '-sns',
      '-t', String(Math.max(2, Math.min(8, threads || os.cpus().length)))];
    if (!fallback) args.push('-nf');
    if (audioCtx) args.push('-ac', String(audioCtx));
    const proc = spawn(cli, args, { windowsHide: true, cwd: dir, env });
    let out = '', err = '';
    if (signal) signal.addEventListener('abort', () => { try { proc.kill(); } catch (e) {} });
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 40000) err = err.slice(-20000); });
    proc.on('error', (e) => reject(new Error('Could not start the speech engine: ' + e.message)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('The speech engine stopped: ' + err.slice(-400)));
      resolve(out.replace(/\s+/g, ' ').trim());
    });
  });
}

/**
 * What is on the wall, named rather than numbered.
 *
 * The studio hands `live` round as `{ bookNr, chapter, verse }` because that is
 * what the parser wants. The cloud model's prompt wants the BOOK'S NAME, so it
 * can be primed with the one the speaker is in the middle of — see promptFor in
 * cloudspeech.js for why that matters more than it looks.
 */
function namedLive(live) {
  if (!live || !live.bookNr) return live;
  const b = (voiceref.VOICE_BOOKS || []).find((x) => x.nr === live.bookNr);
  return b ? Object.assign({}, live, { book: b.name }) : live;
}

/**
 * One phrase of speech in, one instruction for the screen out (or null).
 *
 * `pcm16` is an Int16Array of 16 kHz mono samples. `live` says what is on the
 * wall so "next verse" and "verse twelve" can mean something. `verseCount` is
 * optional and only sharpens one thing — see chapterVerse in voiceref.js.
 *
 * ►► THE CLOUD MODEL GOES FIRST, AND FAILING IS NOT AN ERROR ◄◄
 *
 * When a church has set up the free cloud engine, that is what listens: it runs
 * the full Whisper Large v3 Turbo, which no church PC can, and it answers faster
 * than the small local model does. Everything below it is unchanged and stays
 * exactly where it was — because the ONE thing that must not happen is a service
 * where the internet drops and the feature dies with it. cloudspeech.transcribe
 * never throws and returns null for every kind of failure, which lands here as
 * "use the local model for this window" and nothing more.
 *
 * `partial` is passed through purely so the cloud side can tell an optional
 * look-back from an instruction somebody paused to give, and spend its free
 * allowance accordingly. Nothing below this line looks at it.
 */
async function hear({ pcm16, live = null, verseCount = null, modelId = DEFAULT_MODEL, signal, threads, fast = false, fallback = true, partial = false, local = false } = {}) {
  if (!pcm16 || !pcm16.length) return { ok: true, text: '', intent: null };
  const capped = pcm16.length > SAMPLE_RATE * MAX_SECONDS ? pcm16.subarray(0, SAMPLE_RATE * MAX_SECONDS) : pcm16;
  const seconds = capped.length / SAMPLE_RATE;
  const audioCtx = audioCtxFor(seconds);
  let paced = false;   // the cloud skipped this window on purpose, not in failure
  const finish = (text, via) => ({ ok: true, text, intent: voiceref.parseVoice(text, { live, verseCount }), seconds, via, paced });

  /*
   * `local` — ON THIS PC, WHATEVER IS CONFIGURED.
   *
   * The close-follow look-back (see present.js) asks a much narrower question
   * than the ear's usual one: has the verse ALREADY ON THE SCREEN reached its
   * last words? The text is known, and the matcher that reads the answer is
   * built to absorb a recogniser that gets a word in ten wrong, so the small
   * model here is entirely good enough for it. What it must not do is spend a
   * finite free cloud allowance several times a second, or make the engine the
   * transcript is coming from flap between cloud and PC while it does.
   */
  if (!local && cloudspeech.ready()) {
    const text = await cloudspeech.transcribe(capped, { partial, live: namedLive(live), signal });
    if (text !== null) return finish(text, 'cloud');
    /*
     * It declined. PACING and FAILING look identical from here — both are null —
     * and the studio used to announce both as "listening on this PC for now",
     * several times a minute, because pacing is what the cadence is FOR. So the
     * reason travels with the answer and the log stays quiet about a skip taken
     * on purpose. See lastDecline() in cloudspeech.js.
     */
    paced = !!cloudspeech.lastDecline().paced;
  }

  /*
   * No cloud, or the cloud just declined this window. Everything from here is
   * the local path exactly as it was — which is why the engine check lives HERE
   * now rather than at the top of the function: a church using the cloud engine
   * does not need whisper installed at all, and telling them the speech engine
   * is missing when they are being heard perfectly well would be nonsense.
   */
  const eng = engine(modelId);
  if (!eng) {
    /*
     * NOTHING LEFT TO ASK — but WHICH nothing matters.
     *
     * A church that set the cloud ear up and never installed whisper has no
     * local model to fall back to, so a dropped connection lands here. Saying
     * "the speech engine is not installed" then is both true and useless: it is
     * not what changed, it is not what they can fix, and it reads as the
     * feature having been broken all along rather than the hall's internet
     * having gone. The cloud engine already knows what went wrong; pass it on.
     */
    const cs = cloudspeech.state();
    if (cs.on && cs.hasKey) {
      return { ok: false, reason: 'cloud-down', why: cs.why || 'the cloud ear did not answer', text: '', intent: null };
    }
    return { ok: false, reason: 'no-engine', text: '', intent: null };
  }

  /*
   * The resident model, when it has been switched on and has proved itself.
   * A failure here is never fatal: it falls through to the ordinary path below,
   * so the worst case is one phrase taking as long as it always used to.
   */
  /*
   * `eng.modelId`, NOT `modelId` — the RESOLVED id, never 'auto'.
   *
   * whisperfast asks captioner for its own path, and captioner's fallback for
   * an unrecognised id is bestModel(), which has no Medium cap. Handing it the
   * raw 'auto' would let the resident path load Medium while the whisper-cli
   * path below used Small, so the same sentence would be recognised by a
   * different model depending on which route it happened to take.
   */
  if (fast && whisperfast.start({ modelId: eng.modelId })) {
    try {
      const floats = new Float32Array(capped.length);
      for (let i = 0; i < capped.length; i++) floats[i] = capped[i] / 32768;
      return finish(await whisperfast.transcribe(floats, { audioCtx, threads: threads || 4, fallback }), 'resident');
    } catch (e) { /* fall through and use whisper-cli for this one */ }
  }

  const wav = path.join(os.tmpdir(), `cws-hear-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    writeWav(wav, capped);
    const text = await transcribeFile(eng.cli, eng.model, wav, { signal, threads, audioCtx, fallback });
    return finish(text, 'cli');
  } finally {
    try { fs.rmSync(wav, { force: true }); } catch (e) {}
  }
}

/**
 * Load the model once before the service starts.
 *
 * The first phrase of the morning would otherwise pay for reading 78 MB off
 * disk on top of everything else, which is exactly the phrase the operator is
 * watching to decide whether this works at all.
 */
async function warmUp({ modelId = DEFAULT_MODEL, threads, fast = false } = {}) {
  const eng = engine(modelId);
  // Nothing to warm and nothing wrong: the cloud engine has no model to load on
  // this machine. Saying `false` here would put "not available" under a picker
  // that is about to work perfectly.
  if (!eng) return cloudspeech.ready();
  // With the resident model on, warming means LOADING it — after this, phrases
  // cost only what recognising them costs.
  // The resolved id, for the same reason as in hear() — warming a different
  // model from the one that will answer is worse than not warming at all.
  if (fast && whisperfast.start({ modelId: eng.modelId })) return true;
  const wav = path.join(os.tmpdir(), `cws-warm-${process.pid}-${Date.now()}.wav`);
  try {
    writeWav(wav, new Int16Array(SAMPLE_RATE / 2));      // half a second of silence
    await transcribeFile(eng.cli, eng.model, wav, { threads, audioCtx: AUDIO_CTX_FLOOR });
    return true;
  } catch (e) { return false; } finally { try { fs.rmSync(wav, { force: true }); } catch (e) {} }
}

/**
 * Is there anything to listen with? Used to grey the button out honestly.
 *
 * Two ways to say yes now, and the cloud one matters on a machine that has
 * never downloaded a speech model: a church that pastes a free key gets 🎤
 * Listen straight away, with nothing to install and no 78 MB to fetch first.
 */
function available(modelId = DEFAULT_MODEL) {
  return cloudspeech.ready() || !!engine(modelId);
}

/** Which of the two is actually going to answer, for the studio to say out loud. */
function how(modelId = DEFAULT_MODEL) {
  const cloud = cloudspeech.state();
  const eng = engine(modelId);
  return {
    cloud,
    localReady: !!eng,
    localModel: eng ? eng.modelId : null,
    // A cloud engine that is configured but sulking still counts as the chosen
    // one; the studio shows WHY rather than silently renaming what is in charge.
    via: cloud.on && cloud.hasKey ? 'cloud' : (eng ? 'local' : 'none'),
  };
}

module.exports = {
  hear, warmUp, available, how, engine, writeWav, audioCtxFor,
  whisperfast, cloudspeech, SAMPLE_RATE, MAX_SECONDS, DEFAULT_MODEL,
};
