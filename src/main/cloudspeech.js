'use strict';
/*
 * ►► LISTENING WITH A MODEL THIS PC COULD NEVER RUN ◄◄
 *
 * WHAT WAS WRONG.
 *
 * 🎤 Listen ran whisper on the operator's own PC, and the model it could afford
 * to run was the problem. Listen does not transcribe once — it asks for a
 * rolling look-back many times a minute — so the model has to finish a window
 * in less time than the window covers, on whatever machine the church has at
 * the back of the hall. That budget buys `base.en` (74 MB, 5% of Whisper's
 * parameters) and, on a good PC, `small.en`. Those are the two smallest models
 * OpenAI shipped, and on a preacher at the far end of a hall through a PA they
 * are not close to good enough: measured on a real sermon, `tiny.en` repeated
 * itself on 46 of 298 windows and heard "Acts chapter 6" as "Acts of the Six".
 * `base.en` is better and still wrong often enough that an operator watches the
 * transcript scroll past and sees nonsense. Medium, which WOULD be good enough,
 * was measured on this machine at 3.2x SLOWER THAN REAL TIME — it cannot be
 * used at all. So the local design was stuck between a model that is too weak
 * and a model that is too slow, with nothing in between.
 *
 * WHAT THIS DOES INSTEAD.
 *
 * It sends the audio to a machine that runs `whisper-large-v3-turbo` — the FULL
 * 809-million-parameter Whisper encoder, ~10x the size of base.en — on hardware
 * built for it, and gets the words back in a few hundred milliseconds. That is
 * both more accurate AND faster than anything this PC can do, which is not a
 * trade-off the local path ever had available.
 *
 * AND IT IS FREE. Groq publish a free tier for exactly these two models with no
 * card and no trial clock: 20 requests a minute, 7,200 audio-seconds an hour,
 * 28,800 a day. Those numbers are not generous by accident — they are the whole
 * reason `budget` below exists, because a feature that runs forty times a minute
 * walks straight through them. See the pacing note at cadence().
 *
 * WHY NOT OPENROUTER, WHICH IS WHAT WAS ASKED FOR. It is offered here and it
 * works, but it has no free transcription model: every one of the 21 models on
 * its /audio/transcriptions endpoint is pay-as-you-go (Whisper Turbo is the
 * cheapest, at about a penny an hour of audio). Groq serve the same model for
 * nothing, so that is the default and OpenRouter is the alternative for a
 * church that already has an account.
 *
 * WHY IT NEVER JUST STOPS WORKING. Everything here can fail in ways the local
 * path cannot — the hall's internet, an expired key, a rate limit. So nothing in
 * this module is allowed to be fatal: every failure returns null and voicelisten
 * falls through to the local model for that window, and a cool-down keeps it
 * there rather than paying the timeout again on every phrase. The worst service
 * this can produce is the one the church has today.
 */
const { spawn } = require('child_process');
const { wavBuffer } = require('./wav');

const SAMPLE_RATE = 16000;

/* ===================== WHO CAN BE ASKED, AND ON WHAT TERMS =================
 *
 * All three speak the same OpenAI-shaped `POST /audio/transcriptions`, which is
 * why adding one is a table entry rather than a code path. `limits` is what the
 * provider publishes; the governor below spends a fraction of it on purpose.
 *
 * `minBilledSec` is the one that shapes the whole design. Groq bill a minimum
 * of 10 seconds per request whatever you send, so the old cadence — a 6-second
 * window every 1.2 s — would have burned 500 audio-seconds a minute against a
 * 120/minute allowance, and 50 requests a minute against 20. It also means a
 * window shorter than ten seconds is free width: the twelve-second window this
 * settles on costs one request either way, and buys five seconds of overlap
 * with its neighbour. That is why the renderer changes cadence when this engine
 * is on (see cadence() at the bottom).
 */
const PROVIDERS = {
  groq: {
    id: 'groq',
    name: 'Groq',
    label: 'Free cloud — Whisper Large v3 Turbo',
    blurb: 'Free, no card. The full-size Whisper model — about half a second a phrase.',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    free: true,
    models: [
      { id: 'whisper-large-v3-turbo', name: 'Large v3 Turbo — fastest, free' },
      { id: 'whisper-large-v3', name: 'Large v3 — a shade more accurate, slower' },
    ],
    limits: { rpm: 20, rpd: 2000, audioSecPerHour: 7200, audioSecPerDay: 28800, minBilledSec: 10 },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    label: 'OpenRouter — pay as you go',
    blurb: 'Same model, about 1p an hour of audio. OpenRouter has no free transcription tier.',
    url: 'https://openrouter.ai/api/v1/audio/transcriptions',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    free: false,
    models: [
      { id: 'openai/whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo' },
      { id: 'openai/whisper-large-v3', name: 'Whisper Large v3' },
      { id: 'deepgram/nova-3', name: 'Deepgram Nova 3' },
    ],
    // Nothing published to pace against, so pace it like Groq rather than like
    // nothing: an unpaced look-back loop is how a pay-as-you-go account gets a
    // surprise bill.
    limits: { rpm: 20, rpd: 4000, audioSecPerHour: 7200, audioSecPerDay: 28800, minBilledSec: 1 },
  },
  custom: {
    id: 'custom',
    name: 'Other',
    label: 'Another cloud service',
    blurb: 'Anything serving POST /v1/audio/transcriptions — a paid account, or your own server.',
    url: '',
    keyUrl: '',
    keyHint: 'your key',
    free: false,
    models: [{ id: 'whisper-1', name: 'whisper-1' }],
    limits: { rpm: 60, rpd: 10000, audioSecPerHour: 36000, audioSecPerDay: 200000, minBilledSec: 1 },
  },
};
const DEFAULT_PROVIDER = 'groq';

/* ===================== PRIMING WHISPER WITH THE VOCABULARY =================
 *
 * Whisper takes up to 224 tokens of `prompt` as context for the window, and it
 * is documented as biasing the decoder towards those words. The words Listen
 * has to get right are exactly the ones a general model has least reason to
 * expect — "Habakkuk", "Thessalonians", "Ecclesiastes", "Zephaniah" are rare in
 * English and common in a sermon — so the sixty-six book names go in it.
 *
 * ►► HOW MUCH IT ACTUALLY HELPS: NOT MEASURABLY, ON THE EVIDENCE SO FAR. ◄◄
 *
 * This was written as the feature's big accuracy lever. It was then measured,
 * six hard book names spoken through a simulated hall, with the prompt and
 * without: **2 of 6 either way.** The one visible difference across the set was
 * a verse number ("verse 16" prompted, "verse 15" not). That is not nothing and
 * it is not the lever it was claimed to be.
 *
 * It stays because it is free — one form field, no extra round trip — and
 * because the test was synthesised speech through a synthetic room, which this
 * project has been burned by before (see the sermon-corpus note in
 * voicelisten.js: every test passed because every test used the Windows speech
 * synthesiser). It may well earn its keep on a real preacher on a real PA. What
 * it must NOT do is sit here described as a benefit nobody demonstrated, so:
 * unproven, retained, cheap. Re-measure it on real audio before relying on it.
 *
 * Singular and ungrouped where the spoken form is: nobody says "1 Corinthians"
 * out loud, they say "First Corinthians", and the bias that matters is on the
 * distinctive word either way.
 */
const BOOKS = 'Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua, Judges, Ruth, '
  + 'Samuel, Kings, Chronicles, Ezra, Nehemiah, Esther, Job, Psalm, Proverbs, Ecclesiastes, '
  + 'Song of Solomon, Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, Hosea, Joel, Amos, '
  + 'Obadiah, Jonah, Micah, Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, '
  + 'Matthew, Mark, Luke, John, Acts, Romans, Corinthians, Galatians, Ephesians, Philippians, '
  + 'Colossians, Thessalonians, Timothy, Titus, Philemon, Hebrews, James, Peter, Jude, Revelation';
const BASE_PROMPT = 'A sermon, quoting scripture. Books of the Bible: ' + BOOKS + '.';

/**
 * The prompt for one window: the book list, plus whatever is on the wall.
 *
 * Naming the passage already up is worth more than it looks. A preacher reading
 * Habakkuk says "Habakkuk" once and then says "verse four" for ten minutes, and
 * the window containing "verse four" has nothing in it to tell the model which
 * book it is in the middle of. This puts it back.
 */
function promptFor(live) {
  if (!live || !live.book) return BASE_PROMPT;
  const at = live.book + (live.chapter ? ' chapter ' + live.chapter : '');
  return BASE_PROMPT + ' We are reading ' + at + '.';
}

/*
 * WHISPER SAYING THE PROMPT BACK TO YOU.
 *
 * A prompted Whisper handed near-silence has been known to emit the prompt
 * itself as though it had heard it — and this prompt is a list of book names,
 * which is the single worst thing that could arrive at a reference parser. One
 * book name in a sentence is ordinary; four in a row, in this order, never
 * happens in speech and always means the decoder has fallen back on its context.
 */
const BOOK_WORDS = BOOKS.split(',').map((s) => s.trim().split(' ').pop().toLowerCase());
function looksLikePromptEcho(text) {
  if (/books of the bible/i.test(text || '')) return true;
  const words = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  let run = 0;
  for (const w of words) {
    if (BOOK_WORDS.includes(w)) { if (++run >= 4) return true; } else run = 0;
  }
  return false;
}

/* ===================== THE BUDGET, AND WHY IT IS NOT THE LIMIT =============
 *
 * The published free-tier numbers are where requests start being REFUSED, and a
 * 429 in the middle of a sermon is a minute of the feature being dead. So the
 * governor spends a fraction of them and keeps the rest as headroom, and it
 * counts locally rather than waiting to be told — by the time a 429 arrives the
 * damage is already done.
 *
 * It is also asymmetric on purpose, and this is the important part:
 *
 *   • A LOOK-BACK IS OPTIONAL. Somebody is mid-sentence; there will be another
 *     window in five seconds. If the budget is tight, skipping it costs nothing
 *     that will not come round again.
 *   • A FINISHED PHRASE IS AN INSTRUCTION. Somebody said "next verse" and
 *     stopped. There is no second chance at it, so it may spend into headroom
 *     that a look-back may not.
 *
 * So a church that runs out of allowance does not lose the feature — it loses
 * the rolling transcript, keeps the spoken commands, and the local model picks
 * up the rest.
 *
 * THE SHARES DIFFER PER DIMENSION, WHICH IS NOT FUSSINESS. The per-MINUTE cap
 * needs real headroom, because instructions arrive in bursts — an operator
 * testing the feature says four things in twenty seconds — and a burst that
 * runs into the ceiling is the one moment somebody is watching. The per-HOUR
 * audio cap is a rolling budget nobody bursts against: stopping short of it by
 * a tenth is enough, and every extra percent given back there is another two
 * minutes of service covered.
 */
