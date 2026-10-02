'use strict';
/*
 * ✍ THE CAPTION PROOF-READER, AND ☁️ THE CLOUD EAR'S SEAMS — no network, no Electron.
 *
 * Two promises are pinned here:
 *
 *  1. The rules fix what is plainly wrong and LEAVE ALONE what is merely
 *     unusual. A proof-reader that "corrects" a real sentence is worse than
 *     none, because the operator learns to click Fix without reading. So half
 *     of these checks are things that must NOT change.
 *  2. The AI is held to corrections, not rewrites (vetAiLine), and its answer
 *     is parsed defensively (parseAiFixes).
 *  3. Long recordings sent to the cloud in pieces come back with every word
 *     once — not twice at a seam, not lost in it (transcribeWords, with the
 *     provider and the encoder stubbed).
 *
 *   node test/caption-grammar.test.js
 */
const path = require('path');
const G = require('../src/renderer/capgrammar.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);
const fix = (text, opts) => G.checkLine(text, Object.assign({ caseMode: 'upper' }, opts || {})).fixed;

head('[1] What is plainly wrong gets fixed — in ALL CAPS, the default');
const cases = [
  ['I DONT KNOW', "I DON'T KNOW", 'missing apostrophe'],
  ['THATS WHAT HE SAID', "THAT'S WHAT HE SAID", 'missing apostrophe'],
  ['ITS A NEW DAY', "IT'S A NEW DAY", "its → it's before 'a'"],
  ['YOUR GOING TO BE BLESSED', "YOU'RE GOING TO BE BLESSED", "your → you're before 'going'"],
  ['MORE THEN THAT', 'MORE THAN THAT', 'then → than after a comparative'],
  ['IT IS A AMAZING GRACE', 'IT IS AN AMAZING GRACE', 'a → an'],
  ['AN BLESSING', 'A BLESSING', 'an → a'],
  ['THE THE WORD OF GOD', 'THE WORD OF GOD', 'stutter removed'],
  ['HE GAVE HIS ONLY BEGOTTEN SUN', 'HE GAVE HIS ONLY BEGOTTEN SON', 'begotten sun'],
  ['LET US PREY', 'LET US PRAY', 'let us prey'],
  ['FILLED WITH THE HOLY GOAT', 'FILLED WITH THE HOLY GHOST', 'holy goat'],
  ['THEIR IS POWER IN THE NAME', 'THERE IS POWER IN THE NAME', 'their is'],
  ['WE COULD OF DONE MORE', 'WE COULD HAVE DONE MORE', 'could of'],
  ['COME TO THE ALTER', 'COME TO THE ALTAR', 'the alter'],
  ['IN JESUS NAME', "IN JESUS' NAME", "Jesus' name"],
];
for (const [a, b, why] of cases) check(`${why}: "${a}"`, fix(a) === b, fix(a));

head('[2] …and what is merely unusual is left alone');
const keep = [
  'THAT THAT IS GOOD',            // a real double
  'HE HAD HAD ENOUGH',            // a real double
  'HOLY HOLY HOLY',               // worship, not a stutter
  'FAR FAR AWAY',
  'YOUR RIGHT HAND',              // "your right" is not "you're right" here
  'THERE IS A WAY',
  'THE GODS OF EGYPT',            // pagan gods stay plural, no apostrophe
  'ITS OWN WAY',                  // possessive its
  'I PRAY FOR YOU',
  'A UNIVERSITY',                 // a + "you" sound
  'AN HOUR',                      // an + silent h
  'WE WERE THERE',                // "were" and "well" are real words
  'WELL DONE',
  'LETS GO',                      // "lets" is a real word — not guessed at
];
for (const t of keep) check(`unchanged: "${t}"`, fix(t) === t, fix(t));

head('[3] Capitals for names — only in Normal case, never in lower');
const n = (t) => fix(t, { caseMode: 'none' });
check('i → I and god → God', n('and i was watching it and god said') === 'and I was watching it and God said', n('and i was watching it and god said'));
check('the lord → the Lord', n('the lord is my shepherd') === 'the Lord is my shepherd', n('the lord is my shepherd'));
check('a book before a number: mark 16 → Mark 16, "mark my words" untouched',
  n('turn to mark 16 and mark my words') === 'turn to Mark 16 and mark my words', n('turn to mark 16 and mark my words'));
check('psalms 23 → Psalm 23', n('read psalms 23') === 'read Psalm 23', n('read psalms 23'));
check('Bible names from the Word Book vocabulary', n('paul wrote to the ephesians') === 'Paul wrote to the Ephesians', n('paul wrote to the ephesians'));
check('a false god keeps its small g', n('a false god') === 'a false god', n('a false god'));
check('lower-case captions stay lower-case (the look, not a mistake)',
  fix('and i dont know god', { caseMode: 'lower' }) === "and i don't know god", fix('and i dont know god', { caseMode: 'lower' }));
check('Title case keeps its capitals', fix('I Dont Know', { caseMode: 'title' }) === "I Don't Know", fix('I Dont Know', { caseMode: 'title' }));

head('[4] Context crosses lines — at one word a line, "HOLY" and "GOAT" are two lines');
check('GOAT after a HOLY line → GHOST', fix('GOAT', { prev: 'HOLY' }) === 'GHOST', fix('GOAT', { prev: 'HOLY' }));
check('ITS before an "A" line → IT\'S', fix('ITS', { next: 'A NEW DAY' }) === "IT'S", fix('ITS', { next: 'A NEW DAY' }));
check('a line that only repeats the last word of the line before is emptied (removed by the studio)',
  fix('THE', { prev: 'AND THE' }) === '', JSON.stringify(fix('THE', { prev: 'AND THE' })));

head('[5] Each issue knows where it is, so it can be underlined and fixed alone');
{
  const r = G.checkLine("I DONT KNOW WHAT ITS A", { caseMode: 'upper' });
  check('two issues found', r.issues.length === 2, JSON.stringify(r.issues.map((x) => x.from + '→' + x.to)));
  const first = r.issues[0];
  check('…the first points at the right letters', r.text.slice(first.start, first.end) === 'DONT', r.text.slice(first.start, first.end));
  check('…and fixing just it leaves the other', G.applyIssue(r.text, first) === "I DON'T KNOW WHAT ITS A", G.applyIssue(r.text, first));
  check('every issue says why', r.issues.every((x) => x.why && x.why.length > 3), JSON.stringify(r.issues.map((x) => x.why)));
}
{
  const r = G.checkLine('THE THE WORD', { caseMode: 'upper' });
  check('a removal takes its space with it', G.applyIssue(r.text, r.issues[0]) === 'THE WORD', G.applyIssue(r.text, r.issues[0]));
}

head('[6] The AI is held to corrections, not rewrites');
const v = (a, b, o) => G.vetAiLine(a, b, Object.assign({ caseMode: 'upper' }, o || {}));
check('a misheard word: accepted, put back into CAPS, punctuation dropped',
  v('AND HE GAVE HIS ONLY BEGOTTEN SUN', 'and he gave his only begotten Son.').text === 'AND HE GAVE HIS ONLY BEGOTTEN SON',
  JSON.stringify(v('AND HE GAVE HIS ONLY BEGOTTEN SUN', 'and he gave his only begotten Son.')));
check('a rewrite: refused', !v('AND HE GAVE HIS ONLY BEGOTTEN SUN', 'God loved the world so much that he sent Jesus').ok,
  JSON.stringify(v('AND HE GAVE HIS ONLY BEGOTTEN SUN', 'God loved the world so much that he sent Jesus')));
check('a change of case only (in CAPS): not a suggestion', !v('THE LORD IS GOOD', 'The Lord is good').ok);
{
  // Three words changed in a four-word line: too much for "keep their exact
  // words", within what "also tidy grammar" allows.
  const ex = v('HE GO TO CHURCH', 'he goes to the church', { mode: 'exact' });
  const td = v('HE GO TO CHURCH', 'he goes to the church', { mode: 'tidy' });
  check('"keep their exact words" refuses a grammar tidy that "also tidy grammar" allows',
    !ex.ok && td.ok && td.text === 'HE GOES TO THE CHURCH', JSON.stringify([ex, td]));
}
check('an answer that adds lines of its own is not a correction', !v('AMEN', 'Amen. Let us now turn to the book of Romans').ok);
check('Normal case keeps the AI\'s capitals', v('and i was watching', 'and I was watching', { caseMode: 'none' }).text === 'and I was watching');

head('[7] The AI\'s answer is parsed defensively');
const batch = [{ n: 3, text: 'A' }, { n: 4, text: 'B', context: true }, { n: 5, text: 'C' }];
const got = G.parseAiFixes('Sure! ```json\n{"fixes":[{"n":3,"text":"x","why":"y"},{"n":4,"text":"ctx"},{"n":9,"text":"z"},{"n":5,"text":"w"}]}\n```', batch);
check('fenced JSON in prose is read', Array.isArray(got) && got.length === 2, JSON.stringify(got));
check('…context lines and numbers never asked about are dropped', got && got.every((f) => f.n === 3 || f.n === 5));
check('garbage is null, not a crash', G.parseAiFixes('I could not do that.', batch) === null);
const prompt = G.buildAiPrompt(batch, { mode: 'exact' });
check('the brief says not to rephrase, and marks context lines', /Never rephrase/i.test(prompt.system) && /context only/.test(prompt.prompt));

head('[8] Fast enough to run as you type');
{
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(i % 3 ? 'AND HE SAID UNTO THEM' : 'I DONT KNOW WHAT ITS A');
  const t0 = Date.now();
  const res = G.checkLines(lines, { caseMode: 'upper' });
  const ms = Date.now() - t0;
  check('3,000 lines (a three-hour sermon) checked in under a second', ms < 1000 && res.length === 3000, ms + ' ms');
}

/* ------------------------------------------------------------------------ */
head('[9] ☁️ The cloud ear, sent in pieces: every word once, none lost at a seam');
(async () => {
  const cs = require('../src/main/cloudspeech.js');
  check('a verbose answer becomes words on the file\'s clock',
    JSON.stringify(cs.wordsFromVerbose({ words: [{ word: ' Grace', start: 1, end: 1.4 }], segments: [] }, 10))
      === JSON.stringify([{ text: 'Grace', start: 11, end: 11.4 }]));
  check('a stock filler the model doubted is dropped…',
    cs.wordsFromVerbose({ words: [{ word: 'Thank', start: 0, end: 0.3 }, { word: 'you.', start: 0.3, end: 0.6 }],
      segments: [{ start: 0, end: 0.6, text: ' Thank you.', no_speech_prob: 0.7, avg_logprob: -0.3 }] }, 0).length === 0);
  check('…but the same words SAID with confidence are kept (a preacher does say thank you)',
    cs.wordsFromVerbose({ words: [{ word: 'Thank', start: 0, end: 0.3 }, { word: 'you.', start: 0.3, end: 0.6 }],
      segments: [{ start: 0, end: 0.6, text: ' Thank you.', no_speech_prob: 0.01, avg_logprob: -0.2 }] }, 0).length === 2);
  {
    // Real Groq output, measured: the first word of a sentence stamped BEFORE the word in front of it.
    const ws = cs.wordsFromVerbose({ words: [
      { word: 'and', start: 6.48, end: 9.06 }, { word: 'greet', start: 9.06, end: 9.5 },
      { word: 'them.', start: 8.94, end: 10.06 }, { word: 'Here', start: 10.06, end: 10.7 }], segments: [] }, 0);
    check('words stay in the order they were SAID, even when a stamp runs backwards',
      ws.map((w) => w.text).join(' ') === 'and greet them. Here', ws.map((w) => w.text).join(' '));
    check('…and the stamp is moved instead (never before the word in front has finished)',
      ws.every((w, i) => i === 0 || w.start >= ws[i - 1].end - 0.0005) && ws[2].start === 9.5 && ws[2].end === 10.06, JSON.stringify(ws[2]));
  }
  const hdr = (h) => ({ headers: { get: (k) => h[k] || null } });
  check('wait headers are read in every form Groq sends them',
    cs.retryWaitMs(hdr({ 'retry-after': '7' })) === 7000
    && cs.retryWaitMs(hdr({ 'x-ratelimit-reset-audio-seconds': '1m2.5s' })) === 62500
    && cs.retryWaitMs(hdr({ 'x-ratelimit-reset-requests': '450ms' })) === 450);

  /*
   * A fake provider that "hears" a speaker saying one word every 0.5 s, word
   * N at N*0.5 s on the file's clock — whatever stretch it is sent, it returns
   * exactly the words inside that stretch, on the stretch's own clock. The
   * encoder is the real ffmpeg reading a real silent file; only the network
   * is fake.
   */
  const os = require('os'), fs = require('fs'), { execFileSync } = require('child_process');
  const ffmpeg = require('ffmpeg-static');
  const wav = path.join(os.tmpdir(), 'mw-cloudwords-' + process.pid + '.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '130', '-y', wav]);
  const calls = [];
  let fail429 = 0, failAt = -1, served = 0;
  global.fetch = async (url, init) => {
    const n = calls.length;
    const form = init.body;
    const file = form.get('file');
    const buf = Buffer.from(await file.arrayBuffer());
    // ffmpeg's ogg duration is not easy to read here, so the stub is told the
    // stretch through the order of calls (see `plan` below).
    calls.push({ bytes: buf.length, gran: form.getAll('timestamp_granularities[]') });
    if (fail429 > 0) { fail429--; return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '0.2' : null) }, json: async () => ({}) }; }
    if (n === failAt) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    const [ha, hb] = plan[served++] || [0, 0];
    const words = [];
    for (let k = Math.ceil(ha / 0.5); k * 0.5 + 0.3 <= hb; k++) words.push({ word: 'w' + k, start: +(k * 0.5 - ha).toFixed(3), end: +(k * 0.5 + 0.3 - ha).toFixed(3) });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ words, segments: [] }) };
  };
  cs.configure({ on: false, provider: 'groq', key: 'test-key' });
  // What each request hears with 40 s pieces and 3 s of overlap, 0..130:
  let plan = [[0, 43], [37, 83], [77, 123], [117, 130]];
  const r = await cs.transcribeWords({ input: wav, startSec: 0, endSec: 130, chunkSec: 40 });
  const texts = r.words.map((w) => w.text);
  const expected = []; for (let k = 0; k * 0.5 + 0.3 <= 130; k++) expected.push('w' + k);
  const dupes = texts.filter((t, i) => texts.indexOf(t) !== i);
  check('four pieces for 130 s at 40 s a piece', calls.length === 4, calls.length);
  check('…every one asked for WORD timings', calls.every((c) => c.gran.includes('word')));
  check('no word appears twice at a seam', dupes.length === 0, JSON.stringify(dupes.slice(0, 5)));
  check('no word is lost at a seam', texts.length === expected.length && texts.every((t, i) => t === expected[i]),
    `${texts.length} of ${expected.length}`);
  check('times are back on the file\'s clock, in order',
    r.words.every((w, i) => Math.abs(w.start - (+w.text.slice(1)) * 0.5) < 0.002 && (i === 0 || w.start >= r.words[i - 1].start)));
  check('…and it reports the whole span done', r.doneSec === 130 && !r.why, JSON.stringify({ doneSec: r.doneSec, why: r.why }));

  // A short asked from 50 to 80 s: times come back relative to 50, like the PC's whisper.
  calls.length = 0; served = 0; plan = [[50, 80]];
  const s = await cs.transcribeWords({ input: wav, startSec: 50, endSec: 80 });
  check('a short\'s words are relative to its start, exactly as the PC returns them',
    s.words.length && Math.abs(s.words[0].start - 0) < 0.002 && s.words[0].text === 'w100', JSON.stringify(s.words.slice(0, 2)));

  // Rate limited for a moment: waits it out rather than splitting the batch between engines.
  calls.length = 0; served = 0; plan = [[50, 80]]; fail429 = 1;
  const rl = await cs.transcribeWords({ input: wav, startSec: 50, endSec: 80 });
  check('a 429 that says "in 0.2 s" is waited out, and the words still come from the cloud',
    calls.length === 2 && rl.words.length > 0 && rl.doneSec === 30, `${calls.length} calls, ${rl.words.length} words`);

  // The service dies on the third piece: what was heard is kept and the rest is handed back.
  calls.length = 0; served = 0; plan = [[0, 43], [37, 83]]; failAt = 2;
  const part = await cs.transcribeWords({ input: wav, startSec: 0, endSec: 130, chunkSec: 40 });
  failAt = -1;
  check('stopping part-way keeps what was heard, says how far it got and why',
    part.doneSec === 80 && part.words.length > 0 && /503/.test(part.why) && part.words[part.words.length - 1].start < 80,
    JSON.stringify({ doneSec: part.doneSec, why: part.why, last: part.words[part.words.length - 1] }));

  // No key at all: null, so the studio uses the PC without a word of fuss.
  cs.configure({ on: false, provider: 'groq', key: '' });
  cs.shareKey('groq', '');
  check('no key: null (the PC hears it)', (await cs.transcribeWords({ input: wav, startSec: 0, endSec: 10 })) === null);
  cs.shareKey('groq', 'writer-key');
  check('…but the caption writer\'s Groq key is borrowed for files', cs.fileReady() === true);
  cs.shareKey('openrouter', 'other-key');
  check('…and a key for a different provider is not', cs.fileReady() === false);

  try { fs.unlinkSync(wav); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
