'use strict';
const { spawn } = require('child_process');
const jobs = require('./jobs');

/*
 * Sermon -> shorts highlight detection (audio-driven, on-device, no LLM needed).
 *
 * Idea: a preacher's "key points" are delivered as passages of elevated, sustained
 * vocal energy, usually framed by deliberate pauses. We:
 *   1. decode the audio to a low-rate mono PCM stream,
 *   2. build a loudness (dB) envelope,
 *   3. split it into speech segments separated by pauses,
 *   4. score every pause-bounded window (energy above the speaker's baseline,
 *      a climactic peak, good duration, mostly-speech, framed by pauses),
 *   5. greedily pick the top non-overlapping windows.
 *
 * Because windows begin/end on pause boundaries, the resulting shorts cut
 * cleanly at sentence edges — never mid-word.
 */

const SR = 8000;         // analysis sample rate (plenty for a loudness envelope)
const HOP = 0.05;        // 50 ms analysis hop
const HOP_SAMPLES = Math.round(SR * HOP);

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[i];
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Decode audio to a mono Int16 PCM buffer at SR via ffmpeg (streamed on stdout).
 *
 * `from`/`to` decode only part of the file. That is what makes "the AI searches
 * what I trimmed the clip down to" real rather than cosmetic: the greetings and
 * the worship set are never even LOOKED at, so the loudness baseline, the pause
 * detection and the clip selection are all computed from the preaching alone.
 * `-ss` before `-i` seeks (accurately — ffmpeg's -accurate_seek is on by
 * default), so hop 0 of the envelope really is second `from` of the video.
 */
/*
 * The whole stretch's sound, as 8 kHz mono PCM, for the loudness envelope.
 *
 * Measured on a 2 GB, three-hour service: 55 s for 66 minutes, with the
 * progress bar standing still at ~19% the whole time, before a single word was
 * heard. It is CPU-bound, so the stretch is decoded in pieces AT ONCE across
 * the cores, and with a lighter resampling filter (a loudness envelope does
 * not need studio-grade resampling: -30% on its own). Each piece is an exact
 * number of samples, so the joined buffer is the same as one long decode.
 */
async function extractPcm(ffmpeg, input, from, to, opts = {}) {
  const a = Math.max(0, from || 0);
  const len = to != null && to > a ? to - a : (opts.totalSec ? Math.max(0, opts.totalSec - a) : 0);
  // how many at once is the CALLER's call (it knows the cores): this file stays
  // free of anything but child_process + jobs (test:editor-score [6])
  const n = len >= 600 ? Math.max(1, Math.min(opts.parallel || 1, Math.floor(len / 300))) : 1;
  if (n === 1) return extractPcmOne(ffmpeg, input, a, len || null);
  const step = Math.ceil(len / n);
  let done = 0;
  const parts = await Promise.all(Array.from({ length: n }, (_, k) => {
    const s0 = a + k * step, d = Math.min(step, a + len - s0);
    return extractPcmOne(ffmpeg, input, s0, d, true).then((b) => { done++; if (opts.onPart) opts.onPart(done / n); return b; });
  }));
  // each piece trimmed/padded to exactly its own sample count, so nothing slides
  const out = parts.map((b, k) => {
    const want = Math.round(Math.min(step, a + len - (a + k * step)) * SR) * 2;
    if (b.length === want || k === n - 1) return b;
    return b.length > want ? b.subarray(0, want) : Buffer.concat([b, Buffer.alloc(want - b.length)]);
  });
  const buf = Buffer.concat(out);
  if (buf.length < HOP_SAMPLES * 2) throw new Error('This video has no usable audio track to analyze.');
  return buf;
}
function extractPcmOne(ffmpeg, input, from, dur, partial) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (from > 0) args.push('-ss', String(from));
    args.push('-i', input);
    if (dur) args.push('-t', String(dur));
    args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-af', `aresample=${SR}:filter_size=8`,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-');
    const proc = jobs.track(spawn(ffmpeg, args, { windowsHide: true }));
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 40000) stderr = stderr.slice(-20000); });
    proc.on('error', (e) => reject(new Error('Could not start ffmpeg: ' + e.message)));
    proc.on('close', (code) => {
      if (jobs.isCancelled()) return reject(new jobs.CancelledError());
      const buf = Buffer.concat(chunks);
      if (!partial && buf.length < HOP_SAMPLES * 2) return reject(new Error('This video has no usable audio track to analyze.'));
      resolve(buf);
    });
  });
}

/*
 * THE LOUDNESS, WITHOUT THE SOUND.
 *
 * extractPcm hands back the whole sermon as samples — an hour is 58 MB, and on
 * the way it existed as chunks, then as pieces, then as the joined buffer, so
 * the scan briefly held about three copies of it. All the scan ever does with
 * the samples is buildEnvelope: one loudness figure per 50 ms. On a 512 MB
 * server, those copies were the difference between a scan and a crash.
 *
 * This builds the same envelope while ffmpeg is still talking, 400 samples at
 * a time, and keeps nothing else. It is the same arithmetic in the same order
 * (test:envelope-stream checks it figure for figure against
 * buildEnvelope(extractPcm(...))). The pieces line up with the hops because
 * every piece but the last is a whole number of seconds — 8000 samples, twenty
 * hops — and is trimmed or zero-padded to exactly that, as extractPcm does.
 */
async function extractEnvelope(ffmpeg, input, from, to, opts = {}) {
  const a = Math.max(0, from || 0);
  const len = to != null && to > a ? to - a : (opts.totalSec ? Math.max(0, opts.totalSec - a) : 0);
  const n = len >= 600 ? Math.max(1, Math.min(opts.parallel || 1, Math.floor(len / 300))) : 1;
  let parts;
  if (n === 1) {
    parts = [await envelopeOne(ffmpeg, input, a, len || null, null)];
  } else {
    const step = Math.ceil(len / n);
    let done = 0;
    parts = await Promise.all(Array.from({ length: n }, (_, k) => {
      const s0 = a + k * step, d = Math.min(step, a + len - s0);
      const last = k === n - 1;
      return envelopeOne(ffmpeg, input, s0, d, last ? null : Math.round(d * SR))
        .then((e) => { done++; if (opts.onPart) opts.onPart(done / n); return e; });
    }));
  }
  const hops = parts.reduce((t, e) => t + e.hops, 0);
  if (hops < 1) throw new Error('This video has no usable audio track to analyze.');
  const db = new Float64Array(hops);
  const rms = new Float64Array(hops);
  let at = 0;
  for (const e of parts) { db.set(e.db.subarray(0, e.hops), at); rms.set(e.rms.subarray(0, e.hops), at); at += e.hops; }
  return { db, rms, hops };
}
/** One piece's envelope, straight off ffmpeg's stdout. `exact` samples, padded or cut, when given. */
function envelopeOne(ffmpeg, input, from, dur, exact) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (from > 0) args.push('-ss', String(from));
    args.push('-i', input);
    if (dur) args.push('-t', String(dur));
    args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-af', `aresample=${SR}:filter_size=8`,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-');
    const proc = jobs.track(spawn(ffmpeg, args, { windowsHide: true }));
    // grows as hops arrive; a piece of known length is sized once
    let cap = exact ? Math.ceil(exact / HOP_SAMPLES) : 4096;
    let db = new Float64Array(cap), rms = new Float64Array(cap);
    let hops = 0, samples = 0;
    let sumSq = 0, inHop = 0;
    let odd = null;                       // a byte left over between chunks
    const push = (r) => {
      if (hops === cap) {
        cap *= 2;
        const d2 = new Float64Array(cap); d2.set(db); db = d2;
        const r2 = new Float64Array(cap); r2.set(rms); rms = r2;
      }
      rms[hops] = r;
      db[hops] = 20 * Math.log10(r / 32768 + 1e-9);
      hops++;
    };
    const take = (v) => {
      sumSq += v * v;
      if (++inHop === HOP_SAMPLES) { push(Math.sqrt(sumSq / HOP_SAMPLES)); sumSq = 0; inHop = 0; }
      samples++;
    };
    let stderr = '';
    proc.stdout.on('data', (d) => {
      let i = 0;
      if (odd !== null) { take(Buffer.from([odd, d[0]]).readInt16LE(0)); odd = null; i = 1; }
      for (; i + 1 < d.length; i += 2) {
        if (exact && samples >= exact) return;
        take(d.readInt16LE(i));
      }
      if (i < d.length) odd = d[i];
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 40000) stderr = stderr.slice(-20000); });
    proc.on('error', (e) => reject(new Error('Could not start ffmpeg: ' + e.message)));
    proc.on('close', () => {
      if (jobs.isCancelled()) return reject(new jobs.CancelledError());
      if (exact) while (samples < exact) take(0);          // as extractPcm pads a short piece
      resolve({ db, rms, hops });
    });
  });
}

/** Build the per-hop loudness envelope (dB) from an Int16LE PCM buffer. */
function buildEnvelope(buf) {
  const n = Math.floor(buf.length / 2);
  const hops = Math.floor(n / HOP_SAMPLES);
  const db = new Float64Array(hops);
  const rms = new Float64Array(hops);
  for (let h = 0; h < hops; h++) {
    let sumSq = 0;
    const base = h * HOP_SAMPLES * 2;
    for (let i = 0; i < HOP_SAMPLES; i++) {
      const s = buf.readInt16LE(base + i * 2);
      sumSq += s * s;
    }
    const r = Math.sqrt(sumSq / HOP_SAMPLES);
    rms[h] = r;
    db[h] = 20 * Math.log10(r / 32768 + 1e-9);
  }
  return { db, rms, hops };
}

/** Smooth an array with a small centered moving average. */
function smooth(arr, radius) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let j = i - radius; j <= i + radius; j++) { if (j >= 0 && j < arr.length) { s += arr[j]; c++; } }
    out[i] = s / c;
  }
  return out;
}

const tOf = (hop) => hop * HOP;

/** Real pauses (runs of the envelope at/below `threshold` for >= minDur seconds).
 *  These are the only places a cut can land without chopping a word. */
function pauseWindows(dbS, threshold, minDur = 0.12) {
  const minHops = Math.max(2, Math.round(minDur / HOP));
  const out = [];
  for (let h = 0; h < dbS.length;) {
    if (dbS[h] <= threshold) {
      let j = h; while (j < dbS.length && dbS[j] <= threshold) j++;
      if (j - h >= minHops) out.push({ s: tOf(h), e: tOf(j) });
      h = j;
    } else h++;
  }
  return out;
}

/**
 * Boundary snapper: moves a proposed cut time into the nearest real pause so the
 * cut NEVER lands on a voiced frame. Whisper timestamps jitter by a few hundred
 * ms and threshold-crossings sit exactly ON the first/last word — both chop
 * words when trusted as-is. Snapping is what makes the start/end feel "right":
 *   start → a beat (`lead`) before the voice actually comes in,
 *   end   → after the last word has fully rung out (`tail` into the silence).
 * The nearest pause to the proposed time always wins, so a mid-sentence breath
 * further away can't steal the cut from the true sentence boundary.
 */