const SPEND = {
  partial: { rpm: 0.75, rpd: 0.90, hour: 0.90, day: 0.90 },
  final: { rpm: 0.95, rpd: 0.99, hour: 0.99, day: 0.99 },
};

function budget(limits) {
  const hits = [];            // { t, sec } — one per request actually sent
  // What the SERVER says is left, when it bothers to say. Groq return
  // x-ratelimit-remaining-requests on every answer, and it is worth more than
  // our own count: the ledger here starts empty every time the app does, and a
  // church that has already run a service this morning would otherwise be told
  // it has a full day's allowance and walk into a 429.
  let serverRpdLeft = null;
  const prune = (now) => { while (hits.length && now - hits[0].t > 86400e3) hits.shift(); };
  const sum = (now, ms, f) => {
    let n = 0;
    for (let i = hits.length - 1; i >= 0; i--) { if (now - hits[i].t > ms) break; n += f(hits[i]); }
    return n;
  };
  return {
    /** What one window of this length will really cost against the allowance. */
    billed: (seconds) => Math.max(limits.minBilledSec || 1, Math.ceil(Math.max(0, seconds))),
    /**
     * The shortest gap between look-backs this allowance can sustain FOR EVER.
     *
     * This is the number the whole cadence hangs off, and deriving it rather
     * than writing 5000 in a constant is what stops the feature dying 48
     * minutes into a service. One window costs `billed` seconds; the hourly
     * allowance permits `cap/3600` seconds of audio per second of clock; so the
     * gap that exactly spends the allowance is billed ÷ that rate. Anything
     * shorter is borrowing from later in the same hour, and a rolling hour
     * always collects.
     *
     * For Groq's free tier and a 12-second window: 12 ÷ (6480/3600) = 6.7 s.
     */
    sustainableHopMs(windowSec) {
      const sec = this.billed(windowSec);
      const perSec = (limits.audioSecPerHour * SPEND.partial.hour) / 3600;
      const byAudio = perSec > 0 ? (sec / perSec) : 1e9;
      const byRpm = 60 / Math.max(1, Math.floor(limits.rpm * SPEND.partial.rpm));
      return Math.ceil(Math.max(byAudio, byRpm) * 1000);
    },
    /** Why this window must NOT be sent, or null if it may be. `share` is SPEND.partial|final. */
    refuse(seconds, share) {
      const now = Date.now(); prune(now);
      const sec = this.billed(seconds);
      const over = (used, cap, s) => used + sec > Math.floor(cap * s);
      const overN = (used, cap, s) => used + 1 > Math.floor(cap * s);
      if (overN(sum(now, 60e3, () => 1), limits.rpm, share.rpm)) return 'asking too often for the moment';
      if (serverRpdLeft != null && serverRpdLeft <= 0) return 'the free allowance for today is used up';
      if (overN(sum(now, 86400e3, () => 1), limits.rpd, share.rpd)) return 'the free allowance for today is used up';
      if (over(sum(now, 3600e3, (h) => h.sec), limits.audioSecPerHour, share.hour)) return 'the free allowance for this hour is used up';
      if (over(sum(now, 86400e3, (h) => h.sec), limits.audioSecPerDay, share.day)) return 'the free allowance for today is used up';
      return null;
    },
    spend(seconds) {
      hits.push({ t: Date.now(), sec: this.billed(seconds) });
      if (serverRpdLeft != null) serverRpdLeft--;
    },
    /** Correct the ledger from what the server actually said. */
    sync(remainingRequests) {
      const n = parseFloat(remainingRequests);
      if (Number.isFinite(n) && n >= 0) serverRpdLeft = n;
    },
    /** For the operator: what has gone, as whole numbers they can act on. */
    used() {
      const now = Date.now(); prune(now);
      const rpd = sum(now, 86400e3, () => 1);
      return {
        rpm: sum(now, 60e3, () => 1), rpmCap: limits.rpm,
        hourSec: sum(now, 3600e3, (h) => h.sec), hourCap: limits.audioSecPerHour,
        daySec: sum(now, 86400e3, (h) => h.sec), dayCap: limits.audioSecPerDay,
        rpd, rpdCap: limits.rpd,
        rpdLeft: serverRpdLeft != null ? serverRpdLeft : Math.max(0, limits.rpd - rpd),
      };
    },
    reset() { hits.length = 0; serverRpdLeft = null; },
  };
}

/* ========================= CURRENT SETTINGS AND HEALTH ==================== */
let cfg = { on: false, provider: DEFAULT_PROVIDER, key: '', model: '', url: '' };
let gov = budget(PROVIDERS[DEFAULT_PROVIDER].limits);
const health = { fails: 0, coolUntil: 0, why: '', lastMs: 0, ok: 0, skipped: 0, failed: 0 };
/*
 * WHY THE LAST WINDOW WENT TO THE PC, AND IT IS TWO DIFFERENT THINGS.
 *
 * `transcribe` returns null for both "I am pacing myself" and "I could not",
 * and the caller cannot tell them apart — so the studio announced BOTH as the
 * cloud ear having dropped out. In practice the pacing one happens several
 * times a minute by design, and the operator's log filled with
 * "listening on this PC for now" / "back on the cloud ear" pairs instead of
 * the transcript. A skip taken on purpose is not news; a failure is.
 */
let lastDecline = { paced: false, why: '', at: 0 };

function provider() { return PROVIDERS[cfg.provider] || PROVIDERS[DEFAULT_PROVIDER]; }
function modelId() { return cfg.model || provider().models[0].id; }
/*
 * ►► CAPTIONS ARE HEARD BY THE ACCURATE MODEL, NOT THE QUICK ONE. ◄◄
 * Large v3 Turbo is a pruned Large v3 (4 decoder layers instead of 32): built
 * for the live ear, where a word late is a word lost. Captions are published
 * to the world and proof-reading them is what the operator's time goes on, so
 * they are heard by the full Large v3 — still well under a minute for an hour
 * on Groq, from the same free allowance. A model chosen by hand in Settings is
 * respected; if the provider ever refuses Large v3, Turbo hears it instead.
 */
// When it was last refused — for half an hour, not for ever: one odd answer must
// not quietly put every caption from then on onto the less accurate model.
let captionModelRefusedAt = 0;
const CAPTION_REFUSAL_MS = 30 * 60e3;
function captionModelId() {
  if (cfg.model || (captionModelRefusedAt && Date.now() - captionModelRefusedAt < CAPTION_REFUSAL_MS)) return modelId();
  const full = (provider().models || []).find((m) => /whisper-large-v3$/.test(m.id));
  return full ? full.id : modelId();
}
function endpoint() { return cfg.provider === 'custom' ? (cfg.url || '') : provider().url; }

/**
 * Set it up. Called whenever the operator changes anything, and on startup from
 * the saved settings, so `state()` is never a guess.
 */
function configure({ on, provider: p, key, model, url } = {}) {
  const before = cfg.provider;
  cfg = {
    on: !!on,
    provider: PROVIDERS[p] ? p : DEFAULT_PROVIDER,
    key: String(key || '').trim(),
    model: String(model || '').trim(),
    url: String(url || '').trim(),
  };
  // A different provider means a different allowance; carrying the old one's
  // spend across would either strand a fresh account or overrun a tight one.
  if (cfg.provider !== before) gov = budget(provider().limits);
  health.fails = 0; health.coolUntil = 0; health.why = '';
  return state();
}

/** Is the cloud engine switched on, configured, and not currently sulking? */
function ready() {
  return !!(cfg.on && cfg.key && endpoint() && Date.now() >= health.coolUntil);
}

function state() {
  return {
    on: !!cfg.on,
    provider: cfg.provider,
    providerName: provider().name,
    model: modelId(),
    url: cfg.url,
    hasKey: !!cfg.key,
    free: !!provider().free,
    ready: ready(),
    cooling: Math.max(0, health.coolUntil - Date.now()),
    why: health.why,
    lastMs: health.lastMs,
    heard: health.ok, skipped: health.skipped, failed: health.failed,
    used: gov.used(),
    providers: Object.values(PROVIDERS).map((x) => ({
      id: x.id, name: x.name, label: x.label, blurb: x.blurb, free: x.free,
      keyUrl: x.keyUrl, keyHint: x.keyHint, models: x.models, needsUrl: x.id === 'custom',
    })),
  };
}

/*
 * SULKING, AND FOR HOW LONG.
 *
 * A church hall's internet drops. Without this, every window for the rest of the
 * service pays the full timeout before falling back, so the feature is not
 * merely cloud-less — it is a second and a half SLOWER than it would be with no
 * cloud configured at all. Three failures in a row and it stops asking for a
 * while; the wait grows, so a genuinely dead connection is not probed every
 * minute, and a rate-limit answer sets it directly from what the server said.
 */
const COOL_STEPS = [15e3, 60e3, 300e3];
function trip(why, forMs) {
  health.fails++; health.failed++;
  health.why = why;
  lastDecline = { paced: false, why, at: Date.now() };
  const wait = forMs || COOL_STEPS[Math.min(COOL_STEPS.length - 1, health.fails - 1)];
  if (health.fails >= 3 || forMs) health.coolUntil = Date.now() + wait;
}
function cleared(ms) { health.fails = 0; health.why = ''; health.coolUntil = 0; health.lastMs = ms; health.ok++; }

/* ===================== GETTING THE AUDIO THERE QUICKLY ====================
 *
 * Ten seconds of 16 kHz mono is 320 KB as WAV. A church on a 1 Mbit uplink —
 * which is most of them, and the same uplink the service is being streamed out
 * of — spends two and a half seconds pushing that, which is longer than the
 * recognition and longer than the hop. The whole speed argument for using a
 * cloud model dies right there.
 *
 * The same ten seconds as 24 kbps Opus is 25 KB: 13x smaller, a fifth of a
 * second on the wire, and Whisper does not care — it was trained on compressed
 * audio off the web. Measured on this machine: 109 ms to encode, of which 65 ms
 * is ffmpeg starting up.
 *
 * `-compression_level 0 -application voip` is the setting that matters: the
 * default costs 221 ms for 500 bytes' difference, and this runs every five
 * seconds for the length of a service.
 */
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { ffmpegPath = null; }
let encoderOk = null;                 // null = not tried yet, 'opus' | 'flac' | false

