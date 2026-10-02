'use strict';
/*
 * 🤫 REMOVE PAUSES, BY LISTENING FOR THE WORDS — "the option to use the API
 *    for the remove pauses".
 *
 * WHAT WAS WRONG WITH SILENCE
 *
 * Remove pauses used ffmpeg's silencedetect: anything quieter than -32 dB for
 * 0.7 s is a pause. A church hall is never that quiet — the PA hums, the room
 * rings, somebody shifts in a pew — so on the real sermon, measured:
 *
 *   • 600–690 s: it would have cut into 3 spoken words (a soft word is
 *     "silence" to a fixed threshold);
 *   • 1500–1590 s: it MISSED three real pauses of 2.6 s, 2.4 s and 0.9 s,
 *     because the room under them never dropped below -32 dB.
 *
 * Raising or lowering the threshold trades one failure for the other: there is
 * no single number that is right for every hall.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Two things a threshold cannot know:
 *
 *   1. WHERE THE WORDS ARE. Groq's full-size Whisper hands back every word with
 *      its time (the same request that makes the captions). A spoken word is
 *      never cut — that alone makes the first failure impossible.
 *   2. HOW LOUD THIS PREACHER IS. "Quiet" is judged against the median level of
 *      their own words in this clip, not against -32 dB. A pause in a noisy
 *      hall is still far quieter than the voice, so the second failure goes
 *      too.
 *
 * Where a pause can hide:
 *   • BETWEEN words — the obvious place;
 *   • INSIDE a word Whisper stretched across a breath. Its timestamps are
 *     decoder by-products and they smear: "so" was stamped 25.2–29.76 s, four
 *     and a half seconds for one syllable, with a real pause inside it. A word
 *     far longer than its letters could take is searched for quiet too.
 *
 * And what is NOT a pause, even with no words in it: anything as loud as the
 * voice — the congregation's "Amen!", a burst of music, a hand-clap. Those have
 * no words, but they are not dead air, so they stay.
 *
 * Pure apart from envelope(): the decision is arithmetic on two lists, which is
 * what lets test/remove-pauses.test.js pin it without a network or a hall.
 */
const { spawn } = require('child_process');

const FRAME_SEC = 0.05;

/**
 * The loudness of a stretch of a media file, as dB per 50 ms frame. One ffmpeg
 * decode to 16 kHz mono PCM, read straight off the pipe: 90 s of audio is
 * 2.9 MB and a few hundred milliseconds.
 */
function envelope(ffmpegPath, { input, startSec = 0, endSec, frameSec = FRAME_SEC, track } = {}) {
  const from = Math.max(0, +startSec || 0);
  const span = Math.max(0, (+endSec || 0) - from);
  const args = ['-v', 'error', ...(from > 0 ? ['-ss', String(from)] : []), ...(span > 0 ? ['-t', String(span)] : []),
    '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    if (track) track(proc);
    const per = Math.max(1, Math.round(16000 * frameSec));
    const db = [];
    let acc = 0, n = 0, carry = null, err = '';
    proc.stdout.on('data', (chunk) => {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = buf.length - (buf.length % 2);
      for (let i = 0; i < even; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        acc += v * v; n++;
        if (n === per) { db.push(10 * Math.log10(acc / n + 1e-12)); acc = 0; n = 0; }
      }
      carry = even < buf.length ? buf.slice(even) : null;
    });
    proc.stderr.on('data', (d) => { err += d.toString().slice(0, 300); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && !db.length) return reject(new Error('ffmpeg ' + code + ' ' + err.slice(-200)));
      if (n > per / 2) db.push(10 * Math.log10(acc / n + 1e-12));
      resolve({ db, frameSec, startSec: from });
    });
  });
}

/* How long one word can plausibly take to say. Generous on purpose: a word
 * dragged out for emphasis ("SOOOO good") must not be mistaken for a pause —
 * this only decides where to LOOK for quiet, never what to cut. */
const maxWordSec = (text) => {
  const letters = String(text || '').replace(/[^A-Za-z0-9]/g, '').length;
  return Math.max(0.9, 0.3 + letters * 0.14);
};