function makeSnapper(dbS, threshold, totalDur) {
  const pauses = pauseWindows(dbS, threshold, 0.2);
  const EDGE = 0.1; // stay this far inside the pause (envelope smoothing smears its edges)
  const nearest = (t, lo, hi, anchorOf) => {
    let best = null, bestD = Infinity;
    for (const p of pauses) {
      if (p.e < lo) continue;
      if (p.s > hi) break;
      const contains = p.s <= t && p.e >= t;
      const a = anchorOf(p);
      if (!contains && (a < lo || a > hi)) continue;
      const d = contains ? 0 : Math.abs(a - t);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  };
  return {
    /** Snap a clip START. Searches pauses ENDING in [t-back, t+fwd]. */
    start(t, back = 0.6, fwd = 0.5, lead = 0.25) {
      if (t <= 0.1) return 0;
      const p = nearest(t, t - back, t + fwd, (x) => x.e);
      if (!p) return Math.max(0, t - 0.15);
      // long dead air ahead: keep t (just inside the pause), don't jump forward
      if (p.e - t > 1.2) return clamp(t, p.s + EDGE, p.e - EDGE);
      return clamp(clamp(p.e - lead, p.s + EDGE, p.e - EDGE), 0, totalDur);
    },
    /** Snap a clip END. Searches pauses STARTING in [t-back, t+fwd]; if none exists
     *  (laughter/applause or barreling delivery running through the sentence edge),
     *  rides FORWARD to the next real breath within the `hardMax` length budget —
     *  the natural spoken boundary a human editor would cut on. */
    end(t, back = 0.5, fwd = 0.9, tail = 0.35, hardMax = Infinity) {
      if (t >= totalDur - 0.1) return totalDur;
      let p = nearest(t, t - back, t + fwd, (x) => x.s);
      if (!p) p = nearest(t, t - 0.7, Math.min(t + 3.0, hardMax), (x) => x.s);
      if (!p) return Math.min(totalDur, t + 0.3, hardMax);
      return clamp(clamp(p.s + tail, p.s + EDGE, p.e - EDGE), 0, Math.min(totalDur, hardMax));
    },
    /** Is there a real pause a START/END cut at t could snap into? Used to PREFER
     *  sentence runs whose edges are also acoustic boundaries — where the preacher
     *  actually breathes — over ones that would force a cut into flowing speech. */
    startOk(t, back = 0.6, fwd = 0.5) { return t <= 0.1 || !!nearest(t, t - back, t + fwd, (x) => x.e); },
    endOk(t, back = 0.5, fwd = 0.9) { return t >= totalDur - 0.1 || !!nearest(t, t - back, t + fwd, (x) => x.s); },
    /** …and HOW MUCH room that pause gives (seconds; 0 = none, 2 = the edge of
     *  the searched span). A 1.3-second breath is a far better place to cut than
     *  a 0.25-second one, which "is there a pause at all" cannot tell apart. */
    startRoom(t, back = 0.6, fwd = 0.5) {
      if (t <= 0.1) return 2;
      const p = nearest(t, t - back, t + fwd, (x) => x.e);
      return p ? p.e - p.s : 0;
    },
    endRoom(t, back = 0.5, fwd = 0.9) {
      if (t >= totalDur - 0.1) return 2;
      const p = nearest(t, t - back, t + fwd, (x) => x.s);
      return p ? p.e - p.s : 0;
    },
  };
}

// Phrases a preacher uses to flag a key point / grab attention.
const HOOK_PHRASES = [
  'listen to me', 'listen', 'hear me', 'hear this', 'let me tell you', 'i want you to', 'i need you to',
  'you need to', 'you have to', 'you must', 'look at', 'watch this', "i'm telling you", 'understand this',
  "here's the thing", 'the truth is', 'let me say', 'pay attention', "don't miss", 'this is important',
  'this is key', 'remember this', 'never forget', 'can i tell you', 'let me explain', 'the reason',
  'the bible says', 'scripture says', 'god said', 'jesus said', 'i decree', 'i declare', 'somebody say',
  'say amen', 'are you with me', 'this is why', 'the problem is', 'here is what', 'i promise you',
];
const FAITH_WORDS = new Set(['god', 'jesus', 'christ', 'lord', 'holy', 'spirit', 'faith', 'grace', 'mercy', 'pray', 'prayer',
  'bible', 'scripture', 'gospel', 'heaven', 'salvation', 'saved', 'sin', 'cross', 'believe', 'blessing', 'blessed',
  'kingdom', 'anoint', 'anointing', 'worship', 'glory', 'miracle', 'testimony', 'covenant', 'righteous', 'repent',
  'deliverance', 'breakthrough', 'favour', 'favor', 'purpose', 'destiny', 'promise', 'word', 'church', 'love', 'hope']);

/** Score a transcript excerpt for "key point" content (higher = more important). */
function contentScore(text) {
  if (!text) return 0;
  const t = text.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  const wc = words.length || 1;
  let s = 0;
  let hooks = 0; for (const p of HOOK_PHRASES) if (t.includes(p)) hooks++;
  s += Math.min(3, hooks) * 0.6;                                   // attention hooks
  const q = (text.match(/\?/g) || []).length; s += Math.min(3, q) * 0.35; // rhetorical questions
  let fw = 0; for (const w of words) { const b = w.replace(/[^a-z]/g, ''); if (FAITH_WORDS.has(b)) fw++; }
  s += clamp((fw / wc) / 0.05, 0, 1) * 0.9;                        // teaching/faith density
  const freq = {}; let maxRep = 0;
  for (const w of words) { const b = w.replace(/[^a-z]/g, ''); if (b.length > 3) { freq[b] = (freq[b] || 0) + 1; if (freq[b] > maxRep) maxRep = freq[b]; } }
  s += clamp((maxRep - 2) / 3, 0, 1) * 0.5;                        // repetition = emphasis
  s += Math.min(2, (text.match(/!/g) || []).length) * 0.2;
  if (wc < 12) s -= 0.5;                                           // too little said
  const fillers = (t.match(/\b(um|uh|you know|i mean)\b/g) || []).length;
  s -= clamp(fillers / wc / 0.08, 0, 1) * 0.4;
  return s;
}

/* -------- transcript-driven boundaries + human-like scoring (deep mode) -------- */

// Preacher speaking directly TO the listener / making a declaration — the stuff a
// human clips. Kept broad but not so broad it matches everything.
const IMPERATIVE_RX = /\b(you (?:must|need to|have to|should|shall|can|will|are|were|have|cannot|can't)|don't|do not|never|always|let me (?:tell|say)|listen|watch this|look at|remember|understand|imagine|receive|i (?:declare|decree|promise|prophesy))\b/;
// SPIRIT-FILLED MOMENTS — declarations, altar-call/prophetic language, the peaks a
// church clips for socials. Weighted strongly: these ARE the "best parts".
const POWER_RX = /\b(i (?:decree|declare|prophesy)|receive (?:it|your|this|the)|in the name of jesus|in jesus'? name|somebody (?:shout|say|clap)|shout (?:amen|hallelujah|glory)|hallelujah|glory to god|the anointing|holy (?:ghost|spirit)|god is about to|god will|your (?:season|time|breakthrough|miracle|blessing|destiny)|it is (?:done|finished|settled)|by fire|touch (?:somebody|your neighbou?r)|lift (?:up )?your hands?|pray (?:with|for) me|say with me|the power of god|move of (?:god|the spirit)|give (?:him|god) (?:praise|glory)|testimony|miracle)\b/g;
// Congregation reacting (whisper marks these) — applause/cheers/shouts flag a moment
// that LANDED live; the strongest social-clip signal there is.
const CROWD_RX = /\[(?:applause|cheer[^\]]*|shout[^\]]*|clapping|crowd[^\]]*)\]|\((?:applause|cheer[^)]*|congregation[^)]*|crowd[^)]*|clapping|shouting)\)/gi;
// Logistics / greetings / housekeeping — NOT the sermon's teaching (penalise).
// (Running the service is not preaching it: seating people, welcoming a guest to
// the pulpit and calling for applause are the lines that made "highlights" out of
// a handover on a real convention recording.)
const ADMIN_RX = /\b(good (?:morning|afternoon|evening)|welcome to|we welcome|turn to your neighbou?r|clap your hands|put your hands together|round of applause|give (?:the lord|god|him|her|them) a|please (?:get|be) seated|let me sit down|the usher|announcement|bulletin|next (?:week|sunday|service)|download|website|fill (?:out|in)|the app|social media|offering envelope|prayer request card|sign up)\b/;
// A story being told — testimony, personal history, parable retelling. Stories are
// the most-watched sermon clips because they carry a viewer with no context.
const STORY_RX = /\b(let me tell you (?:a|about)|there was a (?:man|woman|boy|girl|time)|i remember (?:when|the)|years ago|one day|when i was|a few (?:weeks|months|years) ago|true story|my (?:father|mother|son|daughter|wife|husband|grandmother|grandfather)|i met a|somebody once)\b/;
// The TURN — the reversal beat every preacher builds to ("the doctors said... BUT
// GOD"). A clip that contains the turn contains the payoff.
const TURN_RX = /\b(but god|but the lord|but jesus|but then god|but (?:because|when|since) (?:god|the lord|jesus)|until god|then god (?:said|stepped|showed|moved)|god stepped in|(?:because|since) god (?:has |had )?spoken|it came to pass|the devil (?:thought|said|wanted|tried)|the enemy (?:thought|said|wanted|tried)|suddenly|everything changed|that's when|little did (?:i|they|he|she) know|what (?:the devil|the enemy|they) meant for)\b/;

/** Merge whisper phrase-segments into clean SENTENCES with absolute times: split on
 *  terminal punctuation (. ! ? …) or a long silent gap, so cuts land on real
 *  sentence edges (perfect start/finish, never mid-word). */
/**
 * Whisper's segment boundaries are NOT sentence boundaries. The bigger, better
 * models are the worse offenders: Small emits 7-8 second chunks holding three or
 * four sentences and breaking mid-phrase —
 *
 *   95:16.8  "Joshua and Caleb was there. Joshua was the leader. Are you hearing me? Joshua was"
 *   95:24.8  "the leader. The man did not say because we went together. We are at the same level"
 *
 * — so splitting only at chunk edges made a single 20-second "sentence" out of
 * four, and every edge decision below was then working on the wrong units.
 * Split each chunk on its own terminal punctuation instead, sharing the chunk's
 * time across the pieces by length. The times are approximate, which is fine:
 * they only choose WHICH sentence to cut at, and the acoustic snap picks the
 * actual frame from the audio.
 */
function splitChunk(c) {
  const parts = String(c.text).split(/(?<=[.!?…]["')\]]?)\s+/).filter((t) => t.trim());
  if (parts.length < 2) return [c];
  const total = parts.reduce((a, t) => a + t.length, 0) || 1;
  const out = [];
  let t = c.start;
  for (const p of parts) {
    const d = (c.end - c.start) * (p.length / total);
    out.push({ start: t, end: t + d, text: p });
    t += d;
  }
  out[out.length - 1].end = c.end;
  return out;
}

function buildSentences(rawChunks) {
  const chunks = [];
  for (const c of (rawChunks || [])) if (c && c.text) chunks.push(...splitChunk(c));
  const sents = [];
  let cur = null;
  // End of the last chunk SEEN — including ones dropped as non-speech below. The
  // difference between that and the next sentence's start is time nobody said
  // anything at all, which is what tells a handover from a musical sting.
  let heardTo = null;
  for (let i = 0; i < chunks.length; i++) {
    let c = chunks[i];
    if (!c || !c.text) continue;
    // strip whisper's non-speech tokens ([LAUGHTER], [MUSIC], and the ♪ it wraps
    // singing in) so they never pollute labels/quotes or the content scoring — a
    // real run titled a clip "♪♪♪ So I give glory to God…"
    const cleaned = c.text.replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) { heardTo = Math.max(heardTo == null ? c.end : heardTo, c.end); continue; }
    const silentBefore = heardTo == null ? 0 : Math.max(0, c.start - heardTo);
    heardTo = c.end;
    c = { start: c.start, end: c.end, text: cleaned };
    if (!cur) cur = { start: c.start, end: c.end, text: c.text, gapBefore: silentBefore };
    else { cur.end = c.end; cur.text = (cur.text + ' ' + c.text).replace(/\s+/g, ' ').trim(); }
    const endsPunct = /[.!?…]["')\]]?$/.test(c.text.trim());
    const gapNext = (i + 1 < chunks.length) ? (chunks[i + 1].start - c.end) : 99;
    if (endsPunct || gapNext > 0.85) { sents.push(cur); cur = null; }
  }
  if (cur) sents.push(cur);
  return sents.filter((s) => s.text && s.end > s.start);
}

/** Pick the run of COMPLETE sentences that best covers the delivery-hot window
 *  [ws,we] while fitting [minLen,maxLen]. Returns {start,end,sents} on sentence edges.
 *  With autoLen the length pull is nearly off — the clip settles at whatever natural
 *  length the complete thought takes, and a clean quotable LANDING (a final sentence
 *  that really ends, not a gap-split trail-off) is rewarded instead.
 *
 *  Both EDGES are decided here, and both are decided the same way a human editor
 *  decides them — by reading forward and backward past the loud bit and asking
 *  "does the thought start here, and does it finish here?". The delivery-hot
 *  window only says WHERE TO LOOK; it does not get to set the cut points, which
 *  is why the clip is allowed to run past it to reach the payoff.
 */
function refineToSentences(ws, we, sents, minLen, maxLen, idealLen, o = {}) {
  if (!sents.length) return null;
  // Auto: don't force clips toward one length — the discourse terms below decide
  // the edges. A CHOSEN length is an instruction, though, so there the length pull
  // has to stay ahead of them: it picks which runs are eligible, and the discourse
  // terms then choose the best edges among runs of about that length.
  const fitW = o.autoLen ? 0.10 : 0.6;
  const wholeW = o.autoLen ? 0.35 : 0.25; // auto: completeness of the thought matters more
  // WHERE THE CLIP OPENS is the difference between a short and a fragment, so it
  // is decided HERE — by moving the start to a sentence that can stand alone —
  // not merely docked points afterwards. Ways a sentence fails as an opener:
  //   • it flows straight out of the previous one (lowercase, no real gap),
  //   • it opens on a connective — "Because you can win an argument…" — which is
  //     capitalised by whisper and so slipped past the lowercase test entirely,
  //   • it opens on a pronoun with no antecedent inside the clip ("He told them…"),
  //   • it is a repair ("I mean, the defence…") or a bare "Amen."
  // WHERE IT CLOSES is judged by the same standard (closerPenalty), because a
  // clip that stops before the payoff is the cut people actually complain about.
  // Pass 1 refuses a bad opener, a hanging closer and any run that straddles a
  // handover; pass 2 (only if nothing else fits at this length) allows them,
  // heavily penalised, so the least-bad option still wins.
  const fragOpener = (i) => {
    const t = sents[i].text.trim();
    if (/^[a-z]/.test(t) && (i === 0 || sents[i].start - sents[i - 1].end < 0.6)) return true;
    return openerPenalty([sents[i]], t) >= 0.5;
  };
  const fragCloser = (j) => closerPenalty([sents[j]], sents[j + 1]) >= 0.55;
  let best = null;
  let near = [];
  for (let pass = 0; pass < 2 && !best; pass++) {
    near = [];
    for (let i = 0; i < sents.length; i++) {
      if (sents[i].start > we) break;                    // must open before the hot region ends
      if (pass === 0 && fragOpener(i)) continue;
      for (let j = i; j < sents.length; j++) {
        const s = sents[i].start, e = sents[j].end, d = e - s;
        if (d > maxLen) break;
        const run = sents.slice(i, j + 1);
        // A hole THIS long is the service changing gear — a handover, a song, a
        // walk to the pulpit. Shorter holes are the congregation applauding a line
        // or the preacher pausing for effect: both belong INSIDE a clip, and
        // fixed-length modes have to be able to cross them to reach the length
        // that was asked for. Once a run contains a hole, every longer run does
        // too, so stop extending it.
        const gap = transitionGap(run);
        if (pass === 0 && gap > 6) break;
        if (d < minLen) continue;
        if (pass === 0 && fragCloser(j)) continue;
        // KEEP THE PASSIONATE PART — but the loudness window says where to LOOK,
        // not where the thought is. Scored as "how much of the window" it used to
        // hold the clip to the window's own edges: on a real passage, starting 44
        // seconds later reached a proper landing ("Your inheritance is settled.")
        // but lost so much cover it could never win. So a solid CHUNK of the hot
        // delivery earns full marks and the discourse terms decide the rest.
        const overlap = Math.max(0, Math.min(e, we) - Math.max(s, ws));
        const coverRef = Math.max(12, Math.min(we - ws, idealLen * 0.6));
        const cover = clamp(overlap / coverRef, 0, 1);
        // Sharp fit: measured against the ALLOWED BAND, not the whole maxLen — so a
        // "1 minute" selection really lands near 60s (a 40s cut reads as wrong there),
        // while autoLen (weight ~0) still lets clips take their natural length.
        const fitBand = Math.max(8, maxLen - idealLen);
        const fit = clamp(1 - Math.abs(d - idealLen) / fitBand, -1, 1);
        const n = j - i + 1;
        const wholeness = clamp((n - 0.5) / 3, 0, 1);    // 2-4 whole sentences reads best
        // Land on a sentence that truly ENDS; a gap-split trail-off as the final
        // sentence reads as "cut off in the wrong place", so it costs.
        const endsClean = /[.!?…]["')\]]?$/.test(sents[j].text.trim());
        const landing = endsClean ? (o.autoLen ? 0.2 : 0.15) : -0.2;
        // Time hanging outside the passionate window is only worth paying for if
        // it is finishing the thought — which is what closerPenalty measures — so
        // this pull is gentler than it was, and the closer decides the edge.
        const outside = (Math.max(0, e - we) + Math.max(0, ws - s)) / d;
        // Same judgement as fragOpener/fragCloser, as a cost.
        const lcStart = (/^[a-z]/.test(sents[i].text.trim()) ? 0.8 : 0)
          + 0.9 * openerPenalty([sents[i]], sents[i].text);
        const closes = closerPenalty(run, sents[j + 1]);
        // Cut where the topic changes, not through the middle of one.
        const seams = 0.3 * topicSeam(sents[i - 1], sents[i]) + 0.4 * topicSeam(sents[j], sents[j + 1]);
        // Strongly prefer runs whose edges sit at REAL pauses in the audio — a
        // sentence boundary in mid-flow speech can't be cut without chopping words,
        // no matter how good the words are — and prefer the ROOMIEST such pause.
        // (o.room comes from the loudness envelope; o.cutOk is the older yes/no form.)
        const acous = o.room ? (roomScore(o.room.start(s)) + endRoomScore(o.room.end(e)))
          : o.cutOk ? ((o.cutOk.start(s) ? 0.15 : -0.45) + (o.cutOk.end(e) ? 0.15 : -0.5)) : 0;
        const trans = gap > 6 ? 1.3 : gap > 3.5 ? 0.3 : 0;
        const sc = 1.0 * cover + fitW * fit + wholeW * wholeness + landing + acous + seams
          - lcStart - 1.15 * closes - trans - 1.5 * loopiness(run)
          - (o.autoLen ? 0.30 : 0.25) * outside;
        const run_ = { start: s, end: e, sc, closes, opens: lcStart, sents: run, next: sents[j + 1] || null };
        if (!best || sc > best.sc) best = run_;
        near.push(run_);
      }
    }
    // WHEN IT IS A CLOSE CALL, TAKE THE FULLER THOUGHT.
    //
    // Every remaining complaint about these clips has been the same one — "it
    // cut it too short" — and every time the ending the operator wanted was a
    // beat or two LATER and scored within a whisker of the one that won. A
    // preacher makes a point and then proves it; the summary line and the proof
    // both end cleanly, so no test tells them apart, and the shorter one wins on
    // length-fit by a hair. Where the scores are this close there is no real
    // evidence for the shorter cut, so the tie goes to the ending that includes
    // the payoff rather than the one that stops before it.
    // The longer run has to open and close AT LEAST as well, though — this buys
    // the payoff with a little length-fit and window overlap, never with the
    // quality of either edge.
    if (best) {
      // Deliberately just UNDER the 0.3 step between "he paused here" and "he
      // did not" in endRoomScore: a real acoustic landing still decides the cut,
      // and this only settles the cases where nothing actually distinguishes them.
      const TOL = 0.28;
      for (const r of near) {
        if (r.end > best.end && r.sc >= best.sc - TOL
          && r.closes <= best.closes + 1e-6 && r.opens <= best.opens + 1e-6) best = r;
      }
    }
  }
  return best;
}

/** Human-like content score: builds on contentScore() but rewards a strong OPENING
 *  hook, direct address/imperatives, a clean quotable LANDING, and completeness;
 *  penalises housekeeping/greetings. `sents` = the clip's sentence array. */
function contentScoreV2(text, sents) {
  let s = contentScore(text);
  const t = (text || '').toLowerCase();
  const wc = t.split(/\s+/).filter(Boolean).length || 1;
  const first = ((sents && sents[0] ? sents[0].text : (text || '').split(/[.!?]/)[0]) || '').toLowerCase();
  if (HOOK_PHRASES.some((p) => first.includes(p)) || /\?\s*$/.test(first.trim()) || IMPERATIVE_RX.test(first) || new RegExp(POWER_RX.source, 'i').test(first)) s += 0.5; // opens strong
  const power = (t.match(POWER_RX) || []).length; s += clamp(power / 2, 0, 1) * 0.6;  // Spirit-filled declarations / altar-call peaks
  const imp = (t.match(new RegExp(IMPERATIVE_RX.source, 'g')) || []).length; s += clamp(imp / 3, 0, 1) * 0.5;            // preaches TO you
  const you = (t.match(/\byou(?:r|'re|'ll|'ve)?\b/g) || []).length; s += clamp((you / wc) / 0.06, 0, 1) * 0.35;
  const last = (sents && sents.length ? sents[sents.length - 1].text : '').trim();
  if (/[.!?]["')\]]?$/.test(last) && last.split(/\s+/).length <= 16) s += 0.35;                                          // clean landing
  if (sents && sents.length) { const n = sents.length; s += (n >= 2 && n <= 5 ? 0.3 : 0) - (n > 8 ? 0.3 : 0); }         // complete, not rambling
  const admin = (t.match(new RegExp(ADMIN_RX.source, 'g')) || []).length; s -= clamp(admin, 0, 2) * 0.6;                 // not housekeeping
  if (STORY_RX.test(t)) s += 0.4;                                                                                       // carries a story
  if (TURN_RX.test(t)) s += 0.45;                                                                                       // contains the reversal payoff
  return s;
}

/* ==================== THE FREE, ON-DEVICE EDITOR PASS ====================
 *
 * Everything below runs on the whisper transcript we already paid for — no key,
 * no network, no cost, nothing leaves the machine. It asks the questions a human
 * shorts editor asks of every candidate, and answers them by comparing the
 * candidates against EACH OTHER (which is why it runs over the whole pool):
 *
 *   1. Can a stranger follow it from the first word?  → openerPenalty
 *   2. Is it about ONE thing?                         → cohesion
 *   3. Is it distinctive, or could it be any sermon?  → TF-IDF distinctiveness
 *   4. Does it land a payoff?                         → quotableLine / anaphora
 */

// Words that carry no topic, so they can't count toward cohesion or be "rare".
const STOP = new Set(('a an and the or but so then that this these those there here it its is are was were be been being am '
  + 'of to in on at by for with from into over under about as if when while because he she they we you i me my your our their '
  + 'his her them us do does did done have has had will would can could shall should may might must not no nor too very just '
  + 'now also more most other some such only own same than what which who whom whose how why where all any both each few '
  + 'get got go going come came say says said see saw know knew think thought want wanted like one two up out down off again '
  + 'ever never always well much many lot okay yes yeah amen').split(' '));

const wordsOf = (t) => String(t || '').toLowerCase().match(/[a-z']+/g) || [];
const contentWordsOf = (t) => wordsOf(t).filter((w) => w.length > 3 && !STOP.has(w));

/**
 * A clip has to make sense to someone who did not hear the sentence before it.
 * These are the openers that break that: a bare connective, a pronoun with
 * nothing in the clip for it to refer to, a mid-flow REPAIR ("I mean, the…"),
 * or a bare response token ("Amen." "Hi.") that answers a beat the viewer never
 * heard. This is the single biggest difference between "a clip" and "a fragment
 * of a sermon".
 */
const DANGLING_RX = /^(so|and|but|then|because|which|who|that|therefore|however|anyway|also|plus|yet|though|although|since|while|as|or|nor|for)\b/i;
const BARE_PRONOUN_RX = /^(he|she|they|it|him|her|them|his|hers|their|theirs|this|that|these|those)\b/i;
// The speaker correcting themselves — only ever happens mid-thought.
const REPAIR_RX = /^(i mean|or rather|sorry|that is to say|what i'?m saying is|in other words|like i said|as i was saying)\b/i;
// A whole sentence that is nothing but a reaction to something already said.
const RESPONSE_ONLY_RX = /^(amen|hallelujah|alleluia|hi|hello|yes|yeah|yep|no|nope|okay|ok|thank you|thanks|thank you so much|praise god|praise the lord|glory|come on|right|sure|exactly)[\s.,!?]*$/i;
function openerPenalty(sents, text) {
  const first = ((sents && sents[0] ? sents[0].text : String(text || '').split(/[.!?]/)[0]) || '').trim();
  if (!first) return 1;
  let p = 0;
  if (DANGLING_RX.test(first)) p += 0.7;      // "So then he said…" — mid-thought
  if (BARE_PRONOUN_RX.test(first)) p += 0.6;  // "He told them…" — who is he?
  if (/^[a-z]/.test(first)) p += 0.4;         // whisper lowercases a continuation
  if (REPAIR_RX.test(first)) p += 0.8;        // "I mean, the defence…" — a repair, never a start
  if (RESPONSE_ONLY_RX.test(first)) p += 0.6; // opens on somebody else's beat
  // Forgiven when the clip names its subject almost immediately anyway.
  if (p > 0 && /\b(god|jesus|christ|lord|holy spirit|the bible|scripture|paul|david|moses|abraham|peter|the father)\b/i.test(first)) p *= 0.45;
  return p;
}

/* ---------------- WHERE A THOUGHT ACTUALLY ENDS --------------------------
 *
 * The OPENER has been judged since the editor pass went in; the CLOSER never
 * was — and that is the cut people actually notice ("it seems to cut out
 * important parts"). A real clip from a 4-hour convention stopped on
 *
 *     "…If daddy said, well, you'll go to somewhere."
 *
 * throwing away the two seconds that made it worth clipping ("You won't see me
 * here."). Every acoustic test passed: there is a genuine 1.2-second pause
 * right there, because the preacher paused ON PURPOSE, for effect, before the
 * punchline. Silence cannot tell a dramatic pause from the end of a thought.
 * Only the words can, so these read the words.
 */
// Opens a subordinate clause — whatever it sets up is resolved AFTER it.
const OPEN_CLAUSE_RX = /^(if|when|whenever|whilst|while|since|because|unless|although|though|even though|even if|as soon as|before|after|until|till|so that|in order to|in order that|whereas|suppose|supposing|imagine if|the moment|the day)\b/i;
// Stops on a word that cannot end a thought: a conjunction, preposition,
// auxiliary or article still waiting for whatever was going to follow it.
const DANGLING_TAIL_RX = /^(and|but|or|nor|so|because|that|which|who|whom|whose|to|of|for|with|from|into|onto|upon|about|like|than|as|is|are|was|were|be|been|am|has|have|had|will|would|shall|should|can|could|may|might|must|do|does|did|the|a|an|my|your|his|her|its|their|our|this|these|those|in|on|at|by)$/i;
// Promises something that has not happened yet — the payoff is the NEXT breath.
// The second half of this list is CATAPHORA: a verb of knowing or remembering
// whose object never arrives ("But you might have forgotten." — forgotten WHAT?).
// A real clip stopped on exactly that line, four seconds before "Your
// inheritance is settled.", and every other test called the ending clean.
const SETUP_RX = /\b(let me (?:tell|show|say|explain|read|give|remind)|i (?:want|am going|'m going|will) to (?:tell|show|say|read|give|explain|remind)|listen to (?:me|this)|watch (?:this|what)|look at (?:this|that|what)|here (?:is|are|'s) (?:what|why|how|the)|hear me|i'?ll tell you|number (?:one|two|three|four)|the (?:first|second|third) (?:thing|point|reason)|(?:two|three|four) (?:things|points|reasons)|check this out|pay attention|are you ready|you (?:might|may|must) (?:have )?(?:forgotten|forget|remember)|you (?:don'?t|do not|didn'?t|might not|may not) (?:know|remember|realise|realize|understand)|do you know what|you know what i)\b/i;
// A closing line that OPENS on a bare connective is the middle of a thought, not
// the end of one. ("But God…" is the exception — that IS the payoff, and it is
// let through by `resolves` below. Note this list is deliberately narrower than
// DANGLING_RX: "That is the mercy of God!" is a fine place to stop.)
const CLOSER_CONNECTIVE_RX = /^(but|and|so|then|because|therefore|however|yet|also|plus|anyway|though|although)\b/i;
// Opens on a preposition, so it is a phrase hanging off the sentence before it
// rather than a sentence of its own — whisper punctuates these as if they stood
// alone ("Just wait. On the Lord.").
const PHRASE_ONLY_RX = /^(on|in|at|by|for|with|from|to|of|into|onto|upon|about|through|under|over|after|before|during|without|within|against|towards?|like|among|across)\b/i;
// The sentence that FOLLOWS resolves the one we were going to end on — cutting
// between them halves a single thought, even though both halves parse.
// A bare "So…" / "But…" / "Then…" opening the next sentence is NOT this: preachers
// start sentences that way constantly and it usually just carries the story on.
// Counting it cost a clip its payoff, because "…it came to pass." was followed by
// "So, it went to Joshua." and got charged for it. What matters is the next
// sentence actually completing THIS one, so the connective is allowed as an
// optional prefix and the pattern after it has to do the work.
const RESOLVER_RX = /^(?:(?:so|and|but|then|now|yet)[,\s]+)?(that'?s (?:why|when|how|what)|which is why|which means|therefore|the answer|i'?ll tell you|you won'?t|you will|you can'?t|(?:it|that|this|he|she|they) (?:doesn'?t|does not|didn'?t|did not|isn'?t|is not|wasn'?t|was not|won'?t|will not))\b/i;

/**
 * How badly a run's LAST sentence leaves the thought hanging.
 * −0.45 = lands like a full stop, 0 = fine, 1.8 = cut off mid-argument.
 * `next` is the sentence that follows it in the transcript — a broken ending
 * mostly shows itself in what comes after.
 */
function closerPenalty(sents, next) {
  if (!sents || !sents.length) return 1;
  const last = String(sents[sents.length - 1].text || '').trim();
  if (!last) return 1;
  const bare = last.replace(/["')\]]+$/, '');
  const endsTerminal = /[.!?…]$/.test(bare);
  const tail = (bare.replace(/[.,;:!?…]+$/, '').split(/\s+/).pop() || '').replace(/[^a-zA-Z']/g, '');
  const isPraise = /\b(amen|hallelujah|alleluia|praise)\b/i.test(bare);
  // Does this line RESOLVE anything — a declaration, the turn, a called-out
  // close? Only a line that does earns the landing bonus at the bottom. Being
  // short and ending in a full stop is NOT enough on its own: that is exactly
  // what let "But you might have forgotten." through as a good ending.
  const resolves = new RegExp(POWER_RX.source, 'i').test(bare) || TURN_RX.test(bare.toLowerCase());
  const opensConnective = CLOSER_CONNECTIVE_RX.test(bare) && !resolves;
  let p = 0;
  // A subordinate opening is only HALF a reason on its own — "When you pray, God
  // listens." is a fine closing line. It turns into a real one when the sentence
  // after it is the other half (the RESOLVER test below), which is exactly the
  // shape of "If daddy said…" / "You won't see me here."
  if (OPEN_CLAUSE_RX.test(bare)) p += 0.45;
  if (opensConnective) p += 0.35;                                  // the thought is still rolling
  if (!endsTerminal) p += 0.5;                                     // "…when the time came for them to distribute,"
  // Only when whisper did NOT hear a full stop: "That's all he did." ends on an
  // auxiliary and is perfectly finished; "…for their cattle and" is not.
  if (!endsTerminal && DANGLING_TAIL_RX.test(tail)) p += 0.9;      // stops on a conjunction/preposition
  if (SETUP_RX.test(bare)) p += 0.7;                               // announces a payoff the clip does not contain
  if (RESPONSE_ONLY_RX.test(bare) && !isPraise) p += 0.55;         // "Hi." "Yeah." "Thank you."
  // A prepositional phrase is not a sentence, however neatly whisper punctuated
  // it: "Just wait. On the Lord." is one thought that got a full stop put through
  // the middle of it, and stopping on the second half reads as a stumble.
  if (PHRASE_ONLY_RX.test(bare)) p += 0.5;
  if (wordsOf(bare).length <= 2 && !isPraise) p += 0.35;           // stops on a scrap
  if (next) {
    const nt = String(next.text || '').trim();
    if (RESOLVER_RX.test(nt)) p += 0.45;                           // the next breath completes this one
    // it asked a question and the answer is on the other side of the cut
    if (/\?$/.test(bare) && /^(because|the answer|yes|no|it'?s|that'?s|i'?ll tell you|here'?s)\b/i.test(nt)) p += 0.4;
  }
  // A real landing: a short declaration that resolves, or a called-out close.
  // Only claimable when we can SEE what comes next — at the edge of what was
  // transcribed there is no evidence the thought finished, just evidence that we
  // stopped reading, and treating that as a clean landing pulls clips out to the
  // end of the transcript.
  if (next && endsTerminal && p < 0.5 && !opensConnective) {
    if (wordsOf(bare).length <= 14) p -= 0.2;
    if (resolves) p -= 0.25;
  }
  return clamp(p, -0.45, 1.8);
}

/**
 * Whisper LOOPS on singing, chanting and applause: it emits the same line over
 * and over. A real run produced a 65-second "highlight" that was the sentence
 * "I'm going to have a dinner." sixty times — and it scored well enough to be
 * picked. Three repeats is a preacher building; sixty is a decoder fault.
 */
function loopiness(sents) {
  if (!sents || !sents.length) return 0;
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ').trim();
  let sentSignal = 0;
  if (sents.length >= 6) {
    const counts = new Map();
    let maxRun = 1, run = 1, prev = null;
    for (const s of sents) {
      const k = norm(s.text);
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
      if (k === prev) { run++; if (run > maxRun) maxRun = run; } else run = 1;
      prev = k;
    }
    if (counts.size) {
      const share = Math.max(...counts.values()) / sents.length;
      sentSignal = Math.max((maxRun - 4) / 6, (share - 0.45) / 0.4);
    }
  }
  // The same fault at WORD level. A congregation singing "Amen" comes back as one
  // long unpunctuated line — "Amen Amen Amen Amen…" — which is a single sentence,
  // so the test above never sees it, and a real run gave that a 118-second slot.
  // Short words are ignored so a preacher's "God will… God will… God will…" build
  // is not mistaken for one.
  const words = wordsOf(sents.map((s) => s.text).join(' ')).filter((w) => w.length > 3);
  let wordSignal = 0;
  if (words.length >= 12) {
    const f = new Map();
    for (const w of words) f.set(w, (f.get(w) || 0) + 1);
    wordSignal = (Math.max(...f.values()) / words.length - 0.3) / 0.35;
  }
  return clamp(Math.max(sentSignal, wordSignal), 0, 1);
}

/**
 * The biggest hole in a run where nobody is speaking at all. Whisper writes
 * nothing over applause, music, or a handover between speakers, so a long gap
 * between consecutive sentences is exactly where a service changes gear — the
 * one place a clip must never straddle. The loudness envelope CANNOT see this:
 * applause is loud, so a handover looks like unbroken speech. (That is how one
 * clip came to contain a host finishing his introduction, eight seconds of
 * clapping, and a guest saying "Please let me sit down.")
 */
function transitionGap(sents) {
  let g = 0;
  for (let i = 1; i < sents.length; i++) {
    const jump = sents[i].start - sents[i - 1].end;
    // A ♪ tag is dropped from the text but still proves whisper heard something,
    // so a few seconds of music under the preacher is NOT a break in the service
    // — it only becomes one when it runs long enough to be a song rather than a
    // sting. Silence with no output at all is a break at any length.
    const silent = sents[i].gapBefore != null ? sents[i].gapBefore : jump;
    const v = jump > 20 ? jump : silent;
    if (v > g) g = v;
  }
  return g;
}

/**
 * How much of a SEAM there is between two neighbouring sentences: 1 = they
 * share no subject matter (a natural place to put the blade), 0 = the second
 * carries straight on from the first. A clip that opens AND closes on a seam
 * reads as a whole piece rather than a slice out of the middle of one.
 */
function topicSeam(a, b) {
  if (!a || !b) return 0.5;                     // the edge of what we transcribed — unknown, not a seam
  const A = new Set(contentWordsOf(a.text));
  const B = contentWordsOf(b.text);
  if (!A.size || !B.length) return 0.5;
  const shared = B.filter((w) => A.has(w)).length;
  return clamp(1 - shared / Math.min(4, B.length), 0, 1);
}

/** How much room a cut has to breathe, from the length of the real pause it
 *  lands in. No pause at all chops a word; a long one is where a human editor
 *  would put the blade — and "is there a pause" cannot tell the two apart. */
const roomScore = (len) => (len <= 0 ? -0.5 : len < 0.35 ? -0.05 : len < 0.7 ? 0.1 : len < 1.2 ? 0.22 : 0.32);
/**
 * The same thing at the END of a clip, where it is worth far more.
 *
 * A preacher lands a point and then LETS IT SIT. How long the silence after a
 * sentence runs is the clearest evidence available that the thought actually
 * finished — clearer than any wording test, because it is the speaker's own
 * judgement rather than ours. Measured across one passage of a real service:
 *
 *   "That is a package for you."        1.20 s  ← a real place to stop
 *   "…it came to pass."                 1.00 s  ← the one the operator wanted
 *   "…no body can cheat you."           1.95 s  ← also real
 *   "Your inheritance is settled."      1.25 s  ← also real
 *   "I can't go for your life."         0.80 s  ← mid-speech; the shipped cut
 *   "You are my leader."                0.80 s  ← mid-speech
 *
 * On the flat scale those all sat within 0.10 of each other, so nothing could
 * tell them apart and the length-fit term picked the ending instead.
 *
 * The line worth separating is around 0.9 s — above it he has stopped, below it
 * he is still going. ABOVE that line the exact length means very little, and a
 * step there does real damage: a first attempt put the boundary at 1.0 s, which
 * made 1.20 s beat 1.00 s by 0.3 and cut a point off before its payoff. So the
 * scale is steep where the evidence is and flat where it is not.
 */
const endRoomScore = (len) => (len <= 0 ? -0.7 : len < 0.35 ? -0.1 : len < 0.7 ? 0.05
  : len < 0.95 ? 0.2 : len < 1.6 ? 0.5 : len < 2.2 ? 0.65 : 0.75);

/** Is it about ONE thing? Content-word overlap between consecutive sentences —
 *  a clip that wanders scores near 0, one that circles a subject scores high. */
function cohesion(sents) {
  if (!sents || sents.length < 2) return 0.5;
  let linked = 0, pairs = 0;
  for (let i = 1; i < sents.length; i++) {
    const a = new Set(contentWordsOf(sents[i - 1].text));
    const b = contentWordsOf(sents[i].text);
    if (!a.size || !b.length) continue;
    pairs++;
    if (b.some((w) => a.has(w))) linked++;
  }
  return pairs ? linked / pairs : 0.5;
}

/** The preacher's hallmark: the same phrase opening 2-3 sentences in a row.
 *  Free to detect, and one of the strongest "this is the moment" signals. */
function anaphora(sents) {
  if (!sents || sents.length < 2) return 0;
  const heads = sents.map((s) => wordsOf(s.text).slice(0, 2).join(' ')).filter((h) => h.split(' ').length === 2);
  let best = 0;
  for (let i = 0; i < heads.length; i++) {
    let run = 1;
    for (let j = i + 1; j < heads.length && heads[j] === heads[i]; j++) run++;
    if (run > best) best = run;
  }
  return best >= 3 ? 1 : best === 2 ? 0.5 : 0;
}

/** A line someone would screenshot: short, declarative, weighty. */
function quotableLine(sents) {
  if (!sents || !sents.length) return 0;
  const powerI = new RegExp(POWER_RX.source, 'i');
  let best = 0;
  for (const s of sents) {
    const t = s.text.trim();
    const n = wordsOf(t).length;
    if (n < 4 || n > 16) continue;
    let sc = 0;
    if (/[.!]["')\]]?$/.test(t)) sc += 0.4;
    if (powerI.test(t)) sc += 0.5;
    if (IMPERATIVE_RX.test(t.toLowerCase())) sc += 0.35;
    if (/\byou\b/i.test(t)) sc += 0.25;
    if (sc > best) best = sc;
  }
  return Math.min(1, best);
}

/** Reading a passage aloud is not a short. Verse citations with almost no
 *  direct address is the signature; commentary around them cancels it. */
const VERSE_RX = /\b(chapter\s+\d+|verses?\s+\d+|\d+\s*:\s*\d+|(genesis|exodus|leviticus|numbers|deuteronomy|joshua|psalms?|proverbs|isaiah|jeremiah|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|hebrews|james|peter|revelation)\s+\d+)\b/gi;
function readingAloud(text) {
  const t = String(text || '');
  const cites = (t.match(VERSE_RX) || []).length;
  if (!cites) return 0;
  const wc = wordsOf(t).length || 1;
  const address = (t.match(/\byou(?:r|'re|'ll|'ve)?\b/gi) || []).length / wc;
  return clamp(cites / 2, 0, 1) * (address < 0.02 ? 1 : 0.3);
}

/**
 * Score every pooled candidate the way an editor picking from a stack would —
 * against the others. `distinct` is TF-IDF style: terms this clip DWELLS on
 * that the rest of the sermon does not, which is what separates a memorable
 * passage from generic connective preaching. Entirely local and free.
 */
function scoreLikeAnEditor(pool) {
  if (!Array.isArray(pool) || !pool.length) return pool;
  // document frequency across the pool (the sermon is the corpus)
  const df = new Map();
  const bags = pool.map((c) => {
    const bag = new Map();
    for (const w of contentWordsOf(c.text)) bag.set(w, (bag.get(w) || 0) + 1);
    for (const w of bag.keys()) df.set(w, (df.get(w) || 0) + 1);
    return bag;
  });
  const N = pool.length;
  for (let i = 0; i < N; i++) {
    const c = pool[i], bag = bags[i];
    const sents = c.sentsArr || [];
    let tfidf = 0, terms = 0;
    for (const [w, tf] of bag) {
      if (tf < 2) continue;                       // dwelt on, not mentioned once
      tfidf += tf * Math.log(N / (df.get(w) || 1));
      terms++;
    }
    const distinct = clamp(tfidf / 12, 0, 1);
    const coh = cohesion(sents);
    const ana = anaphora(sents);
    const quote = quotableLine(sents);
    const dangling = openerPenalty(sents, c.text);
    const reading = readingAloud(c.text);
    // A question early and a declaration at the end is a complete little arc.
    const arc = (sents.length >= 2
      && /\?["')\]]?$/.test((sents[0].text || '').trim())
      && /[.!]["')\]]?$/.test((sents[sents.length - 1].text || '').trim())) ? 0.35 : 0;

    // `closing`/`straddles` are already priced into c.total by the caller — they are
    // carried here so the card can say, in plain English, what is wrong with a cut.
    c.editor = {
      distinct: Math.round(distinct * 100) / 100,
      cohesion: Math.round(coh * 100) / 100,
      anaphora: ana,
      quotable: Math.round(quote * 100) / 100,
      dangling: Math.round(dangling * 100) / 100,
      reading: Math.round(reading * 100) / 100,
      closing: Math.round((c.closer != null ? c.closer : closerPenalty(sents, c.nextSent)) * 100) / 100,
      straddles: Math.round((c.gap || 0) * 10) / 10,
      terms,
    };
    // Weighted against a base total that runs roughly 0..4. A dangling opener
    // and read-aloud passages SUBTRACT — an editor discards those outright.
    c.editorScore = 0.75 * distinct + 0.7 * coh + 0.5 * ana + 0.6 * quote + arc
      - 1.1 * dangling - 0.8 * reading;
    c.total = (c.total != null ? c.total : c.score) + c.editorScore;
  }
  // Distinctiveness only means anything RELATIVE to the rest of this sermon.
  // Judged on its absolute value it fired on every single clip of a real 48-minute
  // service — a reason that is always true tells the operator nothing. Rank it
  // within the pool instead, so "distinctive" means "more so than most of these".
  const order = pool.slice().sort((a, b) => (a.editor.distinct - b.editor.distinct));
  order.forEach((c, i) => { c.editor.distinctRank = order.length > 1 ? i / (order.length - 1) : 0.5; });
  return pool;
}

/**
 * Pick clips by score BUT guarantee coverage across the whole video so no
 * section is missed: first take the best in each time-bucket, then fill the
 * remaining slots with the best overall. Enforces a min gap between clips.
 */
function selectWithCoverage(cands, { maxClips, minGap, totalDur, scoreKey = 'score' }) {
  const sorted = cands.slice().sort((a, b) => b[scoreKey] - a[scoreKey]);
  const picked = [];
  const nonClash = (c) => picked.every((p) => (c.end + minGap <= p.start) || (c.start - minGap >= p.end));
  const buckets = Math.max(1, maxClips);
  for (let b = 0; b < buckets && picked.length < maxClips; b++) {
    const lo = b * totalDur / buckets, hi = (b + 1) * totalDur / buckets;
    const cand = sorted.find((c) => !picked.includes(c) && ((c.start + c.end) / 2 >= lo) && ((c.start + c.end) / 2 < hi) && nonClash(c));
    if (cand) picked.push(cand);
  }
  for (const c of sorted) { if (picked.length >= maxClips) break; if (!picked.includes(c) && nonClash(c)) picked.push(c); }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

/**
 * Main entry. ctx = { ffmpeg, ffprobe }.
 * opts: { minLen, maxLen, idealLen, maxClips, onProgress, startSec, endSec, ranges }
 *
 * SEARCH RANGE. `startSec`/`endSec` limit the analysis to a stretch of the
 * recording; `ranges` (absolute seconds, [[a,b],…]) narrows it further to the
 * exact pieces the operator kept on the timeline, so a clip can never come out
 * of a gap they cut away. Everything inside this function works in LOCAL time
 * (0 = startSec) — only the audio that is actually being searched is decoded —
 * and the returned clip times are shifted back to the source's clock at the end.
 */
/*
 * How much a reading model's 0..10 verdict is allowed to move a clip.
 *
 * c.total runs roughly 0..4 and every term in it was measured against real
 * services, so the model gets a say worth about one strong term (±1.2) rather
 * than the last word: enough to lift a clip several places or sink one, never
 * enough to overrule an engine that has been tuned on this speaker's own
 * recordings. It is also the dial to turn if the model turns out to be better
 * or worse than the rules on real footage.
 */
const LLM_RANK_W = 1.2;

async function analyzeSermon(ctx, opts = {}) {
  const minLen = opts.minLen || 15;
  const maxLen = opts.maxLen || 60;
  const idealLen = opts.idealLen || 30;
  const maxClips = opts.maxClips || 8;
  const OFF = Math.max(0, Number(opts.startSec) || 0);
  const END = (Number(opts.endSec) > OFF) ? Number(opts.endSec) : null;
  // the kept pieces, in local time; empty = the whole searched span is fair game
  const keep = (Array.isArray(opts.ranges) ? opts.ranges : [])
    .map((r) => [(+r[0] || 0) - OFF, (+r[1] || 0) - OFF])
    .filter((r) => r[1] - r[0] > 1);
  const inKeep = (a, b) => !keep.length || keep.some(([k0, k1]) => a >= k0 - 0.05 && b <= k1 + 0.05);
  // Deep mode spends most of its time transcribing — squeeze the audio phase into
  // the first ~40% of the bar so progress never jumps BACKWARDS when it starts.
  const deepMode = !!(opts.transcribeRange && opts.contentAware !== false);
  const report = (p) => { if (opts.onProgress) opts.onProgress(Math.round(deepMode ? p * 0.42 : p)); };

  const T0 = Date.now();
  const mark = (l) => { if (process.env.MW_SHORTS_TIMING) console.error('[t] ' + l + ' ' + ((Date.now() - T0) / 1000).toFixed(1) + 's'); };
  report(3);
  // the loudness is built as the sound streams in — see extractEnvelope
  const { db, hops } = await extractEnvelope(ctx.ffmpeg, opts.input, OFF, END, {
    totalSec: opts.totalSec || 0, parallel: opts.decodeParallel || 1, onPart: (f) => report(3 + Math.round(f * 40)),
  });
  mark('decoded audio');
  report(45);
  const dbS = smooth(db, 2); // ~150 ms smoothing for thresholding
  report(60);

  // Adaptive speech threshold from the loudness distribution.
  const sorted = Array.from(dbS).sort((a, b) => a - b);
  const floor = percentile(sorted, 15);   // room tone / silence
  const top = percentile(sorted, 95);     // loudest speech
  const threshold = floor + Math.max(6, (top - floor) * 0.28);

  // Classify hops, bridge tiny gaps, split on real pauses.
  const isSpeech = new Uint8Array(hops);
  for (let h = 0; h < hops; h++) isSpeech[h] = dbS[h] > threshold ? 1 : 0;

  const bridgeHops = Math.round(0.25 / HOP); // fill speech gaps < 250 ms
  for (let h = 0; h < hops; h++) {
    if (!isSpeech[h]) {
      let j = h; while (j < hops && !isSpeech[j]) j++;
      if (j - h <= bridgeHops && h > 0 && j < hops) for (let k = h; k < j; k++) isSpeech[k] = 1;
      h = j;
    }
  }

  // Segments = runs of speech, discarding tiny blips.
  const minSegHops = Math.round(0.3 / HOP);
  const segs = [];
  for (let h = 0; h < hops; h++) {
    if (isSpeech[h]) {
      let j = h; while (j < hops && isSpeech[j]) j++;
      if (j - h >= minSegHops) {
        let sum = 0, sum2 = 0; for (let k = h; k < j; k++) { sum += db[k]; sum2 += db[k] * db[k]; }
        let mx = -999; for (let k = h; k < j; k++) if (db[k] > mx) mx = db[k];
        // mean of the segment's first ~5s (used for "hook" strength scoring)
        const headEnd = Math.min(j, h + Math.round(5 / HOP));
        let headSum = 0; for (let k = h; k < headEnd; k++) headSum += db[k];
        segs.push({
          s: tOf(h), e: tOf(j), meanDb: sum / (j - h), maxDb: mx, hopStart: h, hopEnd: j,
          sumDb: sum, sumDb2: sum2, hopCount: j - h, headDb: headSum / Math.max(1, headEnd - h),
        });
      }
      h = j;
    }
  }
  report(72);

  if (segs.length === 0) {
    throw new Error(OFF > 0 || END
      ? 'Could not detect any speech in the part of the video you kept — drag the clip’s edges to cover the preaching.'
      : 'Could not detect any speech in this video.');
  }

  // Speaker baseline (over speech only) for emphasis scoring.
  const speechDb = [];
  for (let h = 0; h < hops; h++) if (isSpeech[h]) speechDb.push(db[h]);
  speechDb.sort((a, b) => a - b);
  const med = percentile(speechDb, 50);
  const spread = Math.max(2, percentile(speechDb, 85) - percentile(speechDb, 50));
  const totalDur = tOf(hops);
  const snap = makeSnapper(dbS, threshold, totalDur);

  // Candidate windows: contiguous runs of segments within [minLen, maxLen].
  // A window may only OPEN after / CLOSE before a STRONG pause (>= minBound):
  // any 250ms gap is just a breath mid-sentence, and cutting there is exactly
  // the "starts/ends in the wrong place" complaint. The bound adapts downward
  // for fast talkers who rarely leave long pauses.
  const beforePauseOf = (k) => (k > 0 ? segs[k].s - segs[k - 1].e : Math.min(1, segs[k].s));
  const afterPauseOf = (k) => (k < segs.length - 1 ? segs[k + 1].s - segs[k].e : Math.min(1, totalDur - segs[k].e));
  const genCandidates = (minBound) => {
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      if (beforePauseOf(i) < minBound) continue;
      let best = null;
      for (let j = i; j < segs.length; j++) {
        const start = segs[i].s, end = segs[j].e;
        const dur = end - start;
        if (dur > maxLen) break;
        if (dur < minLen) continue;
        if (!inKeep(start, end)) continue; // straddles a stretch the operator cut away
        const beforePause = beforePauseOf(i), afterPause = afterPauseOf(j);
        if (afterPause < minBound) continue; // window may still extend to a later j

        // Window loudness features (weighted by each segment's duration).
        let wSum = 0, wDur = 0, peak = -999, hSum = 0, hSum2 = 0, hCount = 0;
        for (let k = i; k <= j; k++) {
          const d = segs[k].e - segs[k].s;
          wSum += segs[k].meanDb * d; wDur += d;
          if (segs[k].maxDb > peak) peak = segs[k].maxDb;
          hSum += segs[k].sumDb; hSum2 += segs[k].sumDb2; hCount += segs[k].hopCount;
        }
        const meanDb = wSum / wDur;
        const speechRatio = wDur / dur; // 1 = all talking, <1 = has internal pauses

        const energyZ = (meanDb - med) / spread;
        const peakZ = (peak - med) / spread;
        // Fixed-length modes measure fit against the ALLOWED BAND so clips land NEAR
        // the chosen length (a 95s clip is "wrong" when you asked for 2 minutes); auto
        // keeps the loose, natural pull so lengths vary.
        const fitBand = opts.autoLen ? idealLen : Math.max(6, maxLen - idealLen);
        const durFit = clamp(1 - Math.abs(dur - idealLen) / fitBand, -1, 1);
        const pauseBonus = clamp((beforePause + afterPause) / 2, 0, 1);

        // "Viral" delivery features:
        // expressiveness — dynamic range within the window (monotone reads score low)
        const hMean = hSum / hCount;
        const exprStd = Math.sqrt(Math.max(0, hSum2 / hCount - hMean * hMean));
        const expr = clamp((exprStd - 3) / 5, 0, 1);
        // hook — does the window OPEN strong? (viewers decide in the first seconds)
        const hookZ = clamp((segs[i].headDb - med) / spread, -1, 1.5);
        // avoid the very start of the RECORDING (greetings/announcements). If the
        // operator already trimmed past that themselves, the first seconds of what
        // they kept are the sermon's opening line — penalising it would throw away
        // the exact moment they trimmed to.
        const posAdj = (OFF < 1 && start < totalDur * 0.04) ? -0.3 : 0;

        // With "auto" length we relax the duration-fit pull so clips settle at their
        // natural pause-bounded length; fixed modes pull HARD so the length is honored.
        const durW = opts.autoLen ? 0.25 : 0.9;
        const score = 1.0 * energyZ + 0.5 * peakZ + durW * durFit + 0.5 * speechRatio +
          0.3 * pauseBonus + 0.35 * expr + 0.3 * hookZ + posAdj;

        if (!best || score > best.score) best = { start, end, dur, score, meanDb, peak, speechRatio, expr, hookZ, pauseBonus };
      }
      if (best) out.push(best);
    }
    return out;
  };
  let candidates = [];
  for (const bound of [0.7, 0.5, 0.35, 0.2, 0]) {
    candidates = genCandidates(bound);
    if (candidates.length >= maxClips * 2) break;
  }
  report(85);

  candidates.sort((a, b) => b.score - a.score);
  const minGap = 8;
  let picked;
  const meta2 = {};
  let contentUsed = false;
  let editorUsed = false;
  let judgeUsed = false;

  /*
   * ►► PLANNED FROM THE WHOLE SERMON (shortplan.js), when a strong reader is on. ◄◄
   * Every word is heard, and the reader marks where each thought starts and
   * where its point lands — so a strong point said quietly is not missed and
   * no short opens on "Huh? Oh yes". If it cannot (no answer, too little
   * speech), the loudness scan below runs exactly as it always did.
   */
  let planned = null;
  if (opts.transcribeRange && opts.contentAware !== false && opts.judge && typeof opts.judge.plan === 'function' && !keep.length) {
    try { planned = await planWholeSermon(opts, { totalDur, OFF, snap, minLen, maxLen, idealLen, maxClips }); }
    catch (e) { if (jobs.isCancelError(e)) throw e; planned = null; }
    if (planned) meta2.planned = planned.meta;
  }
  if (planned) {
    picked = planned.picked;
    contentUsed = true; editorUsed = true; judgeUsed = true;
  } else if (opts.transcribeRange && opts.contentAware !== false && candidates.length) {
    // STAGE 2 — content-aware, human-like: transcribe a coverage-spread pool of the
    // best audio candidates, SNAP each to complete-sentence boundaries (clean start
    // /finish), score what's actually SAID, then re-select for coverage.
    // The pool is BIGGER than the number of clips asked for, so the editor scorer
    // gets to read moments the loudness ranking alone would have discarded (loud
    // is not the same as important) and can throw a candidate away outright — a
    // whisper loop over the singing, a passage whose thought will not close inside
    // the length budget — without leaving the operator short. Every extra
    // candidate is extra audio through whisper, so the margin is six, not sixty:
    // the quality comes from HOW the words are scored, not from reading more.
    // Long-clip modes transcribe much more audio per window — a smaller floor
    // there keeps a 2-minute scan from taking twice as long as a 1-minute one.
    const poolFloor = idealLen >= 90 ? 10 : 12;
    const poolSize = Math.min(opts.poolSize || Math.max(maxClips + 6, poolFloor), candidates.length);
    const pool = selectWithCoverage(candidates, { maxClips: poolSize, minGap: 4, totalDur, scoreKey: 'score' });
    const aMax = Math.max(0.001, ...pool.map((c) => c.score));
    // HOW FAR EITHER SIDE OF THE LOUD BIT TO READ. This is a hard ceiling on how
    // good the cut can be: the editor below can only move an edge to a sentence
    // it has actually been shown. With the old 6-second pad, a clip that stopped
    // one line short of the payoff had no way to reach it — the words simply were
    // not there. So read forward far enough to run the clip out to maxLen, and
    // back far enough to find where the thought started. Forward matters most
    // (endings are what get cut short), and the merge below means neighbouring
    // candidates still share the audio rather than paying for it twice.
    const PAD_BACK = clamp(maxLen * 0.13, 8, 18);
    const PAD_FWD = clamp(maxLen * 0.25, 12, 30);

    // MERGE the padded candidate windows into REGIONS: audio shared between nearby
    // candidates is transcribed ONCE (not once per candidate), and the bigger spans
    // are far more reusable by the disk cache on the next run/length-mode.
    const padded = pool.map((c) => [Math.max(0, c.start - PAD_BACK), Math.min(totalDur, c.end + PAD_FWD)]);
    const regions = [];
    for (const r of padded.slice().sort((a, b) => a[0] - b[0])) {
      const last = regions[regions.length - 1];
      if (last && r[0] <= last[1] + 2) last[1] = Math.max(last[1], r[1]);
      else regions.push([r[0], r[1]]);
    }
    // …but never hand whisper one enormous span. Punctuation is what the sentence
    // logic runs on, and whisper stops producing it on a long call: measured on a
    // real service, a 110-second span came back with 19 full stops and proper
    // capitals, while a 12-minute span came back as one unbroken lower-case run
    // with none — from the same model, same settings. Where candidates cluster
    // and their regions merge, the region is therefore read in equal pieces no
    // longer than this. (Regions stay whole for the lookup below, so a candidate's
    // padded window is still contained by exactly one of them.)
    const MAX_SPAN = 240;
    const parts = [];
    regions.forEach(([s0, e0], ri) => {
      const n = Math.max(1, Math.ceil((e0 - s0) / MAX_SPAN));
      const step = (e0 - s0) / n;
      for (let k = 0; k < n; k++) parts.push({ ri, from: s0 + k * step, to: k === n - 1 ? e0 : s0 + (k + 1) * step });
    });
    // Transcribe CONCURRENTLY (opts.concurrency workers; 1 on small CPUs — whisper
    // already saturates those). Progress owns 42%..98% of the bar, weighted by
    // duration so the bar moves at a steady real pace.
    mark('audio stage done, transcribing ' + parts.length + ' pieces, ' + Math.round(parts.reduce((a, p) => a + p.to - p.from, 0)) + ' s of audio');
    const regionSegs = new Array(regions.length).fill(null);
    const totalRegionDur = Math.max(1, regions.reduce((a, [s0, e0]) => a + (e0 - s0), 0));
    const CONC = Math.max(1, Math.min(4, opts.concurrency || 1));
    let nextIdx = 0, doneDur = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, parts.length) }, async () => {
      for (;;) {
        jobs.throwIfCancelled(); // the user hit Cancel — stop between windows, don't grind through the rest
        const i = nextIdx++; if (i >= parts.length) return;
        const { ri, from, to } = parts[i];
        let segs = [];
        try {
          // whisper reads the ORIGINAL file, so the range it is handed is in the
          // source's clock; the words come back relative to it and are put back
          // on the local clock below.
          const r = await opts.transcribeRange(from + OFF, to + OFF);
          const raw = (r && r.segs) || (Array.isArray(r) ? r : []);
          segs = raw.map((w) => ({ start: w.start + from, end: w.end + from, text: w.text }));
        } catch (e) {
          if (jobs.isCancelError(e)) throw e;
          /* this piece stays empty; its candidates fall back to what the rest gave */
        }
        regionSegs[ri] = (regionSegs[ri] || []).concat(segs);
        doneDur += to - from;
        if (opts.onProgress) opts.onProgress(42 + Math.round((doneDur / totalRegionDur) * 56));
      }
    }));
    mark('transcribed');
    for (const s of regionSegs) if (s) s.sort((a, b) => a.start - b.start);
    /** Choose the sentence run for a candidate out of the words it has so far.
     *  (Refined against a slightly tighter band than maxLen, so the acoustic snap
     *  below — which can legitimately move each cut outward to reach real
     *  silence — stays in bounds.) */
    const refineWith = (c, sents) => refineToSentences(c._win[0], c._win[1], sents, minLen,
      Math.max(minLen + 2, maxLen - 1.5), idealLen,
      { autoLen: !!opts.autoLen, room: { start: (t) => snap.startRoom(t), end: (t) => snap.endRoom(t) } });

    /** Put a chosen run onto a candidate: snap its edges into real silence, then
     *  record what the words say about how the clip reads. Used by the first pass
     *  and again by the "read further" retry below. */
    const applyRun = (c, refined, raw) => {
      if (refined) {
        // Whisper's sentence times jitter by a few hundred ms — never cut ON them.
        // Snap into the real pauses around the sentence run: open a beat before the
        // first word actually comes in, close after the last word fully rings out.
        c.start = snap.start(refined.start, 0.6, 0.5);
        c.end = snap.end(refined.end, 0.5, 0.9, 0.35, c.start + maxLen + 0.9);
        // both edges landed in real silence → this clip cuts perfectly; ones that
        // couldn't should lose their slot to ones that did
        c.acousticClean = snap.startOk(refined.start) && snap.endOk(refined.end);
        c.sentsArr = refined.sents;
        c.nextSent = refined.next;
        c.text = refined.sents.map((x) => x.text).join(' ');
        c.cleanCut = true;
      } else {
        // (strip whisper noise tokens here too — buildSentences does it for the clean path)
        c.text = raw.map((x) => x.text).join(' ').replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]+/g, ' ').replace(/\s+/g, ' ').trim();
        // still audio-bounded — at least make sure the cuts land in silence
        c.acousticClean = snap.startOk(c.start, 0.4, 0.3) && snap.endOk(c.end, 0.3, 0.4);
        c.start = snap.start(c.start, 0.4, 0.3, 0.2);
        c.end = snap.end(c.end, 0.3, 0.4, 0.28);
      }
      c.contentScore = contentScoreV2(c.text, c.sentsArr);
      // How the clip's EDGES read now that the words are known. refineToSentences
      // has already moved them to the best place it could FIND; these say how good
      // that best place actually was, so a candidate whose thought simply cannot be
      // closed inside the length budget loses its slot to one that can.
      c.closer = c.sentsArr ? closerPenalty(c.sentsArr, c.nextSent) : 0.6;
      c.loop = loopiness(c.sentsArr || []);
      c.gap = transitionGap(c.sentsArr || []);
      c.junk = c.loop > 0.6;   // whisper looping on music/chanting — not a clip at all
      // content leads; delivery supports; a clean cut + a crowd that ERUPTED both
      // count — and a clip whose edges could NOT land in real silence is demoted
      // hard (a chopped word ruins a short no matter how good the words were)
      c.total = 1.0 * (c.score / aMax) + 1.7 * c.contentScore + (c.cleanCut ? 0.4 : 0)
        + (c.acousticClean ? 0.2 : -0.7) + Math.min(3, c.crowd || 0) * 0.15
        - 0.9 * c.closer - 2.0 * c.loop - (c.gap > 6 ? 1.0 : 0);
    };
    // Slice each candidate's padded window out of its region, then score it.
    for (const c of pool) {
      c._win = [c.start, c.end]; // the delivery-hot window, before the edges move
      const from = Math.max(0, c.start - PAD_BACK), to = Math.min(totalDur, c.end + PAD_FWD);
      const ri = regions.findIndex(([s0, e0]) => s0 <= from + 0.01 && e0 >= to - 0.01);
      const raw = ((ri >= 0 && regionSegs[ri]) || []).filter((g) => g.end > from && g.start < to);
      c._raw = raw; c._readTo = to;
      // congregation reaction markers (whisper tags them) BEFORE buildSentences strips them
      c.crowd = (raw.map((w) => w.text).join(' ').match(CROWD_RX) || []).length;
      const sents = buildSentences(raw);
      // refine against a slightly tighter band so the acoustic snap below (which can
      // legitimately move each cut outward to reach real silence) stays in-bounds
      const refined = refineWith(c, sents);
      applyRun(c, refined, raw);
    }

    // READ FURTHER WHERE THE ENDING STILL HANGS.
    //
    // The editor can only move an edge to a sentence it has actually been shown,
    // so when the thought finishes just PAST the window the clip comes back cut
    // short — which is the whole complaint this pass exists to answer. A real
    // clip stopped on "But you might have forgotten." because the line it was
    // building to ("Your inheritance is settled.") sat 47 seconds beyond the
    // window and simply was not in the transcript.
    //
    // Widening the pad for every candidate would pay for that reach on the many
    // clips that land perfectly well without it. Instead the ones that could NOT
    // find a landing ask for more audio and try again — on a real service that is
    // a handful of clips, not all of them. Capped so a badly-transcribed sermon
    // cannot turn this into a second full scan.
    // Asked for whenever the ending is merely SERVICEABLE rather than a real
    // landing, and there is length budget left to reach a better one — not only
    // when it is outright broken. "You are my leader." is grammatical, lands in
    // silence, and is still the wrong place to stop.
    const EXTRA_FWD = clamp(maxLen * 0.45, 20, 60);
    const hanging = pool
      .filter((c) => c.cleanCut && c.closer > -0.1 && c._readTo < totalDur - 2
        && (c.end - c.start) < maxLen - 12)
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);
    if (process.env.MW_SHORTS_DEBUG) {
      for (const c of pool) {
        console.error(`cand ${Math.round(c._win[0])}-${Math.round(c._win[1])} clean=${!!c.cleanCut}`
          + ` closer=${(c.closer || 0).toFixed(2)} dur=${Math.round(c.end - c.start)} readTo=${Math.round(c._readTo)}`
          + ` retry=${hanging.includes(c)}`);
      }
    }
    for (const c of hanging) {
      jobs.throwIfCancelled();
      const from = c._readTo, to = Math.min(totalDur, from + EXTRA_FWD);
      if (to - from < 2) continue;
      let extra = [];
      try {
        const r = await opts.transcribeRange(from + OFF, to + OFF);
        extra = ((r && r.segs) || []).map((w) => ({ start: w.start + from, end: w.end + from, text: w.text }));
      } catch (e) {
        if (jobs.isCancelError(e)) throw e;
        continue;
      }
      if (!extra.length) continue;
      const raw = c._raw.concat(extra);
      const refined = refineWith(c, buildSentences(raw));
      // Only take the longer read if it genuinely closes the thought better —
      // otherwise the clip keeps the cut it already had.
      if (process.env.MW_SHORTS_DEBUG) {
        console.error(`retry ${Math.round(c._win[0])}-${Math.round(c._win[1])} read+${Math.round(to - from)}s closer ${c.closer.toFixed(2)}`
          + ` -> ${refined ? closerPenalty(refined.sents, refined.next).toFixed(2) : 'none'}`);
      }
      if (refined && closerPenalty(refined.sents, refined.next) < c.closer - 0.05) {
        c.start = c._win[0]; c.end = c._win[1];
        c._raw = raw; c._readTo = to;
        c.crowd = (raw.map((w) => w.text).join(' ').match(CROWD_RX) || []).length;
        applyRun(c, refined, raw);
      }
    }
    // STAGE 2b — LET A READING MODEL MOVE THE ENDING, when the operator turned
    // one on (opts.judge; see llmjudge.js). Nothing above this line can tell a
    // dramatic pause from a finished thought — "But you might have forgotten."
    // is short, declarative and full-stopped, so every acoustic and grammatical
    // test calls it a clean landing when it is plainly a setup. A model that
    // reads the sentence can see the difference.
    //
    // It runs HERE, before the editor pass, and that ordering is load-bearing:
    // applyRun rebuilds c.total from the base terms, so moving an ending after
    // scoreLikeAnEditor would silently throw the editor score away. Doing it
    // first also means a clip whose ending got fixed is then scored and selected
    // on its NEW words, which is the whole point of fixing it.
    //
    // Bounded work: only the candidates most likely to be picked, ordered by how
    // unsure the rules engine was about the ending (c.closer), and each is one
    // llama-cli run.
    mark('read-further done');
    if (opts.judge) {
      const order = pool
        .filter((c) => c.cleanCut && c._raw && c.sentsArr && c.sentsArr.length)
        .sort((a, b) => (b.total || 0) - (a.total || 0))
        .slice(0, Math.max(maxClips, opts.judge.endingScope || 8))
        .sort((a, b) => (b.closer || 0) - (a.closer || 0))
        .slice(0, opts.judge.maxEndingCalls || 12);
      // a small model has to be kept to a short list; a large one can weigh more
      const MAX_OFFER = Math.max(2, opts.judge.maxOffer || 8);
      // The questions are worked out first and ASKED together (opts.judge.parallel
      // at a time): a hosted model answers four as fast as one, and thirty asked
      // one after another was the longest wait in a cloud scan.
      const asks = [];
      for (const c of order) {
        jobs.throwIfCancelled();
        const sents = buildSentences(c._raw);
        if (!sents.length) continue;
        // Where this clip opens, in the rebuilt sentence list. Whisper times
        // jitter, so match on the text and fall back to the nearest start.
        const first = c.sentsArr[0];
        const last = c.sentsArr[c.sentsArr.length - 1];
        let si = sents.findIndex((s) => s.text === first.text && Math.abs(s.start - first.start) < 1.5);
        if (si < 0) si = sents.findIndex((s) => s.text === first.text);
        if (si < 0) continue;
        // Every sentence this clip could legally end on, at this length setting.
        const ends = [];
        for (let j = si; j < sents.length; j++) {
          const d = sents[j].end - sents[si].start;
          if (d > maxLen) break;
          if (d < minLen) continue;
          ends.push({ i: j, text: sents[j].text });
        }
        if (ends.length < 2) continue;
        let ci = ends.findIndex((o) => sents[o.i].text === last.text);
        if (ci < 0) ci = ends.findIndex((o) => sents[o.i].end >= c.end - 1.5);
        // Keep the list short enough for a small model to hold: the cut it made,
        // a couple of earlier options, and the ones it might have stopped short of.
        let offer = ends;
        if (ends.length > MAX_OFFER) {
          const from = Math.max(0, (ci < 0 ? 0 : ci) - 2);
          offer = ends.slice(from, from + MAX_OFFER);
        }
        if (offer.length < 2) continue;
        const chosen = ci >= 0 ? ends[ci].i : null;
        asks.push({ c, sents, si, chosen, offer,
          opening: (c.sentsArr.slice(0, 2).map((s) => s.text).join(' ') || c.text || '') });
      }
      const answers = new Array(asks.length);
      const PAR = Math.max(1, Math.min(6, opts.judge.parallel || 1));
      let nextAsk = 0;
      await Promise.all(Array.from({ length: Math.min(PAR, asks.length) }, async () => {
        for (;;) {
          jobs.throwIfCancelled();
          const k = nextAsk++;
          if (k >= asks.length) return;
          const a = asks[k];
          answers[k] = await opts.judge.ending({ opening: a.opening, chosen: a.chosen, options: a.offer });
        }
      }));
      asks.forEach((a, k) => {
        const r = answers[k];
        if (!r || !r.changed) return;
        const run = a.sents.slice(a.si, r.i + 1);
        if (!run.length) return;
        applyRun(a.c, {
          start: a.sents[a.si].start, end: a.sents[r.i].end,
          sents: run, next: a.sents[r.i + 1] || null,
        }, a.c._raw);
        a.c.endingByAi = true;
        judgeUsed = true;
      });
    }
    // STAGE 3 — the EDITOR pass, on-device and free. Now that every pooled
    // candidate has real words, judge them against each OTHER the way a human
    // shorts editor would: does it open without leaning on something the viewer
    // never heard, does it stay on one subject, is it distinctive rather than
    // filler, does it land a payoff. This needs the whole pool at once (the
    // distinctiveness measure is relative), so it runs after the loop.
    mark('endings judged');
    scoreLikeAnEditor(pool);
    editorUsed = true;
    // STAGE 3b — and let the reading model rank the pool it produced. This one
    // runs BEFORE selection precisely so it can change which clips get picked,
    // not merely what order they are listed in. One call for the whole pool: the
    // model reload dominates a prompt this size, so twenty separate questions
    // would cost far more than one with twenty parts.
    //
    // Weighted, not obeyed. c.total runs ~0..4 off terms that were each measured
    // against real services; a 0..10 opinion is folded in at a size that can move
    // a clip several places without being able to overrule the whole engine.
    if (opts.judge) {
      const rankable = pool.filter((c) => c.text && c.sentsArr && c.sentsArr.length);
      if (rankable.length >= 2) {
        const scores = await opts.judge.rank({
          clips: rankable.map((c, i) => ({
            id: i + 1,
            opening: c.sentsArr.slice(0, 2).map((s) => s.text).join(' '),
            ending: c.sentsArr.slice(-2).map((s) => s.text).join(' '),
            text: opts.judge.fullText ? c.text : undefined,
          })),
        });
        if (scores) {
          rankable.forEach((c, i) => {
            const v = scores.get(String(i + 1));
            if (v == null) return;
            c.aiScore = v;
            c.total += (opts.judge.rankWeight || LLM_RANK_W) * ((v / 10) * 2 - 1);
          });
          judgeUsed = true;
        }
      }
    }
    // Clips that are not clips (a whisper loop over the singing) are kept out of
    // the running entirely rather than merely marked down — coverage selection
    // would otherwise hand one a slot for being the only thing in its stretch of
    // the service. They come back only if excluding them would leave the operator
    // short of the number of clips they asked for.
    // A STRONG reader may also say "this is not a short at all" — and is
    // believed. Measured on a prayer stretch of "Time of Prayers": with every
    // slot filled regardless, half the set was "God bless you" three times and
    // tongues transcribed as English. Fewer clips that stand up beat a full
    // panel of filler, so what it rejects is not used to top the set up either.
    // (The PC's small reader never gets this power: it is wrong too often.)
    const rejectBelow = opts.judge && opts.judge.rejectBelow != null ? opts.judge.rejectBelow : null;
    let aiRejected = 0;
    for (const c of pool) {
      c.aiReject = rejectBelow != null && c.aiScore != null && c.aiScore <= rejectBelow;
      if (c.aiReject) aiRejected++;
    }
    meta2.aiRejected = aiRejected;
    if (process.env.MW_SHORTS_DEBUG) {
      for (const c of pool) console.error(`pool ${Math.round(c.start)}-${Math.round(c.end)} total=${(c.total || 0).toFixed(2)} ai=${c.aiScore} junk=${!!c.junk} reject=${!!c.aiReject} "${String(c.text || '').slice(0, 60)}"`);
    }
    mark('ranked');
    const usable = pool.filter((c) => !c.junk && !c.aiReject);
    picked = selectWithCoverage(usable, { maxClips, minGap, totalDur, scoreKey: 'total' });
    if (picked.length < maxClips && usable.length < pool.length) {
      // nothing better left anywhere in the pool — top the set up rather than come
      // back short, but never let a reject displace a clip that was already chosen
      for (const c of pool.filter((x) => x.junk && !x.aiReject).sort((a, b) => b.total - a.total)) {
        if (picked.length >= maxClips) break;
        if (picked.every((p) => (c.end + minGap <= p.start) || (c.start - minGap >= p.end))) picked.push(c);
      }
      picked.sort((a, b) => a.start - b.start);
    }
    // …but the strong reader is a HARSH critic (it scored a real sermon's
    // moments 1-6 out of 10), so its rejections may not leave the operator with
    // a near-empty panel: measured, a reject line at 2 kept 3 clips from twenty
    // minutes of preaching. At least 60% of the ask always comes back, its best
    // rejects first.
    const floor = Math.min(maxClips, Math.max(2, Math.ceil(maxClips * 0.6)));
    if (aiRejected && picked.length < floor) {
      for (const c of pool.filter((x) => x.aiReject && !x.junk).sort((a, b) => b.total - a.total)) {
        if (picked.length >= floor) break;
        if (picked.every((p) => (c.end + minGap <= p.start) || (c.start - minGap >= p.end))) { picked.push(c); meta2.aiRejected--; }
      }
      picked.sort((a, b) => a.start - b.start);
    }
    contentUsed = true;
  } else {
    // Audio-only: coverage-aware selection so no section is missed.
    picked = selectWithCoverage(candidates, { maxClips, minGap, totalDur, scoreKey: 'score' });
    // Window edges sit exactly ON the threshold crossing — i.e. on the first/last
    // word. Snap each cut into the adjacent pause: a short lead-in before the
    // voice starts, and room for the last word to ring out.
    for (const c of picked) {
      c.start = snap.start(c.start, 0.4, 0.3, 0.2);
      c.end = snap.end(c.end, 0.3, 0.4, 0.28);
    }
  }
  if (opts.onProgress) opts.onProgress(100);

  const aTop = Math.max(0.001, ...picked.map((c) => c.score));
  // Snapping can nudge a cut a beat outside the searched span — pull it back, or
  // an export would start before the trim the operator set.
  const lo = 0, hi = totalDur;
  for (const c of picked) { c.start = clamp(c.start, lo, hi); c.end = clamp(c.end, c.start + 0.5, hi); }
  // The badge ranks clips against EACH OTHER (see viralityAndReasons), so the
  // spread of the chosen set has to be measured before any of them is scored.
  const cAll = picked.map((c) => c.contentScore || 0);
  const eAll = picked.map((c) => c.editorScore || 0);
  const norm = picked.length > 1 ? {
    cMin: Math.min(...cAll), cMax: Math.max(...cAll),
    eMin: Math.min(...eAll), eMax: Math.max(...eAll),
  } : null;
  // TITLES, from the model that read the clip. `titleFromClip` picks the
  // hookiest sentence and truncates it at a phrase boundary, which is the best a
  // rules engine can do and still reads as a chopped sentence rather than a
  // title. One batched call writes them all; anything the model returns that is
  // not grounded in what was actually said is dropped by llmjudge, and those
  // clips keep the local title — so a half-usable answer still improves half the
  // panel and a useless one changes nothing.
  let aiTitles = null;
  if (opts.judge && contentUsed) {
    const titleable = picked.filter((c) => c.text && !c.aiTitle);   // a planned short already has its title
    if (titleable.length) {
      aiTitles = await opts.judge.titles({
        clips: titleable.map((c, i) => ({ id: i + 1, text: c.text })),
      });
      if (aiTitles) {
        titleable.forEach((c, i) => {
          const t = aiTitles.get(String(i + 1));
          if (t) { c.aiTitle = t; judgeUsed = true; }
        });
      }
    }
  }

  const clips = picked.map((c, idx) => {
    const vr = viralityAndReasons(c, aTop, contentUsed, norm);
    return {
      // back onto the SOURCE's clock: every export cuts from the original file
      start: Math.max(0, Math.round((c.start + OFF) * 10) / 10),
      end: Math.round((c.end + OFF) * 10) / 10,
      durationSec: Math.round((c.end - c.start) * 10) / 10,
      score: Math.round((c.total != null ? c.total : c.score) * 100) / 100,
      rank: idx + 1,
      // the Claude editor's title wins when it rated this clip; otherwise the
      // local hookiest-sentence title
      label: c.aiTitle || (c.text ? titleFromClip(c, idx) : `Key moment ${idx + 1}`),
      quote: c.text ? c.text.replace(/\s+/g, ' ').trim().slice(0, 110) : undefined,
      // the whole of what is said (the card shows `quote`); lets a run be read back in full
      text: c.text ? c.text.replace(/\s+/g, ' ').trim() : undefined,
      cleanCut: !!c.cleanCut,
      aiScore: c.aiScore != null ? c.aiScore : undefined,
      // the reader's one line on what this short is about (planned shorts)
      point: c.point || undefined,
      virality: vr.virality,
      reasons: vr.reasons,
    };
  });

  return {
    clips,
    meta: {
      durationSec: Math.round(totalDur),
      // the stretch of the SOURCE that was actually searched
      searchedFrom: Math.round(OFF * 10) / 10,
      searchedTo: Math.round((OFF + totalDur) * 10) / 10,
      segments: segs.length,
      contentAware: contentUsed,
      editorPass: editorUsed,
      // What the reading model actually did, so the UI can say so honestly
      // rather than claiming an AI pass that silently no-opped.
      aiPass: judgeUsed,
      aiStats: opts.judge ? opts.judge.stats : null,
      aiModel: opts.judge ? opts.judge.modelName : null,
      // clips the strong reader judged not to be shorts at all, and left out
      aiRejected: meta2.aiRejected || 0,
      // planned from the whole sermon: how many sections were read, moments found
      planned: meta2.planned || null,
      thresholdDb: Math.round(threshold * 10) / 10,
      baselineDb: Math.round(med * 10) / 10,
    },
  };
}

/**
 * Hear the whole sermon (in pieces no longer than 240 s — punctuation survives
 * a short call, not a long one), build its sentences, and let the reader plan
 * the shorts. Returns { picked, meta } or null.
 */
async function planWholeSermon(opts, { totalDur, OFF, snap, minLen, maxLen, idealLen, maxClips }) {
  const MAX_SPAN = 240;
  const n = Math.max(1, Math.ceil(totalDur / MAX_SPAN));
  const step = totalDur / n;
  const parts = Array.from({ length: n }, (_, k) => ({ from: k * step, to: k === n - 1 ? totalDur : (k + 1) * step }));
  const got = new Array(n).fill(null);
  const CONC = Math.max(1, Math.min(4, opts.concurrency || 1));
  let next = 0, done = 0, missing = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, n) }, async () => {
    for (;;) {
      jobs.throwIfCancelled();
      const k = next++; if (k >= n) return;
      const { from, to } = parts[k];
      try {
        const r = await opts.transcribeRange(from + OFF, to + OFF);
        got[k] = ((r && r.segs) || []).map((w) => ({ start: w.start + from, end: w.end + from, text: w.text }));
      } catch (e) { if (jobs.isCancelError(e)) throw e; got[k] = []; missing++; }
      done++;
      if (opts.onProgress) opts.onProgress(42 + Math.round((done / n) * 38));
    }
  }));
  // a sermon half of which was never heard cannot be planned honestly
  if (missing > n / 4) return null;
  const sents = buildSentences([].concat(...got).sort((a, b) => a.start - b.start));
  const res = await opts.judge.plan({
    sents, minLen, maxLen, idealLen, maxClips,
    onProgress: (f) => { if (opts.onProgress) opts.onProgress(80 + Math.round(f * 18)); },
  });
  if (!res || !res.moments || res.moments.length < Math.min(3, maxClips)) return null;
  const picked = res.moments.map((m) => {
    const start = snap.start(m.start, 0.6, 0.5);
    const end = snap.end(m.end, 0.5, 0.9, 0.35, start + maxLen + 6);
    return {
      start, end, score: m.strength, total: m.strength, aiScore: m.strength,
      text: m.text, sentsArr: m.sents, cleanCut: true, acousticClean: snap.startOk(m.start) && snap.endOk(m.end),
      aiTitle: m.title || undefined, point: m.point,
      contentScore: contentScoreV2(m.text, m.sents),
    };
  });
  return { picked, meta: { sections: res.sections, found: res.found, failed: res.failed, sentences: sents.length } };
}

/** Make a short human label from the clip's transcript (first few meaningful words). */
function labelFromText(text, idx) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return `Key moment ${idx + 1}`;
  const w = clean.split(' ').slice(0, 6).join(' ');
  return (w.charAt(0).toUpperCase() + w.slice(1)).replace(/[.,!?]+$/, '') + '…';
}

/**
 * Title: the clip's HOOKIEST sentence — a question, a declaration, direct
 * address — rather than whatever words happen to come first.
 *
 * A title must READ as a title. Real output from a 48-minute service included
 * "I was watching, I was hearing all of…" and "Are you listening to the, never
 * lose, or…": both were mid-sentence fragments chopped at a word count. So a
 * candidate sentence is now REJECTED for opening like a fragment, PREFERRED
 * when it fits whole, and only truncated at a phrase boundary (a comma or
 * clause) instead of mid-thought.
 */
function titleFromClip(c, idx) {
  const sents = c.sentsArr || [];
  const powerI = new RegExp(POWER_RX.source, 'i');
  let best = null;
  for (const s of sents) {
    const t = s.text.trim(); if (!t) continue;
    const lower = t.toLowerCase();
    const wc = t.split(/\s+/).length;
    let sc = 0;
    if (powerI.test(lower)) sc += 2;
    if (HOOK_PHRASES.some((p) => lower.includes(p))) sc += 1.2;
    if (/\?["')\]]?$/.test(t)) sc += 1.5;                    // a question makes a great title
    if (IMPERATIVE_RX.test(lower)) sc += 1;
    if (wc >= 4 && wc <= 12) sc += 0.8; else if (wc > 20) sc -= 0.6;
    // A title that opens mid-thought reads as broken even when the clip is good.
    sc -= 1.6 * openerPenalty([s], t);
    // Whole sentences that already fit make the best titles — no ellipsis at all.
    if (wc <= 9 && /[.!?]["')\]]?$/.test(t)) sc += 0.7;
    if (!best || sc > best.sc) best = { t, sc };
  }
  const src = (best && best.sc > 0.8) ? best.t : (c.text || '');
  const clean = src.replace(/\s+/g, ' ').trim();
  if (!clean) return `Key moment ${idx + 1}`;
  const words = clean.split(' ');
  const cap = (s) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/[.,;:]+$/, '');
  if (words.length <= 9) return cap(clean).replace(/[.!?]+$/, '');
  // Too long: cut at the last phrase boundary inside the budget rather than
  // mid-phrase, so the ellipsis lands somewhere a reader can rest.
  const head = words.slice(0, 9).join(' ');
  const brk = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf(' — '));
  const cut = (brk > 12 ? head.slice(0, brk) : words.slice(0, 7).join(' '));
  return cap(cut) + '…';
}

/**
 * 0–100 "viral potential" + plain-English reasons for the card.
 *
 * `norm` (the min/max of the chosen set) is what stops the badge saturating.
 * Judged on absolute thresholds, a real 48-minute service produced nine clips
 * scoring 97-99 — a badge that says 99 about more than half the panel is not
 * ranking anything. The content and editor terms are therefore scored by where
 * the clip sits WITHIN this set, which is the only comparison the operator is
 * actually making when they look down the list.
 */
function viralityAndReasons(c, aTop, contentUsed, norm) {
  const audio = clamp(c.score / aTop, 0, 1);
  const reasons = [];
  // position of `v` between lo and hi, defaulting to the middle when the set is
  // uniform (nothing to tell apart) or when no set was supplied
  const rel = (v, lo, hi) => (hi - lo > 1e-6 ? clamp((v - lo) / (hi - lo), 0, 1) : 0.5);
  let v;
  if (contentUsed && c.text) {
    const t = c.text.toLowerCase();
    const content = norm ? rel(c.contentScore || 0, norm.cMin, norm.cMax) : clamp((c.contentScore || 0) / 3.2, 0, 1);
    const power = (t.match(POWER_RX) || []).length;
    const first = (c.sentsArr && c.sentsArr[0] ? c.sentsArr[0].text : c.text.split(/[.!?]/)[0] || '').toLowerCase();
    const hooky = HOOK_PHRASES.some((p) => first.includes(p)) || /\?\s*$/.test(first.trim())
      || IMPERATIVE_RX.test(first) || new RegExp(POWER_RX.source, 'i').test(first);
    const q = (c.text.match(/\?/g) || []).length;
    v = 40 + 26 * content + 16 * audio + (hooky ? 4 : 0) + Math.min(3, c.crowd || 0) * 2 + (c.cleanCut ? 3 : 0);
    // The editor pass read the actual words — fold its verdict into the badge
    // and say, in plain English, what it liked.
    const ed = c.editor;
    if (ed) {
      v += 16 * (norm ? rel(c.editorScore || 0, norm.eMin, norm.eMax) : clamp((c.editorScore || 0) / 2.2, 0, 1));
      const danglingClip = ed.dangling >= 0.6;
      if (danglingClip) reasons.push('Starts mid-thought — needs a trim');
      else if (ed.quotable >= 0.7) reasons.push('Has a quotable line');
      // The counterpart complaint, and the one people actually notice: the clip
      // stops before the line it was building to.
      if (ed.closing >= 0.55) reasons.push('Ends before the thought lands');
      else if (ed.closing <= -0.2) reasons.push('Finishes on a clean landing');
      if (ed.straddles > 6) reasons.push('Runs through a break in the service');
      if (ed.anaphora >= 1) reasons.push('Builds with repetition');
      if (ed.cohesion >= 0.8 && ed.terms >= 3) reasons.push('Stays on one point');
      // relative, not absolute — see the note on `norm` above
      if (ed.distinctRank != null ? ed.distinctRank >= 0.75 : ed.distinct >= 0.7) reasons.push('Says something distinctive');
      if (ed.reading >= 0.7) reasons.push('Mostly scripture reading');
      // never claim a strong opening for a clip we just called mid-thought
      if (hooky && !danglingClip) reasons.push('Opens with a hook');
    } else if (hooky) reasons.push('Opens with a hook');
    if (power >= 2) reasons.push('Spirit-filled declarations');
    if ((c.crowd || 0) > 0) reasons.push('Congregation reacted');
    if (q >= 2) reasons.push('Speaks straight to the viewer');
    if (audio > 0.75) reasons.push('High-energy delivery');
    if (c.cleanCut) reasons.push('Clean sentence start & finish');
  } else {
    v = 40 + 44 * audio + 8 * clamp(c.expr || 0, 0, 1) + 6 * clamp(c.hookZ || 0, 0, 1);
    if ((c.hookZ || 0) > 0.5) reasons.push('Strong opening');
    if ((c.expr || 0) > 0.5) reasons.push('Animated, expressive delivery');
    if (audio > 0.75) reasons.push('High-energy delivery');
    if ((c.pauseBonus || 0) > 0.7) reasons.push('Cuts cleanly at natural pauses');
  }
  if (!reasons.length) reasons.push('Elevated delivery vs the rest of the sermon');
  return { virality: Math.max(35, Math.min(99, Math.round(v))), reasons: reasons.slice(0, 3) };
}

module.exports = { analyzeSermon, contentScore, contentScoreV2, buildSentences, refineToSentences, selectWithCoverage, titleFromClip, viralityAndReasons,
  scoreLikeAnEditor, openerPenalty, closerPenalty, loopiness, transitionGap, topicSeam, cohesion, anaphora, quotableLine, readingAloud,
  _internals: { buildEnvelope, extractPcm, extractEnvelope, pauseWindows, makeSnapper, SR, HOP } };