function ffmpegPipe(args, input, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const out = [];
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} reject(new Error('encode timed out')); }, timeoutMs);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err += d.toString().slice(0, 400); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('ffmpeg ' + code + ' ' + err.slice(-200)));
      resolve(Buffer.concat(out));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

/** The smallest thing this machine can turn the samples into, with its filename. */
async function encode(pcm16) {
  const raw = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const wav = () => ({ body: wavBuffer(pcm16, SAMPLE_RATE), name: 'a.wav', type: 'audio/wav' });
  if (!ffmpegPath || encoderOk === false) return wav();
  const head = ['-v', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0'];
  const opus = ['opus', ['-c:a', 'libopus', '-b:a', '24k', '-compression_level', '0', '-application', 'voip', '-f', 'ogg', 'pipe:1'], 'a.ogg', 'audio/ogg'];
  const flac = ['flac', ['-c:a', 'flac', '-f', 'flac', 'pipe:1'], 'a.flac', 'audio/flac'];
  const tries = encoderOk === 'flac' ? [flac] : [opus, flac];
  for (const [kind, args, name, type] of tries) {
    try {
      const body = await ffmpegPipe(head.concat(args), raw);
      if (body && body.length) { encoderOk = kind; return { body, name, type }; }
    } catch (e) { /* try the next one, then give up and send WAV */ }
  }
  encoderOk = false;
  return wav();
}

/* ======================= READING THE ANSWER ==============================
 *
 * Whisper's one real failure mode on live audio is that handed room tone it
 * does not return nothing — it returns a short, fluent, confident phrase that
 * was never said. Here that is not a cosmetic fault: it is a line going to a
 * reference parser and a verse matcher, and from there to the wall.
 *
 * ►► THE OBVIOUS GUARD DOES NOT WORK, AND IT WAS MEASURED. ◄◄
 *
 * The first version of this asked the model how sure it was, which is what
 * everyone does: `verbose_json` returns `no_speech_prob` and `avg_logprob` per
 * segment, so drop the segments that score badly. Measured against this
 * provider, on this fixture, both numbers are useless for it:
 *
 *                                   no_speech_prob   avg_logprob   text
 *      real speech, clean               0.00            -0.14      correct
 *      real speech, noisy               0.00            -0.68      mostly right
 *      PURE ROOM NOISE, no voice        0.00            -0.72      "so"
 *      DIGITAL SILENCE                  0.00            -0.41      "Thank you."
 *
 * `no_speech_prob` is 0.00 for ALL of it, silence included — so the original
 * condition (bad on both) could never fire even once, and the filter was dead
 * code that read like a safety net. And `avg_logprob` cannot gate on its own
 * either: digital silence scored BETTER (-0.41) than real degraded speech
 * (-0.68). Any threshold that catches the silence eats the sermon.
 *
 * What does separate them is the TEXT. Whisper's non-speech output is not
 * random; it is a small set of stock fillers learned from captioned video —
 * "Thank you.", "so", "you", "...", subtitle credits. Three of the four rows
 * above produced one. So the rule is: a segment is dropped when it is SHORT
 * and it is one of those exact phrases. That cannot eat real speech — nobody
 * preaches a sentence consisting solely of the word "so" that matters — and it
 * removes precisely what was measured.
 */
const ARTEFACTS = new Set([
  'thank you', 'thanks', 'thank you very much', 'thanks for watching',
  'thank you for watching', 'please subscribe', 'subscribe',
  'so', 'you', 'bye', 'bye bye', 'okay', 'ok', 'hmm', 'mm', 'uh', 'um',
  'the end', 'silence', 'music', 'applause', 'outro', 'intro',
]);
/** Stock filler, or a real short thing somebody said? */
function isArtefact(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return true;                                   // punctuation only: "...", "♪"
  /*
   * Subtitle credits are checked BEFORE the length gate, because they are the
   * one artefact that is longer than a filler — "Subtitles by the Amara.org
   * community" is five words. Whisper emits them verbatim; they come from the
   * captioned video it was trained on, and no preacher says them.
   */
  if (/amara\.?org|subtitles? by|transcription by|captioned by/i.test(text || '')) return true;
  if (t.split(' ').length > 4) return false;             // long enough to be real
  return ARTEFACTS.has(t);
}

function textFrom(json) {
  if (!json) return '';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  if (Array.isArray(json.segments) && json.segments.length) {
    const kept = json.segments.filter((s) => !isArtefact(s && s.text));
    const joined = clean(kept.map((s) => (s && s.text) || '').join(' '));
    // A whole answer that is one filler is nothing heard, not a short sentence.
    return isArtefact(joined) ? '' : joined;
  }
  const t = clean(json.text);
  return isArtefact(t) ? '' : t;
}

/**
 * One window of samples in, the words out — or null, meaning "use the local
 * model for this one". Never throws.
 *
 * `partial` says this is a rolling look-back rather than a finished phrase, and
 * it changes two things: what it may spend, and how long it may take. A
 * look-back that has not come back before the next one is due is worthless, so
 * it is cut off early; a finished phrase is somebody's instruction and gets the
 * longer wait.
 */
async function transcribe(pcm16, { partial = false, live = null, signal = null } = {}) {
  if (!ready()) return null;
  if (!pcm16 || !pcm16.length) return null;
  const seconds = pcm16.length / SAMPLE_RATE;
  const denied = gov.refuse(seconds, partial ? SPEND.partial : SPEND.final);
  if (denied) {
    health.skipped++; health.why = denied;
    lastDecline = { paced: true, why: denied, at: Date.now() };
    return null;
  }

  const timeoutMs = partial ? 4500 : 9000;
  const t0 = Date.now();
  try {
    const { body, name, type } = await encode(pcm16);
    const form = new FormData();
    form.append('file', new Blob([body], { type }), name);
    form.append('model', modelId());
    form.append('language', 'en');
    form.append('temperature', '0');
    form.append('response_format', 'verbose_json');
    form.append('prompt', promptFor(live));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    gov.spend(seconds);                    // spent when it is SENT, not when it lands
    let res;
    try {
      res = await fetch(endpoint(), {
        method: 'POST',
        headers: Object.assign({ authorization: 'Bearer ' + cfg.key },
          cfg.provider === 'openrouter'
            ? { 'http-referer': 'https://church.work.space', 'x-title': 'Church Work Space' }
            : {}),
        body: form,
        signal: ac.signal,
      });
    } finally { clearTimeout(timer); }
    // What the server says is left beats what we counted: see budget().sync.
    gov.sync(res.headers.get('x-ratelimit-remaining-requests'));

    if (res.status === 429) {
      const wait = Math.min(300e3, (parseFloat(res.headers.get('retry-after')) || 30) * 1000);
      trip('the free allowance is used up for the moment', wait);
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      trip('that key was refused — check it in the Listen panel', 600e3);
      return null;
    }
    if (!res.ok) { trip('the speech service answered ' + res.status); return null; }

    const json = await res.json();
    const text = textFrom(json);
    cleared(Date.now() - t0);
    // Heard nothing: hand back empty rather than a list of book names.
    if (looksLikePromptEcho(text)) return '';
    return text;
  } catch (e) {
    trip((e && e.name === 'AbortError')
      ? 'the speech service did not answer in time'
      : 'could not reach the speech service' + (e && e.message ? ' (' + e.message + ')' : ''));
    return null;
  }
}

/**
 * Prove the key works, from the operator's chair.
 *
 * It sends real audio through the real request path rather than pinging a status
 * endpoint, because the questions an operator is actually asking — is this key
 * right, does this hall's network let it out, how long will a phrase take from
 * here — are only answered by the whole round trip. What it reports is the
 * measured milliseconds.
 *
 * Ten seconds, not one: a shorter clip is billed as ten anyway, and a test that
 * sends less than a real window is not testing a real window.
 */
async function test() {
  if (!cfg.key) return { ok: false, error: 'No key yet. Paste one and try again.' };
  if (!endpoint()) return { ok: false, error: 'No address for that service yet.' };
  const saved = { on: cfg.on, cool: health.coolUntil, fails: health.fails };
  cfg.on = true; health.coolUntil = 0; health.fails = 0;
  const pcm = new Int16Array(SAMPLE_RATE * 10);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 8) * 40);  // faint tone, not digital silence
  const t0 = Date.now();
  try {
    const r = await transcribe(pcm, { partial: false });
    const ms = Date.now() - t0;
    if (r === null) return { ok: false, error: health.why || 'It did not answer.', ms };
    return { ok: true, ms, provider: provider().name, model: modelId(), free: !!provider().free };
  } finally {
    cfg.on = saved.on;
    if (health.fails === 0) { health.coolUntil = saved.cool; health.fails = saved.fails; }
  }
}

/* ===================== HOW OFTEN THE RENDERER SHOULD ASK ==================
 *
 * The ear's own cadence was built around a local model: a 6-second look-back
 * every 1.2 s, which is 50 requests and 300 audio-seconds a minute. Against a
 * free tier of 20 requests and 120 audio-seconds a minute, that is three to
 * five times over on both counts before the first hymn is finished.
 *
 * SO THE HOP IS CALCULATED, NOT CHOSEN. `sustainableHopMs` works out the gap
 * that spends the hourly allowance exactly, and the number it returns for Groq
 * is 6.7 s. Writing 5000 in a constant instead would have looked fine for 48
 * minutes and then starved the rest of the service — which is the half nobody
 * would have tested and everybody would have noticed.
 *
 * WHY THE WINDOW IS TWELVE SECONDS AND NOT TEN. Groq bill a ten-second minimum,
 * so anything under ten is free width and ten is the obvious answer. Twelve
 * costs 20% more and buys the thing that actually decides whether a reference
 * is found: the OVERLAP. At a 6.7 s hop a 12-second window overlaps its
 * neighbour by 5.3 s, so any utterance shorter than that is whole inside at
 * least one window — and "turn with me to the book of Habakkuk chapter two" is
 * about four seconds. A 10-second window overlaps by 3.3 s and would cut that
 * sentence in half at every boundary, which is exactly the failure the local
 * design already had.
 *
 * WHAT IT COSTS is latency on a word buried mid-sentence: up to 6.7 s rather
 * than 1.2 s before it is looked at. That is a smaller loss than it sounds, for
 * a reason worth writing down — a deliberate instruction ("next verse", "turn
 * to Romans eight") is followed by a PAUSE, so it arrives as a finished phrase
 * and goes the moment the endpointer calls it, about 460 ms after the last word
 * whatever the look-back cadence is. The hop governs only the words buried in
 * continuous preaching, which is precisely where the old design was spending
 * 1.2 s to fetch a wrong answer.
 */
