'use strict';
/*
 * Deterministic tests for the transcript-driven "perfect start/finish" logic:
 * buildSentences (clean sentence splitting) + refineToSentences (snap a clip to
 * complete-sentence boundaries) + contentScoreV2 (human-like ranking). No whisper.
 * Run:  node test/highlights-boundaries.test.js
 */
const h = require('../src/main/highlights');
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

// A pool of whisper-style phrase chunks with punctuation + gaps.
const chunks = [
  { start: 0.0, end: 3.0, text: 'Good morning, church.' },
  { start: 3.5, end: 8.0, text: 'Today I want to talk about giving,' },
  { start: 8.0, end: 12.0, text: 'because giving changes everything.' },
  { start: 12.2, end: 18.0, text: 'When you give sacrificially, God sees your heart.' },
  { start: 18.1, end: 24.0, text: 'He will pour out a blessing you cannot contain.' },
  { start: 24.1, end: 28.0, text: 'Do you believe that?' },
  { start: 31.0, end: 36.0, text: 'Turn to your neighbor and say amen.' },
];

const sents = h.buildSentences(chunks);
// chunk "…giving," has no terminal punctuation and flows straight into
// "because giving changes everything." -> correctly ONE sentence, so 6 total.
check('splits the stream into complete sentences', sents.length === 6, sents.length + ' sentences');
check('mid-sentence comma phrase is joined, not split', /giving, because giving changes everything\.$/.test(sents[1].text), sents[1].text);
check('every sentence ends on terminal punctuation', sents.every((s) => /[.!?]["')\]]?$/.test(s.text)), sents.map((s) => s.text.slice(-1)).join(''));
check('the last sentence starts after the long silent gap', sents[5].start === 31.0, String(sents[5].start));

// Refine a delivery-hot window [12,24] to whole sentences.
const refined = h.refineToSentences(12, 24, sents, 8, 20, 14);
check('found a sentence-bounded clip for the hot window', !!refined);
if (refined) {
  const starts = sents.map((s) => s.start), ends = sents.map((s) => s.end);
  check('clip STARTS exactly on a sentence start (not mid-word)', starts.includes(refined.start), String(refined.start));
  check('clip ENDS exactly on a sentence end (not mid-word)', ends.includes(refined.end), String(refined.end));
  const dur = refined.end - refined.start;
  check('clip length within [8,20]s', dur >= 8 && dur <= 20, dur.toFixed(1) + 's');
  check('clip covers the passionate window', refined.start <= 12.5 && refined.end >= 23.5, `${refined.start}..${refined.end}`);
  check('clip is made of whole sentences', refined.sents.every((s) => /[.!?]["')\]]?$/.test(s.text)));
}

// AUTO LENGTH: the clip must settle at the thought's NATURAL length, not get
// padded out toward the ideal. Hot window covers one complete 24s thought; with
// a fixed-length pull (idealLen=45) the old scorer stretched into the next,
// unrelated sentence — autoLen must keep the tight, complete cut.
const alChunks = [
  { start: 0.0, end: 10.0, text: 'You have a marital issue?' },
  { start: 10.2, end: 18.0, text: 'Bring it to God, because He cares for you.' },
  { start: 18.1, end: 24.0, text: 'That is the mercy of God!' },
  { start: 27.0, end: 44.0, text: 'Now in the second chapter there is a long passage about the genealogy that goes on and on for a while.' },
];
const alSents = h.buildSentences(alChunks);
const auto = h.refineToSentences(0, 24, alSents, 15, 60, 45, { autoLen: true });
const fixed = h.refineToSentences(0, 24, alSents, 15, 60, 45, {});
check('autoLen keeps the NATURAL complete thought (ends at 24s)', auto && auto.end === 24.0, auto && `${auto.start}..${auto.end}`);
check('autoLen clip ends on a strong landing sentence', auto && /!$/.test(auto.sents[auto.sents.length - 1].text), auto && auto.sents[auto.sents.length - 1].text);
check('(control) fixed-length mode stretches toward the ideal', fixed && fixed.end === 44.0, fixed && `${fixed.start}..${fixed.end}`);

// Content ranking: a teaching passage must beat housekeeping/greetings.
const good = h.buildSentences([
  { start: 0, end: 6, text: 'When you give sacrificially, God sees your heart.' },
  { start: 6, end: 12, text: 'He will pour out a blessing you cannot contain.' },
  { start: 12, end: 16, text: 'Do you believe that?' },
]);
const admin = h.buildSentences([
  { start: 0, end: 3, text: 'Good morning, church.' },
  { start: 3, end: 7, text: 'Welcome to the service.' },
  { start: 7, end: 12, text: 'Download the app and fill out the card.' },
  { start: 12, end: 16, text: 'Next week we have announcements.' },
]);
const gScore = h.contentScoreV2(good.map((s) => s.text).join(' '), good);
const aScore = h.contentScoreV2(admin.map((s) => s.text).join(' '), admin);
console.log(`  teaching score=${gScore.toFixed(2)}  housekeeping score=${aScore.toFixed(2)}`);
check('a teaching/altar-call passage outranks housekeeping', gScore > aScore + 0.5, `${gScore.toFixed(2)} > ${aScore.toFixed(2)}`);
check('housekeeping is actively penalised (negative-ish)', aScore < gScore);

// SPIRIT-FILLED MOMENTS: prophetic/altar-call declarations must outrank plain
// narration — these are the "best parts" a church clips.
const spirit = h.buildSentences([
  { start: 0, end: 6, text: 'I decree and declare, this is your season of breakthrough!' },
  { start: 6, end: 12, text: 'Receive it in the name of Jesus!' },
  { start: 12, end: 16, text: 'Somebody shout hallelujah!' },
]);
const narrate = h.buildSentences([
  { start: 0, end: 6, text: 'So then we went to the store on Tuesday afternoon.' },
  { start: 6, end: 12, text: 'And the weather was quite nice that day as well.' },
  { start: 12, end: 16, text: 'We came back before it got dark outside.' },
]);
const sScore = h.contentScoreV2(spirit.map((s) => s.text).join(' '), spirit);
const nScore = h.contentScoreV2(narrate.map((s) => s.text).join(' '), narrate);
console.log(`  spirit-filled score=${sScore.toFixed(2)}  narration score=${nScore.toFixed(2)}`);
check('Spirit-filled declarations strongly outrank plain narration', sScore > nScore + 1.0, `${sScore.toFixed(2)} vs ${nScore.toFixed(2)}`);

// FIXED LENGTH PRECISION: with "1 minute" selected (40..80s band, ideal 60), the
// ~60s sentence-run must win over a much shorter clean run — the user asked for a
// minute, so deliver a minute (still on sentence edges).
const minChunks = [];
for (let i = 0; i < 7; i++) minChunks.push({ start: i * 12, end: i * 12 + 11.5, text: `Sentence number ${i + 1} of this passage carries the message forward faithfully.` });
const minSents = h.buildSentences(minChunks);
const oneMin = h.refineToSentences(0, 60, minSents, 40, 80, 60, {});
check('"1 minute" mode lands close to 60s (not a 40s stub)', oneMin && Math.abs((oneMin.end - oneMin.start) - 60, 0) <= 12, oneMin && `${(oneMin.end - oneMin.start).toFixed(1)}s`);
check('"1 minute" clip still starts/ends on sentence edges', oneMin && minSents.some((s) => s.start === oneMin.start) && minSents.some((s) => s.end === oneMin.end));

console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
process.exit(fail ? 1 : 0);
