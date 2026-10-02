'use strict';
/*
 * 🤫 REMOVE PAUSES BY THE WORDS — the decision, pinned without a network or a hall.
 *
 * src/main/pauses.js decides where the pauses are from two things: where the
 * words are (Groq's word timings) and how loud this preacher is. These cases
 * are the ones that made silencedetect wrong on the real sermon (measured
 * 2026-10-01): it cut into 3 soft words in one 90 s stretch, and missed 2.6 s,
 * 2.4 s and 0.9 s pauses in another because the hall never went below -32 dB.
 *
 *   node test/remove-pauses.test.js
 */
const P = require('../src/main/pauses.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };

/* A 20 s clip at 50 ms a frame: room noise at `floor` dB, the voice at -20 dB
 * wherever a word is, plus whatever extra sounds a case adds. */
function envFor(words, { floor = -45, extra = [], from = 100, span = 20 } = {}) {
  const fs = 0.05, n = Math.round(span / fs);
  const db = new Array(n).fill(floor);
  const put = (a, b, v) => { for (let k = Math.max(0, Math.floor((a - from) / fs)); k < Math.min(n, Math.ceil((b - from) / fs)); k++) db[k] = v; };
  for (const w of words) put(w.start, w.end, w.db != null ? w.db : -20);
  for (const x of extra) put(x.start, x.end, x.db);
  return { db, frameSec: fs, startSec: from };
}
const W = (text, start, end, db) => ({ text, start, end, db });
const run = (words, env, o) => P.speechPauses(words, env, Object.assign({ startSec: 100, endSec: 120 }, o || {}));

console.log('[1] Pauses between words');
{
  const words = [W('grace', 100.2, 100.7), W('is', 100.75, 100.9), W('free', 101.0, 101.5), W('but', 103.0, 103.3), W('it', 103.35, 103.5)];
  const r = run(words, envFor(words));
  check('a 1.5 s gap between words is cut, padded 0.12 s each side', r.silences.some((c) => Math.abs(c.start - 101.62) < 0.06 && Math.abs(c.end - 102.88) < 0.06), JSON.stringify(r.silences));
  check('…and the gaps between words in a phrase are not', !r.silences.some((c) => c.start < 101.5));
  check('the voice level is measured from the words', r.speechDb === -20, r.speechDb);
}

console.log('\n[2] A noisy hall: the room never drops below -32 dB');
{
  const words = [W('my', 100.5, 100.8), W('finances.', 100.9, 101.6), W('One', 104.2, 104.5)];
  const r = run(words, envFor(words, { floor: -36 }));
  check('the 2.6 s pause is still found (16 dB under the voice)', r.silences.some((c) => c.start < 102 && c.end > 103.8), JSON.stringify(r.silences));
}

console.log('\n[3] What is NOT a pause');
{
  const words = [W('amen', 100.5, 100.9), W('so', 104.0, 104.3)];
  const amen = [{ start: 101.2, end: 103.6, db: -22 }];              // the congregation answers
  const r = run(words, envFor(words, { extra: amen }));
  check('a congregation "Amen!" (as loud as the voice, with no words) is kept', !r.silences.some((c) => c.start < 103.5 && c.end > 101.3), JSON.stringify(r.silences));
}
{
  const words = [W('grace', 100.5, 101.0), W('and', 101.1, 101.4, -38), W('mercy', 101.5, 102.0)];  // a soft word
  const r = run(words, envFor(words));
  check('a soft word is never cut, however quiet', !r.silences.some((c) => c.start < 101.4 && c.end > 101.1), JSON.stringify(r.silences));
}
{
  const words = [W('grace', 100.5, 101.0), W('mercy', 101.5, 102.0)];
  const r = run(words, envFor(words));
  check('a half-second breath is left alone', !r.silences.some((c) => c.start > 100.9 && c.end < 101.6), JSON.stringify(r.silences));
}

console.log('\n[4] A pause hidden inside a word Whisper stretched');
{
  // "so" stamped 25.2–29.76 s on the real sermon: one syllable over four seconds.
  const words = [W('yeah', 100.5, 100.9), W('so', 101.0, 105.5), W('you', 105.6, 105.9)];
  const env = envFor([W('yeah', 100.5, 100.9), W('so', 101.0, 101.3), W('you', 105.6, 105.9)]);  // the voice only at its start
  const r = run(words, env);
  check('the quiet inside an over-long word is found and cut', r.silences.some((c) => c.start < 101.6 && c.end > 105.0), JSON.stringify(r.silences));
}
{
  const words = [W('soooo', 100.5, 101.6), W('good', 101.7, 102.0)];          // emphasis, loud throughout
  const r = run(words, envFor(words));
  check('…but a word dragged out for emphasis is not', r.silences.length === 0 || !r.silences.some((c) => c.start < 101.6 && c.end > 100.5), JSON.stringify(r.silences));
}

console.log('\n[5] Edges');
{
  const words = [W('grace', 100.5, 101.0), W('free', 103.0, 103.4)];
  const click = [{ start: 102.0, end: 102.1, db: -25 }];                      // a 0.1 s click mid-pause
  const r = run(words, envFor(words, { extra: click }));
  check('a click in the middle of a pause does not save it', r.silences.some((c) => c.start < 101.5 && c.end > 102.5), JSON.stringify(r.silences));
}
check('no words: nothing is cut (no voice to measure against)', run([], envFor([])).silences.length === 0);
check('a plausible word length grows with its letters', P.maxWordSec('a') === 0.9 && P.maxWordSec('everlasting') > 1.6);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