const WINDOW_MS = 12000;
function cadence() {
  return {
    liveWinMs: WINDOW_MS,
    liveHopMs: gov.sustainableHopMs(WINDOW_MS / 1000),
    liveMinMs: 2500,
    /*
     * THE PHRASE CAP STOPS BEING A CAP ON ANYTHING USEFUL.
     *
     * Locally it is eight seconds because the ear has to hand whisper SOMETHING
     * before the sentence is over. Here the rolling windows already cover every
     * second of continuous speech, so all the cap still does is decide how often
     * `speaking` drops back to false — which is the only time the endpointer
     * relearns the room's noise floor. Thirty seconds keeps that honest without
     * chopping the speech into pieces that each cost a request.
     *
     * It has to stay well under voicelisten's twenty-second MAX_SECONDS being
     * exceeded silently, which is why present.js drops a capped phrase outright
     * when this engine is listening: a 30-second phrase truncated to its first
     * 20 seconds would send the OLDEST audio in it, which is both stale and
     * paid for.
     */
    maxPhraseMs: 30000,
    // …and with phrases that long, a look-back must be allowed across the
    // boundary between them. See look() in voiceear.js.
    lookAcrossPhrases: true,
  };
}

/* ======================= LISTENING TO A FILE, NOT A ROOM ===================
 *
 * Everything above this line is the LIVE ear: windows of microphone samples, a
 * budget paced so a two-hour service fits inside a free tier, and a cool-down
 * so a dead network costs one timeout and not two hundred.
 *
 * This is the other job, and it is a different shape in every respect. A social
 * clip is a FILE that already exists. Nothing is real-time, there is no next
 * window to be late for, and the question is not "what did they just say" but
 * "what is this clip actually about" — which is the raw material the caption
 * writer needs and the single biggest reason the old captions were poor. The
 * words came from `base.en`, a 74 MB model, or (usually) from the FILE NAME.
 *
 * Three things are deliberately different from the live path:
 *
 *   • IT DOES NOT SPEND THE LIVE BUDGET. The governor exists to stop a service
 *     running out of allowance halfway through. Writing one caption is a
 *     handful of requests an operator makes by hand, and refusing it because a
 *     service used the hourly allowance yesterday would be nonsense.
 *   • IT DOES NOT TRIP THE COOL-DOWN. A caption that fails to reach the cloud
 *     must not then make the next service's ear stand down for five minutes.
 *   • IT ONLY NEEDS A KEY, not the live ear switched on. A church that writes
 *     its posts in the cloud and listens on this PC is a perfectly sensible
 *     arrangement.
 *
 * `null` back means "I could not", and the caller uses whisper on this PC.
 */
const FILE_CHUNK_SEC = 600;     // 10 minutes a request: small, quick, well inside every file-size limit
const FILE_MAX_SEC = 3600;      // a whole service, if something ever asks for one

/*
 * ONE FREE ACCOUNT, WHICHEVER BOX IT WAS PASTED INTO.
 *
 * A church that set Groq up for the caption WRITER (Social) and never opened
 * the Listen panel has a perfectly good speech key sitting in the other box.
 * The writer already borrows the ear's key; this is the same courtesy the other
 * way round, for the file paths only — the live ear still needs its own switch.
 */
let borrowedKey = { provider: '', key: '' };
function shareKey(providerId, k) {
  borrowedKey = { provider: String(providerId || ''), key: String(k || '').trim() };
}
function fileKey() {
  if (cfg.key) return cfg.key;
  if (borrowedKey.key && borrowedKey.provider === cfg.provider) return borrowedKey.key;
  return '';
}

/** Key present and an address to send it to — the live ear need not be on. */
function fileReady() { return !!(fileKey() && endpoint()); }

/** One stretch of a media file as Opus bytes, straight out of ffmpeg. */
function encodeRange(input, startSec, durSec, timeoutMs) {
  const args = ['-v', 'error',
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    '-t', String(durSec),
    '-i', input,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-f', 'ogg', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    // `jobs` is declared further down this file; by the time anything calls
    // this, the module has finished loading and it is there.
    if (jobs) jobs.track(proc);
    const out = [];
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} reject(new Error('decode timed out')); }, timeoutMs || 90000);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err += d.toString().slice(0, 400); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('ffmpeg ' + code + ' ' + err.slice(-200)));
      resolve(Buffer.concat(out));
    });
  });
}

/*
 * Caption pieces go up LOSSLESS (FLAC, 16 kHz mono — exactly what Whisper hears
 * inside). The live ear's 24 kbit Opus "voip" is right for a phrase every few
 * seconds; for a sermon being captioned for the world, a codec's smearing of
 * consonants is one more thing between the preacher and the right word.
 * ~20 KB a second: a three-minute piece is under 4 MB.
 */
function encodeRangeLossless(input, startSec, durSec, timeoutMs) {
  const args = ['-v', 'error',
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    '-t', String(durSec),
    '-i', input,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-sample_fmt', 's16',
    '-c:a', 'flac', '-f', 'flac', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    if (jobs) jobs.track(proc);
    const out = [];
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} reject(new Error('decode timed out')); }, timeoutMs || 90000);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { err += d.toString().slice(0, 400); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('ffmpeg ' + code + ' ' + err.slice(-200)));
      resolve(Buffer.concat(out));
    });
  });
}

/*
 * ►► THE CONTEXT A CAPTION PIECE IS HEARD WITH. ◄◄
 *
 * Measured on a real 45-minute sermon (captioned on the live server, read line
 * by line): heard in ten-minute pieces with no context, Large v3 wrote "our
 * Father who at a never" for "who art in heaven", "I say salt hallelujah" for
 * "shout", "attract God on the same" for "on the scene" — and after a minute or
 * two of fast speech it dropped ALL punctuation and capitals ("when we approach
 * god") for minutes at a time. Turbo heard the same places the same wrong way,
 * so a second listen could only flag them, never fix them.
 *
 * Whisper takes the prompt as the text that came JUST BEFORE the audio, and it
 * continues in that style and that vocabulary. So each piece is heard with:
 *   • a short, properly punctuated passage of the kind of thing a preacher
 *     says (it holds the punctuation and capitals, and primes the phrases a
 *     sermon is made of);
 *   • the church's own names and terms from the Word Book;
 *   • the last sentences actually heard before this piece — a sermon picks up
 *     mid-thought at every seam.
 * Kept inside Whisper's 224-token prompt window (≈ 800 characters).
 */
// No numbers and no references in it: a primer that said "Matthew, chapter 6,
// verse 9" was measured writing "verse 1, verse 1, verse 1…" into a pause.
const CAPTION_PRIMER = 'Good morning, church. Our Father, who art in heaven, hallowed be Thy name. '
  + 'Shout hallelujah! Jesus Christ, the Holy Spirit, the Holy Ghost, the Word of God.';
const PROMPT_MAX_CHARS = 780;
function captionPrompt({ terms = [], before = '' } = {}) {
  let p = CAPTION_PRIMER;
  const t = (terms || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 40);
  if (t.length) p += ' ' + t.join(', ') + '.';
  const tail = String(before || '').replace(/\s+/g, ' ').trim();
  if (tail) {
    const room = Math.max(0, PROMPT_MAX_CHARS - p.length - 1);
    // the END of what was said: whole words, cut at the front
    const cut = tail.length > room ? tail.slice(tail.length - room).replace(/^\S*\s/, '') : tail;
    p += ' ' + cut;
  }
  return p.slice(-PROMPT_MAX_CHARS);
}
/*
 * A prompted Whisper handed music or silence can write its prompt back out as
 * if it had heard it. A stretch whose words are a run of the primer or the
 * Word Book list (or the context sentences, said again) is the decoder falling
 * back on its context, not the preacher: it is dropped.
 */
const echoNorm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function isCaptionPromptEcho(segText, prompt, seg) {
  const a = echoNorm(segText), b = echoNorm(prompt);
  if (!a || !b) return false;
  const words = a.split(' ');
  if (words.length < 4 || !b.includes(a)) return false;
  // A preacher really does say "Our Father, who art in heaven": the words alone
  // are never enough. Only a stretch Whisper itself doubted held speech at all.
  if (!seg) return false;
  return (+seg.no_speech_prob || 0) >= 0.3 || (+seg.avg_logprob || 0) < -0.7 || (+seg.compression_ratio || 0) > 2.4;
}

/** One chunk to the provider. Returns its words, or throws. */
async function postAudio(body, { timeoutMs, signal, prompt }) {
  const form = new FormData();
  form.append('file', new Blob([body], { type: 'audio/ogg' }), 'clip.ogg');
  form.append('model', modelId());
  form.append('language', 'en');
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json');
  if (prompt) form.append('prompt', prompt);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 120000);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: Object.assign({ authorization: 'Bearer ' + fileKey() },
        cfg.provider === 'openrouter'
          ? { 'http-referer': 'https://church.work.space', 'x-title': 'Church Work Space' }
          : {}),
      body: form,
      signal: ac.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const why = res.status === 429 ? 'the free allowance is used up for the moment'
      : (res.status === 401 || res.status === 403) ? 'that key was refused'
      : 'the speech service answered ' + res.status;
    throw new Error(why);
  }
  return textFrom(await res.json());
}

/**
 * Transcribe a media FILE with the full-size Whisper model.
 *
 * `maxSec` is the caller's budget in audio seconds; a short is transcribed
 * whole, a two-hour service is read from the beginning up to that cap — which
 * is where the hook of a clip lives, and which keeps one caption from spending
 * a church's whole hourly allowance.
 *
 * Returns the words, '' when there is no speech in it, or null when the cloud
 * could not be used at all (so the caller falls back to this PC).
 */