const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * The pauses in a clip, as cuts on the source's clock.
 *
 *   words    [{ text, start, end }] on the SOURCE clock (seconds)
 *   env      envelope() output for the same stretch
 *   opts     { startSec, endSec, minSilenceSec = 0.7, padSec = 0.12, quietDb = 14, minCutSec = 0.25 }
 *
 * Returns { silences: [{ start, end }], speechDb, quietBelowDb, removedSeconds }.
 */
function speechPauses(words, env, opts) {
  const o = Object.assign({ minSilenceSec: 0.7, padSec: 0.12, quietDb: 14, minCutSec: 0.25, blipSec: 0.15 }, opts || {});
  const from = +o.startSec || 0;
  const to = +o.endSec || from;
  const W = (words || []).filter((w) => w && w.end > w.start && w.end > from && w.start < to)
    .map((w) => ({ text: w.text, start: Math.max(from, +w.start), end: Math.min(to, +w.end) }))
    .sort((a, b) => a.start - b.start);
  const fs = env && env.frameSec ? env.frameSec : FRAME_SEC;
  const e0 = env ? (+env.startSec || 0) : from;
  const db = env && Array.isArray(env.db) ? env.db : [];
  const frameAt = (t) => Math.floor((t - e0) / fs);
  const timeOf = (k) => e0 + k * fs;

  // How loud the voice is, from the frames inside ordinary-length words.
  const normal = W.filter((w) => (w.end - w.start) <= maxWordSec(w.text));
  const voiced = [];
  for (const w of normal) for (let k = Math.max(0, frameAt(w.start)); k <= Math.min(db.length - 1, frameAt(w.end) - 1); k++) voiced.push(db[k]);
  const speechDb = median(voiced);
  if (speechDb == null || !W.length) return { silences: [], speechDb: null, quietBelowDb: null, removedSeconds: 0, words: W.length };
  const quietBelow = speechDb - o.quietDb;

  /* Where a pause may be looked for: every stretch no ordinary word covers.
   * Over-long words are NOT protection — that is where Whisper hides breaths. */
  const covered = normal.map((w) => [w.start, w.end]);
  const regions = [];
  let at = from;
  for (const [a, b] of covered) {
    if (a > at) regions.push([at, a]);
    at = Math.max(at, b);
  }
  if (to > at) regions.push([at, to]);

  const cuts = [];
  for (const [ra, rb] of regions) {
    if (rb - ra < o.minSilenceSec) continue;
    const k0 = Math.max(0, frameAt(ra)), k1 = Math.min(db.length, frameAt(rb));
    // Runs of quiet frames, forgiving a click or a cough up to blipSec long.
    let runStart = -1, lastQuiet = -1;
    const flush = () => {
      if (runStart < 0) return;
      const a = Math.max(ra, timeOf(runStart)), b = Math.min(rb, timeOf(lastQuiet + 1));
      if (b - a >= o.minSilenceSec) {
        const ca = a + o.padSec, cb = b - o.padSec;
        if (cb - ca >= o.minCutSec) cuts.push({ start: +ca.toFixed(3), end: +cb.toFixed(3) });
      }
      runStart = -1;
    };
    for (let k = k0; k < k1; k++) {
      const quiet = db[k] <= quietBelow;
      if (quiet) {
        if (runStart < 0) runStart = k;
        else if ((k - lastQuiet - 1) * fs > o.blipSec) { flush(); runStart = k; }
        lastQuiet = k;
      }
    }
    flush();
  }
  const merged = [];
  for (const c of cuts.sort((x, y) => x.start - y.start)) {
    const p = merged[merged.length - 1];
    if (p && c.start <= p.end + 0.01) p.end = Math.max(p.end, c.end); else merged.push(Object.assign({}, c));
  }
  return {
    silences: merged,
    speechDb: +speechDb.toFixed(1), quietBelowDb: +quietBelow.toFixed(1),
    removedSeconds: +merged.reduce((s, c) => s + (c.end - c.start), 0).toFixed(3),
    words: W.length,
  };
}

module.exports = { envelope, speechPauses, maxWordSec, FRAME_SEC };