async function transcribeFile({ input, startSec = 0, endSec = 0, maxSec = 900, prompt = null, onProgress = null, signal = null } = {}) {
  if (!fileReady() || !ffmpegPath || !input) return null;
  const from = Math.max(0, +startSec || 0);
  const to = endSec > from ? Math.min(endSec, from + Math.min(maxSec || FILE_MAX_SEC, FILE_MAX_SEC)) : from + Math.min(maxSec || FILE_MAX_SEC, FILE_MAX_SEC);
  const total = Math.max(1, to - from);
  const parts = [];
  const chunks = Math.ceil(total / FILE_CHUNK_SEC);
  for (let i = 0; i < chunks; i++) {
    if (signal && signal.aborted) return parts.length ? parts.join(' ').trim() : null;
    const at = from + i * FILE_CHUNK_SEC;
    const dur = Math.min(FILE_CHUNK_SEC, to - at);
    if (dur <= 0.2) break;
    try {
      const body = await encodeRange(input, at, dur);
      // Nothing came out of ffmpeg: a clip with no audio track at all. That is
      // not a failure of the cloud, it is a clip with nothing to hear.
      if (!body || !body.length) return parts.length ? parts.join(' ').trim() : '';
      const text = await postAudio(body, { signal, prompt });
      if (text) parts.push(text);
    } catch (e) {
      // Partway through a long file, what has already been heard is worth more
      // than nothing — a caption written from the first ten minutes of a sermon
      // is a real caption. With nothing at all, say so and let the PC try.
      health.why = (e && e.message) || 'could not reach the speech service';
      return parts.length ? parts.join(' ').trim() : null;
    }
    if (onProgress) { try { onProgress(Math.round(((i + 1) / chunks) * 100)); } catch (er) {} }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/* ===================== CAPTIONS, HEARD BY THE BIG MODEL ===================
 *
 * "Could the Groq API do the captions rather than medium.en? I'm still doing a
 *  lot of correcting."
 *
 * The captions were transcribed on the church's own PC, and the best model a
 * PC can afford is the problem this whole module exists for: Medium runs at
 * 3.2x SLOWER than real time here, and Small — what most churches actually use
 * — is a twentieth of large-v3's size. The words a caption gets wrong are the
 * words a small model gets wrong.
 *
 * Captions need more than the text, though: every WORD has to know when it was
 * said, or the lines cannot be broken, timed or lit up as they are spoken. The
 * transcription endpoint gives exactly that with `timestamp_granularities[]=
 * word` — measured on the real sermon, 60 s of audio came back with 98
 * word-timed entries in 1.1 s.
 *
 * Long recordings go up in ten-minute pieces, and each piece hears three
 * seconds EITHER SIDE of its own stretch. A word that straddles a cut is then
 * heard whole by both neighbours, and each keeps only the words whose middle
 * falls in its own stretch — so nothing is said twice and nothing is cut in
 * half. Without the overlap the word on every ten-minute boundary was a coin
 * toss.
 *
 * Never fatal, and never silent: the caller is told how far the cloud got and
 * why it stopped, finishes the rest on this PC, and SAYS it did.
 */
/* Three-minute pieces (were ten): every piece is heard with the sentences
 * before it (captionPrompt), and a long piece let Whisper drift into a minute
 * of no punctuation. 45 minutes is 15 requests, well inside 20 a minute. */
const WORDS_CHUNK_SEC = 180;
const WORDS_PAD_SEC = 3;
const WORDS_RETRY_MAX_WAIT_MS = 65e3;   // a minute's allowance refilling is worth waiting for; an hour's is not

let jobs = null;
try { jobs = require('./jobs'); } catch (e) { jobs = null; }
const jobCancelled = () => !!(jobs && jobs.isCancelled());

/**
 * The words of one verbose answer, on the clock of the whole file.
 *
 * A stretch is thrown away only when it is BOTH one of Whisper's stock
 * non-speech fillers ("Thank you.", "so", subtitle credits — see isArtefact)
 * AND the model itself doubted there was speech there. A preacher really does
 * say "Thank you" between sentences, and a caption that silently drops what
 * was said is worse than one that keeps a filler over the band.
 *
 * Pure, so the test can pin it without a network.
 */
const UNSURE_LOGPROB = -0.8;       // Whisper's own "I am not sure of this passage"
const UNSURE_COMPRESSION = 2.4;    // …or the repetition of a decoder going round in circles
function wordsFromVerbose(json, offsetSec) {
  const off = +offsetSec || 0;
  const segs = Array.isArray(json && json.segments) ? json.segments : [];
  const doubted = segs.filter((s) => s && isArtefact(s.text)
    && ((+s.no_speech_prob || 0) >= 0.2 || (+s.avg_logprob || 0) < -0.8));
  const raw = Array.isArray(json && json.words) ? json.words : [];
  const out = [];
  for (const w of raw) {
    const text = String((w && (w.word != null ? w.word : w.text)) || '').replace(/\s+/g, ' ').trim();
    const a = +w.start, b = +w.end;
    if (!text || !Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    const mid = (a + b) / 2;
    if (doubted.some((s) => mid >= (+s.start || 0) - 0.01 && mid <= (+s.end || 0) + 0.01)) continue;
    const word = { text, start: +(a + off).toFixed(3), end: +(b + off).toFixed(3) };
    // A passage the model itself was unsure of (its own average log-probability,
    // or the tell-tale repetition of a decoder going round in circles) is worth
    // a human look, whatever the second listen says.
    const seg = segs.find((s) => s && mid >= (+s.start || 0) - 0.01 && mid <= (+s.end || 0) + 0.01);
    if (seg && ((+seg.avg_logprob || 0) < UNSURE_LOGPROB || (+seg.compression_ratio || 0) > UNSURE_COMPRESSION)) word.unsure = true;
    out.push(word);
  }
  return inSpokenOrder(out);
}

/*
 * THE ORDER IS THE ORDER THEY WERE SAID IN — NOT THE ORDER OF THEIR STAMPS.
 *
 * Measured on the real sermon: 3 words in 98 came back stamped a fraction of a
 * second BEFORE the word in front of them, always at a sentence break —
 * "greet" 9.06 s, then "them." 8.94 s. Sorting by time swapped them and the
 * caption read "AND THEM GREET". The provider's list is in spoken order, so
 * that order is kept and the stamp is moved instead: a word never starts
 * before the one before it has finished.
 */
function inSpokenOrder(words) {
  for (let i = 1; i < words.length; i++) {
    const p = words[i - 1], w = words[i];
    if (w.start < p.end) {
      const s = Math.min(p.end, w.end);
      words[i] = Object.assign({}, w, { start: +s.toFixed(3), end: +Math.max(s, w.end).toFixed(3) });
    }
  }
  return words;
}

/** The verbose answer with any segment that is only the prompt said back removed (and its words). */
function withoutPromptEcho(json, prompt) {
  const segs = Array.isArray(json && json.segments) ? json.segments : [];
  const echo = segs.filter((s) => s && isCaptionPromptEcho(s.text, prompt, s));
  if (!echo.length) return json;
  const inEcho = (w) => { const m = ((+w.start) + (+w.end)) / 2; return echo.some((s) => m >= (+s.start || 0) - 0.01 && m <= (+s.end || 0) + 0.01); };
  return Object.assign({}, json, {
    segments: segs.filter((s) => !echo.includes(s)),
    words: (Array.isArray(json.words) ? json.words : []).filter((w) => !inEcho(w)),
  });
}

/** How long the provider says to wait, in ms, from whichever header it sent. */
function retryWaitMs(res) {
  const h = (n) => (res && res.headers && res.headers.get(n)) || '';
  const parse = (v) => {
    const s = String(v || '').trim();
    if (!s) return 0;
    // "30s", "1m2.5s", "450ms", or a bare number of seconds (Retry-After)
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s) * 1000;
    let ms = 0; let any = false;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
      any = true;
      const n = parseFloat(m[1]);
      ms += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60e3 : n * 3600e3;
    }
    return any ? ms : 0;
  };
  return parse(h('retry-after')) || parse(h('x-ratelimit-reset-audio-seconds')) || parse(h('x-ratelimit-reset-requests')) || 0;
}

/** One piece to the provider, asking for word timings. Returns the verbose JSON, or throws. */
async function postAudioWords(body, { timeoutMs = 180000, retry429 = true, model: asked = null, prompt = '', flac = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    const model = asked || captionModelId();
    if (flac) form.append('file', new Blob([body], { type: 'audio/flac' }), 'clip.flac');
    else form.append('file', new Blob([body], { type: 'audio/ogg' }), 'clip.ogg');
    if (prompt) form.append('prompt', prompt);
    form.append('model', model);
    form.append('language', 'en');
    form.append('temperature', '0');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // Cancel is a click in the studio; this is how it reaches a request in flight.
    const watch = setInterval(() => { if (jobCancelled()) ac.abort(); }, 250);
    let res;
    try {
      res = await fetch(endpoint(), {
        method: 'POST',
        headers: Object.assign({ authorization: 'Bearer ' + fileKey() },
          cfg.provider === 'openrouter'
            ? { 'http-referer': 'https://church.work.space', 'x-title': 'Church Work Space' }
            : {}),
        body: form,
        signal: ac.signal,
      });
    } catch (e) {
      if (jobCancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      throw new Error((e && e.name === 'AbortError')
        ? 'the speech service did not answer in time'
        : 'could not reach the speech service' + (e && e.message ? ' (' + e.message + ')' : ''));
    } finally { clearTimeout(timer); clearInterval(watch); }
    if (res.ok) return res.json();
    if (res.status === 429) {
      /*
       * A batch of shorts is twenty requests in a row against a twenty-a-minute
       * allowance, so a 429 here usually means "in a few seconds", not "today".
       * Waiting that out keeps the WHOLE batch on the big model; giving up would
       * caption half the shorts in the cloud and the other half on the PC.
       */
      const wait = retryWaitMs(res);
      if (retry429 && attempt < 3 && wait > 0 && wait <= WORDS_RETRY_MAX_WAIT_MS) {
        const until = Date.now() + wait + 500;
        while (Date.now() < until) {
          if (jobCancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          await new Promise((r) => setTimeout(r, 250));
        }
        continue;
      }
      throw new Error('the free allowance is used up for the moment'
        + (wait ? ' — it comes back in about ' + Math.max(1, Math.round(wait / 60000)) + ' min' : ''));
    }
    if (res.status === 401 || res.status === 403) throw new Error('that key was refused');
    if (res.status === 413) throw new Error('that piece of audio was too big for the speech service');
    // the accurate model refused (not offered on this key or provider): Turbo hears it, now and from here on
    if ((res.status === 400 || res.status === 404) && !asked && model !== modelId()) { captionModelRefusedAt = Date.now(); continue; }
    throw new Error('the speech service answered ' + res.status);
  }
}

/**
 * Word-timed captions for [startSec, endSec] of a media file.
 *
 * Times come back RELATIVE TO startSec, exactly as the PC's whisper returns
 * them, so the two engines are interchangeable to every caller.
 *
 * Returns null when there is no key, otherwise
 *   { words, doneSec, why, model }
 * where `doneSec` is how far (from startSec) the cloud got. doneSec short of
 * the end means it stopped part-way — `why` says what happened — and the
 * caller hears the rest on this PC.
 */
async function transcribeWords({ input, startSec = 0, endSec = 0, totalSec = 0, onProgress = null, chunkSec = WORDS_CHUNK_SEC, model = null, second = false, terms = null, plain = false } = {}) {
  if (!fileReady() || !ffmpegPath || !input) return null;
  const from = Math.max(0, +startSec || 0);
  const to = endSec > from ? +endSec : from + Math.max(0, +totalSec || 0);
  if (!(to > from)) return null;
  const span = to - from;
  // `chunkSec` is only ever changed by the test, to prove the seams on a short file.
  const CH = Math.max(20, +chunkSec || WORDS_CHUNK_SEC);
  const pieces = Math.max(1, Math.ceil(span / CH - 1e-6));
  const words = [];
  let doneSec = 0;
  for (let i = 0; i < pieces; i++) {
    if (jobCancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const a = from + i * CH;                                    // this piece's own stretch…
    const b = Math.min(to, a + CH);
    const ha = Math.max(from, a - WORDS_PAD_SEC);                // …and what it hears
    const hb = Math.min(to, b + WORDS_PAD_SEC);
    let json, prompt = '';
    try {
      // `plain`: the old way (Opus, no context) — kept so the two can be measured side by side
      const body = plain ? await encodeRange(input, ha, hb - ha, 180000) : await encodeRangeLossless(input, ha, hb - ha, 180000);
      if (!body || !body.length) { doneSec = b - from; continue; }   // no audio track: nothing to hear
      if (onProgress) { try { onProgress(Math.round(((i + 0.3) / pieces) * 100)); } catch (e) {} }
      if (!plain) {
        // The sentences before go in only when they are punctuated: Whisper
        // continues in the style it is shown, and an unpunctuated stretch
        // handed on as context carried the same into the next piece (measured:
        // one ran for six minutes). The primer alone restarts it properly.
        const tail = words.slice(-60);
        const ends = tail.filter((w) => /[.?!,]$/.test(w.text)).length;
        const said = tail.length && ends >= Math.max(1, Math.floor(tail.length / 15)) ? tail.map((w) => w.text).join(' ') : '';
        prompt = captionPrompt({ terms: terms || [], before: said });
      }
      json = await postAudioWords(body, Object.assign({ prompt, flac: !plain }, model ? { model } : {}));
    } catch (e) {
      if (e && e.cancelled) throw e;
      if (jobCancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      // Remembered for state().why, so "heard on this PC instead" can say WHY.
      // Deliberately not trip(): a caption failing must not stand the live ear down.
      health.why = (e && e.message) || 'could not reach the speech service';
      return { words: inSpokenOrder(words), doneSec, why: health.why, model: captionModelId() };
    }
    const got = wordsFromVerbose(prompt ? withoutPromptEcho(json, prompt) : json, ha - from);
    const lo = i === 0 ? -Infinity : a - from;
    const hi = i === pieces - 1 ? Infinity : b - from;
    for (const w of got) {
      const mid = (w.start + w.end) / 2;
      if (mid >= lo && mid < hi) words.push(w);
    }
    doneSec = b - from;
    if (onProgress) { try { onProgress(Math.round(((i + 1) / pieces) * 100)); } catch (e) {} }
  }
  // Pieces arrive in order and each is in spoken order; only the seams need tidying.
  const heard = inSpokenOrder(words);
  // a second opinion is a plain listen: only the first one fills its gaps
  if (second) return { words: heard, doneSec: span, why: '', model: model || captionModelId() };
  const back = await hearGapsAgain({ input, from, span, words: heard, terms: plain ? null : (terms || []) });
  return { words: back.words, doneSec: span, why: '', model: captionModelId(), reheard: back.added };
}

/*
 * ►► A SECOND, INDEPENDENT LISTEN — SO ONLY THE DOUBTFUL LINES NEED A LOOK. ◄◄
 *
 * No speech model is right every time, and a caption published to the world
 * has to be. Reading every line of a sermon to find the two that are wrong is
 * what was eating the operator's time. So the same audio is heard a second
 * time by a DIFFERENT model (Turbo, after the full Large v3), and the two are
 * lined up word by word. Where they agree, the line is very probably right —
 * two independent ears rarely make the same mistake. Where they differ (a
 * name, a number, a mumbled word, music under the voice), the words are marked
 * `doubt`, and the studio lists just those lines, with what the other ear
 * heard, one tap to take it. The second listen costs the same free allowance
 * again and a few seconds; if it cannot be had, the answer says the lines
 * were NOT double-checked, rather than letting silence read as "all clear".
 */
const normTok = (t) => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']/g, '');
const ALIGN_WIN_SEC = 45;
/** Mark the words of `a` the other listen `b` did not hear the same. Both on one clock. */
function markDisagreements(a, b) {
  let doubts = 0;
  if (!a.length) return doubts;
  const end = Math.max(a[a.length - 1].end, b.length ? b[b.length - 1].end : 0);
  const midOf = (w) => (w.start + w.end) / 2;
  for (let w0 = 0; w0 < end + ALIGN_WIN_SEC; w0 += ALIGN_WIN_SEC) {
    const A = a.filter((w) => midOf(w) >= w0 && midOf(w) < w0 + ALIGN_WIN_SEC);
    const B = b.filter((w) => midOf(w) >= w0 && midOf(w) < w0 + ALIGN_WIN_SEC);
    if (!A.length) continue;
    const x = A.map((w) => normTok(w.text)), y = B.map((w) => normTok(w.text));
    // longest common subsequence: what both ears heard, in the same order
    const n = x.length, m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i][j] = x[i] && x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const matched = new Uint8Array(n);
    const missedBefore = new Uint8Array(n + 1);   // the other ear heard words here that this one did not
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] && x[i] === y[j]) { matched[i] = 1; i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else { if (y[j]) missedBefore[i] = 1; j++; }
    }
    for (; j < m; j++) if (y[j]) missedBefore[n] = 1;
    for (let k = 0; k < n; k++) {
      const off = !matched[k] && !!x[k];
      // a word only the other ear heard sits between two this one did: the one
      // after it carries the flag — unless a neighbour is already flagged for it
      // (a different word in the same place is ONE doubt, not two)
      const gap = (missedBefore[k] && (k === 0 || matched[k - 1]))
        || (k === n - 1 && missedBefore[n] && matched[k]);
      if (off || gap) { if (!A[k].doubt) doubts++; A[k].doubt = true; }
    }
  }
  return doubts;
}
/*
 * ►► WORDS THAT WERE NEVER SAID. ◄◄
 * Whisper sometimes writes text that does not line up with any speech: the
 * aligner then squeezes it into an instant. Measured on a real sermon: "ask
 * them been praying for a long time, forever" — six words in under half a
 * second, the preacher said "ask them forever"; and "do do what? what?", the
 * second of each a few hundredths of a second long. Speech does not go that
 * fast. A word squeezed like that (or an instant repeat of the word before) is
 * dropped — but only when the independent second listen did not hear it there.
 */
const SQUEEZE_SEC = 0.06;
function dropSqueezed(words, alt) {
  if (!Array.isArray(words) || !words.length) return { words: words || [], dropped: 0 };
  const dur = (w) => (+w.end) - (+w.start);
  const n = words.length;
  const squeezed = new Uint8Array(n);
  // runs of two or more instant words
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && dur(words[j]) <= SQUEEZE_SEC) j++;
    if (j - i >= 2) for (let k = i; k < j; k++) squeezed[k] = 1;
    i = j > i ? j : i + 1;
  }
  // three or more words at under a tenth of a second each, on average — far
  // faster than anyone speaks (a quick preacher is ~0.2 s a word)
  for (let i = 0; i < n; i++) {
    let tot = 0, best = -1;
    for (let j = i; j < n && j - i < 12; j++) {
      tot += Math.max(0, (+words[j].end) - (+words[j].start));
      if (j - i >= 2 && tot / (j - i + 1) < 0.1) best = j;
    }
    for (let k = i; k <= best; k++) squeezed[k] = 1;
  }
  // an instant copy of the word beside it
  const same = (a, b) => !!a && !!b && !!normTok(a.text) && normTok(a.text) === normTok(b.text);
  for (let i = 0; i < n; i++) if (dur(words[i]) <= SQUEEZE_SEC && (same(words[i], words[i - 1]) || same(words[i], words[i + 1]))) squeezed[i] = 1;
  const altW = Array.isArray(alt) ? alt : [];
  const heardThere = (w) => {
    const t = normTok(w.text), m = ((+w.start) + (+w.end)) / 2;
    return altW.some((a) => normTok(a.text) === t && Math.abs(((+a.start) + (+a.end)) / 2 - m) <= 0.8);
  };
  const out = [];
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    // an instant copy is never "heard there" by virtue of the word beside it
    const repeat = dur(words[i]) <= SQUEEZE_SEC && (same(words[i], words[i - 1]) || same(words[i], words[i + 1]));
    if (squeezed[i] && (repeat || !heardThere(words[i]))) { dropped++; continue; }
    out.push(words[i]);
  }
  return { words: out, dropped };
}

/*
 * ►► WHERE THE CONTEXT LED THE EAR ASTRAY, THE PLAIN EAR'S WORDS. ◄◄
 * The context-primed listen is the more accurate one sentence by sentence
 * ("who art in heaven", the punctuation), but now and then it loses its place:
 * measured on a real sermon, fifteen seconds ("…this is not your daughter. But
 * please, cover this secret. Don't let anybody know.") came back as "Our
 * father, I I that us. praying." The plain second listen heard those fifteen
 * seconds right. So the two are compared stretch by stretch:
 *   • a stretch where the plain ear heard at least eight words in five seconds
 *     and the primed one barely a third as many — the primed one lost it;
 *   • a run of five or more primed words the plain ear heard none of —
 *     words that were not said there;
 * and in either, the plain ear's words are used. A short difference (one to
 * four words: "art in heaven" against "at the never") is left to the primed
 * ear, which is usually the one that is right about it.
 */
const FUSE_WIN = 5, FUSE_MIN_ALT = 8, FUSE_RATIO = 0.34, FUSE_RUN = 5, FUSE_NEAR = 1.0;
function fuseWithPlain(words, alt) {
  if (!Array.isArray(words) || !Array.isArray(alt) || !alt.length) return { words: words || [], replaced: 0 };
  const mid = (w) => ((+w.start) + (+w.end)) / 2;
  const n = words.length;
  const bad = [];      // [from, to] stretches whose words come from the plain ear
  // 1) a stretch the primed ear lost
  const end = Math.max(n ? +words[n - 1].end : 0, +alt[alt.length - 1].end);
  for (let t = 0; t < end; t += 1) {
    const q = alt.filter((w) => mid(w) >= t && mid(w) < t + FUSE_WIN).length;
    if (q < FUSE_MIN_ALT) continue;
    const p = words.filter((w) => mid(w) >= t && mid(w) < t + FUSE_WIN).length;
    if (p < q * FUSE_RATIO) bad.push([t, t + FUSE_WIN]);
  }
  // 2) a run of words the plain ear did not hear
  const heard = (w) => { const t = normTok(w.text), m = mid(w); return !t || alt.some((a) => normTok(a.text) === t && Math.abs(mid(a) - m) <= FUSE_NEAR); };
  for (let i = 0; i < n;) {
    if (heard(words[i])) { i++; continue; }
    let j = i;
    while (j < n && !heard(words[j])) j++;
    if (j - i >= FUSE_RUN) bad.push([+words[i].start - 0.05, +words[j - 1].end + 0.05]);
    i = j;
  }
  if (!bad.length) return { words, replaced: 0 };
  // join overlapping stretches
  bad.sort((a, b) => a[0] - b[0]);
  const spans = [bad[0].slice()];
  for (const [a, b] of bad.slice(1)) { const l = spans[spans.length - 1]; if (a <= l[1]) l[1] = Math.max(l[1], b); else spans.push([a, b]); }
  const inSpan = (w) => spans.some(([a, b]) => mid(w) >= a && mid(w) < b);
  const kept = words.filter((w) => !inSpan(w));
  // the plain ear writes without capitals: the Name, "I", and a sentence's first word get theirs
  const CAPS = { i: 'I', "i'm": "I'm", "i've": "I've", "i'll": "I'll", "i'd": "I'd", god: 'God', jesus: 'Jesus', christ: 'Christ', lord: 'Lord' };
  const cap = (t) => { const m = /^([a-z']+)(\W*)$/.exec(t); return m && CAPS[m[1]] ? CAPS[m[1]] + m[2] : t; };
  const taken = alt.filter((w) => inSpan(w)).map((w) => Object.assign({}, w, { text: cap(String(w.text || '')), fromPlain: true }));
  const out = kept.concat(taken).sort((a, b) => mid(a) - mid(b));
  return { words: inSpokenOrder(out), replaced: taken.length, spans: spans.length };
}

/** Hear [from,to] again with the OTHER model and mark where the two disagree. */
async function secondOpinion({ input, from, to, words, onProgress = null, terms = null, plain = false }) {
  const first = captionModelId();
  const other = (provider().models || []).map((m) => m.id).find((id) => id !== first && /whisper-large-v3/.test(id));
  if (!other) return { checked: false, why: 'no second model to compare with' };
  let r;
  try {
    // Heard WITHOUT the context (and its own model): an independent ear is the
    // point of a second one — a prompt both share could mislead both the same way.
    r = await transcribeWords({ input, startSec: from, endSec: to, onProgress, model: other, second: true, plain: true });
  } catch (e) {
    if (e && e.cancelled) throw e;
    return { checked: false, why: (e && e.message) || 'the second listen failed' };
  }
  if (!r || r.doneSec < (to - from) - 0.5) return { checked: false, why: (r && r.why) || 'the second listen stopped part-way' };
  const doubts = words.length ? markDisagreements(words, r.words) : 0;
  return { checked: true, model: other, alt: r.words, doubts };
}

/*
 * ►► WHAT THE BIG MODEL LEFT OUT, HEARD AGAIN. ◄◄
 *
 * Measured on the live server: a 117-second sermon came back with its whole
 * LAST SENTENCE missing — "The Lord is my shepherd, I shall not want", nine
 * words, every time it was asked. The same audio asked from 30, 60 or 87 s
 * heard it; the same audio a few milliseconds shorter heard it; the same audio
 * with two seconds of silence added did NOT. Whisper decides window by window
 * whether there is more to say, and now and then it decides wrong and stops —
 * not a quiet passage, not a cut, nothing a setting fixes. A caption that
 * silently leaves out what was said is the worst kind there is, because
 * nothing on the screen shows it is missing.
 *
 * So after the whole span is heard, the stretches where something was LOUD
 * ENOUGH TO BE SPEECH and no word landed are asked about again, on their own,
 * with a second of what was said either side for context: the stretch after
 * the last word first (where the measured loss was), then the longest gaps
 * between words. A stretch at the level of the room between sentences is a
 * pause and is left alone; a word only counts if it falls inside the gap, and
 * an answer that is nothing but Whisper's stock filler ("Thank you.") over
 * music is dropped. At most GAP_TRIES requests, so a sermon with a long music
 * interval costs a few seconds, not a second listen.
 */
const GAP_TAIL_SEC = 1.2;       // after the last word: shorter than this is the speaker's breath
const GAP_MID_SEC = 3;          // between two words
const GAP_CTX_SEC = 1;          // heard either side of the gap, so the model has the sentence
const GAP_WIN_SEC = 28;         // a request covers at most this much of a gap (one Whisper window)
const GAP_TRIES = 6;
/* The whole second listen, at most. The words are already complete when it
 * starts; it is a chance to do better, never a reason to keep the operator
 * waiting (found by review: a rate-limited key could hold a finished caption
 * at 90% for minutes, each try waiting out the allowance). */
const GAP_BUDGET_MS = 30000;
const GAP_LOUD_DB = 14;         // a gap this close to the speech's own level may be speech…
const GAP_FLOOR_DB = -55;       // …and never one quieter than this, whatever the speech was
const LEVEL_STEP = 0.25;        // the level is read in quarter seconds

/** Loudness of [from, from+dur] in LEVEL_STEP blocks, dB full scale. Null if it cannot be read. */
function levelsOf(input, from, dur) {
  const SR = 8000, per = Math.round(SR * LEVEL_STEP);
  const args = ['-v', 'error', ...(from > 0 ? ['-ss', String(from)] : []), '-t', String(dur),
    '-i', input, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'];
  return new Promise((resolve) => {
    let proc;
    // stderr is not wanted, and a pipe nobody reads fills up and stalls ffmpeg
    // on a damaged file that complains on every frame — so it goes nowhere
    try { proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return resolve(null); }
    if (jobs) jobs.track(proc);
    const db = [];
    let sum = 0, n = 0, carry = null;
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 120000);
    proc.stdout.on('data', (d) => {
      const buf = carry ? Buffer.concat([carry, d]) : d;
      const whole = buf.length - (buf.length % 2);
      for (let o = 0; o < whole; o += 2) {
        const s = buf.readInt16LE(o) / 32768;
        sum += s * s;
        if (++n === per) { db.push(10 * Math.log10(sum / n + 1e-12)); sum = 0; n = 0; }
      }
      carry = whole < buf.length ? buf.subarray(whole) : null;
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (n > per / 4) db.push(10 * Math.log10(sum / n + 1e-12));
      resolve(code === 0 && db.length ? db : null);
    });
  });
}

/**
 * The stretches worth asking about again, most likely first. Pure, so the test
 * can pin it: `words` on the span's clock, `levels` from levelsOf (or null,
 * which asks about every long-enough gap).
 */
function gapsToHear(words, span, levels) {
  const gaps = [];
  if (!words.length || !(span > 0)) return gaps;
  const last = words[words.length - 1];
  if (span - last.end >= GAP_TAIL_SEC) gaps.push({ a: last.end, b: span, tail: true });
  if (words[0].start >= GAP_MID_SEC) gaps.push({ a: 0, b: words[0].start });
  for (let k = 1; k < words.length; k++) {
    if (words[k].start - words[k - 1].end >= GAP_MID_SEC) gaps.push({ a: words[k - 1].end, b: words[k].start });
  }
  let loud = gaps;
  if (levels && levels.length) {
    // The speech's own level: the middle of the blocks the words were heard in.
    const at = (t) => Math.min(levels.length - 1, Math.max(0, Math.floor(t / LEVEL_STEP)));
    const spoken = [];
    for (const w of words) for (let i = at(w.start); i <= at(w.end); i++) spoken.push(levels[i]);
    spoken.sort((x, y) => x - y);
    const ref = spoken.length ? spoken[Math.floor(spoken.length / 2)] : -Infinity;
    loud = gaps.filter((g) => {
      const bl = levels.slice(at(g.a), at(Math.min(g.b, g.a + GAP_WIN_SEC)) + 1).slice().sort((x, y) => y - x);
      // the loud fifth of the gap, against the speech: a pause sits well below it
      return bl.length && bl[Math.floor(bl.length * 0.2)] >= Math.max(ref - GAP_LOUD_DB, GAP_FLOOR_DB);
    });
  }
  const tail = loud.filter((g) => g.tail);
  const rest = loud.filter((g) => !g.tail).sort((x, y) => (y.b - y.a) - (x.b - x.a));
  return tail.concat(rest).slice(0, GAP_TRIES);
}

const normWord = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9']/g, '');

/*
 * ►► …BUT NOT WHAT WHISPER INVENTS OVER MUSIC. ◄◄
 *
 * A second chance at a stretch the first pass heard nothing in is also a
 * second chance to hallucinate, and over a song it does: measured on the
 * operator's own birthday clip, the re-heard 15 s of music came back as "No,
 * please, no, no, no, no, no, no, no, no, no" and went onto the captions.
 * Whisper's confidence numbers cannot tell (see READING THE ANSWER: Groq's
 * no_speech_prob is 0.00 even for silence), so the WORDS are judged, by three
 * things invented speech does and real speech does not:
 *   • one word over and over — more than half of four or more;
 *   • a crawl — real speech runs two to three words a second, the invented
 *     line above under one;
 *   • words held for seconds — the middle word of a real phrase is a quarter
 *     of a second, a sung or invented one more than one.
 * The sentence this was built to recover ("The Lord is my shepherd, I shall
 * not want": 9 words in 2.4 s, no word twice) passes all three by a mile.
 * A real chant of one word could fail the first — and is then simply left as
 * the first pass heard it, which is what happened before any of this.
 */
function looksSpoken(words) {
  const n = (words || []).length;
  if (!n) return false;
  const durs = words.map((w) => Math.max(0, (+w.end || 0) - (+w.start || 0))).sort((a, b) => a - b);
  if (durs[Math.floor(n / 2)] > 1.0) return false;
  if (n >= 4) {
    const counts = new Map();
    for (const w of words) { const k = normWord(w.text); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    if (Math.max(0, ...counts.values()) / n > 0.5) return false;
    // the pace while SPEAKING: a pause (cheering between "He is risen!" and "He is
    // risen indeed!", a preacher's held silence) is not slow speech
    let spoken = 0, from = +words[0].start || 0;
    for (let k = 1; k <= n; k++) {
      if (k === n || (+words[k].start || 0) - (+words[k - 1].end || 0) > 1.5) {
        spoken += Math.max(0.3, (+words[k - 1].end || 0) - from);
        if (k < n) from = +words[k].start || 0;
      }
    }
    if (n / spoken < 1.0) return false;
  }
  return true;
}

/*
 * ►► A GAP THAT WAS NEVER A GAP IS NOT HEARD TWICE. ◄◄
 *
 * Whisper now and then squashes a run of words into too little time, so a
 * stretch it DID hear looks like three seconds with no words in it. Asked
 * again, that stretch comes back with the same words properly stamped — and
 * they landed BETWEEN the first copies: "WE WE HURT HURT BUT BUT THE THE HOLY",
 * forty seconds of it, on a real 44-minute sermon. So a re-heard answer is
 * only new speech when most of it was not already heard around the gap; and a
 * re-heard word that merely repeats the word beside it is the same word twice.
 * The ending this was built to recover ("The Lord is my shepherd, I shall not
 * want" after the last word) shares at most a word with what came before it.
 */
function freshWords(got, heard, ha, hb) {
  if (!got.length) return got;
  const near = new Map();
  for (const w of heard) {
    const mid = (w.start + w.end) / 2;
    if (mid < ha - 3 || mid > hb + 3) continue;
    const k = normWord(w.text); if (k) near.set(k, (near.get(k) || 0) + 1);
  }
  let seen = 0;
  const left = new Map(near);
  for (const w of got) {
    const k = normWord(w.text);
    if (k && left.get(k) > 0) { seen++; left.set(k, left.get(k) - 1); }
  }
  if (got.length >= 2 && seen / got.length >= 0.5) return [];
  return got.filter((w) => {
    const k = normWord(w.text); if (!k) return true;
    const mid = (w.start + w.end) / 2;
    return !heard.some((h) => normWord(h.text) === k && Math.abs((h.start + h.end) / 2 - mid) < 1.2);
  });
}

async function hearGapsAgain({ input, from, span, words, terms = null }) {   // eslint-disable-line no-unused-vars
  const keep = { words, added: 0 };
  if (!words.length) return keep;              // nothing heard at all: music, or silence — not a gap
  let levels = null;
  try { levels = await levelsOf(input, from, span); } catch (e) { levels = null; }
  const todo = gapsToHear(words, span, levels);
  if (!todo.length) return keep;
  // The ending gets a second try with more of the sentence before it: the
  // loss being undone is itself a coin toss, and a different window re-tosses it.
  const tries = [];
  for (const g of todo) { tries.push({ g, ctx: GAP_CTX_SEC }); if (g.tail) tries.push({ g, ctx: GAP_CTX_SEC * 4, again: true }); }
  let out = words, tailDone = false;
  const until = Date.now() + GAP_BUDGET_MS;
  for (const { g, ctx, again } of tries.slice(0, GAP_TRIES)) {
    if (jobCancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    if (again && tailDone) continue;
    if (Date.now() > until - 3000) break;
    const ha = Math.max(0, g.a - ctx);
    const hb = Math.min(span, Math.min(g.b, g.a + GAP_WIN_SEC) + GAP_CTX_SEC);
    if (!(hb - ha > 0.5)) continue;
    let json;
    try {
      const body = await encodeRange(input, from + ha, hb - ha, 60000);
      if (!body || !body.length) continue;
      // no waiting out a rate limit here: that allowance belongs to the next short's first listen
      json = await postAudioWords(body, { timeoutMs: Math.max(3000, Math.min(20000, until - Date.now())), retry429: false });
    } catch (e) {
      // (Cancel kills the encode, which fails as an ordinary error: it is still a cancel)
      if ((e && e.cancelled) || jobCancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      break;                                   // the first failure ends it: the first answer stands as it was
    }
    // only what lands INSIDE the gap — the context either side was already heard
    let got = wordsFromVerbose(json, ha).filter((w) => {
      const mid = (w.start + w.end) / 2;
      // (a hair inside: "The" of "The Lord is my shepherd" sat 0.15 s past the
      // last word heard, and a wider margin threw it away; a context word
      // re-stamped into the gap is caught by its text just below)
      return mid > g.a + 0.05 && mid < g.b - 0.05;
    });
    // the context's own edge words, re-stamped a little into the gap, are not new
    const before = out.filter((w) => w.end <= g.a + 0.01).pop();
    const after = out.find((w) => w.start >= g.b - 0.01);
    while (got.length && before && normWord(got[0].text) === normWord(before.text)) got = got.slice(1);
    // (only when this request actually reached that word: a gap longer than one
    // window ends unheard, and a real word that happens to match is not a repeat)
    if (hb >= g.b - 0.01) while (got.length && after && normWord(got[got.length - 1].text) === normWord(after.text)) got = got.slice(0, -1);
    got = freshWords(got, out, ha, hb);
    if (!got.length || isArtefact(got.map((w) => w.text).join(' ')) || !looksSpoken(got)) continue;
    out = out.concat(got).sort((x, y) => x.start - y.start);
    keep.added += got.length;
    if (g.tail) tailDone = true;
  }
  keep.words = inSpokenOrder(out);
  return keep;
}

/**
 * Timed SENTENCES for [startSec, endSec] — what ✂️ Long-to-shorts reads.
 *
 * The scan snaps every clip to sentence edges and judges what was said, so its
 * transcript quality caps everything downstream: on a real convention the
 * PC's base.en wrote "Guys, the God in this right" for "There is a God in
 * Israel". This is Whisper Large v3 Turbo in the cloud, returning segments in
 * exactly the shape captioner.transcribe({ granularity: 'segment' }) does —
 * { start, end, text }, RELATIVE to startSec — so the scan cannot tell the two
 * apart. The scan hands it pieces of at most four minutes (highlights.js
 * MAX_SPAN), which is one request each.
 *
 * Returns { segs, model } or throws with a plain reason; the caller hears that
 * piece on this PC instead and says so.
 */
async function transcribeSegments({ input, startSec = 0, endSec = 0 } = {}) {
  if (!fileReady() || !ffmpegPath || !input) throw new Error('no speech key');
  const from = Math.max(0, +startSec || 0), to = +endSec || 0;
  if (!(to > from)) return { segs: [], model: modelId() };
  const body = await encodeRange(input, from, to - from, 180000);
  if (!body || !body.length) return { segs: [], model: modelId() };   // no audio track
  // One network blip must not send the rest of a scan back to the PC's ear:
  // measured, a scan lost the cloud after two pieces on a "fetch failed" that
  // the very next request would have survived. One more try, then the caller
  // decides.
  let json;
  for (let attempt = 0; ; attempt++) {
    try { json = await postAudioWords(body); break; } catch (e) {
      if (e && e.cancelled) throw e;
      if (attempt >= 1 || !/could not reach|did not answer/i.test((e && e.message) || '')) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const segs = [];
  for (const s of (Array.isArray(json && json.segments) ? json.segments : [])) {
    const text = String((s && s.text) || '').replace(/\s+/g, ' ').trim();
    const a = +s.start, b = +s.end;
    if (!text || !Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    // the same "Thank you." / subtitle-credit hallucinations the captions drop
    if (isArtefact(text) && ((+s.no_speech_prob || 0) >= 0.2 || (+s.avg_logprob || 0) < -0.8)) continue;
    segs.push({ start: +a.toFixed(3), end: +b.toFixed(3), text });
  }
  // the same answer carries every word's timing: kept, so ✂️ Remove pauses can
  // find this clip's pauses without sending the audio back to be heard again
  return { segs, words: wordsFromVerbose(json, 0), model: captionModelId() };
}

module.exports = {
  captionModelId, secondOpinion, markDisagreements, dropSqueezed, fuseWithPlain, captionPrompt, isCaptionPromptEcho, withoutPromptEcho, CAPTION_PRIMER,
  _resetCaptionModel: () => { captionModelRefusedAt = 0; },
  configure, state, ready, transcribe, test, cadence,
  fileReady, transcribeFile, transcribeWords, transcribeSegments, shareKey,
  wordsFromVerbose, retryWaitMs, inSpokenOrder, gapsToHear, looksSpoken, freshWords,
  /** Was the last window handed to the PC a paced skip, or a real failure? */
  lastDecline: () => lastDecline,
  PROVIDERS, DEFAULT_PROVIDER, SAMPLE_RATE,
  promptFor, looksLikePromptEcho, textFrom, budget, encode,
  _health: () => health,
  _resetBudget: () => gov.reset(),
};
